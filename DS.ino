//   DS.ino
//   entry point -- telnet-interface port of DOLL-OS for the Freenove ESP32-S3
//   display board (FNK0104-series / "FNK1014B"). No physical screen or keyboard is
//   used: a single telnet client is the entire UI, replacing M5Cardputer's sprite
//   display + keyboard as DOLL-OS's whole interaction model. See docs/PORTING.md
//   for what changed and why.
#include <Arduino.h>
#include <WiFi.h>
#include <FS.h>
#include "config.h"
#include "global.h"

void setup() {
    Serial.begin(115200);

    //GPIO2 driven low as a convenience ground pin next to the keyboard UART header --
    //temporary, so a nearby jumper to DS-Slave has a ground to land on. It's only a
    //signal reference (the real return path is the shared USB ground); an output-low pin
    //can sink very little current, so don't hang any real load off it. Safe on ESP32-S3:
    //GPIO2 isn't a strapping pin here (0/3/45/46 are) and is otherwise unused.
    pinMode(2, OUTPUT);
    digitalWrite(2, LOW);

    unsigned long serialStart = millis();
    while (!Serial && millis() - serialStart < 3000) {
        delay(10);
    }

    Serial.println();
    Serial.println("Starting DS...");
    Serial.flush();   //force this out over UART now, in case something below hangs before the next line

    //report PSRAM up front -- if it's not enabled here, the ~150KB frame sprite and the
    //history ring stay in internal SRAM and everything below is starved for it
    reportPsramStatus();

    //flip the general heap over to PSRAM before anything big allocates, so the display,
    //WiFi, storage and every later malloc/new/String below spill into PSRAM instead of
    //internal SRAM wherever they can (see enablePsramHeap)
    enablePsramHeap();

    //bring the panel up first so boot progress is visible on it too -- it mirrors
    //the telnet session (see Display.ino) but doesn't gate on one existing
    Serial.println("[boot] initDisplay()...");
    Serial.flush();
    initDisplay();
    drawDisplayBootSplash();
    Serial.println("[boot] display OK");
    Serial.flush();

    recordHeapCheckpoint("setup start");
    reserveHotStrings();
    recordHeapCheckpoint("after reserve");

    //AP + Station mode: AP side is this device's own always-on network, STA side
    //joins the configured router for internet access (see WiFiManager.ino)
    Serial.println("[boot] WiFi AP+STA...");
    Serial.flush();
    WiFi.mode(WIFI_AP_STA);
    startAccessPoint();
    connectToInternet();
    recordHeapCheckpoint("after wifi");
    Serial.println("[boot] WiFi OK");
    Serial.flush();

    Serial.println("[boot] initStorage()...");
    Serial.flush();
    initStorage();
    recordHeapCheckpoint("after storage");
    Serial.println("[boot] storage OK");
    Serial.flush();

    //second UART for the DS-Slave BLE-keyboard bridge (KeyboardSerial.ino)
    Serial.println("[boot] initKeyboardSerial()...");
    Serial.flush();
    initKeyboardSerial();

    //bit-banged outbound command channel to DS-Slave on GPIO15 (SlaveLink.ino) -- must
    //come after initKeyboardSerial(), which now leaves GPIO15 unclaimed for the bitbang
    slaveLinkBegin();

    telnetServer.begin();
    telnetServer.setNoDelay(true);

    Serial.println();
    Serial.println("Telnet server started.");
    Serial.printf("  AP SSID: %s\n", AP_SSID);
    Serial.printf("  AP IP:   %s\n", WiFi.softAPIP().toString().c_str());
    Serial.println("Connect with: telnet <ip> 23");

    //start the interactive shell right now instead of waiting for a telnet client to
    //connect -- the panel + BLE keyboard (KeyboardSerial.ino) are a complete UI on their
    //own, so present the welcome banner and prompt immediately. A telnet client that
    //dials in later re-runs this same sequence for its own screen (acceptTelnetClient()).
    beginShellSession();
    outLine("DS ready. AP: " + String(AP_SSID) + " (" + WiFi.softAPIP().toString() + ")");
    outLine("Connect with: telnet " + WiFi.softAPIP().toString() + " 23");
    outLine("");
    printPrompt();
    drawDisplayFrame();
}

void loop() {
    acceptTelnetClient();
    readTelnetClient();
    readKeyboardSerial();   //keystrokes from the DS-Slave BLE-keyboard bridge (KeyboardSerial.ino)
    maintainInternetConnection();
    drawDisplayFrame();   //mirrors whatever changed this tick -- history, status bar, live input line
    delay(1);
}
