//   WiFiManager.ino
//   Wi-Fi connectivity: merges DS's original always-on AP + router-join scaffold
//   with DOLL-OS's wifi.ino command subsystem (scan/connect/save/status). The AP
//   stays on unconditionally so the device is always reachable over telnet even
//   with no saved/working router credentials -- DOLL-OS didn't need this since the
//   M5Cardputer's screen/keyboard don't depend on the network at all, but here the
//   network *is* the interface, so losing STA connectivity can't mean losing the UI.
#include <LittleFS.h>

const char* WIFI_CREDS_PATH = "/wifi.cfg";
bool apActive = false;

void startAccessPoint() {
    IPAddress apAddress(192, 168, 4, 1);
    IPAddress apGateway(192, 168, 4, 1);
    IPAddress apSubnet(255, 255, 255, 0);

    if (!WiFi.softAPConfig(apAddress, apGateway, apSubnet)) {
        Serial.println("Failed to configure access-point address.");
    }

    bool started = WiFi.softAP(AP_SSID, AP_PASSWORD, 0, false, 4);
    if (!started) {
        Serial.println("Failed to start the access point.");
        while (true) {
            delay(1000);
        }
    }

    Serial.println("Access point started.");
    Serial.printf("  SSID: %s\n", AP_SSID);
    Serial.printf("  IP:   %s\n", WiFi.softAPIP().toString().c_str());
    apActive = true;
}

//tries saved credentials first, falling back to the config.h defaults
//returns true if the router connection succeeded
bool connectToInternet() {
    String ssid, password;
    if (!loadWifiCredentials(ssid, password)) {
        ssid = STA_DEFAULT_SSID;
        password = STA_DEFAULT_PASSWORD;
    }

    Serial.printf("Connecting to router: %s\n", ssid.c_str());
    WiFi.begin(ssid.c_str(), password.c_str());

    unsigned long startTime = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startTime < 15000) {
        Serial.print(".");
        delay(500);
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("Connected to router.");
        Serial.print("Station IP: ");
        Serial.println(WiFi.localIP());
        return true;
    }

    Serial.println("Could not connect to router.");
    return false;
}

unsigned long previousReconnectAttempt = 0;
const unsigned long reconnectInterval = 10000;

void maintainInternetConnection() {
    if (WiFi.status() == WL_CONNECTED) {
        return;
    }
    if (millis() - previousReconnectAttempt < reconnectInterval) {
        return;
    }
    previousReconnectAttempt = millis();

    String ssid, password;
    if (!loadWifiCredentials(ssid, password)) {
        ssid = STA_DEFAULT_SSID;
        password = STA_DEFAULT_PASSWORD;
    }
    WiFi.disconnect();
    WiFi.begin(ssid.c_str(), password.c_str());
}

int wifiIsConnected() {
    return WiFi.status() == WL_CONNECTED ? 1 : 0;
}

void scanWifiNetworks() {
    WiFi.scanDelete();
    outLine("Scanning for Wifi Networks");
    telnetClient.flush();   //push this line out before the blocking scan begins

    int networkCount = WiFi.scanNetworks();
    if (networkCount < 0) {
        outLine("Scan Failed", C_RED);
        WiFi.scanDelete();
        return;
    }
    if (networkCount == 0) {
        outLine("No Networks Found");
        WiFi.scanDelete();
        return;
    }
    outLine(String(networkCount) + " Networks Found");

    for (int i = 0; i < networkCount; i++) {
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0) {
            ssid = "<hidden>";
        }
        if (ssid.length() > 20) {
            ssid = ssid.substring(0, 20) + "...";
        }
        String security = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "OPEN" : "SECURE";
        String result = String(i + 1) + ". " + ssid + " "
                        + String(WiFi.RSSI(i)) + "dBm "
                        + "ch" + String(WiFi.channel(i)) + " " + security;
        outLine(result);
    }
    WiFi.scanDelete();
}

void wifiStatus() {
    if (wifiIsConnected() == 1) {
        outLine("WiFi connected", C_GREEN);
        outLine("SSID: " + WiFi.SSID());
        outLine("IP: " + WiFi.localIP().toString());
        outLine("Gateway: " + WiFi.gatewayIP().toString());
        outLine("Subnet: " + WiFi.subnetMask().toString());
    } else {
        outLine("WiFi Not Connected", C_RED);
    }
}

void showWifiStatus() {
    if (wifiIsConnected() == 0) {
        outLine("WiFi: not connected", C_RED);
        return;
    }
    wifiStatus();
}

void connectWifiNetwork(const String& ssid, const String& password) {
    outLine("Connecting to: " + ssid);
    telnetClient.flush();

    WiFi.begin(ssid.c_str(), password.c_str());

    const unsigned long timeoutMs = 15000;
    unsigned long startTime = millis();
    while (WiFi.status() != WL_CONNECTED && (millis() - startTime) < timeoutMs) {
        delay(250);
    }

    if (wifiIsConnected() == 1) {
        wifiStatus();
    } else {
        outLine("WiFi connect failed", C_RED);
    }
}

bool saveWifiCredentials(const String& ssid, const String& password) {
    File file = LittleFS.open(WIFI_CREDS_PATH, "w");
    if (!file) {
        return false;
    }
    file.println(ssid);
    file.println(password);
    file.close();
    return true;
}

bool loadWifiCredentials(String& ssid, String& password) {
    File file = LittleFS.open(WIFI_CREDS_PATH, "r");
    if (!file) {
        return false;
    }
    ssid = file.readStringUntil('\n');
    password = file.readStringUntil('\n');
    file.close();

    ssid.trim();
    password.trim();
    return ssid.length() > 0;
}

void wifiHelp() {
    outLine("WiFi subcommands:");
    outLine("wifi");
    outLine("wifi scan");
    outLine("wifi connect <ssid> <password>");
    outLine("wifi save <ssid> <password>");
}

//Expected forms: wifi | wifi scan | wifi connect <ssid> <password> | wifi save <ssid> <password>
void handleWifiCommand(const String parts[], int partCount) {
    if (partCount == 1) {
        showWifiStatus();
        return;
    }

    if (parts[1] == "scan") {
        scanWifiNetworks();
        return;
    }

    if (parts[1] == "connect") {
        if (partCount < 4) {
            String savedSsid, savedPassword;
            if (loadWifiCredentials(savedSsid, savedPassword)) {
                connectWifiNetwork(savedSsid, savedPassword);
            } else {
                outLine("Usage: wifi connect <ssid> <password>");
            }
            return;
        }
        connectWifiNetwork(parts[2], parts[3]);
        return;
    }

    if (parts[1] == "save") {
        if (partCount < 4) {
            if (wifiIsConnected() != 1) {
                outLine("Usage: wifi save <ssid> <password>");
                return;
            }
            if (saveWifiCredentials(WiFi.SSID(), WiFi.psk())) {
                outLine("Saved WiFi credentials");
            } else {
                outLine("Failed to save WiFi credentials", C_RED);
            }
            return;
        }
        if (saveWifiCredentials(parts[2], parts[3])) {
            outLine("Saved WiFi credentials");
        } else {
            outLine("Failed to save WiFi credentials", C_RED);
        }
        return;
    }

    wifiHelp();
}
