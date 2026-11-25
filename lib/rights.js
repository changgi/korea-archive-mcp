export function judgeRights(rg = '', title = '', archive = '') {
  const RG = rg.toUpperCase(); const T = title.toUpperCase(); const A = archive.toUpperCase();
  if (RG.includes('RG 242') || RG.startsWith('242'))
    return ['D', '[자동초판] RG 242 노획필름 — 원산국 권리 잔존 가능(NARA 미보증, 36 CFR 1254.62). 이용자 책임 · 재검토 연1회'];
  if (T.includes('UNIVERSAL') || RG.includes('200-UN'))
    return ['B', '[자동초판] Universal Newsreel — MCA가 1970년대 권리를 미 정부에 양도(NARA newsreels 페이지). 릴 내 제3자 콘텐츠 QC 필요'];
  if (['RG 111','RG 208','RG 306','RG 342','RG 428','RG 127','111-','208-','306-'].some(x => RG.includes(x)))
    return ['B', '[자동초판] 미 연방정부 직무저작물 추정(17 U.S.C. §105) — 카탈로그 Use Restriction Unrestricted 확인 시 A로 상향'];
  const kogl = (RG + ' ' + T + ' ' + A).match(/(?:KOGL|Korea Open Government Licen[cs]e)[\s-]*(?:Type|제)?\s*([1-4])|공공누리\s*(?:제\s?)?([1-4])\s*유형/i); // 'KOGL Type 1'(Commons 표기)·정식 영문명 포함
  if (kogl) {
    const n = kogl[1] || kogl[2];
    const K = { '1': ['A', '공공누리 제1유형 — 출처표시만으로 자유이용(변경·상업 가능)'],
                '2': ['B', '공공누리 제2유형 — 출처표시 + 상업적 이용 금지'],
                '3': ['B', '공공누리 제3유형 — 출처표시 + 변경 금지'],
                '4': ['B', '공공누리 제4유형 — 출처표시 + 비상업 + 변경 금지'] }[n];
    return [K[0], `[자동초판] ${K[1]} (kogl.or.kr 조건 전문 확인)`];
  }
  if (A.includes('KOFA') || A.includes('KBS'))
    return ['C', '[자동초판] 한국 저작물 — 저작권 존속 전제, 허가 취득 후 공개'];
  return ['D', '[자동초판] 지위 불명 — 권리 판단 플로 수동 수행 필요'];
}
