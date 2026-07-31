//   Led.ino
//   Shared rear RGB LED helpers and the DOLL-OS indicator mixer. One place owns
//   availability, clamping, priority, and hardware writes so native modules and
//   .dapp opcodes behave identically.

#if REAR_RGB_LED_PIN >= 0
    // FNK0104 boards use Freenove's onboard WS2812 implementation. Keep this
    // dependency explicit: silently selecting another installed LED library made
    // the previous fix compile without ever exercising the vendor-tested path.
    #include <Freenove_WS2812_Lib_for_ESP32.h>
#endif

static const uint8_t REAR_RGB_LED_COUNT = 1;
static const uint8_t REAR_RGB_LED_CHANNEL = 0;

#if REAR_RGB_LED_PIN >= 0
static Freenove_ESP32_WS2812 rearLedStrip =
    Freenove_ESP32_WS2812(REAR_RGB_LED_COUNT, REAR_RGB_LED_PIN, REAR_RGB_LED_CHANNEL, TYPE_GRB);
#endif

static bool rearLedInitialized = false;
static bool rearLedBeginAttempted = false;

static uint8_t rearLedClampByte(long value) {
    if (value < 0) return 0;
    if (value > 255) return 255;
    return (uint8_t)value;
}

bool rearLedAvailable() {
#if REAR_RGB_LED_PIN >= 0
    return true;
#else
    return false;
#endif
}

static void rearLedHardwareBegin() {
    if (rearLedBeginAttempted) {
        return;
    }
    rearLedBeginAttempted = true;
#if REAR_RGB_LED_PIN >= 0
    rearLedInitialized = rearLedStrip.begin();
    if (!rearLedInitialized) {
        Serial.printf("[boot] rear RGB LED init failed on GPIO %d\n", REAR_RGB_LED_PIN);
        return;
    }
    rearLedStrip.setBrightness(REAR_RGB_LED_BRIGHTNESS);
    rearLedStrip.setLedColorData(0, 0, 0, 0);
    rearLedStrip.show();
#endif
}

void rearLedSetRgb(uint8_t red, uint8_t green, uint8_t blue) {
#if REAR_RGB_LED_PIN >= 0
    rearLedHardwareBegin();
    if (!rearLedInitialized) {
        return;
    }
    rearLedStrip.setLedColorData(0, red, green, blue);
    rearLedStrip.show();
#else
    (void)red;
    (void)green;
    (void)blue;
#endif
}

void rearLedSetRgbLong(long red, long green, long blue) {
    rearLedSetRgb(rearLedClampByte(red), rearLedClampByte(green), rearLedClampByte(blue));
}

void rearLedOff() {
    rearLedSetRgb(0, 0, 0);
}

static portMUX_TYPE ledMux = portMUX_INITIALIZER_UNLOCKED;
static bool ledSdMounted = false;
static bool ledWifiConnected = false;
static bool ledFtpActive = false;
static bool ledTelnetConnected = false;
static bool ledKeyboardActive = false;
static bool ledUsbActive = false;
static bool ledAppOverride = false;
static LedRgb ledAppColor = { 0, 0, 0 };
static LedRgb ledPulseColor = { 0, 0, 0 };
static unsigned long ledPulseUntilMs = 0;
static RadioState ledRadioState = RADIO_OFF;
static LedRgb ledLastColor = { 255, 255, 255 };

static LedRgb ledScale(LedRgb color, uint8_t numerator, uint8_t denominator) {
    if (denominator == 0) {
        return color;
    }
    color.red = (uint8_t)((uint16_t)color.red * numerator / denominator);
    color.green = (uint8_t)((uint16_t)color.green * numerator / denominator);
    color.blue = (uint8_t)((uint16_t)color.blue * numerator / denominator);
    return color;
}

static LedRgb ledBlink(LedRgb color, unsigned long now, unsigned long periodMs) {
    return ((now / periodMs) & 0x01) ? ledScale(color, 1, 5) : color;
}

static LedRgb ledBreathe(LedRgb color, unsigned long now) {
    unsigned long phase = (now / 160) % 6;
    uint8_t brightness = (phase < 3) ? (2 + phase) : (7 - phase);
    return ledScale(color, brightness, 5);
}

static void ledWriteIfChanged(LedRgb color) {
    if (color.red == ledLastColor.red &&
        color.green == ledLastColor.green &&
        color.blue == ledLastColor.blue) {
        return;
    }
    rearLedSetRgb(color.red, color.green, color.blue);
    ledLastColor = color;
}

static void ledPulse(LedRgb color, unsigned long durationMs) {
    portENTER_CRITICAL(&ledMux);
    ledPulseColor = color;
    ledPulseUntilMs = millis() + durationMs;
    portEXIT_CRITICAL(&ledMux);
}

static LedRgb ledPersistentColor(unsigned long now, bool sdMounted, bool wifiConnected,
                                 bool ftpActive, bool telnetConnected, bool keyboardActive,
                                 bool usbActive, bool appOverride, LedRgb appColor,
                                 RadioState radioState) {
    if (appOverride) {
        return appColor;
    }
    if (usbActive) {
        return ledBlink({ 180, 180, 255 }, now, 180);
    }

    switch (radioState) {
        case RADIO_CONNECTING:
            return ledBlink({ 0, 80, 180 }, now, 220);
        case RADIO_PLAYING:
            return ledBreathe({ 0, 170, 0 }, now);
        case RADIO_PAUSED:
            return ledBlink({ 180, 110, 0 }, now, 500);
        case RADIO_ERROR:
            return ledBlink({ 220, 0, 0 }, now, 160);
        case RADIO_OFF:
        case RADIO_STOPPED:
        default:
            break;
    }

    if (ftpActive) {
        return ledBlink({ 0, 120, 150 }, now, 700);
    }
    if (telnetConnected) {
        return { 120, 0, 130 };
    }
    if (wifiConnected) {
        return { 0, 0, 40 };
    }
    if (keyboardActive) {
        return { 35, 0, 35 };
    }
    if (sdMounted) {
        return { 0, 28, 10 };
    }
    return { 0, 0, 0 };
}

void ledBegin() {
    ledLastColor = { 255, 255, 255 };
    rearLedHardwareBegin();
#if REAR_RGB_LED_PIN >= 0
    if (rearLedInitialized) {
        Serial.printf("[boot] rear RGB LED ready: GPIO %d, Freenove WS2812\n", REAR_RGB_LED_PIN);
        // A brief, deterministic hardware self-test before the status mixer takes
        // ownership. This also makes it obvious that the newly flashed image ran.
        rearLedSetRgb(96, 0, 0);
        delay(120);
        rearLedSetRgb(0, 96, 0);
        delay(120);
        rearLedSetRgb(0, 0, 96);
        delay(120);
    }
#endif
    ledWriteIfChanged({ 0, 0, 0 });
}

void ledService() {
    if (!rearLedAvailable()) {
        return;
    }

    const unsigned long now = millis();
    bool sdMounted;
    bool wifiConnected;
    bool ftpActive;
    bool telnetConnected;
    bool keyboardActive;
    bool usbActive;
    bool appOverride;
    LedRgb appColor;
    LedRgb pulseColor;
    unsigned long pulseUntil;
    RadioState radioState;

    portENTER_CRITICAL(&ledMux);
    sdMounted = ledSdMounted;
    wifiConnected = ledWifiConnected;
    ftpActive = ledFtpActive;
    telnetConnected = ledTelnetConnected;
    keyboardActive = ledKeyboardActive;
    usbActive = ledUsbActive;
    appOverride = ledAppOverride;
    appColor = ledAppColor;
    pulseColor = ledPulseColor;
    pulseUntil = ledPulseUntilMs;
    radioState = ledRadioState;
    portEXIT_CRITICAL(&ledMux);

    if ((long)(pulseUntil - now) > 0) {
        ledWriteIfChanged(pulseColor);
        return;
    }

    ledWriteIfChanged(ledPersistentColor(now, sdMounted, wifiConnected, ftpActive,
                                         telnetConnected, keyboardActive, usbActive,
                                         appOverride, appColor, radioState));
}

void ledPulseStorageRead(bool isSd) {
    ledPulse(isSd ? LedRgb{ 0, 90, 255 } : LedRgb{ 90, 60, 0 }, 90);
}

void ledPulseStorageWrite(bool isSd) {
    ledPulse(isSd ? LedRgb{ 255, 255, 255 } : LedRgb{ 255, 90, 0 }, 140);
}

void ledPulseNetwork() {
    ledPulse({ 0, 180, 180 }, 90);
}

void ledPulseInput() {
    ledPulse({ 180, 0, 180 }, 70);
}

void ledPulseError() {
    ledPulse({ 255, 0, 0 }, 220);
}

void ledSetSdMounted(bool mounted) {
    portENTER_CRITICAL(&ledMux);
    ledSdMounted = mounted;
    portEXIT_CRITICAL(&ledMux);
}

void ledSetWifiConnected(bool connected) {
    portENTER_CRITICAL(&ledMux);
    ledWifiConnected = connected;
    portEXIT_CRITICAL(&ledMux);
}

void ledSetFtpActive(bool active) {
    portENTER_CRITICAL(&ledMux);
    ledFtpActive = active;
    portEXIT_CRITICAL(&ledMux);
}

void ledSetTelnetConnected(bool connected) {
    portENTER_CRITICAL(&ledMux);
    ledTelnetConnected = connected;
    portEXIT_CRITICAL(&ledMux);
}

void ledSetKeyboardActive(bool active) {
    portENTER_CRITICAL(&ledMux);
    ledKeyboardActive = active;
    portEXIT_CRITICAL(&ledMux);
}

void ledSetUsbActive(bool active) {
    portENTER_CRITICAL(&ledMux);
    ledUsbActive = active;
    portEXIT_CRITICAL(&ledMux);
}

void ledSetRadioState(RadioState state) {
    portENTER_CRITICAL(&ledMux);
    ledRadioState = state;
    portEXIT_CRITICAL(&ledMux);
}

void ledSetAppOverrideRgb(uint8_t red, uint8_t green, uint8_t blue) {
    portENTER_CRITICAL(&ledMux);
    ledAppOverride = true;
    ledAppColor = { red, green, blue };
    portEXIT_CRITICAL(&ledMux);
}

void ledSetAppOverrideRgbLong(long red, long green, long blue) {
    ledSetAppOverrideRgb(rearLedClampByte(red), rearLedClampByte(green), rearLedClampByte(blue));
}

void ledClearAppOverride() {
    portENTER_CRITICAL(&ledMux);
    ledAppOverride = false;
    ledAppColor = { 0, 0, 0 };
    portEXIT_CRITICAL(&ledMux);
}
