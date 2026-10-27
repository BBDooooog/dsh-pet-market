# Turns the CC0 "Cat sprites" pack by Shepardskin (OpenGameArt) into the atlas
# used by the demo pet. Run once; the generated PNGs are committed so the pack
# build stays dependency free.
#
#   python demo/tools/build-assets.py
#
# Source: https://opengameart.org/content/cat-sprites  (CC0 1.0)

import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "assets", "cat_sprite", "cat sprite")
OUT = os.path.join(ROOT, "packs", "pixel-cat")

FRAME_W, FRAME_H = 40, 34
COLS = 6
ROWS = 3


def frames_of(path):
    anim = Image.open(path)
    out = []
    background = None
    for index in range(getattr(anim, "n_frames", 1)):
        anim.seek(index)
        frame = anim.convert("RGBA")
        if background is None:
            background = border_color(frame)
        out.append(key_out_background(frame, background))
    return out


def border_color(frame):
    """The GIF background is whatever colour sits on the border."""
    width, height = frame.size
    tally = {}
    for x in range(width):
        for y in (0, height - 1):
            tally[frame.getpixel((x, y))[:3]] = tally.get(frame.getpixel((x, y))[:3], 0) + 1
    for y in range(height):
        for x in (0, width - 1):
            tally[frame.getpixel((x, y))[:3]] = tally.get(frame.getpixel((x, y))[:3], 0) + 1
    return max(tally.items(), key=lambda item: item[1])[0]


def key_out_background(frame, rgb, tolerance=10):
    """GIF frames reuse palette entries for the background; key by colour."""
    pixels = frame.load()
    width, height = frame.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a and abs(r - rgb[0]) <= tolerance and abs(g - rgb[1]) <= tolerance and abs(b - rgb[2]) <= tolerance:
                pixels[x, y] = (0, 0, 0, 0)
    return frame


def place(canvas, image, col, row, frame_w=FRAME_W, frame_h=FRAME_H):
    x = col * frame_w + (frame_w - image.width) // 2
    y = row * frame_h + (frame_h - image.height)
    canvas.alpha_composite(image, (x, y))


def main():
    os.makedirs(os.path.join(OUT, "animations"), exist_ok=True)
    walk = frames_of(os.path.join(RAW, "catwalkx2.gif"))
    run = frames_of(os.path.join(RAW, "catrunx2.gif"))

    atlas = Image.new("RGBA", (COLS * FRAME_W, ROWS * FRAME_H), (0, 0, 0, 0))

    # idle: frame 0 of the walk cycle, twice, the second copy bobs down one pixel
    place(atlas, walk[0], 0, 0)
    bob = Image.new("RGBA", walk[0].size, (0, 0, 0, 0))
    bob.alpha_composite(walk[0], (0, 1))
    place(atlas, bob, 1, 0)

    for index, frame in enumerate(walk[:COLS]):
        place(atlas, frame, index, 1)
    for index, frame in enumerate(run[:COLS]):
        place(atlas, frame, index, 2)

    atlas.save(os.path.join(OUT, "animations", "cat.png"), optimize=True)

    thumb = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    place(thumb, walk[0], 0, 0, FRAME_W, FRAME_H)
    thumb.resize((FRAME_W * 4, FRAME_H * 4), Image.NEAREST).save(os.path.join(OUT, "thumbnail.png"), optimize=True)

    meta = {
        "atlas": atlas.size,
        "frame": [FRAME_W, FRAME_H],
        "walkFrames": len(walk),
        "runFrames": len(run),
        "source": "https://opengameart.org/content/cat-sprites (CC0, Shepardskin)",
    }
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
