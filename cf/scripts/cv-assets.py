# Makes src/cvassets.ts: the font and icons the bot draws CV PDFs with.
# Run once; the output is committed. Needs Python with fontTools
# (pip install fonttools) and macOS's sips (for the icons).
#
#   python3 scripts/cv-assets.py <folder with Amiri-Regular/Bold/Italic.ttf>
#
# Amiri (SIL Open Font License 1.1, https://github.com/aliftype/amiri) is
# cut down to Latin letters - about 40 kB a style instead of 430 - and its
# glyph numbers and widths written out, so the Worker can lay text out and
# embed the font without reading font tables. The icons (scripts/cv-icons)
# become 48x48 grey images, already compressed for a PDF.
import base64, io, json, os, struct, subprocess, sys, tempfile, zlib
from fontTools.ttLib import TTFont
from fontTools import subset

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1]
OUT = os.path.join(HERE, "..", "src", "cvassets.ts")
UNI = list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + [
    0x2013, 0x2014, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E, 0x2022, 0x2024, 0x2026, 0x20AC, 0x2192]

fonts = {}
for style in ["Regular", "Bold", "Italic"]:
    f = TTFont(os.path.join(SRC, f"Amiri-{style}.ttf"))
    # Amiri draws . ( ) / [ ] … Arabic-style unless the text is shaped as Latin
    # (its "locl" rules for script latn): the Latin glyphs go straight in the
    # character map instead, as no shaping happens in the Worker.
    gsub = f["GSUB"].table
    latin = {}
    for fr in gsub.FeatureList.FeatureRecord:
        if fr.FeatureTag != "locl": continue
        for li in fr.Feature.LookupListIndex:
            for st in gsub.LookupList.Lookup[li].SubTable:
                m = getattr(st, "mapping", None) or getattr(getattr(st, "ExtSubTable", None), "mapping", None) or {}
                if "period" in m: latin.update(m)
    for t in f["cmap"].tables:
        if t.isUnicode():
            for c, n in list(t.cmap.items()):
                if n in latin: t.cmap[c] = latin[n]
    o = subset.Options(); o.layout_features = []; o.hinting = False; o.name_IDs = ["*"]; o.notdef_outline = True
    o.drop_tables += ["GSUB", "GPOS", "GDEF", "DSIG"]
    s = subset.Subsetter(o); s.populate(unicodes=UNI); s.subset(f)
    buf = io.BytesIO(); f.save(buf); data = buf.getvalue()
    f = TTFont(io.BytesIO(data))
    k = 1000 / f["head"].unitsPerEm
    order = f.getGlyphOrder(); hmtx = f["hmtx"]; head = f["head"]
    # "code:glyph:width" for each character, in one string
    table = ",".join(f"{c}:{order.index(n)}:{round(hmtx[n][0] * k)}" for c, n in sorted(f.getBestCmap().items()))
    fonts[style] = dict(name=f"Amiri-{style}", data=base64.b64encode(data).decode(), table=table,
        ascent=round(f["hhea"].ascent * k), descent=round(f["hhea"].descent * k), cap=round(f["OS/2"].sCapHeight * k),
        bbox=[round(head.xMin * k), round(head.yMin * k), round(head.xMax * k), round(head.yMax * k)],
        italic=f["post"].italicAngle)

icons = {}
with tempfile.TemporaryDirectory() as tmp:
    for n in ["pin", "mail", "phone", "github", "linkedin", "ext"]:
        bmp = os.path.join(tmp, f"{n}.bmp")
        subprocess.run(["sips", "-s", "format", "bmp", "-z", "48", "48", os.path.join(HERE, "cv-icons", f"{n}.png"), "--out", bmp],
                       check=True, capture_output=True)
        b = open(bmp, "rb").read()
        off = struct.unpack("<I", b[10:14])[0]; w, h = struct.unpack("<ii", b[18:26]); bpp = struct.unpack("<H", b[28:30])[0]
        assert bpp == 32, f"{n}: {bpp} bits a pixel"
        rows = [b[off + y * w * 4: off + (y + 1) * w * 4] for y in range(abs(h))]
        if h > 0: rows.reverse()                                   # bottom-up bitmap
        grey = bytearray()
        for r in rows:
            for x in range(w):
                bl, g, rd, a = r[x * 4: x * 4 + 4]
                lum = (rd * 299 + g * 587 + bl * 114) // 1000
                grey.append(255 - a * (255 - lum) // 255)          # on white
        icons[n] = dict(w=w, h=abs(h), data=base64.b64encode(zlib.compress(bytes(grey), 9)).decode())

with open(OUT, "w") as out:
    out.write("// Made by scripts/cv-assets.py - don't edit. Amiri (c) The Amiri Project Authors,\n"
              "// SIL Open Font License 1.1 (scripts/cv-fonts-OFL.txt), cut down to Latin.\n")
    out.write(f"export const CV_FONTS = {json.dumps(fonts)} as const;\n")
    out.write(f"export const CV_ICONS = {json.dumps(icons)} as const;\n")
print("wrote", OUT, os.path.getsize(OUT), "bytes")
