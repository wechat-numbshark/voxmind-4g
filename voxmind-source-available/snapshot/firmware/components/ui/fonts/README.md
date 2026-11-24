# UI fonts

`font_cn_16.c`, `font_cn_24.c`, and `font_num_44.c` in this directory were
generated here from these two files:

| File | SHA-256 | name ID 0 | name ID 5 |
| --- | --- | --- | --- |
| `NotoSansSC-Medium.otf` | `7633f5a016d4dd95e685a69633d818aabc4644c4b08e26bd35b1b30c45ed5dda` | © 2014-2021 Adobe (http://www.adobe.com/). | Version 2.004;hotconv 1.0.118;makeotfexe 2.5.65603 |
| `NotoSansSC-Bold.otf` | `c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0` | © 2014-2021 Adobe (http://www.adobe.com/). | Version 2.004;hotconv 1.0.118;makeotfexe 2.5.65603 |

Source: `notofonts/noto-cjk` commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`, path `Sans/SubsetOTF/SC/`. The bytes were downloaded from that commit and the SHA-256 values above were checked before `gen_fonts.sh` ran. `lv_font_conv` 1.5.3 wrote the bitmaps. The script then copied name IDs 0, 5, 6, and 7 from the same file into the top of each `.c`.

`font_cn_16` and `font_num_44` use Medium. `font_cn_24` uses Bold. The name ID 0 string does not declare a Reserved Font Name. name ID 7 says: Noto is a trademark of Google Inc. The firmware symbols are `font_cn_16`, `font_cn_24`, and `font_num_44`.

`LICENSE-OFL.txt` matches upstream `Sans/LICENSE` at that commit (SHA-256 `6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2`). That file is the OFL 1.1 text and has no copyright-holder line. The copyright line is the name ID 0 string above.

SHA-256 of the `.c` files after the notice header:

| File | SHA-256 |
| --- | --- |
| `font_cn_16.c` | `f1e82e895b73c2ed8f34162c30a48a4cfda6757bca4a8ec3372da2e0f0ecdec5` |
| `font_cn_24.c` | `1641cdf0d79b27f1c1bd72c61aac48ac36b0f26897e597e2740f9506c8b5132e` |
| `font_num_44.c` | `04239b712e34babe3d32b692ab8ca982db52b57a29b041bd534fed859fa29e26` |

To regenerate, download those two OTFs from that commit, check the hashes, and run `./gen_fonts.sh /path/to/the/directory`. The script reads the copyright from the files you pass. It does not embed a guessed year. The OFL still applies: do not sell the font software by itself, and keep it under the OFL.

This source tree does not include a firmware `.bin`. Building the ESP-IDF image still downloads `managed_components/`, including `esp_audio_codec` and LVGL. That later binary is a separate distribution. See `docs/COMPLIANCE.md`.
