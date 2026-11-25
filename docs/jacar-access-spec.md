# JACAR(아시아역사자료센터) 접근 명세 — 슬롯 재편 투입 준비 (2026-11-19 전수 실측)

일본 국립공문서관(A)·외무성 외교사료관(B)·방위성 방위연구소(C) 3기관 한 창구. 조선총독부·재외 한인·관동군 등
일제강점기 한국 관련 기록의 최대 창구 중 하나. **전 경로가 키 없는 GET으로 동작하며, 데이터센터 IP에서도 열림**(실측).

## 1. 키워드 검색 — GET ✅
```
GET https://www.jacar.archives.go.jp/aj/search-en?kw=Chemulpo
→ 200, 키워드별 유관 결과(제물포 → 해군 소장 보고서 등). 페이지당 ~16건, 건수 표시는 5,000 상한
```
- ★검색어 파라미터는 **`kw`** — `keyword`·`q`·`freeword` 등은 조용히 무시되고 기본 목록을 반환한다(파라미터명 오인 시
  "모든 키워드가 같은 결과"가 되는 함정 — 서로 다른 키워드로 첫 코드 대조 검증 필수).
- 기타 파라미터(검색 폼 실측): `date_y_from`/`date_m_from`/`date_y_to`/`date_m_to`(**연대 필터 내장**) ·
  `inst`(기관 A/B/C) · `fond` · `type`/`datatype` · `description` · `sf` · `lng`
- 주의: `rows=5`처럼 폼에 없는 값은 400 — 폼 허용값만 사용. 일본어판은 `/aj/search`.
- 파싱: 결과 HTML에서 `[A-Z]\d{11}` 레퍼런스코드 추출 가능(실측 16건/페이지). 제목은 코드 인접 마크업에서 — 투입 시 정밀화.
- TOPICS 한→일 출력 사전 필요(현재 입력 패턴만 보유): 조선→朝鮮, 총독부→総督府, 경성→京城 등.

## 2. 레퍼런스코드 직행 — GET ✅
```
GET https://www.jacar.archives.go.jp/das/meta/B04014056900      (일본어)
GET https://www.jacar.archives.go.jp/das/meta-en/B04014056900   (영어)
→ 200, 건 상세(제목 '帝国政府ノ国際連盟脱退関係一件' 등 메타)
```
- 코드 체계: 영문 1자(기관: A=공문서관·B=외무성·C=방위연) + 숫자 11자리. query_bank world 지식과 일치 실확인.

## 3. 계층 브라우징 — GET ✅
```
GET https://www.jacar.archives.go.jp/das/meta-en/AA0000000000   (공문서관 최상위)
GET https://www.jacar.archives.go.jp/das/meta-en/BA0201000000   (외무성 하위 계층)
```
- 루트 페이지가 AA/BA… 계층 코드 링크를 노출 — 트리 하강 가능(AKS treeAjax와 유사한 드릴다운 설계 적용 가능).

## 4. 투입 설계(심사 통과 후 슬롯 재편 시)
- 흡수처 후보: `warmemo_search`→`koreanwar_search` scope 흡수로 1슬롯 확보 → `jacar_search` 신설,
  또는 cross_search 소스 `jacar` 합류(도구 수 불변 — **즉시 가능**).
- 모드: 검색(keyword+연대+기관) · 직행(레퍼런스코드) · 인접(코드 말미 숫자 ±N — 11자리 일련 구조라 TNA식 옆 훑기 적합).
- 권리: JACAR 콘텐츠는 출처 표기 조건 이용(기관 고지 확인 후 judge_rights 규칙 추가).
- 예절: 과도 병렬 금지, 결과 페이지 캐시(TTL) 적용.

## 5. (v1.23 반영) 전용 모드 승격 완료 + 추가 실측
- `nedb_search(mode='jacar')`: 검색(한→일 JA_MAP 48항 우선)·레퍼런스코드 메타 직행(Title·Creator·이미지 수·기밀등급 파싱)·
  **인접 채굴 ±span×100** — 簿冊 내 건 번호 간격이 100 단위임을 실측(±1·±10은 404, ±100은 같은 건명 연속).
- cross_search `jacar`와 역할 분담: 연합 검색=발굴 신호, 모드=심층(메타·인접).

## 6. 장서각(jsg.aks.ac.kr)·민주화운동 오픈아카이브 — 보류 기록 (2026-11-20 실측)
- 장서각: ~~비공개 XHR 추정~~ → **v1.24에서 해제**: Playwright 실브라우저 재역공학으로 실제 형식이 `q=query|<검색어>`(필드 접두 필수)임을 확정 — 플레인 `q`는 조용히 무시되고 전체 열람(134만건)을 반환하는 함정이었다. cross_search `jsg` 소스로 합류(의궤 33,805건·K2 청구기호·ANC 고문서 직행 링크).
  확보된 것: **청구기호 직행** `GET /dir/view?dataId=JSG_<청구기호>` ✓, 원문이미지 레이어 `/dir/ajaxImgVolLayer`. 검색 역공학 재시도 대상.
- 민주화운동 오픈아카이브(archives.kdemo.or.kr): `/main`은 200이나 검색 경로가 오류 페이지 — 개편 중 추정, 재점검 대상.
