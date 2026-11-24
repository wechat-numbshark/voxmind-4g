#!/bin/sh
# ESP-IDF export.sh supports bash/zsh. Invoke this script with bash.
set -eu
firmware_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$firmware_dir"
: "${IDF_PATH:?Source ESP-IDF export.sh first (set IDF_TOOLS_PATH for a custom tool install)}"
if ! rg -q '^CONFIG_VOXMIND_CLOUD_LAB_MODE=y$' sdkconfig; then
  echo 'Release requires the existing configured cloud firmware sdkconfig.' >&2
  exit 1
fi
if ! rg -q '^CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y$' sdkconfig; then
  echo 'Release requires OTA rollback support.' >&2
  exit 1
fi
if rg -q '^CONFIG_VOXMIND_PURGE_LEGACY_PCM=y$|^CONFIG_VOXMIND_DEVICE_API_KEY=".+"$' sdkconfig; then
  echo 'Release cannot contain a static device key or the destructive legacy-audio purge option.' >&2
  exit 1
fi
sh tools/test-host.sh
idf.py -B build-cloud-current build
python -m esptool --chip esp32s3 image_info build-cloud-current/voxmind.bin
