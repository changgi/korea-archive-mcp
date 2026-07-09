import { z } from 'zod';
import { createMcpHandler } from 'mcp-handler';
import { DATA } from '../../../lib/data.js';
import { judgeRights } from '../../../lib/rights.js';

export const maxDuration = 60;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const jget = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function koreaScore(t) {
  const s = (t || '').toLowerCase();
  return ['korea','korean','corea','corean','chosen','seoul','pusan','panmunjom','inchon','pyongyang','armistice'].filter(w => s.includes(w)).length;
}

async function tnaFetch(query, rows = 20, page = 1) {
  const u = new URL('https://discovery.nationalarchives.gov.uk/API/search/records');
  u.searchParams.set('sps.searchQuery', query);
  u.searchParams.set('sps.resultsPageSize', String(rows));
  u.searchParams.set('sps.page', String(page));
  return jget(u.toString());
}
const tnaLine = (r) => `- [${r.reference || '?'}] ${(r.title || r.description || '').replace(/<[^>]+>/g, '').slice(0, 110)} (${r.coveringDates || ''}) https://discovery.nationalarchives.gov.uk/details/r/${r.id}`;

const handler = createMcpHandler((server) => {
  server.tool('tna_search',
    'Search the UK National Archives (TNA) Discovery catalog for Korea-related records. Reference codes like "FO 371/84053" are auto-quoted. 영국 국립기록관 검색.',
    { query: z.string().describe('e.g. "Korea armistice", "FO 371 FK1015", "WO 281 Glosters"'), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, max_results }) => {
      const q = /^[A-Z]+ \d+\/\d+$/.test(query.trim()) ? `"${query.trim()}"` : query;
      const d = await tnaFetch(q, max_results);
      const recs = d.records || [];
      return text(`TNA '${query}' — total ${d.count ?? '?'}:\n` + (recs.map(tnaLine).join('\n') || '(0 results)'));
    });

  server.tool('tna_adjacent_mine',
    'Adaptive Mining: crawl piece numbers around a verified TNA reference (e.g. FO 371/84053) to surface undiscovered Korea files. 인접 확장 채굴 (Song 2026, 214 series discovered).',
    { reference: z.string().describe('e.g. "FO 371/84053"'), radius: z.number().int().min(1).max(8).default(3) },
    async ({ reference, radius }) => {
      const m = reference.trim().match(/^([A-Z]+ \d+)\/(\d+)$/);
      if (!m) return text('Reference format error — expected e.g. FO 371/84053');
      const series = m[1]; const piece = parseInt(m[2], 10);
      const lines = [];
      for (let p = piece - radius; p <= piece + radius; p++) {
        const ref = `${series}/${p}`;
        try {
          const d = await tnaFetch(`"${ref}"`, 5);
          for (const r of d.records || []) {
            if (!(r.reference || '').startsWith(series)) continue;
            const sc = koreaScore((r.title || '') + ' ' + (r.description || ''));
            lines.push(`${sc >= 1 ? '★' : ' '} ${r.reference} | score=${sc} | ${(r.title || '').replace(/<[^>]+>/g, '').slice(0, 90)}`);
          }
        } catch (e) { lines.push(`  ${ref} | ERROR ${e.message}`); }
        await sleep(250);
      }
      return text(`Adjacent mining ${series}/${piece}±${radius} (★ = Korea-related promotion candidate):\n` + (lines.slice(0, 60).join('\n') || '(0)'));
    });

  server.tool('nara_search',
    'Search the US NARA catalog (API v2). Requires NARA_API_KEY env on the server; record_group enables precision cross-search (e.g. 242). 미국 NARA 검색.',
    { query: z.string(), record_group: z.number().int().optional(), moving_images_only: z.boolean().default(false), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, record_group, moving_images_only, max_results }) => {
      const key = process.env.NARA_API_KEY;
      if (!key) return text('NARA_API_KEY not configured on this server. Free key: email Catalog_API@nara.gov (name + email). Meanwhile use catalog.archives.gov directly.');
      const u = new URL('https://catalog.archives.gov/api/v2/records/search');
      u.searchParams.set('q', query); u.searchParams.set('limit', String(max_results)); u.searchParams.set('page', '1');
      if (record_group) u.searchParams.set('recordGroupNumber', String(record_group));
      if (moving_images_only) u.searchParams.set('typeOfMaterials', 'Moving Images');
      const d = await jget(u.toString(), { 'x-api-key': key });
      const hits = ((d.body || {}).hits || {});
      const rows = (hits.hits || []).map((h) => {
        const rec = (h._source || {}).record || {};
        return `- [NAID ${rec.naId}] ${(rec.title || '').slice(0, 100)} | ${rec.localIdentifier || ''} | https://catalog.archives.gov/id/${rec.naId}`;
      });
      const total = typeof hits.total === 'object' ? hits.total.value : hits.total;
      return text(`NARA '${query}'${record_group ? ` (RG ${record_group})` : ''} — total ${total}:\n` + (rows.join('\n') || '(0 results)'));
    });

  server.tool('ia_search',
    'Search archive.org (advanced search syntax). e.g. "identifier:111-adc*", "collection:universal_newsreels AND korea", "mediatype:movies AND (keijo OR chosen)".',
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, max_results }) => {
      const u = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=date&rows=${max_results}&output=json`;
      const d = await jget(u);
      const docs = ((d.response || {}).docs) || [];
      return text(`archive.org '${query}' — total ${(d.response || {}).numFound}:\n` + (docs.map((x) => `- ${x.identifier} | ${String(x.title).slice(0, 90)} | https://archive.org/details/${x.identifier}`).join('\n') || '(0)'));
    });

  server.tool('ia_metadata',
    'Inspect an archive.org item: metadata, license, original files with sizes (check before downloading).',
    { identifier: z.string() },
    async ({ identifier }) => {
      const d = await jget(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
      const md = d.metadata || {};
      const files = (d.files || []).filter((f) => f.source === 'original').slice(0, 10);
      return text(`Title: ${md.title}\nDate: ${md.date} | License: ${md.licenseurl || md.rights || 'not stated'}\nDescription: ${String(md.description || '').slice(0, 300)}\nOriginal files:\n` + files.map((f) => `- ${f.name} (${(Number(f.size || 0) / 1e6).toFixed(1)}MB)`).join('\n'));
    });

  server.tool('gallica_search',
    'Search Gallica (Bibliothèque nationale de France, no key needed). Use French terms: Corée, guerre de Corée, missionnaires Corée, Tchosen. 프랑스 국립도서관 검색.',
    { query: z.string().describe('French terms work best, e.g. "Corée missionnaires"'), max_results: z.number().int().min(1).max(30).default(10) },
    async ({ query, max_results }) => {
      const q = encodeURIComponent(`gallica all "${query.replace(/"/g, '')}"`);
      const r = await fetch(`https://gallica.bnf.fr/SRU?operation=searchRetrieve&version=1.2&query=${q}&maximumRecords=${max_results}`, { headers: { 'User-Agent': UA } });
      const xml = await r.text();
      const total = (xml.match(/<srw:numberOfRecords>(\d+)</) || [])[1] || '?';
      const recs = xml.split('<srw:record>').slice(1);
      const g = (block, tag) => { const m = block.match(new RegExp(`<dc:${tag}[^>]*>([^<]*)<`)); return m ? m[1].trim() : ''; };
      const lines = recs.slice(0, max_results).map((b) => `- ${g(b, 'title').slice(0, 100)} (${g(b, 'date')}) [${g(b, 'type')}] ${g(b, 'identifier')}`);
      return text(`Gallica '${query}' — total ${total}:\n` + (lines.join('\n') || '(0)') + '\nTip: French variants — Corée·Coréens·Séoul·Fusan·guerre de Corée·Tchosen');
    });

  server.tool('europeana_search',
    'Search Europeana — 4,000+ institutions in 58 countries. Requires EUROPEANA_API_KEY env (free at apis.europeana.eu). media_type: VIDEO|IMAGE|TEXT|SOUND. 유럽 통합 검색.',
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(15), media_type: z.enum(['VIDEO', 'IMAGE', 'TEXT', 'SOUND']).optional() },
    async ({ query, max_results, media_type }) => {
      const key = process.env.EUROPEANA_API_KEY;
      if (!key) return text('EUROPEANA_API_KEY not configured. Free key at https://apis.europeana.eu/ . Meanwhile search europeana.eu directly (query: Korea OR Corée OR Korea-Krieg).');
      const u = new URL('https://api.europeana.eu/record/v2/search.json');
      u.searchParams.set('wskey', key); u.searchParams.set('query', query);
      u.searchParams.set('rows', String(max_results)); u.searchParams.set('profile', 'standard');
      if (media_type) u.searchParams.set('qf', `TYPE:${media_type}`);
      const d = await jget(u.toString());
      const items = d.items || [];
      return text(`Europeana '${query}'${media_type ? ` [${media_type}]` : ''} — total ${d.totalResults}:\n` + (items.map((it) => `- ${String((it.title || ['?'])[0]).slice(0, 90)} (${(it.year || [''])[0]}) — ${String((it.dataProvider || [''])[0]).slice(0, 40)} | ${it.guid || ''}`).join('\n') || '(0)') + '\nTip: multilingual — Corée(fr)·Korea-Krieg(de)·Corea(it/es)');
    });

  server.tool('query_bank',
    'Browse 1,943 validated discovery keywords (Song 2026). topic: "list" for groups, a group id (G-01..G-22, N-01..N-07), "RG" for NARA Record Group cross-map, "TNA" for the 14 strategy layers. 검증 쿼리 뱅크.',
    { topic: z.string().default('list') },
    async ({ topic }) => {
      const t = topic.trim();
      if (t === 'list') {
        const lines = [...DATA.common, ...DATA.nara_groups].map((g) => `${g.id}: ${g.ko} / ${g.en} (${g.kws.length})`);
        lines.push('RG: NARA 28 Record Group cross-map (63 precision queries)', 'TNA: 14 strategy layers (1,222 generated queries)');
        return text('Query bank groups:\n' + lines.join('\n'));
      }
      const grp = [...DATA.common, ...DATA.nara_groups].find((g) => g.id.toUpperCase() === t.toUpperCase());
      if (grp) return text(`${grp.id} ${grp.ko} / ${grp.en}:\n` + grp.kws.map((k) => `- ${k}`).join('\n'));
      if (t.toUpperCase() === 'RG') return text('NARA RG cross-map:\n' + Object.entries(DATA.rg_map).map(([rg, v]) => `- RG ${rg}: ${v.desc} → ${v.kws.join(', ')}`).join('\n'));
      if (t.toUpperCase() === 'TNA') return text('TNA strategy layers:\n' + DATA.tna_layers.map((l) => `- ${l.id} (${l.type}) ${l.count} queries — e.g. ${l.example}`).join('\n'));
      return text('Group not found — use topic="list"');
    });

  server.tool('judge_rights',
    'First-pass copyright triage for a discovered record. A/B publishable · C permission needed · D unknown (do not publish). Final determination must be made by a human. 권리 등급 자동 초기판정.',
    { rg_series: z.string().describe('e.g. "RG 242/242-MID"'), title: z.string().default(''), archive: z.string().default('') },
    async ({ rg_series, title, archive }) => {
      const res = judgeRights(rg_series, title, archive);
      return text(`Class: ${res[0]}\nBasis: ${res[1]}\n※ Automated first-pass — confirm manually before publishing. Class D must not be published.`);
    });
}, {}, { basePath: '/api' });

export { handler as GET, handler as POST, handler as DELETE };
