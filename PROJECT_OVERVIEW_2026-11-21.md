# KOREA ARCHIVE 통합검색 — 종합 현황 (v1.51, 2026-11-21)

Vercel 원격 MCP 서버(Node `app/api/[transport]/route.js`, 리전 icn1) + 자매 Python 플러그인(`korea-archive-marketplace`).
도구 **20개 정확히**(PlayMCP 준수 — 확장은 전부 파라미터 모드), 응답 24KB 가드, 전 도구 read-only.

## 한눈에 — v1.27(11-20) 이후 이번 세션에서 늘어난 것
| 축 | 이전 | 현재(v1.51) |
|---|---|---|
| 연합 검색 소스 | 20 | **27** (+공훈전자사료관·commons·UN·NDL·신문아카이브·역사박물관·독립운동판결문) |
| 심층 판독 | 3 | **12채널** (i815·gonghun·jacar·ktv·earchive·commons·jsg·un·oldnews·much·indy + seoul) |
| 권리 자동판정 | KOGL | **4연결** (KOGL 입력·NARA naid 실조회·commons PD/CC·much 공공누리 실문구) + 게재윤리 고지 내장 |
| 성능 | kyudb 10.2s | 타임박스 12s·TTL 캐시(kyudb 0.4s·nlk 1.6s)·foia 6s fail-fast |
| health | 20채널 | **27채널+ms — 🟢24·🟡1·🔴기지2 (2026-11-21 실측)** |


## 연합 검색 24소스 (cross_search)
- 해외: 🇺🇸 NARA · 🇬🇧 TNA · 🌐 IA · 🇫🇷 갈리카 · 🇪🇺 유러피아나 · 🇯🇵 JACAR·NDL 서치 · 🇦🇺 AWM · 🇳🇱 Nationaal Archief · 🌐 위키미디어 공용 · 🇺🇳 UN 디지털도서관
- 국내: 국가기록원(+독립운동판결문) · 국립중앙도서관(+신문아카이브 1883~1960) · 한국사DB · 국편 전자사료관 · 독립기념관 · 공훈전자사료관 · 역사박물관 · KTV · 규장각 · 장서각 · AKS 고문서 · 서울기록원 · 정보공개포털 · KOREAN WAR ARCHIVES(협약)
- 당대 표기 팬아웃(variants) · 한→영(TOPICS 85)·한→일(JA_MAP 48) 자동 변환 · 소스별 12s 타임박스 · CSV 출력

## 심층 판독 9채널 (발굴→분석→권리, 전부 도구 응답 안에서)
| 채널 | 입력 | 나오는 것 |
|---|---|---|
| nedb mode=i815 | detail.do URL | 1910년대 신문기사 전문·독립운동가 자료 번역 전문 |
| mode=gonghun | 이름→mngNo | 공적조서·공훈록 전문·수형기록(판결문)·묘소·현충시설 |
| mode=jacar | 레퍼런스코드 | 일본 공문서 메타(기밀등급·이미지 수)·±span 인접 |
| mode=ktv | ehistory view URL | 대한뉴스 해설·제작연도·상영시간(KOGL) |
| mode=earchive | '키워드\|순번' | 국내 수집 사료 열람·이용조건·등록번호(세션 2단 POST 역공학) |
| mode=commons | File URL | 라이선스(PD→A 자동)·작가·원 소장처(NH·NARA)·원본 고해상 |
| mode=jsg | 청구기호 K2-… | 장서각 서지·해제 전문(정의~참고문헌) |
| mode=un | recid/URL | UN 문서 요약·주제·언어별 PDF 직링크 |
| mode=oldnews | 키워드·CNTS·'본문:…[\|연대]' | 신문 색인어·관련기사 연쇄·OCR 원문 발췌+연도 분포 |
| mode=much | idnbr/URL | 소장품 재질·크기·공공누리 유형→자동 초판정·설명 |
| mode=indy | 이름·상세 URL | 판결문 죄명·주문·사건개요·원문 뷰어(게재윤리 고지) |
| seoul_archives_search | /item·/aggregation URL | 식별번호(RG-SR-IT)·법적지위·이용조건·기술 |

## 권리 자동판정 4연결 (발굴 우선 — 권리는 표시)
1. judge_rights: KOGL 1~4유형 · RG 규칙 — **naid 투입 시 NARA 카탈로그 Use Restriction 실조회**(Unrestricted→A 확정·Restricted→C)
2. commons: PD/CC 라이선스 → A/B/D 자동 초판정 + 원 소장처 역추적
3. 기록 단위 이용조건 실문구: earchive·서울기록원·koreanwar_item — judge_rights 투입 안내 자동 부착

## 자가 감시
- `source_profile('health')`: 24채널 골든 질의 + 채널별 ms. 주간 GitHub Actions(health.yml).
- CI(verify.yml): node --check · 도구 20종 · 설명 1024자 · 24KB 가드 · 3사본 패리티 · py_compile — 푸시마다.
- 2026-11-21 전수 실측: 🟢 **24** · 🟡 nedb(인덱스 대기) · 🔴 기지 2(gallica BnF 403 · foia 리셋 — 6s fail-fast). 응답 중앙값 ~1.1s

## 보류·후보 (재점검 주기 운용 — 복구 시 합류 전례: 공훈전자사료관)
- 차단: LOC(전 JSON 엔드포인트 Cloudflare) · 호주 NAA(Cloudflare) · 뉴질랜드 Archives NZ·Papers Past(Incapsula) · LAC 캐나다(Turnstile) · UN Archives AtoM(JS 챌린지 — 디지털도서관으로 우회 합류 완료) · kdemo(개편 중)
- 키 확보 시 즉시 합류: 호주 Trove(무료) · 독일 DDB(무료) · 공훈전자사료관 OpenAPI(공공데이터) · NEDB 개방파일 인덱스(NEDB_INDEX_URL)

## 사용자 액션 체크리스트
1. **PlayMCP 콘솔 "정보 불러오기" 재실행** — naid·gonghun·i815·ktv·earchive·commons·jsg·un 모드 스키마 누적분 반영(1회면 됨). 이후 docs/playmcp-review-pack.md(v1.42, 시연 15선)로 심사 재신청.
2. (선택) data.go.kr에서 Trove/DDB/보훈부 키 발급 → 환경변수 투입 시 소스 추가.
3. (선택) NEDB 개방파일 인덱스 파일 지정(NEDB_INDEX_URL) → nedb 🟡→🟢.
