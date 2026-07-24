#ifndef _ST77922_H_
#define _ST77922_H_

#include "hal/gpio_ll.h"

#define LCD_WIDTH 320
#define LCD_HEIGHT 480

#define TFT_WIDTH 320
#define TFT_HEIGHT 480

#define WR_RAM_C_CMD 0x3C
#define WR_RAM_CMD 0x2C
#define RD_RAM_CMD 0x2E
#define SET_X_CMD  0x2A
#define SET_Y_CMD  0x2B
#define MADCTL_CMD 0x36
#define QSPI_1W_CMD 0x02
#define QSPI_4W_CMD 0x32

#define TX_LEN (0x4000)

#define QSPI_PORT SPI2_HOST
#define QSPI_FREQUENCY 80000000
#define QSPI_MODE SPI_MODE0


//pin define for ESP32-S3, include lcd pin
#define LCD_CS  10
#define LCD_BL  41
//below is QSPI pin
#define QSPI_SCLK 12
#define QSPI_D0   11
#define QSPI_D1   13
#define QSPI_D2   14
#define QSPI_D3   9

//Pin operation
#if ((LCD_CS>=0) && (LCD_CS<32))
    #define LCD_CS_LOW  GPIO.out_w1tc = (1 << LCD_CS)
    #define LCD_CS_HIGH GPIO.out_w1ts = (1 << LCD_CS)
#elif (LCD_CS>=32)
    #define LCD_CS_LOW  GPIO.out1_w1tc.val = (1 << (LCD_CS - 32))
    #define LCD_CS_HIGH GPIO.out1_w1ts.val = (1 << (LCD_CS - 32))
#endif

#if ((LCD_BL>=0) && (LCD_BL<32))
    #define LCD_BL_LOW  GPIO.out_w1tc = (1 << LCD_BL)
    #define LCD_BL_HIGH GPIO.out_w1ts = (1 << LCD_BL)
#elif (LCD_BL>=32)
    #define LCD_BL_LOW  GPIO.out1_w1tc.val = (1 << (LCD_BL - 32))
    #define LCD_BL_HIGH GPIO.out1_w1ts.val = (1 << (LCD_BL - 32))
#endif

class ST77922
{
public:
	ST77922(void);
	void Write_Reg(uint32_t cmd, void *data, uint8_t len);
	void Init(void);
	void Set_Rotation(uint8_t r);
	uint8_t Get_Rotation(void);
	void Set_Windows(uint16_t sx, uint16_t sy, uint16_t ex, uint16_t ey);
	void Fill_Colors(uint16_t sx, uint16_t sy, uint16_t w, uint16_t h, uint16_t* color);
	uint16_t Get_Width(void);
	uint16_t Get_Height(void);
private:
	uint16_t width, height, rotation;
};

typedef struct {
    uint8_t cmd;       
    void *data;      
    uint8_t len;     
    uint32_t delay_ms; 
}lcd_init_cmd;

#endif