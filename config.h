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
//   STA credentials: the home/router network joined for internet access (STA-only;
//   the old fallback softAP is gone -- it halved streaming throughput). These can
//   also be set later at runtime with "wifi connect <ssid> <password>" +
//   "wifi save" -- these are only the first-boot defaults.
const char* STA_DEFAULT_SSID = "DollNet";
const char* STA_DEFAULT_PASSWORD = "WD10ears!";

//   Telnet
const uint16_t TELNET_PORT = 23;

//   FTP (FtpServer.ino) -- exposes the SD card over the network as an alternative to
//   USB MSC, which this board can't do (its single USB-C port is a serial bridge, not
//   native USB). Plaintext, LAN-only -- same posture as telnet above. Command port is
//   the library default 21 (passive data on 50009). Credentials must be < 16 chars
//   (FTP_CRED_SIZE). Connect from Explorer/FileZilla/WinSCP: ftp://<station-ip>/
const char* FTP_USER = "ds";
const char* FTP_PASS = "ds";

//   Motoko MQTT defaults
const char* MOTOKO_DEFAULT_BROKER = "192.168.44.4";
const int MOTOKO_DEFAULT_PORT = 1883;
const char* MOTOKO_CLIENT_ID = "MOTOKO-DS";

//   Radio defaults (Radio.ino) -- background stream player on the onboard ES8311
//   codec. Default station is the SGCRelay Pi's ICY/MP3 relay; any URL can be
//   given per-play with "radio play <url>". Volume is ESP32-audioI2S's software
//   scale, 0..21.
const char* RADIO_DEFAULT_URL = "http://192.168.1.252:8000/stream.mp3";
const int RADIO_DEFAULT_VOLUME = 12;
