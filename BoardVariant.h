#pragma once

// Select exactly one FNK0104 hardware variant. This header is intentionally
// separate from config.h: the sketch-local TFT_eSPI library is compiled as its
// own translation unit and must see the same selection as the sketch.
//
// The N variant is the active target while its port is being brought up.
#define FNK0104AB_2P8_240x320_ILI9341
//#define FNK0104N_3P5_320x480_ST77922
//#define FNK0104S_4P0_320x480_ST7796

#if (defined(FNK0104AB_2P8_240x320_ILI9341) + \
     defined(FNK0104N_3P5_320x480_ST77922) + \
     defined(FNK0104S_4P0_320x480_ST7796)) != 1
#error "Select exactly one FNK0104 variant in BoardVariant.h"
#endif
