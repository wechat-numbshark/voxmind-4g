# Third-party compliance notes

This import inspected the files that are actually in the tree. It did not
download Espressif components or LVGL, and it did not build firmware.

## Original work

`LICENSE.md` applies only to original VoxMind material. It is a personal
non-commercial source-available license. It is not an OSI open-source
license, and it is not MIT, Apache-2.0, GPL, AGPL, CERN-OHL, or PolyForm
Noncommercial. The Chinese text of `LICENSE.md` controls if a translation
differs.

## Espressif `esp_audio_codec`

`firmware/components/codec_opus/idf_component.yml` depends on
`espressif/esp_audio_codec` `^2.4.1`. `firmware/dependencies.lock` pins
2.6.2. The manifest comment says the official codec is a prebuilt library,
source is not open, and the license allows use together with Espressif
chips. ESP32-S3 meets that condition. The same comment says the grant does
not extend to a non-Espressif product.

The codec itself is not in this repository. This source release does not
distribute it. A later firmware binary that links the prebuilt library
would be a distribution of that library, under whatever terms the
downloaded component actually carries. Those terms were not re-read from
a downloaded license file. Publishing that binary, including on an
ESP32-S3, is not cleared by this note. Using the library with a
non-Espressif MCU is outside the in-tree component comment.

## LVGL and frogfs (MPL-2.0)

`firmware/components/ui/idf_component.yml` depends on `lvgl/lvgl` `^9.2`
and `espressif/esp_lvgl_port` `^2.4`. LVGL's own code is widely distributed
under a permissive license. LVGL 9 also contains `frogfs`, which is
MPL-2.0.

frogfs source is not in this tree. This source release does not
distribute frogfs. If someone later distributes a firmware binary that
includes frogfs object code, MPL-2.0 usually requires that the
corresponding MPL source files be made available. That obligation does not
by itself convert the original VoxMind firmware into an MPL work.

No firmware image was built here, and no MPL source bundle was assembled.
A future binary is not already compliant because this source tree exists.

## Fonts (OFL-1.1)

`font_cn_16.c`, `font_cn_24.c`, and `font_num_44.c` were regenerated from
the Noto Sans SC Medium and Bold subset OTFs at notofonts/noto-cjk commit
`f8d157532fbfaeda587e826d4cd5b21a49186f7c`. The SHA-256 of each input was
checked. The name-table copyright is © 2014-2021 Adobe
(http://www.adobe.com/). The version string is 2.004. `gen_fonts.sh`
copies that notice from the OTF it is given. `fonts/README.md` records
the hashes. `LICENSE-OFL.txt` matches upstream `Sans/LICENSE` and is the
OFL 1.1 text only.

The firmware names are `font_cn_16`, `font_cn_24`, and `font_num_44`.
The OFL still requires that the font software not be sold by itself and
that it stay under the OFL. An ESP-IDF firmware image was not built.

## Silero VAD

`cloud/models/silero_vad.onnx` is MIT, with `LICENSE-silero-vad.txt`.

## Other firmware components

`dependencies.lock` also pins `esp-sr`, `esp_modem`, `esp-dl`, `cjson`,
and related Espressif components. They are registry downloads. Their
license files arrive with `managed_components/`, which this release
excludes. A person who builds firmware should read those downloaded
notices. This import did not find a GPL or AGPL component vendored in
the snapshot. That is not a promise about future dependencies.

## Application packages

`cloud/package.json` lists runtime packages including Fastify, React, the
official Lark/Feishu Node SDK, ONNX Runtime, and others. They are not
relicensed. `node_modules/` is not committed.

## What is still unresolved

1. No firmware image was built. Distributing one is a separate act.
   MPL-2.0 source for frogfs was not prepared, and the prebuilt
   `esp_audio_codec` library was not downloaded. This source release does
   not make a future binary compliant.
2. `esp_audio_codec` terms were taken from the in-tree component comment
   and the lock pin, not from a freshly downloaded license file.
3. Nested licenses inside `esp-sr` model blobs were not reviewed because
   those blobs are not in the tree.
4. The Chinese UI bitmaps in this tree are the regenerated 2.004 outputs
   described above. Shipping a firmware binary is still a separate
   distribution.
5. Original hardware, firmware, website, and docs cannot be read as
   permissively licensed merely because a dependency is MIT, Apache-2.0,
   OFL, or MPL.
