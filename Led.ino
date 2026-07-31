//   Led.ino
//   Shared rear RGB LED helpers. One place owns LED availability, value clamping,
//   and hardware writes so native modules and .dapp opcodes behave identically.

#if __has_include(<esp32-hal-rgb-led.h>)
    #include <esp32-hal-rgb-led.h>
    #define REAR_LED_HAS_DRIVER 1
#endif

static uint8_t rearLedClampByte(long value) {
    if (value < 0) return 0;
    if (value > 255) return 255;
    return (uint8_t)value;
}

bool rearLedAvailable() {
#if (REAR_RGB_LED_PIN >= 0) && defined(REAR_LED_HAS_DRIVER)
    return true;
#else
    return false;
#endif
}

void rearLedSetRgb(uint8_t red, uint8_t green, uint8_t blue) {
#if (REAR_RGB_LED_PIN >= 0) && defined(REAR_LED_HAS_DRIVER)
    rgbLedWrite((uint8_t)REAR_RGB_LED_PIN, red, green, blue);
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
