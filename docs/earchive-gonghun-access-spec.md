# 국편 전자사료관·공훈전자사료관 접근 명세 (2026-11-19 실측)

## ① 국사편찬위 전자사료관 (archive.history.go.kr) — cross_search `earchive`로 합류 ✅
NARA 등 해외 수집 사료의 **국내 원문 창구**(사료ID AUS…=미국 수집 — 노획물자 영상 등 실측 확인).

- **검색**: `POST /search/searchResult.do` — form 필드 `allSearchQuery`·`searchQuery`·`searchPageIndex`·`searchPageUnit`·`searchPageSize`.
  200 응답 HTML에 결과 10건/페이지 + hidden `totalSearchResultCount`(예: 제주도 1,273).
- **파싱**: `fnGoCatalogView('<catalogId>'` 호출 + 같은 태그의 `title="…"` 속성, 인접 700자 내 사료ID
  `[A-Z]{2,3}\d{3}_…`(DCB=국내 충북, DJE=제주, AUS=미국 수집 등 소장·수집 접두).
- **상세 딥링크 없음**: `/record/catalog/catalogView.do?catalogId=…` GET은 302→404 — 세션 기반 POST 뷰.
  → (v1.35에서 해제) **세션 상세 역공학 성공(2026-11-21)**: fnGoCatalogView는 catalogId가 아니라
  **검색 폼 전체+`searchPosition`을 재제출**하는 설계 — 같은 쿠키로 ①`POST /search/searchResult.do`(세션 수립)
  ②`POST /record/catalog/catalogView.do`(동일 폼+searchPosition=순번) 2단 호출 시 상세 44KB가 열린다.
  row-box(label/value)에서 열람조건·이용조건(권리 문구 — judge_rights 투입), 등록번호/청구기호 표, 사료건 ID 추출.
  ※ 평문 매칭은 내비게이션 '열람·이용조건' 메뉴와 혼동 — 반드시 HTML 앵커로. `nedb_search(mode='earchive', query='키워드|순번')`로 제공.
- GET `?keyword=`류는 전부 무시(검색 폼이 POST 전용) — JACAR과 같은 '조용한 무시' 함정 계열.

## ② 공훈전자사료관 (e-gonghun.mpva.go.kr) — 보류 ⛔ (2026-11-19 기준)
- 루트(`/`)가 자체 오류 페이지("존재하지 않는 페이지")를 반환 — 사이트 개편/점검 상태로 추정.
- 대안 경로: 공공데이터포털 **15157239**(국가보훈부 독립유공자 공적 정보 — data.go.kr API). 이 작업 환경에서
  data.go.kr이 차단되어 메타 확인 불가 — 포털에서 신청·키 발급 후 `MPVA_API_KEY`류로 서버 합류 가능.
- 재점검 시점: 사이트 복구 또는 API 키 확보 시. '훈격 실확인' 1차 소스로 우선순위 유지.

## 공훈전자사료관 복구 확정 — cross_search `gonghun` 합류 (2026-11-20 실측)

과거 '사이트 오류'로 보류했던 e-gonghun.mpva.go.kr 가 복구됐다(재점검 주기의 성과). **전 경로 키 없는 GET.**

- 검색: `GET /user/ContribuReportList.do?goTocode=20001&nameKd=NAME_KOR&nameKo=<이름>&pageIndex=1&pageUnit=10`
  — **인명 검색 채널**(독립유공자 공훈록). 일반 키워드는 0건이 정상. ※ indexMain.do는 404 — 목록 경로로 직행할 것.
- 성명은 `utf8_decode('<base64>')` JS로 렌더 — base64 디코드 필요. 한자명은 `<td class="chinese">`.
  행 구성: 성명·한자명·생몰년·운동계열·포상년도·포상훈격·생존여부·본적(base64 2분절).
- 상세 딥링크: `GET /user/ContribuReportDetail.do?goTocode=20001&mngNo=<관리번호>&pageTitle=Report`
  — 공적개요(공적조서)·공훈록·독립운동 인명사전 연계·묘소정보·관련 현충시설까지 한 페이지(실측 ~100KB).
- 실측: 안중근 mngNo=3150(1962 대한민국장) · 유관순 mngNo=3536(2019/1962 대한민국장/독립장) · 윤봉길(1962 대한민국장).
- OpenAPI 안내 페이지 4종 존재(RewardOpenAPI·IndepCrusaderOpenAPI·ContribuMeritOpenAPI·OverseaIndepHistDataOpenAPI)
  — 공공데이터 키 확보 시 구조화 JSON 경로로 승격 가능.
- 같은 날 재점검: kdemo(검색 경로 여전히 오류)·UN Archives(JS 챌린지 유지)는 보류 지속.
