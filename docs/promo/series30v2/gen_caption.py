#!/usr/bin/env python3
"""시리즈별 인스타그램 소개글(caption.txt) — plan.json·series.json·ledger에서 생성. 사실은 전부 원 데이터에서."""
import json, re, pathlib, sys
here = pathlib.Path(__file__).parent
S1 = json.loads((here.parent / 'series30' / 'series.json').read_text(encoding='utf-8'))
PLAN = json.loads((here / 'plan.json').read_text(encoding='utf-8'))
TAGS = {'nara':'#NARA #미국국립기록관리청 #흥남철수','koreanwar':'#6_25전쟁아카이브센터 #장진호','awm':'#호주전쟁기념관 #가평전투','nzarch':'#뉴질랜드 #케이포스','nlna':'#네덜란드 #참전국',
 'un':'#UN #안보리결의','tna':'#영국국립기록관 #거문도사건','gallica':'#Gallica #프랑스국립도서관','europeana':'#Europeana #유럽','oldnews':'#대한매일신보 #단지동맹','nedb':'#한국사데이터베이스 #거문도',
 'commons':'#위키미디어공용 #저작권','indy':'#독립운동판결문 #유관순','gonghun':'#공훈전자사료관 #윤봉길','i815':'#독립기념관 #안창호','jacar':'#JACAR #삼일운동','earchive':'#전자사료관 #미군정',
 'ndl':'#국립국회도서관 #경성','jsg':'#장서각 #의궤','kyudb':'#규장각 #대동여지도','aks':'#한국고문서자료관 #고문서','heritage':'#국가유산 #근정전','nlk':'#국립중앙도서관 #훈민정음',
 'archives':'#국가기록원 #새마을운동','ktv':'#대한뉴스 #KTV','much':'#대한민국역사박물관 #포스터','seoul':'#서울기록원 #청계천','foia':'#정보공개 #원문공개','ia':'#인터넷아카이브 #영상분석','dnz':'#DigitalNZ #뉴질랜드'}
plain = lambda s: re.sub(r'<[^>]+>', '', s.replace('<br>', ' ')).strip()
def cap(n):
    it = next(x for x in S1['items'] if x['n'] == n); P = PLAN[f'{n:02d}']
    part = next(p for p in S1['parts'] if p[2] <= n <= p[3])
    L = [f'[30곳 문서고 탐방 {n:02d}/30 · {part[0]} {part[1]}] {it["flag"]} {it["inst"]}', '', plain(P['hook']).replace(' ,', ','), '',
         f'💬 "{it["say"]}" — 이 한 문장으로 찾았습니다.', '']
    if P.get('ann'):
        a = P['ann'] if isinstance(P['ann'], dict) else P['ann'][0]
        L.append('🔎 사진(문서)에서 직접 읽은 것')
        L += [f'{i}. {b["t"]}' for i, b in enumerate(a['boxes'], 1)]
        L.append('')
    if P.get('scenes'):
        L.append('🎞 영상 장면 해설 (장면 전환 자동 탐지 → 대표 장면)')
        for g in P['scenes']:
            L += [f'{f["tc"]} {f["cap"]}' for f in g['frames']]
        L.append('')
    if P.get('mosaic'):
        L.append('🗂 함께 찾은 원본: ' + ' / '.join(c['label'] for c in P['mosaic']))
        L.append('')
    L.append('📌 기록 정보')
    L += [f'· {k}: {v}' for k, v in it['facts']]
    L += ['', '출처·권리', f'· {P["hero"]["credit"]}']
    if P.get('mosaic_credit'): L.append(f'· {P["mosaic_credit"]}')
    for g in P.get('scenes', []): L.append(f'· {g["credit"]}')
    L += [f'· 원문: {it["link"]}', '', '모든 이미지는 실제 기록 원본입니다(AI 생성 이미지 0). 권리는 소장기관 표기를 직접 확인했습니다.',
          '👉 직접 해 보기: 프로필 링크 → KOREA ARCHIVE 통합검색 커넥터 연결 후 위 문장을 그대로 말해 보세요.', '',
          f'{TAGS[it["src"]]} #KOREAARCHIVE #기록 #아카이브 #한국사 #30곳탐방']
    return '\n'.join(L) + '\n'
if __name__ == '__main__':
    for k in (sys.argv[1:] or sorted(PLAN)):
        n = int(k); out = here / 'build' / f'{n:02d}'; out.mkdir(parents=True, exist_ok=True)
        (out / 'caption.txt').write_text(cap(n), encoding='utf-8'); print(n, len(cap(n)))
