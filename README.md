# Korea Archive MCP — Remote server (Vercel)

Remote MCP server exposing **20** Korea-records discovery tools (해외 6 + 국내 9 + 유틸 5) over Streamable HTTP — PlayMCP 개발가이드 준수(≤20 tools, annotations, Streamable HTTP, stateless).
No local Python needed by users — they just add a connector URL.

## Deploy (once)
1. Push this folder to GitHub (e.g. `korea-archive-mcp`)
2. vercel.com → Add New Project → Import the repo → Deploy (Next.js auto-detected)
3. **Function region → Seoul (icn1).** Korean government sites (`archives.seoul.go.kr`, `opengov.seoul.go.kr`, …)
   block foreign/datacenter egress IPs, so from the default US region their fetch fails ("fetch failed") and
   the tool falls back to a web-search handoff. This repo pins the region to Seoul via `preferredRegion = 'icn1'`
   (in `app/api/[transport]/route.js`) and `vercel.json` `"regions": ["icn1"]`. If your plan/setup ignores those,
   set it manually: Project Settings → Functions → Function Region → **Seoul, South Korea (icn1)**, then redeploy.
4. Env vars (Project Settings → Environment Variables) — all optional:
   - `NARA_API_KEY` — enables nara_search (free: Catalog_API@nara.gov)
   - `EUROPEANA_API_KEY` — heavier europeana_search use (free: apis.europeana.eu; a shared demo key works without it)
   - `ARCHIVES_API_KEY` — enables archives_search / 국가기록원 (free: data.go.kr 15000153)
   - `NLK_API_KEY` — enables nlk_search / 국립중앙도서관 (free: www.nl.go.kr Open API)
   - `KOREANWAR_API_TOKEN` — enables the OpenAPI channel of koreanwar_search / KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 (협약기관).
     Apply via the site's Q&A board ("API 문의"); after approval the admin registers your token **and allowed IP**
     (register the deployment's egress IP — Seoul region). Scraped search works keyless meanwhile; the token adds
     the official-metadata channel (공공누리 KOGL·이용조건·저작권 필드). `KOREANWAR_API_PAGES` (default 3) caps the
     pages scanned per query (pageSize 100) to respect the API's no-bulk-crawling terms.
   - `FETCH_PROXY_PREFIX` — *last-resort bypass* if a site still blocks even the Seoul region (some Korean gov
     sites block all cloud/datacenter ASNs). Point it at a read-through proxy that returns **raw** content, e.g.
     `https://api.allorigins.win/raw?url=` (append target) or `https://r.jina.ai/` (uses the sent `X-Return-Format: html`).
     Off by default. Use `{url}` in the value as a placeholder for the URL-encoded target if the proxy needs it mid-path.
   - `NEDB_INDEX_URL` — **robots-compliant 한국사DB search.** `db.history.go.kr` disallows generic crawlers in
     robots.txt, so instead of scraping it, use the OFFICIAL data.go.kr open-data files (KOGL): download the
     한국사DB datasets (비변사등록·한국사료총서·근현대인물 등), run `node scripts/ingest-opendata.mjs <folder>` to build
     `nedb_index.json`, host it (e.g. this deploy's `public/`), and set `NEDB_INDEX_URL` to that URL. Then
     `nedb_search` and `cross_search` serve results from the official files — no live scraping. (Tailor the field
     map in `scripts/ingest-opendata.mjs` to each dataset's actual XML/CSV structure.)

## Users connect with one URL
- Claude (web/desktop): Settings → Connectors → Add custom connector → `https://<deployment>.vercel.app/api/mcp`
- Claude Code: `claude mcp add --transport http korea-archive https://<deployment>.vercel.app/api/mcp`
- <deployment> is `korea-archive-mcp` so  → `https://korea-archive-mcp.vercel.app/api/mcp`

## Tools (20 — PlayMCP 개발가이드 준수: 서버당 20개 이하)
- **Overseas (6):** tna_search · tna_adjacent_mine · nara_search · ia_search(검색+identifier 메타 조회 통합) · gallica_search · europeana_search
- **Domestic (9):** nedb_search(한국사DB) · archives_search(국가기록원) · nlk_search(국립중앙도서관·category 이중채널) · seoul_archives_search(서울기록원) · foia_search(정보공개포털+서울정보소통광장·서울시교육청·경남기록원 — source 파라미터) · warmemo_search(전쟁기념관) · **koreanwar_search**(KOREAN WAR ARCHIVES·6·25전쟁 아카이브센터 통합검색+전투정보 scope+OpenAPI 이중채널) · **koreanwar_item**(건별 메타·권리 + radius 인접 채굴) · scrape_plan
- **Utility (5):** query_bank(+국내 키워드셋) · judge_rights · report_template · **cross_search**(여러 아카이브 동시 교차수집·병합) · **source_profile**(기관 자료·이용·활용구조)

### KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 (koreanwar.or.kr — MOU 협약기관)
TNA-style structured toolset for KOREAN WAR ARCHIVES (정식 명칭; 전쟁기념관재단, 55,000+ items):
`koreanwar_search`(통합검색 — 상위계층 breadcrumb에서 NARA Record Group을 추출해 원본 역추적 링크 제공; 생산연도·수집구분 서버측 필터, pageSize 10/20/50; `scope=battle`이면 전투정보 DB) →
`koreanwar_item`(생산처·생산시기·입수처[NARA NAID 직결]·열람 및 이용조건; `radius=1~8`이면 archRfcd 일련번호 ±N 동일 시리즈 인접 채굴 — 정중한 3건 배치 병렬).
All requests carry a partner-identifying User-Agent and polite pacing.
`KOREANWAR_API_TOKEN` 승인 즉시 공식 OpenAPI 메타 채널(pbrcList.do — KOGL·이용조건·저작권 필드)이 자동 병행된다.

### PlayMCP 개발가이드 준수 (2026.06.12판)
- Streamable HTTP · Remote(public URL) · stateless — mcp-handler 기반 충족
- 도구 20개 이하(24→20 통합) · 도구명 영문/숫자/underscore · "kakao" 문자열 미사용
- 전 도구 annotations(title·readOnlyHint·destructiveHint·openWorldHint·idempotentHint) 지정 — 전부 read-only·비파괴
- description: PlayMCP 등록 서비스명 "KOREA ARCHIVE 통합검색" 병기 + 1024자 이내 자동 보장
- 응답은 정제 텍스트(마크다운형) — API 원본 미투과 · 인접 채굴은 배치 병렬로 p99 3s 내 응답

### cross_search — 상호보완 동시수집
`cross_search(query, sources="all")` runs one query across TNA·IA·Gallica·Europeana (keyless) + NARA·archives·nlk (if key) + nedb (if `NEDB_INDEX_URL`) **concurrently**, then merges & dedups, tagging each record by which source(s) found it (multi-source = cross-corroborated). robots-forbidden sites (opengov·서울기록원) are excluded by design.

## Skills (`.claude/skills/`)
- **insta-carousel** — 발굴조사 결과를 인스타그램 캐러셀 카드뉴스(1080×1080 PNG)로 제작: 실물 이미지 소싱·라이선스 판정·레이아웃·헤드리스 크롬 렌더링·캡션.
- **archival-discovery-pipeline** — 발굴이 식별자·URL을 확보하면 **실물을 여는** 후속 파이프라인: 프레임 단위 영상·이미지 분석, 문자 영역 탐지·OCR·VLM 교차검증 판독(슬레이트·표지판·현수막), 당대 지명·부대 식별, 재기술, 게재 윤리 4단계 판정, RiC-O/CIDOC-CRM 온톨로지·KARDA 노드엣지 변환, 논문 도판·정합 검사. MCP 도구(`nara_search`·`tna_adjacent_mine`·`koreanwar_search`·`judge_rights` 등)와 왕복 구조로 연동 — 판독에서 나온 단서(ROLL·과제번호·촬영자·부대)로 다시 발굴 도구를 호출해 자매편을 찾는다. 의존: `pip install pillow numpy opencv-python matplotlib` + ffmpeg (OCR 보조: tesseract).

MIT · Methodology: Song, Chang-Gi (2026), National Archives of Korea
