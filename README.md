# Korea Archive MCP — Remote server (Vercel)

Remote MCP server exposing **20** Korea-records discovery tools (해외 7 + 국내 8 + 유틸 5) over Streamable HTTP.
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

## Tools (20)
- **Overseas (7):** tna_search · tna_adjacent_mine · nara_search · ia_search · ia_metadata · gallica_search · europeana_search
- **Domestic (8):** nedb_search(한국사DB) · archives_search(국가기록원) · nlk_search(국립중앙도서관·category 이중채널) · seoul_archives_search(서울기록원) · foia_search(정보공개포털) · local_gov_search(서울정보소통광장·서울시교육청·경남기록원) · warmemo_search(전쟁기념관) · scrape_plan
- **Utility (5):** query_bank(+국내 키워드셋) · judge_rights · report_template · **cross_search**(여러 아카이브 동시 교차수집·병합) · **source_profile**(기관 자료·이용·활용구조)

### cross_search — 상호보완 동시수집
`cross_search(query, sources="all")` runs one query across TNA·IA·Gallica·Europeana (keyless) + NARA·archives·nlk (if key) + nedb (if `NEDB_INDEX_URL`) **concurrently**, then merges & dedups, tagging each record by which source(s) found it (multi-source = cross-corroborated). robots-forbidden sites (opengov·서울기록원) are excluded by design.

MIT · Methodology: Song, Chang-Gi (2026), National Archives of Korea
