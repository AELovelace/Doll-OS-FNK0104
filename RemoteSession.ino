//   RemoteSession.ino
//   shared modal loop for character-oriented remote sessions (ssh shell, outbound
//   telnet client) -- see the RemoteSession class declaration in global.h.
//
//   Ported from DOLL-OS's RemoteSession.ino. There, "local" meant the M5Cardputer
//   keyboard (input) and terminal sprite (output); here "local" means the one
//   connected telnetClient in both directions -- pumpIncoming() writes remote bytes
//   straight to it, and readRawUserBytes() below reads the user's raw keystrokes
//   back off it. DOLL-OS's local escape chord was Fn+Q, a physical key combo with
//   no telnet equivalent; this uses Ctrl+T (0x14) instead, chosen because it isn't
//   commonly bound by remote shells or BBS-style line editors the way Ctrl+C/D/Z are.

//reads one raw byte from telnetClient (IAC already stripped by telnetReadFilteredByte,
//TelnetServer.ino) and classifies it exactly like DOLL-OS's readRawKeyBytes() did for
//keyboard events: normal bytes are forwarded as-is, Ctrl+T sets escapePressed, and
//backspace/DEL sets backspacePressed instead of being forwarded raw, so each transport
//can translate it through its own backspaceBytes() override.
bool readRawUserBytes(String& outBytes, bool& escapePressed, bool& backspacePressed) {
    outBytes = "";
    escapePressed = false;
    backspacePressed = false;

    int raw = telnetReadFilteredByte();
    if (raw == -1) {
        raw = keyboardReadRawByte();   //no telnet byte waiting -- fall back to the BLE-keyboard
                                        //bridge, so the session is drivable with no telnet client
    }
    if (raw == -1) {
        return false;
    }
    uint8_t b = (uint8_t)raw;

    if (b == 0x14) {   //Ctrl+T: local "detach" chord
        escapePressed = true;
        return false;
    }
    if (b == 0x08 || b == 0x7F) {
        backspacePressed = true;
        return false;
    }

    outBytes += (char)b;
    return true;
}

void RemoteSession::run() {
    bool closedNotified = false;

    while (true) {
        delay(2);

        pumpIncoming();
        drawDisplayFrame();   //this loop never returns to DS.ino's loop() until the
                               //session ends, so the mirror has to repaint itself here too

        if (isClosed()) {
            if (!closedNotified) {
                onClosed();
                closedNotified = true;
            }
            break;
        }
        //note: a dropped telnet client no longer ends the session -- the panel mirror and the
        //BLE keyboard are a complete UI on their own, so the session lives until the remote
        //closes (isClosed above) or the user sends the Ctrl+T detach chord. pumpIncoming()
        //already guards its own writes to telnetClient with a connected() check.

        String rawOut;
        bool escapePressed;
        bool backspacePressed;
        if (readRawUserBytes(rawOut, escapePressed, backspacePressed)) {
            sendBytes(rawOut);
        } else if (escapePressed) {
            break;
        } else if (backspacePressed) {
            sendBytes(backspaceBytes());
        }
    }

    //final drain so output already in flight isn't lost when the loop exits
    pumpIncoming();
}
