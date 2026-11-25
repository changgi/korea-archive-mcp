# 30곳 탐방 v2 — 원본 이미지 수집 브리프 (에이전트 공용)

목표: 수집처 30곳마다 인스타그램 캐러셀(5~7장)을 만든다. "원본 이미지가 화면을 가득 채워야" 하고, "글보다 이미지로 설득"해야 한다.
각 시리즈에 필요한 것:
1. **히어로 원본 1장** — 그 수집처에서 찾은 기록의 실물 이미지(사진·문서 면·지도·포스터·지면), 가능한 한 긴 변 ≥1000px
2. **추가 원본 3~6장** — 같은 기록의 다른 면/같은 시리즈·인접 기록의 실물 이미지(모자이크용)
3. **설명 포인트 3~5개** — 이미지 안에서 *눈에 보이는 것*(글자·건물·인물 수·물건)과 기록 메타데이터 원문(제목·날짜·번호·작성자)만. 추정 금지("~로 보인다" 금지).
4. 영상 기록이면: 내려받을 수 있는 영상 파일 직링크(mp4 등)·길이·권리를 보고(프레임 추출은 메인이 한다 — 영상은 내려받지 말 것)

## 권리 규칙 (위반 시 사용 금지)
- 사용 가능: NARA judge_rights(naid) "Unrestricted"(A) 또는 연방정부 저작물 'Undetermined'(B, 명기) · AWM "Copyright expired - public domain" · 공공누리 제1유형(변경 가능) · 제4유형은 **자르지 않고 원형 그대로**만(파일명에 _nocrop) · Public Domain/CC0/PDM · CC BY/BY-SA(저작자 표기) · 1950년 이전 공표 저작물로 보호기간 만료가 명확한 것(근거 기록) · 기관 이용약관이 출처 표기 조건 재사용을 허용하는 것(약관 문구 인용)
- 사용 금지: In Copyright(InC, InC-EDU 포함)·권리 불명·"Restricted"·AI 생성물
- 존엄: 포로·묘지·추모식·시신·수형자 사진(머그샷) 제외
- 접근: 봇 차단 우회 금지(쿠키 예열·UA 위장 반복·프록시 우회 금지). 429/403이면 멈추고 보고. Wikimedia(upload.wikimedia.org)는 요청 사이 6초 이상, 전체 15회 이내. 썸네일은 `https://commons.wikimedia.org/w/thumb.php?f=<파일명>&w=1280`.
- 국립중앙도서관 신문 지면: `https://nl.go.kr/newspaper/coverImage.do?paper=<신문명>&date=<YYYYMMDD>&file=<신문명>_<YYYYMMDD>_<면 2자리>.png` + 헤더 `Referer: https://nl.go.kr/newspaper/detail.do?content_id=<CNTS-…>`(한글 그대로)

## 도구
- 프로덕션 MCP 호출 클라이언트: `python3 /tmp/claude-0/-home-user/3490ea4c-172d-51a8-a338-7f5bdcff1d24/scratchpad/s30/mcpc.py jobs.json out.json`
  jobs.json = `[{"key":"k","tool":"cross_search","args":{"query":"…","sources":"nara","max_per_source":5}}]`
  도구: cross_search · nara_search · judge_rights(naid=) · nedb_search(mode=…) · ia_search(identifier=) · europeana_search · tna_search · koreanwar_item(ref_code=) · seoul_archives_search · nlk_search · archives_search
- NARA 원본 이미지: judge_rights(naid) 응답의 "디지털 객체" URL(catalog.archives.gov/medialz/… 또는 S3) — 원본 해상도로 받기
- curl/python 사용 가능. 이미지 확인은 Read 도구로 직접 눈으로 볼 것(무엇이 찍혔는지 확인 후 존엄 규칙 적용).

## 산출 (반드시 이 형식)
- 파일: `/home/user/korea-archive-mcp/docs/promo/series30v2/img/<NN>/<짧은이름>.jpg|png` (NN=시리즈 번호 2자리). 4000px 넘으면 긴 변 2400px로 줄여 저장(Pillow), 품질 88.
- 대장: `/home/user/korea-archive-mcp/docs/promo/series30v2/img/<NN>/ledger.json`
```json
{"n":1,"src":"nara","record":{"id":"NAID 75392","title":"…","date":"…","inst":"…","url":"…"},
 "images":[{"file":"hero.jpg","role":"hero|extra|page","record_id":"…","title":"…","date":"…","url":"원문 페이지","rights":"A — Unrestricted","rights_evidence":"judge_rights 응답 문구 또는 약관 문구","w":0,"h":0,"visible":["눈에 보이는 사실 1","…"],"nocrop":false}],
 "points":["설명 포인트(출처 원문 기반) …"],
 "video":{"url":"","length_s":0,"rights":"","note":""},
 "status":"ok|partial|blocked","notes":"막힌 경로·대체 경로·남은 문제"}
```
- 이미지가 정말 하나도 없는 수집처면 기록 원문 페이지를 Playwright로 1280×1280 캡처(`chromium.launch()`, deviceScaleFactor 1)해 role "page"로 넣고 rights에 "기관 웹페이지 캡처 — 출처 표기"라고 쓴다(캡처는 최후 수단).
- 끝나면 시리즈별 status와 확보 장수, 막힌 곳을 짧게 보고.
