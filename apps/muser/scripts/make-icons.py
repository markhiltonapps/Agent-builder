#!/usr/bin/env python3
"""Generates Muser's app icon: a blue rounded square with a white chat bubble and typing dots."""
from PIL import Image, ImageDraw
import os

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# gradient background clipped to a rounded square
grad = Image.new("RGBA", (S, S))
top, bot = (88, 160, 255), (10, 92, 214)
for y in range(S):
    t = y / (S - 1)
    c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
    ImageDraw.Draw(grad).line([(0, y), (S, y)], fill=c)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=230, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
d.rounded_rectangle([210, 250, 814, 654], radius=150, fill=(255, 255, 255, 255))
d.polygon([(330, 640), (330, 790), (470, 650)], fill=(255, 255, 255, 255))
for i, x in enumerate((372, 512, 652)):
    d.ellipse([x - 38, 452 - 38, x + 38, 452 + 38], fill=(10, 92, 214, 255 - i * 45))

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
img.save(os.path.join(root, "build", "icon.png"))
img.resize((256, 256), Image.LANCZOS).save(os.path.join(root, "src", "renderer", "icon.png"))
print("icons written")
