# 用法: shot.py 输出.png [串口命令...]   先发这些命令（比如 "page b"），再截屏
import base64, serial, struct, sys, time, zlib
out = sys.argv[1]
s = serial.Serial("/dev/cu.usbmodem3101", 115200, timeout=0.3)
time.sleep(0.3); s.reset_input_buffer()
for cmd in sys.argv[2:]:
    s.write((cmd + "\n").encode()); time.sleep(0.6)
s.reset_input_buffer()
s.write(b"screenshot\n")
buf = b""; end = time.time() + 20
while time.time() < end and b"SHOT:END" not in buf:
    buf += s.read(65536)
rows = []
started = False
for line in buf.split(b"\n"):
    line = line.strip()
    i = line.find(b"SHOT:")
    if i < 0: continue
    body = line[i+5:]
    if body.startswith(b"BEGIN"): started = True; rows = []; continue
    if body in (b"END", b"FAIL"): break
    if started: rows.append(base64.b64decode(body))
W, H = 240, 320
print("rows", len(rows))
if len(rows) != H: sys.exit("截屏不完整")
raw = b""
for r in rows:
    raw += b"\x00"
    for x in range(W):
        v = r[2*x] | (r[2*x+1] << 8)                      # LVGL 原生小端 RGB565
        raw += bytes(((v >> 11 & 31) * 255 // 31, (v >> 5 & 63) * 255 // 63, (v & 31) * 255 // 31))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(out, "wb").write(png); print("saved", out)
