#!/usr/bin/env node
/**
 * 산출물 정합 점검
 *
 *   node consistency.js
 *
 * 계획서·요약·발표자료·발표준비·부록·README·시연본에 흩어진 수치가
 * 서로 어긋나지 않는지 대조합니다.
 * 문서를 여러 번 고치면 한쪽만 바뀌는 일이 반드시 생깁니다.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname);
const OUT = process.env.DOCS_DIR || ROOT;

let pass = 0, fail = 0;
const problems = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else {
    fail++; problems.push(name + (detail ? ' — ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  → ' + detail : ''));
  }
}
function group(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

/** docx/pptx는 압축된 XML입니다. 글자만 직접 뽑습니다.
 *  외부 도구에 기대지 않으므로 어느 환경에서도 동작합니다. */
function readOffice(file) {
  if (!fs.existsSync(file)) return '';
  try {
    const list = execSync(`unzip -Z1 ${JSON.stringify(file)}`, { encoding: 'utf8' })
      .split('\n')
      .filter(n => /word\/document\.xml$|ppt\/slides\/slide\d+\.xml$|ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
    let out = '';
    for (const entry of list) {
      const xml = execSync(`unzip -p ${JSON.stringify(file)} ${JSON.stringify(entry)}`, {
        encoding: 'utf8', maxBuffer: 40 * 1024 * 1024,
      });
      out += xml
        .replace(/<\/w:p>|<\/a:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'") + '\n';
    }
    return out;
  } catch { return ''; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 문서에서 숫자를 뽑습니다 (쉼표 포함) */
const nums = s => (s.match(/[\d,]+/g) || []).map(x => x.replace(/,/g, ''));
const has = (s, ...vals) => vals.every(v => s.includes(v));

(function main() {
  const docs = {
    '계획서': readOffice(path.join(OUT, '기록잇다_프로젝트계획서.docx')),
    '한장요약': readOffice(path.join(OUT, '기록잇다_한장요약.docx')),
    '발표자료': readOffice(path.join(OUT, '기록잇다_발표자료.pptx')),
    '발표준비': readOffice(path.join(OUT, '기록잇다_발표준비.docx')),
  };
  const appendix = readText(path.join(ROOT, '부록_검증자료.html'));
  const readme = readText(path.join(ROOT, 'README.md'));
  const demo = readText(path.join(ROOT, 'index.html'));
  const testjs = readText(path.join(ROOT, 'test.js'));
  const cover = readText(path.join(ROOT, 'coverage.js'));

  group('문서를 읽었는가');
  for (const [k, v] of Object.entries(docs)) {
    ok(`${k} 본문 추출`, v.length > 500, v.length + '자');
  }
  ok('부록 읽음', appendix.length > 500);
  ok('README 읽음', readme.length > 500);
  ok('시연본 읽음', demo.length > 500);

  const all = { ...docs, 부록: appendix, README: readme };

  group('표기 변형 실측값');
  const variantChecks = [
    ['Korea 13,518', '13518'],
    ['Corea 756', '756'],
  ];
  for (const [label, n] of variantChecks) {
    const where = Object.entries(all).filter(([, v]) => nums(v).includes(n)).map(([k]) => k);
    ok(`${label} — ${where.length}개 문서에 등장`, where.length >= 3, where.join(', ') || '없음');
  }
  ok('시연본에도 같은 값이 있음', demo.includes('13,518') && demo.includes('756'));

  group('수요 근거');
  const demandDocs = Object.entries(all).filter(([, v]) => /45\s*만/.test(v)).map(([k]) => k);
  ok('조상땅 45만 건이 계획서·요약·발표자료·발표준비에 모두 있음',
     ['계획서', '한장요약', '발표자료', '발표준비'].every(d => demandDocs.includes(d)),
     demandDocs.join(', '));
  ok('부록에 출처가 적혀 있음', /45\s*만/.test(appendix) && appendix.includes('국토교통부'));
  ok('연평균임을 밝힘 (특정 연도로 오인 방지)',
     /연평균/.test(docs['계획서']) && /연평균|5년/.test(appendix));

  group('검사 항목 수');
  // ok() 호출 지점을 세면 반복문 안의 것을 놓칩니다.
  // 실제로 돌려서 나온 수를 기준으로 삼습니다.
  let testCount = null;
  try {
    const out = execSync('node test.js 2>&1 | tail -5', {
      cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    const m = out.match(/통과\s+(\d+)/);
    if (m) testCount = Number(m[1]);
  } catch (e) {
    const m = String(e.stdout || '').match(/통과\s+(\d+)/);
    if (m) testCount = Number(m[1]);
  }

  const claimed = {};
  for (const [k, v] of Object.entries(all)) {
    // "33개 항목(정합 점검)" 같은 다른 수와 섞이지 않도록
    // 검사 파일을 가리키는 문맥에서만 뽑습니다.
    const m = v.match(/(?:test\.js|자동 검사|검사\s*\()[^\n]{0,40}?(\d+)\s*개 항목/)
           || v.match(/(\d+)\s*개 항목[^\n]{0,20}?(?:통과|자동 검사)/);
    if (m) claimed[k] = Number(m[1]);
  }
  console.log('    실제 통과 ' + (testCount ?? '측정 실패') + '개 · 문서 주장: ' +
    (Object.entries(claimed).map(([k, n]) => `${k} ${n}`).join(', ') || '없음'));
  const vals = [...new Set(Object.values(claimed))];
  ok('여러 문서가 같은 수를 말함', vals.length <= 1, vals.join(' vs '));
  ok('검사를 실제로 돌려 수를 확인함', testCount !== null);
  if (vals.length === 1 && testCount !== null) {
    ok('문서가 말하는 수와 실제가 일치', vals[0] === testCount,
       `문서 ${vals[0]} / 실제 ${testCount}`);
  }

  group('판단 범위 측정');
  const easyN = (cover.match(/const EASY = \[([\s\S]*?)\n\];/) || ['', ''])[1].split('\n').filter(l => l.includes("',")).length;
  const hardN = (cover.match(/const HARD = \[([\s\S]*?)\n\];/) || ['', ''])[1].split('\n').filter(l => l.includes("',")).length;
  const outN = (cover.match(/const OUT_OF_SCOPE = \[([\s\S]*?)\n\];/) || ['', ''])[1].split('\n').filter(l => l.includes("',")).length;
  console.log(`    실제 문항: 쉬운 ${easyN} · 어려운 ${hardN} · 범위 밖 ${outN}`);
  ok('README가 말하는 쉬운 표현 수가 맞음',
     readme.includes(`${easyN}개 중 ${easyN}개`), `실제 ${easyN}`);
  ok('README가 말하는 어려운 표현 수가 맞음',
     readme.includes(`${hardN}개 중 ${hardN}개`), `실제 ${hardN}`);
  ok('README가 말하는 범위 밖 수가 맞음',
     readme.includes(`${outN}개 중 ${outN}개`), `실제 ${outN}`);

  // 부록이 말하는 문항 수도 실제와 맞는가
  const totalQ = easyN + hardN + outN;
  const legitQ = easyN + hardN;
  const apxQ = [...appendix.matchAll(/표현\s*(\d+)\s*개/g)].map(m => Number(m[1]));
  console.log(`    실제 문항 합계 ${totalQ}개 (정당한 질문 ${legitQ}) · 부록 표기 ${apxQ.join(', ') || '없음'}`);
  ok('부록이 말하는 문항 수가 실제와 맞음',
     apxQ.length === 0 || apxQ.every(n => n === totalQ || n === legitQ),
     apxQ.filter(n => n !== totalQ && n !== legitQ).join(', '));

  group('시나리오 수');
  const scenarioKeys = ['okinawa:{', 'land:{', 'service:{', 'adoption:{', 'town:{'];
  const demoScenarios = scenarioKeys.filter(k => demo.includes('\n  ' + k)).length;
  console.log('    시연본 시나리오 ' + demoScenarios + '개');
  ok('시연본에 다섯 갈래가 모두 있음', demoScenarios === 5, String(demoScenarios));
  ok('부록이 다섯 갈래를 말함', /다섯 갈래/.test(appendix));
  ok('발표자료가 다섯 갈래를 열거함',
     has(docs['발표자료'], '해외 소장', '재산', '신분', '입양', '지역'));

  group('실물과 표기의 일치');

  // 영상 길이 — 실제 파일에서 재서 부록 표기와 대조
  function duration(file) {
    if (!fs.existsSync(file)) return null;
    try {
      const out = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 ${JSON.stringify(file)}`,
        { encoding: 'utf8' });
      return Math.floor(parseFloat(out));
    } catch { return null; }
  }
  const full = duration(path.join(ROOT, '기록잇다_시연.mp4'));
  const short = duration(path.join(ROOT, '기록잇다_시연_30초.mp4'));
  const statedDur = [...appendix.matchAll(/영상\s*(\d+)\s*초/g)].map(m => Number(m[1]));
  console.log(`    실제 영상 ${full}초 / ${short}초 · 부록 표기 ${statedDur.join(', ') || '없음'}`);
  ok('전체 영상 길이 표기가 맞음', full !== null && statedDur.includes(full),
     `실제 ${full}초`);
  ok('발표용 영상 길이 표기가 맞음', short !== null && statedDur.includes(short),
     `실제 ${short}초`);
  ok('발표용이 30초를 넘지 않음', short !== null && short <= 30, `${short}초`);

  // 슬라이드 수
  const deckFile = path.join(OUT, '기록잇다_발표자료.pptx');
  let slides = null;
  if (fs.existsSync(deckFile)) {
    try {
      slides = execSync(`unzip -Z1 ${JSON.stringify(deckFile)}`, { encoding: 'utf8' })
        .split('\n').filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
    } catch {}
  }
  const statedSlides = (appendix.match(/슬라이드\s*(\d+)\s*장/) || [])[1];
  console.log(`    실제 슬라이드 ${slides}장 · 부록 표기 ${statedSlides || '없음'}장`);
  ok('슬라이드 수 표기가 맞음', slides !== null && Number(statedSlides) === slides,
     `실제 ${slides} / 표기 ${statedSlides}`);

  // 발표자 노트 — 슬라이드마다 있고, 최신 내용을 담았는가
  let notesCount = null;
  let notesText = '';
  if (fs.existsSync(deckFile)) {
    try {
      const entries = execSync(`unzip -Z1 ${JSON.stringify(deckFile)}`, { encoding: 'utf8' })
        .split('\n').filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
      notesCount = entries.length;
      for (const e of entries) {
        notesText += execSync(`unzip -p ${JSON.stringify(deckFile)} ${JSON.stringify(e)}`, {
          encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        }).replace(/<[^>]+>/g, ' ') + '\n';
      }
    } catch {}
  }
  console.log(`    발표자 노트 ${notesCount}장 · ${notesText.length}자`);
  ok('모든 슬라이드에 발표자 노트가 있음', notesCount === slides,
     `노트 ${notesCount} / 슬라이드 ${slides}`);

  // 나중에 추가된 내용이 노트에도 반영됐는가 (노트만 옛것으로 남는 일이 잦습니다)
  const laterAdditions = [
    ['표기 판별 실측', /756|13,?518/],
    ['다섯 갈래', /다섯|입양/],
    ['공동 발굴 대장', /소재가 모여|축적|대장/],
    ['수요 근거', /45\s*만/],
    ['운영비', /운영비|무료 등급|십만원/],
  ];
  for (const [name, re] of laterAdditions) {
    ok(`발표자 노트에 「${name}」이 반영됨`, re.test(notesText));
  }


  // 부록의 제출물 목록이 실제 파일을 빠짐없이 담았는가
  const shipped = [
    ['index.html',      /시연본/],
    ['api/overseas.js', /프록시/],
    ['test.js',         /검사 파일/],
    ['coverage.js',     /판단 범위/],
    ['consistency.js',  /정합 점검/],
    ['기록잇다_시연.mp4', /시연 영상/],
    ['.github/workflows/test.yml', /자동 실행|GitHub Actions/],
  ];
  // 부록 전체가 아니라 「제출물 구성」 표 안에서만 찾습니다.
  // 다른 절에 같은 낱말이 있어 통과해버리는 일을 막습니다.
  const shipTable = (appendix.match(/제출물 구성[\s\S]*?<\/table>/) || [''])[0];
  const notListed = shipped
    .filter(([f, re]) => fs.existsSync(path.join(ROOT, f)) && !re.test(shipTable))
    .map(([f]) => f);
  ok('부록 제출물 목록이 실제 파일을 모두 담음', notListed.length === 0,
     notListed.length ? `목록에 없음: ${notListed.join(', ')}` : '');

  // 발표 대본이 모든 슬라이드를 다루는가
  const beatRefs = new Set();
  for (const m of docs['발표준비'].matchAll(/슬라이드\s*(\d+)(?:–(\d+))?/g)) {
    beatRefs.add(Number(m[1]));
    if (m[2]) for (let i = Number(m[1]); i <= Number(m[2]); i++) beatRefs.add(i);
  }
  const hasDemoBeat = /시연/.test(docs['발표준비']);
  const missingBeats = [];
  for (let i = 1; i <= (slides || 0); i++) {
    if (!beatRefs.has(i) && !(i === 7 && hasDemoBeat)) missingBeats.push(i);
  }
  console.log(`    대본이 다루는 슬라이드: ${[...beatRefs].sort((a, b) => a - b).join(', ')}`);
  ok('발표 대본이 모든 슬라이드를 다룸', missingBeats.length === 0,
     missingBeats.length ? `빠진 슬라이드 ${missingBeats.join(', ')}` : '');

  // 시간 구간이 끊기지 않는가
  const times = [...docs['발표준비'].matchAll(/(\d):(\d\d)–(\d):(\d\d)/g)]
    .map(m => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  const gaps = times.slice(1).filter((t, i) => t[0] !== times[i][1]);
  ok('대본의 시간 구간이 끊기지 않음', times.length > 3 && gaps.length === 0,
     gaps.length ? `${gaps.length}곳에서 어긋남` : `구간 ${times.length}개`);

  const dataRows = (docs['계획서'].match(/나라기록물정보|한국사데이터베이스|국립기록보관소|국립도서관|인터넷 아카이브/g) || []).length;
  const statedDomestic = (docs['계획서'].match(/국내\s*(\d+)\s*종/) || [])[1];
  const statedOverseas = (docs['계획서'].match(/해외\s*(\d+)\s*종/) || [])[1];
  console.log(`    계획서 서술: 국내 ${statedDomestic || '?'}종 · 해외 ${statedOverseas || '?'}종`);
  ok('국내 데이터 종수를 밝힘', !!statedDomestic);
  ok('해외 데이터 종수를 밝힘', !!statedOverseas);


  const promises = [
    ['근거 없으면 답하지 않는다', /답하지 않|보류/, /보류/],
    ['개인 신상은 저장하지 않는다', /개인 신상|신상은 저장하지/, /생년·본적|남기지 않/],
    ['접근성은 기본값이다', /접근성/, /글자|행간|초점/],
    ['무엇이 실제이고 무엇이 구성인지 밝힌다', /실제 조사 재현|출처/, /출처|실제 조사/],
  ];
  for (const [name, inDoc, inTest] of promises) {
    ok(`「${name}」 계획서에 있음`, inDoc.test(docs['계획서']));
    ok(`「${name}」 검사에 있음`, inTest.test(testjs));
  }

  group('운영비');
  ok('계획서가 무료 구간과 유료 구간을 나눠 적음',
     /0원/.test(docs['계획서']) && /월 3만|십만원/.test(docs['계획서']));
  ok('「예산 없이」라는 단정이 남아 있지 않음',
     !Object.values(all).some(v => /예산 없이/.test(v)),
     Object.entries(all).filter(([, v]) => /예산 없이/.test(v)).map(([k]) => k).join(', '));
  ok('약관 제약을 밝힘', /비영리/.test(docs['계획서']) || /비영리/.test(appendix));

  console.log('\n' + '─'.repeat(52));
  console.log(`  통과 ${pass}  ·  실패 ${fail}`);
  if (fail) {
    console.log('\n  어긋난 곳:');
    problems.forEach(p => console.log('   · ' + p));
    console.log('\n  문서를 고칠 때 한쪽만 바꾸면 이렇게 드러납니다.');
  }
  console.log('─'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
