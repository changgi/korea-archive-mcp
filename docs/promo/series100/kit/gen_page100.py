#!/usr/bin/env python3
"""100선(031~130) 페이지 → docs/series100.html + thumbs/(표지 640·띠 200). 시리즈 폴더의 plan.json·카드만으로 생성."""
import json, html, re, pathlib, glob
from PIL import Image
S = pathlib.Path(__file__).resolve().parent.parent  # series100/
DOCS = S.parent.parent
E = html.escape
ex = (DOCS / 'examples.html').read_text(encoding='utf-8')
css = re.search(r'<style>(.*?)</style>', ex, re.S).group(1) + '''
.grid30{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:22px;margin-top:26px}
.it{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;display:flex;flex-direction:column;min-width:0}
.it>a>img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:#111}
.it .b{padding:16px 18px 18px;display:flex;flex-direction:column;gap:8px;min-width:0}
.it .inst{font-size:.85rem;color:var(--accent);font-weight:800}
.it h3{font-size:1.05rem;line-height:1.45;color:var(--ink)}
.it .q{background:var(--blue-bg);color:#123c7a;border-radius:12px 12px 12px 4px;padding:8px 12px;font-weight:700;font-size:.93rem}
.it ul{list-style:none;font-size:.88rem;line-height:1.55}.it li{border-top:1px dashed var(--line);padding:5px 0;overflow-wrap:anywhere}.it li b{color:#8a2a1f;margin-right:6px}
.strip{display:flex;gap:4px;flex-wrap:wrap}.strip a{width:calc(16.66% - 4px)}.strip img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:4px;display:block}
.lk{font-size:.85rem;display:flex;gap:14px;flex-wrap:wrap}.vid{display:inline-block;background:#8a2a1f;color:#fff;border-radius:6px;padding:1px 8px;font-size:.75rem;font-weight:800;margin-left:6px}
.parts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr));gap:10px;margin-top:26px}
.parts a{display:block;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;text-decoration:none;color:var(--ink);font-weight:700;font-size:.92rem}.parts a span{display:block;color:var(--muted);font-weight:500;font-size:.8rem}
'''
th = S / 'thumbs'; th.mkdir(exist_ok=True)
items = []
for d in sorted(glob.glob(str(S / 's[0-9][0-9][0-9]'))):
    d = pathlib.Path(d); pj = d / 'plan.json'
    if not pj.exists() or d.name == 's000': continue
    P = json.loads(pj.read_text(encoding='utf-8')); n = int(P['n'])
    cards = sorted(d.glob(f'{n:03d}_*.jpg'))
    if not cards: continue
    for k, c in enumerate(cards):
        t = th / f'{c.stem}.jpg'
        if not t.exists() or t.stat().st_mtime < c.stat().st_mtime:
            im = Image.open(c).convert('RGB'); im.thumbnail((640, 640) if k == 0 else (220, 220)); im.save(t, quality=80)
    items.append((n, P, cards))
parts = {}
for n, P, cards in items: parts.setdefault(tuple(P['part']), []).append((n, P, cards))
order = sorted(parts, key=lambda p: min(x[0] for x in parts[p]))
nav = ''.join(f'<a href="#p{min(x[0] for x in parts[p])}">{E(p[0])} {E(p[1])}<span>{min(x[0] for x in parts[p]):03d}–{max(x[0] for x in parts[p]):03d}</span></a>' for p in order)
secs = []
for i, p in enumerate(order):
    arts = []
    for n, P, cards in sorted(parts[p]):
        rel = f'promo/series100/s{n:03d}'
        lis = ''.join(f'<li><b>{E(k)}</b>{E(v)}</li>' for k, v in P['facts'][:3])
        strip = ''.join(f'<a href="{rel}/{c.name}" target="_blank"><img loading="lazy" src="promo/series100/thumbs/{c.stem}.jpg" alt="{n:03d} {k}/{len(cards)}"></a>' for k, c in enumerate(cards, 1))
        vid = '<span class="vid">🎞 영상 해설</span>' if P.get('scenes') else ''
        arts.append(f'''<article class="it" id="s{n:03d}"><a href="{rel}/{cards[0].name}" target="_blank"><img loading="lazy" src="promo/series100/thumbs/{cards[0].stem}.jpg" alt="{E(P["inst"])} — {E(P["head"])}"></a>
<div class="b"><div class="inst">{n:03d} · {P["flag"]} {E(P["inst"])}{vid}</div><h3>{E(P["head"])}</h3><div class="q">"{E(P["say"])}"</div><ul>{lis}</ul>
<div class="strip">{strip}</div><div class="lk"><a href="{rel}/caption.txt" target="_blank">소개글(캡션)</a><a href="{E(P["link"])}" target="_blank" rel="noopener">원문 기록 ↗</a></div></div></article>''')
    secs.append(f'<section id="p{min(x[0] for x in parts[p])}" class="{"tint" if i % 2 else ""}"><div class="wrap"><p class="pill">{E(p[0])}부</p><h2 style="font-family:var(--serif);color:var(--ink);font-size:1.9rem;margin:12px 0 4px">{E(p[1])}</h2><div class="grid30">{"".join(arts)}</div></div></section>')
nv = sum(1 for _, P, _ in items if P.get('scenes'))
page = f'''<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>100선 탐방 — KOREA ARCHIVE 통합검색</title>
<meta name="description" content="수집처 30곳 전부가 나오는 신규 100개 시리즈 — 원본 이미지 캐러셀과 소개글 세트.">
<style>{css}</style></head><body>
<nav><div class="wrap"><a class="logo" href="index.html">KOREA ARCHIVE 통합검색</a><div class="links"><a href="index.html">소개</a><a href="series.html">30곳 탐방</a><a href="#p31">100선</a></div></div></nav>
<header class="hero"><div class="wrap narrow"><span class="pill">신규 100선 · 031~130</span>
<h1>100선 <em>탐방</em></h1>
<p class="sub">수집처 30곳 전부에서 찾은 기록 {len(items)}개 시리즈. 시리즈마다 <b>원본 이미지로 가득 찬 인스타그램 캐러셀</b>과 소개글이 한 세트입니다 — 원본 모음, 기록을 짚어 읽는 해설 이미지{f", 영상 기록 {nv}편의 장면 해설" if nv else ""}까지. 모든 결과는 실제 도구 호출과 기관 원문으로 확인했습니다.</p>
<div class="parts">{nav}</div></div></header>
{"".join(secs)}
<section class="final"><div class="wrap narrow" style="text-align:center;padding:60px 0"><p>권리 원칙: 공공누리 제4유형은 원형 그대로(글·필터 미적용) · 허가 대상 이미지는 미게재 · 포로·묘지·수형자 사진 제외 · 기관 차단은 우회하지 않음. 각 소개글에 출처·권리 근거.</p></div></section>
</body></html>'''
(DOCS / 'series100.html').write_text(page, encoding='utf-8')
print('series', len(items), 'video', nv, 'bytes', len(page.encode()))
