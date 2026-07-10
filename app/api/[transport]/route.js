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

const gtext = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};
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

  server.tool('report_template',
    'Get the HTML report skeleton + 11 writing rules to render finished discovery results as a styled archival report. Call this as the FINAL step of an investigation, fill the {{placeholders}} with verified findings only, and save as [topic]_records_[years].html. 발굴 조사 마무리 단계에서 호출 — HTML 발굴 보고서 골격과 작성 규칙 반환.',
    {},
    async () => text(REPORT_RULES + '\n\n===== HTML TEMPLATE (fill the {{placeholders}}) =====\n' + REPORT_TEMPLATE));

  server.tool('nedb_search',
    "Search 국사편찬위 한국사데이터베이스 (db.history.go.kr) — 11M+ Korean primary sources (Joseon sillok, colonial-era, independence movement, modern newspapers). The site renders results with JavaScript, so plain HTTP returns an empty list — robots allows it, so scrape with cheliped-skills. db: limit to a specific DB id (e.g. 'sillok','jsseung'). 한자·한글 병행 표기 권장.",
    { query: z.string(), db: z.string().default(''), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, db, max_results }) => {
      const p = new URLSearchParams({ searchKeyword: query, searchKeywordType: 'BI', pageSize: String(Math.min(max_results, 50)) });
      if (db) p.set('itemId', db);
      const url = 'https://db.history.go.kr/search/searchResultList.do?' + p.toString();
      let hint = '';
      try { const html = await gtext(url); const m = html.match(/([\d,]{1,12})\s*건/); hint = m ? `직접 조회 약 ${m[1]}건 감지. ` : '직접 조회는 빈 목록(JS 렌더 확인). '; }
      catch (e) { hint = `(직접 조회 실패: ${e.message}) `; }
      return text(`한국사DB '${query}'${db ? ' · DB=' + db : ''}\n브라우저 열기: ${url}\n${hint}JS 렌더 사이트이므로 목록·본문은 브라우저 스크래핑으로 추출:\n${CHELIPED_INSTALL}\n실행: ${chelipedCmd(url)}\n팁: observe가 부여한 번호 id로 상세(level.do) 진입·다음페이지 클릭. 인명·기관명은 한자 원표기가 색인 정확도 높음.`);
    });

  server.tool('archives_search',
    "Search 국가기록원 국가기록포털 (archives.go.kr) via its official OpenAPI (search.archives.go.kr/openapi/search.arc, RSS). Needs a free key from data.go.kr '나라기록물정보 서비스' (15000153) set as ARCHIVES_API_KEY; without it, returns browser-open URL + cheliped scrape command. 일 1,000건 제한.",
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(10) },
    async ({ query, max_results }) => {
      const key = process.env.ARCHIVES_API_KEY;
      const portal = 'https://www.archives.go.kr/next/newsearch/listSubjectDescription.do?query=' + encodeURIComponent(query);
      if (!key) return text(`국가기록원 '${query}'\n인증키 미설정 — data.go.kr '나라기록물정보 서비스'(15000153) 무료 신청 후 ARCHIVES_API_KEY로 설정하면 OpenAPI 자동 검색.\n브라우저 열기: ${portal}\n${CHELIPED_INSTALL}\n실행: ${chelipedCmd(portal)}`);
      const api = `https://search.archives.go.kr/openapi/search.arc?serviceKey=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&start=1&limit=${Math.min(max_results, 50)}`;
      let xml;
      try { xml = await gtext(api); } catch (e) { return text(`국가기록원 API 오류: ${e.message}\n브라우저 열기: ${portal}`); }
      if (xml.includes('searchError')) return text(`국가기록원 API 오류: ${xtag(xml, 'message') || '알 수 없음'}\n인증키·일일 쿼터(1,000건) 확인.`);
      const tot = xtag(xml, 'totalCount') || xtag(xml, 'totalResults') || '?';
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      const lines = items.slice(0, max_results).map((b) => `- ${xtag(b, 'title').slice(0, 90)} (${xtag(b, 'produceYear') || xtag(b, 'pubDate').slice(0, 16)}) ${xtag(b, 'link')}`);
      return text(`국가기록원 '${query}' — 총 ${tot}건:\n` + (lines.join('\n') || '(0건)') + '\n※ 노획문서·생산기관 코드는 상세 확인. 저작권은 공공누리(KOGL) 유형 확인 후 이용.');
    });

  server.tool('scrape_plan',
    'Check a URL\'s robots.txt and return whether direct scraping is allowed; for robots-blocked or JS-rendered sites, return a ready-to-run cheliped-skills (CDP browser) command. Fallback path for archives with no API. robots 차단·JS 렌더 사이트의 cheliped 스크래핑 폴백.',
    { url: z.string() },
    async ({ url }) => {
      const u = new URL(url); const root = `${u.protocol}//${u.host}`; const path = u.pathname || '/';
      let verdict = 'robots 미확인';
      try {
        const rb = await gtext(root + '/robots.txt'); let blocked = false, agentAll = false;
        for (const line of rb.split('\n')) {
          const s = line.trim().toLowerCase();
          if (s.startsWith('user-agent:')) agentAll = s.includes('*');
          else if (agentAll && s.startsWith('disallow:')) { const d = s.split(':')[1].trim(); if (d && path.startsWith(d)) blocked = true; }
        }
        verdict = blocked ? 'robots 차단됨 → 브라우저 스크래핑 사용' : 'robots 허용(단 JS 렌더면 브라우저 필요)';
      } catch (e) { verdict = `robots 미확인(${e.message}) → 브라우저 스크래핑 안전`; }
      return text(`${url}\n판정: ${verdict}\n${CHELIPED_INSTALL}\n실행: ${chelipedCmd(url)}\n다단계: goto→observe로 요소 번호 확인 후 click/fill/scrape로 목록·상세·페이지네이션 처리.`);
    });

  server.tool('nlk_search',
    "Search 국립중앙도서관 (nl.go.kr) digital collections. collection: 'total'(전체 소장자료) · 'subject'(주제별컬렉션) · 'newspaper'(대한민국신문아카이브 1883-1960 old newspapers, copyright-expired free use) · 'gwanbo'(관보) · 'exhibit'(전시컬렉션) · 'koreanmemory'(코리안메모리) · 'overseas'(해외 한국관련자료). Unified OpenAPI (search.do) is used for total/subject/gwanbo/overseas when NLK_API_KEY is set (apply at www.nl.go.kr); otherwise returns browser-open URL + cheliped scrape command. 국립중앙도서관 6개 컬렉션.",
    { query: z.string(), collection: z.enum(['total', 'subject', 'newspaper', 'gwanbo', 'exhibit', 'koreanmemory', 'overseas']).default('total'), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, collection, max_results }) => {
      const COLL = {
        total: ['전체 소장자료', 'https://www.nl.go.kr/NL/contents/search.do?srchTarget=total&kwd=', true],
        subject: ['주제별컬렉션', 'https://www.nl.go.kr/NL/contents/N20103000000.do', true],
        newspaper: ['대한민국신문아카이브', 'https://www.nl.go.kr/newspaper/search_list.do?keyword=', false],
        gwanbo: ['관보', 'https://www.nl.go.kr/NL/contents/N20301000000.do', true],
        exhibit: ['전시컬렉션(온라인전시)', 'https://www.nl.go.kr/NL/contents/N20104000000.do', false],
        koreanmemory: ['코리안메모리', 'https://nl.go.kr/koreanmemory/', false],
        overseas: ['해외 한국관련자료', 'https://www.nl.go.kr/NL/contents/N20401010000.do', true],
      };
      const NOTE = {
        newspaper: '1883–1960 고신문 108종(기사 868만). 저작권 만료 — 출처(국립중앙도서관) 표기 시 자유이용.',
        koreanmemory: '구술·사진 큐레이션 아카이브 — 주제 브라우징에 적합.',
        exhibit: '온라인 전시(서사형) — 전시 목록 브라우징 권장.',
        overseas: '해외 소재 한국 관련 자료 — 소장기관·마이크로필름 정보 확인.',
        gwanbo: '대한제국·조선총독부·대한민국 관보 원문 — 법령·서임·고시 1차 사료.',
        subject: '국립중앙도서관 주제별 선별 디지털 컬렉션.',
        total: '전체 소장자료(단행본·고서·학위논문·디지털화 자료 등).',
      };
      const [name, base, apiOk] = COLL[collection];
      const openUrl = (base.endsWith('kwd=') || base.endsWith('keyword=')) ? base + encodeURIComponent(query) : base;
      const note = NOTE[collection] || '';
      const key = process.env.NLK_API_KEY;
      if (apiOk && key) {
        const api = `https://www.nl.go.kr/NL/search/openApi/search.do?key=${encodeURIComponent(key)}&apiType=xml&srchTarget=total&kwd=${encodeURIComponent(query)}&pageSize=${Math.min(max_results, 50)}&pageNum=1`;
        let xml = '';
        try { xml = await gtext(api); } catch (e) { xml = ''; }
        if (xml && !xml.includes('<error>')) {
          const tot = xtag(xml, 'total') || '?';
          const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
          const lines = items.slice(0, max_results).map((b) => `- ${xtag(b, 'titleInfo').slice(0, 90)} / ${xtag(b, 'authorInfo').slice(0, 24)} (${xtag(b, 'pubYearInfo')}) [${xtag(b, 'typeName').slice(0, 14)}] ${xtag(b, 'detailLink')}`);
          return text(`국립중앙도서관 · ${name} '${query}' — 총 ${tot}건:\n` + (lines.join('\n') || '(0건)') + `\n※ ${note}`);
        }
        if (xml.includes('<error>')) return text(`NLK OpenAPI 오류: ${xtag(xml, 'msg') || '알 수 없음'} — NLK_API_KEY 확인.\n브라우저 열기: ${openUrl}`);
      }
      const keyed = (apiOk && !key) ? '인증키 미설정 — www.nl.go.kr Open API 신청 후 NLK_API_KEY 설정 시 자동 검색. ' : '';
      return text(`국립중앙도서관 · ${name} '${query}'\n${keyed}브라우저 열기: ${openUrl}\n※ ${note}\n${CHELIPED_INSTALL}\n실행: ${chelipedCmd(openUrl)}`);
    });

  server.tool('foia_search',
    "Search 대한민국 정보공개포털 (open.go.kr) — 원문정보공개 (full-text of released government decision documents), 사전정보공표, and FOIA request cases. Login/JS portal with no keyless API, so returns the browser-open URL + a 2-step cheliped scrape command (fill search box → scrape list). Unreleased documents can be requested via 정보공개청구. 정보공개포털 검색.",
    { query: z.string() },
    async ({ query }) => {
      const url = 'https://www.open.go.kr/com/main/mainView.do';
      return text(`정보공개포털 '${query}'\n브라우저 열기: ${url}\n※ 원문정보공개=정부 결재문서 원문 전문검색 · 사전정보공표 · 정보공개청구 사례. 미공개 문서는 포털에서 정보공개청구로 요청 가능.\n${chelipedSearch(url, query)}`);
    });

  server.tool('seoul_archives_search',
    "Search 서울기록원 (archives.seoul.go.kr) — Seoul Metropolitan Archives: municipal administrative records, city photos, oral histories, mayoral documents. The catalog is JS-rendered, so returns the full-text search URL (search_api_fulltext) + a cheliped scrape command. Essential local-archives cross-source for regional history. 서울기록원 카탈로그 검색.",
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, max_results }) => {
      const url = 'https://archives.seoul.go.kr/catalog?search_api_fulltext=' + encodeURIComponent(query);
      let hint = '';
      try { const html = await gtext(url); const m = html.match(/([\d,]{1,9})\s*건/); hint = m ? `약 ${m[1]}건 감지. ` : '직접 조회는 빈 목록(JS 렌더 확인). '; }
      catch (e) { hint = `(직접 조회 실패: ${e.message}) `; }
      return text(`서울기록원 '${query}'\n브라우저 열기: ${url}\n${hint}JS 렌더 카탈로그이므로 목록·상세는 브라우저 스크래핑으로 추출:\n${CHELIPED_INSTALL}\n실행: ${chelipedCmd(url)}\n※ 지방기록물 저작권은 공공누리(KOGL) 유형 확인 후 이용.`);
    });

  server.tool('local_gov_search',
    "Search Korean local-government FOIA / archives. source: 'seoul_opengov' (서울정보소통광장 — Seoul city decision documents full-text, 2014+), 'sen' (서울시교육청 정보공개 '열린 서울교육' — Seoul education office released documents), 'gyeongnam' (경상남도기록원 — first provincial archive, local records/oral history). All are JS portals with no keyless API, so returns browser-open URL + cheliped scrape command. Decision-document originals are primary sources for local/incident history. 지방 정보공개·기록원 라우팅.",
    { query: z.string(), source: z.enum(['seoul_opengov', 'sen', 'gyeongnam']) },
    async ({ query, source }) => {
      const SRC = {
        seoul_opengov: ['서울정보소통광장(결재문서 원문공개)', 'https://opengov.seoul.go.kr/sanction/list?srch_all=', '서울시 결재문서 원문 전문공개(2014~). 부서·기간 필터 가능. 저작권 공공누리 확인.'],
        sen: ['서울시교육청 정보공개(열린 서울교육)', 'https://open.sen.go.kr/', '서울교육청 원문정보공개 결재문서(2014~)·사전정보공표. 미공개분은 정보공개청구.'],
        gyeongnam: ['경상남도기록원', 'https://archives.gyeongnam.go.kr/main.web', '국내 최초 광역 지방기록원 — 경남도정 기록·구술·행정박물. 지역사 발굴 핵심.'],
      };
      const [name, base, note] = SRC[source];
      let url, cmd;
      if (base.endsWith('=')) { url = base + encodeURIComponent(query); cmd = `실행: ${chelipedCmd(url)}`; }
      else { url = base; cmd = chelipedSearch(url, query); }
      return text(`${name} '${query}'\n브라우저 열기: ${url}\n※ ${note}\n${cmd}`);
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
