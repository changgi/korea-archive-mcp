#!/usr/bin/env python3
"""어노테이션 좌표 잡기용 격자(10% 간격) 미리보기: python3 grid.py <이미지> <출력.jpg>"""
import sys
from PIL import Image, ImageDraw
im = Image.open(sys.argv[1]).convert('RGB'); im.thumbnail((900, 900)); d = ImageDraw.Draw(im); W, H = im.size
for i in range(1, 10):
    d.line([(W*i/10, 0), (W*i/10, H)], fill=(255, 0, 0)); d.line([(0, H*i/10), (W, H*i/10)], fill=(255, 0, 0))
    d.text((W*i/10+2, 2), str(i*10), fill=(255, 255, 0)); d.text((2, H*i/10+2), str(i*10), fill=(255, 255, 0))
im.save(sys.argv[2]); print(W, H)
