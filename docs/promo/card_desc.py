"""캐러셀 카드별 한 줄 설명 — 갤러리 뷰어용(gen_page.py·gen_page100.py 공용).
plan(카드 구성)에서 장 순서대로 '무엇이 담긴 장인지'를 만든다: 표지 → 원본 모음 → 기록 해설 → 영상 장면 → 기록 정보 → 직접 해 보기."""
import re, html


def _t(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', re.sub(r'<br\s*/?>', ' ', str(s or ''))))).strip()


def card_descs(plan, head='', say='', facts=()):
    d = ['표지 — ' + _t(plan.get('hook')) + (' · ' + _t(plan['hero'].get('credit', '')).split(' · ')[0] if plan.get('hero', {}).get('credit') else '')]
    if plan.get('mosaic'):
        labs = ' / '.join(_t(m.get('label', '')) for m in plan['mosaic'] if m.get('label'))
        d.append('원본 모음 — ' + _t(plan.get('mosaic_title')) + (f' ({labs})' if labs else ''))
    anns = plan.get('ann') or []
    for a in ([anns] if isinstance(anns, dict) else anns):
        pts = ' · '.join(f'{i}) {_t(b.get("t"))}' for i, b in enumerate(a.get('boxes', []), 1))
        d.append('기록 해설 — ' + (_t(a.get('title')) or '원본에서 직접 읽은 곳') + (f' : {pts}' if pts else ''))
    for g in plan.get('scenes', [])[:2]:
        fr = ' · '.join(f'{_t(f.get("tc"))} {_t(f.get("cap"))}' for f in g.get('frames', [])[:4])
        d.append('영상 장면 해설 — ' + _t(g.get('title')) + (f' : {fr}' if fr else ''))
    fx = ' · '.join(f'{_t(k)}: {_t(v)}' for k, v in list(facts)[:4])
    d.append('기록 정보 — ' + _t(head) + (f' | {fx}' if fx else ''))
    d.append(f'직접 해 보기 — 커넥터에 "{_t(say)}" 한 문장이면 이 기록을 찾습니다')
    return d
