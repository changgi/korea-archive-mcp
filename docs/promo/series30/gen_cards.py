#!/usr/bin/env python3
"""series.json → series_source.html (표지 1 + 예제 30장). 렌더: make_carousel.py"""
import json, html, re, pathlib
here = pathlib.Path(__file__).parent
d = json.loads((here / 'series.json').read_text(encoding='utf-8'))
src = (here.parent / 'singles' / 'singles_source.html').read_text(encoding='utf-8')
css = re.search(r'<style>(.*?)</style>', src, re.S).group(1)
css += '''
  .kick{font-size:24px; color:var(--gold); font-weight:900; letter-spacing:.14em; text-shadow:0 2px 8px #000;}
  .kick .no{display:inline-block; background:var(--crimson); color:#fff; padding:4px 14px; margin-right:12px; letter-spacing:.05em;}
  .inst{font-size:34px; font-weight:900; color:#fff; margin-top:12px; text-shadow:0 2px 10px #000; word-break:keep-all;}
  .bigv{font-size:118px; font-weight:900; line-height:1; color:var(--gold); text-shadow:0 8px 30px rgba(0,0,0,.9); word-break:keep-all; margin-top:10px;}
  .facts{margin-top:18px;}
  .facts div{font-size:25px; color:#eae3cf; line-height:1.45; text-shadow:0 2px 8px #000; word-break:keep-all;}
  .facts b{color:var(--gold); margin-right:10px;}
  .paper{position:absolute; left:76px; right:76px; z-index:5; background:#f4ecd8; color:#1d2128; padding:34px 40px 30px;
         box-shadow:0 24px 60px rgba(0,0,0,.75); border-top:14px solid #b3262f;
         background-image:repeating-linear-gradient(180deg, transparent 0 57px, rgba(80,110,170,.18) 57px 59px);}
  .paper .ph{display:flex; justify-content:space-between; align-items:flex-start; gap:20px;}
  .paper .pi{font-size:26px; font-weight:900; color:#6a4a1c; letter-spacing:.04em; word-break:keep-all;}
  .paper .pb{font-size:84px; font-weight:900; color:#b3262f; line-height:1; white-space:nowrap;}
  .paper .row{display:flex; gap:22px; border-top:1px dashed #b9ad92; padding:16px 0; font-size:29px; line-height:1.4;}
  .paper .row .k{flex:0 0 200px; font-family:Consolas,Menlo,monospace; font-weight:900; color:#8a2a1f; font-size:23px; padding-top:3px; word-break:keep-all;}
  .paper .row .v{flex:1; font-weight:700; word-break:keep-all;}
  .rstamp{position:absolute; right:110px; z-index:8; border:5px solid var(--crimson); color:var(--crimson); background:rgba(244,236,216,.92);
          font-weight:900; font-size:30px; padding:8px 20px; border-radius:10px; transform:rotate(-7deg); letter-spacing:.06em;}
  .tool{font-family:Consolas,Menlo,monospace; font-size:19px; color:#9fb4d8; margin-top:14px; text-shadow:0 2px 6px #000;}
'''
E = html.escape
def brand(n):
    return (f'<div class="brand" style="z-index:9; text-shadow:0 2px 8px #000;">KOREA ARCHIVE 통합검색 · <span style="color:#e8b45a;">30곳 탐방</span></div>'
            f'<div class="pageno" style="z-index:9; color:#e5ddc9; text-shadow:0 2px 8px #000;">{n:02d} / 30</div>')
cards = []
# 표지 — 원본 사진 9장 모자이크
imgs = [i['img'] for i in d['items'] if i.get('img')][:9]
cards.append('<div class="card"><div class="mosaic m33">' + ''.join(f'<img src="{{{{img:{p}|maxdim=420|q=78}}}}">' for p in imgs) + '</div>'
  '<div class="shade-top"></div>'
  '<div class="band" style="top:300px; text-align:center;"><div class="kick" style="letter-spacing:.3em;">KOREA ARCHIVE 통합검색 · 예제 시리즈</div>'
  '<div class="hl" style="font-size:96px; margin-top:8px;">30곳 문서고 <span class="g">탐방</span></div>'
  '<div style="font-size:32px; color:#e5ddc9; margin-top:10px; font-weight:700;">한 문장으로 여는 9개국 · 세계의 한국 기록</div>'
  '<div style="font-size:44px; margin-top:16px; letter-spacing:.2em;">🇺🇸 🇬🇧 🇫🇷 🇳🇱 🇯🇵 🇦🇺 🇳🇿 🇺🇳 🇪🇺 🇰🇷</div></div>'
  '<div class="foot"></div><div class="frame" style="z-index:7;"></div>'
  '<div class="cr">표지 사진: NARA·호주 전쟁기념관·국립중앙도서관·위키미디어 공용 — 모두 권리 실확인(A·PD·공공누리 1유형) · 상세는 출처 대장</div>'
  '<div class="brand" style="z-index:9; text-shadow:0 2px 8px #000;">KOREA ARCHIVE 통합검색 · <span style="color:#e8b45a;">밀어서 30곳 보기 →</span></div></div>')
for it in d['items']:
    n = it['n']
    part = next(p for p in d['parts'] if p[2] <= n <= p[3])
    kick = f'<div class="kick"><span class="no">{n:02d}</span>{E(part[0])} {E(part[1])}</div>'
    say = f'<div style="margin-top:16px;"><span class="say2">"{E(it["say"])}"</span></div>'
    if it.get('img'):
        fx = {'gray': 'filter:grayscale(1) contrast(1.1) brightness(.62);', 'dim': 'filter:contrast(1.05) brightness(.62);'}.get(it.get('imgfx'), '')
        facts = ''.join(f'<div><b>{E(k)}</b>{E(v)}</div>' for k, v in it['facts'][:2])
        lab = f'<div class="lab" style="right:60px; top:250px; font-size:21px;">{E(it["imglab"])}</div>' if it.get('imglab') else ''
        if it.get('imgmode') == 'page':
            bg = (f'<div style="position:absolute; inset:0; background:#14110c;"></div>'
                  f'<img src="{{{{img:{it["img"]}|q=95}}}}" style="position:absolute; right:84px; top:70px; height:560px; z-index:3; transform:rotate(2deg); border:6px solid #f3ead4; box-shadow:0 20px 50px rgba(0,0,0,.8); image-rendering:auto;">'
                  f'<div class="lab" style="right:96px; top:600px; font-size:20px; z-index:6;">지면 원본 · 국립중앙도서관 제공 이미지 그대로</div>')
        else:
            bg = f'<img class="bleed" src="{{{{img:{it["img"]}|maxdim=1200|q=82}}}}" style="{fx}"><div class="shade-top"></div>{lab}'
        cards.append(f'<div class="card">{bg}'
          f'<div class="topz">{kick}<div class="inst" style="{"max-width:500px;" if it.get("imgmode") == "page" else ""}">{it["flag"]} {E(it["inst"])}</div>{say}</div>'
          f'<div class="bottom" style="padding-bottom:128px !important;"><div class="hl" style="font-size:50px;">{E(it["head"])}</div>'
          f'<div class="bigv">{E(it["big"])}</div><div class="facts">{facts}</div></div>'
          f'<div class="foot"></div><div class="frame" style="z-index:7;"></div><div class="cr">{E(it["credit"])}</div>{brand(n)}</div>')
    else:
        rows = ''.join(f'<div class="row"><div class="k">{E(k)}</div><div class="v">{E(v)}</div></div>' for k, v in it['facts'])
        cards.append(f'<div class="card"><div style="position:absolute; inset:0; background:radial-gradient(circle at 30% 20%, #1c2230, #0a0c10 70%);"></div><div class="grain"></div>'
          f'<div class="col" style="padding:64px 76px 150px;">{kick}<div class="inst">{it["flag"]} {E(it["inst"])}</div>{say}'
          f'<div class="hl" style="font-size:46px; margin-top:24px;">{E(it["head"])}</div>'
          f'<div class="bigv" style="font-size:104px; margin-top:14px;">{E(it["big"])}</div>'
          f'<div class="paper" style="position:relative; left:auto; right:auto; margin-top:26px;"><div class="pi">조회 결과 · {E(d["checked"])} 실측 · <span style="font-family:Consolas,Menlo,monospace; font-size:21px; color:#3b5b8a;">{E(it["tool"])}</span></div>{rows}'
          f'<div class="rstamp" style="top:-34px; right:28px;">{E(it["stamp"])}</div></div></div>'
          f'<div class="frame" style="z-index:7;"></div><div class="cr">{E(it["credit"])}</div>{brand(n)}</div>')
out = f'<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="UTF-8">\n<title>30곳 문서고 탐방</title>\n<style>{css}</style>\n</head>\n<body>\n' + '\n\n'.join(cards) + '\n</body>\n</html>\n'
(here / 'series_source.html').write_text(out, encoding='utf-8')
print('cards', len(cards))
