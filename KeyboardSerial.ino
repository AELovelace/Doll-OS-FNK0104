//   KeyboardSerial.ino
//   Second UART that receives keystrokes from DS-Slave -- the companion ESP32-S3 that
//   bridges a BLE HID keyboard to a serial line (see ../DS-Slave/DS-Slave.ino). DS-Slave
//   decodes each BLE key report into a plain byte stream: printable ASCII, CR for Enter,
//   0x08 for Backspace, and ESC/CSI sequences for the arrows/Home/End/Delete/function
//   keys. That is exactly the vocabulary DS's telnet line editor already speaks, so the
//   received bytes are fed straight into the shared processLineEditByte() (TelnetServer.ino)
//   -- the BLE keyboard becomes a second way to drive the shell, working with or without
//   a telnet client attached.
//
//   Wiring (this board <-> DS-Slave):
//     DS RX = GPIO16  <-  DS-Slave TX = GPIO17   (keystrokes flow in on this wire)
//     DS TX = GPIO15  ->  DS-Slave RX = GPIO18   (DS-Slave's STATUS/LED/... command channel)
//     DS GND          <-> DS-Slave GND           (shared ground -- carried by the power pair below)
//     DS 5V/VIN       ->  DS-Slave 5V/VIN        (DS powers DS-Slave; see the current note in setup)
//   GPIO15/16 were chosen so the UART pair sits next to a ground and a power pin on the
//   header, giving one tidy connector that both talks to and powers DS-Slave. Both ends
//   run 115200 8N1. On the active FNK0104AB variant GPIO15/16 are unused (TFT is on
//   10-13/45/46, SD_MMC on 38-48, touch disabled -- see config.h and the setup header).

//UART peripheral 1 -- UART0 backs the USB serial console (Serial), so the keyboard link
//gets its own peripheral. ESP32-S3's GPIO matrix routes it to any pins, hence 15/16.
HardwareSerial KeyboardSerial(1);

static const int KEYBOARD_SERIAL_RX_PIN = 16;   //<- DS-Slave TX (GPIO17)
//GPIO15 (-> DS-Slave RX / GPIO18) is the outbound command channel, but it is NOT driven
//by this UART: KeyboardSerial is started RX-only and SlaveLink.ino bit-bangs GPIO15 in
//software instead (see SlaveLink.ino for why). Passing TX=-1 below leaves GPIO15 free for it.
static const int KEYBOARD_SERIAL_TX_PIN = -1;   //RX-only; outbound is bit-banged on GPIO15 (SlaveLink.ino)
static const uint32_t KEYBOARD_SERIAL_BAUD = 115200;

//own line-edit parse state (see LineEditState in global.h) so a mid-escape keystroke
//can't tangle with the telnet client's in-progress parse
static LineEditState keyboardLineState;

void initKeyboardSerial() {
    KeyboardSerial.begin(KEYBOARD_SERIAL_BAUD, SERIAL_8N1, KEYBOARD_SERIAL_RX_PIN, KEYBOARD_SERIAL_TX_PIN);
    Serial.printf("[boot] keyboard UART RX=%d TX=bitbang(GPIO15) baud=%lu\n",
                  KEYBOARD_SERIAL_RX_PIN, (unsigned long)KEYBOARD_SERIAL_BAUD);
}

//drains whatever DS-Slave has sent this tick, feeding each byte through the same line
//editor the telnet client uses. Both edit the one shared currentCommand buffer -- DS is
//a single-user shell (global.h), so the keyboard and a telnet client are just two ways in
//for the same user. Mirrors the submit/reprompt dance of readTelnetClient().
void readKeyboardSerial() {
    while (KeyboardSerial.available() > 0) {
        uint8_t ch = (uint8_t)KeyboardSerial.read();
        LineInputResult r = processLineEditByte(currentCommand, ch, keyboardLineState, false);
        if (r == LINE_NO_INPUT) {
            continue;
        }
        setActiveInput("> ", currentCommand, false);
        if (r == LINE_SUBMITTED) {
            commandProcessor(currentCommand);
            setActiveInput("> ", currentCommand, false);   //commandProcessor() clears the buffer -- reflect that
            printPrompt();
        }
    }
}

//reads and applies one keyboard-bridge byte to a line-edited buffer, mirroring
//readLineEditedInput() (TelnetServer.ino) but sourced from the DS-Slave UART and never
//echoing CRLF (there's no telnet client to echo to). readKeyboardSerial() above can't be
//reused for this: the modal input phases that need it (ssh's password prompt) block loop(),
//so they poll one source at a time themselves rather than running the whole shell reader.
LineInputResult readKeyboardLineEditedInput(String& text) {
    if (KeyboardSerial.available() <= 0) {
        return LINE_NO_INPUT;
    }
    uint8_t ch = (uint8_t)KeyboardSerial.read();
    return processLineEditByte(text, ch, keyboardLineState, false);
}

//reads one raw keyboard-bridge byte for the RemoteSession raw-passthrough phase, or -1 if
//none is waiting. No line editing here -- the raw session classifies/forwards bytes itself
//(see readRawUserBytes, RemoteSession.ino), exactly as it does for raw telnet bytes.
int keyboardReadRawByte() {
    if (KeyboardSerial.available() <= 0) {
        return -1;
    }
    return (uint8_t)KeyboardSerial.read();
}
