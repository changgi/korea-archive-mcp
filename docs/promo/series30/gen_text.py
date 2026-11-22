#!/usr/bin/env python3
"""series.json → captions.txt · schedule.md · sources.txt"""
import json, pathlib
here = pathlib.Path(__file__).parent
d = json.loads((here / 'series.json').read_text(encoding='utf-8'))
TAG = {'nara':'#NARA #미국국립기록관리청','koreanwar':'#6_25전쟁아카이브센터 #장진호','awm':'#호주전쟁기념관 #가평전투','nzarch':'#뉴질랜드 #케이포스','nlna':'#네덜란드 #참전국',
 'un':'#UN #정전협정','tna':'#영국국립기록관 #거문도사건','gallica':'#Gallica #프랑스국립도서관','europeana':'#Europeana #유럽','oldnews':'#대한매일신보 #단지동맹','nedb':'#한국사데이터베이스 #거문도',
 'commons':'#위키미디어공용 #흥남철수','indy':'#독립운동판결문 #유관순','gonghun':'#공훈전자사료관 #윤봉길','i815':'#독립기념관 #안창호','jacar':'#JACAR #삼일운동','earchive':'#전자사료관 #미군정',
 'ndl':'#국립국회도서관 #경성','jsg':'#장서각 #의궤','kyudb':'#규장각 #대동여지도','aks':'#한국고문서자료관 #고문서','heritage':'#국가유산 #근정전','nlk':'#국립중앙도서관 #훈민정음',
 'archives':'#국가기록원 #새마을운동','ktv':'#대한뉴스 #KTV','much':'#대한민국역사박물관 #포스터','seoul':'#서울기록원 #청계천','foia':'#정보공개 #원문공개','ia':'#인터넷아카이브 #흥남철수','dnz':'#DigitalNZ #가평'}
COMMON = '#KOREAARCHIVE #기록 #아카이브 #한국사 #30곳탐방'
cap = ['30곳 문서고 탐방 — 게시글 캡션 (KOREA ARCHIVE 통합검색)', f'모든 결과·수치: {d["checked"]} 실제 도구 호출 확인 · 출처는 sources.txt', '=' * 60, '',
       '[00 표지]', '한국어 한 문장으로, 9개국 30곳 문서고를 엽니다.',
       '미국 국립기록관리청부터 서울기록원까지 — 한 곳씩, 30일 동안 소개합니다.',
       '모든 카드의 기록은 실제로 조회해 확인한 원본입니다. AI로 만든 이미지는 없습니다.', '', COMMON + ' #한국전쟁 #독립운동', '']
for it in d['items']:
    facts = '\n'.join(f'· {k}: {v}' for k, v in it['facts'])
    cap += [f'[{it["n"]:02d}] {it["flag"]} {it["inst"]}', f'💬 "{it["say"]}"', '', f'{it["head"]} — {it["big"]}', facts, '',
            f'출처: {it["credit"]}', f'원문: {it["link"]}', '직접 해 보기 👉 프로필 링크 (커넥터 연결 후 위 문장 그대로)', '', f'{TAG[it["src"]]} {COMMON}', '-' * 60, '']
(here / 'captions.txt').write_text('\n'.join(cap), encoding='utf-8')
sch = ['# 30곳 문서고 탐방 — 30일 게시 일정', '', '- 하루 한 곳, 단독 게시물(1080×1080 1장). 표지는 0일차(시작 전날)에 게시하고 프로필 상단 고정.',
       '- 부(部)가 바뀌는 날은 스토리로 "이번 주 테마" 예고.', '- 게시 시각 제안: 저녁 8시(평일) · 오전 10시(주말).', '',
       '| 일차 | 카드 | 부 | 기관 | 질문 |', '|---|---|---|---|---|', '| 0 | s00_cover.png | — | 표지 | 30곳 문서고 탐방 |']
for it in d['items']:
    p = next(p for p in d['parts'] if p[2] <= it['n'] <= p[3])
    sch.append(f'| {it["n"]} | s{it["n"]:02d}.png | {p[0]} {p[1]} | {it["flag"]} {it["inst"]} | {it["say"]} |')
sch += ['', '## 운영 메모', '- 게시 전날 해당 카드의 "원문" 링크를 한 번 열어 살아 있는지 확인(링크 실확인 원칙).',
        '- 댓글로 "우리 동네/우리 집안 기록도 찾아줘" 요청이 오면 같은 형식으로 후속 카드 제작.',
        '- 08·28(대체 경로)은 "막힌 곳도 숨기지 않는다"는 신뢰 메시지로 활용.']
(here / 'schedule.md').write_text('\n'.join(sch) + '\n', encoding='utf-8')
src = ['출처·권리 대장 — 30곳 문서고 탐방 (KOREA ARCHIVE 통합검색)', f'확인일: {d["checked"]} · 방법: 프로덕션 MCP 서버 실제 도구 호출(아래 "호출") · 수치·제목·번호는 응답 원문 그대로',
       '이미지 원칙: 실물 기록만 — AI 생성 이미지 0장. 권리를 확인한 원본 11장만 사용, 나머지 19장은 조회 결과 텍스트로 만든 기록 카드',
       '존엄 원칙: 포로·묘지·추모식·수형자 사진 제외', '=' * 60, '']
for it in d['items']:
    src += [f'[{it["n"]:02d}] {it["inst"]} — {it["head"]}', f'  호출: {it["tool"]}', f'  원문: {it["link"]}',
            f'  카드 이미지: {"(이미지 없음 — 기록 카드)" if not it.get("img") else it["img"].replace("../", "docs/promo/")}', f'  표기: {it["credit"]}']
    if it.get('imglab'): src.append(f'  ※ 이미지 성격: {it["imglab"]} (카드에 명기)')
    src.append('')
src += ['[이미지 권리 근거]',
 '- NARA 520781·520782·542210·520995: judge_rights(naid) Use Restriction "Unrestricted" 실조회(A) — 상세 docs/promo/sources_images.txt',
 '- AWM C276864·C1094311: 상세 페이지 "Copyright expired - public domain"',
 '- 대한매일신보 1908.5.6 2면: 국립중앙도서관 대한민국신문아카이브 제공 지면 이미지(1908년 발행, 저작권 만료) — 출처 표기',
 '- 화성성역의궤: 국립중앙박물관 e뮤지엄, 공공누리 제1유형 (nedb_search commons 판독 A)',
 '- 1906 경복궁·1930년대 경성 거리: 위키미디어 공용 Public domain',
 '- 협약기관 기록(02): KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 출처 표기']
(here / 'sources.txt').write_text('\n'.join(src) + '\n', encoding='utf-8')
print('ok', len((here / 'captions.txt').read_bytes()))
