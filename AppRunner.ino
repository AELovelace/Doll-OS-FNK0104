//   AppRunner.ino
//   tiny executable script runtime for DOLL-OS. Apps are plain text .dapp files stored
//   in /apps on LittleFS or /sd/apps on the FTP-served SD card, then launched from
//   the shell with "run". The format is intentionally small: a few display/shell
//   commands, numeric variables, labels, and jumps.
#include <LittleFS.h>
#include <FS.h>
#include <SD_MMC.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <new>
//EXPR hands whole arithmetic expressions to the same evaluator the "calc" shell command
//uses (Calc.ino). The script language deliberately has no expression grammar of its own --
//there is no reason to grow a second, worse one when this is already linked in.
#include "tinyexpr.h"

//   Where a running app's memory lives
//   The whole script is read into RAM before the first line executes, so these caps are
//   really a memory budget. They used to be far smaller (160 lines / 32 labels / 16 vars)
//   because the arrays were plain stack locals in handleRunCommand and appExecute -- a
//   String is only a 12-byte header, but 160 of them plus labels already spent ~2.5KB of
//   the loopTask's 8KB stack, and the interpreter still has to run string expansion and
//   display work underneath. Raising the constants alone would have overflowed the stack
//   rather than printing a limit error.
//   They now come from PSRAM instead (DappProgram::alloc below), which this board has 8MB
//   of, so the caps are set by what a text script plausibly needs rather than by the
//   stack. 4000 lines matches EDIT_MAX_LINES in Edit.ino -- the on-device editor could
//   already write files longer than the runner would accept.
const int DAPP_MAX_LINES = 4000;
const int DAPP_MAX_LABELS = 256;
const int DAPP_MAX_VARS = 64;
const int DAPP_MAX_STRING_VARS = 32;
const int DAPP_MAX_STRING_LEN = 4096;

//   DIM'd numeric arrays. Every array carves cells out of one shared pool rather than
//   allocating its own block, so the memory cost is fixed at load time whatever the script
//   DIMs -- 8192 longs is 32KB of PSRAM, and a 10x20 Tetris well plus its piece tables
//   spends under 500 of them.
const int DAPP_MAX_ARRAYS = 16;
const int DAPP_ARRAY_POOL_CELLS = 8192;

//GOSUB nesting. Deep enough for the routine-calls-routine shape real scripts have, shallow
//enough that a runaway recursion reports a clean error instead of eating PSRAM.
const int DAPP_MAX_CALL_DEPTH = 64;

//CANVAS bounds. The panel can't usefully render finer than this, and the cap keeps the
//cell buffer (2 bytes/cell) under 15KB at its largest.
const int DAPP_CANVAS_MAX_COLS = 120;
const int DAPP_CANVAS_MAX_ROWS = 60;

//runaway-loop backstop. Generous now that it isn't standing in for a memory limit, but a
//tight GOTO loop at this cap runs for minutes, and the interpreter only services the
//display/radio inside WAIT and INPUT -- so appExecute yields every DAPP_STEPS_PER_YIELD
//steps to keep the scheduler and watchdog fed through a long compute loop.
//
//The counter resets whenever the script blocks on purpose (a WAIT with a real duration, or
//an INPUT), because "runaway" means *not yielding*: a game loop that paces itself with
//WAIT 30 would otherwise hit the cap after a few minutes of legitimate play, while a tight
//GOTO loop -- the thing this actually guards against -- never resets and still trips.
const int DAPP_MAX_STEPS = 1000000;
const int DAPP_STEPS_PER_YIELD = 256;

//placement-new over one PSRAM block per array: heap_caps_calloc gives raw bytes, and
//these elements hold Strings that need their constructors run. Returns false with
//everything released if any block can't be had.
bool DappProgram::alloc() {
    void* lineMem = psramOrInternalCalloc(DAPP_MAX_LINES, sizeof(DappLine), "dappLines");
    void* labelMem = psramOrInternalCalloc(DAPP_MAX_LABELS, sizeof(DappLabel), "dappLabels");
    void* varMem = psramOrInternalCalloc(DAPP_MAX_VARS, sizeof(DappVar), "dappVars");
    void* stringVarMem = psramOrInternalCalloc(DAPP_MAX_STRING_VARS, sizeof(DappStringVar), "dappStringVars");
    void* arrayMem = psramOrInternalCalloc(DAPP_MAX_ARRAYS, sizeof(DappArray), "dappArrays");
    //the pool and the call stack are plain longs/ints -- calloc's zeroing is their whole
    //initialization, so unlike the four above they need no placement-new pass
    void* poolMem = psramOrInternalCalloc(DAPP_ARRAY_POOL_CELLS, sizeof(long), "dappArrayPool");
    void* callMem = psramOrInternalCalloc(DAPP_MAX_CALL_DEPTH, sizeof(int), "dappCallStack");

    if (!lineMem || !labelMem || !varMem || !stringVarMem || !arrayMem || !poolMem || !callMem) {
        heap_caps_free(lineMem);
        heap_caps_free(labelMem);
        heap_caps_free(varMem);
        heap_caps_free(stringVarMem);
        heap_caps_free(arrayMem);
        heap_caps_free(poolMem);
        heap_caps_free(callMem);
        return false;
    }

    lines = (DappLine*)lineMem;
    labels = (DappLabel*)labelMem;
    vars = (DappVar*)varMem;
    stringVars = (DappStringVar*)stringVarMem;
    arrays = (DappArray*)arrayMem;
    arrayPool = (long*)poolMem;
    callStack = (int*)callMem;

    for (int i = 0; i < DAPP_MAX_LINES; i++) new (&lines[i]) DappLine();
    for (int i = 0; i < DAPP_MAX_LABELS; i++) new (&labels[i]) DappLabel();
    for (int i = 0; i < DAPP_MAX_VARS; i++) new (&vars[i]) DappVar();
    for (int i = 0; i < DAPP_MAX_STRING_VARS; i++) new (&stringVars[i]) DappStringVar();
    for (int i = 0; i < DAPP_MAX_ARRAYS; i++) new (&arrays[i]) DappArray();

    //the () above is value-initialization, so the plain members (`used`, `lineIndex`,
    //`value`) are zeroed and the Strings are properly constructed -- appEnsureVar can
    //trust `used == false` on a fresh program.
    return true;
}

DappProgram::~DappProgram() {
    if (lines) {
        for (int i = 0; i < DAPP_MAX_LINES; i++) lines[i].~DappLine();
        heap_caps_free(lines);
    }
    if (labels) {
        for (int i = 0; i < DAPP_MAX_LABELS; i++) labels[i].~DappLabel();
        heap_caps_free(labels);
    }
    if (vars) {
        for (int i = 0; i < DAPP_MAX_VARS; i++) vars[i].~DappVar();
        heap_caps_free(vars);
    }
    if (stringVars) {
        for (int i = 0; i < DAPP_MAX_STRING_VARS; i++) stringVars[i].~DappStringVar();
        heap_caps_free(stringVars);
    }
    if (arrays) {
        for (int i = 0; i < DAPP_MAX_ARRAYS; i++) arrays[i].~DappArray();
        heap_caps_free(arrays);
    }
    //no per-array free: every DappArray::values points into arrayPool, which goes as one block
    if (arrayPool) {
        heap_caps_free(arrayPool);
    }
    if (callStack) {
        heap_caps_free(callStack);
    }
}

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

    ledPulseStorageRead(r.isSd);
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
        "/system/apps/" + name,
        target,
    };

    for (int i = 0; i < 4; i++) {
        if (appOpenCandidate(candidates[i], outFile, resolvedOut)) {
            return true;
        }
    }
    return false;
}

static void ensureAppDirectories() {
    ledPulseStorageRead(false);
    File flashApps = LittleFS.open("/apps");
    if (!flashApps || !flashApps.isDirectory()) {
        if (flashApps) {
            flashApps.close();
        }
        ledPulseStorageWrite(false);
        LittleFS.mkdir("/apps");
    } else {
        flashApps.close();
    }

    if (sdCardMounted) {
        ledPulseStorageRead(true);
        File sdApps = SD_MMC.open("/apps");
        if (!sdApps || !sdApps.isDirectory()) {
            if (sdApps) {
                sdApps.close();
            }
            ledPulseStorageWrite(true);
            SD_MMC.mkdir("/apps");
        } else {
            sdApps.close();
        }
    }
}

static void listAppsInDir(fs::FS& fs, const String& realPath, const String& label) {
    bool isSd = label.startsWith("/sd/");
    ledPulseStorageRead(isSd);
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
        ledPulseStorageRead(isSd);
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
    outLine("Apps: SD overrides, Dapper/user apps, then firmware fallbacks.", C_CYAN);
    if (sdCardMounted) {
        listAppsInDir(SD_MMC, "/apps", "/sd/apps");
    } else {
        outLine("/sd/apps: SD not mounted", C_YELLOW);
    }
    listAppsInDir(LittleFS, "/apps", "/apps");
    listAppsInDir(LittleFS, "/system/apps", "/system/apps");
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

static int appFindStringVar(DappStringVar vars[], const String& name) {
    for (int i = 0; i < DAPP_MAX_STRING_VARS; i++) {
        if (vars[i].used && vars[i].name == name) {
            return i;
        }
    }
    return -1;
}

static int appEnsureStringVar(DappStringVar vars[], const String& name) {
    int existing = appFindStringVar(vars, name);
    if (existing >= 0) {
        return existing;
    }
    for (int i = 0; i < DAPP_MAX_STRING_VARS; i++) {
        if (!vars[i].used) {
            vars[i].used = true;
            vars[i].name = name;
            vars[i].value = "";
            vars[i].value.reserve(80);
            return i;
        }
    }
    return -1;
}

static void appSetStringValue(DappStringVar vars[], int slot, const String& value) {
    vars[slot].value = value.substring(0, DAPP_MAX_STRING_LEN);
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

//   Arrays (DIM)
//
//   Reads and writes go through appArrayCell, which is the only place a bad index can be
//   caught -- and it has no way to return an error, since it is called from deep inside
//   value expansion. It sets program.fault instead; appExecute checks that after every
//   instruction and stops the app. A silently-zero out-of-range read is exactly the bug
//   that makes a 200-cell game board impossible to debug, so it is worth the plumbing.

static int appFindArray(DappProgram& program, const String& name) {
    for (int i = 0; i < DAPP_MAX_ARRAYS; i++) {
        if (program.arrays[i].used && program.arrays[i].name == name) {
            return i;
        }
    }
    return -1;
}

static long* appArrayCell(DappProgram& program, const String& name, long index) {
    int slot = appFindArray(program, name);
    if (slot < 0) {
        program.fault = "no array named " + name + " (DIM it first)";
        return nullptr;
    }
    if (index < 0 || index >= program.arrays[slot].size) {
        program.fault = "index " + String(index) + " outside " + name +
                        "[0.." + String(program.arrays[slot].size - 1) + "]";
        return nullptr;
    }
    return &program.arrays[slot].values[index];
}

//carves `size` cells off the shared pool. Re-DIMming a name at its existing size just
//zeroes it -- that is what a script restarting a game wants, and it costs no new cells.
static bool appDimArray(DappProgram& program, const String& name, long size) {
    if (size <= 0) {
        outLine("run: DIM size must be greater than 0", C_RED);
        return false;
    }

    int existing = appFindArray(program, name);
    if (existing >= 0) {
        if (program.arrays[existing].size != (int)size) {
            outLine("run: " + name + " is already DIM'd at " + String(program.arrays[existing].size), C_RED);
            return false;
        }
        for (int i = 0; i < program.arrays[existing].size; i++) {
            program.arrays[existing].values[i] = 0;
        }
        return true;
    }

    if (program.arrayPoolUsed + size > DAPP_ARRAY_POOL_CELLS) {
        outLine("run: out of array space (max " + String(DAPP_ARRAY_POOL_CELLS) + " cells total)", C_RED);
        return false;
    }

    for (int i = 0; i < DAPP_MAX_ARRAYS; i++) {
        if (program.arrays[i].used) {
            continue;
        }
        program.arrays[i].used = true;
        program.arrays[i].name = name;
        program.arrays[i].values = program.arrayPool + program.arrayPoolUsed;
        program.arrays[i].size = (int)size;
        for (int c = 0; c < (int)size; c++) {
            program.arrays[i].values[c] = 0;
        }
        program.arrayPoolUsed += (int)size;
        return true;
    }

    outLine("run: too many arrays (max " + String(DAPP_MAX_ARRAYS) + ")", C_RED);
    return false;
}

//splits "board[$i+1]" into "board" and "$i+1". Takes the first '[' and the last ']' so a
//nested subscript (board[$row[$i]]) stays intact for the recursive evaluation above.
static bool appParseSubscript(const String& token, String& nameOut, String& indexOut) {
    int open = token.indexOf('[');
    if (open <= 0 || !token.endsWith("]")) {
        return false;
    }
    nameOut = trimCopy(token.substring(0, open));
    indexOut = trimCopy(token.substring(open + 1, token.length() - 1));
    return nameOut.length() > 0 && indexOut.length() > 0;
}

//index just past the ']' that closes the '[' at openIdx, or -1 if it never closes. Used by
//the text expanders, which scan a name and then have to know where its subscript ends.
static int appScanSubscript(const String& text, int openIdx) {
    int depth = 0;
    for (int i = openIdx; i < (int)text.length(); i++) {
        if (text[i] == '[') {
            depth++;
        } else if (text[i] == ']') {
            depth--;
            if (depth == 0) {
                return i + 1;
            }
        }
    }
    return -1;
}

//   Key codes returned by KEY. Deliberately small and printable-ASCII-compatible: anything
//   32..126 is the character itself, so a script can compare against "a" via its code or
//   just use these names for the rest.
const long DAPP_KEY_NONE  = 0;
const long DAPP_KEY_UP    = 1;
const long DAPP_KEY_DOWN  = 2;
const long DAPP_KEY_LEFT  = 3;
const long DAPP_KEY_RIGHT = 4;
const long DAPP_KEY_ENTER = 5;
const long DAPP_KEY_ESC   = 6;
const long DAPP_KEY_BACK  = 8;
const long DAPP_KEY_TAB   = 9;
const long DAPP_KEY_SPACE = 32;

//file-op status, declared up here because appBuiltinValue below reads them; the handle
//itself and the routines live in the Files section further down
static long dappFok = 0;    //result of the last FOPEN/FDELETE, read as $fok
static long dappFeof = 0;   //set by FREAD at end of file, read as $feof

static long appBuiltinValue(String name) {
    name.trim();
    name.toLowerCase();
    if (name == "battery") return readBatteryPercent();
    if (name == "heap") return heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    if (name == "millis") return millis();
    if (name == "seconds") return millis() / 1000;
    if (name == "wifi") return wifiIsConnected() == 1 ? 1 : 0;
    if (name == "fok") return dappFok;
    if (name == "feof") return dappFeof;
    if (name == "ledok") return rearLedAvailable() ? 1 : 0;

    //KEY's vocabulary, so scripts compare against a name instead of a magic number.
    //Numeric only -- these are not defined for string expansion (PRINT "$kup" is empty),
    //because they exist to be compared, not printed.
    if (name == "kup") return DAPP_KEY_UP;
    if (name == "kdown") return DAPP_KEY_DOWN;
    if (name == "kleft") return DAPP_KEY_LEFT;
    if (name == "kright") return DAPP_KEY_RIGHT;
    if (name == "kenter") return DAPP_KEY_ENTER;
    if (name == "kesc") return DAPP_KEY_ESC;
    if (name == "kback") return DAPP_KEY_BACK;
    if (name == "ktab") return DAPP_KEY_TAB;
    if (name == "kspace") return DAPP_KEY_SPACE;
    return 0;
}

static long appValueOf(String token, DappProgram& program) {
    token.trim();
    token = stripMatchingQuotes(token);
    if (token.startsWith("$")) {
        token.remove(0, 1);
    }

    String name;
    String indexToken;
    if (appParseSubscript(token, name, indexToken)) {
        long* cell = appArrayCell(program, name, appValueOf(indexToken, program));
        return cell ? *cell : 0;
    }

    if (appIsInteger(token)) {
        return token.toInt();
    }
    int slot = appFindVar(program.vars, token);
    if (slot >= 0) {
        return program.vars[slot].value;
    }
    return appBuiltinValue(token);
}

static String appStringValueOf(String token, DappProgram& program) {
    token.trim();
    if (token.startsWith("$")) {
        token.remove(0, 1);
    }

    String name;
    String indexToken;
    if (appParseSubscript(token, name, indexToken)) {
        long* cell = appArrayCell(program, name, appValueOf(indexToken, program));
        return cell ? String(*cell) : "";
    }

    int stringSlot = appFindStringVar(program.stringVars, token);
    if (stringSlot >= 0) {
        return program.stringVars[stringSlot].value;
    }
    int slot = appFindVar(program.vars, token);
    if (slot >= 0) {
        return String(program.vars[slot].value);
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
    if (lowered == "fok") return String(dappFok);
    if (lowered == "feof") return String(dappFeof);
    if (lowered == "ledok") return rearLedAvailable() ? "1" : "0";
    return "";
}

//shared scanner for the two expanders below: at text[i] == '$', works out how far the
//reference runs (name, plus a [subscript] if one follows) and hands back the reference
//text without the '$'. Returns the index to continue scanning from, or -1 if the '$' is
//not the start of a reference and should be emitted literally.
static int appScanReference(const String& text, int dollarIdx, String& refOut) {
    int start = dollarIdx + 1;
    int end = start;
    while (end < (int)text.length() && appIsNameChar(text[end])) {
        end++;
    }
    if (end == start) {
        return -1;
    }
    if (end < (int)text.length() && text[end] == '[') {
        int close = appScanSubscript(text, end);
        if (close > 0) {
            end = close;
        }
    }
    refOut = text.substring(start, end);
    return end;
}

static String appExpandText(String text, DappProgram& program) {
    text = stripMatchingQuotes(text);
    String out = "";
    for (int i = 0; i < (int)text.length(); i++) {
        if (text[i] != '$') {
            out += text[i];
            continue;
        }

        String ref;
        int next = appScanReference(text, i, ref);
        if (next < 0) {
            out += '$';
            continue;
        }
        out += appStringValueOf(ref, program);
        i = next - 1;
    }
    return out;
}

//EXPR's expander. Same scan as appExpandText, but every reference becomes its *numeric*
//value -- a string variable landing in the middle of an expression would only ever be a
//syntax error, so this guarantees tinyexpr sees digits wherever the script wrote a '$'.
static String appExpandNumericText(const String& text, DappProgram& program) {
    String out = "";
    for (int i = 0; i < (int)text.length(); i++) {
        if (text[i] != '$') {
            out += text[i];
            continue;
        }

        String ref;
        int next = appScanReference(text, i, ref);
        if (next < 0) {
            out += '$';
            continue;
        }
        out += String(appValueOf(ref, program));
        i = next - 1;
    }
    return out;
}

static String appStringOperand(String token, DappProgram& program) {
    token.trim();
    bool explicitVariable = token.startsWith("$");
    bool quoted = token.length() >= 2 &&
        ((token[0] == '"' && token[token.length() - 1] == '"') ||
         (token[0] == '\'' && token[token.length() - 1] == '\''));

    if (explicitVariable ||
        (!quoted && appFindStringVar(program.stringVars, token) >= 0) ||
        (!quoted && appFindVar(program.vars, token) >= 0)) {
        return appStringValueOf(token, program);
    }

    return appExpandText(token, program);
}

//resolves a write target -- "score" (a numeric variable, created on first use) or
//"board[$i]" (a cell of an existing array). nullptr means the fault is already recorded.
static long* appNumericTarget(DappProgram& program, String token) {
    token.trim();
    if (token.startsWith("$")) {
        token.remove(0, 1);
    }

    String name;
    String indexToken;
    if (appParseSubscript(token, name, indexToken)) {
        return appArrayCell(program, name, appValueOf(indexToken, program));
    }

    int slot = appEnsureVar(program.vars, token);
    if (slot < 0) {
        program.fault = "too many variables";
        return nullptr;
    }
    return &program.vars[slot].value;
}

//   CANVAS -- a character grid addressed by cell, drawn over the terminal area of the panel
//   and over the telnet client's screen. Scripts that draw a frame at a time need this:
//   PRINT appends to a scrolling history, so a 20-row playfield redrawn with CLEAR+PRINT
//   both flickers and walks the telnet client's scrollback. The buffer itself lives in
//   global.h because Display.ino renders it -- see the lifetime note there.

static void appCanvasClear() {
    if (!dappCanvasCells) {
        return;
    }
    for (int i = 0; i < dappCanvasCols * dappCanvasRows; i++) {
        dappCanvasCells[i].ch = ' ';
        dappCanvasCells[i].color = C_WHITE;
    }
}

//safe to call when no canvas is up. Clears the flag *before* releasing the buffer so the
//renderer in Display.ino can never follow a dangling pointer.
static void appCanvasEnd() {
    bool wasActive = dappCanvasActive;
    dappCanvasActive = false;
    dappCanvasCols = 0;
    dappCanvasRows = 0;
    if (dappCanvasCells) {
        heap_caps_free(dappCanvasCells);
        dappCanvasCells = nullptr;
    }

    if (wasActive) {
        if (telnetClient && telnetClient.connected()) {
            telnetClient.print("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");   //cursor back, screen back
        }
        markDisplayDirty();
    }
}

static bool appCanvasBegin(int cols, int rows) {
    if (cols < 1 || rows < 1 || cols > DAPP_CANVAS_MAX_COLS || rows > DAPP_CANVAS_MAX_ROWS) {
        outLine("run: CANVAS size must be 1.." + String(DAPP_CANVAS_MAX_COLS) + " by 1.." +
                String(DAPP_CANVAS_MAX_ROWS), C_RED);
        return false;
    }

    if (dappCanvasCells && dappCanvasCols == cols && dappCanvasRows == rows) {
        //same geometry as the canvas already up -- reuse it rather than churning PSRAM
        appCanvasClear();
        return true;
    }

    appCanvasEnd();
    dappCanvasCells = (DappCanvasCell*)psramOrInternalCalloc(cols * rows, sizeof(DappCanvasCell), "dappCanvas");
    if (!dappCanvasCells) {
        outLine("run: not enough memory for that CANVAS", C_RED);
        return false;
    }

    dappCanvasCols = cols;
    dappCanvasRows = rows;
    dappCanvasActive = true;
    appCanvasClear();

    if (telnetClient && telnetClient.connected()) {
        telnetClient.print("\x1b[2J\x1b[?25l");   //clear, and park the cursor out of the way
    }
    markDisplayDirty();
    return true;
}

//writes `text` rightward from (col, row), clipped at the edges. Off-grid rows are dropped
//rather than reported: a script drawing a piece that overhangs the well is doing something
//normal, and making it check bounds first would double the size of every draw routine.
static void appCanvasPut(int col, int row, const String& text, int color) {
    if (!dappCanvasCells || row < 0 || row >= dappCanvasRows) {
        return;
    }
    for (int i = 0; i < (int)text.length(); i++) {
        int x = col + i;
        if (x < 0) {
            continue;
        }
        if (x >= dappCanvasCols) {
            break;
        }
        DappCanvasCell& cell = dappCanvasCells[row * dappCanvasCols + x];
        cell.ch = text[i];
        cell.color = (uint8_t)color;
    }
}

//pushes the grid to both surfaces. The telnet side homes the cursor and overwrites in
//place instead of clearing first -- clearing every frame is what makes a terminal game
//flicker -- and emits one SGR code per color run rather than per cell.
static void appCanvasFlip() {
    if (!dappCanvasCells) {
        return;
    }

    markDisplayDirty();
    drawDisplayFrame();

    if (!telnetClient || !telnetClient.connected()) {
        return;
    }

    String frame = "\x1b[H";
    frame.reserve((size_t)(dappCanvasCols + 8) * dappCanvasRows + 16);
    for (int row = 0; row < dappCanvasRows; row++) {
        int runColor = -1;
        for (int col = 0; col < dappCanvasCols; col++) {
            const DappCanvasCell& cell = dappCanvasCells[row * dappCanvasCols + col];
            if ((int)cell.color != runColor) {
                runColor = cell.color;
                frame += "\x1b[";
                frame += String(runColor);
                frame += "m";
            }
            frame += cell.ch;
        }
        frame += "\x1b[0m";
        if (row < dappCanvasRows - 1) {
            frame += "\r\n";   //no newline after the last row, or the terminal scrolls
        }
    }
    telnetClient.print(frame);
}

//   Files -- FOPEN/FREAD/FWRITE/FCLOSE and friends. One open handle at a time, like the
//   one canvas and the one telnet client: a script that genuinely needs two files open at
//   once has outgrown this language. Error philosophy splits by kind: a file that isn't
//   there is a fact a script can plan around, so FOPEN/FDELETE report through $fok and
//   never stop the app -- but FREAD/FWRITE against a handle in the wrong state is a
//   programming bug and stops it like any other.
static File dappFile;
static bool dappFileOpen = false;
static bool dappFileWritable = false;
static bool dappFileIsSd = false;

static void appFileClose() {
    if (dappFileOpen) {
        dappFile.close();
        dappFileOpen = false;
    }
    dappFileWritable = false;
    dappFileIsSd = false;
}

//routes the unified /sd-or-flash namespace the same way `run` and the shell do, so a
//script's paths mean what its author's shell commands mean. Missing SD reads as "can't".
static bool appFileRoute(const String& path, RoutedPath& out) {
    out = routePath(resolvePath(cwd, path));
    return !(out.isSd && !sdCardMounted);
}

static void appFileOpen(const String& path, const char* fsMode, bool writable) {
    appFileClose();
    dappFok = 0;
    dappFeof = 0;

    RoutedPath r;
    if (!appFileRoute(path, r)) {
        return;
    }

    if (writable) {
        ledPulseStorageWrite(r.isSd);
    } else {
        ledPulseStorageRead(r.isSd);
    }
    File f = r.fs->open(r.realPath, fsMode);
    if (!f || f.isDirectory()) {
        if (f) {
            f.close();
        }
        return;
    }

    dappFile = f;
    dappFileOpen = true;
    dappFileWritable = writable;
    dappFileIsSd = r.isSd;
    dappFok = 1;
}

//one line, newline consumed, CR stripped -- the same shape appLoad reads scripts with,
//but capped per-character so a newline-free multi-megabyte file can't balloon a String.
static String appFileReadLine() {
    String line = "";
    if (!dappFile.available()) {
        dappFeof = 1;
        return line;
    }
    ledPulseStorageRead(dappFileIsSd);
    while (dappFile.available()) {
        char ch = (char)dappFile.read();
        if (ch == '\n') {
            break;
        }
        if (line.length() < DAPP_MAX_STRING_LEN) {
            line += ch;
        }
    }
    if (line.endsWith("\r")) {
        line.remove(line.length() - 1);
    }
    return line;
}

//   KEY -- non-blocking key polling
//
//   INPUT blocks until Enter, which is fine for a prompt and useless for a game: gravity
//   has to keep ticking while nothing is pressed. This decodes at most one key per call
//   from either input source, leaving the rest queued. Each source keeps its own escape
//   state for the same reason LineEditState does (global.h): a half-arrived arrow key on
//   one source must not corrupt the other's parse.

//DappKeyPhase/DappKeyState are defined in global.h -- a hoisted prototype for
//appPollKeySource() below mentions the type, and lands above this file
static DappKeyState dappTelnetKeys;
static DappKeyState dappKeyboardKeys;

//a lone Escape and the start of an arrow key are the same byte, so an unresolved ESC is
//held briefly and only reported as Escape once nothing followed it. Same 40ms rule the
//Game Boy runner uses for its telnet menu key (Gameboy.ino).
const unsigned long DAPP_ESC_SETTLE_MS = 40;

//   Aborting a stuck app -- Ctrl+X, the editor's own exit chord, stops a running .dapp
//   from either input source. Necessary because the step guard deliberately never trips
//   a loop that WAITs, which makes "WAIT in a loop forever" both a legitimate program
//   shape and, when unintended, one that nothing else could stop.
//
//   The check uses peek() so nothing but the abort byte itself is ever consumed -- WAIT
//   and INPUT must not steal bytes a KEY loop or the line editor is about to read. The
//   cost of that safety: the chord only registers as the *next unread* byte. That covers
//   the case that matters (an app looping without reading its input has no other reader,
//   so ^X is at the head), and KEY apps don't rely on it at all -- appPollKeySource traps
//   the byte the moment it is read, wherever it sits in the queue.
static bool dappAbort = false;
const uint8_t DAPP_ABORT_BYTE = 0x18;   //^X

static void appPollAbortChord() {
    if (dappAbort) {
        return;
    }
    if (telnetClient && telnetClient.connected() && telnetClient.peek() == DAPP_ABORT_BYTE) {
        telnetReadFilteredByte();
        dappAbort = true;
        return;
    }
    if (keyboardPeekRawByte() == DAPP_ABORT_BYTE) {
        keyboardReadRawByte();
        dappAbort = true;
    }
}

static long appDecodeKeyByte(uint8_t b, DappKeyState& st) {
    if (st.phase == DKEY_ESC) {
        if (b == '[') {
            st.phase = DKEY_CSI;
            st.params = "";
            return DAPP_KEY_NONE;
        }
        st.phase = DKEY_NORMAL;
        return DAPP_KEY_ESC;
    }

    if (st.phase == DKEY_CSI) {
        if (b < 0x40 || b > 0x7E) {
            st.params += (char)b;
            return DAPP_KEY_NONE;
        }
        st.phase = DKEY_NORMAL;
        switch ((char)b) {
            case 'A': return DAPP_KEY_UP;
            case 'B': return DAPP_KEY_DOWN;
            case 'C': return DAPP_KEY_RIGHT;
            case 'D': return DAPP_KEY_LEFT;
            default:  return DAPP_KEY_NONE;   //function keys and the rest: not in the vocabulary
        }
    }

    if (b == 0x1B) {
        st.phase = DKEY_ESC;
        st.escAtMs = millis();
        return DAPP_KEY_NONE;
    }
    if (b == '\r' || b == '\n') return DAPP_KEY_ENTER;
    if (b == 0x08 || b == 0x7F) return DAPP_KEY_BACK;
    if (b == '\t') return DAPP_KEY_TAB;
    //Ctrl+C and Ctrl+T are how every other modal screen in DOLL-OS is escaped, so a script that
    //quits on $kesc quits on the chords its user already knows too
    if (b == 0x03 || b == 0x14) return DAPP_KEY_ESC;
    if (b >= 32 && b < 127) return (long)b;
    return DAPP_KEY_NONE;
}

static long appPollKeySource(int (*readByte)(), DappKeyState& st) {
    if (st.phase == DKEY_ESC && millis() - st.escAtMs > DAPP_ESC_SETTLE_MS) {
        st.phase = DKEY_NORMAL;
        return DAPP_KEY_ESC;
    }

    int b;
    while ((b = readByte()) >= 0) {
        //^X aborts the app rather than reaching the script -- KEY never returns it
        if (st.phase == DKEY_NORMAL && (uint8_t)b == DAPP_ABORT_BYTE) {
            dappAbort = true;
            return DAPP_KEY_NONE;
        }
        long key = appDecodeKeyByte((uint8_t)b, st);
        if (key != DAPP_KEY_NONE) {
            return key;
        }
    }
    return DAPP_KEY_NONE;
}

static long appPollKey() {
    long key = appPollKeySource(telnetReadFilteredByte, dappTelnetKeys);
    if (key != DAPP_KEY_NONE) {
        return key;
    }
    return appPollKeySource(keyboardReadRawByte, dappKeyboardKeys);
}

static void appResetKeyState() {
    dappTelnetKeys = DappKeyState();
    dappKeyboardKeys = DappKeyState();
    dappAbort = false;
}

static void appDelay(unsigned long waitMs) {
    unsigned long started = millis();
    while (millis() - started < waitMs) {
        appPollAbortChord();
        if (dappAbort) {
            return;   //appExecute notices the flag right after this op
        }
        ftpService();
        radioService();
        maintainInternetConnection();
        ledService();
        drawDisplayFrame();
        delay(1);
    }
}

static String appReadInput(const String& prompt) {
    String input = "";
    commandCursorPos = 0;

    if (telnetClient && telnetClient.connected()) {
        telnetClient.print(prompt);
    }

    while (true) {
        //checked before the line editor gets the byte, so ^X interrupts even a
        //blocked prompt instead of being swallowed as an editing keystroke
        appPollAbortChord();
        if (dappAbort) {
            commandCursorPos = 0;
            return "";
        }
        LineInputResult r = readLineEditedInput(input);
        if (r == LINE_NO_INPUT) {
            r = readKeyboardLineEditedInput(input);
        }
        setActiveInput(prompt, input, false);
        ftpService();
        radioService();
        maintainInternetConnection();
        ledService();
        drawDisplayFrame();

        if (r == LINE_SUBMITTED) {
            String submitted = input;
            submitted.trim();
            commandCursorPos = 0;
            outLine(prompt + submitted, C_CYAN);
            return submitted;
        }

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

static long appRandomRange(long low, long high) {
    if (high < low) {
        long tmp = low;
        low = high;
        high = tmp;
    }

    uint32_t span = (uint32_t)(high - low + 1);
    if (span == 0) {
        return low;
    }
    return low + (long)(esp_random() % span);
}

static bool appLoad(File& file, DappProgram& program) {
    DappLine* lines = program.lines;
    DappLabel* labels = program.labels;
    int& lineCount = program.lineCount;
    int& labelCount = program.labelCount;
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

static bool appExecute(DappProgram& program) {
    DappLine* lines = program.lines;
    DappLabel* labels = program.labels;
    DappStringVar* stringVars = program.stringVars;
    const int lineCount = program.lineCount;
    const int labelCount = program.labelCount;
    int pc = 0;
    long steps = 0;
    int color = C_WHITE;

    while (pc >= 0 && pc < lineCount) {
        if (dappAbort) {
            outLine("run: aborted (^X)", C_YELLOW);
            return false;
        }
        if (++steps > DAPP_MAX_STEPS) {
            outLine("run: stopped after " + String(DAPP_MAX_STEPS) + " steps without a WAIT (possible loop)", C_RED);
            return false;
        }
        if (steps % DAPP_STEPS_PER_YIELD == 0) {
            delay(0);   //hand the scheduler a slot so a long loop can't starve the watchdog
        }

        String line = trimCopy(lines[pc].text);
        pc++;
        const int lineNumber = pc;   //1-based, captured before any jump moves pc
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
            outLine(appExpandText(arg, program), color);
        } else if (op == "COLOR") {
            color = appColorByName(arg);
        } else if (op == "LED") {
            String parts[3];
            int count = splitCommand(arg, parts, 3);
            if (count < 3) {
                outLine("run: LED needs <red> <green> <blue>", C_RED);
                return false;
            }
            if (!rearLedAvailable()) {
                outLine("run: LED unavailable on this build (set REAR_RGB_LED_PIN)", C_RED);
                return false;
            }
            ledSetAppOverrideRgbLong(appValueOf(parts[0], program),
                                     appValueOf(parts[1], program),
                                     appValueOf(parts[2], program));
        } else if (op == "CLEAR" || op == "CLS") {
            //while a canvas is up this means "blank the grid", not "wipe the scrollback the
            //canvas is drawn over" -- the latter would be visible only after ENDCANVAS
            if (dappCanvasActive) {
                appCanvasClear();
            } else {
                outClearScreen();
            }
        } else if (op == "WAIT" || op == "SLEEP") {
            unsigned long waitMs = (unsigned long)appValueOf(arg, program);
            appDelay(waitMs);
            if (waitMs > 0) {
                steps = 0;   //a paced loop isn't a runaway one -- see DAPP_MAX_STEPS
            }
        } else if (op == "SET" || op == "ADD" || op == "SUB" || op == "MUL" || op == "DIV" || op == "MOD") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: " + op + " needs <name> <value>", C_RED);
                return false;
            }
            long value = appValueOf(parts[1], program);
            if ((op == "DIV" || op == "MOD") && value == 0) {
                outLine("run: " + op + " by zero", C_RED);
                return false;
            }
            long* target = appNumericTarget(program, parts[0]);
            if (!target) {
                continue;   //fault recorded; the check at the bottom of the loop reports it
            }
            if (op == "SET") *target = value;
            else if (op == "ADD") *target += value;
            else if (op == "SUB") *target -= value;
            else if (op == "MUL") *target *= value;
            else if (op == "DIV") *target /= value;
            else *target %= value;
        } else if (op == "EXPR") {
            //not split with splitCommand: the expression is the whole rest of the line,
            //spaces and all (tinyexpr skips whitespace itself), so it is taken verbatim
            int split = arg.indexOf(' ');
            if (split < 0) {
                outLine("run: EXPR needs <name> <expression>", C_RED);
                return false;
            }
            String targetToken = arg.substring(0, split);
            String expression = appExpandNumericText(trimCopy(arg.substring(split + 1)), program);
            if (program.fault.length() > 0) {
                continue;
            }

            int err = 0;
            double result = te_interp(expression.c_str(), &err);
            if (err != 0) {
                outLine("run: EXPR cannot evaluate: " + expression, C_RED);
                return false;
            }
            long* target = appNumericTarget(program, targetToken);
            if (!target) {
                continue;
            }
            *target = (long)(result >= 0 ? result + 0.5 : result - 0.5);
        } else if (op == "DIM") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: DIM needs <name> <size>", C_RED);
                return false;
            }
            if (!appDimArray(program, parts[0], appValueOf(parts[1], program))) {
                return false;
            }
        } else if (op == "SETSTR") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: SETSTR needs <name> <text>", C_RED);
                return false;
            }
            int slot = appEnsureStringVar(stringVars, parts[0]);
            if (slot < 0) {
                outLine("run: too many string variables", C_RED);
                return false;
            }
            appSetStringValue(stringVars, slot, appExpandText(parts[1], program));
        } else if (op == "APPEND") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: APPEND needs <name> <text>", C_RED);
                return false;
            }
            int slot = appEnsureStringVar(stringVars, parts[0]);
            if (slot < 0) {
                outLine("run: too many string variables", C_RED);
                return false;
            }
            appSetStringValue(stringVars, slot, stringVars[slot].value + appExpandText(parts[1], program));
        } else if (op == "CHR") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: CHR needs <name> <code>", C_RED);
                return false;
            }
            int slot = appEnsureStringVar(stringVars, parts[0]);
            if (slot < 0) {
                outLine("run: too many string variables", C_RED);
                return false;
            }
            long code = appValueOf(parts[1], program);
            appSetStringValue(stringVars, slot, (code >= 32 && code < 127) ? String((char)code) : String(" "));
        } else if (op == "SUBSTR") {
            String parts[4];
            int count = splitCommand(arg, parts, 4);
            if (count < 4) {
                outLine("run: SUBSTR needs <name> <text> <start> <count>", C_RED);
                return false;
            }
            int slot = appEnsureStringVar(stringVars, parts[0]);
            if (slot < 0) {
                outLine("run: too many string variables", C_RED);
                return false;
            }
            String source = appStringOperand(parts[1], program);
            long start = appValueOf(parts[2], program);
            long want = appValueOf(parts[3], program);
            if (start < 0) start = 0;
            if (start > (long)source.length()) start = source.length();
            if (want < 0) want = 0;
            long end = start + want;
            if (end > (long)source.length()) end = source.length();
            appSetStringValue(stringVars, slot, source.substring(start, end));
        } else if (op == "LEN" || op == "CHARAT") {
            String parts[3];
            int count = splitCommand(arg, parts, 3);
            int needed = (op == "LEN") ? 2 : 3;
            if (count < needed) {
                outLine("run: " + op + (op == "LEN" ? " needs <name> <text>" : " needs <name> <text> <index>"), C_RED);
                return false;
            }
            String source = appStringOperand(parts[1], program);
            long value = 0;
            if (op == "LEN") {
                value = source.length();
            } else {
                long index = appValueOf(parts[2], program);
                value = (index >= 0 && index < (long)source.length()) ? (long)(uint8_t)source[index] : 0;
            }
            long* target = appNumericTarget(program, parts[0]);
            if (!target) {
                continue;
            }
            *target = value;
        } else if (op == "INPUT") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 1) {
                outLine("run: INPUT needs <name> [prompt]", C_RED);
                return false;
            }
            int slot = appEnsureStringVar(stringVars, parts[0]);
            if (slot < 0) {
                outLine("run: too many string variables", C_RED);
                return false;
            }
            String prompt = count >= 2 ? appExpandText(parts[1], program) : parts[0] + "> ";
            appSetStringValue(stringVars, slot, appReadInput(prompt));
            steps = 0;   //waiting on a human is not a runaway loop
        } else if (op == "KEY") {
            if (arg.length() == 0) {
                outLine("run: KEY needs <name>", C_RED);
                return false;
            }
            long key = appPollKey();
            long* target = appNumericTarget(program, arg);
            if (!target) {
                continue;
            }
            *target = key;
        } else if (op == "CANVAS") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: CANVAS needs <cols> <rows>", C_RED);
                return false;
            }
            if (!appCanvasBegin((int)appValueOf(parts[0], program), (int)appValueOf(parts[1], program))) {
                return false;
            }
        } else if (op == "ENDCANVAS") {
            appCanvasEnd();
        } else if (op == "PUT") {
            String parts[3];
            int count = splitCommand(arg, parts, 3);
            if (count < 3) {
                outLine("run: PUT needs <col> <row> <text>", C_RED);
                return false;
            }
            if (!dappCanvasActive) {
                outLine("run: PUT needs a CANVAS first", C_RED);
                return false;
            }
            appCanvasPut((int)appValueOf(parts[0], program),
                         (int)appValueOf(parts[1], program),
                         appExpandText(parts[2], program),
                         color);
        } else if (op == "FLIP") {
            if (!dappCanvasActive) {
                outLine("run: FLIP needs a CANVAS first", C_RED);
                return false;
            }
            appCanvasFlip();
        } else if (op == "FOPEN") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: FOPEN needs <path> read|write|append", C_RED);
                return false;
            }
            String mode = parts[1];
            mode.toLowerCase();
            const char* fsMode;
            bool writable;
            if (mode == "read" || mode == "r") { fsMode = "r"; writable = false; }
            else if (mode == "write" || mode == "w") { fsMode = "w"; writable = true; }
            else if (mode == "append" || mode == "a") { fsMode = "a"; writable = true; }
            else {
                outLine("run: FOPEN mode must be read, write, or append", C_RED);
                return false;
            }
            appFileOpen(appExpandText(parts[0], program), fsMode, writable);
        } else if (op == "FCLOSE") {
            appFileClose();
        } else if (op == "FREAD") {
            if (arg.length() == 0) {
                outLine("run: FREAD needs <name>", C_RED);
                return false;
            }
            if (!dappFileOpen || dappFileWritable) {
                outLine("run: FREAD needs a file FOPENed for read", C_RED);
                return false;
            }
            int slot = appEnsureStringVar(stringVars, arg);
            if (slot < 0) {
                outLine("run: too many string variables", C_RED);
                return false;
            }
            appSetStringValue(stringVars, slot, appFileReadLine());
        } else if (op == "FWRITE") {
            if (!dappFileOpen || !dappFileWritable) {
                outLine("run: FWRITE needs a file FOPENed for write or append", C_RED);
                return false;
            }
            String text = appExpandText(arg, program);
            ledPulseStorageWrite(dappFileIsSd);
            size_t wrote = dappFile.print(text);
            wrote += dappFile.print("\n");
            if (wrote != text.length() + 1) {
                outLine("run: FWRITE failed (filesystem full?)", C_RED);
                return false;
            }
        } else if (op == "FEXISTS") {
            String parts[2];
            int count = splitCommand(arg, parts, 2);
            if (count < 2) {
                outLine("run: FEXISTS needs <name> <path>", C_RED);
                return false;
            }
            RoutedPath r;
            long exists = 0;
            if (appFileRoute(appExpandText(parts[1], program), r)) {
                ledPulseStorageRead(r.isSd);
                if (r.fs->exists(r.realPath)) {
                    exists = 1;
                }
            }
            long* target = appNumericTarget(program, parts[0]);
            if (!target) {
                continue;
            }
            *target = exists;
        } else if (op == "FDELETE") {
            if (arg.length() == 0) {
                outLine("run: FDELETE needs <path>", C_RED);
                return false;
            }
            RoutedPath r;
            dappFok = 0;
            if (appFileRoute(appExpandText(arg, program), r)) {
                ledPulseStorageWrite(r.isSd);
                if (r.fs->remove(r.realPath)) {
                    dappFok = 1;
                }
            }
        } else if (op == "RAND") {
            String parts[3];
            int count = splitCommand(arg, parts, 3);
            if (count < 2) {
                outLine("run: RAND needs <name> <max> or <name> <min> <max>", C_RED);
                return false;
            }

            long value = 0;
            if (count == 2) {
                long maxExclusive = appValueOf(parts[1], program);
                if (maxExclusive <= 0) {
                    outLine("run: RAND max must be greater than 0", C_RED);
                    return false;
                }
                value = appRandomRange(0, maxExclusive - 1);
            } else {
                value = appRandomRange(appValueOf(parts[1], program), appValueOf(parts[2], program));
            }

            long* target = appNumericTarget(program, parts[0]);
            if (!target) {
                continue;
            }
            *target = value;
        } else if (op == "GOTO") {
            int target = appFindLabel(labels, labelCount, arg);
            if (target < 0) {
                outLine("run: label not found: " + arg, C_RED);
                return false;
            }
            pc = target;
        } else if (op == "GOSUB") {
            int target = appFindLabel(labels, labelCount, arg);
            if (target < 0) {
                outLine("run: label not found: " + arg, C_RED);
                return false;
            }
            if (program.callDepth >= DAPP_MAX_CALL_DEPTH) {
                outLine("run: GOSUB nested deeper than " + String(DAPP_MAX_CALL_DEPTH) +
                        " (a RETURN is probably missing)", C_RED);
                return false;
            }
            //pc has already advanced past the GOSUB, so this is where RETURN resumes
            program.callStack[program.callDepth++] = pc;
            pc = target;
        } else if (op == "RETURN") {
            if (program.callDepth <= 0) {
                outLine("run: RETURN without GOSUB", C_RED);
                return false;
            }
            pc = program.callStack[--program.callDepth];
        } else if (op == "IF") {
            String parts[5];
            int count = splitCommand(arg, parts, 5);
            String jumpOp = (count >= 4) ? parts[3] : "";
            jumpOp.toUpperCase();
            if (count < 5 || (jumpOp != "GOTO" && jumpOp != "GOSUB")) {
                outLine("run: IF syntax is IF <left> <op> <right> GOTO|GOSUB <label>", C_RED);
                return false;
            }
            if (appCompare(appValueOf(parts[0], program), parts[1], appValueOf(parts[2], program))) {
                int target = appFindLabel(labels, labelCount, parts[4]);
                if (target < 0) {
                    outLine("run: label not found: " + parts[4], C_RED);
                    return false;
                }
                if (jumpOp == "GOSUB") {
                    if (program.callDepth >= DAPP_MAX_CALL_DEPTH) {
                        outLine("run: GOSUB nested deeper than " + String(DAPP_MAX_CALL_DEPTH), C_RED);
                        return false;
                    }
                    program.callStack[program.callDepth++] = pc;
                }
                pc = target;
            }
        } else if (op == "IFEQ" || op == "IFNE") {
            String parts[4];
            int count = splitCommand(arg, parts, 4);
            String jumpOp = (count >= 3) ? parts[2] : "";
            jumpOp.toUpperCase();
            if (count < 4 || (jumpOp != "GOTO" && jumpOp != "GOSUB")) {
                outLine("run: " + op + " syntax is " + op + " <left> <right> GOTO|GOSUB <label>", C_RED);
                return false;
            }
            bool equal = appStringOperand(parts[0], program) == appStringOperand(parts[1], program);
            if ((op == "IFEQ" && equal) || (op == "IFNE" && !equal)) {
                int target = appFindLabel(labels, labelCount, parts[3]);
                if (target < 0) {
                    outLine("run: label not found: " + parts[3], C_RED);
                    return false;
                }
                if (jumpOp == "GOSUB") {
                    if (program.callDepth >= DAPP_MAX_CALL_DEPTH) {
                        outLine("run: GOSUB nested deeper than " + String(DAPP_MAX_CALL_DEPTH), C_RED);
                        return false;
                    }
                    program.callStack[program.callDepth++] = pc;
                }
                pc = target;
            }
        } else if (op == "EXIT" || op == "END") {
            return true;
        } else {
            outLine("run: unknown app command: " + op, C_RED);
            return false;
        }

        //single check for every helper that can only report failure out of band -- an
        //out-of-range array index, or running out of variable slots mid-expression
        if (program.fault.length() > 0) {
            outLine("run: " + program.fault + " (line " + String(lineNumber) + ")", C_RED);
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

    DappProgram program;
    if (!program.alloc()) {
        file.close();
        outLine("run: not enough memory to load the app", C_RED);
        return;
    }

    outLine("Running " + resolved, C_GREEN);
    ledPulseStorageRead(resolved.startsWith("/sd/"));
    bool loaded = appLoad(file, program);
    file.close();
    if (!loaded) {
        ledClearAppOverride();
        return;
    }

    //stale bytes from before the app started would arrive as its first keypresses
    appResetKeyState();
    dappFok = 0;
    dappFeof = 0;

    bool ok = appExecute(program);

    //unconditional: an app that faulted mid-frame still has to hand the terminal back,
    //and one that stopped mid-read must not leave a dangling handle
    appCanvasEnd();
    appFileClose();
    ledClearAppOverride();
    outLine(ok ? "[app exited]" : "[app stopped]", ok ? C_GREEN : C_RED);
}
