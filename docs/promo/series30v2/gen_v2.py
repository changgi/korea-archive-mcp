#!/usr/bin/env python3
"""30곳 탐방 v2 — 시리즈별 인스타 캐러셀(5~7장) 생성기.
입력: ../series30/series.json(문구·사실) · img/NN/ledger.json(원본 이미지·권리) · plan.json(히어로·어노테이션·장면 해설)
출력: build/NN/source.html → make_carousel.py로 PNG"""
import json, html, re, pathlib, sys
here = pathlib.Path(__file__).parent
S1 = json.loads((here.parent / 'series30' / 'series.json').read_text(encoding='utf-8'))
PLAN = json.loads((here / 'plan.json').read_text(encoding='utf-8'))
css = re.search(r'<style>(.*?)</style>', (here.parent / 'singles' / 'singles_source.html').read_text(encoding='utf-8'), re.S).group(1)
css += '''
  .kick{font-size:23px; color:var(--gold); font-weight:900; letter-spacing:.14em; text-shadow:0 2px 8px #000;}
  .kick .no{display:inline-block; background:var(--crimson); color:#fff; padding:4px 14px; margin-right:12px; letter-spacing:.05em;}
  .inst{font-size:32px; font-weight:900; color:#fff; margin-top:10px; text-shadow:0 2px 10px #000; word-break:keep-all;}
  .hook{font-size:74px; line-height:1.16; font-weight:900; color:#fff; text-shadow:0 6px 30px rgba(0,0,0,.95); word-break:keep-all;}
  .hook .g{color:var(--gold);}
  .tc{position:absolute; z-index:6; background:var(--crimson); color:#fff; font-weight:900; font-family:Consolas,Menlo,monospace; font-size:28px; padding:6px 14px;}
  .scap{position:absolute; left:0; right:0; bottom:0; z-index:6; background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.9) 40%); color:#fff; font-size:24px; font-weight:700; line-height:1.4; padding:40px 16px 12px; word-break:keep-all;}
  .cell{position:relative; overflow:hidden; background:#000;}
  .cell img{width:100%; height:100%; object-fit:cover; display:block;}
  .cell .ml{position:absolute; left:10px; top:10px; z-index:6; background:rgba(0,0,0,.75); color:#fff; font-size:19px; font-weight:800; padding:4px 10px; max-width:90%;}
  .box{position:absolute; z-index:6; border:3px dashed #ffd36b; box-shadow:0 0 0 2px rgba(0,0,0,.55);}
  .chipn{position:absolute; z-index:7; width:46px; height:46px; border-radius:50%; background:var(--crimson); color:#fff; font-weight:900; font-size:26px; display:flex; align-items:center; justify-content:center; border:3px solid #fff; box-shadow:0 4px 12px rgba(0,0,0,.6);}
  .legend{position:absolute; left:0; right:0; bottom:0; z-index:6; background:rgba(8,9,12,.92); border-top:4px solid var(--gold); padding:22px 60px 112px;}
  .legend div{display:flex; gap:14px; align-items:flex-start; font-size:25px; color:#f2ecdb; line-height:1.4; margin:6px 0; word-break:keep-all;}
  .legend b.n{flex:0 0 36px; height:36px; border-radius:50%; background:var(--crimson); color:#fff; font-size:21px; display:flex; align-items:center; justify-content:center;}
  .meta{position:absolute; left:70px; right:70px; z-index:6; background:rgba(244,236,216,.96); color:#1d2128; padding:30px 38px; border-top:12px solid #b3262f; box-shadow:0 24px 60px rgba(0,0,0,.75);}
  .meta .row{display:flex; gap:20px; border-top:1px dashed #b9ad92; padding:12px 0; font-size:27px; line-height:1.4;}
  .meta .row:first-of-type{border-top:none;}
  .meta .k{flex:0 0 170px; font-weight:900; color:#8a2a1f; font-size:23px; padding-top:3px;}
  .meta .v{flex:1; font-weight:700; word-break:keep-all; overflow-wrap:anywhere;}
  .try{font-family:Consolas,Menlo,monospace; font-size:22px; color:#bcd0f0; background:rgba(20,28,44,.9); border-left:6px solid #5b8def; padding:14px 18px; margin-top:16px; word-break:break-all;}
'''
E = html.escape
def img(p, md=1400, q=84):
    return f'{{{{img:{p}|maxdim={md}|q={q}}}}}'
def foot(n, k, total):
    return (f'<div class="brand" style="z-index:9; text-shadow:0 2px 8px #000;">KOREA ARCHIVE 통합검색 · <span style="color:#e8b45a;">30곳 탐방 {n:02d}</span></div>'
            f'<div class="pageno" style="z-index:9; color:#e5ddc9; text-shadow:0 2px 8px #000;">{k} / {total}</div>')
def head(it, part):
    return (f'<div class="kick"><span class="no">{it["n"]:02d}</span>{E(part[0])} {E(part[1])}</div>'
            f'<div class="inst">{it["flag"]} {E(it["inst"])}</div>')

def build(n):
    it = next(x for x in S1['items'] if x['n'] == n)
    part = next(p for p in S1['parts'] if p[2] <= n <= p[3])
    P = PLAN[f'{n:02d}']
    # 경로 규칙: 슬래시 없는 파일명 = img/NN/ 안, 슬래시 있으면 docs/promo/ 기준 상대경로(예: img2/x.jpg, series30v2/video/01/a.jpg)
    rel = lambda f: '../../../' + (f if '/' in f else f'series30v2/img/{n:02d}/{f}')
    cards = []
    # 1 히어로
    h = P['hero']
    fit = 'contain' if h.get('nocrop') else 'cover'
    bg = '#0a0a0a'
    cards.append(f'<div class="card" style="background:{bg}"><img class="bleed" src="{img(rel(h["file"]))}" style="object-fit:{fit}; object-position:{h.get("pos","center")}; {h.get("fx","")}"><div class="shade-top"></div>'
        f'<div class="topz">{head(it, part)}<div style="margin-top:14px;"><span class="say2">"{E(it["say"])}"</span></div></div>'
        f'<div class="bottom" style="padding-bottom:140px !important;"><div class="hook">{P["hook"]}</div></div>'
        f'<div class="foot"></div><div class="frame" style="z-index:7;"></div><div class="cr">{E(h["credit"])}</div>FOOT</div>')
    # 2 원본 모자이크
    if P.get('mosaic'):
        m = P['mosaic']; k = len(m)
        cls = {2: 'm2c', 3: 'm3c', 4: 'm22'}.get(k, 'm22')
        cells = ''.join(f'<div class="cell"><img src="{img(rel(c["file"]), 900, 82)}" style="object-fit:{"contain" if c.get("nocrop") else "cover"}; object-position:{c.get("pos","center")};"><div class="ml">{E(c["label"])}</div></div>' for c in m[:4])
        grid = f'grid-template-columns:1fr; grid-template-rows:repeat({k},1fr);' if P.get('mosaic_layout') == 'rows' else f'grid-template-rows:{"1fr 1fr" if k == 4 else "1fr"};'
        cards.append(f'<div class="card"><div class="mosaic {cls}" style="bottom:210px; {grid}">{cells}</div>'
            f'<div style="position:absolute; left:0; right:0; bottom:0; height:210px; background:#0a0c10; border-top:4px solid var(--gold); z-index:5;"></div>'
            f'<div class="hl" style="position:absolute; left:60px; right:60px; bottom:146px; z-index:8; font-size:38px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{P["mosaic_title"]}</div>'
            f'<div class="frame" style="z-index:7;"></div><div class="cr" style="bottom:84px; font-size:16px;">{E(P.get("mosaic_credit",""))}</div>FOOT</div>')
    # 3 설명(어노테이션) — 이미지 % 좌표를 그대로 쓰고, 세로가 넘치면 crop_y(이미지 비율)부터 잘라 좌표를 환산
    for a in ([P['ann']] if isinstance(P.get('ann'), dict) else P.get('ann', [])):
        from PIL import Image as _I
        iw, ih = _I.open(here.parent / (a['file'] if '/' in a['file'] else f'series30v2/img/{n:02d}/{a["file"]}')).size
        Hf = 1080 * ih / iw; H = min(Hf, a.get('max_h', 680), 1080 - (48 + len(a['boxes']) * 46 + 128)); v = H / Hf  # 범례 줄 수만큼 하단 확보(출처 줄과 겹침 방지)
        c = a.get('crop_y', (1 - v) / 2); c = max(0, min(c, 1 - v))
        posy = 0 if v >= 1 else c / (1 - v) * 100
        boxes = '' if a.get('nobox') else ''.join(f'<div class="box" style="left:{b["x"]}%; top:{(b["y"] - c * 100) / v:.2f}%; width:{b["w"]}%; height:{b["h"] / v:.2f}%;"></div>'
                        f'<div class="chipn" style="left:max(8px, calc({b["x"]}% - 20px)); top:max(8px, calc({(b["y"] - c * 100) / v:.2f}% - 20px));">{i}</div>' for i, b in enumerate(a['boxes'], 1))
        leg = ''.join(f'<div><b class="n">{i}</b><span>{E(b["t"])}</span></div>' for i, b in enumerate(a['boxes'], 1))
        if a.get('nobox'):  # 공공누리 제4유형(변경금지) — 원본 위에 표시를 얹지 않고 위치는 말로 안내
            H = 1080 - (48 + len(a['boxes']) * 46 + 128); boxes = ''; posy = 50
            leg = ''.join(f'<div><b class="n">{i}</b><span>{E(b["t"])}</span></div>' for i, b in enumerate(a['boxes'], 1))
        H = int(H)
        fitmode = 'contain' if a.get('nobox') else 'cover'
        cards.append(f'<div class="card" style="background:#0b0c10;"><div style="position:absolute; left:0; right:0; top:0; height:{H}px; overflow:hidden;">'
            f'<div style="position:relative; width:100%; height:100%;"><img src="{img(rel(a["file"]), 1600, 86)}" style="position:absolute; inset:0; width:100%; height:100%; object-fit:{fitmode}; object-position:center {posy:.1f}%;">{boxes}</div></div>'
            f'<div class="lab" style="left:60px; top:{H - 50}px; font-size:20px; z-index:8;">{E(a.get("title", "기록 해설 — 보이는 것만 읽었습니다"))}</div>'
            f'<div class="legend" style="top:{H}px;">{leg}</div><div class="frame" style="z-index:7;"></div><div class="cr">{E(a.get("credit", h["credit"]))}</div>FOOT</div>')
    # 4 영상 장면 해설(2×2) — 최대 2장
    for grp in P.get('scenes', []):
        cells = ''.join(f'<div class="cell"><img src="{img(rel(s["file"]), 900, 85)}"><div class="tc" style="left:10px; top:10px; font-size:24px;">{E(s["tc"])}</div><div class="scap">{E(s["cap"])}</div></div>' for s in grp['frames'][:4])
        cards.append(f'<div class="card"><div class="mosaic m22" style="bottom:200px;">{cells}</div>'
            f'<div style="position:absolute; left:0; right:0; bottom:0; height:200px; background:#0a0c10; border-top:4px solid var(--crimson); z-index:5;"></div>'
            f'<div class="kick" style="position:absolute; left:60px; right:60px; bottom:124px; z-index:8; font-size:22px; letter-spacing:.04em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">🎞 영상 장면 해설 · {E(grp["title"])}</div>'
            f'<div class="frame" style="z-index:7;"></div><div class="cr" style="bottom:84px; font-size:16px;">{E(grp["credit"])}</div>FOOT</div>')
    # 5 기록 카드(메타)
    rows = ''.join(f'<div class="row"><div class="k">{E(k)}</div><div class="v">{E(v)}</div></div>' for k, v in it['facts'])
    cards.append(f'<div class="card"><img class="bleed" src="{img(rel(h["file"]), 900, 70)}" style="filter:blur(14px) brightness(.38); transform:scale(1.1);">'
        f'<div class="topz">{head(it, part)}<div class="hl" style="font-size:50px; margin-top:22px;">{E(it["head"])}</div>'
        f'<div class="giant" style="font-size:112px; margin-top:8px;">{E(it["big"])}</div></div>'
        f'<div class="meta" style="top:{P.get("meta_top", 520)}px;">{rows}</div><div class="frame" style="z-index:7;"></div>'
        f'<div class="cr">조회 {E(S1["checked"])} 실측 · {E(it["tool"])}</div>FOOT</div>')
    # 6 직접 해 보기
    th = P.get('cta_img', h['file'])
    cards.append(f'<div class="card"><img class="bleed" src="{img(rel(th), 1000, 72)}" style="filter:grayscale(.4) brightness(.32);">'
        f'<div class="col" style="padding:110px 76px 160px; justify-content:center;"><div class="kick">직접 해 보기</div>'
        f'<div class="hl" style="font-size:60px; margin-top:16px;">이 한 문장이면 됩니다</div>'
        f'<div style="margin-top:28px;"><span class="say2" style="font-size:40px; padding:18px 30px;">"{E(it["say"])}"</span></div>'
        f'<div class="try">{E(it["tool"])}</div>'
        f'<div style="font-size:26px; color:#e5ddc9; margin-top:26px; line-height:1.6; word-break:keep-all;">KOREA ARCHIVE 통합검색 커넥터를 연결한 Claude에게 한국어로 말하면<br>9개국 30곳 문서고를 함께 찾고, 원본 링크와 권리까지 알려 줍니다.</div>'
        f'<div style="font-size:22px; color:var(--gold); margin-top:22px; overflow-wrap:anywhere;">원문 ↗ {E(it["link"])}</div></div>'
        f'<div class="frame" style="z-index:7;"></div>FOOT</div>')
    total = len(cards)
    cards = [c.replace('FOOT', foot(n, k, total)) for k, c in enumerate(cards, 1)]
    out = here / 'build' / f'{n:02d}'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'source.html').write_text(f'<!DOCTYPE html>\n<html lang="ko"><head><meta charset="UTF-8"><title>{n:02d}</title><style>{css}</style></head><body>\n' + '\n\n'.join(cards) + '\n</body></html>\n', encoding='utf-8')
    return total

if __name__ == '__main__':
    ns = [int(x) for x in sys.argv[1:]] or sorted(int(k) for k in PLAN)
    for n in ns:
        print(n, build(n))
