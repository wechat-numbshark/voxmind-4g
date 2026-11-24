idf_component_register(SRCS "drv_display.c" INCLUDE_DIRS "include" REQUIRES board drv_power esp_lcd esp_driver_spi esp_driver_ledc esp_driver_gpio esp_driver_i2c heap esp_timer)
