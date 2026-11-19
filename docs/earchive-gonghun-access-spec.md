# 국편 전자사료관·공훈전자사료관 접근 명세 (2026-11-19 실측)

## ① 국사편찬위 전자사료관 (archive.history.go.kr) — cross_search `earchive`로 합류 ✅
NARA 등 해외 수집 사료의 **국내 원문 창구**(사료ID AUS…=미국 수집 — 노획물자 영상 등 실측 확인).

- **검색**: `POST /search/searchResult.do` — form 필드 `allSearchQuery`·`searchQuery`·`searchPageIndex`·`searchPageUnit`·`searchPageSize`.
  200 응답 HTML에 결과 10건/페이지 + hidden `totalSearchResultCount`(예: 제주도 1,273).
- **파싱**: `fnGoCatalogView('<catalogId>'` 호출 + 같은 태그의 `title="…"` 속성, 인접 700자 내 사료ID
  `[A-Z]{2,3}\d{3}_…`(DCB=국내 충북, DJE=제주, AUS=미국 수집 등 소장·수집 접두).
- **상세 딥링크 없음**: `/record/catalog/catalogView.do?catalogId=…` GET은 302→404 — 세션 기반 POST 뷰.
  → 수집기는 사료ID를 표기하고, 이용자는 사이트에서 사료ID로 재검색해 직행.
- GET `?keyword=`류는 전부 무시(검색 폼이 POST 전용) — JACAR과 같은 '조용한 무시' 함정 계열.

## ② 공훈전자사료관 (e-gonghun.mpva.go.kr) — 보류 ⛔ (2026-11-19 기준)
- 루트(`/`)가 자체 오류 페이지("존재하지 않는 페이지")를 반환 — 사이트 개편/점검 상태로 추정.
- 대안 경로: 공공데이터포털 **15157239**(국가보훈부 독립유공자 공적 정보 — data.go.kr API). 이 작업 환경에서
  data.go.kr이 차단되어 메타 확인 불가 — 포털에서 신청·키 발급 후 `MPVA_API_KEY`류로 서버 합류 가능.
- 재점검 시점: 사이트 복구 또는 API 키 확보 시. '훈격 실확인' 1차 소스로 우선순위 유지.
