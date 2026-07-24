#include "ST77922_Touch.h"

ST77922_TOUCH::ST77922_TOUCH(void)
{
	width = TOUCH_WIDTH;
	height = TOUCH_HEIGHT;
	rotation = 0;
	max_points = 0;
    
    Wire.begin(TOUCH_SDA, TOUCH_SCL);
    Wire.setClock(I2C_SPEED);
}

void ST77922_TOUCH::init(void)
{
	uint8_t data;
	pinMode(TOUCH_RST, OUTPUT);
	digitalWrite(TOUCH_RST, HIGH);
 	pinMode(TOUCH_INT, INPUT);
	reset();
	do
	{
		Read_Data(STATUS, &data, 1);
	}while(data&0x0F);
	Read_Data(MAX_TOUCHES, &data, 1);
	max_points = data;
}

void ST77922_TOUCH::reset(void)
{
	TOUCH_RST_LOW;
	delay(100);
	TOUCH_RST_HIGH;
	delay(100);
}

void ST77922_TOUCH::Set_Rotation(uint8_t r)
{
	rotation = r;
	switch(rotation)
	{
		case 0:
		case 2:
			width = TOUCH_WIDTH;
			height = TOUCH_HEIGHT;
			break;
		case 1:
		case 3:
			width = TOUCH_HEIGHT;
			height = TOUCH_WIDTH;
			break;			
		default:
			break;
	}
}

void ST77922_TOUCH::Read_Data(uint16_t reg, uint8_t* rbuf, size_t rlen)
{
    Wire.beginTransmission(TOUCH_ADDR);
    Wire.write((uint8_t)((reg >> 8) & 0xFF));
    Wire.write((uint8_t)(reg & 0xFF));
    Wire.endTransmission(false);

    Wire.requestFrom((uint16_t)TOUCH_ADDR, (size_t)rlen);
    
    size_t i = 0;
    while (Wire.available() && i < rlen) {
        rbuf[i++] = Wire.read();
    }
}

bool ST77922_TOUCH::Get_Touch(void)
{
	bool result;
	uint8_t i = 0;
	uint8_t data[7*MAX_TOUCH_POINTS] = {0};
	uint8_t update = 0;
    
	Read_Data(TOUCH_INFO, &update, 1);
	if(update&0x08)
	{
		Read_Data(TOUCH_POINT0, data, 7*max_points);
		for(i=0; i<max_points; i++)
		{
			if(data[i*7]&0x80)
			{
				touch.id[i] = (data[i*7]&0x80)>>7;
				switch(rotation)
				{
					case 0:
						touch.x[i] = ((data[i*7]&0x3F)<<8) | data[i*7+1];
						touch.y[i] = ((data[i*7+2]&0x3F)<<8) | data[i*7+3];
						break;
					case 1:
						touch.x[i] = ((data[i*7+2]&0x3F)<<8) | data[i*7+3];
						touch.y[i] = height - (((data[i*7]&0x3F)<<8) | data[i*7+1]);
						break;
					case 2:
						touch.x[i] = width - (((data[i*7]&0x3F)<<8) | data[i*7+1]);
						touch.y[i] = height - (((data[i*7+2]&0x3F)<<8) | data[i*7+3]);
						break;
					case 3:
						touch.x[i] = width - (((data[i*7+2]&0x3F)<<8) | data[i*7+3]);
						touch.y[i] = ((data[i*7]&0x3F)<<8) | data[i*7+1];
						break;
					default:
					break;
				}
			}
		}
		result = true;
	}
	else
	{
		result = false;
	}
	return result;
}