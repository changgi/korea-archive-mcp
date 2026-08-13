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

// ── 다국어 주제 사전 → 색인 언어 자동 변환 ──
// 각 아카이브는 자기 색인 언어로만 검색된다(TNA·NARA·IA·Europeana=영어, Gallica=프랑스어).
// 한국어·일본어·중국어·러시아어·스페인어·독일어·베트남어·힌디어·히브리어·아랍어·카자흐어·
// 몽골어 등 어떤 언어로 질의해도, 주제 사전이 해당 주제를 인식해 대상 색인 언어로 변환한다.
// 출력에는 당대 표기(Corea·Chosen·Quelpart·Fusan 등 historical spellings)를 병용한다.
// 실측 근거: IA 장진호 1건 vs "Chosin Reservoir" 139건, Gallica 병인양요 0 vs 5,853건.
// 각 항목: p=매칭 패턴(전 언어 병렬), en=영어 출력, fr=프랑스어 출력(없으면 en 사용).
const TOPICS = [
  { p: '인천\\s?상륙\\s?작전|인천\\s?상륙|仁川上陸|仁川登陆|Инчхонская десантная', en: 'Inchon landing' },
  { p: '장진호|長津湖|长津湖', en: 'Chosin Reservoir' },
  { p: '흥남\\s?철수|흥남|興南', en: 'Hungnam evacuation' },
  { p: '백마고지|白馬高地|白马高地', en: 'White Horse Hill Korea' },
  { p: '단장의\\s?능선', en: 'Heartbreak Ridge' },
  { p: '펀치볼', en: 'Punchbowl Korea' },
  { p: '임진강|臨津江|临津江', en: 'Imjin River' },
  { p: '그로스터|글로스터', en: 'Gloucestershire Regiment Korea' },
  { p: '거제도|巨濟島|巨济岛', en: 'Koje Island' },
  { p: '판문점|板門店|板门店|Пханмунджом', en: 'Panmunjom' },
  { p: '38\\s?선|삼팔선|三八線|三八线', en: '38th parallel Korea' },
  { p: '휴전\\s?협정|정전\\s?협정|휴전|정전|停戦|停战|休戰|перемирие|armisticio|Waffenstillstand', en: 'Korea armistice' },
  { p: '포로|捕虜|战俘|военнопленн\\w*', en: 'prisoners of war Korea' },
  { p: '노획', en: 'captured Korea' },
  { p: '병인양요|丙寅洋擾|병인박해', en: 'French expedition Korea 1866', fr: 'expédition de Corée 1866' },
  { p: '신미양요|辛未洋擾', en: 'United States expedition Korea 1871', fr: 'Corée expédition américaine 1871' },
  { p: '강화도|江華島|江华岛|강화', en: 'Kanghwa', fr: 'île Kanghoa' },
  { p: '파리\\s?외방전교회', en: 'Paris Foreign Missions Korea', fr: 'Missions étrangères de Paris' },
  { p: '선교사|宣教師|宣教师|传教士|missionnaires?|misioneros|Missionare|миссионер\\w*', en: 'missionaries Korea', fr: 'missionnaires' },
  { p: '천주교|가톨릭|카톨릭|순교', en: 'Catholic Korea martyrs', fr: 'catholique Corée' },
  { p: '한국전쟁|6[·.]25|조선전쟁|朝鮮戦争|朝鲜战争|朝鮮戰爭|抗美援朝|Корейская война|Корей соғысы|Солонгосын дайн|Chiến tranh Triều Tiên|कोरियाई युद्ध|מלחמת קוריאה|الحرب الكورية|Koreakrieg|Guerra de Corea|Guerra da Coreia|Guerre de Corée', en: 'Korean War', fr: 'guerre de Corée' },
  { p: '러일전쟁|日露戦争|日俄战争', en: 'Russo-Japanese War Korea', fr: 'guerre russo-japonaise' },
  { p: '청일전쟁|日清戦争|甲午战争', en: 'Sino-Japanese War Korea 1894' },
  { p: '일제\\s?강점기|조선총독부|朝鮮總督府|朝鮮総督府|植民地朝鮮', en: 'Chosen Japan colonial' },
  { p: '대한제국|大韓帝國|大韓帝国', en: 'Korean Empire Corea', fr: 'Empire de Corée' },
  { p: '맥아더|マッカーサー|麦克阿瑟|Макартур', en: 'MacArthur' },
  { p: '이승만|李承晩|李承晚', en: 'Syngman Rhee' },
  { p: '김일성|金日成', en: 'Kim Il Sung' },
  { p: '압록강|鴨綠江|鸭绿江', en: 'Yalu' },
  { p: '낙동강|洛東江|洛东江', en: 'Naktong' },
  { p: '서울|한양|ソウル|首爾|首尔|漢城|汉城|Сеул|Seúl', en: 'Seoul', fr: 'Séoul' },
  { p: '부산|釜山|Пусан', en: 'Pusan', fr: 'Fusan' },
  { p: '평양|平壌|平壤|Пхеньян', en: 'Pyongyang' },
  { p: '인천|제물포|仁川', en: 'Inchon', fr: 'Chemulpo' },
  { p: '제주|濟州|济州|Чеджу', en: 'Cheju Quelpart', fr: 'Quelpaert' },
  { p: '해방|解放', en: 'Korea liberation 1945', fr: 'Corée libération 1945' },
  { p: '영상|필름|映像|フィルム|视频|кинохроника', en: 'film' },
  { p: '사진|寫真|写真|照片|фотографи\\w*', en: 'photograph', fr: 'photographie' },
  { p: '지도|地圖|地图|карт[аы]\\w*', en: 'map', fr: 'carte' },
  { p: '신문|新聞|新闻|газет\\w*', en: 'newspaper', fr: 'journal' },
  { p: '전투|戦闘|战斗|битва|сражение', en: 'battle', fr: 'bataille' },
  // 총칭(각 언어의 '한국/조선') — 구체 주제를 먼저 치환한 뒤 남은 표기를 마지막에 처리.
  // Corea·Coreia 등 라틴 표기는 넣지 않는다: 당대 표기 변형 검색(tna_search "Corea" 등)이 Korea로 강제 치환되면 방법론이 무력화됨. 악상 있는 Corée만 프랑스어 확정으로 사상.
  { p: '조선|한국|고려|朝鮮|韓國|韩国|朝鲜|Корея|Коре[еию]|Corée|كوريا|קוריאה|कोरिया|Hàn Quốc|Triều Tiên|Солонгос|Корей', en: 'Korea', fr: 'Corée' },
  { p: '기록|자료|문서|관련|찾아줘|記録|資料|文書|档案|документ\\w*|материал\\w*', en: ' ', fr: ' ' },
];
const TOPIC_RE = TOPICS.map((t) => ({ ...t, re: new RegExp(t.p, 'giu') }));
// 라틴 확장(악상 포함) 밖의 문자 = 대상 색인이 못 읽는 스크립트(한글·CJK·가나·키릴·아랍·히브리·데바나가리…)
const NON_LATIN = /[^\u0000-ɏ]+/gu;
const EN_ANCHOR = /korea|corea|chosen|chosin|seoul|pusan|inchon|hungnam|panmunjom|imjin|koje|yalu|naktong|kanghwa|pyongyang|macarthur|rhee|kim il/i;
const FR_ANCHOR = /cor[ée]e|séoul|fusan|chemulpo|quelpaert|kanghoa|missionnaires|tchosen/i;
function toIndexLang(q, lang) {
  let f = q;
  for (const t of TOPIC_RE) f = f.replace(t.re, ' ' + (lang === 'fr' ? (t.fr || t.en) : t.en) + ' ');
  const changed = f !== q;
  const foreign = NON_LATIN.test(f); NON_LATIN.lastIndex = 0;
  if (!changed && !foreign) return null;   // 이미 대상 언어(라틴) 질의 — 손대지 않음
  f = f.replace(NON_LATIN, ' ').replace(/\(\s*\)|\[\s*\]|"\s*"/g, ' ').replace(/\s+/g, ' ').trim();
  const anchor = lang === 'fr' ? FR_ANCHOR : EN_ANCHOR;
  if (!anchor.test(f)) f = ((lang === 'fr' ? 'Corée ' : 'Korea ') + f).trim();
  return f || (lang === 'fr' ? 'Corée' : 'Korea');
}
const koToEn = (q) => toIndexLang(q, 'en');
const gallicaKoToFr = (q) => toIndexLang(q, 'fr');

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
    q = koToEn(q) || q;
    const query = /^[A-Z]+ \d+\/\d+$/.test(q.trim()) ? `"${q.trim()}"` : q;
    const d = await tnaFetch(query, n);
    return (d.records || []).map((r) => ({ title: r.title || r.description, date: r.coveringDates || '', id: r.reference || '', url: `https://discovery.nationalarchives.gov.uk/details/r/${r.id}` }));
  },
  ia: async (q, n) => {
    q = koToEn(q) || q;
    const d = await jget(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=date&rows=${n}&output=json`);
    return ((d.response || {}).docs || []).map((x) => ({ title: String(x.title || ''), date: x.date || '', id: x.identifier, url: `https://archive.org/details/${x.identifier}` }));
  },
  gallica: async (q, n) => {
    q = gallicaKoToFr(q) || q;
    const query = encodeURIComponent(`gallica all "${q.replace(/"/g, '')}"`);
    const r = await robustFetch(`https://gallica.bnf.fr/SRU?operation=searchRetrieve&version=1.2&query=${query}&maximumRecords=${n}`);
    const xml = await r.text();
    return xml.split('<srw:record>').slice(1, n + 1).map((b) => {
      const g = (t) => { const m = b.match(new RegExp(`<dc:${t}[^>]*>([^<]*)<`)); return m ? m[1].trim() : ''; };
      return { title: g('title'), date: g('date'), id: g('identifier'), url: g('identifier') };
    });
  },
  europeana: async (q, n) => {
    q = koToEn(q) || q;
    const key = process.env.EUROPEANA_API_KEY || 'api2demo';
    const d = await jget(`https://api.europeana.eu/record/v2/search.json?wskey=${key}&query=${encodeURIComponent(q)}&rows=${n}&profile=standard`);
    return (d.items || []).map((it) => ({ title: (it.title || ['?'])[0], date: (it.year || [''])[0], id: it.id || '', url: it.guid || '' }));
  },
  nara: async (q, n) => {
    q = koToEn(q) || q;
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
  koreanwar: async (q, n) => (await kwSearch({ keyword: q, viewType: 'archive' })).cards.slice(0, n).map((c) => ({ title: c.title, date: '', id: c.id, url: c.url })),
};

// ══════════ KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 (koreanwar.or.kr:8443 — 전쟁기념관재단, 협약기관) ══════════
// MOU partner: identify this program in every request (courtesy UA) and keep call volume polite
// (robots.txt 404 = no directive; OpenAPI terms forbid bulk crawling — we page-scan modestly).
const KW_BASE = 'https://www.koreanwar.or.kr:8443';
const KW_UA = { 'User-Agent': 'KoreaArchiveMCP/1.11 (+https://github.com/changgi/korea-archive-mcp; MOU partner integration)' };
const kwClean = (s) => norm(String(s || '')).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
// result cards on /search.do — archive items (archRfcd) and book items (bookId); meta rows carry
// 생산기관/생산자 and the full provenance breadcrumb (상위계층) incl. "Record Group N" for NARA re-collections.
function kwParseCards(html) {
  const cards = [];
  for (const b of html.split('result-card__body').slice(1)) {
    const m = b.match(/href="\/(searchDetail(?:-book)?\.do)\?(archRfcd|bookId)=([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const meta = {}; const re = /<span class="tit">([^<]+)<\/span>\s*<span class="txt">([\s\S]*?)<\/span>/g; let mm;
    while ((mm = re.exec(b))) meta[kwClean(mm[1])] = kwClean(mm[2]);
    const rg = (meta['상위계층'] || '').match(/Record Group (\d+)/);
    cards.push({ title: kwClean(m[4]), id: m[2] === 'archRfcd' ? m[3] : `book:${m[3]}`, url: `${KW_BASE}/${m[1]}?${m[2]}=${encodeURIComponent(m[3])}`, producer: meta['생산기관/생산자'] || '', hierarchy: meta['상위계층'] || '', rg: rg ? rg[1] : '' });
  }
  return cards;
}
async function kwSearch(params) {
  const u = new URL(KW_BASE + '/search.do');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  const b = await gtext(u.toString(), KW_UA);
  return { total: (b.match(/totalCount">\s*([\d,]+)/) || [])[1] || '?', cards: kwParseCards(b), url: u.toString() };
}
// 수집구분(depth1) 코드 — 상세검색 폼 실측; 서버측 GET 필터로 동작 검증됨(철수 778 → 수집 633 · 기증 104).
const KW_DEPTH1 = { '수집': '00001041', '기증': '00001042', '기타': '00001047', '구입': '00001054', '기탁': '00001073', '제작': '00001125', '이관': '00001179', '차입': '00001410' };
// OpenAPI pbrcList.do — token+IP auth, JSON list (no keyword param) → scan pages, filter client-side.
// Activates the moment KOREANWAR_API_TOKEN is set (application currently pending approval).
async function kwApiScan(q, maxPages) {
  const token = process.env.KOREANWAR_API_TOKEN;
  if (!token) return null;
  const pages = Math.min(maxPages || Number(process.env.KOREANWAR_API_PAGES || 3), 10);
  const ql = q.toLowerCase(); const hits = []; let total = 0, checked = 0;
  for (let p = 1; p <= pages; p++) {
    const d = await jget(`${KW_BASE}/openapi/pbrcList.do?token=${encodeURIComponent(token)}&page=${p}&pageSize=100`, KW_UA);
    if (d.resultCode !== 'OK') throw new Error(`OpenAPI ${d.resultCode}: ${d.resultMsg || ''} — 토큰 미승인이거나 서버 egress IP가 미등록(승인 후 IP 등록 필요)`);
    total = d.totalCount || total;
    const list = d.list || [];
    checked += list.length;
    for (const it of list) {
      if ([it.sj, it.engSj, it.spln, it.stmt].some((f) => f && String(f).toLowerCase().includes(ql)))
        hits.push({ ref: it.archRfcd || '', title: it.sj || it.engSj || '', kogl: it.kogl || '', useCnd: it.useCnd || '', cpyrYn: it.cpyrYn || '', olinYn: it.olinYn || '' });
    }
    if (list.length < 100) break;
    await sleep(200);
  }
  return { total, checked, hits };
}

const handler = createMcpHandler((server) => {
  // ── PlayMCP 개발가이드 준수(2026.06.12) ──
  // · description: PlayMCP 등록 서비스명(KOREA ARCHIVE 통합검색) 병기 + 1024자 이내 보장
  //   ※ 심사 기준: 등록된 서비스명 문자열이 각 도구 description에 그대로 포함되어야 함 (2026-08 반려 사유)
  // · annotations: title·readOnlyHint·destructiveHint·openWorldHint·idempotentHint 전 도구 필수
  //   (모든 도구는 외부 아카이브 read-only 조회 — 파괴적 동작 없음, 결과는 원격 상태에 따라 변동 가능한 open-world)
  // · 도구 수 20개 이하(ia_metadata→ia_search, local_gov→foia, koreanwar 4→2 통합으로 24→20)
  const SVC = ' — KOREA ARCHIVE 통합검색';
  const TITLES = {
    tna_search: 'TNA 영국 국립기록관 검색', tna_adjacent_mine: 'TNA 인접 참조코드 채굴',
    nara_search: 'NARA 미국 국립문서기록관리청 검색', ia_search: 'archive.org 검색·메타데이터',
    gallica_search: 'Gallica 프랑스 국립도서관 검색', europeana_search: 'Europeana 유럽 통합 검색',
    query_bank: '검증 키워드 뱅크', judge_rights: '권리 등급 초판 판정', report_template: 'HTML 발굴 보고서 템플릿',
    nedb_search: '국사편찬위 한국사DB 검색', archives_search: '국가기록원 검색', nlk_search: '국립중앙도서관 검색',
    seoul_archives_search: '서울기록원 검색', warmemo_search: '전쟁기념관 아카이브 검색',
    koreanwar_search: 'KOREAN WAR ARCHIVES(6·25전쟁 아카이브센터) 검색', koreanwar_item: 'KOREAN WAR ARCHIVES(6·25전쟁 아카이브센터) 상세·인접 채굴',
    foia_search: '정보공개포털·지방 정보공개 검색', scrape_plan: 'robots 판정·수집 계획',
    cross_search: '다중 아카이브 동시 교차수집', source_profile: '기관 구조 프로파일',
  };
  const _tool = server.tool.bind(server);
  server.tool = (name, desc, schema, cb) => {
    const max = 1024 - SVC.length;
    const d = (desc.length > max ? desc.slice(0, max - 1) + '…' : desc) + SVC;
    return _tool(name, d, schema,
      { title: TITLES[name] || name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      cb);
  };

  server.tool('tna_search',
    'Search the UK National Archives (TNA) Discovery catalog for Korea-related records. Queries in Korean·Japanese·Chinese·Russian·Spanish·German·Vietnamese·Hindi·Hebrew·Arabic etc. are auto-translated to English index terms (임진강→Imjin River, 長津湖→Chosin Reservoir, Корейская война→Korean War …). Reference codes like "FO 371/84053" are auto-quoted. 영국 국립기록관 검색 — 다국어 질의 자동 영문 변환.',
    { query: z.string().describe('한국어 또는 영어 — e.g. "임진강 전투", "Korea armistice", "FO 371 FK1015"'), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, max_results }) => {
      const en = koToEn(query);
      const eff = en || query;
      const q = /^[A-Z]+ \d+\/\d+$/.test(eff.trim()) ? `"${eff.trim()}"` : eff;
      const d = await tnaFetch(q, max_results);
      const recs = d.records || [];
      return text(`TNA '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''} — total ${d.count ?? '?'}:\n` + (recs.map(tnaLine).join('\n') || '(0 results)'));
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
    'Search the US NARA catalog (API v2). Multilingual queries (한국어·日本語·中文·Русский 등) auto-translate to English index terms (장진호/長津湖→Chosin Reservoir …). Requires NARA_API_KEY env on the server; record_group enables precision cross-search (e.g. 242). 미국 NARA 검색 — 다국어 질의 자동 영문 변환.',
    { query: z.string().describe('한국어 또는 영어'), record_group: z.number().int().optional(), moving_images_only: z.boolean().default(false), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, record_group, moving_images_only, max_results }) => {
      const key = process.env.NARA_API_KEY;
      if (!key) return text('NARA_API_KEY not configured on this server. Free key: email Catalog_API@nara.gov (name + email). Meanwhile use catalog.archives.gov directly.');
      const en = koToEn(query);
      const eff = en || query;
      const u = new URL('https://catalog.archives.gov/api/v2/records/search');
      u.searchParams.set('q', eff); u.searchParams.set('limit', String(max_results)); u.searchParams.set('page', '1');
      if (record_group) u.searchParams.set('recordGroupNumber', String(record_group));
      if (moving_images_only) u.searchParams.set('typeOfMaterials', 'Moving Images');
      const d = await jget(u.toString(), { 'x-api-key': key });
      const hits = ((d.body || {}).hits || {});
      const rows = (hits.hits || []).map((h) => {
        const rec = (h._source || {}).record || {};
        return `- [NAID ${rec.naId}] ${(rec.title || '').slice(0, 100)} | ${rec.localIdentifier || ''} | https://catalog.archives.gov/id/${rec.naId}`;
      });
      const total = typeof hits.total === 'object' ? hits.total.value : hits.total;
      return text(`NARA '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''}${record_group ? ` (RG ${record_group})` : ''} — total ${total}:\n` + (rows.join('\n') || '(0 results)'));
    });

  server.tool('ia_search',
    'Search archive.org (advanced search syntax) — e.g. "identifier:111-adc*", "collection:universal_newsreels AND korea". Multilingual queries (한국어·日本語·中文·Русский 등) auto-translate to English terms. Pass identifier instead to inspect one item: metadata, license, original files with sizes (check before downloading). 다국어 질의 자동 영문 변환.',
    { query: z.string().default('').describe('search query (ignored when identifier is set)'), identifier: z.string().optional().describe('item identifier for metadata inspection'), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, identifier, max_results }) => {
      if (identifier) {
        const d = await jget(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
        const md = d.metadata || {};
        const files = (d.files || []).filter((f) => f.source === 'original').slice(0, 10);
        return text(`Title: ${md.title}\nDate: ${md.date} | License: ${md.licenseurl || md.rights || 'not stated'}\nDescription: ${String(md.description || '').slice(0, 300)}\nOriginal files:\n` + files.map((f) => `- ${f.name} (${(Number(f.size || 0) / 1e6).toFixed(1)}MB)`).join('\n'));
      }
      if (!query) return text('query 또는 identifier 중 하나는 필수.');
      const en = koToEn(query);
      const eff = en || query;
      const u = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(eff)}&fl[]=identifier&fl[]=title&fl[]=date&rows=${max_results}&output=json`;
      const d = await jget(u);
      const docs = ((d.response || {}).docs) || [];
      return text(`archive.org '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''} — total ${(d.response || {}).numFound}:\n` + (docs.map((x) => `- ${x.identifier} | ${String(x.title).slice(0, 90)} | https://archive.org/details/${x.identifier}`).join('\n') || '(0)'));
    });

  server.tool('gallica_search',
    'Search Gallica (Bibliothèque nationale de France, no key needed). Multilingual queries (한국어·日本語·中文 등) auto-translate to French index terms (병인양요→expédition de Corée 1866, 長津湖→Chosin …). French terms also work: Corée, guerre de Corée, missionnaires, Tchosen. 프랑스 국립도서관 검색 — 다국어 질의 자동 프랑스어 변환.',
    { query: z.string().describe('한국어 또는 프랑스어 — e.g. "병인양요 선교사", "Corée missionnaires"'), max_results: z.number().int().min(1).max(30).default(10) },
    async ({ query, max_results }) => {
      const fr = gallicaKoToFr(query);
      const eff = fr || query;
      const q = encodeURIComponent(`gallica all "${eff.replace(/"/g, '')}"`);
      const r = await fetch(`https://gallica.bnf.fr/SRU?operation=searchRetrieve&version=1.2&query=${q}&maximumRecords=${max_results}`, { headers: { 'User-Agent': UA } });
      const xml = await r.text();
      const total = (xml.match(/<srw:numberOfRecords>(\d+)</) || [])[1] || '?';
      const recs = xml.split('<srw:record>').slice(1);
      const g = (block, tag) => { const m = block.match(new RegExp(`<dc:${tag}[^>]*>([^<]*)<`)); return m ? m[1].trim() : ''; };
      const lines = recs.slice(0, max_results).map((b) => `- ${g(b, 'title').slice(0, 100)} (${g(b, 'date')}) [${g(b, 'type')}] ${g(b, 'identifier')}`);
      return text(`Gallica '${query}'${fr ? ` → 프랑스어 자동 변환 '${eff}'` : ''} — total ${total}:\n` + (lines.join('\n') || '(0)') + '\nTip: French variants — Corée·Coréens·Séoul·Fusan·guerre de Corée·Tchosen');
    });

  server.tool('europeana_search',
    'Search Europeana — 4,000+ institutions in 58 countries. Multilingual queries (한국어·日本語·中文 등) auto-translate to English terms. Works out of the box (shared demo key); set EUROPEANA_API_KEY for heavy use. media_type: VIDEO|IMAGE|TEXT|SOUND. 유럽 통합 검색 — 다국어 질의 자동 영문 변환.',
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(15), media_type: z.enum(['VIDEO', 'IMAGE', 'TEXT', 'SOUND']).optional() },
    async ({ query, max_results, media_type }) => {
      const key = process.env.EUROPEANA_API_KEY || 'api2demo';
      const demo = !process.env.EUROPEANA_API_KEY;
      const en = koToEn(query);
      const eff = en || query;
      const u = new URL('https://api.europeana.eu/record/v2/search.json');
      u.searchParams.set('wskey', key); u.searchParams.set('query', eff);
      u.searchParams.set('rows', String(max_results)); u.searchParams.set('profile', 'standard');
      if (media_type) u.searchParams.set('qf', `TYPE:${media_type}`);
      const d = await jget(u.toString());
      const items = d.items || [];
      return text(`Europeana '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''}${media_type ? ` [${media_type}]` : ''} — total ${d.totalResults}:\n` + (items.map((it) => `- ${String((it.title || ['?'])[0]).slice(0, 90)} (${(it.year || [''])[0]}) — ${String((it.dataProvider || [''])[0]).slice(0, 40)} | ${it.guid || ''}`).join('\n') || '(0)') + '\nTip: multilingual — Corée(fr)·Korea-Krieg(de)·Corea(it/es)' + (demo ? '\n(shared demo key in use — for heavy use, set a free EUROPEANA_API_KEY from apis.europeana.eu)' : ''));
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
    'Get the magazine-grade HTML report skeleton + 15 writing rules — editorial journal layout (masthead·standfirst·drop cap·pull quote·record cards), embedded record images with mandatory per-image credits, film-strip frame galleries with timecodes + watch-the-original CTA for video records, per-institution source chips (country flag + official name) and an archives-cited roster. Call as the FINAL step of an investigation, fill {{placeholders}} with verified findings only, save as [topic]_records_[years].html. 발굴 마무리 단계 호출 — 잡지·저널급 HTML 보고서 골격+작성 규칙 반환(실물 이미지·영상 필름스트립·기관별 출처 명시).',
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

  // ── KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 (협약기관 — MOU) : TNA-style structured toolset (PlayMCP 준수: 2 tools) ──
  server.tool('koreanwar_search',
    "Search KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 (koreanwar.or.kr, War Memorial of Korea Foundation — MOU partner): 55,000+ items (documents·maps·photos·films·audio·oral histories). Parses result cards (title, archRfcd persistent ref code, producer, provenance hierarchy) and extracts NARA Record Group for origin tracing via nara_search. Verified server-side filters: year_from/year_to (production year), acquisition (수집구분: 수집·기증·구입·기탁·제작·이관·차입·기타). scope='battle' searches the battle-info DB instead (69 early-war battles — anchor for TNA WO 281 / NARA RG 407 cross-verification). Korean queries recommended (US-origin footage is re-described in Korean). With KOREANWAR_API_TOKEN, an official OpenAPI metadata channel (KOGL rights fields) joins automatically. Full filter code tables: source_profile('koreanwar').",
    { query: z.string().describe('한글 권장 — e.g. "장진호", "흥남철수", "인천상륙"'), scope: z.enum(['archive', 'battle']).default('archive').describe('archive=소장자료 통합검색, battle=전투정보 DB'), page: z.number().int().min(1).default(1), max_results: z.number().int().min(1).max(50).default(10).describe('페이지당 결과 수(=pageSize 10/20/50 자동 매핑)'), year_from: z.number().int().optional().describe('생산연도 시작 e.g. 1950'), year_to: z.number().int().optional().describe('생산연도 끝 e.g. 1951'), acquisition: z.enum(['수집', '기증', '기타', '구입', '기탁', '제작', '이관', '차입']).optional().describe('수집구분(depth1) 필터') },
    async ({ query, scope, page, max_results, year_from, year_to, acquisition }) => {
      if (scope === 'battle') {
        const listUrl = KW_BASE + '/warList.do';
        try {
          const b = await gtext(listUrl, KW_UA);
          const cards = [];
          for (const blk of b.split('/warDetail.do?warIdx=').slice(1)) {
            const idx = (blk.match(/^(\d+)/) || [])[1]; if (!idx) continue;
            const name = kwClean((blk.match(/<span class="text">([\s\S]*?)<\/span>/) || [, ''])[1]);
            const meta = [...blk.slice(0, 2500).matchAll(/<dt>([\s\S]{1,30}?)<\/dt>\s*<dd>([\s\S]{0,120}?)<\/dd>/g)].map((x) => `${kwClean(x[1])}:${kwClean(x[2])}`);
            cards.push({ idx, name, metaText: meta.join(' · ') });
          }
          const t = query.trim();
          const matched = t ? cards.filter((c) => (c.name + ' ' + c.metaText).includes(t)) : cards;
          const lines = matched.slice(0, 25).map((c) => `- [warIdx ${c.idx}] ${c.name || '?'}${c.metaText ? ' | ' + c.metaText : ''}\n  ${KW_BASE}/warDetail.do?warIdx=${c.idx}`);
          if (lines.length) return text(`6·25 전투정보 '${t || '(전체)'}' — ${matched.length}/${cards.length}건:\n` + lines.join('\n') + '\n※ 전투명·시기·장소를 앵커로 TNA WO 281·NARA RG 407·koreanwar_search(scope=archive)와 교차. DB는 개전 초기(1950.6.25~9.14) 단계 수록(확장 중).');
          return text(`6·25 전투정보 '${t}' — 0건 (전체 ${cards.length}건 중). 현재 DB는 개전 초기(1950.6.25~9.14) 전투만 수록 — 이후 시기(백마고지 1952 등)는 미수록. scope=archive로 자료 검색은 가능.` + dbrowse(listUrl));
        } catch (e) { return text(agentBrowse('6·25 전투정보', query, listUrl, `자동조회 실패(${e.message})`)); }
      }
      const pageSize = max_results > 20 ? 50 : (max_results > 10 ? 20 : 10);
      const params = { keyword: query, viewType: 'archive', page, pageSize };
      if (year_from || year_to || acquisition) {
        params.detailYn = 'Y';
        if (year_from) params.detailPrdcBegnYYYY = year_from;
        if (year_to) params.detailPrdcEdYYYY = year_to;
        if (acquisition) params.depth1 = KW_DEPTH1[acquisition];
      }
      try {
        const [r, api] = await Promise.all([
          kwSearch(params),
          kwApiScan(query).catch((e) => ({ error: e.message })),
        ]);
        const lines = r.cards.slice(0, max_results).map((c) =>
          `- [${c.id}] ${c.title.slice(0, 95)}\n  ${c.producer ? '생산: ' + c.producer.slice(0, 70) + ' | ' : ''}${c.hierarchy ? '계층: ' + c.hierarchy.slice(0, 90) : ''}${c.rg ? `\n  ↔ NARA RG ${c.rg} — nara_search(record_group=${c.rg})로 원본 역추적 가능` : ''}\n  ${c.url}`);
        const tags = [year_from || year_to ? `생산 ${year_from || ''}~${year_to || ''}` : '', acquisition ? `수집구분 ${acquisition}` : ''].filter(Boolean);
        let out = `6·25전쟁 아카이브센터 '${query}'${tags.length ? ` [${tags.join(' · ')}]` : ''} — 총 ${r.total}건 (p.${page}, ${pageSize}건/페이지):\n` + (lines.join('\n') || '(0건 — 한글/한자/영문 표기 변형 시도)');
        if (api && api.hits) {
          out += `\n\n[② OpenAPI 공식 메타 채널 — ${api.checked}건 스캔 중 ${api.hits.length}건 매칭 (전체 ${api.total}건)]`
            + (api.hits.slice(0, max_results).map((h) => `\n- [${h.ref}] ${String(h.title).slice(0, 80)} | 공공누리:${h.kogl || '-'} · 이용조건:${h.useCnd || '-'} · 저작권:${h.cpyrYn || '-'} · 원문온라인:${h.olinYn || '-'}`).join('') || '\n(매칭 없음 — 스캔 페이지 내 한정)');
        } else if (api && api.error) {
          out += `\n※ OpenAPI 채널 오류: ${api.error}`;
        } else {
          out += '\n※ OpenAPI(공식 메타·KOGL 권리정보 채널)는 토큰 승인 후 KOREANWAR_API_TOKEN 설정 시 자동 병행 활성 (현재 신청·승인 대기 상태여도 이 검색은 정상 동작).';
        }
        return text(out + `\n협약기관 — 출처 표기 필수: KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터(전쟁기념관재단). 건별 메타·인접 채굴: koreanwar_item.`
          + `\n도서자료 포함 전체·상세검색폼(계층 depth·자료유형·입수처 등 추가 필터는 브라우저에서): ${KW_BASE}/search.do?detailYn=Y&keyword=${encodeURIComponent(query)}`);
      } catch (e) { return text(agentBrowse('6·25전쟁 아카이브센터', query, `${KW_BASE}/search.do?keyword=${encodeURIComponent(query)}`, `자동조회 실패(${e.message})`)); }
    });

  const kwItemTitle = (b) => [...b.matchAll(/<h2[^>]*>([\s\S]{1,300}?)<\/h2>/g)].map((x) => kwClean(x[1])).filter((x) => x && !/KOREAN WAR ARCHIVE/i.test(x))[0];
  server.tool('koreanwar_item',
    "Inspect one KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 item by archRfcd: full metadata — title, producer, production dates, acquisition source (direct NARA catalog NAID link for US re-collections), 열람 및 이용조건 (feed to judge_rights). Set radius 1-8 for Adaptive Mining: iterates the serial tail ±radius to surface same-series adjacent items (TNA-style), fetched in polite parallel batches. MOU partner — cite the source when publishing.",
    { ref_code: z.string().describe('e.g. "2022-US-02-AV-D-00207"'), radius: z.number().int().min(0).max(8).default(0).describe('0=단건 상세, 1~8=일련번호 ±N 인접 채굴') },
    async ({ ref_code, radius }) => {
      const ref0 = ref_code.trim();
      const url = `${KW_BASE}/searchDetail.do?archRfcd=${encodeURIComponent(ref0)}`;
      if (radius > 0) {
        const m = ref0.match(/^(.+-)(\d+)$/);
        if (!m) return text('참조코드 형식 오류 — 예: 2022-US-02-AV-D-00207 (말미가 일련번호)');
        const prefix = m[1]; const serial = parseInt(m[2], 10); const width = m[2].length;
        const refs = [];
        for (let s = Math.max(0, serial - radius); s <= serial + radius; s++) refs.push(prefix + String(s).padStart(width, '0'));
        // 정중한 병렬: 3건 배치 동시 조회 + 배치 간 200ms — p99 3s 내 응답 유지
        const lines = [];
        for (let i = 0; i < refs.length; i += 3) {
          const batch = refs.slice(i, i + 3);
          const rs = await Promise.all(batch.map(async (ref) => {
            try {
              const t = kwItemTitle(await gtext(`${KW_BASE}/searchDetail.do?archRfcd=${encodeURIComponent(ref)}`, KW_UA));
              return t ? `${ref === ref0 ? '●' : '○'} ${ref} | ${t.slice(0, 90)}` : `  ${ref} | (없음)`;
            } catch (e) { return `  ${ref} | ERROR ${e.message}`; }
          }));
          lines.push(...rs);
          if (i + 3 < refs.length) await sleep(200);
        }
        return text(`인접 채굴 ${ref0} ±${radius} (● 기준 · ○ 인접 발굴):\n` + lines.join('\n') + '\n※ 발굴 건은 koreanwar_item(radius=0)으로 메타 확인.');
      }
      try {
        const b = await gtext(url, KW_UA);
        const title = kwItemTitle(b);
        const rows = [...b.matchAll(/<dt[^>]*>\s*([\s\S]{1,60}?)\s*<\/dt>\s*<dd[^>]*>([\s\S]{0,400}?)<\/dd>/g)]
          .map((m) => [kwClean(m[1]), kwClean(m[2])]).filter(([k, v]) => k && v && v !== '~');
        if (!title && !rows.length) return text(agentBrowse('6·25전쟁 아카이브센터', ref0, url, '상세 메타 미검출 — 참조코드 확인'));
        const all = rows.map(([, v]) => v).join(' ');
        const naid = (all.match(/catalog\.archives\.gov\/id\/(\d+)/) || [])[1];
        const rg = (all.match(/Record Group (\d+)/) || [])[1];
        return text(`6·25전쟁 아카이브센터 [${ref0}]\n제목: ${title || '?'}\n` + rows.map(([k, v]) => `· ${k}: ${v.slice(0, 200)}`).join('\n')
          + (naid ? `\n↔ NARA 원본 NAID ${naid} (입수처 링크 직결) — https://catalog.archives.gov/id/${naid} 에서 고해상 원본·상세 기술 확인` : '')
          + (rg ? `\n↔ NARA RG ${rg} — nara_search(record_group=${rg})로 시리즈 확장 검색` : '')
          + `\n${url}\n※ '열람 및 이용조건' 행을 judge_rights에 투입해 권리 초판 판정. 협약기관 — 출처 표기 필수.`);
      } catch (e) { return text(agentBrowse('6·25전쟁 아카이브센터', ref0, url, `자동조회 실패(${e.message})`)); }
    });

  server.tool('foia_search',
    "Korean FOIA / freedom-of-information search. source: 'open_go' (대한민국 정보공개포털 open.go.kr — 원문정보공개·정보공개청구; login-based, returns the URL for the agent's browser), 'seoul_opengov' (서울정보소통광장 — Seoul decision documents, server auto-fetches the list), 'sen' (서울시교육청 정보공개), 'gyeongnam' (경상남도기록원). Decision-document originals are primary sources for local/incident history.",
    { query: z.string(), source: z.enum(['open_go', 'seoul_opengov', 'sen', 'gyeongnam']).default('open_go') },
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
      const url = 'https://www.open.go.kr/othicInfo/infoList/orginlInfoList.do?searchKeyword=' + encodeURIComponent(query);
      return text(agentBrowse('정보공개포털(원문정보공개)', query, url) + '\n※ 미공개 문서는 포털에서 정보공개청구로 요청.');
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
    'Federated discovery — run ONE query across multiple archives concurrently and merge+dedup the results (상호보완 동시수집: API 채널을 동시에 돌려 상호보완). sources: "all" or a comma list of tna,ia,gallica,europeana,nara,archives,nlk,nedb,koreanwar. Overseas (tna/ia/gallica/europeana) are keyless; koreanwar(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터, 협약기관) is keyless; nara/archives/nlk join if their server key is set; nedb joins if NEDB_INDEX_URL (official open-data files) is set. Each result is tagged by which source(s) found it — multi-source tags = cross-corroborated. 여러 아카이브를 한 쿼리로 동시 교차수집·병합.',
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
    'Structural profile of an archive for planning discovery: 자료구조(data model: hierarchy/classification/identifiers/metadata), 이용구조(access: API/auth/query syntax/robots/rights), 활용구조(utilization: how the 3 mismatches show up, which keyword set/cross-map to use, adjacent mining, cross-archive verification combos, rights rule). institution: "list" or a key — tna·nara·ia·gallica·europeana·nedb·archives·nlk·seoul·warmemo·koreanwar·foia. 기관 자료·이용·활용구조 프로파일.',
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

const REPORT_RULES = `HTML 발굴 보고서 작성 규칙 (15) — 잡지·저널급 편집 기준
1. 파일명: [주제영문]_records_[연도범위].html — 조사 완료 시 기본 산출물
2. 지면 구조(잡지형): masthead → kicker → 표제(h1) → standfirst → byline(기관 chip) → 목차(nav.toc) → 히어로 figure → Ⅰ서사 → Ⅱ핵심 기록 카드 → Ⅲ영상 필름스트립 → Ⅳ전수 목록 표 → Ⅴ재현 쿼리(details) → Ⅵ권리·게재 윤리 → 출처 총람(.sources) → footer
3. 서사 우선: 표만 나열 금지 — 발굴 경위·의미를 에세이로 서술(리드 문단 .lead 드롭캡, 풀인용 .pull 1개 이상). 문체는 담백·구체 — 과장어(놀라운·혁신적 등)와 AI투 금지
4. 실물 이미지 필수: 게재 가능(권리 A/B + 게재윤리 1·2단계) 기록은 실물을 base64로 임베드 — 히어로 1장 + 핵심 기록마다. 한 장도 못 실으면 그 사유(권리 C/D·비식별 불가·미디지털화)를 Ⅵ절에 명기
5. 모든 이미지에 figcaption + .credit 필수: "출처: 기관 정식명(국가) · 식별자 · 촬영자/생산자 · 원본 링크" — 출처 없는 이미지는 싣지 않는다
6. 영상 기록은 .film 필름스트립: 장면 전환마다 프레임을 충분히 추출(권장 8~16장)해 타임코드(.tc)+한 줄 설명으로 나열 — 표제가 가린 장면(ETC 뒤)을 드러내 원본을 직접 보고 싶게 만든다. 슬레이트·표지판 판독 프레임은 별도 확대 figure. 블록 끝에 .cta "▶ 원본 영상 보기 — [기관] 카탈로그"
7. 핵심 기록 3~6건은 .record 카드로: 이미지 + 한국어 제목(원제 병기) + .prov 출처 계보(국가→기관→RG/시리즈→상자→식별자) + 요약 + 바로가기 버튼 + 권리 배지
8. 전수 목록 표(부록형): 식별자·원제 / 연대 / 소장처·청구정보(RG·Entry·Box) / 내용 / 바로가기(원문→해제→카탈로그) / 권리초판 배지(b-A 공개확정 · b-B PD추정 · b-C 허가필요 · b-D 지위불명)
9. 출처 명시(전 지면): byline·본문에 기관 chip(국기 이모지+정식명 — 🇺🇸 NARA · 🇬🇧 TNA · 🇫🇷 BnF Gallica · 🇪🇺 Europeana · 🇺🇸 archive.org · 🇰🇷 국가기록원 · 🇰🇷 KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 등), 말미 .sources에 인용 기관 총람(국기·정식명·청구정보·이용조건·링크)
10. 재현 쿼리는 details 접이식 — 실제 실행한 쿼리만(목적/쿼리/URL 인코딩 실행 링크). '0건 ≠ 부재' note(인접 상자 ±2·피스 ±15 권고) 포함
11. 종합 색인·최신 연구 목록(ul.src) — details로 접어도 된다
12. Ⅵ 권리 절: 법적 근거(17 U.S.C. §105 · 36 CFR 1254.62 · Crown/OGL · domaine public · KOGL) + '출판 전 인간 최종 확인 필수' + D등급 공개 금지. 민감 주제(위안부·포로·학살)는 피해자 존엄 문구와 게재윤리 4단계(거부할 수 없었던 처지의 촬영 = 화면 미사용) 적용
13. 링크·수치는 도구 호출로 실확인한 것만 — 추정 URL 금지, footer에 '모든 링크 [날짜] 접속 확인' 명기
14. 연표·지도·관계도는 인라인 svg로 직접 작성 가능. 외부 리소스 금지 — 폰트·CDN·이미지 핫링크 없이 단일 HTML 파일 자기완결
15. 인쇄 대응: 템플릿의 @media print 유지 — 보고서는 그대로 출판물처럼 인쇄 가능해야 한다`;

const REPORT_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{제목}} — 기록 발굴 보고</title>
<style>
  :root{
    --paper:#f5f1e8; --card:#fffdf7; --ink:#211d18; --sub:#6b6257; --faint:#8d8477;
    --line:#dcd4c5; --hair:#c8beac; --accent:#8a3033; --deep:#5f1f22; --gold:#a8853c; --blue:#1d5fa8;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--paper);color:var(--ink);font-size:16.5px;line-height:1.78;
    font-family:'Noto Serif KR','Nanum Myeongjo','Apple Myungjo',Batang,Georgia,'Times New Roman',serif}
  .wrap{max-width:880px;margin:0 auto;padding:0 26px 90px}
  .sans{font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif}
  /* ── 머리지면 ── */
  .masthead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:24px 0 12px;
    border-bottom:3px double var(--ink);font-size:11.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--sub)}
  .masthead b{color:var(--accent)}
  .kicker{margin:52px 0 10px;font-size:12.5px;letter-spacing:.3em;color:var(--accent);text-transform:uppercase;font-weight:700}
  h1{margin:0 0 16px;font-size:clamp(30px,5.4vw,46px);line-height:1.22;font-weight:800;letter-spacing:-.01em}
  .standfirst{font-size:19px;line-height:1.68;color:var(--sub);margin:0 0 22px}
  .byline{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:13px 0;margin-bottom:6px;
    border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);font-size:12.5px;color:var(--sub)}
  nav.toc{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 30px;font-size:12.5px}
  nav.toc a{border:1px solid var(--hair);border-radius:999px;padding:4px 13px;color:var(--sub);text-decoration:none}
  nav.toc a:hover{border-color:var(--accent);color:var(--accent)}
  /* ── 본문 ── */
  h2{margin:64px 0 18px;font-size:23px;font-weight:800;scroll-margin-top:20px}
  h2 .no{font-family:Georgia,serif;font-style:italic;color:var(--accent);margin-right:10px}
  h2::after{content:"";display:block;width:54px;height:3px;background:var(--accent);margin-top:10px}
  p{margin:12px 0}
  .lead::first-letter{float:left;font-size:56px;line-height:.9;padding:7px 10px 0 0;font-weight:800;color:var(--accent)}
  .pull{margin:34px 8px;padding:4px 0 4px 22px;border-left:3px solid var(--gold);
    font-size:20.5px;line-height:1.6;color:var(--deep);font-style:italic}
  a{color:var(--blue);text-decoration:none;border-bottom:1px dotted #9ab6d6}
  a:hover{color:var(--accent);border-bottom-color:var(--accent)}
  /* ── 그림·크레디트 ── */
  figure{margin:34px 0}
  figure img{width:100%;display:block;border:1px solid var(--line);background:#171412}
  figure svg{width:100%;height:auto;display:block;border:1px solid var(--line);background:var(--card)}
  figcaption{font-size:13px;color:var(--sub);margin-top:9px;line-height:1.6}
  figcaption b{color:var(--ink)}
  .credit{display:block;font-size:11.5px;color:var(--faint);letter-spacing:.04em;margin-top:3px}
  .fig-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
  .fig-grid figure{margin:0}
  .fig-grid img{height:100%;object-fit:cover}
  /* ── 출처 chip ── */
  .chip{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;border:1px solid var(--hair);
    border-radius:999px;background:var(--card);font-size:12px;color:var(--sub);white-space:nowrap}
  /* ── 기록 카드 ── */
  .record{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--accent);
    margin:26px 0;padding:22px 24px;display:grid;grid-template-columns:210px 1fr;gap:20px}
  .record>img{width:100%;border:1px solid var(--line);align-self:start}
  .record h3{margin:0 0 6px;font-size:18px}
  .record .prov{font-size:12px;color:var(--faint);letter-spacing:.03em;margin:4px 0 10px}
  .record .prov b{color:var(--sub)}
  .btns{margin-top:12px;display:flex;flex-wrap:wrap;gap:8px}
  .btns a{border:1px solid var(--hair);border-radius:4px;padding:5px 13px;font-size:12.5px;background:var(--paper)}
  @media (max-width:640px){.record{grid-template-columns:1fr}}
  /* ── 영상 필름스트립 ── */
  .film{background:#171412;color:#e9e2d6;border:1px solid #000;margin:38px 0;padding:22px 22px 24px}
  .film h3{margin:0 0 4px;font-size:19px;color:#f4ecdd}
  .film .prov{font-size:12px;color:#9d9384;margin-bottom:6px}
  .film p{color:#cfc5b4;font-size:14.5px}
  .filmstrip{display:flex;gap:10px;overflow-x:auto;padding:12px 2px 14px;scroll-snap-type:x mandatory}
  .frame{flex:0 0 200px;scroll-snap-align:start;margin:0}
  .frame img{width:100%;aspect-ratio:4/3;object-fit:cover;border:1px solid #3a332c;transition:.18s;filter:sepia(.08)}
  .frame:hover img{filter:none;transform:scale(1.02)}
  .frame figcaption{font-size:12px;color:#bdb3a2;margin-top:5px}
  .tc{display:inline-block;font:700 11px/1.7 Consolas,Menlo,monospace;background:#2a241f;color:#d9c691;
    padding:0 7px;border-radius:3px;margin-right:6px}
  .cta{display:inline-block;margin-top:14px;padding:11px 24px;background:var(--accent);color:#fff!important;
    font-weight:700;letter-spacing:.05em;border:none;border-radius:4px}
  .cta:hover{background:var(--deep)}
  .hint{font-size:11.5px;color:#7d7466;margin-top:6px}
  /* ── 표(부록형) ── */
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin:18px 0;background:var(--card)}
  th{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--sub);text-align:left;
    padding:10px;border-bottom:2px solid var(--ink);white-space:nowrap}
  td{padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11.5px;font-weight:700;white-space:nowrap}
  .b-A{background:#e3f0fb;color:#1d5fa8;border:1px solid #b9d4ee}
  .b-B{background:#e6f2e6;color:#2c6e2f;border:1px solid #bcd9bd}
  .b-C{background:#fff3df;color:#9a6b15;border:1px solid #ead9b0}
  .b-D{background:#fbe7e7;color:#a33333;border:1px solid #e6bcbc}
  code{background:#eee9dd;padding:2px 6px;border-radius:4px;font-size:13px;font-family:Consolas,Menlo,monospace}
  .note{background:#fbf5e3;border:1px solid #e2d5ad;border-radius:8px;padding:14px 18px;margin:16px 0;font-size:14px}
  ul.src{padding-left:20px;font-size:14px}
  ul.src li{margin:6px 0}
  .small{font-size:13px;color:var(--sub)}
  /* ── 접이식 ── */
  details{background:var(--card);border:1px solid var(--line);border-radius:6px;margin:14px 0}
  summary{cursor:pointer;padding:13px 18px;font-weight:700;font-size:14.5px;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"▸";display:inline-block;color:var(--accent);margin-right:9px;transition:.15s}
  details[open] summary::before{transform:rotate(90deg)}
  details .inner{padding:0 18px 16px}
  /* ── 출처 총람·꼬리 ── */
  .sources{margin-top:64px;padding:20px 22px;background:var(--card);border:1px solid var(--line)}
  .sources h2{margin-top:0}
  .sources li{margin:7px 0;font-size:13.5px}
  footer{margin-top:44px;border-top:3px double var(--ink);padding-top:14px;font-size:12px;color:var(--sub)}
  @media print{
    body{background:#fff;font-size:11pt}
    .wrap{max-width:100%;padding:0}
    nav.toc,.hint{display:none}
    .film{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    details{border:none}details .inner{display:block}
  }
</style>
</head>
<body>
<div class="wrap">

<div class="masthead sans"><span><b>KOREA ARCHIVE</b> 통합검색 — 기록 발굴 보고</span><span>{{호수 또는 시리즈명}} · {{작성일}}</span></div>

<div class="kicker sans">{{분류 킥커 — 예: 발굴 보고 · 1950 한국전쟁 영상}}</div>
<h1>{{표제 — 신문 표제처럼, 발굴의 핵심을 한 문장으로}}</h1>
<p class="standfirst">{{스탠드퍼스트 2~3문장 — 무엇을, 어디서, 왜 중요한지. 잡지 데크처럼 서술형으로.}}</p>
<div class="byline sans">
  <span>대상 시기 <b>{{대상시기}}</b></span> · <span>조사 도구 <b>KOREA ARCHIVE 통합검색</b></span>
  <span class="chip">🇺🇸 {{NARA · RG 111}}</span><span class="chip">🇬🇧 {{TNA · FO 371}}</span><span class="chip">🇰🇷 {{KOREAN WAR ARCHIVES}}</span>
  <!-- 조사한 기관 전부를 chip으로: 🇫🇷 BnF Gallica · 🇪🇺 Europeana · 🇺🇸 archive.org · 🇰🇷 국가기록원 … -->
</div>
<nav class="toc sans"><a href="#s1">서사</a><a href="#s2">핵심 기록</a><a href="#s3">영상</a><a href="#s4">전수 목록</a><a href="#s5">재현 쿼리</a><a href="#s6">권리·출처</a></nav>

<!-- 히어로: 가장 강한 실물 이미지 1장(권리 A/B + 게재윤리 통과). 반드시 credit. -->
<figure>
  <img src="data:image/jpeg;base64,{{BASE64}}" alt="{{대체 텍스트}}">
  <figcaption><b>그림 1.</b> {{한 줄 설명 — 보는 이가 멈추게 되는 이유}}
  <span class="credit">출처: {{기관 정식명}}({{국가}}) · {{식별자}} · {{촬영자/생산자, 연도}} · <a href="{{원본URL}}">원본</a></span></figcaption>
</figure>

<h2 id="s1"><span class="no">I.</span> {{서사 절 제목 — 발굴 경위}}</h2>
<p class="lead">{{리드 문단(드롭캡) — 어떤 질문에서 출발해 무엇을 찾았는가. 카탈로그의 부실한 표제가 무엇을 가리고 있었는가.}}</p>
<p>{{본문 서사 — 검색 전략(표기 변형·인접 채굴), 결정적 단서, 판독 과정. 확인한 것과 추정을 구분해 담백하게.}}</p>
<blockquote class="pull">{{풀인용 — 슬레이트 판독문·문서 원문·핵심 발견 한 구절}}</blockquote>
<p>{{서사 계속. 이미지가 있으면 figure를 절 사이 어디든 추가(각각 credit 필수).}}</p>

<h2 id="s2"><span class="no">II.</span> 핵심 기록</h2>
<!-- 가장 중요한 기록 3~6건을 카드로. 이미지 없으면 <img> 줄 생략 -->
<div class="record">
  <img src="data:image/jpeg;base64,{{BASE64}}" alt="{{설명}}">
  <div>
    <h3>{{한국어 제목 — 원제 병기}}</h3>
    <div class="prov sans">{{🇺🇸 미국}} → <b>{{NARA}}</b> → {{RG 111 · Entry NM-xx · Box nn}} → <b>{{식별자}}</b></div>
    <p>{{내용 요약 2~3문장 — 한국 관련 핵심. 표제가 가린 내용이 있으면 그것부터.}}</p>
    <div class="btns sans"><a href="{{원문URL}}">원문 보기</a><a href="{{카탈로그URL}}">카탈로그</a><span class="badge b-B">B · PD 추정</span></div>
  </div>
</div>

<h2 id="s3"><span class="no">III.</span> 영상 기록 — 프레임으로 먼저 본다</h2>
<!-- 영상 1건당 .film 블록 1개. 프레임은 장면 전환마다 추출(권장 8~16장, analyze_video.py auto/zoom).
     표제가 가린 장면(ETC 뒤)을 프레임으로 드러내 원본을 직접 보고 싶게 만드는 것이 목적. -->
<div class="film">
  <h3>{{영상 제목 (원제)}}</h3>
  <div class="prov sans">{{🇺🇸 NARA · RG 111 · 식별자}} · {{러닝타임}} · {{연대}} · 촬영 {{부대/촬영자}}</div>
  <p>{{이 영상이 왜 중요한가 — 카탈로그 표제와 실제 내용의 간극을 중심으로 2~3문장.}}</p>
  <div class="filmstrip">
    <figure class="frame"><img src="data:image/jpeg;base64,{{BASE64}}" alt="{{장면}}"><figcaption><span class="tc">{{00:00:12}}</span>{{한 줄 장면 설명}}</figcaption></figure>
    <figure class="frame"><img src="data:image/jpeg;base64,{{BASE64}}" alt="{{장면}}"><figcaption><span class="tc">{{00:01:05}}</span>{{슬레이트 — 날짜·부대 판독}}</figcaption></figure>
    <!-- 프레임 반복 -->
  </div>
  <div class="hint sans">← 좌우로 넘겨 보세요 · 프레임 {{N}}장 / 전체 {{러닝타임}}</div>
  <a class="cta sans" href="{{원본영상URL}}">▶ 원본 영상 보기 — {{기관}} 카탈로그</a>
</div>

<h2 id="s4"><span class="no">IV.</span> 발굴 기록 전수 목록</h2>
<table>
  <thead><tr><th>#</th><th>식별자 · 원제</th><th>연대</th><th>소장처 / 청구정보</th><th>관련 내용</th><th>바로가기</th><th>권리초판</th></tr></thead>
  <tbody>
    <tr><td>1</td><td><strong>{{원제}}</strong><br><span class="small">{{생산기관·시리즈}}</span></td><td>{{연대}}</td><td>{{소장처}} <strong>{{RG/참조코드}}</strong>{{, Entry·Box}}</td><td>{{핵심 내용}}</td><td><a href="{{원문URL}}">원문</a> · <a href="{{카탈로그URL}}">카탈로그</a></td><td><span class="badge b-B">B</span></td></tr>
    <!-- 행 반복. 사진·영상 사료가 많으면 표②로 분리 -->
  </tbody>
</table>

<h2 id="s5"><span class="no">V.</span> 재현 가능한 조사</h2>
<details open>
  <summary>재현용 검색 쿼리 — 실제 실행분만</summary>
  <div class="inner">
  <p class="small">전전(戰前) 자료는 <code>Korea</code> 외 <code>Chosen</code>·<code>Corea</code>·<code>Keijo</code> 등 당대 표기를 병렬 투입.</p>
  <table>
    <thead><tr><th>목적</th><th>쿼리</th><th>실행</th></tr></thead>
    <tbody><tr><td>{{목적}}</td><td><code>{{쿼리}}</code></td><td><a href="{{URL인코딩된 검색URL}}">검색 실행</a></td></tr></tbody>
  </table>
  </div>
</details>
<div class="note"><strong>0건 ≠ 부재.</strong> {{미전산화 상황 + 인접 상자(Box ±2)·피스(참조코드 ±15) 추가 조사 권고}}</div>
<details>
  <summary>종합 색인 · 최신 연구</summary>
  <div class="inner"><ul class="src"><li><a href="{{URL}}">{{제목}}</a> — {{한 줄 설명}}</li></ul></div>
</details>

<h2 id="s6"><span class="no">VI.</span> 권리 판정과 게재 윤리</h2>
<p>{{판정 요약 + 법적 근거(17 U.S.C. §105 · 36 CFR 1254.62 · Crown/OGL · domaine public · KOGL)}}.
자동 초판이므로 <strong>출판 전 인간 최종 확인 필수</strong>이며, <span class="badge b-D">D등급</span>은 공개 금지입니다.
{{민감 주제(위안부·포로·학살 등)면: 피해자 존엄·윤리적 사용 기준, 게재윤리 4단계(거부할 수 없었던 처지의 촬영 = 화면 미사용) 적용 문구}}</p>

<div class="sources">
  <h2 style="margin:0 0 10px;font-size:17px">기록 출처 <span class="small">Archives cited</span></h2>
  <ul class="src">
    <li>🇺🇸 <b>{{National Archives and Records Administration (NARA)}}</b> — {{RG·시리즈, 이용조건 요약}} · <a href="{{URL}}">catalog.archives.gov</a></li>
    <li>🇰🇷 <b>{{KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터(전쟁기념관재단)}}</b> — {{출처 표기 필수 조건}} · <a href="{{URL}}">koreanwar.or.kr</a></li>
    <!-- 인용한 모든 기관: 국기 · 정식명 · 청구정보 · 이용조건 · 링크 -->
  </ul>
</div>

<footer>
  발굴 방법론: KOREA ARCHIVE 통합검색(표기 변형 병렬 투입 · RG 교차 검색 · 인접 확장 · 권리 초판 판정) ·
  본 보고서의 모든 링크와 수치는 {{확인일}} 기준 도구 호출로 확인됨 · 이미지는 각 기관 원본의 재현이며 출처 표기를 유지할 것.
</footer>
</div>
</body>
</html>`;

export { handler as GET, handler as POST, handler as DELETE };
