idf_component_register(SRCS "app_cloud.c" "ota.c" "runtime_diagnostics.c" "cellular_profile.c" "cellular_settings.c"
                       INCLUDE_DIRS "include"
                       REQUIRES board drv_audio drv_storage drv_feedback drv_display drv_power drv_modem drv_input
                                codec_opus ui esp_event esp_netif esp_http_client fatfs
                                mbedtls json nvs_flash esp_app_format esp_https_ota app_update esp_partition voice_cmd)
