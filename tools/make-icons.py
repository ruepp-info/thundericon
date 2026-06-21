#!/usr/bin/env python3
"""Generate Thundericon's PNG icons (no external deps).

Draws the add-on's own avatar badge as the icon: a soft, low-saturation
dark-green circle with white "TI" initials (the same look the renderer gives a
sender in its "soft hue" color mode). Letterforms are drawn geometrically and
supersampled for smooth edges, so no font library is needed. Run from anywhere:
`python3 tools/make-icons.py`.
"""
import os
import struct
import zlib

def hsl_to_rgb(h, s, l):
    """HSL (h in degrees, s/l in percent) -> (r, g, b) 0-255.

    Mirrors avatar-core.js's hslToHex, so the icon color comes from the same
    formula as the renderer's "soft hue, low saturation" color mode.
    """
    s /= 100.0
    l /= 100.0

    def k(n):
        return (n + h / 30.0) % 12

    a = s * min(l, 1 - l)

    def f(n):
        return l - a * max(-1, min(k(n) - 3, min(9 - k(n), 1)))

    return tuple(int(round(255 * f(n))) for n in (0, 8, 4))


# Badge fill: the add-on's "soft hue, low saturation" look, dialed to a dark
# green. Tweak this HSL triple (hue°, saturation%, lightness%) to recolor.
BADGE = hsl_to_rgb(145, 32, 36)
WHITE = (0xFF, 0xFF, 0xFF)
SIZES = (16, 32, 48, 64, 128)
SS = 4  # supersampling factor for anti-aliasing

# "TI" letterform geometry, in the normalized 0..1 icon square. Cap height runs
# TOP..BOT; STROKE is the bar/stem thickness. The two letters are centered as a
# pair inside the circle.
TOP = 0.29
BOT = 0.71
STROKE = 0.11
T_X0, T_X1 = 0.225, 0.515   # "T": full top bar span; stem centered within it
I_X0, I_X1 = 0.585, 0.775   # "I": serif span (top & bottom bars); stem centered

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")


def _rect(px, py, x0, y0, x1, y1):
    return x0 <= px <= x1 and y0 <= py <= y1


def coverage(px, py):
    """Return (inside_bg, inside_glyph) booleans for a normalized point."""
    # Background avatar circle.
    in_bg = (px - 0.5) ** 2 + (py - 0.5) ** 2 < 0.47 ** 2
    if not in_bg:
        return False, False
    t_cx = (T_X0 + T_X1) / 2
    i_cx = (I_X0 + I_X1) / 2
    glyph = (
        # "T": top bar + centered vertical stem.
        _rect(px, py, T_X0, TOP, T_X1, TOP + STROKE) or
        _rect(px, py, t_cx - STROKE / 2, TOP, t_cx + STROKE / 2, BOT) or
        # "I": top serif + bottom serif + centered vertical stem.
        _rect(px, py, I_X0, TOP, I_X1, TOP + STROKE) or
        _rect(px, py, I_X0, BOT - STROKE, I_X1, BOT) or
        _rect(px, py, i_cx - STROKE / 2, TOP, i_cx + STROKE / 2, BOT)
    )
    return True, glyph


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
                # Blend the white glyph over slate, alpha from bg coverage.
                si = si_hits / total
                bgc = (bg_hits - si_hits) / total
                cover = bg_hits / total
                rr = (WHITE[0] * si + BADGE[0] * bgc)
                gg = (WHITE[1] * si + BADGE[1] * bgc)
                bb = (WHITE[2] * si + BADGE[2] * bgc)
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
