#!/usr/bin/env python3
"""전체 기록 IIIF 갤러리 빌드 — docs/iiif/ (IIIF Presentation 3.0 컬렉션 + 시리즈별 매니페스트 + 이미지).

원천: 30선(series30v2/img/NN/ledger.json)·100선(series100/sNNN/ledger.json)의 출처 대장.
권리 규칙(콘텐츠 신뢰 원칙):
  · 재이용 가능(PD·Unrestricted·CC·이용 제한 없음·기관 약관 허용) → 긴 변 1600px로 줄여 게재
  · 공공누리 제4유형 → 원본 파일을 그대로(크기·화질 변경 없이) 게재 — 변경 금지 조건
  · 기관 웹페이지 캡처·All Rights Reserved → 게재하지 않고 원 기관 링크만(목록 'links')
사용: python3 docs/promo/build_iiif.py   (재실행 시 바뀐 이미지만 다시 만든다)
"""
import json, glob, os, re, shutil, pathlib, html, hashlib, csv, io, time, urllib.request, urllib.parse, datetime
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


PAGES = 'https://changgi.github.io/korea-archive-mcp/'
BRIDGE = 'https://korea-archive-mcp.vercel.app/iiif/nara/'
_NCACHE = None


def nara_ctx(naid):
    """NARA 계보(맥락) — NARA→IIIF 브리지의 RiC-O 기술에서 상위 계층·이용조건을 받아 캐시(docs/iiif/_nara_ctx.json). 재현 가능한 빌드를 위해 한 번 받은 값은 캐시를 쓴다.
    끄려면 KA_NARA=0."""
    global _NCACHE
    cf = OUT / '_nara_ctx.json'
    if _NCACHE is None:
        _NCACHE = json.loads(cf.read_text(encoding='utf-8')) if cf.exists() else {}
    k = str(naid)
    if k not in _NCACHE and os.environ.get('KA_NARA', '1') != '0':
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(BRIDGE + k + '/record.jsonld', headers={'User-Agent': 'KoreaArchive build_iiif'}), timeout=30))
            anc = r.get('rico:isOrWasIncludedInTransitive') or []
            _NCACHE[k] = {'chain': ' › '.join(f"{a.get('rico:identifier', '')} {a.get('rico:title', '')}".strip() for a in anc),
                          'use': r.get('rico:conditionsOfUse', ''), 'date': r.get('rico:isAssociatedWithDate', ''), 'level': r.get('rico:hasRecordSetType', '')}
            time.sleep(0.3)
        except Exception as e:
            _NCACHE[k] = {'error': str(e)[:80]}
        cf.write_text(json.dumps(_NCACHE, ensure_ascii=False, indent=0), encoding='utf-8')
    return _NCACHE.get(k) or {}


def nav_date(s):
    """연대 문자열 → IIIF navDate(ISO). 연월일 > 연월 > 연도(1500~2099) 순으로 확실한 것만."""
    s = str(s or '')
    m = re.search(r'(1[5-9]\d\d|20\d\d)[-./](\d{1,2})[-./](\d{1,2})', s)
    if m and 1 <= int(m.group(2)) <= 12 and 1 <= int(m.group(3)) <= 31:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}T00:00:00Z'
    m = re.search(r'(1[5-9]\d\d|20\d\d)[-./](\d{1,2})\b', s)
    if m and 1 <= int(m.group(2)) <= 12:
        return f'{m.group(1)}-{int(m.group(2)):02d}-01T00:00:00Z'
    m = re.search(r'(?<!\d)(1[5-9]\d\d|20\d\d)(?!\d)', s)
    return f'{m.group(1)}-01-01T00:00:00Z' if m else ''


_ROM = {'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6, 'Ⅶ': 7, 'Ⅷ': 8, 'Ⅸ': 9, 'Ⅹ': 10, 'Ⅺ': 11, 'Ⅻ': 12}


def slug(t):
    """부(部) 컬렉션 파일명 — ASCII(IIIF URI 안전): '30곳 탐방 · Ⅰ …' → s30-01, '100선 · ⅩⅢ …' → s100-13"""
    m = re.search(r'([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+)', t)
    if m:
        n = sum(_ROM[c] for c in m.group(1))
    else:  # 라틴 로마자(XIII 등)
        r = (re.search(r'\b([IVXLC]+)\b', t) or [None, ''])[1]
        v = {'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100}; n = 0
        for i, c in enumerate(r):
            n += -v[c] if i + 1 < len(r) and v[r[i + 1]] > v[c] else v[c]
    return ('s30' if t.startswith('30') else 's100') + f'-{n:02d}'


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
        out.append(dict(key=f's{d.name}', n=int(d.name), d=d, led_path=f, led=json.loads(pathlib.Path(f).read_text(encoding='utf-8')),
                        inst=m.get('inst', ''), flag=m.get('flag', ''), head=m.get('head', ''), part='30곳 탐방 · ' + part30.get(int(d.name), ''),
                        page=f'../series.html#s{d.name}', tool=m.get('tool', ''), checked=s30.get('checked', '')))
    for f in sorted(glob.glob(str(PROMO / 'series100' / 's[0-9][0-9][0-9]' / 'ledger.json'))):
        d = pathlib.Path(f).parent
        if d.name == 's000' or not (d / 'plan.json').exists():
            continue
        P = json.loads((d / 'plan.json').read_text(encoding='utf-8'))
        out.append(dict(key=d.name, n=int(P['n']), d=d, led_path=f, led=json.loads(pathlib.Path(f).read_text(encoding='utf-8')),
                        inst=P.get('inst', ''), flag=P.get('flag', ''), head=P.get('head', ''), part='100선 · ' + ' '.join(P.get('part', [])),
                        page=f'../series100.html#{d.name}', tool=P.get('tool', ''), checked=P.get('checked', '')))
    return out


def main():
    (OUT / 'm').mkdir(parents=True, exist_ok=True)
    manifests, index, stats = [], [], {'ok': 0, 'kogl4': 0, 'link': 0, 'missing': 0}
    exports, parts = [], {}
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
            sha = hashlib.sha256(dst.read_bytes()).hexdigest()
            md.append({'label': L('고정성(sha256)'), 'value': L(sha[:16] + ' — 게재 이미지 파일 지문(불일치=파일 변경)')})
            nm = re.search(r'NAID\s*(\d{3,})', str(im.get('record_id') or '') + ' ' + str(im.get('url') or ''))
            nctx = nara_ctx(nm.group(1)) if nm else {}
            if nctx.get('chain'):
                md.append({'label': L('원 기관 계보'), 'value': L('NARA › ' + nctx['chain'])})
            if im.get('rights_evidence'):
                md.append({'label': L('권리 근거'), 'value': L(str(im['rights_evidence'])[:300])})
            cv = {'id': cid, 'type': 'Canvas', 'label': L(title[:200]), 'width': w, 'height': h, 'metadata': md,
                  'thumbnail': [{'id': BASE + rel.replace('img/', 'th/', 1), 'type': 'Image', 'format': 'image/jpeg'}],
                  'items': [{'id': cid + '/page', 'type': 'AnnotationPage', 'items': [{
                      'id': cid + '/page/a', 'type': 'Annotation', 'motivation': 'painting', 'target': cid,
                      'body': {'id': BASE + rel, 'type': 'Image', 'format': 'image/jpeg', 'width': w, 'height': h}}]}]}
            u = im.get('url') or rec.get('url')
            if u:
                cv['homepage'] = [{'id': u, 'type': 'Text', 'label': L('원 기관 기록'), 'format': 'text/html'}]
            led_url = PAGES + str(pathlib.Path(S['led_path']).relative_to(DOCS)).replace(os.sep, '/')
            cv['seeAlso'] = [{'id': led_url, 'type': 'Dataset', 'label': L('출처 대장(ledger) — 권리 근거·판독 내용'), 'format': 'application/json'}]
            if nm:
                cv['seeAlso'] += [{'id': BRIDGE + nm.group(1) + '/manifest.json', 'type': 'Manifest', 'label': L('NARA 원본 전체(IIIF 브리지)'), 'format': 'application/ld+json'},
                                  {'id': BRIDGE + nm.group(1) + '/record.jsonld', 'type': 'Dataset', 'label': L('NARA 계층 기술(RiC-O)'), 'format': 'application/ld+json'}]
            uu = str(im.get('url') or rec.get('url') or '')  # v1.99: 원 기관 IIIF 브리지(AWM·역사박물관·위키미디어) — 원본 전체로 이어지는 길
            bm = re.search(r'awm\.gov\.au/collection/(C\d+)', uu) or re.search(r'much\.go\.kr/.*idnbr=([A-Z]{2}[\w-]+)', uu)
            cm = re.search(r'commons\.wikimedia\.org/wiki/(File(?:%3A|:)[^?#]+)', uu, re.I)
            if bm or cm:
                src_ = 'awm' if 'awm.gov.au' in uu else 'much' if 'much.go.kr' in uu else 'commons'
                bid = urllib.parse.unquote(cm.group(1)).replace('_', ' ') if cm else bm.group(1)
                cv['seeAlso'].append({'id': 'https://korea-archive-mcp.vercel.app/iiif/' + src_ + '/' + urllib.parse.quote(bid, safe='') + '/manifest.json', 'type': 'Manifest', 'label': L('원 기관 원본(IIIF 브리지)'), 'format': 'application/ld+json'})
            nd = nav_date(im.get('date') or rec.get('date'))
            if nd:
                cv['navDate'] = nd
            cv['_sha'] = sha; cv['_naid'] = nm.group(1) if nm else ''
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
               'metadata': [x for x in [{'label': L('원 기록'), 'value': L(f'{rec.get("id", "")} {rec.get("title", "")}'.strip())},
                            {'label': L('소장'), 'value': L(rec.get('inst', S['inst']))},
                            {'label': L('계층'), 'value': L(f'KOREA ARCHIVE 통합검색 › {S["part"]} › {S["key"]}')},
                            S.get('tool') and {'label': L('수집 경로'), 'value': L(S['tool'])},
                            S.get('checked') and {'label': L('확인일'), 'value': L(S['checked'])},
                            {'label': L('게재 이미지'), 'value': L(f'{len(canvases)}장 · 링크 전용 {len(links)}건')}] if x],
               'partOf': [{'id': BASE + 'c/' + slug(S['part']) + '.json', 'type': 'Collection', 'label': L(S['part'])},
                          {'id': BASE + 'hierarchy.json', 'type': 'Collection', 'label': L('KOREA ARCHIVE 통합검색 — 기록 계층')}],
               'seeAlso': [{'id': PAGES + str(pathlib.Path(S['led_path']).relative_to(DOCS)).replace(os.sep, '/'), 'type': 'Dataset', 'label': L('출처 대장(ledger)'), 'format': 'application/json'}],
               'requiredStatement': {'label': L('출처'), 'value': L(f'{rec.get("inst") or S["inst"]} — 이미지별 권리 표시 참조. 협약기관(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터) 기록은 출처 표기 필수.')},
               'provider': [{'id': 'https://changgi.github.io/korea-archive-mcp/', 'type': 'Agent', 'label': L('KOREA ARCHIVE 통합검색')}],
               'items': canvases}
        if rec.get('url'):
            man['homepage'] = [{'id': rec['url'], 'type': 'Text', 'label': L('원 기관 기록'), 'format': 'text/html'}]
        if canvases:
            man['thumbnail'] = canvases[0]['thumbnail']
        nd0 = nav_date(rec.get('date'))
        if nd0:
            man['navDate'] = nd0
        for c in canvases:
            exports.append({'series': S['key'], 'n': S['n'], 'part': S['part'], 'series_label': label, 'canvas': c['id'], 'title': c['label']['ko'][0],
                            **{m['label']['ko'][0]: m['value']['ko'][0] for m in c['metadata']}, 'image': c['items'][0]['items'][0]['body']['id'],
                            'manifest': mid, 'kv': PAGES + 'kv.html?collection=' + urllib.request.quote(BASE + 'hierarchy.json', safe='') + '&manifest=' + urllib.request.quote(mid, safe='') + '&canvas=' + c['id'].rsplit('/', 1)[1],
                            'source': (c.get('homepage') or [{}])[0].get('id', ''), 'navDate': c.get('navDate', ''), 'sha256': c['_sha'], 'naid': c['_naid'], 'rights_uri': c.get('rights', '')})
        for c in canvases:
            c.pop('_sha', None); c.pop('_naid', None)
        parts.setdefault(S['part'], []).append({'id': mid, 'type': 'Manifest', 'label': L(label), **({'thumbnail': man['thumbnail']} if canvases else {}), **({'navDate': nd0} if nd0 else {})})
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
    # 계층(맥락): 최상위 → 부(部) 컬렉션 → 시리즈 매니페스트 → 캔버스. collection.json(평면)은 호환용으로 유지
    (OUT / 'c').mkdir(exist_ok=True)
    pcs = []
    for pt, its in parts.items():
        pid = BASE + 'c/' + slug(pt) + '.json'
        (OUT / 'c' / (slug(pt) + '.json')).write_text(json.dumps({'@context': 'http://iiif.io/api/presentation/3/context.json', 'id': pid, 'type': 'Collection', 'label': L(pt),
            'summary': L(f'{pt} — 시리즈 {len(its)}개'), 'partOf': [{'id': BASE + 'hierarchy.json', 'type': 'Collection'}], 'items': its}, ensure_ascii=False, indent=1), encoding='utf-8')
        pcs.append({'id': pid, 'type': 'Collection', 'label': L(pt), **({'thumbnail': its[0]['thumbnail']} if its and its[0].get('thumbnail') else {})})
    for f in (OUT / 'c').glob('*.json'):
        if f.stem not in {slug(p) for p in parts}:
            f.unlink()
    (OUT / 'hierarchy.json').write_text(json.dumps({'@context': 'http://iiif.io/api/presentation/3/context.json', 'id': BASE + 'hierarchy.json', 'type': 'Collection',
        'label': L('KOREA ARCHIVE 통합검색 — 기록 계층(부 › 시리즈 › 이미지)'), 'summary': L(f'부 {len(pcs)}개 · 시리즈 {len(manifests)}개 · 이미지 {len(exports)}장'),
        'provider': [{'id': PAGES, 'type': 'Agent', 'label': L('KOREA ARCHIVE 통합검색')}], 'items': pcs}, ensure_ascii=False, indent=1), encoding='utf-8')
    # 데이터화·다매체: CSV(표·통계) · RiC-O JSON-LD(지식그래프·기록관리 등재)
    cols = ['series', 'n', 'part', 'series_label', 'title', '식별자', '연대', 'navDate', '소장', '권리', 'rights_uri', '원 기관 계보', 'naid', '보이는 것', 'sha256', 'image', 'manifest', 'kv', 'source', 'canvas']
    buf = io.StringIO(); w = csv.DictWriter(buf, fieldnames=cols, extrasaction='ignore'); w.writeheader(); w.writerows(exports)
    (OUT / 'records.csv').write_text('\ufeff' + buf.getvalue(), encoding='utf-8')
    graph = [{'@id': BASE + 'hierarchy.json', '@type': 'rico:RecordSet', 'rico:title': 'KOREA ARCHIVE 통합검색 — 기록 계층', 'rico:hasOrHadHolder': {'rico:name': 'KOREA ARCHIVE 통합검색'}}]
    graph += [{'@id': BASE + 'c/' + slug(pt) + '.json', '@type': 'rico:RecordSet', 'rico:title': pt, 'rico:isOrWasIncludedIn': {'@id': BASE + 'hierarchy.json'}} for pt in parts]
    graph += [{'@id': x['id'], '@type': 'rico:RecordSet', 'rico:title': x['label']['ko'][0], 'rico:isOrWasIncludedIn': {'@id': next(BASE + 'c/' + slug(pt) + '.json' for pt, its in parts.items() if any(i['id'] == x['id'] for i in its))}} for x in manifests]
    graph += [{'@id': e['canvas'], '@type': 'rico:Record', 'rico:title': e['title'], 'rico:identifier': e.get('식별자', ''), 'rico:isAssociatedWithDate': e.get('연대', ''),
               'rico:isOrWasIncludedIn': {'@id': e['manifest']}, 'rico:conditionsOfUse': e.get('권리', ''), **({'dct:rights': e['rights_uri']} if e['rights_uri'] else {}),
               'rico:hasOrHadInstantiation': {'@id': e['image'], '@type': 'rico:Instantiation', 'dct:format': 'image/jpeg', 'rico:hasCarrierType': 'IIIF canvas', 'prov:value': 'sha256:' + e['sha256']},
               **({'prov:wasDerivedFrom': {'@id': e['source']}} if e['source'] else {}), **({'owl:sameAs': {'@id': 'https://catalog.archives.gov/id/' + e['naid']}} if e['naid'] else {})} for e in exports]
    (OUT / 'records.jsonld').write_text(json.dumps({'@context': {'rico': 'https://www.ica.org/standards/RiC/ontology#', 'prov': 'http://www.w3.org/ns/prov#', 'dct': 'http://purl.org/dc/terms/', 'owl': 'http://www.w3.org/2002/07/owl#'},
        'prov:generatedAtTime': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), '@graph': graph}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (OUT / 'index.json').write_text(json.dumps({'stats': stats, 'series': index}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    for p in list((OUT / 'img').rglob('*.jpg')) + list((OUT / 'th').rglob('*.jpg')):
        if str(p) not in keep:
            p.unlink()
    print(len(manifests), 'manifests', stats)


if __name__ == '__main__':
    main()
