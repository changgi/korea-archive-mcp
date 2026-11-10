#!/usr/bin/env node
/**
 * 기록잇다 · 검사
 *
 *   node test.js
 *
 * 판단 규칙, 검색어 추출, 응답 파싱, 표기 판별을 검사합니다.
 * 화면을 실제 브라우저에 띄워 내부 함수를 직접 부릅니다.
 * 네트워크가 필요한 항목은 --net 을 붙였을 때만 실행합니다.
 */

const puppeteer = require('puppeteer');
const path = require('path');

const WITH_NET = process.argv.includes('--net');
const PAGE = 'file://' + path.resolve(__dirname, 'index.html');

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else {
    fail++; fails.push(name + (detail ? ' — ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  → ' + detail : ''));
  }
}
function group(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(PAGE, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 600));

  const call = (fn, ...args) =>
    page.evaluate((f, a) => window.GIROK[f](...a), fn, args);

  // ── 1. 화면이 뜨는가 ──
  group('화면');
  ok('자바스크립트 오류 없음', errors.length === 0, errors[0]);
  ok('시험용 함수가 노출됨', await page.evaluate(() => !!window.GIROK));
  ok('시연 시나리오 5종 존재',
     (await page.evaluate(() => Object.keys(window.GIROK.DATA).length)) === 5);

  // ── 2. 판단 규칙 — 갈래를 맞게 고르는가 ──
  group('판단 — 맞게 고르기');
  const routes = [
    ['할아버지가 오키나와에 끌려갔다는데 기록이 있을까요', 'okinawa'],
    ['강제동원 피해 입증 자료를 찾습니다', 'okinawa'],
    ['돌아가신 아버지 명의 토지 상속 확인', 'land'],
    ['임야조사부 지적원도 어디서 보나요', 'land'],
    ['아버지 병적기록이랑 학적부가 필요합니다', 'service'],
    ['제적등본으로 군번 확인하려고요', 'service'],
    ['해외로 입양됐는데 친생부모 기록을 찾고 싶어요', 'adoption'],
    ['뿌리찾기를 시작하려고 합니다', 'adoption'],
    ['재개발로 사라지는 우리 동네 기록 전시', 'town'],
    ['마을 옛날 사진으로 전시를 하고 싶어요', 'town'],
  ];
  for (const [q, want] of routes) {
    const got = await call('route', q);
    ok(`「${q.slice(0, 18)}…」 → ${want}`, got === want, `실제: ${got}`);
  }

  // ── 3. 판단 규칙 — 모를 때 답하지 않는가 ──
  group('판단 — 모를 때 답하지 않기');
  const abstain = [
    ['안녕하세요', '인사말'],
    ['옛날 자료 좀 찾아주세요', '갈래를 특정할 단서 없음'],
    ['기록', '한 낱말'],
    ['자료 있나요', '막연함'],
    ['땅이랑 병적 둘 다 필요해요', '두 갈래가 팽팽'],
    ['', '빈 입력'],
  ];
  for (const [q, why] of abstain) {
    const got = await call('route', q);
    ok(`「${q || '(빈 문자열)'}」 → 보류 (${why})`, got === null, `실제: ${got}`);
  }

  // ── 4. 점수 규칙이 의도대로인가 ──
  group('점수 규칙');
  const s1 = await call('score', '오키나와 강제동원');
  ok('강한 낱말 두 개면 6점', s1.okinawa === 6, JSON.stringify(s1.okinawa));
  const s2 = await call('score', '아버지');
  ok('약한 낱말 하나면 1점', s2.land === 1, JSON.stringify(s2.land));
  const s3 = await call('score', '토지 아버지 상속');
  ok('강2+약1 = 7점', s3.land === 7, JSON.stringify(s3.land));

  // ── 5. 검색어 추출 ──
  group('검색어 추출');
  const kw = [
    ['오키나와 조선인 기록이 있을까요', ['있을까요']],
    ['조상 땅을 어떻게 찾나요', ['어떻게']],
    ['자료를 좀 찾아주세요', ['찾아주세요', '좀']],
  ];
  for (const [q, banned] of kw) {
    const got = await call('toKeyword', q);
    const clean = banned.every(b => !got.includes(b));
    ok(`「${q}」 → 「${got}」 군더더기 제거`, clean && got.length > 0, got);
  }
  ok('낱말 3개 이하로 자름',
     (await call('toKeyword', '가나다 라마바 사아자 차카타 파하가')).split(' ').length <= 3);

  // ── 6. 기관 응답 파싱 — 태그가 달라도 읽는가 ──
  group('응답 파싱');

  const xmlItem = `<?xml version="1.0"?><response><body><items>
    <item><title>국무회의록</title><prodInsttNm>국무조정실</prodInsttNm><rcrdNo>BA0000001</rcrdNo></item>
    <item><title>관보 제1호</title><prodInsttNm>총무처</prodInsttNm><rcrdNo>BA0000002</rcrdNo></item>
  </items></body></response>`;
  const r1 = await call('parseXml', xmlItem);
  ok('item 태그를 읽음', r1.length === 2, JSON.stringify(r1.length));
  ok('제목을 뽑음', r1[0].title === '국무회의록', r1[0].title);
  ok('생산기관을 뽑음', r1[0].org === '국무조정실', r1[0].org);
  ok('관리번호를 뽑음', r1[0].no === 'BA0000001', r1[0].no);

  const xmlRow = `<?xml version="1.0"?><result><row>
    <rcrdNm>토지조사부</rcrdNm><insttNm>조선총독부</insttNm><mngNo>CJA0011</mngNo>
  </row></result>`;
  const r2 = await call('parseXml', xmlRow);
  ok('row 태그와 다른 필드명도 읽음',
     r2.length === 1 && r2[0].title === '토지조사부' && r2[0].org === '조선총독부',
     JSON.stringify(r2[0]));

  const xmlEmpty = `<?xml version="1.0"?><response><body><items></items></body></response>`;
  ok('결과 없음도 오류 없이 처리', (await call('parseXml', xmlEmpty)).length === 0);

  const xmlNoTitle = `<?xml version="1.0"?><r><item><foo>x</foo></item></r>`;
  const r3 = await call('parseXml', xmlNoTitle);
  ok('제목이 없으면 표시 문구로 대체', r3[0].title === '(제목 없음)', r3[0].title);

  const xmlErr = `<?xml version="1.0"?><OpenAPI_ServiceResponse><cmmMsgHeader>
    <errMsg>SERVICE ERROR</errMsg><returnAuthMsg>등록되지 않은 키</returnAuthMsg>
  </cmmMsgHeader></OpenAPI_ServiceResponse>`;
  let threw = false;
  try { await call('parseXml', xmlErr); } catch (e) { threw = true; }
  ok('기관 오류 응답이면 예외를 던짐', threw);

  // ── 8. 공동 발굴 대장 — 무엇이 저장되는가 ──
  group('공동 발굴 대장');

  // 개인 신상이 잔뜩 섞인 질의를 넣고 대장 내용을 확인합니다.
  const nosy = '김기준 1930년생 제주 한림면 비양도 본적 아버지 오키나와 강제동원';
  await page.evaluate(q => { document.querySelector('#q').value = q; }, nosy);
  await page.click('#go');
  await new Promise(r => setTimeout(r, 2800));

  const visible = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#ledger')).display !== 'none');
  ok('발굴에 성공하면 대장이 보임', visible);

  const draft = await page.evaluate(() => window.__ledgerDraft());

  ok('소장 정보를 남김', /소재|표기|기록/.test(draft), draft.slice(0, 40));
  ok('무엇을 남기지 않는지 함께 적음', draft.includes('남기지 않는 것'));

  // 개인 신상 항목이 별도 필드로 저장되지 않는가
  const identityFields = ['생년', '본적', '가족관계'];
  const leaked = identityFields.filter(f => {
    const line = draft.split('\n').find(l => l.startsWith(f));
    return !!line;   // 해당 이름의 저장 항목이 있으면 유출
  });
  ok('생년·본적·가족관계를 저장 항목으로 두지 않음',
     leaked.length === 0, leaked.join(', '));

  // 저장 항목은 정해진 것만
  const keys = draft.split('\n')
    .filter(l => l.includes(':'))
    .map(l => l.split(':')[0].trim())
    .filter(Boolean);
  const allowed = ['질의', '유효 표기', '확인한 기록', '소재', '등록 시각', '남기지 않는 것'];
  const unexpected = keys.filter(k => !allowed.includes(k));
  ok('허용된 항목 외에는 저장하지 않음', unexpected.length === 0, unexpected.join(', '));

  // 등록은 두 단계여야 한다 — 확인 없이 바로 등록되지 않는가
  const before = await page.evaluate(() => document.querySelector('#ledgerN').textContent);
  await page.click('#ledgerBtn');
  await new Promise(r => setTimeout(r, 250));
  const mid = await page.evaluate(() => ({
    shown: document.querySelector('#ledgerWhat').classList.contains('on'),
    count: document.querySelector('#ledgerN').textContent,
    label: document.querySelector('#ledgerBtn').textContent,
  }));
  ok('한 번 누르면 저장 내용을 먼저 보여줌', mid.shown);
  ok('한 번 누른 것만으로는 등록되지 않음', mid.count === before, mid.count);
  ok('두 번째 단계임을 문구로 알림', mid.label.includes('이대로'), mid.label);

  await page.click('#ledgerBtn');
  await new Promise(r => setTimeout(r, 250));
  const after = await page.evaluate(() => ({
    count: document.querySelector('#ledgerN').textContent,
    done: document.querySelector('#ledgerBtn').disabled,
  }));
  ok('두 번 누르면 등록됨', after.count !== before, after.count);
  ok('등록 후에는 다시 눌리지 않음', after.done);

  // 답하지 않은 경우에는 남길 것이 없어야 한다
  await page.evaluate(() => { document.querySelector('#q').value = '안녕하세요'; });
  await page.click('#go');
  await new Promise(r => setTimeout(r, 1500));
  const hiddenOnAbstain = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#ledger')).display === 'none');
  ok('답하지 않았으면 대장을 감춤', hiddenOnAbstain);

  // ── 9. 출처 표시 — 무엇이 실제이고 무엇이 구성인가 ──
  group('출처 표시');

  const origins = await page.evaluate(() => {
    const d = window.GIROK.DATA;
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.origin || null]));
  });

  ok('모든 시나리오가 출처를 밝힘',
     Object.values(origins).every(o => typeof o === 'string' && o.length > 10),
     Object.entries(origins).filter(([, o]) => !o).map(([k]) => k).join(', '));

  ok('오키나와는 실제 조사 재현으로 표시',
     /실제 조사/.test(origins.okinawa || ''), origins.okinawa);

  const constructed = ['land', 'service', 'adoption', 'town'];
  ok('나머지는 절차 구성으로 표시',
     constructed.every(k => /구성/.test(origins[k] || '')),
     constructed.filter(k => !/구성/.test(origins[k] || '')).join(', '));

  ok('실제가 아닌 것을 실제라고 하지 않음',
     constructed.every(k => !/실제 조사/.test(origins[k] || '')));

  // 화면에 실제로 뜨는가
  await page.click('.chip[data-k="okinawa"]');
  await new Promise(r => setTimeout(r, 2600));
  const shownOrigin = await page.evaluate(() => {
    const el = document.querySelector('#origin');
    return { text: el.textContent, visible: getComputedStyle(el).display !== 'none' };
  });
  ok('결과 화면에 출처가 보임', shownOrigin.visible && shownOrigin.text.length > 10);
  ok('화면 문구가 데이터와 일치', shownOrigin.text === origins.okinawa);

  // 답하지 않았으면 밝힐 출처도 없다
  await page.evaluate(() => { document.querySelector('#q').value = '안녕하세요'; });
  await page.click('#go');
  await new Promise(r => setTimeout(r, 1400));
  ok('답하지 않았으면 출처도 감춤',
     await page.evaluate(() => getComputedStyle(document.querySelector('#origin')).display === 'none'));

  // ── 10. 접근성 — 고령·취약계층 포용 약속 ──
  group('접근성');

  const a11y = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const q = document.querySelector('#q');
    const inputs = [...document.querySelectorAll('input')];
    const buttons = [...document.querySelectorAll('button')];
    return {
      lang: document.documentElement.lang,
      fontPx: parseFloat(body.fontSize),
      lineH: parseFloat(body.lineHeight) / parseFloat(body.fontSize),
      inputPx: parseFloat(getComputedStyle(q).fontSize),
      labeled: inputs.every(i => i.labels?.length || i.getAttribute('aria-label')),
      named: buttons.every(b => (b.textContent || '').trim() || b.getAttribute('aria-label')),
      live: !!document.querySelector('[aria-live]'),
      viewport: !!document.querySelector('meta[name="viewport"]'),
      micHidden: document.querySelector('#mic').hidden,
      micLabel: document.querySelector('#mic').getAttribute('aria-label'),
    };
  });

  ok('문서 언어가 한국어로 선언됨', a11y.lang === 'ko', a11y.lang);
  ok('본문 글자가 16px 이상', a11y.fontPx >= 16, a11y.fontPx + 'px');
  ok('행간이 1.6 이상', a11y.lineH >= 1.6, a11y.lineH.toFixed(2));
  ok('입력창 글자가 16px 이상 (모바일 자동확대 방지)', a11y.inputPx >= 16, a11y.inputPx + 'px');
  ok('모든 입력에 이름표가 있음', a11y.labeled);
  ok('모든 단추에 읽을 이름이 있음', a11y.named);
  ok('결과 영역이 화면낭독기에 알려짐', a11y.live);
  ok('모바일 화면 설정이 있음', a11y.viewport);
  ok('마이크가 없으면 말하기 단추를 감춤', a11y.micHidden === true);
  ok('말하기 단추에 대체 설명이 있음', !!a11y.micLabel, a11y.micLabel);

  // 키보드만으로 검색까지 도달하는가 (첫 화면 기준)
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => document.body.focus());
  const reachable = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    reachable.push(await page.evaluate(() => document.activeElement.id || document.activeElement.className));
  }
  ok('키보드만으로 입력창에 도달', reachable.includes('q'), reachable.join(' → ').slice(0, 70));
  ok('키보드만으로 찾기 단추에 도달', reachable.includes('go'), reachable.join(' → ').slice(0, 70));

  const focusVisible = await page.evaluate(() => {
    // 초점 표시는 :focus-visible 규칙이 스타일시트에 있는지로 확인합니다.
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.includes(':focus-visible')) {
          return /outline/.test(r.style.cssText) && r.style.outlineWidth !== '0px';
        }
      }
    }
    return false;
  });
  ok('초점이 눈에 보이게 표시됨', focusVisible);

  // 동작 최소화 설정을 존중하는가
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  await page.click('.chip[data-k="okinawa"]');
  await new Promise(r => setTimeout(r, 1800));
  const reduced = await page.evaluate(() => ({
    beam: getComputedStyle(document.querySelector('.beam')).display,
    done: document.querySelector('#stamp').textContent,
    hits: document.querySelectorAll('.frame.hit').length,
  }));
  ok('동작 최소화 설정에서 훑는 빛을 끔', reduced.beam === 'none', reduced.beam);
  ok('동작을 줄여도 결과는 그대로 나옴', reduced.done === '조회완료' && reduced.hits > 0,
     `${reduced.done} / 히트 ${reduced.hits}`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // ── 11. 표기 변형 사전 ──
  group('표기 변형');
  const V = require('./api/overseas.js').VARIANTS;
  ok('Corea 가 유효 표기에 있음', V.verified.includes('Corea'));
  ok('Chosen 이 노이즈로 분류됨', !!V.noisy.Chosen);
  ok('Coree 가 노이즈로 분류됨', !!V.noisy.Coree);
  ok('노이즈마다 이유가 적혀 있음',
     Object.values(V.noisy).every(r => typeof r === 'string' && r.length > 3));

  // ── 12. 해외 검색 프록시 — 네트워크 없이 ──
  group('프록시 · 판별 로직');
  const api = require('./api/overseas.js');
  const { classify, clean } = api;

  const okRes = (count, records = []) => ({ status: 'fulfilled', value: { count, records } });
  const failRes = () => ({ status: 'rejected', reason: new Error('timeout') });

  // 노이즈 표기는 결과에서 빠지는가
  const c1 = classify(
    ['Korea', 'Chosen'],
    [okRes(100, [{ ref: 'A/1', title: 'Korea file' }]),
     okRes(4000, [{ ref: 'B/9', title: 'Chosen Hill' }])]
  );
  ok('유효 표기는 결과에 포함', c1.kept.map(k => k.term).join() === 'Korea');
  ok('노이즈 표기는 걸러냄', c1.dropped.map(d => d.term).join() === 'Chosen');
  ok('노이즈 표기의 기록은 수집하지 않음',
     c1.records.length === 1 && c1.records[0].ref === 'A/1',
     JSON.stringify(c1.records.map(r => r.ref)));
  ok('걸러낸 이유를 함께 남김', /지명|낱말/.test(c1.dropped[0].reason), c1.dropped[0].reason);

  // 여러 표기에 같은 기록이 잡히면 한 번만
  const dup = { ref: 'FO 881/5247', title: 'COREA and RUSSIA' };
  const c2 = classify(['Korea', 'Corea'], [okRes(10, [dup]), okRes(5, [dup])]);
  ok('같은 참조번호는 한 번만 수집', c2.records.length === 1, JSON.stringify(c2.records.length));
  ok('먼저 걸린 표기를 기록', c2.records[0].matchedBy === 'Korea', c2.records[0].matchedBy);

  // 제목이 같아도 참조번호가 다르면 별개 기록
  const c3 = classify(['Korea'], [okRes(2, [
    { ref: 'NCUACS 54.3.95/K.230', title: 'Korean War' },
    { ref: 'NCUACS 54.3.95/K.231', title: 'Korean War' },
  ])]);
  ok('제목이 같아도 참조번호가 다르면 둘 다 남김',
     c3.records.length === 2, JSON.stringify(c3.records.length));

  // 조회 실패한 표기 처리
  const c4 = classify(['Korea', 'Corea'], [okRes(10, [{ ref: 'X/1', title: 'a' }]), failRes()]);
  ok('조회 실패한 표기는 걸러냄에 기록', c4.dropped[0].term === 'Corea');
  ok('실패 사유를 남김', c4.dropped[0].reason === '조회 실패', c4.dropped[0].reason);
  ok('한 표기가 실패해도 나머지는 살림', c4.records.length === 1);

  // 참조번호도 제목도 없는 기록은 버림
  const c5 = classify(['Korea'], [okRes(1, [{ ref: '', title: '' }])]);
  ok('식별할 수 없는 기록은 버림', c5.records.length === 0);

  // 상한
  const many = Array.from({ length: 40 }, (_, i) => ({ ref: 'R/' + i, title: 't' + i }));
  ok('한 번에 20건까지만 돌려줌', classify(['Korea'], [okRes(40, many)]).records.length === 20);

  // 제목 정리
  ok('제목의 태그를 걷어냄', clean('<b>COREA</b>: Military') === 'COREA: Military');
  ok('제목의 겹공백을 정리', clean('  a   b  ') === 'a b');

  group('프록시 · HTTP 동작');
  const handler = api;
  const mockRes = () => {
    const r = { headers: {}, code: null, body: null };
    r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
    r.status = c => { r.code = c; return r; };
    r.json = o => { r.body = o; return r; };
    r.end = () => r;
    return r;
  };

  const noQuery = mockRes();
  await handler({ method: 'GET', query: {} }, noQuery);
  ok('검색어가 없으면 400', noQuery.code === 400, String(noQuery.code));
  ok('오류에 이유를 담음', !!(noQuery.body && noQuery.body.error));

  const preflight = mockRes();
  await handler({ method: 'OPTIONS', query: {} }, preflight);
  ok('사전요청(OPTIONS)은 204', preflight.code === 204, String(preflight.code));

  ok('교차출처 허용 머리글을 붙임',
     noQuery.headers['access-control-allow-origin'] === '*',
     noQuery.headers['access-control-allow-origin']);
  ok('캐시 머리글을 붙임', !!noQuery.headers['cache-control'], noQuery.headers['cache-control']);

  // ── 13. 실제 조회 (--net) ──
  if (WITH_NET) {
    group('해외 문서고 실제 조회');
    const { searchVariants } = require('./api/overseas.js');
    const terms = [...V.verified, ...Object.keys(V.noisy)];
    try {
      const out = await searchVariants('검사', terms);
      ok('유효 표기 결과를 받음', out.kept.length >= 2, JSON.stringify(out.kept.length));
      ok('노이즈 표기를 걸러냄', out.dropped.length >= 2, JSON.stringify(out.dropped.length));
      ok('기록을 수집함', out.records.length > 0, JSON.stringify(out.records.length));
      const refs = out.records.map(r => r.ref).filter(Boolean);
      ok('참조번호 중복 없음', refs.length === new Set(refs).size);
      ok('각 기록에 매칭 표기가 붙음', out.records.every(r => r.matchedBy));
    } catch (e) {
      ok('해외 문서고 조회', false, e.message);
    }
  } else {
    console.log('\n\x1b[2m  (해외 문서고 실제 조회는 --net 을 붙이면 실행합니다)\x1b[0m');
  }

  await browser.close();

  console.log('\n' + '─'.repeat(46));
  console.log(`  통과 ${pass}  ·  실패 ${fail}`);
  if (fail) {
    console.log('\n  실패 항목:');
    fails.forEach(f => console.log('   · ' + f));
  }
  console.log('─'.repeat(46) + '\n');
  process.exit(fail ? 1 : 0);
})();
