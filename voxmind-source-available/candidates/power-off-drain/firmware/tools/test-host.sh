#!/bin/sh
set -eu
firmware_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/voxmind-host-tests.XXXXXX")
trap 'rm -f "$test_dir/ui-test" "$test_dir/protocol-test" "$test_dir/battery-test"; rmdir "$test_dir"' EXIT HUP INT TERM
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  "$firmware_dir/components/ui/ui_logic.c" "$firmware_dir/components/ui/tests/ui_logic_test.c" -o "$test_dir/ui-test"
"$test_dir/ui-test"
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  "$firmware_dir/components/app_cloud/tests/runtime_protocol_test.c" -o "$test_dir/protocol-test"
"$test_dir/protocol-test"
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I "$firmware_dir/components/app_cloud/include" \
  "$firmware_dir/components/app_cloud/battery_logic.c" "$firmware_dir/components/app_cloud/tests/battery_logic_test.c" -o "$test_dir/battery-test"
"$test_dir/battery-test"
