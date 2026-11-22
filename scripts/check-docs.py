#!/usr/bin/env python3
"""GitHub Pages(docs/) 무결성 검사 — 링크 부패·이미지 누락을 배포 전에 잡는다.
① docs/*.html의 상대 href·src가 실제 파일로 존재하는가 ② IIIF 매니페스트(collection·all·m/*)의 이미지·썸네일이 docs/iiif/ 아래 있는가
③ 갤러리 index.json과 매니페스트 수가 맞는가. 외부 URL은 보지 않는다(주간 감시 몫)."""
import json, re, sys, pathlib, glob, urllib.parse
D = pathlib.Path(__file__).resolve().parent.parent / 'docs'
BASE = 'https://changgi.github.io/korea-archive-mcp/'
bad = []
for f in sorted(D.glob('*.html')):
    s = f.read_text(encoding='utf-8')
    for m in re.finditer(r'(?:href|src)="([^"#?]+)(?:[#?][^"]*)?"', s):
        u = m.group(1)
        if re.match(r'^(https?:|mailto:|data:|javascript:|//)', u) or '${' in u:
            continue
        p = (f.parent / urllib.parse.unquote(u)).resolve()
        if not p.exists():
            bad.append(f'{f.name}: {u}')
for f in sorted(glob.glob(str(D / 'iiif' / '**' / '*.json'), recursive=True)):
    if f.endswith('index.json'):
        continue
    for m in re.finditer(r'"id":"?\s*"?(' + re.escape(BASE) + r'iiif/(?:img|th)/[^"]+)"', open(f, encoding='utf-8').read()):
        p = D / m.group(1)[len(BASE):]
        if not p.exists():
            bad.append(f'{pathlib.Path(f).name}: {m.group(1)[len(BASE):]}')
idx = D / 'iiif' / 'index.json'
if idx.exists():
    n = len(json.loads(idx.read_text(encoding='utf-8'))['series']); nm = len(list((D / 'iiif' / 'm').glob('*.json')))
    if n != nm:
        bad.append(f'iiif/index.json 시리즈 {n} ≠ 매니페스트 {nm}')
bad = sorted(set(bad))
print(f'docs 무결성: 문제 {len(bad)}건' + (':\n- ' + '\n- '.join(bad[:60]) if bad else ' — 링크·이미지·매니페스트 전부 존재'))
sys.exit(1 if bad else 0)
