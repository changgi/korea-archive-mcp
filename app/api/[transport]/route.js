import { z } from 'zod';
import { createMcpHandler } from 'mcp-handler';
import { DATA } from '../../../lib/data.js';
import { judgeRights } from '../../../lib/rights.js';
import { PROFILES } from '../../../lib/profiles.js';
import { DOMESTIC } from '../../../lib/domestic_keywords.js';

export const maxDuration = 60;
// Korean government archive sites (archives.seoul.go.kr, opengov.seoul.go.kr, …) block foreign /
// datacenter egress IPs — on Vercel's default (US) region this surfaces as "fetch failed" even though
// the same request returns HTTP 200 from a Korean IP. Pin this function to Seoul (icn1) so outbound
// requests originate from Korea. Also settable in Vercel dashboard (Settings → Functions → Region → Seoul)
// or vercel.json "regions". Overseas archives (NARA, TNA, Gallica, Europeana, archive.org) stay globally reachable.
export const preferredRegion = 'icn1';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const FETCH_TIMEOUT = 20000;
// Optional last-resort bypass for hosts that block cloud/datacenter IPs even from Seoul.
// Set FETCH_PROXY_PREFIX to a read-through proxy that returns RAW content, e.g.
//   "https://api.allorigins.win/raw?url="   (raw HTML, recommended for the gov scrapers)
//   "https://r.jina.ai/"                    (uses the X-Return-Format:html header sent below)
// Use "{url}" as a placeholder for the URL-encoded target; otherwise the target is appended.
const PROXY = process.env.FETCH_PROXY_PREFIX || '';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Surface the real network cause (undici hides it behind a generic "fetch failed").
const errInfo = (e) => {
  const c = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : '';
  return `${(e && e.name) || 'Error'}: ${(e && e.message) || e}${c ? ` (${c})` : ''}`;
};
const proxied = (url) => (PROXY.includes('{url}') ? PROXY.replace('{url}', encodeURIComponent(url)) : PROXY + encodeURIComponent(url));

// fetch with UA + timeout + one retry, then an optional proxy fallback for geo/ASN-blocked hosts.
async function robustFetch(url, headers = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) { lastErr = e; if (attempt === 0) await sleep(300); }
  }
  if (PROXY) {
    const r = await fetch(proxied(url), { headers: { 'User-Agent': UA, 'X-Return-Format': 'html', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!r.ok) throw new Error(`HTTP ${r.status} (via proxy)`);
    return r;
  }
  throw new Error(errInfo(lastErr));
}

const jget = async (url, headers = {}) => (await robustFetch(url, { Accept: 'application/json', ...headers })).json();
const gtext = async (url, headers = {}) => (await robustFetch(url, headers)).text();
const CHELIPED_INSTALL = 'cheliped-skills 설치(https://github.com/tykimos/cheliped-skills): git clone https://github.com/tykimos/cheliped-skills && cd cheliped-skills/browser/scripts && npm install && npm run build';
const chelipedCmd = (url) => `node cheliped-cli.mjs '${JSON.stringify([{ cmd: 'goto', args: [url] }, { cmd: 'observe' }])}'`;
const chelipedSearch = (url, query) => `${CHELIPED_INSTALL}\n1) 관찰: ${chelipedCmd(url)}\n2) 검색: node cheliped-cli.mjs '${JSON.stringify([{ cmd: 'fill', args: ['<검색창번호>', query] }, { cmd: 'click', args: ['<버튼번호>'] }, { cmd: 'scrape' }])}'\n   (1)의 observe 결과 번호로 <검색창번호>·<버튼번호> 치환)`;
const xtag = (block, t) => { const m = block.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)); return m ? m[1].replace(/<[^>]+>/g, '').trim() : ''; };

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

// ══════════ 상호보완 다중채널 수집 (concurrent collect + merge/dedup) ══════════
const norm = (s) => (s == null ? '' : String(s)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const dedupKey = (it) => norm(it.title).toLowerCase().replace(/[^a-z0-9가-힣一-鿿]/g, '').slice(0, 50) + '|' + (it.id || '');
// run collectors concurrently; merge, dedup by title|id, union the source tags (상호보완: 한 record를 여러 채널이 확인)
async function collectMerged(collectors) {
  const settled = await Promise.allSettled(collectors.map((c) => c.fn()));
  const map = new Map(); const stats = [];
  settled.forEach((r, i) => {
    const name = collectors[i].source;
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      stats.push(`${name}:${r.value.length}`);
      for (const raw of r.value) {
        if (!raw || !norm(raw.title)) continue;
        const k = dedupKey({ ...raw });
        if (map.has(k)) { const e = map.get(k); if (!e.sources.includes(name)) { e.sources.push(name); if (!e.url && raw.url) e.url = raw.url; } }
        else map.set(k, { title: norm(raw.title), date: raw.date || '', id: raw.id || '', url: raw.url || '', sources: [name] });
      }
    } else stats.push(`${name}:—`);
  });
  return { items: [...map.values()], stats };
}
// nedb: 국사편찬위 한국사DB의 data.go.kr 공식 개방파일(KOGL)을 미리 인덱싱해 웹 배치한 것을 검색 — robots 무관(라이브 스크래핑 없음).
// NEDB_INDEX_URL 에 ingest-opendata.mjs로 만든 nedb_index.json(호스팅 URL)을 지정하면 활성화.
let _nedbPromise = null;
function loadNedbIndex() {
  if (_nedbPromise) return _nedbPromise;  // cache the in-flight promise so concurrent cold-start callers share one load
  _nedbPromise = (async () => {
    const url = process.env.NEDB_INDEX_URL;
    if (!url) return null;
    try { const d = await jget(url); return Array.isArray(d) ? d : (d.records || null); } catch { return null; }
  })();
  return _nedbPromise;
}
function nedbFileSearch(recs, q, n) {
  const ql = q.toLowerCase();
  return recs.filter((r) => (r.title || '').toLowerCase().includes(ql) || (r.text || '').toLowerCase().includes(ql))
    .slice(0, n).map((r) => ({ title: r.title || '', date: r.date || '', id: r.db || '', url: r.url || '' }));
}

// normalized per-source collectors → [{title,date,id,url}]; compliant channels only (robots-OK APIs / officially-published files)
const COLLECT = {
  tna: async (q, n) => {
    const query = /^[A-Z]+ \d+\/\d+$/.test(q.trim()) ? `"${q.trim()}"` : q;
    const d = await tnaFetch(query, n);
    return (d.records || []).map((r) => ({ title: r.title || r.description, date: r.coveringDates || '', id: r.reference || '', url: `https://discovery.nationalarchives.gov.uk/details/r/${r.id}` }));
  },
  ia: async (q, n) => {
    const d = await jget(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=date&rows=${n}&output=json`);
    return ((d.response || {}).docs || []).map((x) => ({ title: String(x.title || ''), date: x.date || '', id: x.identifier, url: `https://archive.org/details/${x.identifier}` }));
  },
  gallica: async (q, n) => {
    const query = encodeURIComponent(`gallica all "${q.replace(/"/g, '')}"`);
    const r = await robustFetch(`https://gallica.bnf.fr/SRU?operation=searchRetrieve&version=1.2&query=${query}&maximumRecords=${n}`);
    const xml = await r.text();
    return xml.split('<srw:record>').slice(1, n + 1).map((b) => {
      const g = (t) => { const m = b.match(new RegExp(`<dc:${t}[^>]*>([^<]*)<`)); return m ? m[1].trim() : ''; };
      return { title: g('title'), date: g('date'), id: g('identifier'), url: g('identifier') };
    });
  },
  europeana: async (q, n) => {
    const key = process.env.EUROPEANA_API_KEY || 'api2demo';
    const d = await jget(`https://api.europeana.eu/record/v2/search.json?wskey=${key}&query=${encodeURIComponent(q)}&rows=${n}&profile=standard`);
    return (d.items || []).map((it) => ({ title: (it.title || ['?'])[0], date: (it.year || [''])[0], id: it.id || '', url: it.guid || '' }));
  },
  nara: async (q, n) => {
    const key = process.env.NARA_API_KEY; if (!key) return [];
    const d = await jget(`https://catalog.archives.gov/api/v2/records/search?q=${encodeURIComponent(q)}&limit=${n}&page=1`, { 'x-api-key': key });
    return ((((d.body || {}).hits || {}).hits) || []).map((h) => { const rec = (h._source || {}).record || {}; return { title: rec.title || '', date: '', id: rec.naId ? `NAID ${rec.naId}` : '', url: `https://catalog.archives.gov/id/${rec.naId}` }; });
  },
  archives: async (q, n) => {
    const key = process.env.ARCHIVES_API_KEY; if (!key) return [];
    const sk = /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
    const xml = await gtext(`https://apis.data.go.kr/1741050/openapi/searcharc?serviceKey=${sk}&query=${encodeURIComponent(q)}&start=1&limit=${n}`);
    return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((i) => ({ title: xtag(i, 'title'), date: xtag(i, 'prod_year'), id: xtag(i, 'prod_name'), url: xtag(i, 'link') }));
  },
  nlk: async (q, n) => {
    const key = process.env.NLK_API_KEY; if (!key) return [];
    const xml = await gtext(`https://www.nl.go.kr/NL/search/openApi/search.do?key=${encodeURIComponent(key)}&apiType=xml&srchTarget=total&kwd=${encodeURIComponent(q)}&pageSize=${n}&pageNum=1`);
    return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => { let lk = xtag(it, 'detail_link') || xtag(it, 'org_link'); if (lk.startsWith('/')) lk = 'https://www.nl.go.kr' + lk; return { title: xtag(it, 'title_info') || xtag(it, 'title'), date: xtag(it, 'pub_year_info'), id: xtag(it, 'type_name'), url: lk }; });
  },
  nedb: async (q, n) => { const recs = await loadNedbIndex(); return recs ? nedbFileSearch(recs, q, n) : []; },
};

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
    'Search Europeana — 4,000+ institutions in 58 countries. Works out of the box (shared demo key); set EUROPEANA_API_KEY for heavy use. media_type: VIDEO|IMAGE|TEXT|SOUND. 유럽 통합 검색.',
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(15), media_type: z.enum(['VIDEO', 'IMAGE', 'TEXT', 'SOUND']).optional() },
    async ({ query, max_results, media_type }) => {
      const key = process.env.EUROPEANA_API_KEY || 'api2demo';
      const demo = !process.env.EUROPEANA_API_KEY;
      const u = new URL('https://api.europeana.eu/record/v2/search.json');
      u.searchParams.set('wskey', key); u.searchParams.set('query', query);
      u.searchParams.set('rows', String(max_results)); u.searchParams.set('profile', 'standard');
      if (media_type) u.searchParams.set('qf', `TYPE:${media_type}`);
      const d = await jget(u.toString());
      const items = d.items || [];
      return text(`Europeana '${query}'${media_type ? ` [${media_type}]` : ''} — total ${d.totalResults}:\n` + (items.map((it) => `- ${String((it.title || ['?'])[0]).slice(0, 90)} (${(it.year || [''])[0]}) — ${String((it.dataProvider || [''])[0]).slice(0, 40)} | ${it.guid || ''}`).join('\n') || '(0)') + '\nTip: multilingual — Corée(fr)·Korea-Krieg(de)·Corea(it/es)' + (demo ? '\n(shared demo key in use — for heavy use, set a free EUROPEANA_API_KEY from apis.europeana.eu)' : ''));
    });

  server.tool('query_bank',
    'Browse validated discovery keywords (Song 2026). topic: "list" for groups, a group id (G-01..G-22, N-01..N-07), "RG" for NARA Record Group cross-map, "TNA" for the 14 strategy layers, "domestic" for the 5 domestic archives, or a domestic key (nedb/archives/nlk/warmemo/seoul) / domestic group id (e.g. NAK-L1). 검증 쿼리 뱅크(국내 아카이브 포함).',
    { topic: z.string().default('list') },
    async ({ topic }) => {
      const t = topic.trim();
      if (t === 'list') {
        const lines = [...DATA.common, ...DATA.nara_groups].map((g) => `${g.id}: ${g.ko} / ${g.en} (${g.kws.length})`);
        lines.push('RG: NARA 28 Record Group cross-map (63 precision queries)', 'TNA: 14 strategy layers (1,222 generated queries)');
        lines.push('domestic: 국내 5개 아카이브 검증 키워드셋 — topic="domestic", 기관키(nedb/archives/nlk/warmemo/seoul), 또는 그룹ID(예 NAK-L1)');
        return text('Query bank groups:\n' + lines.join('\n'));
      }
      const grp = [...DATA.common, ...DATA.nara_groups].find((g) => g.id.toUpperCase() === t.toUpperCase());
      if (grp) return text(`${grp.id} ${grp.ko} / ${grp.en}:\n` + grp.kws.map((k) => `- ${k}`).join('\n'));
      if (t.toUpperCase() === 'RG') return text('NARA RG cross-map:\n' + Object.entries(DATA.rg_map).map(([rg, v]) => `- RG ${rg}: ${v.desc} → ${v.kws.join(', ')}`).join('\n'));
      if (t.toUpperCase() === 'TNA') return text('TNA strategy layers:\n' + DATA.tna_layers.map((l) => `- ${l.id} (${l.type}) ${l.count} queries — e.g. ${l.example}`).join('\n'));
      // ── 국내 아카이브 키워드셋 (validated) ──
      if (t.toLowerCase() === 'domestic') {
        const lines = Object.entries(DOMESTIC).map(([k, v]) => `- ${k} (${v.name}): 그룹 ${v.groups.map((g) => g.id).join('·')} | 분류맵 ${Object.keys(v.class_map).length} | 관행노트 ${v.notes.length}`);
        return text('국내 아카이브 3대 부정합 키워드셋 (topic=기관키 또는 그룹ID):\n' + lines.join('\n'));
      }
      const dinst = DOMESTIC[t.toLowerCase()];
      if (dinst) {
        const gl = dinst.groups.map((g) => `[${g.id}] ${g.ko} (${g.dim}, ${g.kws.length}): ${g.kws.slice(0, 14).join(', ')}${g.kws.length > 14 ? ' …' : ''}`);
        const cm = Object.entries(dinst.class_map).map(([c, v]) => `- ${c}: ${v.kws.join(', ')}`);
        return text(`${dinst.name} — ${dinst.scheme}\n\n[① 언어적 부정합 — 검증 키워드]\n${gl.join('\n')}\n\n[② 분류 교차매핑]\n${cm.join('\n')}\n\n[③ 기술관행 노트]\n- ${dinst.notes.join('\n- ')}`);
      }
      for (const v of Object.values(DOMESTIC)) {
        const g = v.groups.find((g) => g.id.toUpperCase() === t.toUpperCase());
        if (g) return text(`${g.id} ${g.ko} (${v.name}) [${g.dim}]:\n` + g.kws.map((k) => `- ${k}`).join('\n'));
      }
      return text('Group not found — use topic="list" (해외 G/N/RG/TNA) 또는 "domestic"');
    });

  server.tool('judge_rights',
    'First-pass copyright triage for a discovered record. A/B publishable · C permission needed · D unknown (do not publish). Final determination must be made by a human. 권리 등급 자동 초기판정.',
    { rg_series: z.string().describe('e.g. "RG 242/242-MID"'), title: z.string().default(''), archive: z.string().default('') },
    async ({ rg_series, title, archive }) => {
      const res = judgeRights(rg_series, title, archive);
      return text(`Class: ${res[0]}\nBasis: ${res[1]}\n※ Automated first-pass — confirm manually before publishing. Class D must not be published.`);
    });

  server.tool('report_template',
    'Get the HTML report skeleton + 11 writing rules to render finished discovery results as a styled archival report. Call this as the FINAL step of an investigation, fill the {{placeholders}} with verified findings only, and save as [topic]_records_[years].html. 발굴 조사 마무리 단계에서 호출 — HTML 발굴 보고서 골격과 작성 규칙 반환.',
    {},
    async () => text(REPORT_RULES + '\n\n===== HTML TEMPLATE (fill the {{placeholders}}) =====\n' + REPORT_TEMPLATE));

  // ===== 국내 아카이브 — 자동 브라우징(서버 사이드 fetch·파싱) v1.9.0 =====
  const dclean = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();
  const dbrowse = (u) => `\n열어보기: ${u}`;
  const agentBrowse = (name, q, u, why = '이 기관은 자동 페치가 제한적입니다') => `${name} '${q}' — ${why}.\n➤ 에이전트 지시: 이 메시지를 그대로 사용자에게 전달하지 마세요. 대신 당신의 웹 검색(WebSearch)으로 '${q}'를 이 기관에서 찾거나 아래 공식 검색 URL을 열람해 상위 결과(제목·연대·링크)를 표로 정리해 사용자에게 제시하세요. 결과가 있으면 report_template으로 HTML 보고서화도 가능합니다.\n공식 검색: ${u}`;

  server.tool('nedb_search',
    "Search 국사편찬위 한국사데이터베이스 (db.history.go.kr). PREFERRED: set NEDB_INDEX_URL to a pre-built index of the OFFICIAL data.go.kr open-data files (KOGL) — searches those files (robots-compliant, no live scraping). Otherwise falls back to the integrated-search page (note: db.history.go.kr/robots.txt disallows generic crawlers — prefer the file index or a browser tool). 한자·한글 병행 표기 권장.",
    { query: z.string(), db: z.string().default(''), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, max_results }) => {
      const browse = 'https://db.history.go.kr/search/searchResultList.do?searchKeywordType=BI&searchKeyword=' + encodeURIComponent(query);
      const idx = await loadNedbIndex();
      if (idx) {
        const hits = nedbFileSearch(idx, query, max_results);
        return text(`한국사DB(공식 개방파일 인덱스) '${query}' — ${hits.length}건:\n`
          + (hits.map((h) => `- [${h.id}] ${h.title.slice(0, 95)}${h.url ? ' ' + h.url : ''}`).join('\n') || '(0건 — 다른 표기(한자 원표기 등) 시도)')
          + `\n※ data.go.kr 공식 파일(KOGL) 기반 — robots 무관. 전체 통합검색(브라우저): ${browse}`);
      }
      const api = 'https://db.history.go.kr/search/searchTotalResult.do?searchKeyword=' + encodeURIComponent(query);
      try {
        const b = await gtext(api);
        const seen = new Set(); const dbs = [];
        const re = /href="\/item\/\w+\/main\.do"[^>]*>([\s\S]*?)<\/a>/g; let m;
        // strip the "n(ew)" badge (<span class="btn-new">n</span>) so DB names aren't suffixed with " n"
        while ((m = re.exec(b))) { const nm = dclean(m[1].replace(/<span[^>]*class="btn-new"[^>]*>[\s\S]*?<\/span>/g, '')); if (nm && !seen.has(nm)) { seen.add(nm); dbs.push(nm); } }
        if (dbs.length) return text(`한국사DB '${query}' — 검색어가 등장하는 DB ${dbs.length}종:\n` + dbs.slice(0, max_results).map((d) => '- ' + d).join('\n') + dbrowse(browse) + '\n각 DB에서 문서 단위로 열람. 한자 원표기 병행 검색 권장.');
        return text(agentBrowse('한국사DB', query, browse, '통합검색에서 매칭 DB 미검출'));
      } catch (e) { return text(agentBrowse('한국사DB', query, browse, `자동조회 실패(${e.message})`)); }
    });

  server.tool('archives_search',
    "Search 국가기록원 국가기록포털 (archives.go.kr) via official OpenAPI (RSS). Set a free data.go.kr key '나라기록물정보 서비스'(15000153) as ARCHIVES_API_KEY and the server auto-searches; otherwise returns the portal URL. 공공누리 확인 후 이용.",
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(10) },
    async ({ query, max_results }) => {
      const key = process.env.ARCHIVES_API_KEY;
      const portal = 'https://www.archives.go.kr/next/newsearch/listSubjectDescription.do?query=' + encodeURIComponent(query);
      if (!key) return text(agentBrowse('국가기록원', query, portal, "OpenAPI 키(ARCHIVES_API_KEY, data.go.kr 15000153) 미설정"));
      const sk = /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
      const api = `https://apis.data.go.kr/1741050/openapi/searcharc?serviceKey=${sk}&query=${encodeURIComponent(query)}&start=1&limit=${Math.min(max_results, 50)}`;
      try {
        const xml = await gtext(api);
        if (xml.includes('searchError') || !xml.includes('<item>')) return text(agentBrowse('국가기록원', query, portal, `API 오류: ${xtag(xml, 'message') || '결과 없음'}`));
        const tot = xtag(xml, 'total') || '?';
        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        const lines = items.slice(0, max_results).map((i) => `- ${xtag(i, 'title').slice(0, 90)} (${xtag(i, 'prod_year')}) · ${xtag(i, 'prod_name').slice(0, 20)} [${xtag(i, 'is_open') === '1' ? '공개' : '비공개'}] ${xtag(i, 'link')}`);
        return text(`국가기록원 '${query}' — 총 ${tot}건:\n` + (lines.join('\n') || '(0건)') + '\n공공누리(KOGL) 유형 확인 후 이용. 비공개 항목은 정보공개청구 대상.');
      } catch (e) { return text(agentBrowse('국가기록원', query, portal, `API 오류(${e.message})`)); }
    });

  server.tool('nlk_search',
    "Search 국립중앙도서관 (nl.go.kr) collections. collection: total·subject·newspaper(1883-1960 old newspapers, free use)·gwanbo·exhibit·koreanmemory·overseas. With NLK_API_KEY the server auto-searches. category (자료유형: 도서·고문헌·학위논문·잡지/학술지·신문·기사·멀티미디어) runs a 2nd concurrent type-scoped channel merged with the full-catalog channel (상호보완 이중수집).",
    { query: z.string(), collection: z.enum(['total', 'subject', 'newspaper', 'gwanbo', 'exhibit', 'koreanmemory', 'overseas']).default('total'), category: z.enum(['도서', '고문헌', '학위논문', '잡지/학술지', '신문', '기사', '멀티미디어']).optional(), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, collection, category, max_results }) => {
      const COLL = {
        total: ['전체 소장자료', 'https://www.nl.go.kr/NL/contents/search.do?srchTarget=total&kwd=', true],
        subject: ['주제별컬렉션', 'https://www.nl.go.kr/NL/contents/N20103000000.do', true],
        newspaper: ['대한민국신문아카이브', 'https://www.nl.go.kr/newspaper/search_list.do?keyword=', false],
        gwanbo: ['관보', 'https://www.nl.go.kr/NL/contents/N20301000000.do', true],
        exhibit: ['전시컬렉션(온라인전시)', 'https://www.nl.go.kr/NL/contents/N20104000000.do', false],
        koreanmemory: ['코리안메모리', 'https://nl.go.kr/koreanmemory/', false],
        overseas: ['해외 한국관련자료', 'https://www.nl.go.kr/NL/contents/N20401010000.do', true],
      };
      const NOTE = { newspaper: '1883–1960 고신문 108종. 저작권 만료 — 출처표기 시 자유이용.', koreanmemory: '구술·사진 큐레이션.', exhibit: '온라인 전시.', overseas: '해외 소재 한국 관련 자료.', gwanbo: '대한제국·총독부·대한민국 관보 원문.', subject: '주제별 선별 컬렉션.', total: '전체 소장자료.' };
      const [name, base, apiOk] = COLL[collection];
      const openUrl = (base.endsWith('kwd=') || base.endsWith('keyword=')) ? base + encodeURIComponent(query) : base;
      const note = NOTE[collection] || '';
      const key = process.env.NLK_API_KEY;
      if (apiOk && key) {
        const base = `https://www.nl.go.kr/NL/search/openApi/search.do?key=${encodeURIComponent(key)}&apiType=xml&srchTarget=total&kwd=${encodeURIComponent(query)}&pageSize=${Math.min(max_results, 50)}&pageNum=1`;
        const parse = (xml) => {
          const tot = xtag(xml, 'total') || '?';
          const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
          const pick = (b, tags) => { for (const t of tags) { const v = xtag(b, t); if (v) return v; } return ''; };
          const lines = items.slice(0, max_results).map((it) => {
            let title = pick(it, ['title_info', 'titleInfo', 'title']);
            if (!title) title = it.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const typ = pick(it, ['type_name', 'typeName']);
            const pub = pick(it, ['pub_info', 'author_info', 'authorInfo']);
            const year = pick(it, ['pub_year_info', 'pubYearInfo']);
            let lk = pick(it, ['org_link', 'detail_link', 'detailLink']);
            if (lk.startsWith('/')) lk = 'https://www.nl.go.kr' + lk;
            return '- ' + title.slice(0, 80) + (typ ? ' [' + typ + ']' : '') + (pub ? ' · ' + pub.slice(0, 20) : '') + (year ? ' (' + year + ')' : '') + (lk ? ' ' + lk : '');
          });
          return { tot, lines };
        };
        try {
          // 이중채널 동시 수집: (A) 전체 소장자료 + (B) 자료유형(category) 정밀 — 상호보완
          const [totalXml, catXml] = await Promise.all([
            gtext(base),
            category ? gtext(base + '&category=' + encodeURIComponent(category)).catch(() => null) : Promise.resolve(null),
          ]);
          if (totalXml.includes('<error')) return text(`NLK OpenAPI 오류: ${xtag(totalXml, 'msg') || '?'} — NLK_API_KEY 확인.` + dbrowse(openUrl));
          const A = parse(totalXml);
          let out = `국립중앙도서관 자동검색(전체 소장자료) '${query}' — 총 ${A.tot}건:\n` + (A.lines.join('\n') || '(0건)');
          if (category && catXml && !catXml.includes('<error')) {
            const B = parse(catXml);
            out += `\n\n[② 자료유형 '${category}' 정밀 채널 — 총 ${B.tot}건 (동시 수집)]\n` + (B.lines.join('\n') || '(0건)')
              + `\n※ 전체+자료유형 이중채널(상호보완).`;
          } else {
            out += `\n※ 전체 카탈로그 대상. category 인자(신문·고문헌 등)로 자료유형 정밀 이중수집 가능.`;
          }
          out += ` '${name}' 컬렉션 정밀검색: ${openUrl}` + (note ? `\n※ ${note}` : '');
          return text(out);
        } catch (e) { return text(`NLK API 오류(${e.message}).` + dbrowse(openUrl)); }
      }
      const why = (apiOk && !key) ? 'OpenAPI 키(NLK_API_KEY, www.nl.go.kr Open API) 미설정' : `큐레이션/전용 컬렉션 — ${note}`;
      return text(agentBrowse(`국립중앙도서관 · ${name}`, query, openUrl, why));
    });

  server.tool('seoul_archives_search',
    "Search 서울기록원 (archives.seoul.go.kr) — server fetches the catalog and returns collections matching the term plus the full-result URL. Seoul municipal records/photos/oral histories.",
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, max_results }) => {
      const land = 'https://archives.seoul.go.kr/catalog?search_api_fulltext=' + encodeURIComponent(query);
      const deep = 'https://archives.seoul.go.kr/catalog/result?regclass=RC_ITEM&search_api_fulltext=' + encodeURIComponent(query);
      try {
        const b = await gtext(land);
        const cols = []; const re = /href="(\/catalog\/result\?[^"]*collects=[^"]*)"[^>]*>([\s\S]*?)<\/a>/g; let m;
        while ((m = re.exec(b))) { const nm = dclean(m[2]); if (nm && nm.includes('컬렉션')) cols.push([nm, 'https://archives.seoul.go.kr' + m[1]]); }
        if (cols.length) return text(`서울기록원 '${query}' — 매칭 컬렉션 ${cols.length}개:\n` + cols.slice(0, max_results).map(([n, u]) => `- ${n}\n  ${u}`).join('\n') + `\n전체 항목: ${deep}`);
        return text(agentBrowse('서울기록원', query, deep, '매칭 컬렉션 미검출'));
      } catch (e) { return text(agentBrowse('서울기록원', query, deep, `자동조회 실패(${e.message})`)); }
    });

  server.tool('warmemo_search',
    "Search 전쟁기념관 아카이브 (archives.warmemo.or.kr) — server fetches the integrated search and returns per-category hit counts (유물·사진/필름·구술·전시 등). Korean War / military-history primary source; cross-check with NARA·TNA.",
    { query: z.string() },
    async ({ query }) => {
      const url = 'http://archives.warmemo.or.kr/intgsrch/intgsrchArchv.do?MID=UM00045&keyword=' + encodeURIComponent(query);
      try {
        const b = await gtext(url);
        const cats = []; const re = /class="total-breadcrumb">([\s\S]*?)<\/span>\s*<span>\s*총\s*([\d,]+)/g; let m;
        while ((m = re.exec(b))) cats.push([dclean(m[1]), m[2]]);
        if (cats.length) return text(`전쟁기념관 '${query}' — 카테고리별 검색 건수:\n` + cats.slice(0, 20).map(([c, n]) => `- ${c} : ${n}건`).join('\n') + dbrowse(url) + '\n한국전쟁·군사사 사료 — 해외(NARA·TNA)와 교차검증.');
        return text(agentBrowse('전쟁기념관', query, url, '통합검색 결과 미검출'));
      } catch (e) { return text(agentBrowse('전쟁기념관', query, url, `자동조회 실패(${e.message})`)); }
    });

  server.tool('foia_search',
    "대한민국 정보공개포털 (open.go.kr) — 원문정보공개·정보공개청구. Login-based portal, so returns the search URL for the agent to open with its browser tool. Unreleased documents can be requested via 정보공개청구.",
    { query: z.string() },
    async ({ query }) => {
      const url = 'https://www.open.go.kr/othicInfo/infoList/orginlInfoList.do?searchKeyword=' + encodeURIComponent(query);
      return text(agentBrowse('정보공개포털(원문정보공개)', query, url) + '\n※ 미공개 문서는 포털에서 정보공개청구로 요청.');
    });

  server.tool('local_gov_search',
    "Korean local-government FOIA/archives. source: 'seoul_opengov' (서울정보소통광장 — Seoul city decision documents, server auto-fetches the list), 'sen' (서울시교육청 정보공개), 'gyeongnam' (경상남도기록원). Decision-document originals are primary sources for local/incident history.",
    { query: z.string(), source: z.enum(['seoul_opengov', 'sen', 'gyeongnam']) },
    async ({ query, source }) => {
      if (source === 'seoul_opengov') {
        const url = 'https://opengov.seoul.go.kr/sanction/list?searchKeyword=' + encodeURIComponent(query);
        try {
          const b = await gtext(url);
          const seen = new Set(); const uniq = [];
          const re = /<a[^>]+href="(\/sanction\/\d+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
          while ((m = re.exec(b))) { const t = dclean(m[2]).replace(/^제목\s*:\s*/, ''); if (t && !seen.has(m[1])) { seen.add(m[1]); uniq.push([m[1], t]); } }
          if (uniq.length) return text(`서울정보소통광장 '${query}' — 결재문서 ${uniq.length}건:\n` + uniq.slice(0, 15).map(([h, t]) => `- ${t}\n  https://opengov.seoul.go.kr${h}`).join('\n'));
          return text(agentBrowse('서울정보소통광장', query, url, '결재문서 미검출'));
        } catch (e) { return text(agentBrowse('서울정보소통광장', query, url, `자동조회 실패(${e.message})`)); }
      }
      if (source === 'sen') return text(agentBrowse('서울시교육청 정보공개(열린 서울교육)', query, 'https://open.sen.go.kr/'));
      if (source === 'gyeongnam') return text(agentBrowse('경상남도기록원', query, 'https://archives.gyeongnam.go.kr/main.web'));
      return text('source 값: seoul_opengov, sen, gyeongnam');
    });

  server.tool('scrape_plan',
    "Check a URL's robots.txt; for robots-blocked or JS-rendered sites with no server response, advise opening the URL with the agent's own browser tool and tabulating results, then report_template. robots 판정 + 브라우저 도구 안내.",
    { url: z.string() },
    async ({ url }) => {
      const u = new URL(url); const root = `${u.protocol}//${u.host}`; const path = u.pathname || '/';
      let verdict = 'robots 미확인';
      try {
        const rb = await gtext(root + '/robots.txt'); let blocked = false, agentAll = false;
        for (const line of rb.split('\n')) { const s = line.trim().toLowerCase(); if (s.startsWith('user-agent:')) agentAll = s.includes('*'); else if (agentAll && s.startsWith('disallow:')) { const d = s.split(':')[1].trim(); if (d && path.startsWith(d)) blocked = true; } }
        verdict = blocked ? 'robots 차단 → 브라우저 도구로 열람' : 'robots 허용(단 JS 렌더면 브라우저 필요)';
      } catch (e) { verdict = `robots 미확인(${e.message})`; }
      return text(`${url}\n판정: ${verdict}\n권장: 에이전트 브라우저 도구로 이 URL을 열고 결과의 제목·링크·연대를 표로 정리한 뒤 report_template으로 HTML 보고서화. 과도한 요청은 피할 것.`);
    });

  server.tool('cross_search',
    'Federated discovery — run ONE query across multiple archives concurrently and merge+dedup the results (상호보완 동시수집: API 채널을 동시에 돌려 상호보완). sources: "all" or a comma list of tna,ia,gallica,europeana,nara,archives,nlk,nedb. Overseas (tna/ia/gallica/europeana) are keyless; nara/archives/nlk join if their server key is set; nedb joins if NEDB_INDEX_URL (official open-data files) is set. Each result is tagged by which source(s) found it — multi-source tags = cross-corroborated. 여러 아카이브를 한 쿼리로 동시 교차수집·병합.',
    { query: z.string(), sources: z.string().default('all'), max_per_source: z.number().int().min(1).max(30).default(8) },
    async ({ query, sources, max_per_source }) => {
      const want = sources.trim().toLowerCase() === 'all'
        ? Object.keys(COLLECT)
        : sources.split(',').map((s) => s.trim().toLowerCase()).filter((s) => COLLECT[s]);
      if (!want.length) return text('sources: "all" 또는 ' + Object.keys(COLLECT).join(','));
      const { items, stats } = await collectMerged(want.map((s) => ({ source: s, fn: () => COLLECT[s](query, max_per_source) })));
      items.sort((a, b) => b.sources.length - a.sources.length);
      const lines = items.slice(0, 45).map((it) => `- [${it.sources.join('+')}] ${it.title.slice(0, 95)}${it.date ? ` (${it.date})` : ''}${it.url ? ' ' + it.url : ''}`);
      return text(`교차수집 '${query}' — 채널별 [${stats.join(' · ')}] → 병합 ${items.length}건 (복수출처 우선 정렬):\n` + (lines.join('\n') || '(0)')
        + '\n※ [출처] 복수 표기 = 교차확인된 record. 국내(nara·archives·nlk)는 서버 키, nedb는 NEDB_INDEX_URL(공식 개방파일) 설정 시 포함. robots가 막은 opengov·서울기록원은 미포함 — 각 전용 도구/브라우저로.');
    });

  server.tool('source_profile',
    'Structural profile of an archive for planning discovery: 자료구조(data model: hierarchy/classification/identifiers/metadata), 이용구조(access: API/auth/query syntax/robots/rights), 활용구조(utilization: how the 3 mismatches show up, which keyword set/cross-map to use, adjacent mining, cross-archive verification combos, rights rule). institution: "list" or a key — tna·nara·ia·gallica·europeana·nedb·archives·nlk·seoul·warmemo·foia. 기관 자료·이용·활용구조 프로파일.',
    { institution: z.string().default('list') },
    async ({ institution }) => {
      const t = (institution || 'list').trim().toLowerCase();
      if (t === 'list' || !PROFILES[t]) {
        const lines = Object.entries(PROFILES).map(([k, v]) => `- ${k} (${v.name_ko}) [${v.category}]`);
        return text('기관 프로파일 (source_profile institution=<key>):\n' + lines.join('\n') + (t !== 'list' && !PROFILES[t] ? `\n\n('${institution}' 프로파일 없음 — 위 목록에서 선택)` : ''));
      }
      const p = PROFILES[t], D = p.data, A = p.access, U = p.use;
      const combos = (U.cross_archive_combos || []).map((c) => `    · ${c}`).join('\n');
      const vn = (p.verify && p.verify.notes && p.verify.notes.length) ? '\n\n【팩트체크 교정】\n- ' + p.verify.notes.join('\n- ') : '';
      return text(
        `${p.name_ko} (${p.name_en}) — ${p.category}\n` +
        `════════ ① 자료구조 (Data structure) ════════\n` +
        `· 계층/단위: ${D.hierarchy}\n· 분류체계: ${D.classification}\n· 식별자: ${D.identifiers}\n· 기술규칙: ${D.metadata_standard}\n· 범위/규모: ${D.scope}\n· 디지털화: ${D.digitization}\n` +
        `════════ ② 이용구조 (Access structure) ════════\n` +
        `· 채널/엔드포인트: ${A.channel}\n· 인증: ${A.auth}\n· 쿼리문법: ${A.query_syntax}\n· 응답형식: ${A.response_format}\n· robots/차단: ${A.blocking_notes}\n· 원문 권리: ${A.rights_access}\n· robots(실측): ${p.verify ? p.verify.robots : 'n/a'}\n` +
        `════════ ③ 활용구조 (Utilization structure) ════════\n` +
        `· 3대 부정합: ${U.mismatch_summary}\n· 키워드셋: ${U.keyword_ref}\n· 분류 교차맵: ${U.crossmap_ref}\n· 인접확장: ${U.adjacent_mining}\n· 교차검증 조합:\n${combos}\n· 권리판정: ${U.rights_rule}` +
        vn);
    });
}, {}, { basePath: '/api' });

const REPORT_RULES = `HTML 발굴 보고서 작성 규칙 (11) / Report writing rules:
1. Filename: [topic]_records_[years].html — default deliverable when an investigation finishes
2. header: "[주제] — 자료 발굴 보고" + meta(작성일 · 대상 시기 · 대상 아카이브)
3. highlight box: the single most important find (identifier · provenance · structure · significance)
4. Table 1 documents / Table 2 photos·film (omit if none): identifier·title / date / holder + citation (RG·Entry·Box) / Korea-related content / links (original → commentary → catalog search, target="_blank") / rights badge (b-A cleared · b-B PD-presumed · b-C permission needed · b-D unknown, do NOT publish)
5. Reproducible query table: purpose / query / URL-encoded live search link — only queries actually executed
6. "0 hits ≠ absence" note: digitization level + adjacent boxes(±2)/pieces(±15) follow-up advice
7. Index & recent scholarship list (ul.src)
8. Rights section: legal basis (17 U.S.C. §105 · 36 CFR 1254.62 · Crown/OGL · domaine public) + "human final confirmation required before publishing" + Class D must not be published
9. footer: methodology line + "all links verified as of [date]"
10. Only URLs actually verified via tool calls — never guess URLs
11. Sensitive topics (comfort women, POWs, massacres): include victim-dignity / ethical-use language in the rights section`;

const REPORT_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{제목}} — 자료 발굴 보고</title>
<style>
  :root{
    --ink:#1a1d23; --sub:#5a6070; --line:#e3e5ea; --bg:#f7f8fa;
    --accent:#8a3033; --accent-soft:#f7eeee; --card:#ffffff;
  }
  *{box-sizing:border-box;}
  body{margin:0; font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif; color:var(--ink); background:var(--bg); line-height:1.65;}
  .wrap{max-width:1000px; margin:0 auto; padding:40px 24px 80px;}
  header{border-bottom:3px solid var(--accent); padding-bottom:20px; margin-bottom:32px;}
  h1{font-size:26px; margin:0 0 8px;}
  .meta{color:var(--sub); font-size:14px;}
  h2{font-size:20px; margin:40px 0 12px; padding-left:12px; border-left:4px solid var(--accent);}
  p{margin:10px 0;}
  .highlight{background:var(--accent-soft); border:1px solid #e8d5d5; border-radius:10px; padding:18px 20px; margin:20px 0;}
  .highlight strong{color:var(--accent);}
  table{width:100%; border-collapse:collapse; background:var(--card); font-size:14px; margin:16px 0; border:1px solid var(--line);}
  th{background:#2d3340; color:#fff; padding:10px 12px; text-align:left; font-weight:600; white-space:nowrap;}
  td{padding:10px 12px; border-top:1px solid var(--line); vertical-align:top;}
  tr:nth-child(even) td{background:#fafbfc;}
  a{color:#1d5fa8; text-decoration:none; border-bottom:1px dotted #9ab6d6;}
  a:hover{color:var(--accent); border-bottom-color:var(--accent);}
  .badge{display:inline-block; padding:2px 8px; border-radius:20px; font-size:12px; font-weight:700; white-space:nowrap;}
  .b-A{background:#e3f0fb; color:#1d5fa8; border:1px solid #b9d4ee;}
  .b-B{background:#e6f2e6; color:#2c6e2f; border:1px solid #bcd9bd;}
  .b-C{background:#fff3df; color:#9a6b15; border:1px solid #ead9b0;}
  .b-D{background:#fbe7e7; color:#a33333; border:1px solid #e6bcbc;}
  code{background:#eef0f4; padding:2px 6px; border-radius:4px; font-size:13px; font-family:Consolas,Menlo,monospace;}
  .note{background:#fff8e6; border:1px solid #eadfb8; border-radius:10px; padding:14px 18px; margin:16px 0; font-size:14px;}
  ul.src{columns:1; padding-left:20px; font-size:14px;}
  ul.src li{margin:6px 0;}
  .small{font-size:13px; color:var(--sub);}
  footer{margin-top:48px; padding-top:16px; border-top:1px solid var(--line); font-size:12px; color:var(--sub);}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>{{제목}} — 자료 발굴 보고</h1>
  <div class="meta">작성일: {{작성일}} · 대상 시기: {{대상시기}} · 대상 아카이브: {{아카이브 목록}}</div>
</header>
<div class="highlight">
  <p><strong>핵심 발굴</strong> — {{가장 중요한 발굴 1건: 식별자·원제·경위·구성·연구사적 의의 요약}}</p>
</div>
<h2>1. 발굴 문서 목록 (문서 사료)</h2>
<table>
  <thead><tr><th>#</th><th>식별자 · 원제</th><th>연대</th><th>소장처 / 청구정보</th><th>관련 내용</th><th>바로가기</th><th>권리초판</th></tr></thead>
  <tbody>
    <tr>
      <td>1</td>
      <td><strong>{{원제}}</strong><br><span class="small">{{생산기관·시리즈}}</span></td>
      <td>{{연대}}</td>
      <td>{{소장처}} <strong>{{RG/참조코드}}</strong>{{, Entry·Box}}</td>
      <td>{{한국 관련 핵심 내용}}</td>
      <td><a href="{{원문URL}}" target="_blank">원문</a><br><a href="{{해제URL}}" target="_blank">해제</a><br><a href="{{카탈로그검색URL}}" target="_blank">카탈로그 검색</a></td>
      <td><span class="badge b-B">B · PD 추정</span></td>
    </tr>
    <!-- 행 반복 -->
  </tbody>
</table>
<h2>2. 사진 · 영상 사료</h2>
<!-- 없으면 이 절 삭제 -->
<table>
  <thead><tr><th>#</th><th>식별자</th><th>연대</th><th>촬영자/생산자</th><th>내용</th><th>바로가기</th><th>권리초판</th></tr></thead>
  <tbody>
    <tr><td>P1</td><td><strong>{{111-SC-000000}}</strong><br><span class="small">{{소장처·RG}}</span></td><td>{{연대}}</td><td>{{촬영자}}</td><td>{{내용}}</td><td><a href="{{URL}}" target="_blank">{{링크명}}</a></td><td><span class="badge b-B">B</span></td></tr>
  </tbody>
</table>
<h2>3. 재현용 검색 쿼리</h2>
<p>{{카탈로그명·링크}}에서 아래 쿼리로 재현할 수 있습니다. 전전(戰前) 자료 표기 규칙상
<code>Korea</code> 외에 <code>Chosen</code> · <code>Corea</code> 등 당대 표기를 병렬 투입하십시오.</p>
<table>
  <thead><tr><th>목적</th><th>쿼리</th><th>실행 링크</th></tr></thead>
  <tbody>
    <tr><td>{{목적}}</td><td><code>{{쿼리}}</code></td><td><a href="{{URL인코딩된 검색URL}}" target="_blank">검색 실행</a></td></tr>
  </tbody>
</table>
<div class="note">
  <strong>⚠ 0건 ≠ 부재.</strong> {{미전산화 상황 + 인접 상자(Box ±2)·피스(참조코드 ±15) 추가 조사 권고 + 현지 열람·복사 대행 안내}}
</div>
<h2>4. 종합 색인 · 최신 연구</h2>
<ul class="src">
  <li><a href="{{URL}}" target="_blank">{{색인·연구 제목}}</a> — {{한 줄 설명}}</li>
</ul>
<h2>5. 권리 등급 판정 (초판)</h2>
<p>{{판정 요약 + 법적 근거(17 U.S.C. §105, 36 CFR 1254.62, Crown/OGL, domaine public)}}.
자동 초판이므로 <strong>출판 전 인간 최종 확인 필수</strong>이며, <span class="badge b-D">D등급</span>은 공개 금지입니다.
{{민감 주제인 경우 피해자 존엄·윤리적 사용 기준 문구}}</p>
<footer>
  발굴 방법론: 해외 아카이브 한국 기록 발굴 스킬(표기 변형 병렬 투입 · RG 교차 검색 · 인접 확장 · 권리 초판 판정) 기반 ·
  본 보고서의 모든 링크는 {{확인일}} 기준 접속 확인됨.
</footer>
</div>
</body>
</html>`;

export { handler as GET, handler as POST, handler as DELETE };
