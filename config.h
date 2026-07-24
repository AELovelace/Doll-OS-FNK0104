//   config.h
//   build-time configuration for DS -- board pins, network credentials, defaults.
//   Ported from DOLL-OS's config.h; expanded with the settings DOLL-OS hardcoded
//   into M5Cardputer-specific headers (SD pins, battery ADC) since this board
//   needs its own values for both.
#pragma once

//   Board variant
//   This firmware targets the Freenove ESP32-S3 display family (FNK0104-series,
//   sold as the "FNK1014B" kit). Only the SD_MMC bus and battery ADC pin differ
//   between panel variants -- uncomment the one you have. Values below are taken
//   directly from Freenove's own example sketches for this board.
#define FNK0104AB_2P8_240x320_ILI9341
//#define FNK0104N_3P5_320x480_ST77922
//#define FNK0104S_4P0_320x480_ST7796

#ifdef FNK0104N_3P5_320x480_ST77922
    const int SD_MMC_CLK_PIN = 5;
    const int SD_MMC_CMD_PIN = 4;
    const int SD_MMC_D0_PIN  = 6;
    const int SD_MMC_D1_PIN  = 7;
    const int SD_MMC_D2_PIN  = 2;
    const int SD_MMC_D3_PIN  = 3;
    const int BATTERY_ADC_PIN = 8;
#else
    const int SD_MMC_CLK_PIN = 38;
    const int SD_MMC_CMD_PIN = 40;
    const int SD_MMC_D0_PIN  = 39;
    const int SD_MMC_D1_PIN  = 41;
    const int SD_MMC_D2_PIN  = 48;
    const int SD_MMC_D3_PIN  = 47;
    const int BATTERY_ADC_PIN = 9;
#endif

//battery voltage divider on this board is 2:1 (see Freenove's Battery_Voltage example)
const float BATTERY_ADC_DIVIDER = 2.0f;
//rough LiPo curve endpoints for a percent estimate -- not a fuel-gauge chip, just linear interpolation
const float BATTERY_VOLTAGE_EMPTY = 3.3f;
const float BATTERY_VOLTAGE_FULL  = 4.2f;

//   Wi-Fi
//   AP side: this device's own network, always on so it's reachable even with
//   no saved router credentials. STA side: the home/router network it joins for
//   internet access. STA credentials can also be set later at runtime with
//   "wifi connect <ssid> <password>" + "wifi save" -- these are only the
//   first-boot defaults.
const char* AP_SSID = "ESPTerm";
const char* AP_PASSWORD = "esp32router";
const char* STA_DEFAULT_SSID = "DollNet";
const char* STA_DEFAULT_PASSWORD = "WD10ears!";

//   Telnet
const uint16_t TELNET_PORT = 23;

//   Motoko MQTT defaults
const char* MOTOKO_DEFAULT_BROKER = "192.168.44.4";
const int MOTOKO_DEFAULT_PORT = 1883;
const char* MOTOKO_CLIENT_ID = "MOTOKO-DS";
