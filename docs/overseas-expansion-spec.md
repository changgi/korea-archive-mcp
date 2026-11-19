# 해외 확장 접근 명세 — 호주·캐나다·독일·UN·뉴질랜드 (2026-11-20 전수 실측)

## ✅ 호주 전쟁기념관 AWM (awm.gov.au) — cross_search `awm` 합류
한국전 영연방(호주) 부대 사진·유물·미술의 1차 소장처. 가평 전투 호주군 기록의 본산.
- **검색**: `GET /advanced-search?query=<영문>` — 결과가 서버 렌더 **이미지 모자이크**(제목 없는 `/collection/C<id>` 링크 + S3 썸네일).
- **2단 수집**: 모자이크 C-id 추출 → `GET /collection/C<id>` 상세(SSR)에서 `<h1>` 제목 + Accession/ID number.
  실측: Kapyong → 147844(가평 계곡 1952-04-16 항공 조망)·HOBJ3143~45(파노라마). 상세 병렬 ≤5건(예절).
- 권리: AWM 저작권 고지 건별 확인(Public Domain 다수) — judge_rights 연계.

## ⛔ 캐나다 LAC (recherche-collection-search.bac-lac.gc.ca) — 보류
- Cloudflare **Turnstile** 챌린지가 데이터센터 IP를 차단(브라우저 자동화로도 상호작용 필요) — 서버사이드 불가.
- 대안: 한국전 캐나다군(PPCLI — 가평 전투)은 **AWM·TNA(영연방)·NARA**에서 교차 발굴 가능. LAC는 브라우저 안내.

## ⛔ UN Archives (search.archives.un.org, AtoM) — 보류
- 자체 JS 챌린지("Verifying Your Browser" → localStorage+redirect) — 서버사이드 GET 불가.
- AtoM 플랫폼이라 챌린지만 통과하면 `/informationobject/browse?query=` 표준 검색 — 챌린지 정책 완화 시 즉시 합류 가능. 브라우저 안내.

## 🔑 독일 — 키 확보 시 합류 경로
- Bundesarchiv invenio: 직링크가 셸 반환 — 세션 기반.
- **DDB(deutsche-digitale-bibliothek.de)**: 웹 403이나 **공식 API(무료 키)** 제공 — `DDB_API_KEY` 확보 시 `ddb` 소스 합류 가능.
- 현행 대안: **Europeana가 독일(DDB 포함) 기관을 이미 집계** — `europeana_search`가 독일권 실질 커버(필요 시 쿼리에 Koreakrieg 병용, TOPICS가 독일어 입력 인식).

## ✅ 네덜란드 국립문서보관소 (nationaalarchief.nl) — cross_search `nlna` 합류 (v1.26)
- 웹 검색은 SPA 셸이나 **공개 JSON API**를 Playwright 역추적으로 확보: `GET zvt.nationaalarchief.nl/api/search/eads?q=&rows=&page=&sortBy=_score` — 키 불요.
- 응답: total_hits + results[{type, id(문서군 코드), title, period}]. 실측 'Korea' 243건 — **주한 네덜란드 대사관(2.05.202, 1955-74)·한국전 파견부대(2.13.56, 1950-79)** 문서군 직행.
- 딥링크: `nationaalarchief.nl/onderzoeken/archief/<id>`.

## ⛔ 뉴질랜드 Papers Past — 보류 (v1.26 실측)
- Incapsula(Imperva) 봇 게이트 — 서버사이드 불가. Archives NZ는 미탐침(다음 라운드).

## (v1.26) AWM 심화
- 상세 파싱 확장: **권리 자동 태그**(Item copyright 'Copyright expired - public domain' → `· 권리:PD(저작권 만료)`) + Conflict 기간을 date 필드로 — 발굴 우선·권리 표시 원칙의 해외 적용 1호.
