//   Gameboy.ino
//   "gb" app -- runs the vendored gnuboy Game Boy / Game Boy Color core
//   (src/emulator/gnuboy, GPLv2, ported from github.com/dkyazzentwatwa/cube-boy)
//   as a full-screen takeover on this board's TFT panel, driven by the BLE
//   keyboard through DS-Slave's gamepad mode.
//
//   This is the one place in DS that does NOT follow the telnet-mirror model:
//   an emulator is a real-time framebuffer + low-latency input, so `gb <rom>`
//   seizes loop() (it runs its own inner loop until the player quits), draws
//   the 160x144 GB frame straight to `tft` instead of through the mirrored
//   history sprite, and reads raw button events off the keyboard link instead
//   of the line editor. On exit it hands control cleanly back to the shell.
//
//   Input: DS tells DS-Slave to enter gamepad mode ("GAME 1"). In that mode the
//   slave stops sending ASCII and instead sends 2-byte button events:
//       0xF0 <bit>   button DOWN (bit = a GB_PAD_* bit, 0x01..0x80)
//       0xF1 <bit>   button UP
//       0xF2         QUIT (Esc on the keyboard) -- leave the emulator
//   We hold a live button bitmap, so holding a key = held button (the whole
//   reason gamepad mode exists; the normal keystroke path is edge-only and
//   can't express "still held"). See ../DS-Slave/DS-Slave.ino.
//
//   Audio is muted in this build (see src/AudioOut.*): gnuboy runs silent.

#include "src/GameBoyHost.h"
#include "esp_heap_caps.h"

// The panel draw path targets the plain TFT_eSPI `tft` object (global.h), which
// only exists on the SPI panel variants. The QSPI ST77922 variant uses a
// different object and pushes whole frames differently -- unsupported here for
// now, so compile the app out to a stub on that variant.
#ifndef FNK0104N_3P5_320x480_ST77922

static GameBoyHost gbHost;

// Output rectangle on the panel. "fit" scales 160x144 up to the tallest box
// that fits DISPLAY_HEIGHT while keeping aspect (letterboxed left/right); "1x"
// is native 160x144 centered (much smaller, but the cheapest to push -- use it
// if the scaled frame rate feels low). Chosen per-launch: `gb <rom> [1x|fit]`.
static const int GB_W = GameBoyHost::kWidth;    // 160
static const int GB_H = GameBoyHost::kHeight;   // 144

static uint16_t* gbScaleBuf = nullptr;   // outW*outH RGB565, in PSRAM
static int16_t* gbColMap = nullptr;      // outW source-column lookup
static int16_t* gbRowMap = nullptr;      // outH source-row lookup
static int gbOutW = 0, gbOutH = 0, gbOutX = 0, gbOutY = 0;
static bool gbFitMode = true;

static void gbFreeScale() {
    if (gbScaleBuf) { heap_caps_free(gbScaleBuf); gbScaleBuf = nullptr; }
    if (gbColMap)   { heap_caps_free(gbColMap);   gbColMap = nullptr; }
    if (gbRowMap)   { heap_caps_free(gbRowMap);   gbRowMap = nullptr; }
}

// Builds (or rebuilds) the scale buffers for the current mode. Returns false if
// PSRAM for the scaled frame couldn't be had -- caller falls back to 1x, which
// needs no scale buffer at all.
static bool gbSetupScale() {
    if (gbFitMode) {
        gbOutH = DISPLAY_HEIGHT;                 // fill the height
        gbOutW = (GB_W * DISPLAY_HEIGHT) / GB_H; // keep aspect (~266 on 320x240)
        if (gbOutW > DISPLAY_WIDTH) {            // never wider than the panel
            gbOutW = DISPLAY_WIDTH;
            gbOutH = (GB_H * DISPLAY_WIDTH) / GB_W;
        }
    } else {
        gbOutW = GB_W;
        gbOutH = GB_H;
    }
    gbOutX = (DISPLAY_WIDTH - gbOutW) / 2;
    gbOutY = (DISPLAY_HEIGHT - gbOutH) / 2;

    if (!gbFitMode) return true;   // 1x blits straight from the GB frame

    gbColMap = (int16_t*)heap_caps_malloc(gbOutW * sizeof(int16_t), MALLOC_CAP_8BIT);
    gbRowMap = (int16_t*)heap_caps_malloc(gbOutH * sizeof(int16_t), MALLOC_CAP_8BIT);
    gbScaleBuf = (uint16_t*)heap_caps_malloc((size_t)gbOutW * gbOutH * sizeof(uint16_t),
                                             MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!gbColMap || !gbRowMap || !gbScaleBuf) {
        gbFreeScale();
        return false;
    }
    for (int x = 0; x < gbOutW; x++) gbColMap[x] = (x * GB_W) / gbOutW;
    for (int y = 0; y < gbOutH; y++) gbRowMap[y] = (y * GB_H) / gbOutH;
    return true;
}

// Pushes one emulator frame to the panel. gnuboy renders GB_PIXEL_565_LE (native
// little-endian uint16); the panel wants big-endian, so setSwapBytes(true) makes
// pushImage swap as it streams.
static void gbBlitFrame() {
    const uint16_t* frame = gbHost.frame();
    if (!frame) return;
    tft.setSwapBytes(true);
    if (!gbFitMode) {
        tft.pushImage(gbOutX, gbOutY, GB_W, GB_H, (uint16_t*)frame);
        return;
    }
    for (int oy = 0; oy < gbOutH; oy++) {
        const uint16_t* srcRow = frame + (int)gbRowMap[oy] * GB_W;
        uint16_t* dst = gbScaleBuf + (size_t)oy * gbOutW;
        for (int ox = 0; ox < gbOutW; ox++) dst[ox] = srcRow[gbColMap[ox]];
    }
    tft.pushImage(gbOutX, gbOutY, gbOutW, gbOutH, gbScaleBuf);
}

// Drains every button event waiting on the keyboard link and folds it into the
// live bitmap. Returns true if the player asked to quit. Reused DS plumbing:
// keyboardReadRawByte() (KeyboardSerial.ino) hands back one raw slave byte or -1.
static bool gbPumpInput(uint8_t& buttons) {
    static uint8_t phase = 0;   // 0 = idle, 1 = expect DOWN bit, 2 = expect UP bit
    int b;
    while ((b = keyboardReadRawByte()) >= 0) {
        uint8_t by = (uint8_t)b;
        if (phase == 1) { buttons |= by; phase = 0; continue; }
        if (phase == 2) { buttons &= ~by; phase = 0; continue; }
        if (by == 0xF0) { phase = 1; }
        else if (by == 0xF1) { phase = 2; }
        else if (by == 0xF2) { return true; }              // Esc in gamepad mode
        else if (by == 0x1B || by == 'q' || by == 'Q') {   // fallback: raw Esc/q
            return true;                                    // (slave not in game mode)
        }
        // any other stray ASCII byte is ignored while a game runs
    }
    return false;
}

// Turns a DS logical path (absolute or relative to cwd) into a stdio/VFS path
// gnuboy's fopen can open. SD is mounted at "/sdcard" (Storage.ino), LittleFS at
// "/littlefs". Returns "" if the path routes to SD but no card is mounted.
static String gbVfsPath(const String& arg) {
    String resolved = resolvePath(cwd, arg);
    RoutedPath r = routePath(resolved);
    if (r.isSd) {
        if (!sdCardMounted) return "";
        return "/sdcard" + r.realPath;
    }
    return "/littlefs" + r.realPath;
}

// romVfs -> same directory/name with the extension swapped for ".sav".
static String gbSavePath(const String& romVfs) {
    int dot = romVfs.lastIndexOf('.');
    int slash = romVfs.lastIndexOf('/');
    if (dot > slash) return romVfs.substring(0, dot) + ".sav";
    return romVfs + ".sav";
}

void handleGbCommand(const String parts[], int partCount) {
    if (partCount < 2) {
        outLine("Usage: gb <rom.gb|.gbc> [1x|fit]", C_CYAN);
        outLine("  ROM path is a normal DS path (e.g. /sd/roms/zelda.gb).", C_CYAN);
        outLine("  Controls (BLE keyboard via slave): arrows=D-pad, X=A, Z=B,", C_CYAN);
        outLine("  Enter=Start, Backspace=Select, Esc=quit.", C_CYAN);
        return;
    }

    gbFitMode = !(partCount >= 3 && parts[2] == "1x");

    String romVfs = gbVfsPath(parts[1]);
    if (romVfs.isEmpty()) {
        outLine("gb: SD not mounted (insert card and reboot)", C_RED);
        return;
    }

    if (!gbHost.begin()) {
        outLine("gb: " + gbHost.status(), C_RED);
        return;
    }
    if (!gbHost.load(romVfs, gbSavePath(romVfs))) {
        outLine("gb: " + gbHost.status(), C_RED);
        outLine("gb: check the path -- " + romVfs, C_YELLOW);
        return;
    }

    if (!gbSetupScale()) {
        // Couldn't get PSRAM for the scaled frame -- drop to native 1x, which
        // needs no scale buffer, rather than failing the launch.
        gbFitMode = false;
        gbSetupScale();
        outLine("gb: low memory, running native 1x", C_YELLOW);
    }

    outLine("gb: launching " + parts[1] + " -- Esc to quit", C_GREEN);
    drawDisplayFrame();   // flush that line to the panel before we take it over

    // Hand the panel and the keyboard over to the game.
    slaveLinkSendLine("GAME 1");   // DS-Slave: emit raw button events, not ASCII
    delay(20);
    tft.fillScreen(TFT_BLACK);

    uint8_t buttons = 0;
    const uint32_t frameUs = 16743;   // ~59.7 Hz, true GB frame period
    uint32_t nextFrame = micros();

    for (;;) {
        if (gbPumpInput(buttons)) break;

        gbHost.setButtons(buttons);
        gbHost.runFrame(true);
        gbBlitFrame();
        gbHost.tickSave();

        // Pace to ~59.7 fps when we're ahead; if a frame ran long, don't try to
        // "catch up" by spinning -- just reset the clock and carry on.
        uint32_t now = micros();
        int32_t remaining = (int32_t)(nextFrame + frameUs - now);
        if (remaining > 1000) {
            delay(remaining / 1000);
        } else if (remaining < -(int32_t)frameUs) {
            nextFrame = now;   // fell behind; resync
        }
        nextFrame += frameUs;
    }

    // Shut the game down and give everything back to the shell.
    gbHost.stop();            // flushes SRAM to the .sav
    gbFreeScale();
    slaveLinkSendLine("GAME 0");   // DS-Slave: back to normal keystroke mode

    outLine("gb: " + gbHost.status(), C_GREEN);
    displayDirty = true;      // force a full shell repaint over the game frame
    drawDisplayFrame();
    printPrompt();
}

#else   // FNK0104N_3P5_320x480_ST77922 -- QSPI panel path not implemented

void handleGbCommand(const String parts[], int partCount) {
    outLine("gb: not supported on the ST77922 QSPI panel variant yet", C_RED);
}

#endif
