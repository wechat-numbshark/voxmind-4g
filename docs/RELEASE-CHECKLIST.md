# Release checklist

This branch prepares a private source-available tree. It does not publish
the repository, deploy a server, or send a public post.

## Done in this import

- [x] Software archive and both hardware parts verified, then extracted
- [x] v7 snapshot kept; power-off-drain kept beside it, not merged
- [x] 69 hardware files checked against the part manifest
- [x] Secret and identity scan before commit; replacements listed in
      `docs/SECURITY-FINDINGS.md`
- [x] Personal non-commercial license in Chinese, English, and Japanese
- [x] Third-party NOTICE and unresolved combinations written down
- [x] Enclosure v2 and the three author videos recorded as absent

## Required before this repository is made public

- [ ] If the removed production host, Feishu app id, or patch mailbox
      were ever live, rotate those credentials. This tree no longer
      contains them. Whether they were live was not re-checked here

## Required before anyone distributes a firmware binary

- [ ] Download `esp_audio_codec` and read its license file. The in-tree
      comment is not that file
- [ ] If the image contains frogfs, ship the corresponding MPL-2.0 source.
      This source tree does not (`docs/COMPLIANCE.md`)

## Done for the source tree

- [x] Published device id is the fictional `demo-voxmind-not-a-real-device`.
      Do not point a build at a real device or a production host
- [x] Chinese UI fonts regenerated from hash-checked Noto Sans SC 2.004,
      with that file's name-table copyright in each `.c` header
      (`fonts/README.md`)

## Optional missing assets

These are not code-security blockers. They were not invented.

- [ ] Verified WhatsApp or WeChat contact. None is known
- [ ] Enclosure v2 (staging notes: about 96.3 MB, 143 files)
- [ ] The three author videos
- This repository is the supplied source set, not the original working
  tree of about 9 GB

## Not done here, on purpose

- [ ] Firmware build (`idf.py`) — toolchain not run
- [ ] Hardware electrical, RF, or manufacturing check
- [ ] Merge to the default branch
- [ ] Visibility change
- [ ] Deploy
- [ ] Public demo with a real device or real audio
- [ ] X / social post
