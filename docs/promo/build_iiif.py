#!/usr/bin/env python3
"""전체 기록 IIIF 갤러리 빌드 — docs/iiif/ (IIIF Presentation 3.0 컬렉션 + 시리즈별 매니페스트 + 이미지).

원천: 30선(series30v2/img/NN/ledger.json)·100선(series100/sNNN/ledger.json)의 출처 대장.
권리 규칙(콘텐츠 신뢰 원칙):
  · 재이용 가능(PD·Unrestricted·CC·이용 제한 없음·기관 약관 허용) → 긴 변 1600px로 줄여 게재
  · 공공누리 제4유형 → 원본 파일을 그대로(크기·화질 변경 없이) 게재 — 변경 금지 조건
  · 기관 웹페이지 캡처·All Rights Reserved → 게재하지 않고 원 기관 링크만(목록 'links')
사용: python3 docs/promo/build_iiif.py   (재실행 시 바뀐 이미지만 다시 만든다)
"""
import json, glob, os, re, shutil, pathlib, html
from PIL import Image

PROMO = pathlib.Path(__file__).resolve().parent
DOCS = PROMO.parent
OUT = DOCS / 'iiif'
BASE = 'https://changgi.github.io/korea-archive-mcp/iiif/'
MAXE = 1600

RIGHTS_URI = [  # (판별 정규식, rights URI) — 확실한 경우에만 부여
    (r'CC0', 'http://creativecommons.org/publicdomain/zero/1.0/'),
    (r'CC BY-NC-SA 2\.0', 'http://creativecommons.org/licenses/by-nc-sa/2.0/'),
    (r'CC BY 4\.0', 'http://creativecommons.org/licenses/by/4.0/'),
    (r'Public Domain|퍼블릭 도메인|PDM|pdm|^PD|Copyright expired|보호기간 만료', 'http://creativecommons.org/publicdomain/mark/1.0/'),
    (r'Unrestricted', 'http://rightsstatements.org/vocab/NoC-US/1.0/'),
]


def kind(r):
    if '4유형' in r:
        return 'kogl4'
    if '캡처' in r or 'All Rights' in r:
        return 'link'
    return 'ok'


def L(s):
    return {'ko': [str(s)]}


def find(d, f):
    for c in (d / 'src' / f, d / f, d / 'src' / os.path.basename(f), d.parent / f):
        if c.exists():
            return c
    return None


def series_list():
    out = []
    s30 = json.loads((PROMO / 'series30' / 'series.json').read_text(encoding='utf-8'))
    meta30 = {f'{it["n"]:02d}': it for it in s30['items']}
    part30 = {}
    for p in s30['parts']:
        for n in range(p[2], p[3] + 1):
            part30[n] = f'{p[0]} {p[1]}'
    for f in sorted(glob.glob(str(PROMO / 'series30v2' / 'img' / '*' / 'ledger.json'))):
        d = pathlib.Path(f).parent; m = meta30.get(d.name, {})
        out.append(dict(key=f's{d.name}', n=int(d.name), d=d, led=json.loads(pathlib.Path(f).read_text(encoding='utf-8')),
                        inst=m.get('inst', ''), flag=m.get('flag', ''), head=m.get('head', ''), part='30곳 탐방 · ' + part30.get(int(d.name), ''),
                        page=f'../series.html#s{d.name}'))
    for f in sorted(glob.glob(str(PROMO / 'series100' / 's[0-9][0-9][0-9]' / 'ledger.json'))):
        d = pathlib.Path(f).parent
        if d.name == 's000' or not (d / 'plan.json').exists():
            continue
        P = json.loads((d / 'plan.json').read_text(encoding='utf-8'))
        out.append(dict(key=d.name, n=int(P['n']), d=d, led=json.loads(pathlib.Path(f).read_text(encoding='utf-8')),
                        inst=P.get('inst', ''), flag=P.get('flag', ''), head=P.get('head', ''), part='100선 · ' + ' '.join(P.get('part', [])),
                        page=f'../series100.html#{d.name}'))
    return out


def main():
    (OUT / 'm').mkdir(parents=True, exist_ok=True)
    manifests, index, stats = [], [], {'ok': 0, 'kogl4': 0, 'link': 0, 'missing': 0}
    keep = set()
    for S in series_list():
        rec = S['led'].get('record', {})
        canvases, links, seen = [], [], set()
        for k, im in enumerate(S['led'].get('images', [])):
            f = im.get('file', '')
            if not f or f in seen:
                continue
            seen.add(f)
            r = str(im.get('rights', ''))
            kd = kind(r)
            title = im.get('title') or rec.get('title') or f
            if kd == 'link':
                links.append({'title': title, 'url': im.get('url') or rec.get('url', ''), 'rights': r}); stats['link'] += 1
                continue
            src = find(S['d'], f)
            if not src:
                stats['missing'] += 1
                continue
            rel = f'img/{S["key"]}/{re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.splitext(os.path.basename(f))[0])}.jpg'
            dst = OUT / rel; th = OUT / rel.replace('img/', 'th/', 1)
            keep.add(str(dst)); keep.add(str(th))
            dst.parent.mkdir(parents=True, exist_ok=True); th.parent.mkdir(parents=True, exist_ok=True)
            fresh = not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime
            with Image.open(src) as I0:
                if kd == 'kogl4':  # 공공누리 제4유형 — 원본 그대로
                    if fresh:
                        if src.suffix.lower() in ('.jpg', '.jpeg'):
                            shutil.copyfile(src, dst)
                        else:
                            I0.convert('RGB').save(dst, quality=100)
                    w, h = I0.size
                else:
                    I = I0.convert('RGB')
                    if max(I.size) > MAXE:
                        I.thumbnail((MAXE, MAXE), Image.LANCZOS)
                    w, h = I.size
                    if fresh:
                        I.save(dst, quality=82, optimize=True, progressive=True)
                if fresh or not th.exists():
                    T = I0.convert('RGB'); T.thumbnail((480, 480)); T.save(th, quality=72)
            stats[kd] += 1
            cid = f'{BASE}m/{S["key"]}/canvas/{len(canvases) + 1}'
            md = [{'label': L('식별자'), 'value': L(im.get('record_id') or rec.get('id', ''))},
                  {'label': L('연대'), 'value': L(im.get('date') or rec.get('date', ''))},
                  {'label': L('소장'), 'value': L(rec.get('inst') or S['inst'])},
                  {'label': L('권리'), 'value': L(r + (' · 원본 무변경 게재' if kd == 'kogl4' else ''))}]
            if im.get('visible'):
                md.append({'label': L('보이는 것'), 'value': L(' · '.join(map(str, im['visible']))[:400])})
            cv = {'id': cid, 'type': 'Canvas', 'label': L(title[:200]), 'width': w, 'height': h, 'metadata': md,
                  'thumbnail': [{'id': BASE + rel.replace('img/', 'th/', 1), 'type': 'Image', 'format': 'image/jpeg'}],
                  'items': [{'id': cid + '/page', 'type': 'AnnotationPage', 'items': [{
                      'id': cid + '/page/a', 'type': 'Annotation', 'motivation': 'painting', 'target': cid,
                      'body': {'id': BASE + rel, 'type': 'Image', 'format': 'image/jpeg', 'width': w, 'height': h}}]}]}
            u = im.get('url') or rec.get('url')
            if u:
                cv['homepage'] = [{'id': u, 'type': 'Text', 'label': L('원 기관 기록'), 'format': 'text/html'}]
            for rx, uri in RIGHTS_URI:
                if re.search(rx, r) and kd != 'kogl4':
                    cv['rights'] = uri; break
            canvases.append(cv)
        if not canvases and not links:
            continue
        mid = f'{BASE}m/{S["key"]}.json'
        label = f'{S["n"]:03d} · {S["inst"]} — {S["head"]}' if len(S['key']) == 4 else f'{S["n"]:02d} · {S["inst"]} — {S["head"]}'
        man = {'@context': 'http://iiif.io/api/presentation/3/context.json', 'id': mid, 'type': 'Manifest', 'label': L(label),
               'summary': L(f'{S["part"]} · 원 기록: {rec.get("title", "")} ({rec.get("date", "")}) · {rec.get("inst", "")}'),
               'metadata': [{'label': L('원 기록'), 'value': L(f'{rec.get("id", "")} {rec.get("title", "")}'.strip())},
                            {'label': L('소장'), 'value': L(rec.get('inst', S['inst']))}],
               'requiredStatement': {'label': L('출처'), 'value': L(f'{rec.get("inst") or S["inst"]} — 이미지별 권리 표시 참조. 협약기관(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터) 기록은 출처 표기 필수.')},
               'provider': [{'id': 'https://changgi.github.io/korea-archive-mcp/', 'type': 'Agent', 'label': L('KOREA ARCHIVE 통합검색')}],
               'items': canvases}
        if rec.get('url'):
            man['homepage'] = [{'id': rec['url'], 'type': 'Text', 'label': L('원 기관 기록'), 'format': 'text/html'}]
        if canvases:
            man['thumbnail'] = canvases[0]['thumbnail']
        (OUT / 'm' / f'{S["key"]}.json').write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding='utf-8')
        manifests.append({'id': mid, 'type': 'Manifest', 'label': L(label), **({'thumbnail': man['thumbnail']} if canvases else {})})
        index.append({'key': S['key'], 'n': S['n'], 'label': label, 'part': S['part'], 'flag': S['flag'], 'page': S['page'],
                      'rec': {k: rec.get(k, '') for k in ('id', 'title', 'date', 'inst', 'url')},
                      'c': [{'t': c['label']['ko'][0], 'img': c['items'][0]['items'][0]['body']['id'].replace(BASE, ''),
                             'th': c['thumbnail'][0]['id'].replace(BASE, ''), 'w': c['width'], 'h': c['height'],
                             'md': {m['label']['ko'][0]: m['value']['ko'][0] for m in c['metadata']},
                             'u': (c.get('homepage') or [{}])[0].get('id', '')} for c in canvases],
                      'links': links})
    coll = {'@context': 'http://iiif.io/api/presentation/3/context.json', 'id': BASE + 'collection.json', 'type': 'Collection',
            'label': L('KOREA ARCHIVE 통합검색 — 30곳 탐방·100선 전체 기록 이미지'),
            'summary': L(f'시리즈 {len(manifests)}개 · 이미지 {stats["ok"] + stats["kogl4"]}장(공공누리 제4유형 {stats["kogl4"]}장은 원본 무변경) · 원 기관 링크만 {stats["link"]}건'),
            'items': manifests}
    # 전체 이어보기 매니페스트 — 800장을 한 매니페스트에(각 장 라벨에 시리즈 번호), Mirador·UV에서 처음부터 끝까지 연속으로 넘김
    allc = []
    for S0 in index:
        man0 = json.loads((OUT / 'm' / f'{S0["key"]}.json').read_text(encoding='utf-8'))
        for c in man0['items']:
            c = json.loads(json.dumps(c)); c['label'] = L(S0['label'].split(' — ')[0] + ' · ' + c['label']['ko'][0]); allc.append(c)
    allm = {'@context': 'http://iiif.io/api/presentation/3/context.json', 'id': BASE + 'all.json', 'type': 'Manifest',
            'label': L(f'KOREA ARCHIVE 통합검색 — 전체 기록 이어보기 ({len(allc)}장)'),
            'summary': L('30곳 탐방·100선의 실물 기록 이미지 전체를 시리즈 순서대로 한 매니페스트에 담았습니다. 장마다 원 기관·식별자·권리 표시.'),
            'requiredStatement': {'label': L('출처'), 'value': L('이미지별 원 기관·권리 표시 참조. 협약기관(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터) 기록은 출처 표기 필수.')},
            'provider': [{'id': 'https://changgi.github.io/korea-archive-mcp/', 'type': 'Agent', 'label': L('KOREA ARCHIVE 통합검색')}],
            'items': allc}
    if allc:
        allm['thumbnail'] = allc[0]['thumbnail']
    (OUT / 'all.json').write_text(json.dumps(allm, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (OUT / 'collection.json').write_text(json.dumps(coll, ensure_ascii=False, indent=1), encoding='utf-8')
    (OUT / 'index.json').write_text(json.dumps({'stats': stats, 'series': index}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    for p in list((OUT / 'img').rglob('*.jpg')) + list((OUT / 'th').rglob('*.jpg')):
        if str(p) not in keep:
            p.unlink()
    print(len(manifests), 'manifests', stats)


if __name__ == '__main__':
    main()
