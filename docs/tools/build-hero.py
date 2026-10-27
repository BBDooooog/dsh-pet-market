from PIL import Image, ImageDraw, ImageFont
import pathlib

root = pathlib.Path(r"D:\AI\dsh\dsh-pet-market")
cat = Image.open(root / "demo/packs/pixel-cat/animations/cat.png").convert("RGBA")
dog = Image.open(root / "demo/packs/yellow-dog/animations/dog.png").convert("RGBA")
cell = (40, 34)
cat_idle = cat.crop((0, 0, *cell))
dog_idle = dog.crop((0, 0, *cell))

W, H = 1280, 400
hero = Image.new("RGBA", (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(hero)
top, bottom = (18, 22, 40), (58, 44, 92)
for y in range(H):
    t = y / (H - 1)
    draw.line([(0, y), (W, y)], fill=(int(top[0]+(bottom[0]-top[0])*t), int(top[1]+(bottom[1]-top[1])*t), int(top[2]+(bottom[2]-top[2])*t), 255))

def paste_scaled(sprite, scale, xy):
    hero.alpha_composite(sprite.resize((sprite.width*scale, sprite.height*scale), Image.NEAREST), xy)

paste_scaled(cat_idle, 5, (140, 160))
paste_scaled(dog_idle, 4, (1010, 190))

font_path = r"C:\Windows\Fonts\msyh.ttc"
draw.text((380, 118), "宠物乐园", font=ImageFont.truetype(font_path, 64), fill=(255, 255, 255, 255))
draw.text((382, 210), "DSH 桌宠市场 · 序列帧宠物包 · 系统桌面画家", font=ImageFont.truetype(font_path, 26), fill=(206, 214, 240, 255))
draw.text((382, 252), "任何作者都能发布宠物，市场只认格式，不认内容", font=ImageFont.truetype(font_path, 26), fill=(152, 164, 198, 255))
hero.convert("RGB").save(root / "docs/assets/hero.png")
print("hero saved", hero.size)

