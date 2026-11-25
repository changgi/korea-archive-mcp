#!/usr/bin/env python3
"""어노테이션 좌표 잡기용 격자(10% 간격) 미리보기: python3 grid.py <이미지> <출력.jpg>"""
import sys
from PIL import Image, ImageDraw
im = Image.open(sys.argv[1]).convert('RGB'); im.thumbnail((900, 900)); d = ImageDraw.Draw(im); W, H = im.size
st = int(sys.argv[3]) if len(sys.argv) > 3 else 10  # 격자 간격(%) — 5 권장(정밀 배치)
for v in range(st, 100, st):
    d.line([(W*v/100, 0), (W*v/100, H)], fill=(255, 0, 0)); d.line([(0, H*v/100), (W, H*v/100)], fill=(255, 0, 0))
    d.text((W*v/100+2, 2), str(v), fill=(255, 255, 0)); d.text((2, H*v/100+2), str(v), fill=(255, 255, 0))
im.save(sys.argv[2]); print(W, H)
