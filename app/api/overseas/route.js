// 기록잇다 — 해외 문서고 검색 프록시 (원작: 기록잇다 출품 세트 api/overseas.js — App Router 포팅)
// KOREA ARCHIVE 통합검색 연계판: 검증 표기에 당대 표기(Corean 등) 보강, 파트너 UA, 판정 우선 응답 유지.
export const maxDuration = 30;

const TNA = 'https://discovery.nationalarchives.gov.uk/API/search/records';

const VARIANTS = {
  verified: ['Korea', 'Corea', 'Korean'],
  noisy: {
    Coree: '인명·다른 낱말과 오매칭',
    Chosen: '영어 낱말 및 영국 지명과 겹침',
    Tyosen: '해당 문서고에 기록 없음',
  },
};

const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function searchOne(term, rows = 8) {
  const url = `${TNA}?sps.searchQuery=${encodeURIComponent(term)}&sps.resultsPageSize=${rows}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'KoreaArchiveMCP-Ingitda/1.0 (+https://korea-archive-mcp.vercel.app/ingitda.html)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`TNA ${res.status}`);
  const data = await res.json();
  const count = data.count ?? data.totalCount ?? null;
  const records = (data.records || []).map((r) => ({
    title: clean(r.title),
    ref: r.citableReference || r.reference || '',
    held: (r.heldBy && r.heldBy[0]) || '',
    dates: clean(r.coveringDates),
    id: r.id || '',
  }));
  return { term, count, records };
}

function classify(terms, results) {
  const kept = [];
  const dropped = [];
  const records = [];
  const seen = new Set();
  results.forEach((r, i) => {
    const term = terms[i];
    if (r.status !== 'fulfilled') { dropped.push({ term, count: null, reason: '조회 실패' }); return; }
    if (VARIANTS.noisy[term]) { dropped.push({ term, count: r.value.count, reason: VARIANTS.noisy[term] }); return; }
    kept.push({ term, count: r.value.count });
    (r.value.records || []).forEach((rec) => {
      const key = (rec.ref || rec.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      records.push({ ...rec, matchedBy: term });
    });
  });
  return { kept, dropped, records: records.slice(0, 20) };
}

export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const q = (sp.get('q') || '').trim();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=600, stale-while-revalidate=3600',
  };
  if (!q) return Response.json({ error: '검색어(q)가 필요합니다' }, { status: 400, headers });
  const terms = (sp.get('variants') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const use = terms.length ? terms : [...VARIANTS.verified, ...Object.keys(VARIANTS.noisy)];
  try {
    const results = await Promise.allSettled(use.map((t) => searchOne(t)));
    return Response.json({
      ok: true,
      source: '영국 국립기록보관소 Discovery',
      via: 'KOREA ARCHIVE 통합검색 (korea-archive-mcp.vercel.app)',
      queriedAt: new Date().toISOString(),
      query: q,
      ...classify(use, results),
    }, { headers });
  } catch (err) {
    return Response.json({ ok: false, error: '해외 문서고 조회에 실패했습니다', detail: String(err && err.message || err).slice(0, 120) }, { status: 502, headers });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}
