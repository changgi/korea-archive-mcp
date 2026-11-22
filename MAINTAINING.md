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

수집처 하나 = route.js의 `COLLECT.<이름>`(연합 검색) + 필요하면 `nedb_search` 등의 `mode` 분기(심층 판독). Python은 `_c_<이름>`·`_<이름>_mode`.

## 2. 자동 감시 — 사람이 매일 보지 않아도 되는 이유

| 워크플로 | 언제 | 무엇을 | 실패하면 |
|---|---|---|---|
| `verify` | 모든 push·PR | 구문·도구 20종·설명 1024자·24KB 가드·**Python 패리티·본문 사본 일치**·**Pages 링크·IIIF 이미지 무결성**·골든 파일 형식 | PR 빨간불 |
| `golden` | main 반영 직후(배포 대기 150초) · 매주 수 | 프로덕션 도구 18케이스 출력 구조(제목 전체·해제·표기 변형·IIIF·24KB) | **`auto-health` 이슈 자동 생성/갱신**, 다음에 통과하면 자동 종료 |
| `health` | 매주 월 | 30채널 골든 질의 + 같은 기록 묶기 회귀 | `auto-health` 이슈 |
| `fixity-watch` | 매주 화 | 골든 기록 본문 지문(sha256-16) — 원문 개정 감지 | 원장(`public/fixity-ledger.json`) 이력 커밋 + 실패 |
| `retry-blocked` · `nz-harvest` | 매주 화 | 차단 채널 재탐침 · NZ 정적 인덱스 갱신 | 실행 요약 |
| Dependabot | 매월 | npm·Actions 의존성 갱신 PR | verify·golden이 자동 검증 |

**할 일은 하나** — 저장소 Issues에서 `auto-health` 라벨을 본다. 열려 있으면 아래 3절.

## 3. 사이트가 바뀌었을 때 (가장 흔한 장애)

1. 이슈/실행 요약에서 **어느 케이스·채널**인지 확인 (`golden` 표의 `문제` 칸 = 빠진 패턴).
2. 실제 응답 확인: `python3 scripts/golden.py --only <케이스id>` 또는 프로덕션 MCP 호출. 원 사이트 HTML/JSON을 직접 받아 **구조 변화**를 본다(검색 파라미터·태그·클래스명).
3. 접근이 막혔다면(403·429·WAF·TLS 리셋) **우회하지 않는다** — UA 위장·쿠키 데우기·프록시·러너 우회 금지. 결과에 "기술적 불능 + 브라우저 대체 경로"를 표시하는 것이 원칙(CLAUDE.md 발굴 우선 원칙).
4. 파서를 **양쪽**(route.js · server.py)에서 고친다 → `node --check`(`.mjs` 사본) · `py_compile` · `node scripts/ci-verify.mjs` · `node scripts/ci-parity.mjs ../korea-archive-marketplace`.
5. 고친 동작을 `tests/golden.json`에 **케이스로 추가**(옛 결함 출력이 걸리는 `must_not`까지). 다음 개편 때 자동으로 잡힌다.
6. CHANGELOG 기록 → 두 저장소 커밋·푸시 → main 반영 → `golden`이 배포 후 자동 재검사.

### 알려진 접근 제약 (2026-11 실측)
- 정보공개포털(open.go.kr) 원문정보 — 기관 점검 중(2026.11.12~). foia는 청구 경로 안내로 대체.
- Gallica — 서버 IP 자동 조회 403 → BnF SRU 카탈로그로 수집, IIIF는 브라우저 뷰어에서 열림.
- NDL — 동시·연속 요청 429. 순차·타임박스 유지, 재조회 최소화(디지털 PID는 검색 결과에서 바로).
- 한국고문서자료관(AKS) — 일반 요청 WAF 차단(브라우저 세션에서만). 규장각 — 일부 네트워크에서 연결 불가(서버는 정상).
- 위키미디어 — 연속 요청 429. imageinfo는 한 번에 묶어 조회.

## 4. 새 기능·수집처를 넣을 때 체크리스트

- [ ] 도구 **20개 이하** — 새 도구 대신 기존 도구의 `mode`/`kind`/`format` enum 확장.
- [ ] 응답 **24KB 이하**(UTF-8 바이트 실측, 한글 3B/자) · 도구 설명 **1024자 이하** · 설명에 서비스명(SVC 래퍼).
- [ ] Node·Python **양쪽 동일 동작** + `splice_mcp.py`.
- [ ] 로컬 전용 지식(스킬)이라면 **서버 상수로도 노출**(`report_template` kind) — 웹·모바일 동등성(CLAUDE.md 제1원칙).
- [ ] `source_profile` 간이 프로파일(`QUICK_PROFILES`)·health 골든 질의 추가.
- [ ] `tests/golden.json` 케이스 추가.
- [ ] 스키마·설명이 바뀌면 **PlayMCP 콘솔 "정보 불러오기"** 재실행.

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

`NARA_API_KEY` · `ARCHIVES_API_KEY`(국가기록원) · `NLK_API_KEY` · `EUROPEANA_API_KEY` · `KOREANWAR_API_TOKEN`(협약기관) · `KOREANWAR_API_PAGES` · `DNZ_API_KEY`(선택) · `NEDB_INDEX_URL`(한국사DB 공식 개방파일 인덱스, 선택) · `FETCH_PROXY_PREFIX`(선택).
키가 없으면 해당 채널은 결과에 "키 미설정"으로 표시되고 나머지는 계속 동작한다. `source_profile('health')` 맨 아래에 설정 상태가 나온다.

## 7. 산출물 다시 만들기

| 산출물 | 명령 | 원천 |
|---|---|---|
| 100선 카드 한 시리즈 | `python3 docs/promo/series100/kit/build_series.py sNNN` | `sNNN/plan.json`·`src/` |
| 100선 페이지 | `python3 docs/promo/series100/kit/gen_page100.py` | 각 시리즈 plan·카드 |
| 30곳 탐방 페이지 | `cd docs/promo/series30 && python3 gen_page.py` | `series.json`·series30v2 |
| IIIF 갤러리 | `python3 docs/promo/build_iiif.py` | 출처 대장 `ledger.json`(권리 3단계 자동 적용) |

원본 이미지(`src/`)는 저장소에 넣지 않는다(.gitignore). 게재본은 카드·IIIF 이미지(권리 규칙 적용)만.

## 8. 콘텐츠 원칙(바뀌지 않는 것)

실물 기록만(AI 생성 인물·장면 금지) · 링크·수치는 도구 호출·원문으로 확인한 것만 · 공공누리 제4유형은 원형 그대로 · 허가 필요 이미지는 링크만 · 포로·묘지·수형자 사진 제외 · 협약기관(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터) 출처 표기 · 접근 차단은 우회하지 않고 표시한다.
