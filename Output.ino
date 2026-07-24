//   Output.ino
//   Line output helpers -- the telnet-port replacement for DOLL-OS's terminal.ino.
//
//   DOLL-OS's terminal was a scrolling grid of pixels: addWrappedHistoryLine had to
//   measure glyph widths and wrap text itself, and every row's color lived in a ring
//   buffer so the sprite could be redrawn from scratch every tick. A telnet client is
//   a real terminal -- it already wraps long lines and keeps its own scrollback --
//   so none of that is needed for the telnet side. Output is just bytes written to
//   the socket, with real ANSI SGR codes for color instead of a per-row uint16_t.
//
//   The board's own TFT panel still mirrors this output (see Display.ino), so
//   outLine()/outClearScreen() feed both: the telnet client gets real ANSI, the
//   panel gets DOLL-OS's original pixel-wrapped-history treatment.
//
//   outLine() is the direct replacement for addWrappedHistoryLine() at every call
//   site ported from DOLL-OS.

void outLine(const String& text) {
    outLine(text, C_WHITE);
}

void outLine(const String& text, int color) {
    addDisplayLine(text, ansiCodeToPixelColor(color));

    if (!telnetClient || !telnetClient.connected()) {
        return;
    }
    if (color != C_WHITE) {
        telnetClient.print("\x1b[");
        telnetClient.print(color);
        telnetClient.print("m");
    }
    telnetClient.print(text);
    if (color != C_WHITE) {
        telnetClient.print("\x1b[0m");
    }
    telnetClient.print("\r\n");
}

//clears the client's terminal screen and homes the cursor (ANSI CSI 2J + CSI H)
void outClearScreen() {
    clearDisplayHistory();

    if (!telnetClient || !telnetClient.connected()) {
        return;
    }
    telnetClient.print("\x1b[2J\x1b[H");
}

void printPrompt() {
    if (telnetClient && telnetClient.connected()) {
        telnetClient.print("> ");
    }
}
