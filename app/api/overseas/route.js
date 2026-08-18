// 기록잇다 — 다중 문서고 연합 검색 프록시 (원작: 출품 세트 api/overseas.js — KOREA ARCHIVE 확장판)
// 문서고별 검증/노이즈 표기 사전(6층 언어 규칙): TNA=Corea 유효·Chosen 노이즈 / Gallica=Corée가 정답 / IA=당대 표기 Chosen 유효.
export const maxDuration = 45;

const UA = { 'User-Agent': 'KoreaArchiveMCP-Ingitda/2.0 (+https://korea-archive-mcp.vercel.app/ingitda.html)' };

const ARCHIVES = {
  tna: {
    name: '영국 TNA',
    verified: ['Korea', 'Corea', 'Korean'],
    noisy: { Coree: '인명·다른 낱말과 오매칭', Chosen: '영어 낱말·영국 지명과 겹침', Tyosen: '해당 문서고에 기록 없음' },
    async search(term, rows = 8) {
      const url = `https://discovery.nationalarchives.gov.uk/API/search/records?sps.searchQuery=${encodeURIComponent(term)}&sps.resultsPageSize=${rows}`;
      const res = await fetch(url, { headers: { Accept: 'application/json', ...UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`TNA ${res.status}`);
      const d = await res.json();
      return {
        count: d.count ?? d.totalCount ?? null,
        records: (d.records || []).map((r) => ({
          title: clean(r.title), ref: r.citableReference || r.reference || '',
          held: (r.heldBy && r.heldBy[0]) || 'The National Archives', dates: clean(r.coveringDates), id: r.id || '',
        })),
      };
    },
  },
  ia: {
    name: 'Internet Archive',
    verified: ['Korea', 'Corea', 'Chosen'],
    noisy: { Coree: '색인 저조 — Corée는 갈리카에서', Tyosen: '희소 표기' },
    async search(term, rows = 8) {
      const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent('"' + term + '"')}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&rows=${rows}&page=1&output=json`;
      const res = await fetch(url, { headers: { Accept: 'application/json', ...UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`IA ${res.status}`);
      const d = await res.json();
      const rsp = d.response || {};
      return {
        count: rsp.numFound ?? null,
        records: (rsp.docs || []).map((r) => ({
          title: clean(Array.isArray(r.title) ? r.title[0] : r.title), ref: r.identifier || '',
          held: 'archive.org', dates: r.year ? String(r.year) : '', id: r.identifier || '',
        })),
      };
    },
  },
  gallica: {
    name: '프랑스 갈리카(BnF)',
    verified: ['Corée', 'Corea'],
    noisy: { Chosen: '불어권 색인에 희소', Korea: '영어권 근현대 위주 — 시기 확인 필요' },
    async search(term, rows = 8) {
      const q = encodeURIComponent(`gallica all "${term}"`);
      const url = `https://gallica.bnf.fr/SRU?operation=searchRetrieve&version=1.2&query=${q}&maximumRecords=${rows}`;
      // ★ Accept 민감: application/xml=200 · text/xml=406 (실측)
      const res = await fetch(url, { headers: { Accept: 'application/xml', ...UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`Gallica ${res.status}`);
      const xml = await res.text();
      const count = parseInt((xml.match(/numberOfRecords>(\d+)/) || [, '0'])[1], 10);
      const records = [];
      const re = /<srw:record>([\s\S]*?)<\/srw:record>/g;
      let m;
      while ((m = re.exec(xml)) && records.length < rows) {
        const seg = m[1];
        const g = (tag) => { const mm = seg.match(new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)</dc:${tag}>`)); return mm ? clean(mm[1]) : ''; };
        const ark = (seg.match(/ark:\/12148\/[\w]+/) || [''])[0];
        records.push({ title: g('title'), ref: ark, held: 'BnF Gallica', dates: g('date'), id: ark });
      }
      return { count, records };
    },
  },
  europeana: {
    name: '유러피아나(유럽 4천 기관)',
    verified: ['Corea', 'Corée', 'Korea'],
    noisy: { Chosen: '유럽 색인 희소', Coree: '악상 없는 표기 — Corée 사용' },
    note: 'Corea는 재즈 피아니스트·의학용어와 동음 — 결과 확인 필요',
    async search(term, rows = 6) {
      const url = `https://api.europeana.eu/record/v2/search.json?wskey=api2demo&query=${encodeURIComponent('"' + term + '"')}&rows=${rows}`;
      const res = await fetch(url, { headers: { Accept: 'application/json', ...UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`Europeana ${res.status}`);
      const d = await res.json();
      if (!d.success) throw new Error('Europeana key');
      return {
        count: d.totalResults ?? null,
        records: (d.items || []).map((r) => ({
          title: clean(Array.isArray(r.title) ? r.title[0] : r.title),
          ref: (r.id || '').replace(/^\//, ''),
          held: (r.dataProvider && r.dataProvider[0]) || 'Europeana', dates: (r.year && r.year[0]) || '', id: r.guid || '',
        })),
      };
    },
  },
  kwa: {
    name: '6·25전쟁 아카이브(KWA)',
    useRawQuery: true,
    verified: [], noisy: {},
    async search(term, rows = 8) {
      const url = `https://www.koreanwar.or.kr:8443/search.do?keyword=${encodeURIComponent(term)}&viewType=archive&pageSize=10`;
      const res = await fetch(url, { headers: { ...UA, Accept: 'text/html' }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`KWA ${res.status}`);
      const b = await res.text();
      const count = parseInt(((b.match(/totalCount">\s*([\d,]+)/) || [, '0'])[1]).replace(/,/g, ''), 10);
      // MCP kwParseCards 이식 — archive(archRfcd)·도서(bookId) 카드 모두
      const records = [];
      for (const seg of b.split('result-card__body').slice(1)) {
        if (records.length >= rows) break;
        const m = seg.match(/href="\/(searchDetail(?:-book)?\.do)\?(archRfcd|bookId)=([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!m) continue;
        records.push({ title: clean(m[4]), ref: m[2] === 'archRfcd' ? m[3] : `book:${m[3]}`,
          held: 'KOREAN WAR ARCHIVES(협약기관)', dates: '',
          id: `https://www.koreanwar.or.kr:8443/${m[1]}?${m[2]}=${encodeURIComponent(m[3])}` });
      }
      return { count, records };
    },
  },
  nara: {
    name: '미국 NARA',
    verified: ['Korea', 'Chosen'],
    noisy: { Corea: '미국 색인은 Korea·Chosen 위주' },
    needsKey: true,
    async search(term, rows = 6) {
      const key = process.env.NARA_API_KEY;
      if (!key) throw new Error('서버 키 필요(NARA_API_KEY)');
      const url = `https://catalog.archives.gov/api/v2/records/search?q=${encodeURIComponent(term)}&limit=${rows}`;
      const res = await fetch(url, { headers: { Accept: 'application/json', 'x-api-key': key, ...UA }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`NARA ${res.status}`);
      const d = await res.json();
      const body = d.body || d;
      const hits = (body.hits && body.hits.hits) || [];
      const total = (body.hits && body.hits.total && (body.hits.total.value ?? body.hits.total)) || null;
      return {
        count: typeof total === 'number' ? total : null,
        records: hits.map((h) => {
          const r = (h._source && h._source.record) || {};
          return { title: clean(r.title), ref: String(r.naId || ''), held: 'NARA', dates: '', id: String(r.naId || '') };
        }),
      };
    },
  },
};

const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const q = (sp.get('q') || '').trim();
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 's-maxage=600, stale-while-revalidate=3600' };
  if (!q) return Response.json({ error: '검색어(q)가 필요합니다' }, { status: 400, headers });

  const want = (sp.get('archives') || 'tna').split(',').map((s) => s.trim().toLowerCase()).filter((a) => ARCHIVES[a]);
  const use = want.length ? want : ['tna'];
  const userTerms = (sp.get('variants') || '').split(',').map((s) => s.trim()).filter(Boolean);

  const jobs = [];
  for (const a of use) {
    const A = ARCHIVES[a];
    if (A.useRawQuery) { jobs.push({ archive: a, term: q, noisy: null }); continue; }
    const terms = userTerms.length ? userTerms : [...A.verified, ...Object.keys(A.noisy)];
    for (const t of terms) jobs.push({ archive: a, term: t, noisy: A.noisy[t] || null });
  }
  const results = await Promise.allSettled(jobs.map((j) => ARCHIVES[j.archive].search(j.term)));

  const kept = []; const dropped = []; const records = []; const seen = new Set();
  results.forEach((r, i) => {
    const j = jobs[i]; const aname = ARCHIVES[j.archive].name;
    if (r.status !== 'fulfilled') { dropped.push({ term: j.term, archive: aname, count: null, reason: '조회 실패' }); return; }
    if (j.noisy) { dropped.push({ term: j.term, archive: aname, count: r.value.count, reason: j.noisy }); return; }
    kept.push({ term: j.term, archive: aname, count: r.value.count });
    (r.value.records || []).forEach((rec) => {
      const key = (j.archive + '|' + (rec.ref || rec.title || '')).trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      records.push({ ...rec, matchedBy: j.term, archive: aname });
    });
  });

  return Response.json({
    ok: true,
    source: use.map((a) => ARCHIVES[a].name).join(' · '),
    via: 'KOREA ARCHIVE 통합검색 (korea-archive-mcp.vercel.app)',
    queriedAt: new Date().toISOString(),
    query: q, archives: use, kept, dropped, records: records.slice(0, 30),
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}
