# KOREA ARCHIVE 통합검색 — 유지·관리 안내

이 문서는 **처음 맡는 사람도 이 도구를 계속 살아 있게** 하기 위한 것이다. 개발 원칙은 [CLAUDE.md](CLAUDE.md), 변경 이력은 자매 저장소 `korea-archive-marketplace/CHANGELOG.md`.

## 1. 구조 한눈에

| 위치 | 역할 | 비고 |
|---|---|---|
| `app/api/[transport]/route.js` | **원본** — Vercel 원격 MCP 서버(Node). 도구 20종 | main 병합 = Vercel 자동 배포(icn1) |
| `lib/` | 권리 판정(`rights.js`)·기관 프로파일·키워드 | |
| `korea-archive-marketplace/plugins/korea-archive/servers/server.py` | Python 플러그인 서버 — **원본과 같은 동작(패리티)** | |
| `korea-archive-marketplace/mcp/server.py` | 위 파일의 본문 사본(머리말만 다름) | `python3 scripts/splice_mcp.py`로만 갱신 |
| `docs/` | GitHub Pages(소개·30곳 탐방·100선·IIIF 갤러리) | Pages 원본 폴더 = `/docs` |
| `public/` | Vercel 정적 파일(도움말·원장·NZ 정적 인덱스) | |
| `tests/golden.json` | 골든 회귀 케이스 — 도구 출력의 **모양** | `python3 scripts/golden.py` |
| `lib/nara_iiif.js` · `app/iiif/nara/[...p]/route.js` | **NARA→IIIF 브리지** — `/iiif/nara/{NAID}/manifest.json`·`/collection.json`·`/record.jsonld`(RiC-O) | NARA_API_KEY 사용, 6시간 캐시, CORS * |
| `lib/ka_iiif.js` · `app/iiif/[src]/[...p]/route.js` | **IIIF 브리지 2** — `/iiif/{heritage\|much\|awm\|commons}/{id}/manifest.json` | 서울 리전(icn1) · 정직한 UA · 6시간 캐시 |
| `lib/ka_iiif.js` `nrich` | **국립문화유산연구원 IIIF 브리지** — `/iiif/nrich/{키}-{번호}/manifest.json`(이미지 데이터셋 14종 + ov, 이미지 없으면 기록 카드): 명칭·해설·권리=데이터셋별 정적 색인 `docs/data/nrich/<키>.jsonl`, 이미지·상세 항목=원 페이지(원본 그대로) | 색인은 nrich-harvest가 주 1회 분할 저장 |
| `lib/rec_iiif.js` · `app/iiif/rec/[...p]/route.js` | **기록 봉투 IIIF** — IIIF가 없는 모든 기록 → `/iiif/rec/{token}/manifest.json`·`card.svg`·`record.jsonld`(토큰=봉인된 기술, 서버 저장 없음) | KV `#c=` 압축 컬렉션 링크 |
| `lib/tna_iiif.js` · `app/iiif/tna/[...p]/route.js` | **TNA→IIIF** — 실제 계층(parentId) 재구성 매니페스트·하위 컬렉션 | 부모 기술 6시간 캐시 · 컬렉션 1회 TNA 2~8요청 |
| `app/export/csv/[tok]/route.js` | **검색 결과 CSV 내려받기** — `cross_search(format='csv')` 응답의 📥 링크. 토큰=CSV 본문 압축(서버 저장 없음), 엑셀용 BOM | 24KB·URL 12,000자 넘으면 링크 생략 |
| `lib/ledger.js` · `app/api/ledger/[day]/route.js` · `scripts/ledger_merge.py` | **발견 누적 원장** — cross_search 발견 기록(검색어·사용자 정보 없음)을 Upstash Redis 날짜 함(3일 보관)에 적재 → 매일 `ledger` 워크플로가 공개 읽기 주소에서 꺼내 `docs/data/`(discovered.jsonl·csv·jsonld·collection.json·index.html)에 병합·커밋 | 무료(Upstash Free 월 50만 명령 ≈ 하루 8천 검색). 미설정·한도 초과면 적재만 생략 |
| `docs/data/nrich/` | 연구원 연구DB — `<키>.jsonl`(분할 색인) · `iiif/`(계층 컬렉션: 데이터셋 › 지역·소장처·분류 › 기록) · `people.json`(인물 색인 — 찬·서·화가·화승·저자, 한자 NFKC 정규화) · `export/<키>.csv`·`.jsonld`(RiC-O, 인물=rico:Person) · `index.html` | `nrich_harvest.py`(주간) · 파생물만: `--derived` |
| `docs/iiif/` | 갤러리 IIIF — `hierarchy.json`(부›시리즈›이미지)·`collection.json`(평면)·`all.json`·`m/`·`c/` + 데이터 `records.csv`·`records.jsonld` | `build_iiif.py`가 생성(`_nara_ctx.json`=NARA 계보 캐시) |

원장 보강 = 병합 때 기관 IIIF·우리 브리지 매니페스트를 하루 `ENRICH_MAX`(기본 80)건 순차 판독해 `summary`(주요 내용)·`meta`(메타정보 8항목)·`rights`·`thumb`를 채운다(실패는 다음 날 재시도). 매니페스트가 없는 국가기록원 기록은 공개 상세 페이지를 1회 판독해 메타정보(관리번호·문서유형·보존기간·서고·매체 등)와 **실제 계층**(국가기록원 › 기록물계열 › 상위 철)을 구축한다(`enrich_archives`). 그 밖의 매니페스트 없는 출처(i815·indy·gonghun·jacar·oldnews·un·jsg·ktv·koreanwar·seoul)는 **우리 서버의 심층 판독 도구를 그대로 호출**해(`DEEP` 표, `X-KA-Probe: ledger` — 적재 안 함) 주요 내용·메타정보·본문 지문·원문 뷰어를 채운다 — 파서는 서버 한 곳에만 있고 골든 검사가 지킨다. 호출문은 `deep_call`에 남아 재현 가능. 썸네일은 재이용 가능 표시(PD·CC·NoC·공공누리·저작권 만료)·NARA·우리 갤러리·우리 카드만 싣고, 포로·사망자·묘지·수형자 관련 기록은 링크만(`SENSITIVE` 정규식). 국가기록원 링크는 `&amp;` 해제·https로 정규화(`archLink`/`_arch_link`, 원장은 `clean_url`로 소급).

국외 소재 교차확인 = 검색 때 `linkOverseas`(Python `_link_overseas`)가 okchf·nrich의 '명칭(괄호·한자 제거)+소장처(별칭 표 `OV_ALIAS`)' 동일 기록을 한 건으로 묶고(출처 둘 다·sameAs), 원장 병합 때 tree.html '국외 소장처 교차 보기'·`overseas_holders.csv`가 소장처별 두 DB 수록 범위를 보여 준다. 소장처 별칭이 새로 보이면 `OV_ALIAS`(양쪽)와 `ledger_merge.py` ALIAS에 추가.

계층구조도 = 병합 때 `build_tree`가 원장 전체를 '기관 › partOf 단계 › 기록'으로 묶어 `tree.html`(접이식)·`tree.json`·`hierarchy.json`(IIIF 중첩 컬렉션)·`h/<기관>.json`(기관별 — KV로 계층 열람)을 만든다. 계층이 없는 기록은 '(계열 미상)'(붉은색)으로 드러나 보강 대상이 된다.

원장 중복 처리 = 같은 기록이 다시 발견되면 새 줄 대신 **활용 컬럼**을 갱신한다: `seen`(전체)·`seen_7d`·`seen_30d`·`days_total`(발견된 날 수)·`days`(날짜별 90일)·`formats`(text·csv·iiif·manifest·karda)·`max_cross`(교차확인 기관 수)·`trend`·`score`·`rank`. 자주 활용 TOP 200=`docs/data/popular.csv`, 일별 추이=`usage.json`. 자동 검사(golden.py·health.yml)는 `X-KA-Probe` 헤더로 표시되어 적재하지 않는다 — 새 자동 호출을 만들 때도 이 헤더를 붙일 것.

발견 누적 원장도 수집처다 — `cross_search(sources='ledger')`가 `docs/data/discovered.jsonl`을 1시간 캐시로 검색(발견 횟수·처음 발견일 표시). 'all'에는 넣지 않는다(원 기관 결과와 중복·교차확인 오인 방지), 원장에서 다시 찾은 기록은 재적재하지 않는다.

우리 IIIF 갤러리도 수집처다 — `cross_search(sources='gallery')`가 `docs/iiif/index.json`(Pages)을 6시간 캐시로 검색하고, `format='iiif'`면 시리즈 매니페스트(`iiif/m/sNNN.json`)를 컬렉션에 넣는다.

수집처 하나 = route.js의 `COLLECT.<이름>`(연합 검색) + 필요하면 `nedb_search` 등의 `mode` 분기(심층 판독). Python은 `_c_<이름>`·`_<이름>_mode`.

## 2. 자동 감시 — 사람이 매일 보지 않아도 되는 이유

| 워크플로 | 언제 | 무엇을 | 실패하면 |
|---|---|---|---|
| `verify` | 모든 push·PR | 구문·도구 20종·설명 1024자·24KB 가드·**Python 패리티·본문 사본 일치**·**Pages 링크·IIIF 이미지 무결성**·골든 파일 형식 | PR 빨간불 |
| `golden` | main 반영 직후(배포 대기 150초) · 매주 수 | 프로덕션 도구 18케이스 출력 구조(제목 전체·해제·표기 변형·IIIF·24KB) | **`auto-health` 이슈 자동 생성/갱신**, 다음에 통과하면 자동 종료 |
| `health` | 매주 월 | 30채널 골든 질의 + 같은 기록 묶기 회귀 | `auto-health` 이슈 |
| `fixity-watch` | 매주 화 | 골든 기록 본문 지문(sha256-16) — 원문 개정 감지 | 원장(`public/fixity-ledger.json`) 이력 커밋 + 실패 |
| `ledger` | 매일 00:17 KST | 발견 누적 원장 병합(`docs/data/`) — 처리 위치 `_state.json`, 최근 3일 함 | 실패 시 `auto-health` 이슈('발견 원장 병합', 3일 안에 조치 — 함 3일 보관), 정상이면 자동 종료 |
| `nrich-harvest` | 매주 수 02:41 KST | 국립문화유산연구원 Open API 21종(30,647건) → `docs/data/nrich_db.jsonl`(정적 색인)·파생물 | **품질 관문**: 건수 30%↓ 또는 URL 채움 90%↓ 데이터셋은 지난 색인 유지 + `auto-health` 이슈('연구원 색인 수집'), 정상이면 자동 종료 |
| `relevance` | 매주 목 03:23 KST | **관련성 감사**(`scripts/relevance_audit.py`) — 33개 수집처 골든 질의 결과에 검색어·인정 번역어가 있는지, 옛 오답 패턴(크롤링 묶음·메뉴 오인) 재발 여부 | `auto-health` 이슈('관련성 감사'), 통과하면 자동 종료 |
| `retry-blocked` · `nz-harvest` | 매주 화 | 차단 채널 재탐침 · NZ 정적 인덱스 갱신 | 실행 요약 |
| Dependabot | 매월 | npm(마이너·패치만)·Actions 의존성 갱신 PR | verify의 **실제 빌드(next build)**가 병합 전 검증 |

**할 일은 하나** — 저장소 Issues에서 `auto-health` 라벨을 본다. 한눈 점검은 `source_profile('health')` — 30채널 + **자동 파이프라인 신선도**(연구원 색인 9일·원장 2.5일 넘으면 🔴). 열려 있으면 아래 3절.

### 영구 축적 원칙(v2.26) — 축적된 정보는 지우지 않는다(중복만 정리)

| 축적물 | 위치 | 중복 처리 | 지우지 않는 방식 |
|---|---|---|---|
| 질의·회신(모든 도구 호출) | Redis `ka:q:<날짜>`(3일) → `docs/data/queries/YYYY-MM.jsonl.gz` + `queries/index.json` | 같은 도구·같은 인자·같은 회신 지문(h)이면 `seen`·`last`만 갱신 | 회신이 바뀌면 **새 판**으로 보존 — 기관 응답 변화 이력(증거성) |
| 발견 기록 | `docs/data/discovered.*` | 같은 key면 횟수·날짜만 | `days` 이력 전 기간 보존(90일·400일 잘라내기 폐지) |
| 분류·계층 경로 | `docs/data/classifications.json` | 같은 경로면 갱신 | 사라진 경로도 보존, `records`는 줄지 않음 |
| 연구원 연구DB | `docs/data/nrich/*.jsonl` | 같은 (데이터셋,id)면 새 값 | 원 기관에서 사라진 기록은 `withdrawn: <처음 사라진 날>`로 보존 |

- **원문 그대로(v2.26.1, 소유자 결정)**: 질의 인자·회신 본문은 어떤 패턴도 지우거나 바꾸지 않는다 — 질의·회신은 일반 기록에서 수집되는 기록 자체이므로 원형 보존이 증거성의 조건. 공개 저장소에 그대로 남는다는 사실은 cross_search 안내문으로 사용자에게 고지한다. `lib/ledger.js`의 `scrub()`은 쓰지 않는다(필요 시 공개본과 분리된 별도 저장소에서만 검토).
- 자동 검사(X-KA-Probe) 호출은 적재하지 않는다. Python 로컬 플러그인은 Redis가 없어 질의 축적 대상이 아니다(원격 서버 전용).

## 3. 사이트가 바뀌었을 때 (가장 흔한 장애)

1. 이슈/실행 요약에서 **어느 케이스·채널**인지 확인 (`golden` 표의 `문제` 칸 = 빠진 패턴).
2. 실제 응답 확인: `python3 scripts/golden.py --only <케이스id>` 또는 프로덕션 MCP 호출. 원 사이트 HTML/JSON을 직접 받아 **구조 변화**를 본다(검색 파라미터·태그·클래스명).
3. 접근이 막혔다면(403·429·WAF·TLS 리셋) **우회하지 않는다** — UA 위장·쿠키 데우기·프록시·러너 우회 금지. 결과에 "기술적 불능 + 브라우저 대체 경로"를 표시하는 것이 원칙(CLAUDE.md 발굴 우선 원칙).
4. 파서를 **양쪽**(route.js · server.py)에서 고친다 → `node --check`(`.mjs` 사본) · `py_compile` · `node scripts/ci-verify.mjs` · `node scripts/ci-parity.mjs ../korea-archive-marketplace`.
5. 고친 동작을 `tests/golden.json`에 **케이스로 추가**(옛 결함 출력이 걸리는 `must_not`까지). 다음 개편 때 자동으로 잡힌다.
6. CHANGELOG 기록 → 두 저장소 커밋·푸시 → main 반영 → `golden`이 배포 후 자동 재검사.

### 알려진 접근 제약 (2026-11 실측)
- 정보공개포털(open.go.kr) 원문정보 — 기관 점검 중(2026.11.12~). foia는 청구 경로 안내로 대체.
- Gallica — 서버 IP 자동 조회 403, BnF 카탈로그(catalogue.bnf.fr)도 연결 불가(2026-11-23) → **data.bnf.fr 공식 SPARQL**(`bnfSparql`, 제목 전문검색 bif:contains + Gallica 원문 링크)을 우선, 0건일 때만 카탈로그. IIIF는 브라우저 뷰어에서 열림.
- 한국사DB — 통합검색(`searchTotalResult.do`)은 GET·POST 모두 결과를 스크립트로 그려 HTML에 없음(메뉴만). **시대별 하위 DB POST**(`/{joseon|modern|contemp|ancient}/search/searchResultList.do`, `searchItemId`)가 건수·기록(fnGoItemLevel levelId)을 돌려준다 — `nedbLive`가 주요 8개 DB 병렬(6h 캐시). DB 코드 111종은 사이트 메뉴 `/{시대}/level.do?itemId=`에서 확인.
- NDL — 동시·연속 요청 429. 순차·타임박스 유지, 재조회 최소화(디지털 PID는 검색 결과에서 바로).
- 한국고문서자료관(AKS) — 일반 요청 WAF 차단(브라우저 세션에서만). 규장각 — 일부 네트워크에서 연결 불가(서버는 정상).
- 위키미디어 — 연속 요청 429. imageinfo는 한 번에 묶어 조회.
- Internet Archive — 전체 필드 검색은 Archive-It 웹 크롤링 원자료(mediatype web)·라디오 스트림이 상위를 채운다(2026-11-23 감사). `iaSearch`/`_ia_search`: 제목 범위 + texts·movies·image → 0건이면 web·collection·account 제외 질의, gov.* 원본 우선·youtube- 사본 뒤. 고급 문법(필드:값)은 그대로.
- **관련성 감사**(health 건수 검사로는 안 잡히는 '그럴듯한 오답'): 수집처마다 골든 질의 결과에 검색어(또는 번역어)가 실제로 들어 있는지 본다 — 매주 `relevance` 워크플로가 자동 실행. 새 수집처는 `scripts/relevance_audit.py`의 `CASES`(질의·인정 토큰)에, 새로 발견한 오답 패턴은 `JUNK`에 추가. 2026-11-23 감사에서 한국사DB(메뉴 오인)·IA(크롤링 묶음) 두 건 발견·수정. 새 수집처를 넣을 때 golden에 `must`(검색어)·`must_not`(오답 패턴)을 함께 둔다.
- 국립문화유산연구원 국가유산 지식이음(portal.nrich.go.kr) — robots Allow. 발간자료는 공식 Open API(`originalTotalApi.do`, 무키, XML md_data1~13), 국외문화유산 DB는 목록 GET(`st=1` 제목 검색 — `st=3`·POST는 필터 안 됨, 2026-11 실측). 그 밖의 Open API 22종(초상화·공예도설·목간·금석문 등)은 `apiList.do?menuIdx=665` — 다음 확장 후보.
- 국립문화유산연구원 범용 Open API(`openapi.do?idx=N`) — 키워드 검색 없음 → 주 1회 전체 수집(`scripts/nrich_harvest.py`, 정적 색인). **`firstindex`=시작 행, `recordcountperpage`=끝 행(포함)** — 명세 설명과 다름(실측). https는 응답이 비는 경우가 있어 공식 End Point대로 http. 필드 번호(md_dataN)는 데이터셋별 실측표(스크립트 `DS`) — 원 기관이 열을 바꾸면 golden `nrich-db-detail`이 잡는다.
- 국외소재문화유산재단(overseaschf.or.kr) — robots.txt `Disallow: /`. 발굴 우선 원칙에 따라 수집처로 두되 결과·프로파일에 표시하고, 정직 UA·요청 1회(목록)·상세 24h 캐시로 최소화. 이 컨테이너의 Node fetch는 프록시 경유 503이 날 수 있음(curl·Vercel은 정상) — 로컬 검증은 저장 HTML로.

## 4. 새 기능·수집처를 넣을 때 체크리스트

- [ ] 도구 **20개 이하** — 새 도구 대신 기존 도구의 `mode`/`kind`/`format` enum 확장.
- [ ] 응답 **24KB 이하**(UTF-8 바이트 실측, 한글 3B/자) · 도구 설명 **1024자 이하** · 설명에 서비스명(SVC 래퍼).
- [ ] Node·Python **양쪽 동일 동작** + `splice_mcp.py`.
- [ ] 로컬 전용 지식(스킬)이라면 **서버 상수로도 노출**(`report_template` kind) — 웹·모바일 동등성(CLAUDE.md 제1원칙).
- [ ] `source_profile` 간이 프로파일(`QUICK_PROFILES`)·health 골든 질의 추가.
- [ ] `tests/golden.json` 케이스 추가.
- [ ] 스키마·설명이 바뀌면 **PlayMCP 콘솔 "정보 불러오기"** 재실행.

### 메이저 업그레이드(next·zod·mcp-handler)
자동 PR에서 제외된다. 올릴 때는 브랜치에서 `npm i <패키지>@<버전>` → `npx next build` → 로컬 `next start` 후 `python3 scripts/golden.py --url http://localhost:3000/api/mcp` → 프리뷰 배포에서 골든 재실행 → 병합. zod 4는 스키마 API(`z.coerce` 등)를, mcp-handler 2는 `createMcpHandler` 시그니처를 먼저 확인.

## 5. 배포 절차 (요약)

```bash
# korea-archive-mcp (작업 브랜치 → PR → main 병합 = Vercel 자동 배포)
cp "app/api/[transport]/route.js" /tmp/route_check.mjs && node --check /tmp/route_check.mjs
node scripts/ci-verify.mjs && node scripts/ci-parity.mjs ../korea-archive-marketplace
python3 scripts/check-docs.py
# korea-archive-marketplace (main 직접)
python3 scripts/splice_mcp.py && python3 -m py_compile plugins/korea-archive/servers/server.py
# 배포 후
python3 scripts/golden.py          # 프로덕션 골든 회귀
```

## 6. 서버 설정(값은 Vercel 프로젝트 환경변수 — 저장소에 넣지 않는다)

`NARA_API_KEY` · `ARCHIVES_API_KEY`(국가기록원) · `NLK_API_KEY` · `EUROPEANA_API_KEY` · `KOREANWAR_API_TOKEN`(협약기관) · `KOREANWAR_API_PAGES` · `DNZ_API_KEY`(선택) · `NEDB_INDEX_URL`(한국사DB 공식 개방파일 인덱스, 선택) · `FETCH_PROXY_PREFIX`(선택) · `KV_REST_API_URL`·`KV_REST_API_TOKEN`(발견 누적 원장 — Vercel Storage의 Upstash Redis 연결 시 자동 주입, 결제 수단 등록 금지: 무료 리소스가 유료로 전환됨).
키가 없으면 해당 채널은 결과에 "키 미설정"으로 표시되고 나머지는 계속 동작한다. `source_profile('health')` 맨 아래에 설정 상태가 나온다.

## 7. 산출물 다시 만들기

| 산출물 | 명령 | 원천 |
|---|---|---|
| 100선 카드 한 시리즈 | `python3 docs/promo/series100/kit/build_series.py sNNN` | `sNNN/plan.json`·`src/` |
| 100선 페이지 | `python3 docs/promo/series100/kit/gen_page100.py` | 각 시리즈 plan·카드 |
| 30곳 탐방 페이지 | `cd docs/promo/series30 && python3 gen_page.py` | `series.json`·series30v2 |
| IIIF 갤러리 | `python3 docs/promo/build_iiif.py` — **`build_series.py`가 시리즈 빌드 끝에 자동 실행**(끄려면 `NO_IIIF=1`) · 갱신을 잊으면 verify의 `check-docs`가 '갤러리가 출처 대장보다 오래됨'으로 실패 | 출처 대장 `ledger.json`(권리 3단계 자동 적용) |

원본 이미지(`src/`)는 저장소에 넣지 않는다(.gitignore). 게재본은 카드·IIIF 이미지(권리 규칙 적용)만.

## 8. 콘텐츠 원칙(바뀌지 않는 것)

실물 기록만(AI 생성 인물·장면 금지) · 링크·수치는 도구 호출·원문으로 확인한 것만 · 공공누리 제4유형은 원형 그대로 · 허가 필요 이미지는 링크만 · 포로·묘지·수형자 사진 제외 · 협약기관(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터) 출처 표기 · 접근 차단은 우회하지 않고 표시한다.
