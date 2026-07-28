#include "AudioOut.h"

// Muted stub -- see AudioOut.h for why. Every entry point is safe to call from
// the game glue whether or not audio ever comes up; with `ready` false they do
// nothing and no samples are ever handed to I2S.
namespace {
bool ready = false;
}

bool AudioOut::begin() { return ready; }
bool AudioOut::available() { return ready; }
void AudioOut::onSamples(void* /*buf*/, size_t /*len*/) {}
void AudioOut::pump() {}
void AudioOut::setDiscard(bool /*on*/) {}
void AudioOut::startStream() {}
void AudioOut::stats(uint32_t& pushed, uint32_t& dropped, uint32_t& underruns) {
  pushed = dropped = underruns = 0;
}
