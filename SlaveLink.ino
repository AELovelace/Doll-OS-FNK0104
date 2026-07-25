//   SlaveLink.ino
//   Outbound command channel to DS-Slave -- the companion ESP32-S3 that bridges a
//   BLE HID keyboard to a UART (see ../DS-Slave/DS-Slave.ino). DS-Slave listens for
//   newline-terminated line commands on its UART1 RX (GPIO18) at 115200 8N1:
//     HELP  STATUS  KEYBOARDS/PAIRED  FORGET  PAIR  SCAN
//     LED <0-31>  NUM 0|1  CAPS 0|1  SCROLL 0|1  OUT <hex bytes>
//
//   Why bit-bang instead of the hardware UART:
//     KeyboardSerial (UART1, KeyboardSerial.ino) owns this board's only spare
//     hardware UART, and its job is to *receive* keystrokes on GPIO16. We only ever
//     need to *send* a handful of short control lines the other way, and infrequently.
//     So rather than share the UART peripheral's TX, we drive the outbound wire in
//     software on GPIO15 -- the exact pin KeyboardSerial.ino already documents as
//     "DS TX = GPIO15 -> DS-Slave RX = GPIO18". KeyboardSerial is now started RX-only
//     so nothing else touches GPIO15 (see initKeyboardSerial()).
//
//   The link is deliberately one-way. DS-Slave prints every command's reply to its
//   own USB serial console (Serial.print, never back onto its UART1 TX), so DS cannot
//   read STATUS/HELP/etc. output back over this wire -- GPIO15 -> GPIO18 carries
//   commands out and nothing returns on it. The keystroke stream on the *other* wire
//   (Slave GPIO17 -> DS GPIO16) is unrelated and keeps flowing. handleSlaveCommand()
//   says as much so a user isn't left waiting for a reply that only lands on the
//   slave's console.

static const int SLAVE_LINK_TX_PIN = 15;          //-> DS-Slave RX (GPIO18); same wire KeyboardSerial.ino documents
static const uint32_t SLAVE_LINK_BAUD = 115200;   //must match DS-Slave's LinkSerial (UART_BAUD)

//per-byte we hold a critical section so no interrupt can stretch a bit period and
//frame-error the byte at the slave. One byte is 10 bit-times (~87us at 115200); we
//release between bytes, so the longest interrupts-off window stays under ~90us.
static portMUX_TYPE slaveLinkMux = portMUX_INITIALIZER_UNLOCKED;

static uint32_t slaveLinkCyclesPerBit = 0;   //CPU cycles per bit, computed from the live CPU clock in slaveLinkBegin()
static bool slaveLinkReady = false;

//spins until the CPU cycle counter reaches an absolute target. Targets are advanced by
//exactly one bit period each edge (next += cyclesPerBit) rather than measured relative to
//"now", so the per-edge digitalWrite overhead doesn't accumulate into baud drift across a
//byte. int32_t difference math tolerates the 32-bit counter wrapping (~18s at 240MHz).
static inline void slaveLinkWaitUntil(uint32_t targetCycle) {
    while ((int32_t)(ESP.getCycleCount() - targetCycle) < 0) {
        //busy-wait; the enclosing critical section keeps this deterministic
    }
}

void slaveLinkBegin() {
    //idle line is high; drive it high before anyone reads it as a spurious start bit
    pinMode(SLAVE_LINK_TX_PIN, OUTPUT);
    digitalWrite(SLAVE_LINK_TX_PIN, HIGH);

    //cycles-per-bit from the actual CPU frequency (240MHz typical -> 2083 cycles/bit).
    //Read it live so a non-240MHz build still bangs the correct baud.
    slaveLinkCyclesPerBit = (uint32_t)((uint64_t)getCpuFrequencyMhz() * 1000000ULL / SLAVE_LINK_BAUD);
    slaveLinkReady = true;

    Serial.printf("[boot] slave link bit-bang TX=%d baud=%lu (%lu cyc/bit)\n",
                  SLAVE_LINK_TX_PIN, (unsigned long)SLAVE_LINK_BAUD,
                  (unsigned long)slaveLinkCyclesPerBit);
}

//transmits one byte, 8N1, LSB first: start bit (low), 8 data bits, stop bit (high).
static void slaveLinkWriteByte(uint8_t b) {
    if (!slaveLinkReady) {
        return;
    }

    const uint32_t bit = slaveLinkCyclesPerBit;

    portENTER_CRITICAL(&slaveLinkMux);
    uint32_t next = ESP.getCycleCount();

    //start bit
    digitalWrite(SLAVE_LINK_TX_PIN, LOW);
    next += bit;
    slaveLinkWaitUntil(next);

    //8 data bits, least-significant first
    for (int i = 0; i < 8; i++) {
        digitalWrite(SLAVE_LINK_TX_PIN, (b & 0x01) ? HIGH : LOW);
        b >>= 1;
        next += bit;
        slaveLinkWaitUntil(next);
    }

    //stop bit -- also leaves the line idling high for the next byte
    digitalWrite(SLAVE_LINK_TX_PIN, HIGH);
    next += bit;
    slaveLinkWaitUntil(next);

    portEXIT_CRITICAL(&slaveLinkMux);
}

//sends one command line to DS-Slave, terminated with '\n' (its pumpCommandStream treats
//either CR or LF as end-of-line). Bytes go out back-to-back; the slave resynchronises on
//each byte's start bit, and any interrupt gap between our bytes just looks like idle line.
void slaveLinkSendLine(const String& line) {
    for (size_t i = 0; i < line.length(); i++) {
        slaveLinkWriteByte((uint8_t)line[i]);
    }
    slaveLinkWriteByte('\n');
}

//   Shell command: "slave <subcommand> [args]" -- one DS-side verb that reaches every
//   DS-Slave command over the bit-banged wire. Subcommand names mirror DS-Slave's own
//   (case-insensitive here; forwarded upper-cased where the slave expects it). "raw"
//   is an escape hatch that forwards the rest of the line verbatim.
static void slaveLinkUsage() {
    outLine("slave <subcommand> -- drive the DS-Slave BLE-keyboard bridge", C_CYAN);
    outLine("  slave status              request STATUS");
    outLine("  slave keyboards|paired    list saved keyboards");
    outLine("  slave pair                enter BLE pairing mode");
    outLine("  slave scan                rescan / reconnect");
    outLine("  slave forget              clear saved keyboards + bonds");
    outLine("  slave led <0-31>          set the keyboard LED mask");
    outLine("  slave num|caps|scroll 0|1 toggle one lock LED");
    outLine("  slave out <hex bytes>     send a raw HID output report");
    outLine("  slave help                ask the slave to print its help");
    outLine("  slave raw <text...>       forward a line verbatim");
    outLine("Link is send-only: replies print on DS-Slave's USB console, not here.", C_YELLOW);
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
    outLine("-> DS-Slave: " + line, C_GREEN);
}
