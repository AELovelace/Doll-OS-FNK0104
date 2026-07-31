//   UsbMsc.ino
//   exposes the mounted SD card to a PC as a USB Mass Storage drive -- entered via
//   the "usb" command, exited with Ctrl+T (this device's local "detach" chord,
//   also used by RemoteSession -- see global.h). This feature is orthogonal to the
//   telnet-vs-keyboard interface swap: it's about a physical USB cable to a host
//   PC, not the network, so it's ported close to verbatim from DOLL-OS's
//   usb_msc.ino aside from swapping the SPI-based SD library for SD_MMC (see
//   Storage.ino) and the exit chord.
//
//   DOLL-OS's build target (M5Cardputer) is guaranteed to have native USB-OTG, so
//   it hard-failed the whole sketch at compile time (#error) if the Tools > USB
//   Mode wasn't set to "USB-OTG (TinyUSB)". This board's USB Mode is a build
//   setting this code can't control or detect being "right" for the user's intent,
//   so instead of refusing to compile, "usb" stays registered either way and just
//   reports itself unavailable at runtime when the build doesn't support it -- the
//   rest of the firmware still builds and runs regardless of that Tools menu setting.
#include <Arduino.h>

#if !SOC_USB_OTG_SUPPORTED || ARDUINO_USB_MODE
#define USB_MSC_SUPPORTED 0
#else
#define USB_MSC_SUPPORTED 1
#endif

#if USB_MSC_SUPPORTED

#include <USB.h>
#include <USBMSC.h>

USBMSC msc;
bool mscStarted = false;
static uint8_t* mscSectorScratch = nullptr;
static uint32_t mscSectorScratchSize = 0;

static bool ensureMscScratch(uint32_t sectorSize) {
    if (mscSectorScratchSize >= sectorSize && mscSectorScratch != nullptr) {
        return true;
    }
    uint8_t* resizedScratch = (uint8_t*)realloc(mscSectorScratch, sectorSize);
    if (resizedScratch == nullptr) {
        return false;
    }
    mscSectorScratch = resizedScratch;
    mscSectorScratchSize = sectorSize;
    return true;
}

static int32_t onMscRead(uint32_t lba, uint32_t offset, void* buffer, uint32_t bufsize) {
    uint32_t secSize = SD_MMC.sectorSize();
    if (!secSize || offset >= secSize) {
        return -1;
    }
    if (bufsize == 0) {
        return 0;
    }

    if (offset == 0 && (bufsize % secSize) == 0) {
        for (uint32_t i = 0; i < bufsize / secSize; i++) {
            if (!SD_MMC.readRAW((uint8_t*)buffer + (i * secSize), lba + i)) {
                return -1;
            }
        }
        return bufsize;
    }

    if (!ensureMscScratch(secSize)) {
        return -1;
    }

    uint8_t* out = (uint8_t*)buffer;
    uint32_t remaining = bufsize;
    uint32_t currentLba = lba;
    uint32_t currentOffset = offset;

    while (remaining > 0) {
        if (!SD_MMC.readRAW(mscSectorScratch, currentLba)) {
            return -1;
        }
        uint32_t chunkSize = min(remaining, secSize - currentOffset);
        memcpy(out, mscSectorScratch + currentOffset, chunkSize);
        out += chunkSize;
        remaining -= chunkSize;
        currentLba++;
        currentOffset = 0;
    }
    return bufsize;
}

static int32_t onMscWrite(uint32_t lba, uint32_t offset, uint8_t* buffer, uint32_t bufsize) {
    uint32_t secSize = SD_MMC.sectorSize();
    if (!secSize || offset >= secSize) {
        return -1;
    }
    if (bufsize == 0) {
        return 0;
    }

    if (offset == 0 && (bufsize % secSize) == 0) {
        for (uint32_t i = 0; i < bufsize / secSize; i++) {
            if (!SD_MMC.writeRAW(buffer + (i * secSize), lba + i)) {
                return -1;
            }
        }
        return bufsize;
    }

    if (!ensureMscScratch(secSize)) {
        return -1;
    }

    uint8_t* in = buffer;
    uint32_t remaining = bufsize;
    uint32_t currentLba = lba;
    uint32_t currentOffset = offset;

    while (remaining > 0) {
        uint32_t chunkSize = min(remaining, secSize - currentOffset);
        if (currentOffset != 0 || chunkSize != secSize) {
            if (!SD_MMC.readRAW(mscSectorScratch, currentLba)) {
                return -1;
            }
        }
        memcpy(mscSectorScratch + currentOffset, in, chunkSize);
        if (!SD_MMC.writeRAW(mscSectorScratch, currentLba)) {
            return -1;
        }
        in += chunkSize;
        remaining -= chunkSize;
        currentLba++;
        currentOffset = 0;
    }
    return bufsize;
}

static bool onMscStartStop(uint8_t power_condition, bool start, bool load_eject) {
    return true;
}

//blocks until Ctrl+T is received over the telnet session, keeping the SD card
//exposed as a USB drive the whole time
void runUsbModeBlocking() {
    outLine("USB mode on -- Ctrl+T to exit", C_YELLOW);

    while (true) {
        delay(10);
        //exit on Ctrl+T from either input surface. A dropped/absent telnet client no longer
        //ends USB mode -- otherwise running "usb" from the BLE keyboard alone would exit
        //instantly. The panel keeps showing the USB-mode banner the whole time.
        int raw = telnetReadFilteredByte();
        if (raw == -1) {
            raw = keyboardReadRawByte();
        }
        if (raw == 0x14) {
            break;
        }
        //other bytes are ignored -- the SD card is busy being a USB block device
    }

    msc.mediaPresent(false);
    usbModeDisplayActive = false;
    setActiveInput(shellPrompt(), "", false);   //cwd may have been forced back to "/" above
    drawDisplayFrame();
    outLine("USB mode off");
    //no printPrompt() here -- readTelnetClient()'s loop (TelnetServer.ino) already
    //reprints the prompt after every command, including this one, once we return
}

//handles the "usb" command: exposes the SD card over USB MSC and blocks until the user exits
void handleUsbCommand(const String parts[], int partCount) {
    if (!sdCardMounted) {
        outLine("usb: SD card not mounted", C_RED);
        return;
    }

    //the host PC can freely modify the SD card's directory structure while it's exposed;
    //bail out of it now so cwd can't end up pointing at something that no longer exists
    if (cwd == SD_MOUNT || cwd.startsWith(SD_MOUNT + "/")) {
        cwd = "/";
    }

    if (!mscStarted) {
        msc.vendorID("DS");
        msc.productID("SD Card");
        msc.productRevision("1.0");
        msc.onRead(onMscRead);
        msc.onWrite(onMscWrite);
        msc.onStartStop(onMscStartStop);
        msc.isWritable(true);
        msc.begin(SD_MMC.numSectors(), SD_MMC.sectorSize());
        USB.begin();
        mscStarted = true;
    }

    msc.mediaPresent(true);
    usbModeDisplayActive = true;
    setActiveInput("usb> ", "Ctrl+T to quit", false);
    drawDisplayFrame();
    runUsbModeBlocking();
}

#else /* !USB_MSC_SUPPORTED */

void handleUsbCommand(const String parts[], int partCount) {
    outLine("usb: not available on this build (needs Tools > USB Mode: USB-OTG / TinyUSB)", C_RED);
}

#endif
