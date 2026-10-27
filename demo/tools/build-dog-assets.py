"""Paint a yellow pixel dog sprite sheet for the demo pack.

Everything is drawn on a 20x17 logical grid and scaled 2x with nearest-neighbour,
so the frames stay chunky like the CC0 cat demo. Output:
  demo/packs/yellow-dog/animations/dog.png      (3 rows x 6 cols, 40x34 cells)
  demo/packs/yellow-dog/thumbnail.png
"""

from pathlib import Path

from PIL import Image

LOGICAL_W, LOGICAL_H = 20, 17
CELL_W, CELL_H = 40, 34
SCALE = 2
COLS = 6
ROWS = 3

BODY = (232, 184, 75, 255)
BODY_DARK = (198, 148, 52, 255)
BELLY = (248, 224, 160, 255)
EAR = (168, 118, 40, 255)
DARK = (44, 34, 24, 255)
NOSE = (28, 20, 14, 255)
COLLAR = (214, 72, 72, 255)
TOOTH = (255, 255, 255, 255)
TONGUE = (226, 108, 118, 255)


def canvas():
    return Image.new("RGBA", (LOGICAL_W, LOGICAL_H), (0, 0, 0, 0))


def rect(img, x, y, w, h, color):
    for yy in range(y, y + h):
        for xx in range(x, x + w):
            if 0 <= xx < LOGICAL_W and 0 <= yy < LOGICAL_H:
                img.putpixel((xx, yy), color)


def dog(frame, phase, tail, bob, run=False, tongue=False):
    """Draw one dog pose. phase 0..5 drives the leg cycle."""
    top = 1 + bob
    # tail: raised, wagging with `tail` in -1..1
    tx = 4
    rect(frame, tx, 6 + top + max(0, tail), 2, 3, BODY)
    rect(frame, tx - 1, 4 + top + max(0, tail), 2, 3, BODY_DARK)
    rect(frame, tx - 2, 3 + top + max(0, tail), 1, 2, BODY_DARK)

    # body
    rect(frame, 5, 7 + top, 11, 5, BODY)
    rect(frame, 5, 11 + top, 11, 1, BELLY)
    rect(frame, 15, 7 + top, 2, 5, BODY_DARK)

    # collar
    rect(frame, 14, 7 + top, 2, 4, COLLAR)

    # head
    rect(frame, 13, 4 + top, 6, 5, BODY)
    rect(frame, 16, 7 + top, 4, 2, BELLY)
    # floppy ear
    rect(frame, 13, 4 + top, 2, 4, EAR)
    rect(frame, 12, 6 + top, 1, 3, EAR)
    # eye + nose
    rect(frame, 16, 5 + top, 1, 1, DARK)
    rect(frame, 19, 7 + top, 1, 1, NOSE)
    if tongue:
        rect(frame, 18, 9 + top, 1, 2, TONGUE)

    # legs: two front, two back, alternating by phase
    swing = [0, 1, 2, 1, 0, -1][phase % 6]
    if run:
        swing *= 2
    base_y = 12 + top
    # back legs
    rect(frame, 6 + max(0, swing), base_y, 2, 3 - min(2, abs(swing)), BODY_DARK)
    rect(frame, 9 - min(0, swing), base_y, 2, 3 - min(2, abs(swing)), BODY)
    # front legs
    rect(frame, 12 + max(0, swing), base_y, 2, 3 - min(2, abs(swing)), BODY)
    rect(frame, 15 - min(0, swing), base_y, 2, 3 - min(2, abs(swing)), BODY_DARK)

    # paws
    foot_y = base_y + 3 - min(2, abs(swing))
    for leg_x in (6, 9, 12, 15):
        rect(frame, leg_x, foot_y, 2, 1, NOSE if foot_y < LOGICAL_H - 1 else NOSE)

    # a single tooth when the mouth is open
    if tongue:
        rect(frame, 17, 8 + top, 1, 1, TOOTH)


def build_atlas():
    atlas = Image.new("RGBA", (CELL_W * COLS, CELL_H * ROWS), (0, 0, 0, 0))
    poses = []
    # row 0: idle, two frames, tail wag + breathing bob
    poses.append([(0, -1, 0, False, False), (0, 1, 1, False, False)])
    # row 1: walk, six frames
    poses.append([(phase, 1 if phase % 2 else -1, phase % 2, False, False) for phase in range(6)])
    # row 2: run, six frames, tongue out
    poses.append([(phase, 1 if phase % 2 else -1, phase % 2, True, True) for phase in range(6)])

    for row, row_poses in enumerate(poses):
        for col, pose in enumerate(row_poses):
            frame = canvas()
            dog(frame, *pose)
            enlarged = frame.resize((CELL_W, CELL_H), Image.NEAREST)
            atlas.paste(enlarged, (col * CELL_W, row * CELL_H), enlarged)
    return atlas


def main():
    root = Path(__file__).resolve().parent.parent
    pack = root / "packs" / "yellow-dog"
    (pack / "animations").mkdir(parents=True, exist_ok=True)
    atlas = build_atlas()
    atlas.save(pack / "animations" / "dog.png")
    thumb = atlas.crop((0, 0, CELL_W, CELL_H)).resize((CELL_W * 4, CELL_H * 4), Image.NEAREST)
    thumb.save(pack / "thumbnail.png")
    print({"atlas": list(atlas.size), "frame": [CELL_W, CELL_H], "pack": str(pack)})


if __name__ == "__main__":
    main()
