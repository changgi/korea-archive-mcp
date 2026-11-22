#!/usr/bin/env python3
"""시리즈 폴더 하나를 끝까지 만든다: plan.json → 카드 렌더 → NNN_kk.jpg → caption.txt → NNN.zip → _sheet.jpg(육안 검수용).
사용: python3 build_series.py <시리즈 폴더> [--only 1,3]   (예: ../s031)"""
import sys, json, re, subprocess, pathlib, zipfile, glob, os, shutil
from PIL import Image
KIT = pathlib.Path(__file__).parent
MC = '/home/user/korea-archive-mcp/.claude/skills/insta-carousel/scripts/make_carousel.py'
sd = pathlib.Path(sys.argv[1]).resolve()
only = sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else None
P = json.loads((sd / 'plan.json').read_text(encoding='utf-8')); n = int(P['n'])
subprocess.run([sys.executable, str(KIT / 'gen_v3.py'), str(sd)], check=True)
cmd = [sys.executable, MC, str(sd / 'build' / 'source.html'), '--outdir', str(sd / 'build'), '--browser', '/usr/bin/google-chrome'] + (['--only', only] if only else [])
r = subprocess.run(cmd, capture_output=True, text=True); print(r.stdout[-400:]); 
if r.returncode: print(r.stderr[-800:]); sys.exit(1)
for f in sorted(glob.glob(str(sd / 'build' / 'png' / 'card_*.png'))):
    k = os.path.basename(f)[5:7]
    Image.open(f).convert('RGB').save(sd / f'{n:03d}_{k}.jpg', quality=88, optimize=True); os.remove(f)
for d in ('png', 'cards'): shutil.rmtree(sd / 'build' / d, ignore_errors=True)
(sd / 'build' / 'carousel.html').unlink(missing_ok=True)
# 소개글
plain = lambda s: re.sub(r'<[^>]+>', '', s.replace('<br>', ' ')).strip()
L = [f'[KOREA ARCHIVE 탐방 {n:03d} · {P["part"][0]} {P["part"][1]}] {P["flag"]} {P["inst"]}', '', plain(P['hook']), '', f'💬 "{P["say"]}" — 이 한 문장으로 찾았습니다.', '']
anns = [P['ann']] if isinstance(P.get('ann'), dict) else P.get('ann', [])
if anns:
    L.append('🔎 기록에서 직접 읽은 것'); L += [f'{i}. {b["t"]}' for i, b in enumerate(anns[0]['boxes'], 1)]; L.append('')
for g in P.get('scenes', []):
    L.append(f'🎞 영상 장면 해설 — {g["title"]}'); L += [f'{f["tc"]} {f["cap"]}' for f in g['frames']]; L.append('')
if P.get('mosaic'): L += ['🗂 함께 찾은 원본: ' + ' / '.join(c['label'] for c in P['mosaic']), '']
L.append('📌 기록 정보'); L += [f'· {k}: {v}' for k, v in P['facts']]
L += ['', '출처·권리', f'· {P["hero"]["credit"]}'] + ([f'· {P["mosaic_credit"]}'] if P.get('mosaic_credit') else []) + [f'· {g["credit"]}' for g in P.get('scenes', [])]
L += [f'· 원문: {P["link"]}', '', '모든 이미지는 실제 기록 원본입니다(AI 생성 이미지 0). 권리는 소장기관 표기를 직접 확인했습니다.',
      '👉 직접 해 보기: 프로필 링크 → KOREA ARCHIVE 통합검색 커넥터 연결 후 위 문장을 그대로 말해 보세요.', '',
      P.get('tags', '') + ' #KOREAARCHIVE #기록 #아카이브 #한국사 #100선탐방']
(sd / 'caption.txt').write_text('\n'.join(L) + '\n', encoding='utf-8')
jpgs = sorted(glob.glob(str(sd / f'{n:03d}_*.jpg')))
with zipfile.ZipFile(sd / f'{n:03d}_set.zip', 'w', zipfile.ZIP_STORED) as z:
    for f in jpgs + [str(sd / 'caption.txt')]: z.write(f, os.path.basename(f))
# 육안 검수용 시트(2열)
ims = [Image.open(f).resize((540, 540)) for f in jpgs]
rows = (len(ims) + 1) // 2; sh = Image.new('RGB', (1084, rows * 544), 'white')
for i, im in enumerate(ims): sh.paste(im, ((i % 2) * 544, (i // 2) * 544))
sh.save(sd / '_sheet.jpg', quality=80)
print(f'OK {n:03d}: {len(jpgs)} cards → {sd}/_sheet.jpg  (Read로 반드시 육안 검수)')
# IIIF 갤러리 자동 갱신 — 시리즈를 만들면 docs/iiif(매니페스트·이미지·썸네일)도 함께 갱신(바뀐 이미지만). 건너뛰려면 NO_IIIF=1
if not os.environ.get('NO_IIIF'):
    import subprocess, sys as _sys
    _b = pathlib.Path(__file__).resolve().parents[2] / 'build_iiif.py'
    if _b.exists():
        r = subprocess.run([_sys.executable, str(_b)], capture_output=True, text=True)
        print('IIIF 갤러리:', (r.stdout.strip().splitlines() or ['?'])[-1] if r.returncode == 0 else '갱신 실패 — ' + r.stderr.strip()[-200:])
