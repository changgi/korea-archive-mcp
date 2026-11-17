# KOREA ARCHIVE 통합검색 — 프로젝트 전체 갈무리 (2026-11-17)

> 본 문서는 세션 기록과 저장소 실측(커밋·코드·배포 상태)을 기준으로 작성한 현황 정리이며,
> 저장소에 커밋되지 않은 참고용 파일이다.

---

## 1. 무엇을 만들었나 — 한 줄 요약

**한국 관련 기록(1860~1960 중심)을 국내외 15개 기관에서 발굴·교차검증·산출물 제작까지
한 번에 수행하는 AI 에이전트용 도구 모음.**
웹·모바일 사용자는 원격 MCP 커넥터로, 로컬(Claude Code/Desktop) 사용자는 플러그인+스킬로
동일한 20개 도구를 사용한다.

---

## 2. 구조 — 두 개의 저장소, 세 개의 서버 사본

```
changgi/korea-archive-mcp (Node) ──── Vercel 자동배포(리전 icn1) ──── 웹·모바일 커넥터
 └ app/api/[transport]/route.js      (1,819줄, 도구 20종, main @ e45dce4)
 └ .claude/skills/ (11종)            로컬 전용 심화 노하우
 └ public/ (help.html·gallery·showcase)  랜딩·안내 페이지
 └ example/ (풀패키지 예시 산출물)

changgi/korea-archive-marketplace (Python) ─── 로컬 플러그인 서버 (main @ e8e7a21)
 └ plugins/korea-archive/servers/server.py   배포본 (1,924줄, 도구 20종)
 └ plugins/korea-archive/skills/ (11종)      플러그인 동봉 스킬
 └ mcp/server.py                             개발·로컬 실행용 진입점 (배포본과 동기화 완료)
 └ harvester/·collector/·keywords/           수집기·권리대장·키워드셋 252종
 └ docs/ (보고서·쿼리코퍼스·캐러셀·기관 프로파일)
```

**패리티 원칙**: 세 서버 사본(route.js·배포본 server.py·개발용 server.py)은 도구 20종·공유
상수(TOPICS 다국어 사전·보고서 규칙·매직 키워드)가 항상 동일해야 한다. 2026-11-13 실측으로
세 사본 모두 일치 확인(런타임 등록 20종, py_compile·node --check 통과).

**제1원칙 — 웹·모바일 동등성**: 스킬은 로컬 전용이므로, 모든 지식(규칙·템플릿·프롬프트)은
MCP 도구 응답으로도 노출한다. 로컬 실행 의존 단계(헤드리스 크롬 렌더 등)는 도구 응답에
웹 대체 경로(아티팩트 미리보기·Canva 커넥터)를 명시한다.

---

## 3. 내용 — 도구 20종 (PlayMCP 제약: 20개 이하 준수)

### 해외 (6)
| 도구 | 기관 | 특장점 |
|---|---|---|
| `tna_search` | 영국 국립기록보존소 Discovery | 참조코드 자동 정확구 검색 |
| `tna_adjacent_mine` | TNA | 인접 참조코드 ± 확장 채굴(Adaptive Mining) — 미발굴 승격 후보 |
| `nara_search` | 미국 NARA | RG(기록군) 교차·영상 한정 검색 |
| `ia_search` | archive.org | 검색 + identifier 메타·파일 확인 통합 |
| `gallica_search` | 프랑스 BnF Gallica | **한→프 자동 변환**(병인양요→expédition de Corée 등) |
| `europeana_search` | 유럽 58개국 4,000+ 기관 | 통합검색 |

### 국내 (9)
| 도구 | 기관 |
|---|---|
| `nedb_search` | 국사편찬위 한국사DB (1차 사료 1,100만+) |
| `archives_search` | 국가기록원 OpenAPI |
| `nlk_search` | 국립중앙도서관 6개 컬렉션 |
| `seoul_archives_search` | 서울기록원 |
| `foia_search` | 정보공개포털 + 지방 정보공개·기록원(서울정보소통광장·서울시교육청·경남기록원) 통합 |
| `warmemo_search` | 전쟁기념관 아카이브 |
| `koreanwar_search` | **KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터(협약기관)** — 통합검색 + 전투정보 DB(`scope=battle`), 생산연도·수집구분 필터 |
| `koreanwar_item` | 동 센터 건별 메타 + **NARA 역추적(NAID 직결)** + 인접 채굴(`radius=1~8`) |
| `scrape_plan` | robots 확인 + 브라우저 도구 폴백 안내 |

### 유틸 (5)
| 도구 | 기능 |
|---|---|
| `query_bank` | 검증 쿼리 세트 44그룹 + 국내 3대 부정합 키워드셋 252종 |
| `judge_rights` | 권리 등급 자동 초기판정 |
| `report_template` | HTML 발굴 보고서·캐러셀·Canva 프롬프트·**풀패키지·help** 등 kind 모드 |
| `cross_search` | 여러 아카이브 동시 교차수집·병합 |
| `source_profile` | 기관별 자료·이용·활용구조 3층 프로파일 |

### 매직 키워드 (커넥터 instructions + 도구 description 이중 장전)
- **"풀패키지"** → `report_template(kind=full_package)`: 발굴 조사→실물 이미지 수집→HTML 보고서→인스타 캐러셀 8장→Canva 편집본·포스터까지 되묻지 않고 전부 제작.
- **"창기창기" / "changgi-help" / 사용법 질문** → `report_template(kind=help)`: 신규 사용자 안내.

### 로컬 스킬 11종 (양쪽 저장소 동봉)
archival-discovery-pipeline(영상·사진 프레임 분석·슬레이트 판독·온톨로지 변환),
insta-carousel(1080px 카드뉴스 렌더), joseon-source-excavation/mining(조선 1차 사료 POST 접근·판독),
khdb-citation·nanet-citation(각주·참고문헌 자동), kyujanggak-images(규장각 도판 4단계 파이프라인),
record-annotation(판독 마커 해설 카드), korea-full-package, changgi-help, korea-archive-discovery.

---

## 4. 기능과 쓰임새

| 사용자 | 쓰임새 |
|---|---|
| **역사 연구자** | 교차검색→인접 채굴→원문 확인→표준 각주·참고문헌 생성. 조선 제도사(법전·등록·승정원일기)는 POST 전용 사이트까지 접근 |
| **아카이브 기관·학예사** | 재기술(표제-내용 불일치 교정), 슬레이트 판독, RiC-O/CIDOC-CRM 온톨로지 변환, 전시 캡션·도판 |
| **콘텐츠 제작자·언론** | 풀패키지 한 번에: 잡지형 HTML 보고서(18규칙) + 인스타 캐러셀 8장 + 게시 캡션·해시태그 + Canva 편집본 |
| **교육** | 수업 자료·핸드아웃(example/ 조선 선박 덱·한강 주운 사례 등 실증 완료) |
| **일반 대중** | 웹·모바일 Claude에서 커넥터만 연결하면 "장진호 풀패키지"로 즉시 사용 |

**콘텐츠 신뢰 원칙**: 실물 기록만(AI 생성 인물·장면 금지), 링크·수치·훈격은 API 원문 실확인분만,
협약기관 기록 출처 표기 필수, 게재윤리 4단계(포로·사망자 존엄) 적용.

---

## 5. 성능 — 실측 결과

| 항목 | 수치 | 비고 |
|---|---|---|
| 다국어 자동 변환 | 한→영·프 TOPICS 43항목 | 장진호→Chosin Reservoir, 이승만→Syngman Rhee 등 |
| Gallica 한국어 질의 | **0건 → 5,853건** | "병인양요 선교사" — PlayMCP 반려 사유 해소 |
| koreanwar 라이브 검증 | "임규호" 20건 실결과 | 배포 서버에서 실측 |
| 도구 수 | 정확히 20종 | PlayMCP 상한 준수 |
| 응답 크기 | 24KB 이하 (UTF-8 바이트 실측 관리) | 한글 3B/자 |
| 서버 규모 | Node 1,819줄 / Python 1,924줄 | 공유 상수 패리티 유지 |
| 검증 체계 | node --check + py_compile + 런타임 등록 실측 | 3사본 20종 일치 확인(11-13) |
| 전투정보 DB | 개전 초기(1950.6.25~9.14) 단계 수록 | **확장 중** |

버전: 마켓플레이스 plugin v1.16.0 / mcp 저장소 v1.11.0 계열 병합 완료.
배포: Vercel icn1, main 푸시 시 자동 배포, 커넥터 라이브 동작 확인.

---

## 6. 다음 작업 (우선순위순)

### A. 즉시 — 심사·운영
1. **PlayMCP 콘솔 "정보 불러오기" 재실행** — koreanwar 도구 추가·도구명 축약 이후 스키마가
   바뀌었으므로 필수. 이후 심사 재신청(반려 사유였던 한국어 질의 0건은 다국어 변환으로 해소됨).
2. **`mcp/requirements.txt`에 `mcp<2` 버전 고정** — mcp 2.x에서 FastAPI(FastMCP) 임포트가
   깨지는 것을 11-13 실측으로 확인. 로컬 설치 사용자 보호.
3. **CHANGELOG 현행화** — 마켓플레이스 CHANGELOG가 v1.16.0(8-19)에서 멈춰 있으나 이후
   커밋(koreanwar·다국어·매직 키워드·패리티 동기화)이 다수. v1.17 항목 정리.

### B. 단기 — 기능 확장
4. **koreanwar 전투정보 DB 확장** — 현재 개전 초기 단계만 수록. 인천상륙~1.4후퇴~고지전 단계 증보.
5. **다국어 사전 확대** — 일본어(JACAR·NDL 대비)·중국어·러시아어 우선, 계획된 14개 언어 순차 구축.
   PlayMCP 글로벌 사용자 대응.
6. **aks-archive-harvester(한국고문서자료관) 서버 노출 검토** — 스킬은 존재하나 서버 도구가 없음.
   제1원칙(웹 동등성) 위반 상태. 단 도구 20개 상한이므로 신규 도구가 아니라 기존 도구
   (nedb_search 또는 cross_search)의 enum 모드로 흡수.

### C. 중기 — 품질·자동화
7. **CI 자동화(GitHub Actions)** — 푸시마다 node --check·py_compile·3사본 도구명 diff·
   응답 24KB 바이트 검사 자동 실행. 지금은 전부 수동.
8. **스킬-서버 패리티 스플라이스 스크립트 정비** — 캐노니컬(스킬 에셋)→서버 상수 반영을
   스크립트화해 수동 누락(이번 mcp/server.py 사례) 재발 방지.
9. **CLAUDE.md의 `D:\korea-archive-marketplace` 경로 표기 일반화** — Windows 로컬 전제 표기를
   클라우드 세션 경로와 병기.

### D. 홍보·확산
10. 인스타 캐러셀 8장(1080×1350) + 플랫폼별 캡션 게시 — 제작 완료분 활용.
11. 랜딩(help.html·showcase) 링크 배포, "기록잇다" 출품 세트 후속.
