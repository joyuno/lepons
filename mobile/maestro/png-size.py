"""png-size.py WxH[,WxH...] DIR -- fail unless every PNG under DIR is one of the sizes (and there is at least one)."""
import pathlib
import struct
import sys

allowed = {tuple(map(int, s.split("x"))) for s in sys.argv[1].split(",")}
pngs = sorted(pathlib.Path(sys.argv[2]).rglob("*.png"))
bad = 0
for p in pngs:
    w, h = struct.unpack(">II", p.read_bytes()[16:24])  # IHDR width, height
    ok = (w, h) in allowed
    bad += not ok
    print(f"{'ok ' if ok else 'BAD'} {w}x{h} {p}")
sys.exit(1 if bad or not pngs else 0)
