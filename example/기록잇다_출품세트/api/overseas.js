/**
 * 해외 문서고 검색 프록시
 *
 * 영국 국립기록보관소(TNA) Discovery API는 CORS 헤더를 보내지 않아
 * 브라우저에서 직접 호출할 수 없습니다. 이 함수가 서버에서 대신 호출합니다.
 *
 * 배포: Vercel에 올리면 /api/overseas 로 접근됩니다.
 * 로컬: node -e "require('./api/overseas.js')" 로는 동작하지 않습니다.
 *       vercel dev 또는 아래 selfTest()로 확인하세요.
 *
 *   GET /api/overseas?q=오키나와&variants=Korea,Corea
 */

const TNA = 'https://discovery.nationalarchives.gov.uk/API/search/records';

/* 표기 변형 사전
 * 확장만으로는 부족합니다. 어떤 표기는 다른 뜻으로도 쓰여 노이즈가 됩니다.
 * verified: 해당 문서고에서 실제로 한국을 가리키는 것으로 확인된 표기
 * noisy:    같은 철자가 인명·지명 등으로 쓰여 걸러내야 하는 표기
 */
const VARIANTS = {
  verified: ['Korea', 'Corea', 'Korean'],
  noisy: {
    Coree:  '인명·다른 낱말과 오매칭',
    Chosen: '영어 낱말 및 영국 지명과 겹침',
    Tyosen: '해당 문서고에 기록 없음',
  },
};

/** 제목에서 태그 제거 */
function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** TNA 한 표기 조회 */
async function searchOne(term, rows = 8) {
  const url =
    `${TNA}?sps.searchQuery=${encodeURIComponent(term)}` +
    `&sps.resultsPageSize=${rows}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`TNA ${res.status}`);

  const data = await res.json();
  const count = data.count ?? data.totalCount ?? null;

  const records = (data.records || []).map(r => ({
    title: clean(r.title),
    ref: r.citableReference || r.reference || '',
    held: (r.heldBy && r.heldBy[0]) || '',
    dates: clean(r.coveringDates),
    id: r.id || '',
  }));

  return { term, count, records };
}

/** 조회 결과를 유효/노이즈로 나누고 중복을 제거합니다.
 *  네트워크와 분리해 두어 검사할 수 있게 했습니다.
 *  results 는 Promise.allSettled 의 결과 배열입니다. */
function classify(terms, results) {
  const kept = [];      // 결과에 포함한 표기
  const dropped = [];   // 걸러낸 표기
  const records = [];   // 표기 간 중복을 제거한 기록
  const seen = new Set();

  results.forEach((r, i) => {
    const term = terms[i];

    if (r.status !== 'fulfilled') {
      dropped.push({ term, count: null, reason: '조회 실패' });
      return;
    }
    // 같은 철자가 다른 뜻으로도 쓰이는 표기는 결과에 넣지 않습니다.
    if (VARIANTS.noisy[term]) {
      dropped.push({ term, count: r.value.count, reason: VARIANTS.noisy[term] });
      return;
    }

    kept.push({ term, count: r.value.count });

    (r.value.records || []).forEach(rec => {
      // 같은 기록이 여러 표기로 잡히는 경우를 걸러냅니다.
      // 주의: 한 시리즈 안에서 제목이 같은 별개 기록이 실제로 존재하므로
      // (예: NCUACS 54.3.95/K.230 과 K.231 이 모두 'Korean War')
      // 참조번호를 우선 기준으로 삼고, 없을 때만 제목을 씁니다.
      const key = (rec.ref || rec.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      records.push({ ...rec, matchedBy: term });
    });
  });

  return { kept, dropped, records: records.slice(0, 20) };
}

/** 여러 표기를 조회하고 유효/노이즈로 나눔 */
async function searchVariants(query, terms) {
  const results = await Promise.allSettled(terms.map(t => searchOne(t)));
  return { query, ...classify(terms, results) };
}

/* ── Vercel 핸들러 ────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = (req.query?.q || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: '검색어(q)가 필요합니다' });
  }

  // 요청에 표기 목록이 없으면 검증된 표기 + 노이즈 표기를 함께 조회해
  // 걸러지는 과정을 이용자에게 보여줍니다.
  const terms = (req.query?.variants || '')
    .toString()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const use = terms.length
    ? terms
    : [...VARIANTS.verified, ...Object.keys(VARIANTS.noisy)];

  try {
    const out = await searchVariants(q, use);
    return res.status(200).json({
      ok: true,
      source: '영국 국립기록보관소 Discovery',
      queriedAt: new Date().toISOString(),
      ...out,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: '해외 문서고 조회에 실패했습니다',
      detail: String(err.message || err).slice(0, 120),
    });
  }
};

/* ── 로컬 확인용 ──────────────────────────────────── */
module.exports.searchVariants = searchVariants;
module.exports.classify = classify;
module.exports.clean = clean;
module.exports.VARIANTS = VARIANTS;

if (require.main === module) {
  (async () => {
    const terms = [...VARIANTS.verified, ...Object.keys(VARIANTS.noisy)];
    const out = await searchVariants('테스트', terms);
    console.log('유효 표기:');
    out.kept.forEach(k => console.log(`  ${k.term.padEnd(8)} ${k.count}건`));
    console.log('걸러낸 표기:');
    out.dropped.forEach(d => console.log(`  ${d.term.padEnd(8)} ${d.count}건 — ${d.reason}`));
    console.log(`\n수집 기록 ${out.records.length}건 (상위 3건)`);
    out.records.slice(0, 3).forEach(r =>
      console.log(`  [${r.matchedBy}] ${r.ref} · ${r.title.slice(0, 70)}`)
    );
  })();
}
