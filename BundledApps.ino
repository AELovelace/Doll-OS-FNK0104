//   BundledApps.ino
//   Seeds selected built-in files from firmware into LittleFS so a normal sketch
//   upload can refresh built-in apps/docs without a separate filesystem upload step.
#include <LittleFS.h>
#include <FS.h>
#include <string.h>
#include "BundledApps.h"

struct BundledAsset {
    const char* path;
    const char* contents;
};

static void ensureBundledDirectory(const char* path) {
    File dir = LittleFS.open(path);
    if (!dir || !dir.isDirectory()) {
        if (dir) {
            dir.close();
        }
        LittleFS.mkdir(path);
    } else {
        dir.close();
    }
}

static bool bundledAssetMatches(const char* path, const char* contents) {
    File file = LittleFS.open(path, "r");
    if (!file || file.isDirectory()) {
        if (file) {
            file.close();
        }
        return false;
    }

    size_t expectedLen = strlen(contents);
    if ((size_t)file.size() != expectedLen) {
        file.close();
        return false;
    }

    char chunk[128];
    size_t offset = 0;
    while (offset < expectedLen) {
        size_t want = expectedLen - offset;
        if (want > sizeof(chunk)) {
            want = sizeof(chunk);
        }

        size_t got = file.readBytes(chunk, want);
        if (got != want || memcmp(chunk, contents + offset, want) != 0) {
            file.close();
            return false;
        }
        offset += want;
    }

    file.close();
    return true;
}

static bool writeBundledAsset(const char* path, const char* contents) {
    File file = LittleFS.open(path, "w");
    if (!file) {
        return false;
    }

    size_t len = strlen(contents);
    size_t written = file.write((const uint8_t*)contents, len);
    file.close();
    return written == len;
}

void seedBundledApps() {
    ensureBundledDirectory("/apps");
    ensureBundledDirectory("/docs");

    const BundledAsset bundledApps[] = {
        { "/apps/adventure.dapp", BUNDLED_APP_ADVENTURE },
        { "/apps/tetris.dapp", BUNDLED_APP_TETRIS },
        { "/docs/dapp.txt", BUNDLED_DOC_DAPP },
    };

    for (const BundledAsset& app : bundledApps) {
        if (bundledAssetMatches(app.path, app.contents)) {
            continue;
        }

        if (writeBundledAsset(app.path, app.contents)) {
            outLine("bundle: synced " + String(app.path) + " to flash", C_GREEN);
        } else {
            outLine("bundle: failed to sync " + String(app.path) + " to flash", C_RED);
        }
    }
}
