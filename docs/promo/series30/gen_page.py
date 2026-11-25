#!/usr/bin/env python3
"""series.json → docs/series.html (GitHub Pages 30선 페이지) + caption/schedule/sources 텍스트."""
import json, html, re, pathlib
here = pathlib.Path(__file__).parent
docs = here.parent.parent
d = json.loads((here / 'series.json').read_text(encoding='utf-8'))
E = html.escape
ex = (docs / 'examples.html').read_text(encoding='utf-8')
css = re.search(r'<style>(.*?)</style>', ex, re.S).group(1)
css += '''
.parts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:10px;margin-top:26px}
.parts a{display:block;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;text-decoration:none;color:var(--ink);font-weight:700;font-size:.95rem}
.parts a span{display:block;color:var(--muted);font-weight:500;font-size:.8rem}
.grid30{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:22px;margin-top:26px}
.it{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;display:flex;flex-direction:column;min-width:0}
.it img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:#111}
.it .b{padding:16px 18px 18px;display:flex;flex-direction:column;gap:8px;min-width:0}
.it .inst{font-size:.85rem;color:var(--accent);font-weight:800}
.it h3{font-size:1.08rem;line-height:1.45;color:var(--ink)}
.it .q{background:var(--blue-bg);color:#123c7a;border-radius:12px 12px 12px 4px;padding:8px 12px;font-weight:700;font-size:.95rem;display:flex;gap:8px;align-items:center;justify-content:space-between}
.it .q button{border:1px solid #9bb6e0;background:#fff;border-radius:8px;font-size:.78rem;padding:3px 8px;cursor:pointer;white-space:nowrap}
.it ul{list-style:none;font-size:.9rem;line-height:1.55}
.it li{border-top:1px dashed var(--line);padding:5px 0;overflow-wrap:anywhere}
.it li b{color:#8a2a1f;margin-right:6px}
.it .tool{font-family:var(--mono);font-size:.78rem;color:var(--muted);overflow-wrap:anywhere}
.it .lk{font-size:.85rem;display:flex;gap:14px;flex-wrap:wrap}
.set{margin-top:6px}.set b{display:block;font-size:.85rem;color:var(--accent);margin-bottom:6px}.set a{display:inline-block;width:calc(20% - 4px);margin:0 4px 4px 0}.set img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:4px;display:block}
.status{background:#fff7e6;border:1px solid #f0d9a8;border-radius:12px;padding:16px 18px;margin-top:20px;font-size:.95rem}
'''
parts_nav = ''.join(f'<a href="#p{p[2]}">{E(p[0])} {E(p[1])}<span>{p[2]:02d}–{p[3]:02d}</span></a>' for p in d['parts'])
import sys as _s; _s.path.insert(0, str(docs / 'promo')); from card_desc import card_descs
V2PLAN = json.loads((docs / 'promo' / 'series30v2' / 'plan.json').read_text(encoding='utf-8'))
secs = []
for i, p in enumerate(d['parts']):
    items = [it for it in d['items'] if p[2] <= it['n'] <= p[3]]
    cards = []
    for it in items:
        lis = ''.join(f'<li><b>{E(k)}</b>{E(v)}</li>' for k, v in it['facts'])
        v2 = sorted((docs / 'promo' / 'series30v2' / 'build' / f'{it["n"]:02d}').glob('*.jpg'))
        _pl = V2PLAN.get(f'{it["n"]:02d}', {}); ds = card_descs(_pl, it['head'], it['say'], it['facts']) if _pl else []; ds = ds if len(ds) == len(v2) else [''] * len(v2)
        strip = ''.join(f'<a href="promo/series30v2/build/{it["n"]:02d}/{f.name}" data-d="{E(ds[k-1])}" target="_blank"><img loading="lazy" src="promo/series30v2/build/{it["n"]:02d}/{f.name}" alt="{it["n"]:02d} 캐러셀 {k}/{len(v2)}"></a>' for k, f in enumerate(v2, 1))
        zname = f'{it["n"]:02d}_' + it['inst'].split(' (')[0].replace('/', '·') + '.zip'
        setlink = f'<div class="set"><b>인스타 캐러셀 {len(v2)}장</b>{strip}</div><div class="lk"><a href="promo/series30v2/build/{it["n"]:02d}/caption.txt" target="_blank">소개글(캡션) 열기</a><a href="promo/series30v2/zip/{zname}" download><b>세트 내려받기(ZIP)</b></a></div>' if v2 else ''
        cover = f'promo/series30v2/build/{it["n"]:02d}/{v2[0].name}' if v2 else f'promo/series30/thumbs/s{it["n"]:02d}.jpg'
        cards.append(f'''<article class="it" id="s{it["n"]:02d}"><img loading="lazy" src="{cover}" alt="{E(it["inst"])} — {E(it["head"])} 카드">
<div class="b"><div class="inst">{it["n"]:02d} · {it["flag"]} {E(it["inst"])}</div><h3>{E(it["head"])}</h3>
<div class="q"><span id="sq{it["n"]}">{E(it["say"])}</span><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('sq{it["n"]}').textContent);this.textContent='복사됨 ✓'">복사</button></div>
<ul>{lis}</ul><div class="tool">{E(it["tool"])}</div>
<div class="lk"><a href="{E(it["link"])}" target="_blank" rel="noopener">원문 기록 열기 ↗</a><a href="promo/series30/s{it["n"]:02d}.png" download>요약 카드 PNG</a></div>{setlink}</div></article>''')
    secs.append(f'<section id="p{p[2]}" class="{"tint" if i % 2 else ""}"><div class="wrap"><p class="pill">{E(p[0])}부</p><h2 style="font-family:var(--serif);color:var(--ink);font-size:1.9rem;margin:12px 0 4px">{E(p[1])}</h2><div class="grid30">{"".join(cards)}</div></div></section>')
flags = {}
for it in d['items']: flags[it['flag']] = flags.get(it['flag'], 0) + 1
page = f'''<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>30곳 문서고 탐방 — KOREA ARCHIVE 통합검색 예제 시리즈</title>
<meta name="description" content="한국어 한 문장으로 9개국 30곳 문서고를 하나씩 여는 예제 30선. 모든 결과는 {E(d["checked"])} 실제 도구 호출로 확인했습니다.">
<style>{css}</style>
</head>
<body>
<nav><div class="wrap"><a class="logo" href="index.html">KOREA ARCHIVE 통합검색</a><div class="links"><a href="index.html">소개</a><a href="examples.html">예제 15선</a><a href="#p1">30곳 탐방</a><a href="#status">현황</a><a href="#download">내려받기</a><a href="series100.html">100선</a><a href="iiif.html">IIIF 갤러리</a></div></div></nav>
<header class="hero" id="top"><div class="wrap narrow">
<span class="pill">예제 시리즈 · 30곳 전부</span>
<h1>30곳 문서고 <em>탐방</em></h1>
<p class="sub">이 도구가 함께 찾는 30곳을 <b>한 곳씩</b> 열어 봅니다. 곳마다 <b>원본 이미지로 가득 찬 인스타그램 캐러셀(4~7장)</b>과 소개글을 세트로 드립니다 — 원본 사진 한 장, 함께 찾은 원본 모음, 사진 속 글자를 짚어 읽는 해설 카드, 영상이 있으면 장면 해설까지. 각 예제는 그곳에 맞는 한 문장 질문과, 그 질문에 실제로 돌아온 기록입니다. 모든 결과는 {E(d["checked"])} 실제 도구 호출로 확인했습니다.</p>
<p style="font-size:1.6rem;margin-top:18px;letter-spacing:.2em">{" ".join(flags)}</p>
<div class="parts">{parts_nav}</div>
</div></header>
{"".join(secs)}
<section id="status"><div class="wrap narrow"><h2 style="font-family:var(--serif);color:var(--ink);font-size:1.7rem">솔직한 현황 — 막힌 곳도 숨기지 않습니다</h2>
<div class="status">
<p><b>이 시리즈를 만들며 고친 것</b> — 막힌 곳은 빼지 않고 도구를 고쳤습니다.</p>
<p style="margin-top:8px"><b>08 Gallica</b>: 서버 자동 조회가 403으로 막히면 같은 국립도서관의 <b>BnF 공식 카탈로그</b>로 넘어가 기록을 수집하고, 디지털화된 Gallica 원본 링크를 함께 돌려줍니다.</p>
<p style="margin-top:8px"><b>11 한국사DB</b>: 연합검색이 늘 0건이던 문제 → 개방파일 색인이 없으면 한국사DB를 실시간 조회합니다. 비변사등록 巨文島 4건은 등록류 판독으로 확인했습니다.</p>
<p style="margin-top:8px"><b>28 정보공개</b>: 정보공개포털 원문정보 메뉴가 2026-11-12부터 점검 중입니다. 도구가 점검 상태를 실측해 알리고, 점검 중에도 가능한 정보공개청구·대체 검색 경로를 안내합니다.</p>
<p style="margin-top:8px"><b>영상</b>: 영상 기록의 장면 전환을 찾아 장면별 대표 프레임을 뽑는 기능을 만들었습니다(01·29 흥남 필름 장면 해설). 웹·모바일에서는 인터넷 아카이브의 시각 코드 프레임으로 같은 일을 합니다.</p>
<p style="margin-top:8px"><b>권리를 지킨 방식</b>: 공공누리 제4유형은 자르거나 표시를 얹지 않고 원형 그대로, 기관 허가가 필요한 이미지(장서각·규장각·독립기념관 스크랩 등)는 싣지 않고 같은 기록의 공개 원본이나 참고 이미지를 쓰고 그렇다고 적었습니다. 기관 방화벽·봇 차단은 우회하지 않았습니다.</p>
</div></div></section>
<section id="download" class="tint"><div class="wrap narrow"><h2 style="font-family:var(--serif);color:var(--ink);font-size:1.7rem">내려받기 — 인스타그램 게시용</h2>
<ul style="margin:16px 0 0 20px;line-height:2">
<li><b>시리즈별 캐러셀 세트(카드+소개글) ZIP 30개</b> — 각 예제의 "세트 내려받기(ZIP)"</li>
<li><a href="promo/series30/s00_cover.png" download>표지 카드</a> + 카드 30장(각 예제의 "카드 PNG")</li>
<li><a href="promo/series30/captions.txt">게시글 캡션 30개 + 해시태그</a></li>
<li><a href="promo/series30/schedule.md">30일 게시 일정</a></li>
<li><a href="promo/series30/sources.txt">출처·권리 대장</a> (이미지 11장 권리 실확인 · 이미지가 없는 19곳은 실제 조회 결과만으로 만든 '기록 카드')</li>
</ul></div></section>
<section class="final"><div class="wrap narrow" style="text-align:center;padding:60px 0"><p>더 자세한 예제는 <a href="examples.html">예제 15선</a>, 연결 방법은 <a href="index.html">소개 페이지</a>에서.</p></div></section>
<script src="gallery.js" defer></script>
</body>
</html>
'''
(docs / 'series.html').write_text(page, encoding='utf-8')
print('series.html', len(page.encode()))
