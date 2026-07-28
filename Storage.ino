//   Storage.ino
//   mounts internal (LittleFS) and SD storage, and provides the filesystem
//   commands. Ported from DOLL-OS's storage.ino -- the path-resolution/routing
//   logic is display-agnostic and carries over unchanged. What changed is the SD
//   transport: DOLL-OS's M5Cardputer wires its SD card over SPI, but this board's
//   SD slot is wired to the ESP32-S3's dedicated SDMMC peripheral (4-bit bus), so
//   this uses the SD_MMC library instead of SD/SPI. Pins come from config.h,
//   confirmed against Freenove's own example sketches for this board family.
#include <LittleFS.h>
#include <FS.h>
#include <SD_MMC.h>
#include <esp_task_wdt.h>
#include <esp_idf_version.h>

//widens (or restores) the task watchdog timeout. Used instead of disableCore0WDT()/
//enableCore0WDT() around SD_MMC.begin() below -- those legacy per-core shims don't
//correctly re-subscribe the idle tasks on this IDF5-based core, which left the
//watchdog itself in a broken state and caused a *delayed* panic ~20s later instead of
//preventing one. Reconfiguring the timeout doesn't touch task subscriptions at all.
static void setTaskWdtTimeout(uint32_t timeoutMs) {
#if ESP_IDF_VERSION_MAJOR >= 5
    esp_task_wdt_config_t wdtConfig = {
        .timeout_ms = timeoutMs,
        .idle_core_mask = 0x3,   //both cores' idle tasks
        .trigger_panic = true,
    };
    esp_task_wdt_reconfigure(&wdtConfig);
#else
    esp_task_wdt_init(timeoutMs / 1000, true);
#endif
}

//mounts LittleFS (formatting it on first boot if needed) and the SD card, called once from setup()
void initStorage() {
    //begin(true) asks esp_littlefs to auto-format when the mount fails, which covers a
    //blank first-boot partition. But a partition left half-written -- the "Corrupted
    //dir pair at {0x0, 0x1}" state -- isn't reliably recovered by that path, and DS
    //then boots with settings storage dead (no saved wifi.cfg -> falls back to the
    //config.h default SSID and can never reconnect). So on failure, force an explicit
    //format + clean remount; settings reset to defaults but storage lives again.
    if (!LittleFS.begin(true)) {
        Serial.println("LittleFS: mount failed; forcing format...");
        if (LittleFS.format() && LittleFS.begin(false)) {
            outLine("LittleFS: was corrupt -- reformatted (settings reset)", C_YELLOW);
        } else {
            outLine("LittleFS: mount failed -- settings won't persist", C_RED);
        }
    }

    //with no card inserted, the SD_MMC driver's internal retry loop (sdmmc_init_ocr) can run
    //long enough without yielding that the default ~5s watchdog timeout trips mid-retry --
    //widen it just for this call so a missing card fails cleanly instead of resetting
    SD_MMC.setPins(SD_MMC_CLK_PIN, SD_MMC_CMD_PIN, SD_MMC_D0_PIN, SD_MMC_D1_PIN, SD_MMC_D2_PIN, SD_MMC_D3_PIN);
    setTaskWdtTimeout(20000);
    sdCardMounted = SD_MMC.begin("/sdcard", false, false);
    setTaskWdtTimeout(5000);
    if (!sdCardMounted) {
        Serial.println("SD: not detected");
    }
}

//lists one directory of a mounted filesystem into the terminal.
//showSdMount adds a synthetic "sd" entry, used when listing flash root so the mount point is discoverable
void listDirectory(fs::FS& fs, const String& path, bool showSdMount) {
    File dir = fs.open(path);
    if (!dir || !dir.isDirectory()) {
        outLine("ls: " + path + " not found", C_RED);
        return;
    }

    File entry = dir.openNextFile();
    int entryCount = 0;
    while (entry) {
        String line = entry.isDirectory() ? "  [DIR]  " : ("  " + String(entry.size()) + "b  ");
        line += entry.name();
        outLine(line);
        entryCount++;
        entry.close();
        entry = dir.openNextFile();
    }
    dir.close();

    if (showSdMount) {
        outLine("  [DIR]  sd");
        entryCount++;
    }

    if (entryCount == 0) {
        outLine("(empty)");
    }
}

//routes an absolute path in the unified namespace to the physical filesystem that owns it.
//paths at or under SD_MOUNT map onto the SD card with the mount prefix stripped; everything else is LittleFS
RoutedPath routePath(const String& resolvedPath) {
    bool onSd = (resolvedPath == SD_MOUNT) || resolvedPath.startsWith(SD_MOUNT + "/");
    if (onSd) {
        String realPath = resolvedPath.substring(SD_MOUNT.length());
        if (realPath.length() == 0) realPath = "/";
        return { &SD_MMC, realPath, true };
    }
    return { &LittleFS, resolvedPath, false };
}

//collapses "inputPath" (relative or absolute) against cwd into a clean absolute path in the
//unified namespace, resolving "." and ".." segments
String resolvePath(const String& cwd, const String& inputPath) {
    String combined = (inputPath.length() > 0 && inputPath[0] == '/')
        ? inputPath
        : cwd + "/" + inputPath;

    String stack[16];
    int depth = 0;

    int start = 0;
    while (start < combined.length()) {
        while (start < combined.length() && combined[start] == '/') start++;
        int end = combined.indexOf('/', start);
        if (end == -1) end = combined.length();
        String segment = combined.substring(start, end);

        if (segment.length() == 0 || segment == ".") {
            //skip
        } else if (segment == "..") {
            if (depth > 0) depth--;
        } else if (depth < 16) {
            stack[depth++] = segment;
        }
        start = end;
    }

    String result = "/";
    for (int i = 0; i < depth; i++) {
        result += stack[i];
        if (i < depth - 1) result += "/";
    }
    return result;
}

//true if resolvedPath is a real, openable directory once routed to its physical filesystem
bool directoryExists(const String& resolvedPath) {
    RoutedPath r = routePath(resolvedPath);
    if (r.isSd && !sdCardMounted) {
        return false;
    }
    File dir = r.fs->open(r.realPath);
    bool ok = dir && dir.isDirectory();
    if (dir) dir.close();
    return ok;
}

void handleLsCommand(const String parts[], int partCount) {
    String target = (partCount > 1) ? parts[1] : "";
    String resolved = resolvePath(cwd, target);

    RoutedPath r = routePath(resolved);
    if (r.isSd && !sdCardMounted) {
        outLine("SD not mounted (insert card and reboot)", C_RED);
        return;
    }

    outLine(resolved);
    listDirectory(*r.fs, r.realPath, !r.isSd && resolved == "/" && sdCardMounted);
}

void handleCdCommand(const String parts[], int partCount) {
    String target = (partCount > 1) ? parts[1] : "/";
    String resolved = resolvePath(cwd, target);

    if (!directoryExists(resolved)) {
        outLine("cd: " + resolved + " not found", C_RED);
        return;
    }
    cwd = resolved;
}

void handlePwdCommand(const String parts[], int partCount) {
    outLine(cwd);
}

void handleCatCommand(const String parts[], int partCount) {
    if (partCount < 2) {
        outLine("Usage: cat <file>");
        return;
    }

    String target = parts[1];
    String resolved = resolvePath(cwd, target);
    RoutedPath r = routePath(resolved);

    if (r.isSd && !sdCardMounted) {
        outLine("SD not mounted (insert card and reboot)", C_RED);
        return;
    }

    File file = r.fs->open(r.realPath, "r");
    if (!file) {
        outLine("cat: " + resolved + " not found", C_RED);
        return;
    }

    if (file.isDirectory()) {
        outLine("cat: " + resolved + " is a directory", C_RED);
        file.close();
        return;
    }

    if (file.size() == 0) {
        outLine("(empty)");
        file.close();
        return;
    }

    while (file.available()) {
        String line = file.readStringUntil('\n');
        if (line.endsWith("\r")) {
            line.remove(line.length() - 1);
        }
        outLine(line);
    }

    file.close();
}
