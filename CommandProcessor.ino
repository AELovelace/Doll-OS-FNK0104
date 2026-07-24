//   CommandProcessor.ino
//   parses and runs terminal commands for DS. Ported near-verbatim from
//   DOLL-OS's CommandProcessor.ino -- tokenizing, history, and dispatch are all
//   display-agnostic, so only the output calls changed (addWrappedHistoryLine -> outLine).

int splitCommand(const String& input, String parts[], int maxParts) {
    String working = input;
    working.trim();

    int count = 0;
    int start = 0;
    int len = working.length();
    while (start < len && count < maxParts) {
        while (start < len && working[start] == ' ') {
            start++;
        }
        if (start >= len) {
            break;
        }
        char c = working[start];
        if (c == '"' || c == '\'') {
            char quote = c;
            start++;
            int end = working.indexOf(quote, start);
            if (end == -1) {
                parts[count++] = working.substring(start);
                break;
            }
            parts[count++] = working.substring(start, end);
            start = end + 1;
            continue;
        }
        int end = working.indexOf(' ', start);
        if (end == -1) {
            parts[count++] = working.substring(start);
            break;
        }
        parts[count++] = working.substring(start, end);
        start = end + 1;
    }
    return count;
}

static int commandHistoryPhysicalIndex(int logicalIndex) {
    return (commandHistoryHead + logicalIndex) % COMMAND_HISTORY_MAX;
}

void addCommandHistory(const String& cmd) {
    if (cmd.length() == 0) {
        return;
    }
    if (commandHistoryCount < COMMAND_HISTORY_MAX) {
        int slot = commandHistoryPhysicalIndex(commandHistoryCount);
        commandHistory[slot] = cmd;
        commandHistoryCount++;
    } else {
        commandHistory[commandHistoryHead] = cmd;
        commandHistoryHead = (commandHistoryHead + 1) % COMMAND_HISTORY_MAX;
    }
    commandHistoryIndex = -1;
}

void recallCommandHistory(int step, String& text) {
    if (commandHistoryCount == 0) {
        return;
    }

    if (commandHistoryIndex == -1) {
        if (step > 0) {
            return;
        }
        commandHistoryDraft = text;
        commandHistoryIndex = commandHistoryCount - 1;
    } else {
        int newIndex = commandHistoryIndex + step;
        if (newIndex < 0) {
            newIndex = 0;
        } else if (newIndex >= commandHistoryCount) {
            commandHistoryIndex = -1;
            text = commandHistoryDraft;
            return;
        }
        commandHistoryIndex = newIndex;
    }

    text = commandHistory[commandHistoryPhysicalIndex(commandHistoryIndex)];
}

struct CommandEntry {
    const char* name;
    void (*handler)(const String parts[], int partCount);
};

void helpCommandHandler(const String parts[], int partCount) {
    outLine("Commands: battery, calc, cat, cd, clear, dice, free, help, ip, ls,");
    outLine("          motoko, ping, pwd, reboot, ssh, status, telnet, uptime,");
    outLine("          usb, wifi");
}

void handleRebootCommand(const String parts[], int partCount) {
    outLine("Restarting...");
    drawDisplayFrame();   //ESP.restart() below never returns to loop(), so paint the panel now --
                           //otherwise a keyboard-driven reboot gives no on-device feedback
    telnetClient.flush();
    delay(500);
    ESP.restart();
}

void handleUptimeCommand(const String parts[], int partCount) {
    unsigned long totalSeconds = millis() / 1000;
    unsigned long days = totalSeconds / 86400;
    unsigned long hours = (totalSeconds % 86400) / 3600;
    unsigned long minutes = (totalSeconds % 3600) / 60;
    unsigned long seconds = totalSeconds % 60;

    char buf[64];
    snprintf(buf, sizeof(buf), "Uptime: %lu days, %02lu:%02lu:%02lu", days, hours, minutes, seconds);
    outLine(String(buf));
}

void handleStatusCommand(const String parts[], int partCount) {
    outLine("");
    outLine("Wi-Fi status", C_CYAN);
    outLine("-----------");
    if (apActive) {
        outLine("Access point: " + String(AP_SSID) + " (fallback, active)");
        outLine("AP IP: " + WiFi.softAPIP().toString());
        outLine("AP clients: " + String(WiFi.softAPgetStationNum()));
    } else {
        outLine("Access point: off");
    }
    if (wifiIsConnected() == 1) {
        outLine("Router: connected");
        outLine("Router SSID: " + WiFi.SSID());
        outLine("Station IP: " + WiFi.localIP().toString());
        outLine("Signal: " + String(WiFi.RSSI()) + " dBm");
    } else {
        outLine("Router: disconnected");
    }
    outLine("");
}

//sorted alphabetically for readability; lookup is a linear scan since the table is small
static const CommandEntry commandTable[] = {
    { "battery", handleBatteryCommand },
    { "calc",   handleCalcCommand },
    { "cat",    handleCatCommand },
    { "cd",     handleCdCommand },
    { "dice",   handleDiceCommand },
    { "free",   handleFreeCommand },
    { "help",   helpCommandHandler },
    { "ip",     handleIpCommand },
    { "ls",     handleLsCommand },
    { "motoko", handleMotokoCommand },
    { "ping",   handlePingCommand },
    { "pwd",    handlePwdCommand },
    { "reboot", handleRebootCommand },
    { "ssh",    handleSshCommand },
    { "status", handleStatusCommand },
    { "telnet", handleTelnetCommand },
    { "uptime", handleUptimeCommand },
    { "usb",    handleUsbCommand },
    { "wifi",   handleWifiCommand },
};
static const int commandTableSize = sizeof(commandTable) / sizeof(commandTable[0]);

//takes the finished command line, runs it, and clears the buffer for the next entry
void commandProcessor(String& command) {
    if (command.length() == 0) {
        return;
    }

    String entered = command;
    command = "";
    commandCursorPos = 0;

    String trimmedEntered = entered;
    trimmedEntered.trim();
    addCommandHistory(trimmedEntered);

    String parts[8];
    int partCount = splitCommand(entered, parts, 8);
    if (partCount == 0) {
        return;
    }
    if (parts[0] == "clear") {
        outClearScreen();
        return;
    }

    for (int i = 0; i < commandTableSize; i++) {
        if (parts[0] == commandTable[i].name) {
            commandTable[i].handler(parts, partCount);
            return;
        }
    }
    outLine("Unknown command: " + entered, C_RED);
}
