//   AppRunner.ino
//   tiny executable script runtime for DS. Apps are plain text .dapp files stored
//   in /apps on LittleFS or /sd/apps on the FTP-served SD card, then launched from
//   the shell with "run". The format is intentionally small: a few display/shell
//   commands, numeric variables, labels, and jumps.
#include <LittleFS.h>
#include <FS.h>
#include <SD_MMC.h>
#include <esp_heap_caps.h>

const int DAPP_MAX_LINES = 160;
const int DAPP_MAX_LABELS = 32;
const int DAPP_MAX_VARS = 16;
const int DAPP_MAX_STEPS = 1200;

struct DappLine {
    String text;
};

struct DappLabel {
    String name;
    int lineIndex;
};

struct DappVar {
    String name;
    long value;
    bool used;
};

static bool endsWithIgnoreCase(String value, const String& suffix) {
    value.toLowerCase();
    String s = suffix;
    s.toLowerCase();
    return value.endsWith(s);
}

static String trimCopy(String value) {
    value.trim();
    return value;
}

static String stripMatchingQuotes(String value) {
    value.trim();
    if (value.length() >= 2) {
        char first = value[0];
        char last = value[value.length() - 1];
        if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
            return value.substring(1, value.length() - 1);
        }
    }
    return value;
}

static bool isAppCommentOrBlank(const String& rawLine) {
    String line = trimCopy(rawLine);
    return line.length() == 0 || line.startsWith("#") || line.startsWith("//");
}

static int appColorByName(String name) {
    name.trim();
    name.toLowerCase();
    if (name == "black") return C_BLACK;
    if (name == "red") return C_RED;
    if (name == "green") return C_GREEN;
    if (name == "yellow") return C_YELLOW;
    if (name == "blue") return C_BLUE;
    if (name == "magenta") return C_MAGENTA;
    if (name == "cyan") return C_CYAN;
    if (name == "pink") return C_PINK;
    return C_WHITE;
}

static bool appOpenResolvedFile(const String& resolved, File& outFile) {
    RoutedPath r = routePath(resolved);
    if (r.isSd && !sdCardMounted) {
        return false;
    }

    File f = r.fs->open(r.realPath, "r");
    if (!f || f.isDirectory()) {
        if (f) {
            f.close();
        }
        return false;
    }

    outFile = f;
    return true;
}

static bool appOpenCandidate(const String& candidate, File& outFile, String& resolvedOut) {
    String resolved = resolvePath(cwd, candidate);
    if (appOpenResolvedFile(resolved, outFile)) {
        resolvedOut = resolved;
        return true;
    }

    if (!endsWithIgnoreCase(resolved, ".dapp") && appOpenResolvedFile(resolved + ".dapp", outFile)) {
        resolvedOut = resolved + ".dapp";
        return true;
    }

    return false;
}

static bool appOpenByName(const String& target, File& outFile, String& resolvedOut) {
    if (target.indexOf('/') >= 0) {
        return appOpenCandidate(target, outFile, resolvedOut);
    }

    String name = target;
    if (!endsWithIgnoreCase(name, ".dapp")) {
        name += ".dapp";
    }

    const String candidates[] = {
        "/sd/apps/" + name,
        "/apps/" + name,
        target,
    };

    for (int i = 0; i < 3; i++) {
        if (appOpenCandidate(candidates[i], outFile, resolvedOut)) {
            return true;
        }
    }
    return false;
}

static void ensureAppDirectories() {
    File flashApps = LittleFS.open("/apps");
    if (!flashApps || !flashApps.isDirectory()) {
        if (flashApps) {
            flashApps.close();
        }
        LittleFS.mkdir("/apps");
    } else {
        flashApps.close();
    }

    if (sdCardMounted) {
        File sdApps = SD_MMC.open("/apps");
        if (!sdApps || !sdApps.isDirectory()) {
            if (sdApps) {
                sdApps.close();
            }
            SD_MMC.mkdir("/apps");
        } else {
            sdApps.close();
        }
    }
}

static void listAppsInDir(fs::FS& fs, const String& realPath, const String& label) {
    File dir = fs.open(realPath);
    if (!dir || !dir.isDirectory()) {
        if (dir) {
            dir.close();
        }
        outLine(label + ": (missing)");
        return;
    }

    outLine(label + ":", C_CYAN);
    File entry = dir.openNextFile();
    int count = 0;
    while (entry) {
        String name = entry.name();
        if (!entry.isDirectory() && endsWithIgnoreCase(name, ".dapp")) {
            outLine("  " + name + "  " + String(entry.size()) + "b");
            count++;
        }
        entry.close();
        entry = dir.openNextFile();
    }
    if (count == 0) {
        outLine("  (none)");
    }
    dir.close();
}

void handleAppsCommand(const String parts[], int partCount) {
    ensureAppDirectories();
    outLine("Apps live in /sd/apps for FTP uploads, or /apps on flash.", C_CYAN);
    if (sdCardMounted) {
        listAppsInDir(SD_MMC, "/apps", "/sd/apps");
    } else {
        outLine("/sd/apps: SD not mounted", C_YELLOW);
    }
    listAppsInDir(LittleFS, "/apps", "/apps");
}

static int appFindLabel(const DappLabel labels[], int labelCount, String name) {
    name.trim();
    if (name.startsWith(":")) {
        name.remove(0, 1);
    }
    for (int i = 0; i < labelCount; i++) {
        if (labels[i].name == name) {
            return labels[i].lineIndex;
        }
    }
    return -1;
}

static int appFindVar(DappVar vars[], const String& name) {
    for (int i = 0; i < DAPP_MAX_VARS; i++) {
        if (vars[i].used && vars[i].name == name) {
            return i;
        }
    }
    return -1;
}

static int appEnsureVar(DappVar vars[], const String& name) {
    int existing = appFindVar(vars, name);
    if (existing >= 0) {
        return existing;
    }
    for (int i = 0; i < DAPP_MAX_VARS; i++) {
        if (!vars[i].used) {
            vars[i].used = true;
            vars[i].name = name;
            vars[i].value = 0;
            return i;
        }
    }
    return -1;
}

static bool appIsInteger(const String& token) {
    if (token.length() == 0) {
        return false;
    }
    int start = (token[0] == '-' || token[0] == '+') ? 1 : 0;
    if (start >= token.length()) {
        return false;
    }
    for (int i = start; i < token.length(); i++) {
        if (!isDigit(token[i])) {
            return false;
        }
    }
    return true;
}

static bool appIsNameChar(char ch) {
    return (ch >= 'a' && ch <= 'z')
        || (ch >= 'A' && ch <= 'Z')
        || (ch >= '0' && ch <= '9')
        || ch == '_';
}

static long appBuiltinValue(String name) {
    name.trim();
    name.toLowerCase();
    if (name == "battery") return readBatteryPercent();
    if (name == "heap") return heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    if (name == "millis") return millis();
    if (name == "seconds") return millis() / 1000;
    if (name == "wifi") return wifiIsConnected() == 1 ? 1 : 0;
    return 0;
}

static long appValueOf(String token, DappVar vars[]) {
    token.trim();
    token = stripMatchingQuotes(token);
    if (token.startsWith("$")) {
        token.remove(0, 1);
    }
    if (appIsInteger(token)) {
        return token.toInt();
    }
    int slot = appFindVar(vars, token);
    if (slot >= 0) {
        return vars[slot].value;
    }
    return appBuiltinValue(token);
}

static String appStringValueOf(String token, DappVar vars[]) {
    token.trim();
    if (token.startsWith("$")) {
        token.remove(0, 1);
    }
    int slot = appFindVar(vars, token);
    if (slot >= 0) {
        return String(vars[slot].value);
    }

    String lowered = token;
    lowered.toLowerCase();
    if (lowered == "cwd") return cwd;
    if (lowered == "ip") return WiFi.localIP().toString();
    if (lowered == "battery") return String(readBatteryPercent());
    if (lowered == "heap") return String(heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    if (lowered == "millis") return String(millis());
    if (lowered == "seconds") return String(millis() / 1000);
    if (lowered == "wifi") return wifiIsConnected() == 1 ? "1" : "0";
    return "";
}

static String appExpandText(String text, DappVar vars[]) {
    text = stripMatchingQuotes(text);
    String out = "";
    for (int i = 0; i < text.length(); i++) {
        if (text[i] != '$') {
            out += text[i];
            continue;
        }

        int start = i + 1;
        int end = start;
        while (end < text.length() && appIsNameChar(text[end])) {
            end++;
        }
        if (end == start) {
            out += '$';
            continue;
        }

        String name = text.substring(start, end);
        out += appStringValueOf(name, vars);
        i = end - 1;
    }
    return out;
}

static void appDelay(unsigned long waitMs) {
    unsigned long started = millis();
    while (millis() - started < waitMs) {
        ftpService();
        radioService();
        maintainInternetConnection();
        drawDisplayFrame();
        delay(1);
    }
}

static bool appCompare(long left, const String& op, long right) {
    if (op == "==" || op == "=") return left == right;
    if (op == "!=" || op == "<>") return left != right;
    if (op == ">") return left > right;
    if (op == "<") return left < right;
    if (op == ">=") return left >= right;
    if (op == "<=") return left <= right;
    return false;
}

static bool appLoad(File& file, DappLine lines[], int& lineCount, DappLabel labels[], int& labelCount) {
    lineCount = 0;
    labelCount = 0;

    while (file.available()) {
        String line = file.readStringUntil('\n');
        if (line.endsWith("\r")) {
            line.remove(line.length() - 1);
        }

        if (lineCount >= DAPP_MAX_LINES) {
            outLine("run: too many app lines (max " + String(DAPP_MAX_LINES) + ")", C_RED);
            return false;
        }

        String trimmed = trimCopy(line);
        if (!isAppCommentOrBlank(trimmed)) {
            if (trimmed.startsWith(":") && labelCount < DAPP_MAX_LABELS) {
                labels[labelCount++] = { trimmed.substring(1), lineCount };
            } else {
                String op = trimmed;
                int space = op.indexOf(' ');
                if (space >= 0) {
                    op = op.substring(0, space);
                }
                op.toUpperCase();
                if (op == "LABEL" && space >= 0 && labelCount < DAPP_MAX_LABELS) {
                    labels[labelCount++] = { trimCopy(trimmed.substring(space + 1)), lineCount };
                }
            }
        }

        lines[lineCount++].text = line;
    }

    return true;
}

static bool appExecute(DappLine lines[], int lineCount, DappLabel labels[], int labelCount) {
    DappVar vars[DAPP_MAX_VARS] = {};
    int pc = 0;
    int steps = 0;
    int color = C_WHITE;

    while (pc >= 0 && pc < lineCount) {
        if (++steps > DAPP_MAX_STEPS) {
            outLine("run: stopped after " + String(DAPP_MAX_STEPS) + " steps (possible loop)", C_RED);
            return false;
        }

        String line = trimCopy(lines[pc].text);
        pc++;
        if (isAppCommentOrBlank(line) || line.startsWith(":")) {
            continue;
        }

        int space = line.indexOf(' ');
        String op = (space >= 0) ? line.substring(0, space) : line;
        String arg = (space >= 0) ? trimCopy(line.substring(space + 1)) : "";
        op.toUpperCase();

        if (op == "LABEL") {
            continue;
        } else if (op == "PRINT" || op == "ECHO") {
            outLine(appExpandText(arg, vars), color);
        } else if (op == "COLOR") {
            color = appColorByName(arg);
        } else if (op == "CLEAR" || op == "CLS") {
            outClearScreen();
        } else if (op == "WAIT" || op == "SLEEP") {
            appDelay((unsigned long)appValueOf(arg, vars));
        } else if (op == "SET") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: SET needs <name> <value>", C_RED);
                return false;
            }
            int slot = appEnsureVar(vars, parts[0]);
            if (slot < 0) {
                outLine("run: too many variables", C_RED);
                return false;
            }
            vars[slot].value = appValueOf(parts[1], vars);
        } else if (op == "ADD") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: ADD needs <name> <value>", C_RED);
                return false;
            }
            int slot = appEnsureVar(vars, parts[0]);
            if (slot < 0) {
                outLine("run: too many variables", C_RED);
                return false;
            }
            vars[slot].value += appValueOf(parts[1], vars);
        } else if (op == "GOTO") {
            int target = appFindLabel(labels, labelCount, arg);
            if (target < 0) {
                outLine("run: label not found: " + arg, C_RED);
                return false;
            }
            pc = target;
        } else if (op == "IF") {
            String parts[5];
            int count = splitCommand(arg, parts, 5);
            String jumpOp = (count >= 4) ? parts[3] : "";
            jumpOp.toUpperCase();
            if (count < 5 || jumpOp != "GOTO") {
                outLine("run: IF syntax is IF <left> <op> <right> GOTO <label>", C_RED);
                return false;
            }
            if (appCompare(appValueOf(parts[0], vars), parts[1], appValueOf(parts[2], vars))) {
                int target = appFindLabel(labels, labelCount, parts[4]);
                if (target < 0) {
                    outLine("run: label not found: " + parts[4], C_RED);
                    return false;
                }
                pc = target;
            }
        } else if (op == "EXIT" || op == "END") {
            return true;
        } else {
            outLine("run: unknown app command: " + op, C_RED);
            return false;
        }
    }

    return true;
}

void handleRunCommand(const String parts[], int partCount) {
    if (partCount < 2) {
        outLine("Usage: run <app|path.dapp>");
        outLine("Upload apps to /sd/apps over FTP, then run <name>.");
        return;
    }

    File file;
    String resolved;
    if (!appOpenByName(parts[1], file, resolved)) {
        outLine("run: app not found: " + parts[1], C_RED);
        outLine("Try 'apps' to list installed .dapp files.");
        return;
    }

    DappLine lines[DAPP_MAX_LINES];
    DappLabel labels[DAPP_MAX_LABELS];
    int lineCount = 0;
    int labelCount = 0;

    outLine("Running " + resolved, C_GREEN);
    bool loaded = appLoad(file, lines, lineCount, labels, labelCount);
    file.close();
    if (!loaded) {
        return;
    }

    bool ok = appExecute(lines, lineCount, labels, labelCount);
    outLine(ok ? "[app exited]" : "[app stopped]", ok ? C_GREEN : C_RED);
}
