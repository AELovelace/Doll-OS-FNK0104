#pragma once

#include <Arduino.h>

// DS port note: cube-boy's AudioOut captured an I2S TX handle from the
// Waveshare sensors HAL. DS's onboard ES8311 codec + I2S are owned by Radio.ino
// (its own FreeRTOS task), so wiring emulator audio means handing that I2S port
// and the codec over from the radio while a game runs -- deferred. Until then
// begin() returns false, available() stays false, and GameBoyHost passes a NULL
// audio callback to gnuboy: the core mixes into its scratch buffer and stays
// silent (failure-soft, exactly the path cube-boy uses on boards with no audio).
//
// The ring/pump/onSamples members below are kept as no-op-safe shims so turning
// audio on later is a change confined to this one file (bring up an i2s_std TX
// channel on RADIO_I2S_* pins + es8311_codec_init(), flip `ready` true) rather
// than a change to GameBoyHost or the glue.
namespace AudioOut {
bool begin();
bool available();
void onSamples(void* buf, size_t len);   // gb_audio_cb_t shape; len = int16 count
void pump();                              // call each loop tick while a game runs
void setDiscard(bool on);
void startStream();
void stats(uint32_t& pushed, uint32_t& dropped, uint32_t& underruns);
}  // namespace AudioOut
