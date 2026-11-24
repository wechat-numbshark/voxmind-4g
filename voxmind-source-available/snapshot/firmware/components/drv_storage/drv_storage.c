#include "drv_storage.h"
#include "board.h"
#include "driver/sdspi_host.h"
#include "driver/spi_common.h"
#include "sdmmc_cmd.h"
#include "esp_vfs_fat.h"
#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "storage";
static sdmmc_card_t *s_card = NULL;
#define SD_SPI_HOST   SPI2_HOST
#define OPUS_BITRATE  16000     /* bit/s，v3 需求定的编码码率 */

esp_err_t storage_init(void)
{
    spi_bus_config_t bus = {
        .mosi_io_num = PIN_SD_MOSI,
        .miso_io_num = PIN_SD_MISO,
        .sclk_io_num = PIN_SD_SCLK,
        .quadwp_io_num = -1, .quadhd_io_num = -1,
        .max_transfer_sz = 4096,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SD_SPI_HOST, &bus, SPI_DMA_CH_AUTO));

    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = SD_SPI_HOST;
    /* 首板 bring-up 先压到 10MHz 跑通，稳定后再往上抬到 20~40MHz 实测吞吐 */
    host.max_freq_khz = 10000;

    sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot.gpio_cs   = PIN_SD_CS;
    slot.host_id   = SD_SPI_HOST;

    esp_vfs_fat_sdmmc_mount_config_t mnt = {
        /* Only the factory bring-up image may initialize an empty chip.
         * A field mount failure must never erase cached recordings. */
#ifdef CONFIG_VOXMIND_BRINGUP_MODE
        .format_if_mount_failed = true,
#else
        .format_if_mount_failed = false,
#endif
        .max_files = 12,
        .allocation_unit_size = 16 * 1024,
    };
    esp_err_t e = esp_vfs_fat_sdspi_mount(STORAGE_MOUNT_POINT, &host, &slot, &mnt, &s_card);
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "挂载失败 (%s)。检查：① U9 是否贴反 ② R12/R13 上拉是否在位 "
                      "③ 降低 max_freq_khz 再试", esp_err_to_name(e));
        return e;
    }
    sdmmc_card_print_info(stdout, s_card);
    return ESP_OK;
}

esp_err_t storage_deinit(void)
{
    if (!s_card) return ESP_OK;
    esp_vfs_fat_sdcard_unmount(STORAGE_MOUNT_POINT, s_card);
    s_card = NULL;
    return spi_bus_free(SD_SPI_HOST);
}

esp_err_t storage_free_seconds(uint32_t *out_sec)
{
    if (!s_card || !out_sec) return ESP_ERR_INVALID_STATE;
    FATFS *fs; DWORD free_clusters;
    if (f_getfree("0:", &free_clusters, &fs) != FR_OK) return ESP_FAIL;
    uint64_t free_bytes = (uint64_t)free_clusters * fs->csize * fs->ssize;
    *out_sec = (uint32_t)(free_bytes * 8 / OPUS_BITRATE);
    return ESP_OK;
}
