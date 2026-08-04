//   SlaveLink.ino
//   Outbound command channel to DS-Slave -- the companion ESP32-S3 that bridges a
//   BLE HID keyboard to a UART (see ../DS-Slave/DS-Slave.ino). DS-Slave listens for
//   newline-terminated line commands on its UART1 RX (GPIO18) at 115200 8N1:
//     HELP  STATUS  KEYBOARDS/PAIRED  FORGET  PAIR  SCAN
//     LED <0-31>  NUM 0|1  CAPS 0|1  SCROLL 0|1  OUT <hex bytes>
//     GAME 0|1  PAD [slot] AUTO|KEYBOARD|GAMEPAD  DUMP 0|1  DROP
//   DS-Slave holds up to two HID devices at once (a keyboard and a controller),
//   merging their input into one stream, so nothing here needs to care which is
//   which; "slave status" lists the slots on the slave's own console.
//
//   Why bit-bang instead of the hardware UART:
//     KeyboardSerial (UART1, KeyboardSerial.ino) owns this board's only spare
//     hardware UART, and its job is to *receive* keystrokes on GPIO21. We only ever
//     need to *send* a handful of short control lines the other way, and infrequently.
//     So rather than share the UART peripheral's TX, we drive SLAVE_LINK_TX_PIN in
//     software. BoardPins.h keeps it clear of each variant's onboard peripherals.
//
//   The link is deliberately one-way. DS-Slave prints every command's reply to its
//   own USB serial console (Serial.print, never back onto its UART1 TX), so DOLL-OS cannot
//   read STATUS/HELP/etc. output back over this wire -- GPIO15 -> GPIO18 carries
//   commands out and nothing returns on it. The keystroke stream on the *other* wire
//   (Slave GPIO17 -> DOLL-OS GPIO16) is unrelated and keeps flowing. handleSlaveCommand()
//   says as much so a user isn't left waiting for a reply that only lands on the
//   slave's console.

#include "driver/gpio.h"   //gpio_set_level -- IRAM-resident, unlike Arduino's digitalWrite (see slaveLinkWriteByte)

static const uint32_t SLAVE_LINK_BAUD = 115200;   //must match DS-Slave's LinkSerial (UART_BAUD)

//per-byte we hold a critical section so no interrupt can stretch a bit period and
//frame-error the byte at the slave. One byte is 10 bit-times (~87us at 115200); we
//release between bytes, so the longest interrupts-off window stays under ~90us.
static portMUX_TYPE slaveLinkMux = portMUX_INITIALIZER_UNLOCKED;

static bool slaveLinkReady = false;

//spins until the CPU cycle counter reaches an absolute target. Targets are advanced by
//exactly one bit period each edge (next += cyclesPerBit) rather than measured relative to
//"now", so the per-edge overhead doesn't accumulate into baud drift across a byte.
//int32_t difference math tolerates the 32-bit counter wrapping (~18s at 240MHz).
//IRAM_ATTR: this runs inside slaveLinkWriteByte's critical section, where the executing
//core must never need a flash-resident instruction fetch -- if the *other* core is mid
//flash write/erase (WiFi/BT NVS commits, LittleFS/SD writes) when that happens, this core
//stalls for the whole SPI operation regardless of interrupts being disabled, corrupting
//bit timing mid-byte. Keeping this loop (and its caller) in IRAM avoids that fetch entirely.
static inline void IRAM_ATTR slaveLinkWaitUntil(uint32_t targetCycle) {
    while ((int32_t)(ESP.getCycleCount() - targetCycle) < 0) {
        //busy-wait; the enclosing critical section keeps this deterministic
    }
}

void slaveLinkBegin() {
    //idle line is high; drive it high before anyone reads it as a spurious start bit
    pinMode(SLAVE_LINK_TX_PIN, OUTPUT);
    digitalWrite(SLAVE_LINK_TX_PIN, HIGH);

    slaveLinkReady = true;

    Serial.printf("[boot] slave link bit-bang TX=%d baud=%lu\n",
                  SLAVE_LINK_TX_PIN, (unsigned long)SLAVE_LINK_BAUD);
}

//cycles-per-bit from the *current* CPU frequency (240MHz typical -> 2083 cycles/bit).
//Recomputed on every send rather than cached once at boot: this used to be a one-time
//slaveLinkBegin() calculation, which went stale (and silently baud-mismatched every
//transmission from then on, garbling "GAME 1" into consistent garbage the receiving
//UART decoded wrong every time) if the CPU frequency at boot didn't match the frequency
//once WiFi/BT were actually up and running later. Reading it live costs one cheap call.
static inline uint32_t slaveLinkCurrentCyclesPerBit() {
    return (uint32_t)((uint64_t)getCpuFrequencyMhz() * 1000000ULL / SLAVE_LINK_BAUD);
}

//transmits one byte, 8N1, LSB first: start bit (low), 8 data bits, stop bit (high).
//Uses gpio_set_level (IDF, IRAM-resident) instead of Arduino's digitalWrite -- digitalWrite
//isn't guaranteed to live in IRAM, and a flash-resident instruction fetch here would hit
//the same other-core-flash-write stall slaveLinkWaitUntil's comment describes.
static void IRAM_ATTR slaveLinkWriteByte(uint8_t b) {
    if (!slaveLinkReady) {
        return;
    }

    const uint32_t bit = slaveLinkCurrentCyclesPerBit();

    portENTER_CRITICAL(&slaveLinkMux);
    uint32_t next = ESP.getCycleCount();

    //start bit
    gpio_set_level((gpio_num_t)SLAVE_LINK_TX_PIN, 0);
    next += bit;
    slaveLinkWaitUntil(next);

    //8 data bits, least-significant first
    for (int i = 0; i < 8; i++) {
        gpio_set_level((gpio_num_t)SLAVE_LINK_TX_PIN, (b & 0x01) ? 1 : 0);
        b >>= 1;
        next += bit;
        slaveLinkWaitUntil(next);
    }

    //stop bit -- also leaves the line idling high for the next byte
    gpio_set_level((gpio_num_t)SLAVE_LINK_TX_PIN, 1);
    next += bit;
    slaveLinkWaitUntil(next);

    portEXIT_CRITICAL(&slaveLinkMux);
}

//sends one command line to DS-Slave, terminated with '\n' (its pumpCommandStream treats
//either CR or LF as end-of-line). Bytes go out back-to-back; the slave resynchronises on
//each byte's start bit, and any interrupt gap between our bytes just looks like idle line.
void slaveLinkSendLine(const String& line) {
    ledPulseInput();
    for (size_t i = 0; i < line.length(); i++) {
        slaveLinkWriteByte((uint8_t)line[i]);
    }
    slaveLinkWriteByte('\n');
}

//   Shell command: "slave <subcommand> [args]" -- one DOLL-OS-side verb that reaches every
//   DS-Slave command over the bit-banged wire. Subcommand names mirror DS-Slave's own
//   (case-insensitive here; forwarded upper-cased where the slave expects it). "raw"
//   is an escape hatch that forwards the rest of the line verbatim.
static void slaveLinkUsage() {
    outLine("slave <subcommand> -- drive the DOLL-OS BLE-keyboard bridge", C_CYAN);
    outLine("  slave status              request STATUS");
    outLine("  slave keyboards|paired    list saved keyboards");
    outLine("  slave pair                pair one more device (existing ones stay)");
    outLine("  slave scan                rescan / reconnect");
    outLine("  slave forget              clear saved keyboards + bonds");
    outLine("  slave led <0-31>          set the keyboard LED mask");
    outLine("  slave num|caps|scroll 0|1 toggle one lock LED");
    outLine("  slave game 0|1            gamepad mode (button events vs keystrokes)");
    outLine("  slave pad [slot] auto|keyboard|gamepad  how to parse a peer's reports");
    outLine("  slave drop                disconnect every paired device (bonds kept)");
    outLine("  slave dump 0|1            hex-log raw input reports on the slave console");
    outLine("  slave out <hex bytes>     send a raw HID output report");
    outLine("  slave help                ask the slave to print its help");
    outLine("  slave raw <text...>       forward a line verbatim");
    outLine("Link is send-only: replies print on the keyboard bridge's USB console, not here.", C_YELLOW);
}

//joins parts[from..partCount) back into a space-separated string (undoing the tokenizer)
static String slaveLinkJoinFrom(const String parts[], int partCount, int from) {
    String out = "";
    for (int i = from; i < partCount; i++) {
        if (out.length() > 0) {
            out += " ";
        }
        out += parts[i];
    }
    return out;
}

void handleSlaveCommand(const String parts[], int partCount) {
    if (partCount == 1) {
        slaveLinkUsage();
        return;
    }

    String sub = parts[1];
    sub.toLowerCase();
    String line = "";

    if (sub == "status" || sub == "help" || sub == "pair" || sub == "scan" || sub == "forget") {
        line = parts[1];
        line.toUpperCase();
    } else if (sub == "keyboards" || sub == "paired") {
        line = parts[1];
        line.toUpperCase();
    } else if (sub == "led") {
        if (partCount < 3) {
            outLine("usage: slave led <0-31>", C_RED);
            return;
        }
        line = "LED " + parts[2];
    } else if (sub == "num" || sub == "caps" || sub == "scroll") {
        if (partCount < 3) {
            outLine("usage: slave " + sub + " 0|1", C_RED);
            return;
        }
        String verb = parts[1];
        verb.toUpperCase();
        line = verb + " " + parts[2];
    } else if (sub == "game") {
        if (partCount < 3) {
            outLine("usage: slave game 0|1", C_RED);
            return;
        }
        line = "GAME " + parts[2];
    } else if (sub == "pad") {
        if (partCount < 3) {
            outLine("usage: slave pad [slot] auto|keyboard|gamepad", C_RED);
            return;
        }
        String rest = slaveLinkJoinFrom(parts, partCount, 2);   //optional slot, then the mode
        rest.toUpperCase();
        line = "PAD " + rest;
    } else if (sub == "drop") {
        line = "DROP";
    } else if (sub == "dump") {
        if (partCount < 3) {
            outLine("usage: slave dump 0|1", C_RED);
            return;
        }
        line = "DUMP " + parts[2];
    } else if (sub == "out") {
        if (partCount < 3) {
            outLine("usage: slave out <hex bytes>", C_RED);
            return;
        }
        line = "OUT " + slaveLinkJoinFrom(parts, partCount, 2);
    } else if (sub == "raw") {
        if (partCount < 3) {
            outLine("usage: slave raw <text...>", C_RED);
            return;
        }
        line = slaveLinkJoinFrom(parts, partCount, 2);   //forwarded exactly as typed
    } else {
        outLine("slave: unknown subcommand '" + parts[1] + "'", C_RED);
        slaveLinkUsage();
        return;
    }

    slaveLinkSendLine(line);
    outLine("-> DOLL-OS keyboard bridge: " + line, C_GREEN);
}
