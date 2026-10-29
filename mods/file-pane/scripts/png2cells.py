#!/usr/bin/env python3
"""Downscale a PNG to a terminal cell grid for the file-pane mod.

Usage: png2cells.py image.png COLUMNS ROWS
Prints base64 of COLUMNS*ROWS little-endian u32 triplets [codepoint, fg, bg]:
each cell is an upper-half block whose foreground is the top pixel and
background the bottom one. Standard library only; interlaced PNGs are refused.
"""
import base64, hashlib, os, struct, sys, zlib

CACHE = "/tmp/file-pane"


def read_png(path):
    d = open(path, "rb").read()
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("not a PNG file")
    pos, idat, plte, trns = 8, [], b"", b""
    while pos < len(d):
        ln, typ = struct.unpack(">I4s", d[pos:pos + 8])
        body = d[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, bd, ct, _, _, il = struct.unpack(">IIBBBBB", body)
        elif typ == b"PLTE":
            plte = body
        elif typ == b"tRNS":
            trns = body
        elif typ == b"IDAT":
            idat.append(body)
        elif typ == b"IEND":
            break
    if il:
        raise SystemExit("interlaced PNGs are not supported")
    raw = zlib.decompress(b"".join(idat))
    chans = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    stride = (w * chans * bd + 7) // 8
    bpp = max(1, chans * bd // 8)
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        rows.append(line)
        prev = line
    return w, h, bd, ct, plte, trns, rows


def pixel_row(line, w, bd, ct, plte, trns):
    """One row as a flat list of r, g, b (alpha composited over white)."""
    out = []
    if bd == 16:
        line = line[0::2]
        bd = 8
    if bd < 8:
        per, mask = 8 // bd, (1 << bd) - 1
        idx = [(line[x // per] >> (8 - bd * (x % per + 1))) & mask for x in range(w)]
    elif ct in (0, 3):
        idx = list(line[:w])
    for x in range(w):
        if ct == 3:
            k = idx[x]
            r, g, b = plte[3 * k:3 * k + 3]
            a = trns[k] if k < len(trns) else 255
        elif ct == 0:
            v = idx[x] * (255 // ((1 << bd) - 1) if bd < 8 else 1)
            r = g = b = v
            a = 255
        elif ct == 4:
            r = g = b = line[2 * x]
            a = line[2 * x + 1]
        elif ct == 2:
            r, g, b = line[3 * x:3 * x + 3]
            a = 255
        else:
            r, g, b, a = line[4 * x:4 * x + 4]
        if a != 255:
            r, g, b = (r * a + 255 * (255 - a)) // 255, (g * a + 255 * (255 - a)) // 255, (b * a + 255 * (255 - a)) // 255
        out += (r, g, b)
    return out


def main():
    path, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.realpath(path)}:{st.st_mtime_ns}:{st.st_size}:{cols}:{rows}".encode()).hexdigest()
    cached = f"{CACHE}/cells-{key}.txt"
    if os.path.exists(cached):
        sys.stdout.write(open(cached).read())
        return
    w, h, bd, ct, plte, trns, lines = read_png(path)
    gw, gh = cols, rows * 2
    # Sum each target pixel's source block, row band by row band.
    sums = [[0, 0, 0, 0] for _ in range(gw * gh)]
    for y in range(h):
        ty = min(gh - 1, y * gh // h)
        px = pixel_row(lines[y], w, bd, ct, plte, trns)
        base = ty * gw
        for x in range(w):
            s = sums[base + min(gw - 1, x * gw // w)]
            s[0] += px[3 * x]
            s[1] += px[3 * x + 1]
            s[2] += px[3 * x + 2]
            s[3] += 1

    def rgb(i):
        r, g, b, n = sums[i]
        n = n or 1
        return ((r // n) << 16) | ((g // n) << 8) | (b // n)

    out = bytearray()
    for cy in range(rows):
        for cx in range(cols):
            out += struct.pack("<III", 0x2580, rgb(2 * cy * gw + cx), rgb((2 * cy + 1) * gw + cx))
    text = base64.b64encode(bytes(out)).decode()
    os.makedirs(CACHE, exist_ok=True)
    open(cached, "w").write(text)
    sys.stdout.write(text)


main()
