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
.status{background:#fff7e6;border:1px solid #f0d9a8;border-radius:12px;padding:16px 18px;margin-top:20px;font-size:.95rem}
'''
parts_nav = ''.join(f'<a href="#p{p[2]}">{E(p[0])} {E(p[1])}<span>{p[2]:02d}–{p[3]:02d}</span></a>' for p in d['parts'])
secs = []
for i, p in enumerate(d['parts']):
    items = [it for it in d['items'] if p[2] <= it['n'] <= p[3]]
    cards = []
    for it in items:
        lis = ''.join(f'<li><b>{E(k)}</b>{E(v)}</li>' for k, v in it['facts'])
        cards.append(f'''<article class="it" id="s{it["n"]:02d}"><img loading="lazy" src="promo/series30/thumbs/s{it["n"]:02d}.jpg" alt="{E(it["inst"])} — {E(it["head"])} 카드">
<div class="b"><div class="inst">{it["n"]:02d} · {it["flag"]} {E(it["inst"])}</div><h3>{E(it["head"])}</h3>
<div class="q"><span id="sq{it["n"]}">{E(it["say"])}</span><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('sq{it["n"]}').textContent);this.textContent='복사됨 ✓'">복사</button></div>
<ul>{lis}</ul><div class="tool">{E(it["tool"])}</div>
<div class="lk"><a href="{E(it["link"])}" target="_blank" rel="noopener">원문 기록 열기 ↗</a><a href="promo/series30/s{it["n"]:02d}.png" download>카드 PNG</a></div></div></article>''')
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
<nav><div class="wrap"><a class="logo" href="index.html">KOREA ARCHIVE 통합검색</a><div class="links"><a href="index.html">소개</a><a href="examples.html">예제 15선</a><a href="#p1">30곳 탐방</a><a href="#status">현황</a><a href="#download">내려받기</a></div></div></nav>
<header class="hero" id="top"><div class="wrap narrow">
<span class="pill">예제 시리즈 · 30곳 전부</span>
<h1>30곳 문서고 <em>탐방</em></h1>
<p class="sub">이 도구가 함께 찾는 30곳을 <b>한 곳씩</b> 열어 봅니다. 각 예제는 그곳에 맞는 한 문장 질문과, 그 질문에 실제로 돌아온 기록입니다. 모든 결과는 {E(d["checked"])} 실제 도구 호출로 확인했습니다.</p>
<p style="font-size:1.6rem;margin-top:18px;letter-spacing:.2em">{" ".join(flags)}</p>
<div class="parts">{parts_nav}</div>
</div></header>
{"".join(secs)}
<section id="status"><div class="wrap narrow"><h2 style="font-family:var(--serif);color:var(--ink);font-size:1.7rem">솔직한 현황 — 막힌 곳도 숨기지 않습니다</h2>
<div class="status">
<p><b>정상 응답 26곳</b> · 30곳 헬스체크({E(d["checked"])} 실측).</p>
<p style="margin-top:8px"><b>08 Gallica</b>와 <b>28 정보공개</b>는 기관 쪽에서 서버 자동 조회를 막거나 응답하지 않습니다. 그래도 수집 대상에서 빼지 않고, 응답에 <b>브라우저·웹 검색으로 여는 공식 경로</b>를 안내합니다(예제 08·28이 그 실제 응답입니다).</p>
<p style="margin-top:8px"><b>11 한국사DB</b>는 연합검색 색인(공식 개방파일)이 아직 설정되지 않아, 전용 판독 도구(nedb_search)로 직접 조회한 결과를 실었습니다.</p>
<p style="margin-top:8px"><b>30 DigitalNZ</b>는 이날 한때 서버 IP가 차단(403)됐다가 재실측에서 정상 응답했습니다.</p>
<p style="margin-top:8px">이 시리즈를 만들며 찾은 도구 결함 3건(일본 국립국회도서관 일문 검색, 인터넷 아카이브 사본 묶기, 링크 추적 꼬리)은 바로 고쳐 배포했습니다 — 예제 18·29가 고친 뒤의 결과입니다.</p>
</div></div></section>
<section id="download" class="tint"><div class="wrap narrow"><h2 style="font-family:var(--serif);color:var(--ink);font-size:1.7rem">내려받기 — 인스타그램 게시용</h2>
<ul style="margin:16px 0 0 20px;line-height:2">
<li><a href="promo/series30/s00_cover.png" download>표지 카드</a> + 카드 30장(각 예제의 "카드 PNG")</li>
<li><a href="promo/series30/captions.txt">게시글 캡션 30개 + 해시태그</a></li>
<li><a href="promo/series30/schedule.md">30일 게시 일정</a></li>
<li><a href="promo/series30/sources.txt">출처·권리 대장</a> (이미지 11장 권리 실확인 · 이미지가 없는 19곳은 실제 조회 결과만으로 만든 '기록 카드')</li>
</ul></div></section>
<section class="final"><div class="wrap narrow" style="text-align:center;padding:60px 0"><p>더 자세한 예제는 <a href="examples.html">예제 15선</a>, 연결 방법은 <a href="index.html">소개 페이지</a>에서.</p></div></section>
</body>
</html>
'''
(docs / 'series.html').write_text(page, encoding='utf-8')
print('series.html', len(page.encode()))
