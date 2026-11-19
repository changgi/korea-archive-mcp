# 독립기념관(i815)·KTV e영상역사관 접근 명세 (2026-11-19 실측) — cross_search 합류 ✅

## ① 독립기념관 한국독립운동정보시스템 (search.i815.or.kr) — 소스 `i815`
- **검색**: `GET /main/totalSearch.do?searchWord=<어>&searchMenu=all` — ★`searchMenu` 누락 시 500 (폼의 select 필수값).
  쿠키·CSRF 없이 동작(루트 폼에 _csrf가 있으나 GET 검색엔 불요 — 실측).
- **파싱**: 카테고리별 집계 링크 `href="/main/moreContentsSearchList.do?content=…&searchOption=<분류>&searchWord=…">분류 N 건`
  — 대한민국임시정부·독립운동가 자료·마이크로필름·미주흥사단·신문자료·의병자료·피해자 명부 등. 수집기는 분류·건수·직행 링크를 신호 채널로 반환.
- 독립운동가 인명사전(이명·가명·호 생성)은 별도: search.i815.or.kr/dictionary — 인명 열쇠(query_bank persons)와 연계 여지.

## ② KTV e영상역사관 (ehistory.go.kr) — 소스 `ktv`
- ehistory.go.kr 자체 /search 는 셸 페이지(iframe) — **실체는 ktv.go.kr 통합검색**:
  `GET https://www.ktv.go.kr/totalSearch/ehistory?design=new&collection=ehistory&baseKeyword=<어>` (판문점 → 총 2,641건).
- **파싱**: `href="https://www.ehistory.go.kr/view/movie?mediasrcgbn=KV&mediaid=…"` + 제목 — 대한뉴스·정책 기록영상 딥링크.
- 권리: KTV 콘텐츠는 공공누리 표기 확인 후 이용(건별 KOGL 유형 상이) — judge_rights(KOGL) 연계.

## ③ JACAR 한→일 출력 사전 (`JA_MAP`, 16항)
- 일본어 질의가 영어와 **다른 결과축**을 연다(실측: 朝鮮総督府 → 총독부 행정·법령류 vs Chosen → 일반).
- jacar 수집기 적용 순서: 한→일 사상 → 한→영(TOPICS) → 원문.
