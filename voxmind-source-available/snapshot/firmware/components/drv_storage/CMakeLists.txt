idf_component_register(SRCS "drv_storage.c" INCLUDE_DIRS "include"
                       REQUIRES board fatfs sdmmc esp_driver_spi)
