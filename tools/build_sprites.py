"""Cuts the generated art into sprites for Mallow and measures each one.

Reads the asset pack (PNG sheets + asset-manifest.json), crops every pose to its
visible pixels, scales it down to app size, and writes web/sprites/*.png plus
web/sprites/sprites.json with each sprite's size, feet point and head anchors.
Run:  python tools/build_sprites.py path/to/mallow-assets
"""
import json, sys
from pathlib import Path
from PIL import Image

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / "web" / "sprites"
OUT.mkdir(parents=True, exist_ok=True)
manifest = {a["file"]: a for a in json.loads((SRC / "asset-manifest.json").read_text())["assets"]}
meta = {}

NAMES = {
    "mallow-a.png": ["m-idle", "m-blink", "m-walk1", "m-walk2"],
    "mallow-b.png": ["m-run1", "m-run2", "m-wave", "m-cheer"],
    "mallow-c.png": ["m-sleep", "m-eat", "m-worried", "m-alert"],
    "mallow-d.png": ["m-read", "m-sip", "m-stretch", "m-dance"],
    "mallow-knight.png": ["k-ready", "k-swing", "k-victory", "k-polish"],
    "baby-gear.png": ["g-explorer", "g-hardhat", "g-goggles", "g-glasses", "g-cap", "g-guard", "g-scarf", "g-bandana", "g-knight"],
    "mallow-hats.png": ["h-party", "h-crown", "h-flowers", "h-bow", "h-beanie", "h-chef", "h-nightcap", None, None],
    "dragon.png": ["d-sleep", "d-awake", "d-fire", "d-dizzy"],
    "props.png": ["p-house", "p-bowl", "p-bottle", "p-plant", "p-clock", "p-beetle", "p-slime", "p-seed", "p-sign"],
}
for fur in ("ginger", "cream", "cocoa", "smoke"):
    NAMES[f"baby-{fur}.png"] = [f"b-{fur}-idle", f"b-{fur}-run", f"b-{fur}-wave", f"b-{fur}-sword"]
SINGLES = {"wheel.png": "wheel", "wheel-stand.png": "wheel-stand", "mallow-knight-helmet.png": "h-helmet", "app-icon.png": "icon", "mallow-ref.png": "m-ref"}
FACING = {"m-walk1": "left", "m-walk2": "left", "m-run1": "left", "m-run2": "left", "p-beetle": "left",
          **{f"b-{f}-run": "left" for f in ("ginger", "cream", "cocoa", "smoke")},
          **{n: "left" for n in ("d-sleep", "d-awake", "d-fire", "d-dizzy")}}
# how much to shrink each kind of art (characters are drawn ~500px tall; the app shows them ~120 units)
SCALE = {"d-": 1.0, "p-": 0.55, "wheel": 0.62, "icon": 0.4, "h-": 0.55, "g-": 0.5, "m-": 0.6, "k-": 0.6}


def scale_for(name):
    for k, v in SCALE.items():
        if name.startswith(k):
            return v
    return 0.5


def measure(im):
    """Head anchors from the alpha channel: where the top of the head is and how wide it is."""
    a = im.getchannel("A")
    w, h = im.size
    px = a.load()

    def row_span(y):
        xs = [x for x in range(w) if px[x, y] > 40]
        return (xs[0], xs[-1]) if xs else None

    band = [y for y in range(int(h * 0.02), int(h * 0.2))]
    tot = cnt = 0
    for y in band:
        for x in range(0, w, 2):
            if px[x, y] > 40:
                tot += x; cnt += 1
    head_x = tot / cnt if cnt else w / 2
    spans = [row_span(int(h * f)) for f in (0.3, 0.34, 0.38)]
    widths = [s[1] - s[0] for s in spans if s]
    head_w = max(widths) if widths else w * 0.8
    feet = row_span(h - 3) or (0, w)
    return {"headX": round(head_x, 1), "headW": round(head_w, 1), "feetX": round((feet[0] + feet[1]) / 2, 1)}


def save(name, im):
    bbox = im.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
    if not bbox:
        return
    im = im.crop(bbox)
    pad = 6
    canvas = Image.new("RGBA", (im.width + pad * 2, im.height + pad), (0, 0, 0, 0))
    canvas.paste(im, (pad, pad))                     # no padding under the feet, so the bottom edge is the floor
    s = scale_for(name)
    canvas = canvas.resize((max(1, round(canvas.width * s)), max(1, round(canvas.height * s))), Image.LANCZOS)
    canvas.save(OUT / f"{name}.png", optimize=True)
    m = {"w": canvas.width, "h": canvas.height, "facing": FACING.get(name, "front")}
    m.update(measure(canvas))
    meta[name] = m


for file, names in NAMES.items():
    sheet = Image.open(SRC / file).convert("RGBA")
    rects = [s["sourceRect"] for s in manifest[file]["sprites"]]
    for name, (x, y, w, h) in zip(names, rects):
        if name:
            save(name, sheet.crop((x, y, x + w, y + h)))
for file, name in SINGLES.items():
    save(name, Image.open(SRC / file).convert("RGBA"))
for room in ("day", "night", "knight"):
    Image.open(SRC / f"room-{room}.png").convert("RGB").save(OUT / f"room-{room}.jpg", quality=90, optimize=True, progressive=True)
    meta[f"room-{room}"] = dict(zip(("w", "h"), Image.open(SRC / f"room-{room}.png").size))
(OUT / "sprites.json").write_text(json.dumps(meta, indent=1))
print(len(meta), "sprites written to", OUT)
