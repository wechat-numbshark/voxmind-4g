#!/bin/sh
set -eu
firmware_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/voxmind-host-tests.XXXXXX")
trap 'rm -f "$test_dir/ui-test" "$test_dir/protocol-test" "$test_dir/cellular-test" "$test_dir/cellular-settings-test" "$test_dir/cjson.o"; rmdir "$test_dir"' EXIT HUP INT TERM
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  "$firmware_dir/components/ui/ui_logic.c" "$firmware_dir/components/ui/tests/ui_logic_test.c" -o "$test_dir/ui-test"
"$test_dir/ui-test"
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  "$firmware_dir/components/app_cloud/tests/runtime_protocol_test.c" -o "$test_dir/protocol-test"
"$test_dir/protocol-test"
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I "$firmware_dir/components/app_cloud/include" \
  "$firmware_dir/components/app_cloud/cellular_profile.c" \
  "$firmware_dir/components/app_cloud/tests/cellular_profile_test.c" -o "$test_dir/cellular-test"
"$test_dir/cellular-test"
cjson_dir="$firmware_dir/managed_components/espressif__cjson/cJSON"
# Apple's SDK deprecates sprintf used by the upstream cJSON library. Suppress
# that warning only for third-party code; keep -Werror for the settings adapter.
cc -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -fsanitize=address,undefined \
  -I "$cjson_dir" -c "$cjson_dir/cJSON.c" -o "$test_dir/cjson.o"
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I "$firmware_dir/components/app_cloud/tests/host" \
  -I "$firmware_dir/components/app_cloud/include" -I "$cjson_dir" \
  "$firmware_dir/components/app_cloud/cellular_profile.c" \
  "$firmware_dir/components/app_cloud/cellular_settings.c" \
  "$firmware_dir/components/app_cloud/tests/cellular_settings_test.c" \
  "$test_dir/cjson.o" -o "$test_dir/cellular-settings-test"
"$test_dir/cellular-settings-test"
