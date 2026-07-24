//   Display.ino
//   drives the TFT panel as a mirror of the telnet session -- "a second screen for
//   the cardputer," per the user's request. Telnet remains the only *input* path;
//   this is output-only. Ported from DOLL-OS's terminal.ino (history wrapping/
//   rendering) and ansi.ino (SGR color interpretation for raw remote byte streams),
//   retargeted from an M5GFX sprite to a TFT_eSPI one -- the API shapes
//   (drawString/textWidth/setTextColor/setTextDatum/fillSprite) are close enough
//   that the porting is mostly a rename, not a redesign.
//
//   Unlike DOLL-OS, there's no local scroll-back chord (no physical keyboard to
//   send one), so the panel always shows the tail of history -- it just follows
//   along live, the way a mirrored terminal should.

//   Boot / init

void pushDisplayFrame() {
#ifdef FNK0104N_3P5_320x480_ST77922
    tft_st77922.Fill_Colors(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, (uint16_t*)frameSprite.getPointer());
#else
    frameSprite.pushSprite(0, 0);
#endif
}

void initDisplay() {
    //history ring first, so its PSRAM use is accounted before the sprite snapshot below
    displayHistoryRows = (DisplayHistoryRow*) psramOrInternalCalloc(
        DISPLAY_HISTORY_MAX_LINES, sizeof(DisplayHistoryRow), "displayHistory");

    //the frame sprite is the big one (~150KB at 16bpp). TFT_eSPI routes it to PSRAM by
    //itself when psramFound() (Sprite.cpp callocSprite); snapshot the PSRAM pool around
    //createSprite so the boot log proves whether it actually landed there.
    size_t psramFreeBeforeSprite = ESP.getFreePsram();
#ifdef FNK0104N_3P5_320x480_ST77922
    tft_st77922.Init();
    tft_st77922.Set_Rotation(1);
    frameSprite.setColorDepth(16);
    frameSprite.createSprite(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    frameSprite.setSwapBytes(true);
#else
    tft.init();
    tft.setRotation(1);
    frameSprite.setColorDepth(16);
    frameSprite.createSprite(DISPLAY_WIDTH, DISPLAY_HEIGHT);
#endif
    Serial.printf("[psram] frameSprite: %u bytes drawn from PSRAM (0 => it fell back to internal RAM)\n",
                  (unsigned)(psramFreeBeforeSprite - ESP.getFreePsram()));

    frameSprite.setTextColor(TFT_WHITE, TFT_BLACK);
    frameSprite.fillSprite(TFT_BLACK);
    pushDisplayFrame();
}

void drawDisplayBootSplash() {
    frameSprite.fillSprite(TFT_CYAN);
    frameSprite.setTextDatum(MC_DATUM);
    frameSprite.setTextColor(TFT_PINK, TFT_CYAN);
    frameSprite.setTextSize(2);
    frameSprite.drawString("DS", DISPLAY_WIDTH / 2, DISPLAY_HEIGHT / 2 - 10);
    frameSprite.setTextSize(1);
    frameSprite.drawString("booting...", DISPLAY_WIDTH / 2, DISPLAY_HEIGHT / 2 + 14);
    frameSprite.setTextDatum(TL_DATUM);
    pushDisplayFrame();
}

//   Layout

int displayTerminalY() {
    return DISPLAY_STATUS_BAR_HEIGHT;
}
int displayTerminalHeight() {
    return DISPLAY_HEIGHT - DISPLAY_STATUS_BAR_HEIGHT - DISPLAY_COMMAND_BAR_HEIGHT;
}
int displayCommandBarY() {
    return DISPLAY_HEIGHT - DISPLAY_COMMAND_BAR_HEIGHT;
}

void markDisplayDirty() {
    displayDirty = true;
}

//single entry point for the three activeInput* globals (TelnetServer.ino, Motoko.ino,
//Ssh.ino, TelnetClient.ino, UsbMsc.ino all funnel through this) so the mirrored command
//bar can never go stale on the TFT because a call site forgot to mark the frame dirty
void setActiveInput(const String& prompt, const String& text, bool masked) {
    activeInputPrompt = prompt;
    activeInputText = text;
    activeInputMasked = masked;
    markDisplayDirty();
}

//   History ring buffer (mirrors DOLL-OS's HistoryRow / addWrappedHistoryLine)

static int displayCharWidth(char ch) {
    char glyph[2] = { ch, '\0' };
    return (int)frameSprite.textWidth(glyph);
}

static int displayHistoryPhysicalIndex(int logicalIndex) {
    return (displayHistoryHead + logicalIndex) % DISPLAY_HISTORY_MAX_LINES;
}

static void copyDisplayHistoryText(char* dest, const String& src) {
    int copyLen = min((int)src.length(), DISPLAY_HISTORY_ROW_MAX_CHARS - 1);
    for (int i = 0; i < copyLen; i++) {
        dest[i] = src[i];
    }
    dest[copyLen] = '\0';

    if (src.length() >= DISPLAY_HISTORY_ROW_MAX_CHARS && DISPLAY_HISTORY_ROW_MAX_CHARS > 4) {
        dest[DISPLAY_HISTORY_ROW_MAX_CHARS - 4] = '.';
        dest[DISPLAY_HISTORY_ROW_MAX_CHARS - 3] = '.';
        dest[DISPLAY_HISTORY_ROW_MAX_CHARS - 2] = '.';
        dest[DISPLAY_HISTORY_ROW_MAX_CHARS - 1] = '\0';
    }
}

static const char* displayHistoryRowText(int logicalIndex) {
    return displayHistoryRows[displayHistoryPhysicalIndex(logicalIndex)].text;
}
static uint16_t displayHistoryRowColor(int logicalIndex) {
    return displayHistoryRows[displayHistoryPhysicalIndex(logicalIndex)].color;
}

void addDisplayHistoryRow(const String& row, uint16_t color) {
    if (displayHistoryRows == nullptr) {
        return;   //allocation failed at boot -- keep count at 0 so nothing tries to render/read rows
    }
    displayOpenRowOwner = nullptr;   //a fresh row is becoming "last" via the non-streaming path

    int slot;
    if (displayHistoryCount < DISPLAY_HISTORY_MAX_LINES) {
        slot = displayHistoryPhysicalIndex(displayHistoryCount);
        displayHistoryCount++;
    } else {
        slot = displayHistoryHead;
        displayHistoryHead = (displayHistoryHead + 1) % DISPLAY_HISTORY_MAX_LINES;
    }

    copyDisplayHistoryText(displayHistoryRows[slot].text, row);
    displayHistoryRows[slot].color = color;
    markDisplayDirty();
}

void addDisplayLine(const String& line) {
    addDisplayLine(line, TFT_WHITE);
}

void addDisplayLine(const String& line, uint16_t color) {
    const int maxWidth = DISPLAY_WIDTH - (DISPLAY_PADDING * 2);
    if (maxWidth < 0) {
        return;
    }

    String row = "";
    row.reserve(min((int)line.length(), DISPLAY_HISTORY_ROW_MAX_CHARS - 1));
    int rowWidth = 0;

    for (int i = 0; i < line.length(); i++) {
        char ch = line[i];
        int charWidth = displayCharWidth(ch);

        if (row.length() > 0 && rowWidth + charWidth > maxWidth) {
            addDisplayHistoryRow(row, color);
            row = "";
            rowWidth = 0;
            if (ch == ' ') {
                continue;
            }
        }

        row += ch;
        rowWidth += charWidth;
    }

    addDisplayHistoryRow(row, color);
}

void updateLastDisplayHistoryRow(const String& row, uint16_t color) {
    if (displayHistoryCount == 0) {
        return;
    }
    int lastSlot = displayHistoryPhysicalIndex(displayHistoryCount - 1);
    copyDisplayHistoryText(displayHistoryRows[lastSlot].text, row);
    displayHistoryRows[lastSlot].color = color;
    markDisplayDirty();
}

void clearDisplayHistory() {
    displayHistoryCount = 0;
    displayHistoryHead = 0;
    displayOpenRowOwner = nullptr;
    markDisplayDirty();
}

//   Streaming API for raw remote byte mirroring (ssh, outbound telnet) -- one
//   DisplayStreamState instance per independent stream so interleaved streams
//   (ssh stdout vs stderr) don't corrupt each other's in-progress row

static void displayStreamCloseRow(DisplayStreamState& st) {
    if (displayOpenRowOwner == &st) {
        displayOpenRowOwner = nullptr;
    }
    st.pendingRow = "";
    st.cursorCol = 0;
    st.wrapDepth = 0;
    st.wrapPending = false;
}

//removes just the newest history row -- used when displayStreamBackspace merges a wrapped
//stream row back into its predecessor. Only ever called for a row the stream owns and just
//created, so displayHistoryHead is left alone: this peels the tail, never the ring's head.
static void popLastDisplayHistoryRow() {
    if (displayHistoryCount == 0) {
        return;
    }
    displayHistoryCount--;
    markDisplayDirty();
}

void displayStreamReset(DisplayStreamState& st) {
    displayStreamCloseRow(st);
}

void displayStreamNewline(DisplayStreamState& st) {
    displayStreamCloseRow(st);
}

void displayStreamPutChar(DisplayStreamState& st, char ch, uint16_t color) {
    const int maxWidth = DISPLAY_WIDTH - (DISPLAY_PADDING * 2);
    if (maxWidth < 0) {
        return;
    }

    if (displayOpenRowOwner != &st) {
        st.pendingRow = "";
        st.cursorCol = 0;
        //preserve the wrap-continuation link only when the open row is free because *we* just
        //wrapped it (owner == nullptr AND wrapPending). Any other cause -- a newline, a reset,
        //or another stream owning the open row -- starts a fresh logical line, so drop the link.
        if (displayOpenRowOwner != nullptr || !st.wrapPending) {
            st.wrapDepth = 0;
            st.wrapPending = false;
        }
    }

    bool atEnd = st.cursorCol >= (size_t)st.pendingRow.length();

    if (atEnd && st.pendingRow.length() > 0 &&
        frameSprite.textWidth(st.pendingRow + ch) > maxWidth) {
        st.pendingRow = "";
        st.cursorCol = 0;
        displayOpenRowOwner = nullptr;
        st.wrapPending = true;   //the panel row about to open continues this same logical line
        if (ch == ' ') {
            return;
        }
        atEnd = true;
    }

    if (atEnd) {
        st.pendingRow += ch;
    } else {
        st.pendingRow.setCharAt(st.cursorCol, ch);
    }
    st.cursorCol++;

    if (displayOpenRowOwner == &st) {
        updateLastDisplayHistoryRow(st.pendingRow, color);
    } else {
        addDisplayHistoryRow(st.pendingRow, color);
        displayOpenRowOwner = &st;
        if (st.wrapPending) {
            st.wrapDepth++;         //this new row is a wrap-continuation, reachable by backspace
            st.wrapPending = false;
        } else {
            st.wrapDepth = 0;       //first panel row of a fresh logical line
        }
    }
}

void displayStreamCarriageReturn(DisplayStreamState& st) {
    if (displayOpenRowOwner == &st) {
        st.cursorCol = 0;
    }
}

void displayStreamEraseToEnd(DisplayStreamState& st) {
    if (displayOpenRowOwner != &st || st.cursorCol >= (size_t)st.pendingRow.length()) {
        return;
    }
    st.pendingRow.remove(st.cursorCol);
    updateLastDisplayHistoryRow(st.pendingRow, displayHistoryRowColor(displayHistoryCount - 1));
}

void displayStreamBackspace(DisplayStreamState& st) {
    if (displayOpenRowOwner != &st) {
        return;
    }
    if (st.cursorCol == 0) {
        //at the left edge of the current panel row. If this logical line wrapped onto an
        //earlier panel row, peel this (now-empty) one off and keep deleting from the end of
        //the previous row -- otherwise backspace stalls here visually while the remote's own
        //line buffer keeps shrinking (the reported "deletes line 2 but not line 1" bug).
        if (st.wrapDepth == 0) {
            return;   //genuine start of the logical line -- nothing above it belongs to us
        }
        popLastDisplayHistoryRow();
        st.wrapDepth--;
        st.pendingRow = String(displayHistoryRowText(displayHistoryCount - 1));
        st.cursorCol = st.pendingRow.length();
        //displayOpenRowOwner stays &st -- we created the row we just re-adopted, too
    }
    st.cursorCol--;
    st.pendingRow.remove(st.cursorCol, 1);
    updateLastDisplayHistoryRow(st.pendingRow, displayHistoryRowColor(displayHistoryCount - 1));
}

//   ANSI/UTF-8 filter for raw remote streams -- display-only (telnet gets true
//   unfiltered passthrough, see Ssh.ino/TelnetClient.ino); ported from DOLL-OS's
//   ansi.ino, SGR colors now map onto real TFT_eSPI pixel constants instead of a
//   sprite-native palette pulled from a different graphics stack

static uint16_t ansiSgrColor(int code, uint16_t defaultColor) {
    switch (code) {
        case 0:               return defaultColor;
        case 30: case 90:     return TFT_BLACK;
        case 31: case 91:     return TFT_RED;
        case 32: case 92:     return TFT_GREEN;
        case 33: case 93:     return TFT_YELLOW;
        case 34: case 94:     return TFT_BLUE;
        case 35: case 95:     return TFT_MAGENTA;
        case 36: case 96:     return TFT_CYAN;
        case 37: case 97:     return TFT_WHITE;
        default:              return defaultColor;
    }
}

static uint16_t ansiApplySgr(const String& params, uint16_t currentColor, uint16_t defaultColor) {
    if (params.length() == 0) {
        return defaultColor;
    }
    uint16_t color = currentColor;
    int start = 0;
    while (start <= (int)params.length()) {
        int sep = params.indexOf(';', start);
        String token = (sep == -1) ? params.substring(start) : params.substring(start, sep);
        int code = token.length() ? token.toInt() : 0;
        color = ansiSgrColor(code, defaultColor);
        if (sep == -1) {
            break;
        }
        start = sep + 1;
    }
    return color;
}

bool ansiFilterByte(AnsiFilterState& st, uint8_t ch, uint16_t defaultColor, uint16_t& color, char& outCh, bool& colorChanged, bool& isBackspace, bool& eraseToEndOfLine) {
    colorChanged = false;
    isBackspace = false;
    eraseToEndOfLine = false;

    switch (st.state) {
        case ANSI_TEXT:
            if (ch == 0x1B) {
                st.state = ANSI_ESC;
                return false;
            }
            if (st.utf8Remaining > 0) {
                if ((ch & 0xC0) == 0x80) {
                    st.utf8Remaining--;
                    return false;
                }
                st.utf8Remaining = 0;
            }
            if (ch >= 0x80) {
                if ((ch & 0xE0) == 0xC0)      st.utf8Remaining = 1;
                else if ((ch & 0xF0) == 0xE0) st.utf8Remaining = 2;
                else if ((ch & 0xF8) == 0xF0) st.utf8Remaining = 3;
                outCh = '?';
                return true;
            }
            if (ch == 0x08 || ch == 0x7F) {
                isBackspace = true;
                return false;
            }
            if (ch == '\t' || (ch >= 0x20 && ch < 0x7F)) {
                outCh = (char)ch;
                return true;
            }
            return false;

        case ANSI_ESC:
            if (ch == '[') {
                st.state = ANSI_CSI;
                st.csiParams = "";
            } else if (ch == ']') {
                st.state = ANSI_OSC;
            } else {
                st.state = ANSI_TEXT;
            }
            return false;

        case ANSI_CSI:
            if (ch >= 0x40 && ch <= 0x7E) {
                if (ch == 'm') {
                    color = ansiApplySgr(st.csiParams, color, defaultColor);
                    colorChanged = true;
                } else if (ch == 'K') {
                    eraseToEndOfLine = true;
                }
                st.state = ANSI_TEXT;
            } else {
                st.csiParams += (char)ch;
            }
            return false;

        case ANSI_OSC:
            if (ch == 0x07) {
                st.state = ANSI_TEXT;
            } else if (ch == 0x1B) {
                st.state = ANSI_OSC_ESC;
            }
            return false;

        case ANSI_OSC_ESC:
            st.state = (ch == '\\') ? ANSI_TEXT : ANSI_OSC;
            return false;
    }

    return false;
}

//maps Output.ino's ANSI SGR color constants (C_RED etc.) onto real TFT_eSPI pixel
//colors -- outLine()'s own generated text (help/status/etc.) uses this so it shows
//up in roughly the same color on both the telnet session and the mirrored panel
uint16_t ansiCodeToPixelColor(int code) {
    switch (code) {
        case C_BLACK:   return TFT_BLACK;
        case C_RED:     return TFT_RED;
        case C_GREEN:   return TFT_GREEN;
        case C_YELLOW:  return TFT_YELLOW;
        case C_BLUE:    return TFT_BLUE;
        case C_MAGENTA: return TFT_MAGENTA;
        case C_CYAN:    return TFT_CYAN;
        case C_PINK:    return TFT_PINK;
        default:        return TFT_WHITE;
    }
}

//   Frame rendering -- called once per loop() tick from DS.ino, mirroring
//   DOLL-OS's own per-tick drawTerminalHistory()/drawCommandBar() calls

void drawDisplayStatusBar() {
    frameSprite.fillRect(0, 0, DISPLAY_WIDTH, DISPLAY_STATUS_BAR_HEIGHT, TFT_BLACK);
    frameSprite.setTextDatum(TL_DATUM);
    frameSprite.setTextColor(TFT_PINK, TFT_BLACK);
    frameSprite.drawString("DS", DISPLAY_PADDING, 2);

    char statusText[64];
    snprintf(statusText, sizeof(statusText), "MEM:%luKB BAT:%d%%",
        (unsigned long)(ESP.getFreeHeap() / 1000), readBatteryPercent());
    frameSprite.setTextDatum(TR_DATUM);
    frameSprite.setTextColor(TFT_WHITE, TFT_BLACK);
    frameSprite.drawString(statusText, DISPLAY_WIDTH - DISPLAY_PADDING, 2);

    frameSprite.drawFastHLine(0, DISPLAY_STATUS_BAR_HEIGHT - 1, DISPLAY_WIDTH, TFT_PINK);
    frameSprite.setTextDatum(TL_DATUM);
}

void drawDisplayHistory() {
    const int lineHeight = 12;
    const int top = displayTerminalY();
    const int height = displayTerminalHeight();

    frameSprite.fillRect(0, top, DISPLAY_WIDTH, height, TFT_BLACK);
    if (displayHistoryCount == 0) {
        return;
    }

    frameSprite.setTextDatum(TL_DATUM);
    const int visibleLines = max(1, height / lineHeight);
    const int lastLine = displayHistoryCount - 1;   //always pinned to newest -- no local scroll input on this panel
    const int firstLine = max(0, lastLine - visibleLines + 1);

    int y = top + DISPLAY_PADDING;
    for (int i = firstLine; i <= lastLine; i++) {
        frameSprite.setTextColor(displayHistoryRowColor(i), TFT_BLACK);
        frameSprite.drawString(displayHistoryRowText(i), DISPLAY_PADDING, y);
        y += lineHeight;
    }
    frameSprite.setTextColor(TFT_WHITE, TFT_BLACK);
}

void drawDisplayCommandBar() {
    const int y = displayCommandBarY();
    frameSprite.fillRect(0, y, DISPLAY_WIDTH, DISPLAY_COMMAND_BAR_HEIGHT, TFT_BLACK);
    frameSprite.drawFastHLine(0, y, DISPLAY_WIDTH, TFT_WHITE);
    frameSprite.setTextDatum(TL_DATUM);
    frameSprite.setTextColor(TFT_WHITE, TFT_BLACK);

    frameSprite.drawString(activeInputPrompt, DISPLAY_PADDING, y + DISPLAY_PADDING);
    int textX = DISPLAY_PADDING + (int)frameSprite.textWidth(activeInputPrompt);
    int maxWidth = max(0, DISPLAY_WIDTH - textX - DISPLAY_PADDING);

    String shown = activeInputText;
    if (activeInputMasked) {
        String masked;
        masked.reserve(shown.length());
        for (size_t i = 0; i < shown.length(); i++) {
            masked += '*';
        }
        shown = masked;
    }

    //this panel mirrors, it doesn't locally edit -- no cursor to keep visible, so a
    //too-long line just drops its head (shows the tail, where typing is happening)
    while (shown.length() > 0 && frameSprite.textWidth(shown) > maxWidth) {
        shown = shown.substring(1);
    }
    frameSprite.drawString(shown, textX, y + DISPLAY_PADDING);
}

//covers the terminal area with a warning banner -- used while USB MSC mode is active
void drawDisplayUsbWarning() {
    const int top = displayTerminalY();
    const int height = displayTerminalHeight();
    frameSprite.fillRect(0, top, DISPLAY_WIDTH, height, TFT_RED);
    frameSprite.setTextDatum(MC_DATUM);
    frameSprite.setTextColor(TFT_WHITE, TFT_RED);
    frameSprite.drawString("USB MODE ACTIVE", DISPLAY_WIDTH / 2, top + height / 2 - 8);
    frameSprite.drawString("Ctrl+T (telnet) to exit", DISPLAY_WIDTH / 2, top + height / 2 + 8);
    frameSprite.setTextDatum(TL_DATUM);
}

void drawDisplayFrame() {
    unsigned long now = millis();
    bool statusRefreshDue = (now - displayLastStatusRefresh) >= DISPLAY_STATUS_REFRESH_MS;
    if (!displayDirty && !statusRefreshDue) {
        return;   //nothing changed since the last push -- skip the full-frame redraw + SPI blit
    }
    displayDirty = false;
    displayLastStatusRefresh = now;

    drawDisplayStatusBar();
    if (usbModeDisplayActive) {
        drawDisplayUsbWarning();
    } else {
        drawDisplayHistory();
    }
    drawDisplayCommandBar();
    pushDisplayFrame();
}
