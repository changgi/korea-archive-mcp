# PlayMCP 심사 대응 팩 — KOREA ARCHIVE 통합검색 (v1.51, 2026-11-21)

콘솔 "정보 불러오기" 재실행 후, 아래 질의로 전 기능을 시연할 수 있다. 전부 2026-11-18~21 프로덕션 실측으로 검증된 질의·결과이다.

## 제약 준수 요약
| 항목 | 상태 |
|---|---|
| 도구 20개 이하 | 정확히 20개 (CI `ci-verify.mjs`가 푸시마다 검증 — 확장은 전부 파라미터 모드) |
| 응답 24KB 이하 | **공통 가드** — 전 도구 UTF-8 바이트 실측 트렁케이션(23,800B) |
| description 서비스명 + 1024자 | 래퍼 자동 부착·자동 절단 (CI 검증) |
| annotations read-only | 래퍼 일괄 적용 |
| 한국어 질의 | 전 도구 한국어 입력 → 색인 언어 자동 변환(TOPICS 85항목 · 한→일 JA_MAP 48항목) |

## 심사 반려 사유(한국어 질의 0건) 해소 증빙
| 질의 | 이전 | 현재 (실측) |
|---|---|---|
| gallica_search("병인양요 선교사") | 0건 | → "expédition de Corée 1866" 자동 변환, 5,853건 (2026-08 실측. ※BnF가 간헐적으로 서버 IP를 차단하며, 차단 시 도구가 사실을 명시하고 브라우저 경로를 안내) |
| ia_search("장진호") | 1건 | → "Chosin Reservoir" 139건 |
| tna_search("임진강") | — | → "Imjin River" 글로스터 연대 기록 직행 |
| nedb_search("징용", mode="jacar") | — | → 徴用 자동 변환, 일본 아시아역사자료센터 직결 |

## 시연 질의 19선 (실측 완료)
1. **다국어 변환**: `tna_search("임진강", year_from=1950, year_to=1953)` — 영문 자동 변환 + 연대 필터(Korea 13,533→2,553건 축소 실측).
2. **협약기관**: `koreanwar_search("인천상륙")` — 55,000+ 소장, NARA RG 역추적 링크. `scope="battle"`로 전투정보.
3. **인접 채굴 5기관**: `nara_search(naid=22015, radius=2)` — 인천상륙 D-DAY 연속 필름(111-ADC-8247~8251) 일괄 발굴. `ia_search(identifier="111-adc-10076", radius=2)` · JACAR ±span×100 · TNA · 6·25아카이브.
4. **교차검색 28소스**: `cross_search("장진호")` — 채널별 건수 태그, 복수출처=교차확인. 미·영·프·EU·일·호주·네덜란드 + 국내 14기관.
5. **당대 표기 팬아웃**: `cross_search("한국전쟁", variants=true)` — `ia·Corean` 변형만으로 추가 4건 실측.
6. **분석 투입**: `cross_search("장진호", format="csv")` — CSV 직출력.
7. **고문서**: `nedb_search("송준길", mode="aks")` — 소장처 172곳→분류→문서 266건→건별 27면 썸네일 실측.
8. **독립유공자 심층 판독**: `nedb_search("유관순", mode="gonghun")` → mngNo 3536 → `nedb_search("3536", mode="gonghun")` — 공적조서·공훈록 전문·수형기록(판결문)·묘소·현충시설 11곳 한 번에 (국가보훈부 공훈전자사료관, 2026-11-20 실측). 이어 `nedb_search("사전:유관순", mode="i815")` → 항목 614 — 한국독립운동인명사전 기본정보(생몰·본관·이명 冠順)+전기 전문 4,000자(공공저작물, 2026-11-21 합류 실측).
9. **권리 표시 자동화**: `judge_rights("KOGL 1")` → Class A. `judge_rights(naid=22015)` → NARA 카탈로그 **Use Restriction 실조회** 'Restricted - Possibly · Copyright' → C 자동판정 / naid=535795 → 'Unrestricted' → A 확정 (발굴 우선 — 권리는 표시).
10. **자가 점검**: `source_profile("health")` — 28채널 골든 질의 실측 + 채널별 응답시간(ms). 주간 CI 자동 실행.
11. **일본 측 기록**: `nedb_search("B04014056900", mode="jacar")` — 레퍼런스코드 메타 직행(Title·이미지 수·기밀등급), ±span 인접 채굴.
12. **장서각 해제**: `nedb_search("K2-3556", mode="jsg")` — 개건도감의궤(1776 경모궁 개건) 서지+해제 전문 1,500자(판식·장정·참고문헌까지).
13. **UN 문서 판독**: `cross_search("정전협정", sources="un")` → 문서기호 발굴 → `nedb_search("808136", mode="un")` — 요약·주제·6개 언어판 PDF 직링크.
14. **PD 파일 판독**: `nedb_search("File:NH 96379 …", mode="commons")` — Public domain → A 자동판정, 원 소장처(해군역사사령부) 크레딧·5622×4421 원본.
15. **당대 신문 3단**: `cross_search("안중근", sources="oldnews")` → 대한매일신보 공판 보도 → `nedb_search("CNTS-…", mode="oldnews")` 색인어 26개·관련기사 연쇄 → `'본문:단지동맹|1907-1908'` OCR 원문 발췌+연도 분포(1907:54 — 안중근 이전 유학생 단지동맹 물결 발견).
16. **판결문 완주**: gonghun 수형기록 → `cross_search("유관순", sources="indy")` → `mode="indy"`(상세 URL) — 당시 18세·본적·죄명·주문·사건개요·원문 뷰어. 두 기관 기록 정합 실증.
17. **박물관 실물+KOGL 자동**: `nedb_search("PS…-003418-…", mode="much")` — 「판문점 미루나무 작전」 영화 포스터: 재질·크기·**공공누리 제4유형→B 자동 초판정**·설명.
18. **국가유산 해설**: `nedb_search("근정전", mode="heritage")` → 복합 id → 재투입 — [국보]·시대(1867 중건)·**해설 전문**(정도전 작명·다포식·12지신상). 전시·공간사 맥락 직결.
19. **매직 키워드**: "장진호 풀패키지로 만들어줘" → full_package 오케스트레이션 / "창기창기 도와줘" → help.

## 알려진 채널 상태 (health 실측, 2026-11-21 — 27채널)
- 🟢 **24채널 정상** — 신규 합류 6소스(oldnews·much·indy·commons·un·ndl) 전부 녹색. 응답시간 중앙값 ~1.1s
- 🟡 nedb(개방파일 인덱스 미설정 — NEDB_INDEX_URL 설정 시 합류)
- 🔴 기지 2: gallica(BnF 서버 차단 — 사실 명시+브라우저 안내로 우아한 성능저하) · foia(opengov 리셋 — 6s fail-fast로 영향 격리)
- `source_profile("health")`로 언제든 실측(채널별 ms). 주간 GitHub Actions 자동 감시.


## 성능·견고성
- 28소스 전수 연합('한국전쟁' all) 실측 12.4초 — 소스별 12s 타임박스 상한 수렴, 25채널 수확·병합 64건(실패 채널은 — 표시로 투명).
- 소스별 12초 타임박스(최저속 소스가 전체 지연을 지배하지 않음) · 느린 소스 TTL 캐시(규장각 10.2s→0.4s, AWM·JACAR 상세 24h) · 차단·오류 응답은 캐시하지 않음(마커 검증).

## 심층 판독 12채널 (발굴→분석 다리)
cross_search 27소스로 발굴한 URL·번호를 재투입하면 본문·메타·권리가 도구 응답으로 나온다 — 연합 검색 푸터가 경로를 자동 안내.
- nedb_search 모드: i815(1910년대 신문·자료 전문 + '사전:이름'=한국독립운동인명사전 — 전기 전문·생몰·본관·이명·훈격, 공공저작물) · gonghun(공적조서·공훈록·수형기록) · jacar(일본 공문서 메타·인접) · ktv(대한뉴스 해설) · earchive(수집 사료 열람·이용조건) · commons(PD→A/B/D 자동) · jsg(장서각 해제 전문) · un(UN 요약·언어별 PDF) · oldnews(색인어·관련기사 연쇄·'본문:' OCR 전문+연대) · much(소장품·공공누리 자동판정) · indy(판결문 — 죄명·주문·사건개요·원문 뷰어) · heritage(국가유산 — 해설 전문·시대, 복합 id)
- seoul_archives_search(상세 URL → 식별번호·이용조건) · koreanwar_item(archRfcd) · judge_rights(naid — NARA Use Restriction 실조회)
