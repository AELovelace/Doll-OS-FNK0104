#include <Arduino.h>
#include <SPI.h>
#include "driver/spi_master.h"
#include "ST77922.h"

static const lcd_init_cmd st77922_lcd_init[] = {
    {0xF1, (uint8_t []){0x00}, 1, 0},
    {0x60, (uint8_t []){0x00, 0x00, 0x00}, 3, 0},
    {0x65, (uint8_t []){0x80}, 1, 0},
    {0x79, (uint8_t []){0x06}, 1, 0},
    {0x7B, (uint8_t []){0x00, 0x08, 0x08}, 3, 0},
    {0x80, (uint8_t []){0x55, 0x62, 0x2F, 0x17, 0xF0, 0x52, 0x70, 0xD2, 0x52, 0x62, 0xEA}, 11, 0},
    {0x81, (uint8_t []){0x26, 0x52, 0x72, 0x27}, 4, 0},
    {0x84, (uint8_t []){0x92, 0x25}, 2, 0},
    {0x87, (uint8_t []){0x10, 0x10, 0x58, 0x00, 0x02, 0x3A}, 6, 0},
    {0x88, (uint8_t []){0x00, 0x00, 0x2C, 0x10, 0x04, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x06}, 15, 0},
    {0x89, (uint8_t []){0x00, 0x00, 0x00}, 3, 0},
    {0x8A, (uint8_t []){0x13, 0x00, 0x2C, 0x00, 0x00, 0x2C, 0x10, 0x10, 0x00, 0x3E, 0x19}, 11, 0},
    {0x8B, (uint8_t []){0x15, 0xB1, 0xB1, 0x44, 0x96, 0x2C, 0x10, 0x97, 0x8E}, 9, 0},
    {0x8C, (uint8_t []){0x1D, 0xB1, 0xB1, 0x44, 0x96, 0x2C, 0x10, 0x50, 0x0F, 0x01, 0xC5, 0x12, 0x09}, 13, 0},
    {0x8D, (uint8_t []){0x0C}, 1, 0},
    {0x8E, (uint8_t []){0x33, 0x01, 0x0C, 0x13, 0x01, 0x01}, 6, 0},
    {0xB3, (uint8_t []){0x00, 0x30}, 2, 0},
    {0xF1, (uint8_t []){0x00}, 1, 0},
    {0x71, (uint8_t []){0xD0}, 1, 0},
    {0x66, (uint8_t []){0x02, 0x3F}, 2,  0},
    {0xBE, (uint8_t []){0x26, 0x00, 0x9D}, 3, 0},
    {0x70, (uint8_t []){0x01, 0xA0, 0x11, 0x40, 0xE0, 0x00, 0x11, 0x69, 0x11, 0x00, 0x00, 0x1A}, 12, 0},
    {0x90, (uint8_t []){0x04, 0x04, 0x55, 0x74, 0x00, 0x40, 0x43, 0x27, 0x27}, 9, 0},
    {0x91, (uint8_t []){0x04, 0x04, 0x55, 0x75, 0x00, 0x40, 0x42, 0x27, 0x27}, 9, 0},
    {0x92, (uint8_t []){0x04, 0x44, 0x55, 0xC0, 0x06, 0x00, 0x07, 0x05, 0x90, 0x27}, 10, 0},
    {0x93, (uint8_t []){0x04, 0x43, 0x11, 0x00, 0x00, 0x00, 0x00, 0x05, 0x90, 0x27}, 10, 0},
    {0x94, (uint8_t []){0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, 6, 0},
    {0x95, (uint8_t []){0x96, 0x16, 0x00, 0x00, 0xFF}, 5, 0},
    {0x96, (uint8_t []){0x44, 0x53, 0x03, 0x12, 0x23, 0x24, 0x06, 0x05, 0x94, 0x27, 0x00, 0x44}, 12, 0},
    {0x97, (uint8_t []){0x44, 0x53, 0x47, 0x56, 0x20, 0x20, 0x02, 0x01, 0x94, 0x27, 0x00, 0x44}, 12, 0},
    {0xBA, (uint8_t []){0x55, 0x94, 0x2D, 0x94, 0x27}, 5, 0},
    {0x9A, (uint8_t []){0x40, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00}, 7, 0},
    {0x9B, (uint8_t []){0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00}, 7, 0},
    {0x9C, (uint8_t []){0x5C, 0x12, 0x00, 0x00, 0x10, 0x12, 0x00, 0x00, 0x10, 0x02, 0x00, 0x00, 0x00}, 13, 0},
    {0x9D, (uint8_t []){0x8A, 0x51, 0x00, 0x00, 0x00, 0x80, 0x1E, 0x01}, 8, 0},
    {0x9E, (uint8_t []){0x51, 0x00, 0x00, 0x00, 0x80, 0x1E, 0x01}, 7, 0},
    {0xB4, (uint8_t []){0x1D, 0x1C, 0x1E, 0x0B, 0x14, 0x02, 0x13, 0x09, 0x1E, 0x00, 0x1E, 0x10}, 12, 0},
    {0xB5, (uint8_t []){0x1D, 0x1C, 0x1E, 0x0A, 0x15, 0x03, 0x11, 0x08, 0x1E, 0x01, 0x1E, 0x12}, 12, 0},
    {0xB6, (uint8_t []){0x77, 0x77, 0x00, 0x0A, 0xFF, 0x0A, 0xFF}, 7, 0},
    {0x86, (uint8_t []){0xCD, 0x04, 0xB1, 0x02, 0x58, 0x12, 0x58, 0x0C, 0x13, 0x01, 0xA5, 0x00, 0xA5, 0xA5}, 14, 0},
    {0xB7, (uint8_t []){0x07, 0x0A, 0x0E, 0x06, 0x05, 0x03, 0x2B, 0x03, 0x03, 0x42, 0x07, 0x10, 0x10, 0x2E, 0x3F, 0x0D}, 16, 0},
    {0xB8, (uint8_t []){0x07, 0x0A, 0x0D, 0x05, 0x05, 0x02, 0x2B, 0x02, 0x03, 0x42, 0x06, 0x10, 0x0F, 0x2E, 0x3F, 0x0D}, 16, 0},
    {0xB9, (uint8_t []){0x23, 0x23}, 2, 0},
    {0xBF, (uint8_t []){0x10, 0x14, 0x14, 0x0B, 0x0B, 0x0B}, 6, 0},
    {0xF2, (uint8_t []){0x00}, 1, 0},
    {0x73, (uint8_t []){0x04, 0xDA, 0x12, 0x54, 0x47}, 5, 0},
    {0x77, (uint8_t []){0x6B, 0x5B, 0xFD, 0xC3, 0xC5}, 5, 0},
    {0x7A, (uint8_t []){0x15, 0x27}, 2, 0},
    {0x7B, (uint8_t []){0x04, 0x57}, 2, 0},
    {0x7E, (uint8_t []){0x01, 0x0E}, 2, 0},
    {0xBF, (uint8_t []){0x36}, 1, 0},
    {0xE3, (uint8_t []){0x40, 0x40}, 2, 0},
    {0xF0, (uint8_t []){0x00}, 1, 0},
    {0xD0, (uint8_t []){0x00}, 1, 0},
    {0x2A, (uint8_t []){0x00, 0x00, 0x01, 0x3F}, 4, 0},
    {0x2B, (uint8_t []){0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x21, (uint8_t []){0x00}, 0, 0},
    {0x11, (uint8_t []){0x00}, 0, 120},
    {0x29, (uint8_t []){0x00}, 0, 0},
    {0x2C, (uint8_t []){0x00}, 0, 0},
    {0x3A, (uint8_t []){0x01}, 1, 0},
    {0x36, (uint8_t []){0x00}, 1, 0},
    {0x35, (uint8_t []){0x01}, 1, 20},
};


static spi_device_handle_t qspi;

ST77922::ST77922(void)
{
	width = LCD_WIDTH;
	height = LCD_HEIGHT;
	rotation = 0;
	pinMode(LCD_CS, OUTPUT);
	digitalWrite(LCD_CS, HIGH);
 	pinMode(LCD_BL, OUTPUT);
	digitalWrite(LCD_BL, LOW);
	const spi_bus_config_t buscfg = 
    {
        .data0_io_num = QSPI_D0,
        .data1_io_num = QSPI_D1,
        .sclk_io_num = QSPI_SCLK,
        .data2_io_num = QSPI_D2,
        .data3_io_num = QSPI_D3,
        .max_transfer_sz = (TX_LEN*16)+8,
        .flags = SPICOMMON_BUSFLAG_MASTER | SPICOMMON_BUSFLAG_IOMUX_PINS |SPICOMMON_BUSFLAG_QUAD,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(QSPI_PORT, &buscfg, SPI_DMA_CH_AUTO));
    spi_device_interface_config_t devcfg = {
        .command_bits = 0,
        .address_bits = 0,
        .mode = QSPI_MODE,
        .clock_speed_hz = QSPI_FREQUENCY,
        .spics_io_num = LCD_CS,
        .flags = SPI_DEVICE_HALFDUPLEX ,
        .queue_size = 17,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(QSPI_PORT, &devcfg, &qspi));
	Init();
	Set_Rotation(0);
}

void ST77922::Write_Reg(uint32_t cmd, void *data, uint8_t len)
{
	LCD_CS_LOW; 
    spi_transaction_ext_t qspit;
    memset(&qspit, 0, sizeof(qspit));
    qspit.base.flags = (SPI_TRANS_VARIABLE_CMD | SPI_TRANS_VARIABLE_ADDR);
    qspit.base.cmd = QSPI_1W_CMD;
    qspit.base.addr = cmd << 8;
    qspit.command_bits = 8;
    qspit.address_bits = 24;
    if(len != 0)
    {
        qspit.base.tx_buffer = data;
        qspit.base.length = 8 * len;
    }
    else
    {
        qspit.base.tx_buffer = NULL;
        qspit.base.length = 0;        
    }
    spi_device_polling_transmit(qspi, (spi_transaction_t *)&qspit);
    LCD_CS_HIGH;
}

void ST77922::Init(void)
{
	uint16_t i = 0;
    for(i=0; i<sizeof(st77922_lcd_init)/sizeof(lcd_init_cmd); i++)
    {
        Write_Reg(st77922_lcd_init[i].cmd, st77922_lcd_init[i].data, st77922_lcd_init[i].len);
        delay(st77922_lcd_init[i].delay_ms);
    }
	LCD_BL_HIGH;
}

void ST77922::Set_Rotation(uint8_t r)
{
	uint8_t value;
	rotation = r;
    switch(rotation)
    {
        case 0:
            value = (0<<3)|(0<<6);
			width = LCD_WIDTH;
            height = LCD_HEIGHT;
            break;
        case 1:
		case 3:
            value = 0;
			width = LCD_HEIGHT;
            height = LCD_WIDTH;
			break;
        case 2:
            value = (0<<3)|(1<<6)|(1<<7);
			width = LCD_WIDTH;
            height = LCD_HEIGHT;
            break;
        default:
            break;
    }
    Write_Reg(MADCTL_CMD, &value, 1);
}

uint8_t ST77922::Get_Rotation(void)
{
	return rotation;
}

void ST77922::Set_Windows(uint16_t sx, uint16_t sy, uint16_t ex, uint16_t ey)
{
	uint8_t x_data[] = {
        (uint8_t)(sx >> 8), 
        (uint8_t)(sx & 0xFF), 
        (uint8_t)((ex - 1) >> 8), 
        (uint8_t)((ex - 1) & 0xFF)
    };
    Write_Reg(SET_X_CMD, x_data, 4);

    // 修改 Y 坐标部分
    uint8_t y_data[] = {
        (uint8_t)(sy >> 8), 
        (uint8_t)(sy & 0xFF), 
        (uint8_t)((ey - 1) >> 8), 
        (uint8_t)((ey - 1) & 0xFF)
    };
    Write_Reg(SET_Y_CMD, y_data, 4);
}

void ST77922::Fill_Colors(uint16_t sx, uint16_t sy, uint16_t w, uint16_t h, uint16_t* color)
{
	bool flag = true;
    size_t tx_len;
	uint16_t* cbuf = nullptr;
	uint16_t* tx_buf = nullptr;
    uint16_t i, j, tmp;
    spi_transaction_ext_t espit = {0};
	size_t total = 0;
    if((sx >= width) || (sy >= height))
        return;
    if(((sx + w) > width) || ((sy + h) > height))
        return;
    if(((w < 1) || (w > width)) || ((h < 1) || (h > height)))
        return;
	if((rotation == 1)||(rotation == 3))
    {
        cbuf = (uint16_t *)ps_malloc(sizeof(uint16_t)*w*h);
		if(cbuf == nullptr)
		{
			return;
		}
        for(i = sy; i<sy + h; i++)
        {
            for(j = sx; j<sx + w; j++)
            {
                if(rotation == 1)
                {
                    *(cbuf + j*h + (h-i-1)) = *(color + i*w + sx + j);
                }
                else
                {
                    *(cbuf + (w - j -1)*h + i) = *(color + i*w + sx + j);
                }
            }
        }
		tx_buf = cbuf;
        tmp = sx;
        sx = sy;
        sy = tmp;
        tmp = w;
        w = h;
        h = tmp;
    }
    else
    {
        tx_buf = color;
    }
	total = w*h;
	Set_Windows(sx, sy, sx + w, sy + h);    
    LCD_CS_LOW;
     do
     {
         if(flag)
        {
            espit.base.flags = (SPI_TRANS_MODE_QIO | SPI_TRANS_VARIABLE_CMD | SPI_TRANS_VARIABLE_ADDR);
            espit.base.cmd = QSPI_4W_CMD;
            espit.base.addr = WR_RAM_C_CMD << 8;
            espit.command_bits = 8;
            espit.address_bits = 24;
            flag = false;
        }
        else
        {
            espit.base.flags = (SPI_TRANS_MODE_QIO | SPI_TRANS_VARIABLE_CMD | SPI_TRANS_VARIABLE_ADDR | SPI_TRANS_VARIABLE_DUMMY);
        }
        tx_len = (total>TX_LEN)?TX_LEN:total;
        espit.base.tx_buffer = tx_buf;
        espit.base.length = tx_len * 16;
        spi_device_polling_transmit(qspi, (spi_transaction_t *)&espit);
        total -= tx_len;
        tx_buf += tx_len;
  }while(total>0);
  LCD_CS_HIGH;
  if((rotation == 1)||(rotation == 3))
  {
  	if(cbuf != nullptr)
  	{
      free(cbuf);
	  cbuf = nullptr;
  	}
  }
}

uint16_t ST77922::Get_Width(void)
{
	return width;
}

uint16_t ST77922::Get_Height(void)
{
	return height;
}


