//   FtpServer.ino
//   exposes the mounted SD card to the network as an FTP server -- the practical
//   replacement for USB MSC (UsbMsc.ino) on this board, whose single USB-C port is
//   a serial bridge, not native USB, so a mass-storage drive can never enumerate on
//   a host. FTP reaches the same goal (move files on/off the card from a PC) over
//   the WiFi that's already up, and every desktop OS can browse it: in Windows
//   Explorer's address bar type  ftp://<station-ip>/  (or use FileZilla/WinSCP).
//
//   Unlike "usb", this does NOT block: the server is serviced one non-blocking tick
//   at a time from loop() (ftpService below, next to readTelnetClient()), so the
//   shell, panel, radio and telnet all keep working while a transfer is in flight --
//   large files just get chunked across many loop() iterations. Toggle it with the
//   "ftp" command; it stays off until asked for, like usb.
//
//   Storage backend + credentials: the library is a separately-compiled translation
//   unit, so the SD_MMC selection lives in its config header (libraries/
//   SimpleFTPServer/FtpServerKey.h -> DEFAULT_STORAGE_TYPE_ESP32 STORAGE_SD_MMC),
//   not here. begin() does NOT re-mount SD_MMC -- it uses the card Storage.ino
//   already mounted with this board's custom pins. Creds come from config.h.
#include <Arduino.h>
#include <SimpleFTPServer.h>

//command port 21, passive data port 50009 -- the library defaults (FtpServer.h)
static FtpServer ftpSrv;
static bool ftpActive = false;

//serviced every loop() tick while active -- non-blocking, drives the FTP state
//machine one step (accept/auth/one buffer of transfer) and returns immediately
void ftpService() {
    if (ftpActive) {
        ftpSrv.handleFTP();
    }
}

static void ftpStart() {
    if (ftpActive) {
        outLine("ftp: already running", C_YELLOW);
        return;
    }
    if (!sdCardMounted) {
        outLine("ftp: SD card not mounted", C_RED);
        return;
    }
    //begin() only starts the listeners + allocates the transfer buffer; the SD card
    //stays mounted exactly as Storage.ino left it
    ftpSrv.begin(FTP_USER, FTP_PASS);
    ftpActive = true;

    outLine("FTP server on", C_GREEN);
    if (wifiIsConnected() == 1) {
        outLine("  ftp://" + WiFi.localIP().toString() + "/  (Explorer/FileZilla/WinSCP)");
    } else {
        outLine("  (WiFi not connected -- reachable once STA joins)", C_YELLOW);
    }
    outLine("  user: " + String(FTP_USER) + "   pass: " + String(FTP_PASS));
    outLine("  serving the SD card -- 'ftp off' to stop");
}

static void ftpStop() {
    if (!ftpActive) {
        outLine("ftp: not running", C_YELLOW);
        return;
    }
    ftpSrv.end();
    ftpActive = false;
    outLine("FTP server off");
}

static void ftpStatus() {
    if (!ftpActive) {
        outLine("FTP: off  ('ftp on' to start)");
        return;
    }
    outLine("FTP: on", C_GREEN);
    if (wifiIsConnected() == 1) {
        outLine("  ftp://" + WiFi.localIP().toString() + "/");
    }
    outLine("  user: " + String(FTP_USER) + "   pass: " + String(FTP_PASS));
}

//handles the "ftp" command: "ftp on"/"start" begins, "ftp off"/"stop" ends, bare
//"ftp" reports status. Non-modal -- the prompt returns immediately either way.
void handleFtpCommand(const String parts[], int partCount) {
    String sub = (partCount > 1) ? parts[1] : "";
    sub.toLowerCase();

    if (sub == "on" || sub == "start") {
        ftpStart();
    } else if (sub == "off" || sub == "stop") {
        ftpStop();
    } else if (sub == "" || sub == "status") {
        ftpStatus();
    } else {
        outLine("Usage: ftp [on|off|status]");
    }
}
