<div align="center">

# 🏛️ KOREA ARCHIVE 통합검색
### Korea Archive MCP — 30개 문서고 연합 발굴 원격 MCP 서버

[![Sources](https://img.shields.io/badge/sources-30_archives_·_9_countries-1f6feb?style=flat-square)](#-연합-검색망-30소스)
[![Tools](https://img.shields.io/badge/MCP_tools-20_(PlayMCP_준수)-2da44e?style=flat-square)](#-도구-20종)
[![Hierarchy](https://img.shields.io/badge/partOf_계층-28%2F30_채널-8250df?style=flat-square)](#-현용기록물화-사슬--발굴이-기록이-됩니다)
[![Fixity](https://img.shields.io/badge/공개_지문_원장-골든_8종_주간_감시-d4a72c?style=flat-square)](https://korea-archive-mcp.vercel.app/fixity-ledger.json)
[![Region](https://img.shields.io/badge/Vercel-icn1_(Seoul)-black?style=flat-square&logo=vercel)](https://korea-archive-mcp.vercel.app)
[![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)](#라이선스--방법론)

**한국 관련 기록(1860~현대)을 9개국 30개 문서고에서 한국어 한 번의 질의로 발굴하고,**
**발굴 자체를 맥락·증거성을 갖춘 현용기록물(JSON-LD 매니페스트·지식그래프·CSV)로 만들어 전파하는 서버.**

[사용 안내](https://korea-archive-mcp.vercel.app/help.html) · [English Guide](https://korea-archive-mcp.vercel.app/help-en.html) · [기록잇다(즉석 연합검색)](https://korea-archive-mcp.vercel.app/ingitda.html) · [공개 지문 원장](https://korea-archive-mcp.vercel.app/fixity-ledger.json) · [심사 시연 21선](docs/playmcp-review-pack.md)

</div>

---

## ⚡ 연결은 URL 하나

| 클라이언트 | 방법 |
|---|---|
| **Claude** (웹·모바일·데스크톱) | 설정 → 커넥터 → 커스텀 커넥터 추가 → `https://korea-archive-mcp.vercel.app/api/mcp` |
| **Claude Code** | `claude mcp add --transport http korea-archive https://korea-archive-mcp.vercel.app/api/mcp` |
| **PlayMCP** (카카오) | "KOREA ARCHIVE 통합검색" 검색 → 연결 |

매직 키워드 — **"○○ 풀패키지로 만들어줘"**(조사→보고서→카드뉴스→포스터→보존 패키지 SIP까지 산출물 12종) · **"창기창기 도와줘"**(처음 사용자 안내).

## 🌏 연합 검색망 30소스

`cross_search("장진호")` 한 번이 아래 전체를 동시 수집·병합·중복제거하고, 복수 출처 레코드는 **교차확인**으로 표시합니다. 한국어 질의는 색인 언어로 자동 변환됩니다(TOPICS 85항목 · 한→일 48항목 · 한→불).

| 권역 | 소스 |
|---|---|
| 🇺🇸 미국 | **NARA**(계보·생산일·소장단위·scope 지문·원본 직링크 — 최심도 채널) · Internet Archive |
| 🇬🇧🇫🇷🇪🇺 유럽 | TNA 영국국립기록관 · Gallica 프랑스국립도서관 · Europeana · 🇳🇱 Nationaal Archief · 🇩🇪(DDB 키 대기) |
| 🇯🇵 일본 | JACAR 아시아역사자료센터 · NDL 국립국회도서관 |
| 🇦🇺🇳🇿 오세아니아 | Australian War Memorial · DigitalNZ · **Archives NZ**(공개 API 역공학 10차로 합류) |
| 🌐 국제 | UN Digital Library · Wikimedia Commons(PD 원본 직링크) |
| 🇰🇷 국내 14+ | **KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터(MOU 협약기관)** · 국가기록원 · 국립중앙도서관 · 대한민국신문아카이브(면·단 좌표) · 서울기록원 · 국사편찬위 한국사DB·전자사료관 · 공훈전자사료관 · 독립기념관(+한국독립운동인명사전) · 독립운동판결문 · 국가유산포털 · 대한민국역사박물관 · KTV e영상역사관 · 장서각 · 규장각 · 한국고문서자료관 · 정보공개포털 |

> **발굴 우선 원칙** — 권리·접근 제약은 발굴을 막는 사유가 아니라 **표시 대상**입니다. 결과마다 권리 상태를 표시하고(`judge_rights` — KOGL 1~4유형·NARA Use Restriction 실조회), 기술적 불능 소스만 제외하되 대체 경로를 안내합니다.

## 🧬 현용기록물화 사슬 — 발굴이 기록이 됩니다

```
발굴(cross_search) ──► 생산: JSON-LD 수집기록 매니페스트 (ISAD(G)·RiC 지향)
                        provenance=질의·소스·시각·재현 호출문 (증거성)
                        heldBy=기관 정식명·국가 / partOf=상위 계층 28채널 (맥락)
                        media=실조회 검증 원본 직링크 (다매체)
                  ──► 데이터화: format=csv(partOf·media 열) · karda(지식그래프 — series 노드·PART_OF 엣지)
                        세 매체가 같은 node 키를 공유 — 상호 참조
                  ──► 전파: 보고서·카드뉴스·포스터가 매니페스트를 부록으로 상속
                        이미지도 media 직링크에서 소싱 — 데이터와 지면의 계보 일치
                  ──► 지속: sha256 fixity + 본문 지문 10채널 + 공개 지문 원장(골든 8종 주간 감시)
                        영속 식별자(NAID·archRfcd·R번호·레퍼런스코드) 우선 인용
```

- **계층(partOf) 28/30채널**: NARA `RG 127 › General Photograph File…` · 협약기관 `수집 > 미국 > NARA > RG 111…` · 장서각 四部 · 규장각 문고(奎·古·想白·一簑) · NL 토이강(2.05 외무부…) · UN 문서기호 · Gallica ark 유형 등 — 응답에 재료가 없던 채널은 식별자 분해·패턴 도출로 **구축**
- **심층 판독 14채널**: 발굴한 번호·URL을 재투입하면 본문·메타·권리가 나옵니다 — 공훈록 전문, 판결문 사건개요, 장서각 해제, 국가유산 해설, 신문 OCR 원문, UN 요약+6개 언어 PDF, NARA 계보·소장단위·디지털 객체…
- **인접 채굴**: 하나 찾으면 양옆을 훑습니다 — NARA NAID ±N(계보로 시리즈 경계 탐지) · TNA · IA 일련번호 · 6·25아카이브 archRfcd

## 🛠 도구 20종

PlayMCP 제약(도구 ≤20 · 응답 ≤24KB · read-only annotations)을 CI가 푸시마다 검증합니다. 확장은 전부 **파라미터 모드**로.

| 묶음 | 도구 |
|---|---|
| 해외 (6) | `tna_search` · `tna_adjacent_mine` · `nara_search`(RG 교차·NAID 인접·계보·원본 점수) · `ia_search` · `gallica_search` · `europeana_search` |
| 국내 (9) | `nedb_search`(**판독 14모드** — 조선 사료 10 + gonghun·i815 사전·jsg·jacar·un·commons·oldnews·much·indy·heritage·ktv·earchive·nzarch) · `archives_search` · `nlk_search` · `seoul_archives_search` · `foia_search` · `warmemo_search` · `koreanwar_search` · `koreanwar_item` · `scrape_plan` |
| 유틸 (5) | `cross_search`(**30소스** · variants 당대 표기 팬아웃 · **format=text/csv/karda/manifest**) · `judge_rights`(KOGL 자동 + NARA naid 실조회) · `query_bank`(검증 키워드·전략 토픽) · `report_template`(kind 9종 — 보고서 19규칙·카드뉴스·풀패키지·전시·인용·해설) · `source_profile`(**health 30채널 실측**) |

## 🔭 자가 감시 4종 (GitHub Actions, 주간)

| 워크플로 | 역할 |
|---|---|
| `health` | 30채널 골든 질의 실측(🟢🟡🔴 + 응답시간) |
| `retry-blocked` | 차단 6곳 복구 탐침(HTTP 코드+콘텐츠 마커 — 오탐 교정 완료) |
| `nz-harvest` | Archives NZ 주간 수확 → `public/nz-index.json`(간헐 차단 폴백) |
| `fixity-watch` | 골든 8종 본문 지문 재계산 → [공개 원장](https://korea-archive-mcp.vercel.app/fixity-ledger.json) 대조·개정 이력 축적 (NARA는 시크릿 `NARA_API_KEY` 설정 시) |

## 🚀 배포 (직접 운영 시)

<details>
<summary><b>Vercel 배포·환경변수 안내 펼치기</b></summary>

1. 이 저장소를 GitHub에 푸시 → vercel.com → Import → Deploy (Next.js 자동 감지)
2. **Function 리전 → Seoul (icn1) 필수.** 국내 공공 사이트가 해외 데이터센터 IP를 차단하므로 `preferredRegion='icn1'`·`vercel.json`이 고정합니다. 플랜이 무시하면 Project Settings → Functions → Function Region → Seoul 수동 설정.
3. 환경변수(전부 선택):
   - `NARA_API_KEY` — nara_search·judge_rights(naid) 활성 (무료: Catalog_API@nara.gov)
   - `ARCHIVES_API_KEY` — 국가기록원 (data.go.kr 15000153) · `NLK_API_KEY` — 국립중앙도서관 · `EUROPEANA_API_KEY`
   - `KOREANWAR_API_TOKEN` — 협약기관 공식 OpenAPI 메타 채널(Referer 바인딩 — 서버 자동 처리)
   - `NEDB_INDEX_URL` — 한국사DB **robots 준수** 검색: data.go.kr 공식 개방파일을 `scripts/ingest-opendata.mjs`로 인덱싱해 호스팅 후 지정
   - `FETCH_PROXY_PREFIX` — 최후 수단 read-through 프록시 (기본 꺼짐)

같은 배포가 웹 레이어도 서빙: `/`(랜딩) · `/help.html` · `/help-en.html` · `/ingitda.html`(+`/api/overseas`) · `/examples/`(한강 보고서·강연 풀덱 403장) · `/fixity-ledger.json` · `/nz-index.json`
</details>

## 🏗 구조 원칙

- **웹·모바일 동등성** — 지식(규칙·템플릿·프롬프트)은 전부 MCP 도구 응답으로 노출. 로컬 스킬(`.claude/skills/` 10종)과 서버 상수는 패리티 유지
- **3사본 패리티** — 본 저장소(route.js) ↔ [korea-archive-marketplace](https://github.com/changgi/korea-archive-marketplace)(Python plugin server.py·mcp/server.py). `ci-verify`·`ci-parity`가 푸시마다 검증
- **콘텐츠 신뢰** — 실물 기록만(AI 생성 인물·장면 금지), 링크·수치·훈격은 실확인만, 협약기관 출처 표기, 게재윤리 4단계

## 라이선스 · 방법론

MIT · Methodology: Song, Chang-Gi (2026), National Archives of Korea
협약: KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 (koreanwar.or.kr — MOU)
