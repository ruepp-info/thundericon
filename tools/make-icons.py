#!/usr/bin/env python3
"""Generate Thundericon's PNG icons (no external deps).

Draws a neutral slate avatar circle with a white person silhouette, supersampled
for smooth edges. Run from anywhere: `python3 tools/make-icons.py`.
"""
import os
import struct
import zlib

SLATE = (0x6B, 0x72, 0x80)   # neutral slate, matches the default palette
WHITE = (0xFF, 0xFF, 0xFF)
SIZES = (16, 32, 48, 64, 128)
SS = 4  # supersampling factor for anti-aliasing

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")


def coverage(px, py):
    """Return (inside_bg, inside_silhouette) booleans for a normalized point."""
    # Background avatar circle.
    in_bg = (px - 0.5) ** 2 + (py - 0.5) ** 2 < 0.47 ** 2
    if not in_bg:
        return False, False
    # Head.
    head = (px - 0.5) ** 2 + (py - 0.40) ** 2 < 0.165 ** 2
    # Shoulders: top arc of a large lower circle.
    shoulders = ((px - 0.5) ** 2 + (py - 1.06) ** 2 < 0.42 ** 2) and py > 0.60
    return True, (head or shoulders)


def render(size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            bg_hits = si_hits = total = 0
            # Supersample.
            for sy in range(SS):
                for sx in range(SS):
                    px = (x + (sx + 0.5) / SS) / size
                    py = (y + (sy + 0.5) / SS) / size
                    in_bg, in_si = coverage(px, py)
                    total += 1
                    if in_bg:
                        bg_hits += 1
                    if in_si:
                        si_hits += 1
            if bg_hits:
                # Blend silhouette over slate, alpha from bg coverage.
                si = si_hits / total
                bgc = (bg_hits - si_hits) / total
                cover = bg_hits / total
                rr = (WHITE[0] * si + SLATE[0] * bgc)
                gg = (WHITE[1] * si + SLATE[1] * bgc)
                bb = (WHITE[2] * si + SLATE[2] * bgc)
                # Normalize color by covered (non-transparent) fraction.
                norm = si + bgc or 1
                r = int(round(rr / norm))
                g = int(round(gg / norm))
                b = int(round(bb / norm))
                a = int(round(cover * 255))
            row += bytes((r, g, b, a))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0
        raw += row

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        rows = render(size)
        write_png(os.path.join(OUT, f"icon-{size}.png"), size, rows)
        print(f"wrote icons/icon-{size}.png")


if __name__ == "__main__":
    main()
