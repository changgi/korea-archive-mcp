# 30곳 문서고 탐방 — 인스타그램 캐러셀 세트 (v2)

- `build/NN/` — 시리즈 NN의 캐러셀(NN_01.jpg … 1080×1080, 올리는 순서 그대로) + `caption.txt`(소개글·출처·해시태그)
  - 1장: 원본 이미지로 가득 찬 첫 장 · 2장: 함께 찾은 원본 모음 · 3장: 사진·문서 속 글자를 짚어 읽는 해설 카드
  - (영상이 있으면) 장면 해설 카드 — 장면 전환 자동 탐지 → 대표 장면, 시각 코드 표시
  - 기록 정보 카드 · 직접 해 보기 카드
- `img/NN/` — 수집한 원본 이미지와 `ledger.json`(출처·권리 근거·보이는 사실)
- `video/` — 영상 장면 추출 결과(scenes.json·대표 프레임·타임라인)
- 재생성: `plan.json`(카드 구성) → `python3 gen_v2.py NN` → `make_carousel.py build/NN/source.html --outdir build/NN` → `python3 gen_caption.py NN`
- 권리 원칙: 공공누리 4유형 원형 유지(_nocrop), 허가 필요 이미지 미게재, 참고 이미지는 카드에 명기, 포로·묘지·수형자 사진 제외
