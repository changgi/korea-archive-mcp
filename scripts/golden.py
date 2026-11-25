#!/usr/bin/env python3
"""골든 회귀 실행기 — 프로덕션 MCP에 tests/golden.json 케이스를 호출해 출력 '모양'을 검사한다(표준 라이브러리만).
사용: python3 scripts/golden.py [--url URL] [--only id1,id2] [--md 요약.md]
종료 코드: error 레벨 실패가 있으면 1. warn 레벨은 경고만."""
import json, re, sys, time, argparse, pathlib, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--url', default='https://korea-archive-mcp.vercel.app/api/mcp')
ap.add_argument('--only', default='')
ap.add_argument('--md', default='')
a = ap.parse_args()
G = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'golden.json').read_text(encoding='utf-8'))
H = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'X-KA-Probe': 'golden'}  # 누적 원장 활용 집계 제외


def post(body, sid=None, t=120):
    h = dict(H)
    if sid:
        h['Mcp-Session-Id'] = sid
    r = urllib.request.urlopen(urllib.request.Request(a.url, json.dumps(body).encode(), h), timeout=t)
    return r.headers.get('mcp-session-id'), r.read().decode('utf-8', 'replace')


sid, _ = post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'golden', 'version': '1'}}})
post({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, sid)
only = set(filter(None, a.only.split(',')))
rows, errs, warns = [], 0, 0
for c in G['cases']:
    if only and c['id'] not in only:
        continue
    t0 = time.time(); probs = []; txt = ''
    try:
        _, raw = post({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': c['tool'], 'arguments': c['args']}}, sid)
        line = next((ln[6:] if ln.startswith('data: ') else ln for ln in raw.splitlines() if ln.lstrip('data: ').startswith('{')), '{}')
        j = json.loads(line)
        if 'error' in j:
            probs.append('JSON-RPC 오류 ' + json.dumps(j['error'], ensure_ascii=False)[:120])
        txt = ((j.get('result') or {}).get('content') or [{}])[0].get('text', '')
    except Exception as e:
        probs.append(f'호출 실패 {type(e).__name__}: {str(e)[:100]}')
    nb = len(txt.encode('utf-8'))
    if txt and nb > G['max_bytes']:
        probs.append(f'응답 {nb}B > {G["max_bytes"]}B(PlayMCP 24KB 상한)')
    for rx in c.get('must', []):
        if txt and not re.search(rx, txt):
            probs.append(f'없음: /{rx}/')
    for rx in c.get('must_not', []):
        if txt and re.search(rx, txt):
            probs.append(f'금지 패턴 출현: /{rx}/')
    if not txt and not probs:
        probs.append('빈 응답')
    lv = c.get('level', 'error')
    ok = not probs
    if not ok:
        if lv == 'error':
            errs += 1
        else:
            warns += 1
    mark = '✅' if ok else ('❌' if lv == 'error' else '⚠️')
    rows.append(f'| {mark} | `{c["id"]}` | {c["tool"]} | {nb}B | {time.time() - t0:.1f}s | {"; ".join(probs)[:300]} |')
    print(f'{mark} {c["id"]:<20} {nb:>6}B {time.time() - t0:5.1f}s {"; ".join(probs)[:200]}')
    time.sleep(1)
md = f'## 골든 회귀 — error 실패 {errs} · 경고 {warns} · 전체 {len(rows)}\n\n| | 케이스 | 도구 | 크기 | 시간 | 문제 |\n|---|---|---|---|---|---|\n' + '\n'.join(rows) + '\n'
if a.md:
    pathlib.Path(a.md).write_text(md, encoding='utf-8')
sys.exit(1 if errs else 0)
