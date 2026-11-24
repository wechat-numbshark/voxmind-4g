#!/usr/bin/env bash
# 重新生成屏幕用字库，并在每个 .c 开头写上这次所用 OTF 的 name 表版权。
# 用法: ./gen_fonts.sh <放 NotoSansSC-Medium.otf 和 NotoSansSC-Bold.otf 的目录>
# 已入库的结果来自 notofonts/noto-cjk 提交
#   f8d157532fbfaeda587e826d4cd5b21a49186f7c
#   路径 Sans/SubsetOTF/SC/ 下的 Medium 与 Bold。哈希和版权见 README.md。
# 许可证正文：LICENSE-OFL.txt（与上游 Sans/LICENSE 的 OFL 1.1 正文一致）。
# 版权持有人在 OTF 的 name 表，不在该正文里。本脚本从你传入的文件读取，不写死年份。
#
# 字重不是随便选的：2 英寸 240x320 约 200 PPI，深色底上的浅色字会有视觉减重
# （optical weight loss），Regular 上机后发虚。正文用 Medium，标题用 Bold，
# 两档拉开层次；44px 那支只含数字，给录音计时和时钟做主视觉。
#
# 字符集：GB2312 一二级汉字 6763 个 + 全角标点/符号(A1、A3 区) + ASCII
# 依赖：node、npx、lv_font_conv@1.5.3、python3
set -euo pipefail
DIR=${1:?用法: gen_fonts.sh <放 NotoSansSC-*.otf 的目录>}
cd "$(dirname "$0")"
SYM=$(python3 - <<'PY'
chars = []
def row(hi):
    for lo in range(0xA1, 0xFF):
        try:
            chars.append(bytes([hi, lo]).decode('gb2312'))
        except UnicodeDecodeError:
            pass
for hi in (0xA1, 0xA3):
    row(hi)
for hi in range(0xB0, 0xF8):
    row(hi)
print(''.join(sorted(set(chars))), end='')
PY
)
conv() {
  local src="$1" size="$2" name="$3"
  shift 3
  local out="$PWD/$name.c"
  # 在字体目录里调用，Opts 行只留下文件名，不写本机临时路径。
  ( cd "$(dirname "$src")" && npx --yes lv_font_conv@1.5.3 \
      --font "$(basename "$src")" --size "$size" --bpp 4 --format lvgl \
      --lv-include lvgl.h --lv-font-name "$name" -o "$out" "$@" )
  python3 - "$out" "$src" "$name" <<'PY'
import hashlib, pathlib, struct, sys
out, src, symbol = sys.argv[1:]
data = pathlib.Path(src).read_bytes()
sha = hashlib.sha256(data).hexdigest()
num = struct.unpack(">H", data[4:6])[0]
name_off = name_len = None
for i in range(num):
    tag, _chk, off, length = struct.unpack(">4sIII", data[12+i*16:12+(i+1)*16])
    if tag == b"name":
        name_off, name_len = off, length
if name_off is None:
    raise SystemExit(f"no name table in {src}")
nt = data[name_off:name_off+name_len]
count, string_off = struct.unpack(">HH", nt[2:6])
found = {}
for i in range(count):
    plat, enc, lang, name_id, length, offset = struct.unpack(">HHHHHH", nt[6+i*12:6+(i+1)*12])
    if plat != 3 or lang != 0x409 or name_id not in (0, 5, 6, 7):
        continue
    raw = nt[string_off+offset:string_off+offset+length]
    found[name_id] = raw.decode("utf-16-be")
missing = [i for i in (0, 5, 6) if i not in found]
if missing:
    raise SystemExit(f"name IDs {missing} missing from {src}")
otf = pathlib.Path(src).name
header = (
    "/* SIL Open Font License, Version 1.1\n"
    f" * Bitmap font software derived from {otf}.\n"
    f" * SHA-256 of the OTF passed to lv_font_conv: {sha}\n"
    f" * name ID 0: {found[0]}\n"
    f" * name ID 5: {found[5]}\n"
    f" * name ID 6: {found[6]}\n"
    + (f" * name ID 7: {found[7]}\n" if 7 in found else "")
    + " * License text: LICENSE-OFL.txt beside this file.\n"
    f" * Firmware symbol: {symbol}. Do not present this derivative under the name Noto.\n"
    " */\n\n"
)
path = pathlib.Path(out)
path.write_text(header + path.read_text())
print(f"NOTICE {symbol} {otf} {sha} | {found[0]} | {found[5]}")
PY
}

conv "$DIR/NotoSansSC-Medium.otf" 16 font_cn_16  -r 0x20-0x7E --symbols "$SYM"
conv "$DIR/NotoSansSC-Bold.otf"   24 font_cn_24  -r 0x20-0x7E --symbols "$SYM"
conv "$DIR/NotoSansSC-Medium.otf" 44 font_num_44 --symbols "0123456789:%.- "
