idf_component_register(SRCS "main.c" "bringup.c"
                       INCLUDE_DIRS "."
                       REQUIRES board drv_modem drv_audio drv_storage drv_power
                                drv_input drv_feedback drv_display app_cloud nvs_flash esp_psram)
