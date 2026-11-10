#!/usr/bin/env node
/**
 * 판단 범위 측정
 *
 *   node coverage.js
 *
 * 실제 국민이 쓸 법한 표현으로 얼마나 맞게 갈라지는지 잽니다.
 * 보류는 안전장치이지만, 정당한 질문까지 보류하면 도구가 쓸모없어집니다.
 * 두 가지를 함께 봅니다 — 맞게 고르는 비율, 그리고 헛보류 비율.
 */

const puppeteer = require('puppeteer');
const path = require('path');

/* 세 묶음으로 나눠 잽니다.
   A. 쉬운 표현 — 갈래를 짐작할 낱말이 또렷한 경우
   B. 어려운 표현 — 에두르거나 구어체이거나 낱말이 흐린 경우
   C. 범위 밖   — 이 서비스가 다루지 않는 영역. 반드시 보류해야 함
   시험 문장을 사전과 같은 사람이 만들면 점수가 부풀기 때문에,
   B와 C를 넉넉히 넣어 실제 쓸모를 봅니다. */

const EASY = [
  ['할아버지가 오키나와에 끌려갔다는데 기록이 있을까요', 'okinawa'],
  ['일제 강제동원 피해 입증 자료가 필요합니다', 'okinawa'],
  ['징용 갔다 오신 분 기록 어디서 찾나요', 'okinawa'],
  ['사할린에 남으셨던 큰아버지를 찾고 싶어요', 'okinawa'],
  ['정신대로 끌려간 고모 기록', 'okinawa'],
  ['돌아가신 아버지 명의 땅이 있다는데 확인하고 싶어요', 'land'],
  ['조상 땅 찾기 어떻게 하나요', 'land'],
  ['임야가 할아버지 앞으로 되어 있다는데', 'land'],
  ['옛날 토지대장 떼려면 어디로 가요', 'land'],
  ['지적원도 열람 신청', 'land'],
  ['아버지 병적기록 떼는 방법', 'service'],
  ['학적부 조회하고 싶습니다', 'service'],
  ['제적등본으로 가족관계 확인하려고요', 'service'],
  ['폐교된 학교 졸업 증명은 어디서 받나요', 'service'],
  ['해외로 입양됐는데 친생부모 기록을 찾을 수 있을까요', 'adoption'],
  ['입양 기록을 열람하려면 어디로 가야 하나요', 'adoption'],
  ['뿌리찾기를 하고 싶습니다', 'adoption'],
  ['재개발로 사라지는 우리 동네 기록을 모으고 싶어요', 'town'],
  ['마을 옛날 사진으로 전시를 하려고 합니다', 'town'],
  ['철거되는 아파트 단지 기록이 남아 있나요', 'town'],
  ['주민들과 동네 역사 전시를 준비합니다', 'town'],
];

const HARD = [
  // 에두른 표현 — 핵심 낱말을 직접 쓰지 않음
  ['일본에 끌려가셨다가 못 돌아오신 분이 계신데요', 'okinawa'],
  ['해방 전에 배 타고 나가신 분 자취를 찾습니다', 'okinawa'],
  ['우리나라 자료가 외국 문서고에 있다고 들었습니다', 'okinawa'],
  ['만주로 이주한 집안 기록 찾기', 'okinawa'],
  // 구어체·불완전 문장
  ['아버지 앞으로 된 논이 있다던데 그거 확인 되나요', 'land'],
  ['할아버지 물려주신 산이 어디 있는지 모르겠어요', 'land'],
  ['상속 때문에 옛날 서류가 필요해서요', 'land'],
  ['군대 갔다 온 거 증명할 방법 없을까요', 'service'],
  ['참전 사실을 증명할 기록이 필요해요', 'service'],
  ['호적이 옛날 거라 확인이 안 됩니다', 'service'],
  ['어릴 때 시설에 있다가 외국으로 갔습니다. 그때 서류를 보고 싶어요', 'adoption'],
  ['낳아주신 분을 찾고 싶은데 어디서 시작해야 할지 모르겠어요', 'adoption'],
  ['우리 지역 변천사를 알 수 있는 자료', 'town'],
  ['살던 동네가 없어져서 기록이라도 남기고 싶습니다', 'town'],
];

const OUT_OF_SCOPE = [
  ['특허 출원 서류를 보려면 어떻게 하나요', '지식재산'],
  ['세금 납부 내역을 확인하고 싶습니다', '조세'],
  ['진료기록 사본을 떼려고 합니다', '의료'],
  ['날씨 알려주세요', '무관'],
  ['맛집 추천해줘', '무관'],
  ['이 법이 언제 개정됐는지 알려주세요', '법령'],
];

const CASES = [...EASY, ...HARD];

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(__dirname, 'index.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));

  const route = q => page.evaluate(t => window.GIROK.route(t), q);

  async function measure(name, cases) {
    let hit = 0, abstain = 0, miss = 0;
    const bad = [];
    for (const [q, want] of cases) {
      const got = await route(q);
      if (got === want) hit++;
      else if (got === null) { abstain++; bad.push(['헛보류', q, want, '—']); }
      else { miss++; bad.push(['오분류', q, want, got]); }
    }
    const n = cases.length;
    console.log(`\n\x1b[1m${name}\x1b[0m  (${n}개)`);
    console.log(`  맞게 고름  ${String(hit).padStart(3)}  ${(hit / n * 100).toFixed(0)}%`);
    console.log(`  헛보류     ${String(abstain).padStart(3)}  ${(abstain / n * 100).toFixed(0)}%`);
    console.log(`  잘못 고름  ${String(miss).padStart(3)}  ${(miss / n * 100).toFixed(0)}%`);
    return { n, hit, abstain, miss, bad };
  }

  console.log('\n\x1b[1m판단 범위 측정\x1b[0m');
  console.log('\x1b[2m  시험 문장을 사전과 같은 사람이 만들면 점수가 부풀기 때문에,\x1b[0m');
  console.log('\x1b[2m  에두른 표현과 범위 밖 질문을 함께 넣어 잽니다.\x1b[0m');

  const easy = await measure('쉬운 표현 — 낱말이 또렷한 경우', EASY);
  const hard = await measure('어려운 표현 — 에두르거나 구어체', HARD);

  // 범위 밖은 반드시 보류해야 합니다.
  let held = 0;
  const wrongly = [];
  for (const [q, why] of OUT_OF_SCOPE) {
    const got = await route(q);
    if (got === null) held++;
    else wrongly.push([q, why, got]);
  }
  console.log(`\n\x1b[1m범위 밖 — 반드시 보류해야 하는 질문\x1b[0m  (${OUT_OF_SCOPE.length}개)`);
  console.log(`  올바로 보류 ${String(held).padStart(3)}  ${(held / OUT_OF_SCOPE.length * 100).toFixed(0)}%`);
  if (wrongly.length) {
    console.log('  \x1b[31m엉뚱하게 답한 것:\x1b[0m');
    wrongly.forEach(([q, why, got]) => console.log(`   · ${q}  (${why}) → ${got}`));
  }

  const bad = [...easy.bad, ...hard.bad];
  if (bad.length) {
    console.log('\n  손봐야 할 것:');
    bad.forEach(([kind, q, want, got]) =>
      console.log(`   [${kind}] ${q}\n           기대 ${want} · 실제 ${got}`));
  }

  const n = easy.n + hard.n;
  const hit = easy.hit + hard.hit;
  const miss = easy.miss + hard.miss;
  const rate = hit / n;
  const outOk = held === OUT_OF_SCOPE.length;

  console.log('\n' + '─'.repeat(54));
  console.log(`  정당한 질문 ${n}개 중 ${hit}개 적중 (${(rate * 100).toFixed(1)}%)`);
  console.log(`  범위 밖 ${OUT_OF_SCOPE.length}개 중 ${held}개 올바로 보류`);
  if (miss > 0) console.log('  \x1b[31m잘못 안내한 것이 있습니다. 이것부터 고쳐야 합니다.\x1b[0m');
  else if (!outOk) console.log('  \x1b[31m범위 밖 질문에 답했습니다. 보류 기준을 조여야 합니다.\x1b[0m');
  else if (rate >= 0.85) console.log('  \x1b[32m충분합니다.\x1b[0m 잘못 안내하지 않으면서 대부분 답합니다.');
  else if (rate >= 0.7) console.log('  \x1b[33m쓸 만합니다.\x1b[0m 에두른 표현에서 더 줄일 여지가 있습니다.');
  else console.log('  \x1b[31m너무 자주 보류합니다.\x1b[0m 낱말 사전을 넓혀야 합니다.');
  console.log('─'.repeat(54) + '\n');

  await browser.close();
  process.exit(miss > 0 || !outOk || rate < 0.7 ? 1 : 0);
})();
