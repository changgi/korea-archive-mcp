import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createMcpHandler } from 'mcp-handler';
import { DATA } from '../../../lib/data.js';
import { judgeRights } from '../../../lib/rights.js';
import { PROFILES } from '../../../lib/profiles.js';
import { DOMESTIC } from '../../../lib/domestic_keywords.js';
import { buildNaraManifest, naraUrls } from '../../../lib/nara_iiif.js';
import { bridgeUrl, kvUrl } from '../../../lib/ka_iiif.js';
import { envelopeOf, encodeEnv, recUrls } from '../../../lib/rec_iiif.js';
import { deflateRawSync } from 'node:zlib';
import { tnaUrls } from '../../../lib/tna_iiif.js';
import { stash, stashCall, argKey, ledgerConf, LEDGER_PAGE } from '../../../lib/ledger.js';
import { AsyncLocalStorage } from 'node:async_hooks';
const REQ = new AsyncLocalStorage(); // v2.7: 요청 맥락 — 자동 검사(X-KA-Probe) 트래픽을 활용 집계에서 제외

export const maxDuration = 60;
// Korean government archive sites (archives.seoul.go.kr, opengov.seoul.go.kr, …) block foreign /
// datacenter egress IPs — on Vercel's default (US) region this surfaces as "fetch failed" even though
// the same request returns HTTP 200 from a Korean IP. Pin this function to Seoul (icn1) so outbound
// requests originate from Korea. Also settable in Vercel dashboard (Settings → Functions → Region → Seoul)
// or vercel.json "regions". Overseas archives (NARA, TNA, Gallica, Europeana, archive.org) stay globally reachable.
export const preferredRegion = 'icn1';

// v2.36 정직 UA — 브라우저 위장 금지(CLAUDE.md 접근 원칙). 이 UA를 거부하는 기관은 우회하지 않고 health·source_profile에 '정직 UA 거부'로 표시하고 브라우저 경로를 안내한다.
const UA = 'KoreaArchiveMCP/2.36 (+https://github.com/changgi/korea-archive-mcp; archival discovery; non-commercial research)';
const FETCH_TIMEOUT = 20000;
// v2.36 정직 UA 거부 기관 — 우회하지 않고 표시(실측 기록). 기관이 허용하면 결과가 다시 나오므로 이 표는 안내용(차단 판정은 응답으로)
const UA_REFUSED = {}; // v2.37 비움 — 규장각 403은 UA가 아니라 사이트 개편(POST CSRF)이었고 GET으로 복구, KTV는 e영상역사관 자체 목록 검색으로 복구(2026-11-24 실측). 새 거부가 확인되면 추가(위장하지 않음)
const uaRefusedNote = (k, q = '') => { const r = UA_REFUSED[k]; if (!r) return ''; return `접근 제한(정직 UA 거부) — ${r.name}: ${r.how} (실측 ${r.since}). 위장·우회하지 않습니다. 브라우저로 직접 열람: ${r.browse}${q ? ` (검색어 '${q}')` : ''} · 자동 수집 허용 문의: ${r.contact}`; };
// v2.36 프록시 우회(FETCH_PROXY_PREFIX·allorigins·jina) 제거 — 접근 차단은 우회하지 않고 표시한다(CLAUDE.md).


const text = (s) => ({ content: [{ type: 'text', text: s }] });
const OK_B = 'https://www.overseaschf.or.kr'; // v2.11 국외소재문화유산재단 — robots.txt 'Disallow: /'(표시 대상 — 발굴 우선 원칙), 정직 UA·요청 최소
const OK_UA = { 'User-Agent': 'KoreaArchiveMCP/1.0 (+https://github.com/changgi/korea-archive-mcp; archival discovery)' };
const okText = (h) => norm(h).replace(/\u200b/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); // Python _clean 패리티
const okList = (b) => { const out = [];
  for (const tr of String(b).split(/<tr>/).slice(1)) {
    const a = tr.match(/href="(\/archive\/search\/(?:photo|category)\.do)(?:;jsessionid=[^?"]*)?\?mode=view&(?:amp;)?srSearchTy=(\w+)&(?:amp;)?id=(\d+)&(?:amp;)?iDivCd=(\d*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const lis = [...a[5].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => okText(m[1])).filter(Boolean);
    const title = okText(a[5].replace(/<span class="mo">[\s\S]*?<\/span>/, '').replace(/<ul[\s\S]*?<\/ul>/, ''));
    const type = okText(tds[2] || ''); const img = (tr.match(/<img[^>]+src="([^"]+)"/) || [])[1] || '';
    out.push({ title, type, country: lis[0] || '', holder: lis[1] || okText(tds[4] || ''), url: `${OK_B}${a[1]}?mode=view&srSearchTy=${a[2]}&id=${a[3]}&iDivCd=${a[4]}`, id: `${a[2]}:${a[3]}`, img: img && (img.startsWith('http') ? img : OK_B + img) });
  }
  const total = ((String(b).match(/전체 <strong[^>]*>([\d,]+)/) || [])[1] || '').replace(/,/g, '');
  return { out, total }; };
const OK_PD = `${OK_B}/okchf/data/US_DF_PD.do`; // v2.12 발간자료(국외 소장 한국문화유산 조사보고서) 게시판 — 제목+내용(목차) 검색
const okPubs = (b) => [...String(b).matchAll(/<a href="\?mode=view&(?:amp;)?articleNo=(\d+)[^"]*">\s*<span class="board-item__img">\s*(?:<img src="([^"]+)")?[\s\S]*?<span class="board-item__tit">([\s\S]*?)<\/span>/g)]
  .map((m) => ({ no: m[1], title: okText(m[3]), img: m[2] ? OK_B + m[2] : '', url: `${OK_PD}?mode=view&articleNo=${m[1]}` }));
const okPubSearch = async (q) => { const b = await cachedText('okPS:' + q, 6 * 3600e3, () => gtext(`${OK_PD}?mode=list&srSearchKey=article_title_text&srSearchVal=${encodeURIComponent(q)}&articleLimit=10`, OK_UA), 'count-all');
  return { items: okPubs(b), total: ((b.match(/count-all">총 <span>([\d,]+)/) || [])[1] || '').replace(/,/g, '') }; };
// v2.13 국립문화유산연구원 국가유산 지식이음(portal.nrich.go.kr) — robots Allow. 발간자료 Open API(무키, 공공누리 유형 포함) + 국외문화유산 DB(12,569건, 제목 검색 st=1)
const NR_B = 'https://portal.nrich.go.kr';
const nrRepApi = async (q, n) => { const x = await cachedText(`nrA:${Math.min(n, 20)}:${q}`, 6 * 3600e3, () => gtext(`${NR_B}/kor/originalTotalApi.do?idx=203&firstindex=1&recordcountperpage=${Math.min(n, 20)}&st=all&sk=${encodeURIComponent(q)}&bunya_cd=&start_year=&end_year=`, OK_UA), '<list');
  return [...x.matchAll(/<data>([\s\S]*?)<\/data>/g)].map((m) => { const f = {}; for (const c of m[1].matchAll(/<md_data(\d+)><!\[CDATA\[([\s\S]*?)\]\]><\/md_data\d+>/g)) f[c[1]] = c[2].trim();
    return { idx: f[2], title: okText(f[3] || ''), form: f[4] || '', abs: f[5] || '', year: f[6] || '', field: f[7] || '', owner: f[8] || '', kogl: f[10] || '', toc: f[11] || '', url: f[12] || `${NR_B}/kor/originalUsrView.do?menuIdx=1046&info_idx=${f[2]}`, img: f[13] || '' }; }); };
const nrOvList = async (q) => { const b = await cachedText('nrL:' + q, 6 * 3600e3, () => gtext(`${NR_B}/kor/overseasSearchList.do?menuIdx=840&webyn=Y&st=1&pageindex=1&sk=${encodeURIComponent(q)}`, OK_UA), 'overseasSearch');
  return [...b.matchAll(/<tr>\s*<td[^>]*>\s*\d+\s*<\/td>\s*<td>\s*<a href="\/kor\/overseasSearchView\.do\?menuIdx=840&(?:amp;)?mseq=(\d+)">([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map((m) => ({ mseq: m[1], title: okText(m[2]), era: okText(m[3]), holder: okText(m[4]), nation: okText(m[5]), url: `${NR_B}/kor/overseasSearchView.do?menuIdx=840&mseq=${m[1]}` })); };
// v2.15 연구DB 정적 색인 — Open API 11종(금석문·초상화·괘불·개인일기·목간·일제강점기 고적조사 문헌·조선고적도보·고고학사전·고고학저널 유적·고구려·개성)을 주 1회 수집(scripts/nrich_harvest.py)한 docs/data/nrich_db.jsonl을 검색(원 기관 요청 0)
const NR_DB = 'https://changgi.github.io/korea-archive-mcp/data/nrich_db.jsonl';
const NR_DS = ['ksm', 'portrait', 'gwaebul', 'diary', 'mokgan', 'jcbib', 'jcphoto', 'dict', 'arch', 'koguryo', 'gaesong', 'design', 'pattern', 'oldbook', 'hyanggyo', 'stone', 'journal', 'iron', 'dolmen', 'assay', 'material'];
let nrDbMem = null;
const nrDb = async () => { const t = await cachedText('nrDB', 6 * 3600e3, async () => (await fetch(NR_DB, { headers: OK_UA, signal: AbortSignal.timeout(40000) })).text(), '"ds"'); // 11.7MB — 수집기 제한과 분리된 긴 타임아웃
  if (!nrDbMem || nrDbMem.src !== t.length) nrDbMem = { src: t.length, rows: t.split('\n').filter(Boolean).map((l) => { try { const o = JSON.parse(l); o._h = [o.t, o.a, o.p, o.d, o.x, ...Object.values(o.m || {})].join(' ').toLowerCase(); return o; } catch { return null; } }).filter(Boolean) };
  return nrDbMem.rows; };
let nrDbP = null; // v2.15.1: 색인 적재를 한 번만(동시 호출 공유), 실패 시 다음 호출에서 재시도
const nrDbWarm = () => (nrDbP ||= nrDb().catch((e) => { nrDbP = null; throw e; }));
const nrDbQuick = (q, n, ms = 3500) => Promise.race([nrDbWarm().then(() => nrDbSearch(q, n)), new Promise((r) => setTimeout(() => r([]), ms))]).catch(() => []); // 연합검색은 색인을 최대 3.5s만 기다림(나머지 결과 먼저)
const nrDbSearch = async (q, n, ds) => { const toks = String(q).toLowerCase().split(/\s+/).filter(Boolean); if (!toks.length) return [];
  const rows = (await nrDb()).filter((o) => (!ds || o.ds === ds) && toks.every((t) => o._h.includes(t)));
  const score = (o) => (toks.every((t) => String(o.t).toLowerCase().includes(t)) ? 0 : 1); // 명칭 일치 우선
  return rows.sort((a, b) => score(a) - score(b)).slice(0, n); };
const nrDbItem = (o) => ({ title: `[${o.dn}] ${o.t}${o.a ? ` (${o.a})` : ''}`.slice(0, 160), date: o.d || '', id: o.id, series: ['연구DB', o.dn, (o.p || '').split(/\s+/)[0]].filter(Boolean).join(' › '), url: o.u || '' });
// v2.21 연구원 인물 색인 조회(공용) — '인물:이름' 모드와 gonghun '종합:이름' 4번째 채널이 함께 쓴다
const nrPeople = async () => JSON.parse(await cachedText('nrPeople', 6 * 3600e3, () => gtext('https://changgi.github.io/korea-archive-mcp/data/nrich/people.json'), '"r"'));
const nrPeopleKeys = (P, nm) => Object.keys(P).filter((k) => P[k].n === nm || k === nm || (P[k].h && P[k].h.includes(nm)) || (nm.length >= 2 && P[k].n.startsWith(nm) && P[k].n.length <= nm.length + 1)).slice(0, 8);
const nrYear = (d) => { const m = String(d || '').match(/(?<!\d)(\d{3,4})(?!\d)/); return m ? +m[1] : 9999; }; // 연대 문자열의 첫 연도(정렬용)
const nrPeopleLines = (P, keys, per = 3) => keys.map((k) => { const e = P[k]; const tot = Object.values(e.r).reduce((a, v) => a + v.length, 0);
  const ex = Object.entries(e.r).flatMap(([r, v]) => v.map((x) => [r, ...x])).sort((a, b) => nrYear(a[3]) - nrYear(b[3])).slice(0, per);
  return `- ${k} — ${tot}건(${Object.entries(e.r).map(([r, v]) => `${r} ${v.length}`).join(' · ')})` + ex.map((x) => `\n  · [${x[0]}] ${x[2]}${x[3] ? ' · ' + x[3] : ''} → ${x[1]}`).join(''); });
// v2.24 IA 관련성 — 전체 필드 검색은 Archive-It 웹 크롤링 원자료(mediatype web)·라디오 스트림이 상위를 채운다(실측 'Korea' 6건 전부 크롤링 묶음). 제목 범위 + 문서·영상·이미지, 0건이면 웹·컬렉션·계정만 제외한 넓은 질의. 고급 문법(필드:값)은 그대로.
const iaQueries = (q) => (/\w+:/.test(q) ? [q] : [`title:(${q}) AND mediatype:(texts OR movies OR image)`, `(${q}) AND NOT mediatype:(web OR collection OR account)`]);
const iaRank = (docs) => docs.map((x, i) => [x, /^gov\./.test(x.identifier || '') ? 0 : /^youtube-/.test(x.identifier || '') ? 2 : 1, i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]); // 정부·기관 원본 우선, 유튜브 사본 뒤
async function iaSearch(q, rows, fl, page = 1) { let last = null;
  for (const qq of iaQueries(q)) { const d = await jget(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(qq)}&${fl}&rows=${Math.min(100, rows * 2)}&page=${page}&output=json`); last = { d, qq };
    if (((d.response || {}).numFound || 0) > 0) break; }
  const r = (last.d.response || {}); return { numFound: r.numFound || 0, docs: iaRank(r.docs || []).slice(0, rows), q: last.qq }; }
const nrField = (f) => String(f || '').split(/\s*-\s*/).filter(Boolean).join(' › ');
// v2.14 국외 소재 교차확인 — 재단(okchf)·연구원(nrich) 두 DB에서 '명칭(괄호·한자·기호 제거)+소장처'가 같은 기록을 한 건으로 묶는다(출처 둘 다, sameAs=다른 쪽 URL)
const OV_ALIAS = { '대영박물관': '영국박물관', 'british museum': '영국박물관', '메트로폴리탄박물관': '메트로폴리탄미술관' };
const ovKey = (it) => { const t = String(it.title || '').replace(/^\[[^\]]+\]\s*/, ''); const nm = t.split(' — ')[0].replace(/[(（][^)）]*[)）]|[『』〈〉「」<>\s·]/g, '');
  const h = String(it.series || '').split(' › ').pop().trim(); return nm && h ? `${nm}|${OV_ALIAS[h.toLowerCase()] || OV_ALIAS[h] || h}` : ''; };
function linkOverseas(items) {
  const seen = new Map(); const out = [];
  for (const it of items) {
    const src = (it.sources || [])[0] || ''; const ok = /^(okchf|nrich)/.test(src) && /^국외문화유산/.test(it.series || '');
    const k = ok ? ovKey(it) : ''; const prev = k && seen.get(k);
    if (prev && !prev.sources.some((x) => x.split('·')[0] === src.split('·')[0])) { prev.sources.push(...it.sources); prev.sameAs = prev.sameAs || it.url; prev.crossOv = true; continue; }
    if (k) seen.set(k, it); out.push(it);
  }
  return out;
}
const archLink = (u) => String(u || '').replace(/&amp;/g, '&').replace(/^http:\/\/www\.archives\.go\.kr/, 'https://www.archives.go.kr'); // 국가기록원 상세 링크 정규화(v2.7.1)
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Surface the real network cause (undici hides it behind a generic "fetch failed").
const errInfo = (e) => {
  const c = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : '';
  return `${(e && e.name) || 'Error'}: ${(e && e.message) || e}${c ? ` (${c})` : ''}`;
};

// fetch with honest UA + timeout + one retry. 차단(403 등)은 그대로 오류로 보고 — 우회 없음.
async function robustFetch(url, headers = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) { lastErr = e; if (attempt === 0) await sleep(300); }
  }
  throw new Error(errInfo(lastErr));
}

const jget = async (url, headers = {}) => (await robustFetch(url, { Accept: 'application/json', ...headers })).json();
const gtext = async (url, headers = {}) => (await robustFetch(url, headers)).text();
// v1.96.6: 장서각은 병렬 호출 시 간헐 403 — 백오프 3회(0.9s·1.8s) 후 실패 보고(우회 아님: 같은 요청을 늦춰 재시도)
const jsgText = async (url) => { let e0; for (let k = 0; k < 3; k++) { try { return await gtext(url); } catch (e) { e0 = e; if (!/HTTP (403|429|5\d\d)/.test(String(e && e.message))) break; await sleep(900 * (k + 1)); } } throw e0; };
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
  // ── v2.96 증보: 개항기~일제강점기~해방 공간 용어(실측 57개 중 54개 미변환·오변환 '조선어학회→Korea 어학회' 등). 구체 표기 먼저 ──
  { p: '강화도\\s?조약|조일\\s?수호\\s?조규|병자\\s?수호\\s?조약', en: 'Treaty of Kanghwa 1876', fr: 'traité de Kanghwa 1876' },
  { p: '개항(?!장)|문호\\s?개방', en: 'Korea treaty ports opening', fr: 'ouverture des ports Corée' },
  { p: '임오\\s?군란', en: 'Imo incident 1882 Korea' },
  { p: '갑신\\s?정변', en: 'Kapsin coup 1884 Korea' },
  { p: '갑오\\s?개혁|갑오\\s?경장', en: 'Kabo reform 1894 Korea' },
  { p: '을미\\s?사변', en: 'assassination Queen Min 1895', fr: 'assassinat reine Min 1895' },
  { p: '독립\\s?협회', en: 'Independence Club Korea' },
  { p: '독립\\s?신문', en: 'The Independent newspaper Seoul 1896' },
  { p: '만민\\s?공동회', en: 'Independence Club mass meeting Seoul 1898' },
  { p: '경술\\s?국치|한일\\s?병합|한일\\s?합병|韓國倂合|韓国併合', en: 'Japan annexation of Korea 1910', fr: 'annexion de la Corée 1910' },
  { p: '토지\\s?조사\\s?사업', en: 'land survey Chosen 1910s' },
  { p: '제주\\s?4[·.]3|4[·.]3\\s?사건', en: 'Cheju-do 1948' }, // v2.96 일반 '제주'보다 먼저(옛 순서 결함: '제주 4·3'→'Cheju Quelpart 4·3')
  { p: '동양\\s?척식(?:\\s?주식\\s?회사)?|東洋拓殖', en: 'Oriental Development Company' },
  { p: '산미\\s?증식', en: 'rice production Chosen Japan' },
  { p: '신사\\s?참배|神社参拝', en: 'Shinto shrine worship Korea' },
  { p: '창씨\\s?개명|創氏改名', en: 'name change policy Korea Japan' },
  { p: '황국\\s?신민|내선\\s?일체', en: 'Japanese assimilation policy Korea' },
  { p: '학병|학도병', en: 'Korean student soldiers Japanese army' },
  { p: '지원병|징병|徵兵', en: 'Korean conscription Japanese army' },
  { p: '근로\\s?정신대|여자\\s?정신대', en: 'women volunteer labor corps Korea' },
  { p: '관동\\s?대지진|간토\\s?대지진|간토\\s?학살|関東大震災', en: 'earthquake Tokyo 1923 Koreans' },
  { p: '6[·.]10\\s?만세', en: 'June 10 movement 1926 Korea' },
  { p: '광주\\s?학생\\s?운동', en: 'Kwangju student movement 1929' },
  { p: '신간회', en: 'Singanhoe Korea' },
  { p: '조선어\\s?학회', en: 'Korean Language Society' },
  { p: '물산\\s?장려', en: 'Korean products promotion movement' },
  { p: '독립군', en: 'Korean independence army Manchuria' },
  { p: '청산리', en: 'Battle of Qingshanli 1920' },
  { p: '봉오동', en: 'Battle of Fengwudong 1920' },
  { p: '의열단', en: 'Uiyoldan Korean righteous brotherhood' },
  { p: '윤봉길', en: 'Hongkew Park bombing 1932' },
  { p: '이봉창', en: 'Lee Bong-chang 1932' },
  { p: '유관순', en: 'Yu Gwan-sun' },
  { p: '손기정', en: 'Sohn Kee-chung Kitei Son' },
  { p: '베를린\\s?올림픽', en: 'Berlin Olympics 1936' },
  { p: '광복(?!군)|8[·.]15', en: 'Korea liberation 1945', fr: 'Corée libération 1945' },
  { p: '건국\\s?준비\\s?위원회|건준', en: 'Committee for Preparation of Korean Independence' },
  { p: '모스크바\\s?3상\\s?회의|삼상\\s?회의', en: 'Moscow Conference 1945 Korea' },
  { p: '좌우\\s?합작', en: 'Left-Right Coalition Committee Korea 1946' },
  { p: '5[·.]10\\s?총?선거', en: 'Korea election May 1948' },
  { p: '정부\\s?수립', en: 'establishment Republic of Korea 1948' },
  { p: '제헌\\s?국회', en: 'Constituent National Assembly Korea 1948' },
  { p: '반민\\s?특위|반민족\\s?행위', en: 'Special Committee anti-national activities Korea' },
  { p: '농지\\s?개혁', en: 'land reform Korea' },
  { p: '4[·.]19|4월\\s?혁명', en: 'April Revolution 1960 Korea' },
  { p: '5[·.]16', en: 'May 16 coup 1961 Korea' },
  { p: '하와이\\s?이민', en: 'Korean immigrants Hawaii' },
  { p: '사진\\s?신부', en: 'picture brides' },
  { p: '이민|移民', en: 'Korean emigration', fr: 'émigration coréenne' },
  { p: '재일\\s?조선인|재일\\s?한국인|在日朝鮮人', en: 'Koreans in Japan Zainichi' },
  { p: '고려인|카레이스키', en: 'Koryo-saram Soviet Koreans' },
  { p: '강제\\s?이주', en: 'deportation Koreans Soviet 1937' },
  { p: '사할린', en: 'Sakhalin Koreans' },
  // ── v2.95 증보: 6·25 핵심 용어(실측 44개 중 39개 미변환 → 해외 채널이 'Korea'만 검색). 구체 표기(피란수도·휴전회담)는 일반 패턴보다 먼저 ──
  { p: '피란\\s?수도|임시\\s?수도', en: 'Pusan 1951' },
  { p: '휴전\\s?회담|정전\\s?회담|휴전\\s?협상|정전\\s?협상', en: 'armistice negotiations Korea' },
  { p: '서울\\s?수복|9[·.]28\\s?수복', en: 'recapture of Seoul' },
  { p: '북진', en: 'UN advance north Korea 1950' },
  { p: '폭격|공습|爆擊|轰炸', en: 'bombing Korea', fr: 'bombardement Corée' },
  { p: '네이팜', en: 'napalm Korea' },
  { p: '민간인\\s?학살|양민\\s?학살', en: 'civilian massacre Korea' },
  { p: '보도\\s?연맹', en: 'Bodo League massacre' },
  { p: '거창\\s?사건|거창\\s?양민', en: 'Kochang incident' },
  { p: '국민\\s?방위군', en: 'National Defense Corps Korea' },
  { p: '위문\\s?공연|위문', en: 'troop entertainment Korea' },
  { p: '전쟁\\s?미망인', en: 'war widows Korea' },
  { p: '상이\\s?군인|상이\\s?용사', en: 'disabled veterans Korea' },
  { p: '유엔\\s?기념\\s?공원|유엔\\s?묘지|UN\\s?묘지', en: 'United Nations Memorial Cemetery Pusan' },
  { p: '국군|한국군|國軍', en: 'ROK Army', fr: 'armée sud-coréenne' },
  { p: '인민군|북한군|朝鮮人民軍', en: 'North Korean Army', fr: 'armée nord-coréenne' },
  { p: '미군(?!\\s?정)|美軍|美军', en: 'US Army Korea', fr: 'armée américaine Corée' },
  { p: '해병대|海兵隊', en: 'Marines Korea' },
  { p: '공수\\s?작전|공수\\s?부대|낙하산', en: 'airborne Korea' },
  { p: '상륙정|상륙함', en: 'landing craft Korea' },
  { p: '야전\\s?병원|이동\\s?외과\\s?병원|병원선', en: 'field hospital Korea', fr: 'hôpital Corée' },
  { p: '적십자|赤十字', en: 'Red Cross Korea', fr: 'Croix-Rouge Corée' },
  { p: '구호\\s?물자|구호|원조', en: 'relief Korea' },
  { p: '이산\\s?가족', en: 'separated families Korea' },
  { p: '전사자|전몰자|戰死者', en: 'killed in action Korea' },
  { p: '유해\\s?발굴|유해\\s?송환', en: 'remains recovery Korea' },
  { p: '훈장|무공\\s?훈장|勳章', en: 'decoration medal Korea' },
  { p: '종군\\s?기자', en: 'war correspondents Korea', fr: 'correspondants de guerre Corée' },
  { p: '삐라|선전\\s?전단|전단', en: 'leaflets Korea', fr: 'tracts Corée' },
  { p: '심리전', en: 'psychological warfare Korea' },
  { p: '방송|放送', en: 'radio broadcast Korea' },
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
  { p: '대한제국|大韓帝國|大韓帝国', en: 'Korean Empire', fr: 'Empire de Corée' },
  { p: '맥아더|マッカーサー|麦克阿瑟|Макартур', en: 'MacArthur' },
  { p: '이승만|李承晩|李承晚', en: 'Syngman Rhee' },
  { p: '김일성|金日成', en: 'Kim Il Sung' },
  { p: '압록강|鴨綠江|鸭绿江', en: 'Yalu' },
  { p: '낙동강|洛東江|洛东江', en: 'Naktong' },
  { p: '서울|한양|ソウル|首爾|首尔|漢城|汉城|Сеул|Seúl', en: 'Seoul', fr: 'Séoul' },
  { p: '부산|釜山|Пусан', en: 'Pusan', fr: 'Fusan' },
  { p: '평양|平壌|平壤|Пхеньян', en: 'Pyongyang' },
  { p: '인천|제물포|仁川', en: 'Inchon', fr: 'Chemulpo' },
  { p: '제주|濟州|济州|Чеджу', en: 'Cheju-do', fr: 'Quelpaert' },
  { p: '해방|解放', en: 'Korea liberation 1945', fr: 'Corée libération 1945' },
  { p: '영상|필름|映像|フィルム|视频|кинохроника', en: 'film' },
  { p: '사진|寫真|写真|照片|фотографи\\w*', en: 'photograph', fr: 'photographie' },
  { p: '지도|地圖|地图|карт[аы]\\w*', en: 'map', fr: 'carte' },
  { p: '신문|新聞|新闻|газет\\w*', en: 'newspaper', fr: 'journal' },
  { p: '전투|戦闘|战斗|битва|сражение', en: 'battle', fr: 'bataille' },
  // ── v1.17 증보: 6·25 후기 단계 전투 ──
  { p: '지평리|砥平里', en: 'Chipyong-ni', fr: 'bataillon français Corée Chipyong-ni' },
  { p: '가평\\s?전투|加平', en: 'Kapyong' },
  { p: '노근리|老斤里', en: 'No Gun Ri' },
  { p: '철의\\s?삼각지?대?', en: 'Iron Triangle Korea' },
  { p: '폭찹\\s?힐|폭찹\\s?고지', en: 'Pork Chop Hill' },
  { p: '피의\\s?능선', en: 'Bloody Ridge Korea' },
  { p: '저격\\s?능선|狙擊稜線|狙击岭', en: 'Sniper Ridge Korea' },
  { p: '삼각\\s?고지|상감령|上甘嶺|上甘岭', en: 'Triangle Hill Korea' },
  { p: '금성\\s?전투|金城\\s?戰鬪|金城战役', en: 'Kumsong' },
  { p: '청천강|淸川江|清川江', en: 'Chongchon River' },
  { p: '부산\\s?교두보|워커\\s?라인', en: 'Pusan Perimeter' },
  { p: '피란민|피난민|난민|피란|피난|避難民|避难民|難民|难民|беженц\\w*', en: 'refugees Korea', fr: 'réfugiés Corée' }, // v2.94 실측: '피란민'이 변환되지 않아 해외 채널이 일반 'Korea'만 검색
  { p: '1[·.]4\\s?후퇴', en: 'Seoul evacuation January 1951' },
  { p: '전쟁\\s?고아|고아원|戰爭孤兒|战争孤儿', en: 'war orphans Korea', fr: 'orphelins Corée' },
  { p: '유엔군|국제연합군|국련군|联合国军', en: 'United Nations forces Korea', fr: 'forces ONU Corée' },
  { p: '중공군|인민지원군|志願軍|志愿军', en: 'Chinese forces Korea' },
  { p: '리지웨이|リッジウェイ|李奇微', en: 'Ridgway' },
  { p: '밴\\s?플리트|밴플리트', en: 'Van Fleet' },
  // ── v1.17 증보: 지명 ──
  { p: '원산|元山|Вонсан', en: 'Wonsan' },
  { p: '대구|大邱|Тэгу', en: 'Taegu' },
  { p: '대전\\s?전투|大田', en: 'Taejon' },
  { p: '개성|開城|开城|Кэсон', en: 'Kaesong' },
  { p: '철원|鐵原|铁原', en: 'Chorwon' },
  { p: '금강산|金剛山|金刚山', en: 'Diamond Mountains Korea', fr: 'monts Kumgang' },
  { p: '독도|獨島|独岛|다케시마|竹島', en: 'Dokdo Takeshima Liancourt Rocks' },
  // ── v1.17 증보: 개항기~일제강점기~해방 공간 인물·사건 ──
  { p: '명성황후|명성왕후|민비|閔妃', en: 'Queen Min Korea', fr: 'reine Min Corée' },
  { p: '고종\\s?황제|고종|高宗', en: 'Kojong' },
  { p: '안중근|安重根', en: 'An Jung-geun Ito Hirobumi' },
  { p: '이토\\s?히로부미|伊藤博文', en: 'Ito Hirobumi Korea' },
  { p: '김구|金九', en: 'Kim Koo' },
  { p: '안창호|安昌浩', en: 'Ahn Chang-ho' },
  { p: '3[·.]1\\s?운동|삼일\\s?운동|三一運動|만세\\s?운동', en: 'March First Movement Korea 1919', fr: 'mouvement du 1er mars Corée' },
  { p: '위안부|慰安婦|慰安妇', en: 'comfort women', fr: 'femmes de réconfort' },
  { p: '강제\\s?동원|강제\\s?징용|징용|徵用|征用', en: 'Korean forced labor conscription' },
  { p: '광복군|光復軍|光复军', en: 'Korean Liberation Army' },
  { p: '임시\\s?정부|臨時政府|临时政府', en: 'Korean Provisional Government' },
  { p: '동학|東學|东学|갑오\\s?농민', en: 'Tonghak rebellion', fr: 'Tonghak' },
  { p: '의병|義兵|义兵', en: 'Righteous Army Korea insurgents', fr: 'insurgés Corée' },
  { p: '을사\\s?조약|을사\\s?늑약|乙巳條約', en: 'Japan Korea protectorate treaty 1905' },
  { p: '아관\\s?파천|俄館播遷', en: 'Kojong Russian legation 1896' },
  { p: '헤이그\\s?특사|해아\\s?밀사', en: 'Hague secret emissaries Korea 1907', fr: 'La Haye Corée 1907' },
  { p: '제주\\s?4[·.]3|4[·.]3\\s?사건', en: 'Cheju-do 1948' },
  { p: '여순\\s?사건|여수.순천\\s?사건', en: 'Yosu rebellion 1948' },
  { p: '신탁\\s?통치', en: 'Korea trusteeship', fr: 'tutelle Corée' },
  { p: '미군정|미\\s?군정', en: 'USAMGIK military government Korea' },
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

async function tnaFetch(query, rows = 20, page = 1, yearFrom, yearTo) {
  const u = new URL('https://discovery.nationalarchives.gov.uk/API/search/records');
  u.searchParams.set('sps.searchQuery', query);
  u.searchParams.set('sps.resultsPageSize', String(rows));
  u.searchParams.set('sps.page', String(page));
  // sps.dateFrom/To 실측 검증: Korea 13,533건 → 1950~51 한정 2,553건 (2026-11-18)
  if (yearFrom) u.searchParams.set('sps.dateFrom', `${yearFrom}-01-01`);
  if (yearTo) u.searchParams.set('sps.dateTo', `${yearTo}-12-31`);
  return jget(u.toString());
}
// v1.96.7: TNA Discovery는 단어 전부 일치(AND)·어형 그대로 — 'Korean War prisoners' 41건 vs 'Korea War prisoners' 105건 vs 'Korea POW' 216건(실측).
// 다어절 질의는 표기 변형(Korean↔Korea · prisoners of war↔POW)과 일반어 제거(battle·records 등) 질의를 병행해 합친다.
const TNA_GENERIC = /^(battle|battles|records?|files?|documents?|papers?|the|of|in|and|on|for|a|an)$/i;
function tnaVariants(q) {
  const s = String(q).trim();
  if (!/\s/.test(s) || /"/.test(s) || /^[A-Z]+ \d+(\/\d+)?$/.test(s)) return [s];
  const v = [s];
  const add = (x) => { x = x.replace(/\s+/g, ' ').trim(); if (x && x.split(' ').length >= 1 && !v.includes(x)) v.push(x); };
  const sw = s.replace(/\bKorean\b/g, 'Korea').replace(/\bKoreans\b/g, 'Korea');
  add(sw);
  const pw = (x) => x.replace(/\bprisoners? of war\b/gi, 'POW').replace(/\bprisoners?\b/gi, 'POW').replace(/\bwar POW\b/gi, 'POW');
  if (pw(sw) !== sw) add(pw(sw).replace(/\bKorea War POW\b/, 'Korea POW'));
  const core = sw.split(' ').filter((w) => !TNA_GENERIC.test(w)).join(' ');
  if (core !== sw && core.split(' ').length >= 1) add(core);
  return v.slice(0, 4);
}
// v1.98: 기록 URL → IIIF 매니페스트(기관 IIIF·NARA 브리지·우리 갤러리) — 매니페스트 형식(RiC)·IIIF 형식 공용
const iiifFor = (u, id) => { u = String(u || ''); let x;
  if ((x = String(id || '').match(/^(ksm|portrait|gwaebul|diary|mokgan|jcphoto|arch|design|pattern|oldbook|hyanggyo|stone|gaesong|assay):(\d+)$/))) return bridgeUrl('nrich', `${x[1]}-${x[2]}`); // v2.18 연구DB 이미지 데이터셋 → 국립문화유산연구원 IIIF 브리지
  if ((x = u.match(/catalog\.archives\.gov\/id\/(\d+)/))) return naraUrls(x[1]).manifest;
  if ((x = u.match(/discovery\.nationalarchives\.gov\.uk\/details\/r\/([A-Za-z0-9]{2,20})/))) return tnaUrls(x[1]).manifest; // v2.1: TNA 실제 계층 브리지
  // v1.99: IIIF 브리지 2 — 국가유산(목록 id kdcd-asno-ctcd)·역사박물관(idnbr)·AWM(C-id)·위키미디어(File)
  if (/heritage\.go\.kr/.test(u) && /^\d{2}-[0-9A-Za-z]+-\d{2}$/.test(String(id || ''))) return bridgeUrl('heritage', id);
  if ((x = u.match(/much\.go\.kr\/.*idnbr=([A-Z]{2}[\w-]+)/))) return bridgeUrl('much', x[1]);
  if ((x = u.match(/awm\.gov\.au\/collection\/(C\d+)/))) return bridgeUrl('awm', x[1]);
  if ((x = u.match(/portal\.nrich\.go\.kr\/kor\/(overseasSearchView|ksmUsrView|portraitNdUsrView|buddhaNdUsrView)\.do\S*?(?:mseq|ksm_idx|portrait_idx|buddha_idx)=(\d+)/))) // v2.17 국립문화유산연구원 IIIF 브리지
    return bridgeUrl('nrich', `${{ overseasSearchView: 'ov', ksmUsrView: 'ksm', portraitNdUsrView: 'portrait', buddhaNdUsrView: 'gwaebul' }[x[1]]}-${x[2]}`);
  if ((x = u.match(/commons\.wikimedia\.org\/wiki\/(File(?:%3A|:)[^?#]+)/i))) return bridgeUrl('commons', decodeURIComponent(x[1]).replace(/_/g, ' '));
  if ((x = u.match(/korea-archive-mcp\/iiif\.html#(s\d+)/))) return `https://changgi.github.io/korea-archive-mcp/iiif/m/${x[1]}.json`;
  if ((x = u.match(/archive\.org\/details\/([^/?#]+)/))) return `https://iiif.archive.org/iiif/3/${x[1]}/manifest.json`;
  if ((x = u.match(/europeana\.eu\/(?:[a-z]{2}\/)?item\/([^/]+)\/([^/?#]+)/))) return `https://iiif.europeana.eu/presentation/${x[1]}/${x[2]}/manifest`;
  if (/gallica/.test(u) && (x = u.match(/ark:\/12148\/([a-z0-9]+)/i))) return `https://gallica.bnf.fr/iiif/ark:/12148/${x[1]}/manifest.json`;
  if ((x = u.match(/dl\.ndl\.go\.jp\/pid\/(\d+)/))) return `https://dl.ndl.go.jp/api/iiif/${x[1]}/manifest.json`;
  return ''; };
const tnaLine = (r) => `- [${r.reference || '?'}] ${(r.title || r.description || '').replace(/<[^>]+>/g, '').slice(0, 110)} (${r.coveringDates || ''}) https://discovery.nationalarchives.gov.uk/details/r/${r.id}`;

// ══════════ 상호보완 다중채널 수집 (concurrent collect + merge/dedup) ══════════
const norm = (s) => (s == null ? '' : String(s)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const dedupKey = (it) => norm(it.title).toLowerCase().replace(/[^a-z0-9가-힣一-鿿]/g, '').slice(0, 50) + '|' + (it.id || '');
// run collectors concurrently; merge, dedup by title|id, union the source tags (상호보완: 한 record를 여러 채널이 확인)
const mclean = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); // v1.93: 모듈 범위 HTML 정리(도구 범위 dclean 미노출 대응)
// v1.96.3: Europeana 원본 이미지 직링크(edmIsShownBy) — 제공기관 링크 부패 교정(Náprstek esbirky img.php·detail → /predmet/{id}, 2026-11 실측 404)
const euMedia = (it) => { let u = String(((it.edmIsShownBy || [])[0]) || ''); const m = u.match(/esbirky\.cz\/(?:img\.php\?id=|detail\/)(\d+)/); if (m) u = `https://www.esbirky.cz/predmet/${m[1]}`; return u; };
// v1.93: Gallica(gallica.bnf.fr)가 서버 IP 자동 조회를 403 차단 — BnF 공식 카탈로그 SRU(catalogue.bnf.fr/api/SRU, 같은 BnF 소장 기록)로 폴백.
// UNIMARC 200$a 표제·210/214$d 연대·215$a 수량·856$u Gallica 원문 ark — 기록 수집은 계속되고, 원문(Gallica) 링크도 함께 준다.
// v2.23 data.bnf.fr 공식 개방데이터 SPARQL — Gallica SRU는 서버 IP 403, 카탈로그(catalogue.bnf.fr)는 연결 불가(2026-11-23 실측)일 때 우선 경로. 제목 전문검색 + Gallica 원문 링크
async function bnfSparql(q, n) {
  const words = String(q).replace(/["'\\{}<>]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !/^\d+$/.test(w)).slice(0, 4); if (!words.length) return [];
  const sp = `PREFIX dcterms: <http://purl.org/dc/terms/> PREFIX rdarel: <http://rdvocab.info/RDARelationshipsWEMI/> SELECT ?m ?title ?date ?g WHERE { ?m dcterms:title ?title . ?title bif:contains "${words.map((w) => `'${w}'`).join(' AND ')}" . OPTIONAL { ?m dcterms:date ?date } OPTIONAL { ?m rdarel:electronicReproduction ?g } } LIMIT ${Math.min(60, n * 4)}`;
  const j = await jget(`https://data.bnf.fr/sparql?query=${encodeURIComponent(sp)}&format=${encodeURIComponent('application/json')}`, { 'User-Agent': UA });
  const seen = new Set(); const out = [];
  for (const b of ((j.results || {}).bindings || [])) { const m = (b.m || {}).value || ''; if (!m || seen.has(m)) continue; seen.add(m);
    const ark = (m.match(/ark:\/12148\/[A-Za-z0-9]+/) || [])[0] || ''; const gal = (((b.g || {}).value) || '').replace(/^http:/, 'https:');
    out.push({ title: String((b.title || {}).value || '(무제)').slice(0, 160), date: (b.date || {}).value || '', id: ark, gallica: gal.includes('gallica.bnf.fr') ? gal : '', series: 'BnF › data.bnf.fr', url: (gal.includes('gallica') ? gal : '') || m.replace(/#about$/, '') }); }
  out.sort((x, y) => (y.gallica ? 1 : 0) - (x.gallica ? 1 : 0)); return out;
}
async function bnfCatalog(q, n, doctype) {
  if (doctype === undefined || doctype === '') {
    try { const sp = await bnfSparql(q, n); if (sp.length) return { total: sp.length, items: sp.slice(0, n), via: 'data.bnf.fr' }; } catch { /* SPARQL 실패 → 카탈로그 */ } // v1.93.1: 사진·도판(doctype i) 질의를 병행 — 디지털화(Gallica 원문) 자료가 상위에 오도록
    const [a, b] = await Promise.allSettled([bnfCatalog(q, n, 'i'), bnfCatalog(q, n, null)]);
    const A = a.status === 'fulfilled' ? a.value : { total: 0, items: [] }, B = b.status === 'fulfilled' ? b.value : { total: 0, items: [] };
    if (a.status !== 'fulfilled' && b.status !== 'fulfilled') throw b.reason;
    const seen = new Set(); const all = [...A.items, ...B.items].filter((it) => !seen.has(it.id) && seen.add(it.id));
    if (!all.length) { // v1.96.3: 'all' CQL은 모든 단어 일치 — 0건이면 숫자·짧은 단어를 빼고 핵심어 2개로 완화(실측: 'Corée 1866 expédition' 0건)
      const words = String(q).split(/\s+/).filter((w) => w && !/^\d+$/.test(w) && w.length > 2);
      const q2 = words.slice(0, 2).join(' ');
      if (q2 && q2 !== String(q).trim()) { const r2 = await bnfCatalog(q2, n); return { ...r2, relaxed: q2 }; }
    }
    all.sort((x, y) => (y.gallica ? 1 : 0) - (x.gallica ? 1 : 0));
    return { total: Math.max(A.total, B.total), items: all.slice(0, n) };
  }
  const cql = `bib.anywhere all "${String(q).replace(/"/g, '')}"` + (doctype ? ` and bib.doctype any "${doctype}"` : '');
  const xml = await gtext(`https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=unimarcXchange&maximumRecords=20`, { 'User-Agent': UA });
  const total = (xml.match(/numberOfRecords>(\d+)</) || [])[1];
  if (total === undefined) throw new Error('BnF 카탈로그 응답 형식 아님');
  const items = xml.split('<srw:record>').slice(1).map((b) => {
    const sf = (tag, code) => { for (const m of b.matchAll(new RegExp(`tag="${tag}"[^>]*>([\\s\\S]*?)</mxc:datafield>`, 'g'))) { const s = m[1].match(new RegExp(`code="${code}">([^<]*)<`)); if (s) return s[1].trim(); } return ''; };
    const ark = (b.match(/id="(ark:\/12148\/[^"]+)"/) || [])[1] || '';
    const gal = (b.match(/(https?:\/\/gallica\.bnf\.fr\/ark:\/12148\/[A-Za-z0-9]+)/) || [])[1] || '';
    const typ = sf('200', 'b');
    return { title: (sf('200', 'a') || '(무제)').replace(/^\[|\]$/g, '').slice(0, 160), date: sf('210', 'd') || sf('214', 'd'), id: ark, extent: sf('215', 'a'), type: typ, gallica: gal,
      ...(typ ? { series: `BnF › ${typ}` } : {}), url: gal || (ark ? `https://catalogue.bnf.fr/${ark}` : '') };
  });
  items.sort((x, y) => (y.gallica ? 1 : 0) - (x.gallica ? 1 : 0)); // Gallica 원문(디지털화) 있는 기록 우선
  return { total: Number(total), items: items.slice(0, n) };
}
// v1.93: 정보공개포털 상태 실측 — 2026-11-12부터 원문정보·목록 메뉴 '점검 중'(JSON 백엔드 없음), 서울정보소통광장은 연결 시간 초과.
// 막힌 사실과 기간을 그대로 알리고, 점검 중에도 가능한 경로(기관에 정보공개청구 · 신청내역조회)를 안내한다.
async function openGoStatus(q) {
  try {
    const b = await gtext('https://www.open.go.kr/othicInfo/infoList/orginlInfoList.do?searchKeyword=' + encodeURIComponent(q || ''), { 'User-Agent': UA });
    const t = mclean(b);
    if (/메뉴 점검|점검 중인 메뉴/.test(t)) {
      const per = (t.match(/제한 기간\s*([^.]*?\d{4}\.\d{1,2}\.\d{1,2}\.[^재]{0,30})/) || [])[1] || '';
      return { maint: true, msg: `정보공개포털 원문정보 메뉴 점검 중${per ? `(제한 기간 ${per.trim()})` : ''} — 포털 공지: 점검 기간에도 자료 보유 기관에 정보공개청구 가능, 진행은 '신청내역조회'에서 확인` };
    }
    return { maint: false, msg: '' };
  } catch (e) { return { maint: false, msg: `정보공개포털 응답 실패(${e.message})` }; }
}
// v1.95: 국가유산 원본 이미지 — 상세 API imageUrl + 이미지 목록 API(SearchImageOpenapi: sn·imageUrl·ccimDesc). 원본을 '찾아 쓰게' 직링크 제공
async function heritageImages(kdcd, asno, ctcd, main) {
  const urls = []; if (main) urls.push([main.replace(/^http:\/\/www\.khs\.go\.kr/, 'https://www.khs.go.kr'), '대표 이미지']);
  try {
    const b = await cachedText(`heriI:${kdcd}|${asno}|${ctcd}`, 24 * 3600e3, () => gtext(`https://www.khs.go.kr/cha/SearchImageOpenapi.do?ccbaKdcd=${kdcd}&ccbaAsno=${asno}&ccbaCtcd=${ctcd}`), '<');
    const ims = [...b.matchAll(/<imageUrl>(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?<\/imageUrl>/g)].map((m) => m[1]);
    const ds = [...b.matchAll(/<ccimDesc>(?:<!\[CDATA\[)?\s*([^<\]]*?)\s*(?:\]\]>)?<\/ccimDesc>/g)].map((m) => m[1]);
    ims.map((u) => u.replace(/^http:\/\/www\.khs\.go\.kr/, 'https://www.khs.go.kr')).forEach((u, i) => { if (!urls.some(([x]) => x === u)) urls.push([u, ds[i] || '']); });
  } catch { /* 목록 API 실패 — 대표 이미지만 */ }
  if (!urls.length) return '';
  return `【원본 이미지 ${urls.length}점】\n` + urls.slice(0, 10).map(([u, d], i) => `${i + 1}. ${u}${d ? ` — ${d.slice(0, 50)}` : ''}`).join('\n') + '\n';
}
const titleCut = (t) => { const m = String(t).match(/^\[[^\]]{0,160}\] /); return m ? m[0] + t.slice(m[0].length, m[0].length + 95) : String(t).slice(0, 95); }; // v2.93 앞 꼬리표([원장 발견 횟수·순위 …])는 95자 몫에서 빼고 실제 제목을 95자까지
const QUICK_PROFILES = {"nrich": ["국립문화유산연구원 국가유산 지식이음", "cross_search(sources=nrich) · nedb_search(mode='nrich') — 국외문화유산 DB 12,569건(명칭·시대·소장처·국가) + 발간자료 Open API(보고서·초록·목차·연구분야·공공누리 유형, 무키)", "nedb_search(mode='nrich', query='ov:번호'|'rep:번호'|상세 URL) — 계층 국외문화유산 › 국가 › 소장처 / 발간자료 › 연구분야. 국외소재문화유산 조사(1992~, 3만 7천여 점·보고서 36권) https://www.nrich.go.kr/kor/page.do?menuIdx=336", "대부분 공공누리 제4유형(출처표시·비상업·변경금지 — 원형 그대로). robots Allow. 정직 UA, 상세 24h 캐시. okchf와 교차확인"], "okchf": ["국외소재문화유산재단 대국민 아카이브", "cross_search(sources=okchf) · nedb_search(mode='okchf') — 국외문화유산 6천여 건·사진아카이브 1,800여 건(통합검색), 상세=소장국가·소장처·관리번호·소장경위·시대·재질·크기·출판정보·설명", "nedb_search(mode='okchf', query=<상세 URL>) — 계층 유형 › 소장국가 › 소장처 · 발간 보고서(국외 소장 한국문화재 조사보고서) https://www.overseaschf.or.kr/okchf/data/US_DF_PD.do", "소장기관과 공개 협의된 정보 — 이미지·설명 게재는 재단·소장처 이용조건 확인(허가 전 링크만). 접근: robots.txt 전체 Disallow(표시 — 발굴 우선 원칙), 정직 UA·요청 최소"], "ledger": ["KOREA ARCHIVE 발견 누적 원장", "cross_search(sources=ledger) — 사용자들이 도구로 이미 발굴한 기록(매일 누적 · 발견 경로로 질의·회신 원문과 연결)", "https://changgi.github.io/korea-archive-mcp/data/ — CSV·JSONL·RiC-O·IIIF 컬렉션(최근 300건 KV) · 새 발견 구독 feed.xml(Atom) · 인용 records.csl.json(Zotero)·records.ris(EndNote)·records.bib(BibTeX) · 하베스터 records.oai_dc.xml(OAI-PMH Dublin Core) · 자동 점검 질의·회신 queries/probe/(활용 집계와 분리) · 데이터 목록 catalog.jsonld(DCAT·schema.org Dataset — 포털·검색엔진 수집) · 기록별 영구 페이지 r/<slug>.html(맥락·증거·IIIF·권리·인용문, schema.org — 색인 r/index.json)·기계 판독 r/<slug>.json(원장 항목·관계·인용)·sitemap.xml · 연대 timeline.json · 계층 tree.html·분류 classifications.json · 기록↔기록 맥락 연결 relations.json(같은 기록·같은 날·같은 계열, 관계마다 근거 — 기록 페이지 관련 기록 칸) · 발견 경로 provenance.json · 질의별 발굴 기록 q/<질의 지문>.json(IIIF 컬렉션 — 질의 한 건 = 기록물 한 건)·q/index.html · 질의·회신 queries/ · 주제 색인 subjects.html·subjects.json(기관 주제어·지명·분류·시대·매체 패싯) · SKOS 개념 체계 subjects.jsonld(RiC-O 기록이 rico:hasOrHadSubject·isAssociatedWithPlace로 연결) · 데이터 품질 추이 quality.json(항목별 채움률 일별) · 기록마다 권리 표시+근거(rights_view·rights_basis) · 일일 기록물 등록부 records/(산출물 SHA-256·직전 등록부 해시 사슬 — 위변조·소실 검증) · SHA256SUMS", "원 기관 권리 표기를 따름 — 발견 횟수·처음 발견일 표시, 'all'에는 포함되지 않음(명시 호출)"], "gallery": ["KOREA ARCHIVE IIIF 갤러리", "cross_search(sources=gallery) — 30곳 탐방·100선 실물 기록 800장(권리 확인 완료)", "iiif.html#sNNN/k 딥줌 · iiif/m/sNNN.json 매니페스트 · cross_search format='iiif'로 컬렉션 합류", "이미지별 권리 표시(공공누리 제4유형은 원본 무변경) — 출처 대장 기반"], "jacar": ["일본 아시아역사자료센터 JACAR", "cross_search(sources=jacar) — 한→일 변환·레퍼런스코드", "nedb_search(mode=jacar, 'A0401…') 상세 + ±8×100 인접 채굴, 원본 PDF는 国立公文書館 뷰어", "JACAR 이용약관: 출처(센터·소장관·레퍼런스코드) 표기 조건 2차 이용 원칙 허용"], "earchive": ["국사편찬위원회 전자사료관", "cross_search(sources=earchive)", "nedb_search(mode=earchive, '키워드|순번') — 열람·이용조건·등록번호", "사료별 이용조건 표기(공개/제한적 이용) — 원 소장처 권리 확인"], "awm": ["호주 전쟁기념관 AWM", "cross_search(sources=awm) — 최대 10건 상세", "awm.gov.au/collection/C… 페이지(공개 이미지 최대 640px)", "'Copyright expired - public domain' 표기분만 게재"], "nlna": ["네덜란드 국립문서보관소", "cross_search(sources=nlna) — 문서군(inventaris)", "사진은 Europeana dataset 1417 → nationaalarchief.nl 원본(TIFF 16비트 주의)", "Anefo 등 CC0/Publiek Domein 다수 — 사진별 확인"], "dnz": ["디지털NZ DigitalNZ", "cross_search(sources=dnz) — NZ 30여 기관 집계", "각 제공기관 페이지(usage·rights 필드)", "재이용 표기(No known restrictions·CC) 확인 — Papers Past 1950년대는 usage Unknown 다수"], "nzarch": ["뉴질랜드 기록원 Archives NZ", "cross_search(sources=nzarch) — 라이브 실패 시 주간 정적 인덱스", "nedb_search(mode=nzarch, 'R22438362') — R번호 상세", "기록별 접근 상태(Open 등) — 본 사이트는 봇 차단(Incapsula)"], "commons": ["위키미디어 공용", "cross_search(sources=commons)", "nedb_search(mode=commons, File URL) — 라이선스·원 소장처, NARA 번호면 원본 자동 대조", "업로더 표기는 2차 정보 — 원 소장처 카탈로그로 확정"], "un": ["UN 디지털도서관", "cross_search(sources=un) — 문서기호 시리즈", "nedb_search(mode=un, recid) — 요약·주제·PDF 6개 언어", "UN 공식문서는 퍼블릭 도메인(ST/AI/189/Add.9/Rev.2)"], "ndl": ["일본 국립국회도서관 NDL", "cross_search(sources=ndl) — 당대 자료(~1945) 우선", "dl.ndl.go.jp IIIF(<pid>/R<7자리>) — 'Access Restrictions: PDM' 확인", "PDM(보호기간 만료) 표기분 자유 이용 · 동시 요청 시 429"], "i815": ["독립기념관 한국독립운동정보시스템", "cross_search(sources=i815)", "nedb_search(mode=i815, 상세 URL) 본문 · '사전:이름' 인명사전", "공공누리 표시 없는 원문이미지는 사전 협의 대상(041-560-0445)"], "gonghun": ["공훈전자사료관(국가보훈부)", "cross_search(sources=gonghun) — 이름", "nedb_search(mode=gonghun, mngNo) — 공적조서·공훈록 전문", "공훈록 텍스트 인용 시 출처 표기 · 인물 사진은 수형 사진 제외"], "ktv": ["KTV e영상역사관", "cross_search(sources=ktv) — 기록 탭(대한뉴스·문화영화·사진집) 병합", "nedb_search(mode=ktv, view URL) — 영상 해설 / 사진 판독(공공누리 유형·원본 경로)", "사진은 표시 유형대로(4유형=원형) · 영상 무표시분은 KTV 나누리 신청"], "oldnews": ["대한민국신문아카이브(국립중앙도서관)", "cross_search(sources=oldnews) — 단일 핵심어가 잘 걸림(띄어쓴 다어절은 완화 재검색)", "nedb_search(mode=oldnews, CNTS-…) 색인어 · '본문:…|연대' OCR", "1946년 이전 지면 보호기간 만료 — 국립중앙도서관 출처 표기"], "much": ["대한민국역사박물관 근현대사아카이브", "cross_search(sources=much)", "nedb_search(mode=much, idnbr) — 재질·크기·공공누리 유형·원본 이미지 링크", "공공누리 유형(4유형=변경금지·비상업) 준수"], "indy": ["국가기록원 독립운동판결문", "cross_search(sources=indy) — 이름(동명이인 주의)", "nedb_search(mode=indy, 상세 URL) — 죄명·주문·사건개요·원문 뷰어", "판결문은 저작권법 제7조 비보호 저작물 — 국가기록원 출처 표기"], "heritage": ["국가유산청 국가유산포털", "cross_search(sources=heritage) — 지정 종목", "nedb_search(mode=heritage, 'kdcd-asno-ctcd') — 해설·원본 이미지 목록", "사진은 공공누리 유형 확인 후 이용"], "kyudb": ["서울대 규장각한국학연구원", "cross_search(sources=kyudb)", "nedb_search(mode=kyujanggak) — 목록+해제(절목류는 해제에서)", "원문 이미지 게재는 기관 허가(02-880-5316)"], "jsg": ["한국학중앙연구원 장서각", "cross_search(sources=jsg)", "nedb_search(mode=jsg, K2-…) — 서지·해제 전문", "이미지 게재는 공문 신청·허가 대상"], "aks": ["한국고문서자료관", "cross_search(sources=aks) — 172개 소장처", "nedb_search(mode=aks) — 소장처→분류→문서 면", "사이트 재이용 조건 미표기 — 게재 전 기관 확인"]}; // v1.96.4: 상세 프로파일이 없는 18곳의 간이 프로파일(검색 경로·상세 판독·권리)
const SOURCE_TIMEBOX_MS = 12000; // 소스별 타임박스 — 최저속(차단 대기) 소스가 전체 지연을 지배하지 않게 (실측 21.7s → ~12s)
// v1.89: 원본 확인 — 재게시·재수집본의 sameAs NAID가 결과에 없으면 NARA 카탈로그를 직접 조회해 원본 실재를 확인하고 계보·날짜·매체를 채운다(최대 4건·6s·24h 캐시)
async function resolveOrigins(items, stats) {
  const key = process.env.NARA_API_KEY; if (!key) return;
  const todo = items.filter((it) => !it.sources.some((s) => s.startsWith('nara')) && /^NAID \d+$/.test(it.sameAs || '')).slice(0, 4);
  if (!todo.length) return;
  let ok = 0;
  await Promise.race([Promise.all(todo.map(async (it) => {
    try {
      const naid = it.sameAs.slice(5);
      const raw = await cachedText('naid:' + naid, 24 * 3600e3, () => gtext(`https://catalog.archives.gov/api/v2/records/search?naId=${naid}&limit=1`, { Accept: 'application/json', 'x-api-key': key }), '"naId"');
      const rec = (((((JSON.parse(raw).body || {}).hits || {}).hits) || [])[0] || { _source: {} })._source.record;
      if (!rec || String(rec.naId) !== naid) return; // 원본 미확인 — 연결 정보만 유지
      const link = `${it.sources[0].split('·')[0]}:${it.id || it.url}`;
      if (norm(rec.title).toLowerCase() !== norm(it.title).toLowerCase()) it.altTitle = it.title.slice(0, 110);
      it.title = norm(rec.title || it.title); it.id = `NAID ${naid}`; it.url = `https://catalog.archives.gov/id/${naid}`; it.sameAs = link;
      const po = naraChain(rec); if (po) it.series = po;
      if (!it.date) it.date = naraDate(rec);
      const d0 = String((((rec.digitalObjects || [])[0]) || {}).objectUrl || ''); if (!it.media && d0) it.media = d0;
      it.sources.unshift('nara·원본확인'); ok++;
    } catch { /* 조회 실패 — 연결 정보만 유지 */ }
  })), sleep(6000)]);
  if (ok) stats.push(`nara원본확인:${ok}`);
}
// v2.37 e영상역사관(ehistory.go.kr) 자체 목록 검색 — 분류 목록 페이지가 GET search_type·search_text로 걸러진 타일(제목·제작연도·호수·썸네일·상세 링크)을 준다
const EH = 'https://www.ehistory.go.kr';
const EH_LISTS = [['koreanews/korea_news', '대한뉴스'], ['koreanews/korea_newskc', '미공개 대한뉴스'], ['movie/culture', '문화영화'], ['photo/government', '정부기록사진집'], ['photo/nation', '국가기록사진'], ['photo/korea', '한국소개사진'], ['movie/president', '대통령기록영상']]; // 분류명은 각 페이지 제목 그대로(2026-11-24 실측)
async function ehistoryList(path, label, q) {
  {
    const b = await cachedText(`eh:${path}:${q}`, 6 * 3600e3, () => gtext(`${EH}/${path}?search_type=all&search_text=${encodeURIComponent(q)}`), 'tileList');
    const out = [];
    for (const li of b.split('<li>').slice(1)) {
      const m = li.match(/<a href="(\/view\/(?:movie|photo)\?[^"]+)"/); const t = (li.match(/<strong class="title">([\s\S]*?)<\/strong>/) || [])[1];
      if (!m || !t) continue;
      const dl = norm(((li.match(/<span class="date">([\s\S]*?)<\/span>\s*<\/div>/) || [])[1] || '').replace(/<[^>]+>/g, ' '));
      const yr = (dl.match(/(1[89]\d\d|20\d\d)(?:[.년]\s*(\d{1,2}))?(?:\.(\d{1,2}))?/) || []);
      const no = (dl.match(/(\d{2,4})호/) || [])[1];
      const img = (li.match(/<img src="([^"]+)"/) || [])[1];
      const title = norm(t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
      out.push({ title: `${title}${no ? ` (${no}호)` : ''}`.slice(0, 120), date: yr[1] ? [yr[1], yr[2] && yr[2].padStart(2, '0'), yr[3] && yr[3].padStart(2, '0')].filter(Boolean).join('-') : '',
        id: (m[1].match(/mediadtl=(\d+)/) || [])[1] ? `${label}:${(m[1].match(/mediadtl=(\d+)/) || [])[1]}` : '', series: label, url: EH + m[1].replace(/&amp;/g, '&'), ...(img ? { media: (img.startsWith('http') ? '' : EH) + img } : {}) });
    }
    return out;
  }
}
async function ehistorySearch(q, n) {
  // 질의에 분류명(대한뉴스·문화영화…)이 있으면 그 분류만, 나머지 낱말로 검색. 여러 낱말이 0건이면 첫 낱말로 한 번 더
  const toks = String(q).split(/\s+/).filter(Boolean); const cats = EH_LISTS.filter(([, l]) => toks.includes(l) || toks.includes(l.replace(/\s/g, '')));
  const kw = toks.filter((t) => !EH_LISTS.some(([, l]) => l === t || l.replace(/\s/g, '') === t)).join(' ');
  if (cats.length && kw && kw !== q) return ehistorySearchIn(cats, kw, n);
  const r0 = await ehistorySearchIn(EH_LISTS, q, n);
  return r0.length || toks.length < 2 ? r0 : ehistorySearchIn(EH_LISTS, toks[0], n);
}
async function ehistorySearchIn(L, q, n) {
  const one = async ([path, label]) => ehistoryList(path, label, q);
  const res = await Promise.allSettled(L.map(one));
  const lists = res.map((r) => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set(); const out = [];
  for (let k = 0; k < 20 && out.length < n; k++) for (const l of lists) { const it = l[k]; if (!it || seen.has(it.url) || out.length >= n) continue; seen.add(it.url); out.push(it); }
  return out;
}
const ktvTotalSearch = (q, n) => COLLECT._ktvLegacy(q, n);

async function collectMerged(collectors) {
  const boxed = (fn) => Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timebox 12s')), SOURCE_TIMEBOX_MS))]);
  const settled = await Promise.allSettled(collectors.map((c) => boxed(c.fn)));
  const map = new Map(); const stats = [];
  settled.forEach((r, i) => {
    const name = collectors[i].source;
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      stats.push(`${name}:${r.value.length}${!r.value.length && UA_REFUSED[name] ? '⛔정직UA거부' : ''}`);
      for (const raw of r.value) {
        if (!raw || !norm(raw.title)) continue;
        const k = dedupKey({ ...raw });
        if (map.has(k)) { const e = map.get(k); if (!e.sources.includes(name)) { e.sources.push(name); if (!e.url && raw.url) e.url = raw.url; } }
        else map.set(k, { title: norm(raw.title), date: raw.date || '', id: raw.id || '', url: raw.url || '', ...(raw.series ? { series: String(raw.series).slice(0, 80) } : {}), ...(raw.media ? { media: String(raw.media).slice(0, 600) } : {}), ...(raw.sameAs ? { sameAs: String(raw.sameAs) } : {}), ...(raw.lid ? { lid: String(raw.lid) } : {}), ...(raw.note ? { note: String(raw.note).slice(0, 300) } : {}), sources: [name] });
      }
    } else stats.push(`${name}:—${UA_REFUSED[name] ? '⛔정직UA거부' : ''}`);
  });
  // v1.86: 동일 기록 병합 — sameAs(원본 식별자)가 다른 레코드의 id와 같으면 한 건으로 합치고 출처를 모두 남긴다(제목 언어가 달라도 교차확인)
  const items = [...map.values()];
  const byId = new Map(items.filter((it) => it.id).map((it) => [String(it.id), it]));
  for (const it of items) if (it.lid && !byId.has(it.lid)) byId.set(it.lid, it);
  for (const it of items) { const fb = (String(it.media || '').match(/\/(\d{2,3}[a-z]?-[a-z]{1,6}-\d+[a-z]?)(?:_\d+)?\.\w+$/i) || [])[1]; if (fb && it.sources.some((s) => s.startsWith('nara')) && !byId.has('NARA ' + fb.toUpperCase())) byId.set('NARA ' + fb.toUpperCase(), it); } // v1.91.2: NARA 디지털 객체 파일명(428-npc-171.mp4)으로도 대조 // NARA 고유번호(127-N-A4560형)로도 대조 — 실재할 때만 병합
  const drop = new Set();
  for (const it of items) {
    const tgt = it.sameAs && byId.get(it.sameAs);
    if (!tgt || tgt === it) continue;
    for (const s of it.sources) if (!tgt.sources.includes(s)) tgt.sources.push(s);
    const link = `${it.sources[0].split('·')[0]}:${it.id || it.url}`; // 복수 기관 연결은 누적(덮어쓰기 금지)
    tgt.sameAs = tgt.sameAs && tgt.sameAs !== link ? `${tgt.sameAs} | ${link}` : link;
    if (!tgt.altTitle && norm(it.title).toLowerCase() !== norm(tgt.title).toLowerCase()) tgt.altTitle = it.title.slice(0, 110); // 다른 기관 제목(언어가 다르면) 보존
    if (!tgt.date && it.date) tgt.date = it.date;
    if (!tgt.media && it.media) tgt.media = it.media; // 원본에 매체가 없으면 재게시본 원본 파일 승계
    drop.add(it);
  }
  return { items: items.filter((it) => !drop.has(it)), stats };
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

// ── 한국고문서자료관(한국학중앙연구원, archive.aks.ac.kr) — 소장처 172곳 (2026-11-17 treeAjax 전수 실측) ──
// 형식: id|상위경로(upPath)|분류|소장처명. 트리·문서목록은 라이브 조회, 이미지 일괄 수집은 로컬 전용.
const AKS_BASE = 'https://archive.aks.ac.kr';
const AKS_UA = { 'User-Agent': UA, 'Referer': AKS_BASE + '/viewer/viewer.do' }; // v2.36 정직 UA
const AKS_CAT = `L011146|01^0111|문중>서울특별시|서울 마포 반남박씨 대종중
L011143|01^0111|문중>서울특별시|서울 마포 성주이씨 대종회
L011144|01^0111|문중>서울특별시|서울 원주김씨 두암 김응남 종가
L011148|01^0111|문중>서울특별시|서울 전주이씨 경녕군 후손가
L011145|01^0111|문중>서울특별시|서울 전주이씨 장천군 이보생 후손가
L011117|01^0111|문중>서울특별시|서울 진주류씨 우강 유태영 후손가
L016909|01^0169|문중>대구광역시|대구 영천이씨 세효당 후손가
L013003|01^0130|문중>대전광역시|대전 무수동 안동권씨 유회당 권이진 종가
L013001|01^0130|문중>대전광역시|대전 회덕 은진송씨 동춘당 송준길 후손가
L014151|01^0141|문중>경기도|광주 기곡 광주안씨 순암 안정복 종가
L014160|01^0141|문중>경기도|광주 연안이씨 매간 이익상 종가
L014158|01^0141|문중>경기도|광주 평산신씨 신대우
L014153|01^0141|문중>경기도|군포 속달 동래정씨 동래부원군 정난종 종가
L014140|01^0141|문중>경기도|김포 의령남씨 서윤공 남두장 후손가
L014156|01^0141|문중>경기도|김포 전주이씨 효헌 이인철 후손가
L014139|01^0141|문중>경기도|성남 해주오씨 월곡공파 오윤함
L014163|01^0141|문중>경기도|시흥 반남박씨 금계군 박동량 종가
L014132|01^0141|문중>경기도|안산 부곡 진주류씨 경성당
L014115|01^0141|문중>경기도|안성 보체 동래정씨 정홍순 종가
L014131|01^0141|문중>경기도|안성 해주오씨 오치풍 후손가
L014154|01^0141|문중>경기도|양근 안동김씨 노가재 김창업 후손가
L014161|01^0141|문중>경기도|양주 광주정씨
L014168|01^0141|문중>경기도|양주 사릉 해주정씨 종가
L014164|01^0141|문중>경기도|여주 산북 전주이씨 완양부원군 이충원 종가
L014148|01^0141|문중>경기도|여흥민씨 민영환 후손가
L014152|01^0141|문중>경기도|용인 해주오씨 추탄 오윤겸 종가
L014167|01^0141|문중>경기도|의정부 장암 반남박씨 서계 박세당 종가
L014166|01^0141|문중>경기도|의정부 장암 반남박씨 서계 박세당 후손가
L014165|01^0141|문중>경기도|이천 풍천임씨
L014303|01^0143|문중>충청북도|제천 한수 연안이씨
L014423|01^0144|문중>충청남도|공주 안동김씨 청음 김상헌 후손가
L014421|01^0144|문중>충청남도|공주 전주이씨 숭선군파 종가
L014422|01^0144|문중>충청남도|공주 진주류씨 금사 유충걸 후손가
L014418|01^0144|문중>충청남도|논산 노성 파평윤씨 명재 윤증 종가
L014426|01^0144|문중>충청남도|보령 천궁 경주김씨 직각 김면주 종가
L014425|01^0144|문중>충청남도|부여 은산 함양박씨 구당 박세영 종가
L014429|01^0144|문중>충청남도|서산 대교 경주김씨 충민공 김홍익 후손가
L014432|01^0144|문중>충청남도|서산 대교 경주김씨 학주 김홍욱 종가
L014433|01^0144|문중>충청남도|서산 대교 경주김씨 학주 김홍욱 후손가
L014430|01^0144|문중>충청남도|아산 선교 장흥임씨 종가
L014427|01^0144|문중>충청남도|예산 한곡 한산이씨 수당 고택
L014431|01^0144|문중>충청남도|예산 한양조씨
L014428|01^0144|문중>충청남도|청양 안동김씨 삼당 김영 후손가
L014738|01^0147|문중>전북특별자치도|고창 광산김씨 노산사
L014734|01^0147|문중>전북특별자치도|고창 신천강씨
L014724|01^0147|문중>전북특별자치도|고창 흥덕 평해황씨 이재 황윤석 종가
L014731|01^0147|문중>전북특별자치도|남원 안터 순흥안씨 사제당 안처순 후손가
L014722|01^0147|문중>전북특별자치도|남원·구례 삭녕최씨
L014720|01^0147|문중>전북특별자치도|부안 우반 부안김씨
L014735|01^0147|문중>전북특별자치도|익산 함열 임천조씨
L014736|01^0147|문중>전북특별자치도|정읍 광산김씨 김흥암 후손가
L014737|01^0147|문중>전북특별자치도|정읍 광산김씨 옥산서원
L014719|01^0147|문중>전북특별자치도|진안 정천 전주이씨 서곡 이정영 후손가
L014804|01^0148|문중>전라남도|구례 오미 문화류씨 운조루
L014803|01^0148|문중>전라남도|나주 회진 나주임씨 창계 임영 후손가
L014810|01^0148|문중>전라남도|영광 연안김씨 종가
L014802|01^0148|문중>전라남도|영광 영월신씨
L014812|01^0148|문중>전라남도|영암 남평문씨
L014813|01^0148|문중>전라남도|해남 김해김씨
L014811|01^0148|문중>전라남도|해남 연동 해남윤씨 녹우당
L016792|01^0167|문중>경상북도|경주 구정 경주이씨
L016722|01^0167|문중>경상북도|경주 소정 경주이씨
L016762|01^0167|문중>경상북도|경주 양동 경주손씨 종가 송첨
L016712|01^0167|문중>경상북도|경주 옥산 여주이씨 독락당
L016794|01^0167|문중>경상북도|경주 옥산 여주이씨 치암 이순 종가
L016798|01^0167|문중>경상북도|경주 용산서원
L016706|01^0167|문중>경상북도|경주 이조 경주최씨
L016727|01^0167|문중>경상북도|고령 도진 고령박씨 소윤공 문연재
L016763|01^0167|문중>경상북도|고령 선산김씨 점필재 김종직 종가
L016768|01^0167|문중>경상북도|구미 옥산 인동장씨 여헌 장현광 종가
L016746|01^0167|문중>경상북도|김천 성산이씨 양계 이하 종가
L016724|01^0167|문중>경상북도|김천 진주강씨 학암 강석귀 종가
L016744|01^0167|문중>경상북도|봉화 꽃내 무안박씨 회이당 박한 종가
L016725|01^0167|문중>경상북도|봉화 법전 진주강씨 고암 강임 후손가
L016775|01^0167|문중>경상북도|봉화 유곡 안동권씨 충재 권벌 종가
L016776|01^0167|문중>경상북도|봉화 유곡 안동권씨 충재 권벌 후손가
L016785|01^0167|문중>경상북도|상주 낙동 풍양조씨 양진당 조정
L016793|01^0167|문중>경상북도|상주 성주이씨 묵재 종가
L016767|01^0167|문중>경상북도|상주 연안이씨 식산 이만부 종가
L016766|01^0167|문중>경상북도|상주 우산 진주정씨 우복 정경세 종가
L016761|01^0167|문중>경상북도|상주 충주박씨 충원군 박동형 종가
L016769|01^0167|문중>경상북도|성주 명곡 벽진이씨 완석정 이언영 종가
L016764|01^0167|문중>경상북도|안동 갈전 순흥안씨 종가
L016713|01^0167|문중>경상북도|안동 금계 의성김씨 학봉 김성일 종가
L016758|01^0167|문중>경상북도|안동 법흥 고성이씨 종가 임청각
L016709|01^0167|문중>경상북도|안동 송파 진주하씨 하위지 후손가
L016701|01^0167|문중>경상북도|안동 수곡 전주류씨 무실 종가
L016715|01^0167|문중>경상북도|안동 오천 광산김씨 후조당 김부필
L016717|01^0167|문중>경상북도|안동 주촌 진성이씨 경류정
L016707|01^0167|문중>경상북도|안동 천전 의성김씨 천상각파
L016708|01^0167|문중>경상북도|안동 하회 풍산류씨
L016728|01^0167|문중>경상북도|안동 하회 풍산류씨 북촌댁 화경당
L016759|01^0167|문중>경상북도|영덕 도곡 무안박씨 무의공 박의장 종가
L016765|01^0167|문중>경상북도|영덕 도곡 무안박씨 충효당 박선 종가
L016760|01^0167|문중>경상북도|영덕 재령이씨 충효당 이함 종가
L016791|01^0167|문중>경상북도|영주 화계 인동장씨 연복군 종가
L016795|01^0167|문중>경상북도|예천 맛질 함양박씨 미산 박득녕 종가
L016796|01^0167|문중>경상북도|예천 맛질 함양박씨 박현녕 후손가
L016780|01^0167|문중>경상북도|예천 진주류씨 서파 유희 가문
L016741|01^0167|문중>경상북도|의성 아주신씨 오봉 신지제 가문
L016742|01^0167|문중>경상북도|의성 아주신씨 호계 신적도 가문
L016774|01^0167|문중>경상북도|청도 함박김씨
L016721|01^0167|문중>경상북도|칠곡 석전 광주이씨
L015019|01^0150|문중>경상남도|거창 강동 초계정씨 동계 정온 종가
L015025|01^0150|문중>경상남도|거창 거창신씨
L015024|01^0150|문중>경상남도|거창 은진임씨
L015022|01^0150|문중>경상남도|밀양 밀성박씨 종가 모선정
L015020|01^0150|문중>경상남도|밀양 사촌 의령남씨 종가 침류정
L015026|01^0150|문중>경상남도|밀양 창녕조씨 오봉서원
L015007|01^0150|문중>경상남도|진주 단목 진양하씨 단지 하협 종가
L015004|01^0150|문중>경상남도|진주 단목 진양하씨 창주 하증 후손가
L015023|01^0150|문중>경상남도|진주 마진 재령이씨 이재관 후손가
L015018|01^0150|문중>경상남도|진주 마진 재령이씨 종가
L015011|01^0150|문중>경상남도|진주 안계 진양하씨 담헌 하우선 종가
L015005|01^0150|문중>경상남도|진주 운문 진양하씨
L015002|01^0150|문중>경상남도|함안 두릉 순흥안씨
L015021|01^0150|문중>경상남도|함양 안의 밀양박씨 지족당 박명부 종가
L017101|01^0171|문중>강원특별자치도|강릉 전주이씨 선교장 효령대군 후손가
L016821|01^0168|문중>제주특별자치도|서귀포 사계 진주강씨
L016814|01^0168|문중>제주특별자치도|제주 경주김씨 문중회
L016807|01^0168|문중>제주특별자치도|제주 구좌 동래정씨 정석록 후손가
L016816|01^0168|문중>제주특별자치도|제주 동래정씨 정희현 후손가
L016819|01^0168|문중>제주특별자치도|제주 애월 김해김씨 김용징 후손가
L016820|01^0168|문중>제주특별자치도|제주 애월 김해김씨 김희주 후손가
L016822|01^0168|문중>제주특별자치도|제주 어도 진주강씨 강봉지 후손가
L016817|01^0168|문중>제주특별자치도|제주 어도 진주강씨 강수황 후손가
L016818|01^0168|문중>제주특별자치도|제주 어도 진주강씨 강익진 후손가
L016815|01^0168|문중>제주특별자치도|제주 제주고씨 종친회
L016810|01^0168|문중>제주특별자치도|제주 조천 곡산강씨 강만식 후손가
L016811|01^0168|문중>제주특별자치도|제주 조천 곡산강씨 강이진 후손가
L016806|01^0168|문중>제주특별자치도|제주 조천 김해김씨 김희정 후손가
L017201|01^0172|문중>인천광역시|강화·부여 창원황씨
L024712|02^0247|서원향교>경상북도|경주 용산서원
L024711|02^0247|서원향교>경상북도|경주 장산서원
L024710|02^0247|서원향교>경상북도|안동 병산서원
L024807|02^0248|서원향교>경상남도|거창 거창향교
L024804|02^0248|서원향교>경상남도|김해 김해향교
L024808|02^0248|서원향교>경상남도|밀양 덕남서원
L024806|02^0248|서원향교>경상남도|산청 단성향교
L024802|02^0248|서원향교>경상남도|산청 덕천서원
L024803|02^0248|서원향교>경상남도|함양 남계서원
L024801|02^0248|서원향교>경상남도|합천 용연서원
L024805|02^0248|서원향교>경상남도|합천 합천향교
L031119|03^0311|박물관도서관>서울특별시|국립고궁박물관
L031121|03^0311|박물관도서관>서울특별시|한국연구원
L037702|03^0377|박물관도서관>경기도|경기도박물관
L037705|03^0377|박물관도서관>경기도|명성황후기념관
L037701|03^0377|박물관도서관>경기도|여주박물관
L037801|03^0378|박물관도서관>강원특별자치도|오죽헌·시립박물관
L037502|03^0375|박물관도서관>충청북도|국립청주박물관
L039202|03^0392|박물관도서관>세종특별자치시|미래엔 교과서박물관
L040102|04^0401|공공기관>경기도|국사편찬위원회
L040101|04^0401|공공기관>경기도|한국학중앙연구원 장서각
L040301|04^0403|공공기관>서울특별시|규장각한국학연구원
L054904|05^0549|사찰>경상북도|김천 직지사
L054901|05^0549|사찰>경상북도|예천 용문사
L054701|05^0547|사찰>경상남도|고성 옥천사 보장각
L054702|05^0547|사찰>경상남도|고성 옥천사 청련암
L061502|06^0615|개인>경기도|신상후 선생님 제공 자료
L061503|06^0615|개인>경기도|헤이리예술마을뮤지엄카페 타임캡슐
L061201|06^0612|개인>경상북도|경주 경주이씨 이찬우
L0619  F02|06^L0619|개인>개인|고문서
L062001|06^0620|개인>미상|개인
L074902|07^0749|촌락>경상북도|경주 외동 방어리
L074901|07^0749|촌락>경상북도|경주 지북동(황성동)
L074801|07^0748|촌락>경상남도|거제 일운 구조라리
L074702|07^0747|촌락>제주특별자치도|제주 애월 수산리
L074703|07^0747|촌락>제주특별자치도|제주 애월 중엄리
L074701|07^0747|촌락>제주특별자치도|제주 애월 하가리
L0807  F02|08^L0807|기타>기타|고문서
L0809  F02|08^L0809|기타>명성황후 편지글(이기대, 다운샘, 2007)|고문서
L0811  F02|08^L0811|기타>한글서예변천전 도록|고문서`.trim().split('\n').map((l) => { const [id, up, grp, name] = l.split('|'); return { id, up, grp, name }; });
const aksChain = (base, suf) => { const c = []; if (suf) { c.push(base + suf.slice(0, 3)); if (suf.length > 3) c.push(base + suf); } return c; };

// 한→일 출력 사전(JACAR 전용) — 일본어 질의가 영어와 다른 결과축을 연다(총독부 행정 법령류 실측)
const JA_MAP = [['조선총독부', '朝鮮総督府'], ['이토 히로부미', '伊藤博文'], ['강제동원', '強制動員'], ['인천상륙', '仁川上陸'],
  ['한국전쟁', '朝鮮戦争'], ['창씨개명', '創氏改名'], ['동양척식', '東洋拓殖'], ['조선은행', '朝鮮銀行'], ['재일조선인', '在日朝鮮人'],
  ['독립운동', '独立運動'], ['임시정부', '臨時政府'], ['3·1운동', '三・一運動'], ['삼일운동', '三・一運動'], ['만주국', '満州国'],
  ['관동군', '関東軍'], ['황민화', '皇民化'], ['학도병', '学徒兵'], ['위안소', '慰安所'], ['위안부', '慰安婦'], ['독립군', '独立軍'],
  ['의열단', '義烈団'], ['광복군', '光復軍'], ['연해주', '沿海州'], ['사할린', '樺太'], ['신의주', '新義州'], ['총독부', '総督府'],
  ['장진호', '長津湖'], ['안중근', '安重根'], ['윤봉길', '尹奉吉'], ['이봉창', '李奉昌'], ['여운형', '呂運亨'], ['김구', '金九'],
  ['헌병', '憲兵'], ['특고', '特高'], ['징용', '徴用'], ['의병', '義兵'], ['간도', '間島'], ['만주', '満州'], ['경성', '京城'],
  ['평양', '平壌'], ['부산', '釜山'], ['인천', '仁川'], ['원산', '元山'], ['청진', '清津'], ['상해', '上海'], ['중경', '重慶'],
  ['조선', '朝鮮'], ['한국', '朝鮮']];
const koToJa = (q) => { let out = q, hit = false; for (const [k, j] of JA_MAP) { if (out.includes(k)) { out = out.split(k).join(j); hit = true; } } return hit ? out : null; };

// normalized per-source collectors → [{title,date,id,url}]; compliant channels only (robots-OK APIs / officially-published files)
// 소장기관 정식명·국가 — 맥락 강화(v1.71): manifest heldBy·karda archive 노드에 주입
const ARCHIVE_META = {
  tna: { n: 'The National Archives (영국 국립기록관)', c: 'GB' }, ia: { n: 'Internet Archive', c: 'INT' },
  gallica: { n: 'Gallica (프랑스 국립도서관 BnF)', c: 'FR' }, europeana: { n: 'Europeana', c: 'EU' },
  nara: { n: 'U.S. National Archives (NARA)', c: 'US' }, archives: { n: '국가기록원', c: 'KR' },
  nlk: { n: '국립중앙도서관', c: 'KR' }, nedb: { n: '국가기록원 개방데이터', c: 'KR' },
  koreanwar: { n: 'KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터', c: 'KR' },
  jacar: { n: '아시아역사자료센터 JACAR', c: 'JP' }, earchive: { n: '국사편찬위원회 전자사료관', c: 'KR' },
  i815: { n: '독립기념관 한국독립운동정보시스템', c: 'KR' }, gonghun: { n: '국가보훈부 공훈전자사료관', c: 'KR' },
  ktv: { n: 'KTV e영상역사관', c: 'KR' }, oldnews: { n: '국립중앙도서관 대한민국 신문 아카이브', c: 'KR' },
  much: { n: '대한민국역사박물관', c: 'KR' }, indy: { n: '국가기록원 독립운동판결문', c: 'KR' },
  heritage: { n: '국가유산청 국가유산포털', c: 'KR' }, kyudb: { n: '서울대 규장각한국학연구원', c: 'KR' },
  jsg: { n: '한국학중앙연구원 장서각', c: 'KR' }, awm: { n: 'Australian War Memorial', c: 'AU' },
  nlna: { n: 'Nationaal Archief (네덜란드)', c: 'NL' }, dnz: { n: 'DigitalNZ (뉴질랜드 집계)', c: 'NZ' },
  nzarch: { n: 'Archives New Zealand Te Rua Mahara', c: 'NZ' }, commons: { n: 'Wikimedia Commons', c: 'INT' },
  un: { n: 'UN Digital Library', c: 'INT' }, ndl: { n: '일본 국립국회도서관 NDL', c: 'JP' },
  seoul: { n: '서울기록원', c: 'KR' }, foia: { n: '정보공개포털·서울소통광장', c: 'KR' },
  aks: { n: '한국학중앙연구원 한국고문서자료관', c: 'KR' }, gallery: { n: 'KOREA ARCHIVE IIIF 갤러리(30곳 탐방·100선 실물 기록)', c: 'KR' }, ledger: { n: 'KOREA ARCHIVE 발견 누적 원장(사용자 발굴 기록)', c: 'KR' }, okchf: { n: '국외소재문화유산재단 대국민 아카이브', c: 'KR' }, nrich: { n: '국립문화유산연구원 국가유산 지식이음', c: 'KR' },
};
// 증거성 강화(v1.71): 레코드별 심층 판독 재현 호출문 — 발굴→판독 증거 사슬
const DEEP_READ = {
  gonghun: (it) => it.id && `nedb_search(mode='gonghun', query='${it.id}')`,
  i815: (it) => it.url && `nedb_search(mode='i815', query='${it.url}')`,
  un: (it) => it.url && `nedb_search(mode='un', query='${it.url}')`,
  nzarch: (it) => it.id && `nedb_search(mode='nzarch', query='${it.id}')`,
  jsg: (it) => it.id && `nedb_search(mode='jsg', query='${it.id}')`,
  much: (it) => it.url && `nedb_search(mode='much', query='${it.url}')`,
  indy: (it) => it.url && `nedb_search(mode='indy', query='${it.url}')`,
  heritage: (it) => it.id && `nedb_search(mode='heritage', query='${it.id}')`,
  ktv: (it) => it.url && `nedb_search(mode='ktv', query='${it.url}')`,
  jacar: (it) => it.id && `nedb_search(mode='jacar', query='${it.id}')`,
  oldnews: (it) => it.id && `nedb_search(mode='oldnews', query='${it.id}')`,
  commons: (it) => it.url && `nedb_search(mode='commons', query='${it.url}')`,
  koreanwar: (it) => it.id && `koreanwar_item(ref_code='${it.id}')`,
  okchf: (it) => it.url && `nedb_search(mode='okchf', query='${it.url}')`,
  nrich: (it) => (/^(ksm|portrait|gwaebul|diary|mokgan|jcbib|jcphoto|dict|arch|koguryo|gaesong|design|pattern|oldbook|hyanggyo|stone|journal|iron|dolmen|assay|material):/.test(it.id || '') ? `nedb_search(mode='nrich', query='${it.id}')` : it.url && `nedb_search(mode='nrich', query='${it.url}')`),
  nara: (it) => it.id && `judge_rights(naid=${String(it.id).replace(/\D/g, '')})`,
  seoul: (it) => it.url && `seoul_archives_search(query='${it.url}')`,
};
// NARA 계보(v1.80): ancestors 배열 → "RG n › 시리즈" 축약 체인 (수집기·전용 도구·판정 공용)
const naraChain = (rec) => {
  const anc = rec.ancestors || [];
  const rg = rec.recordGroupNumber || anc.map((a) => a.recordGroupNumber).find(Boolean) || '';
  const ser = (anc.find((a) => /series/i.test(a.levelOfDescription || '')) || {}).title || '';
  return [rg ? `RG ${rg}` : '', ser].filter(Boolean).join(' › ').slice(0, 80);
};
// NARA 생산일자(v1.82): productionDates 다중 폴백 — logicalDate(ISO)·year·proximatePhrase
const naraDate = (rec) => { const p = ((rec.productionDates || [])[0] || {}); return String(p.logicalDate || p.year || p.proximatePhrase || '').slice(0, 10); };
// 데이터화×맥락 강화(v1.72): 레코드의 상위 계층(partOf) 추출 — 시리즈·수집 구조·소장관
const PART_OF = {
  nara: (it) => it.series && `NARA › ${it.series}`,
  nzarch: (it) => it.series && `Series: ${it.series}`,
  koreanwar: (it) => { if (it.series) return `협약 › ${it.series}`; const m = String(it.id || '').match(/^(\d{4})-([A-Z]{2})-(\d{2})-([A-Z]+)-([A-Z])-\d+$/); return m && `수집 ${m[1]} › ${m[2]} › ${m[4]}-${m[5]}`; },
  jacar: (it) => { const o = { A: '국립공문서관', B: '외무성 외교사료관', C: '방위성 방위연구소' }[String(it.id || '')[0]]; return o && `JACAR › ${o}`; },
  oldnews: (it) => it.series && `신문 › ${it.series}`,
  aks: (it) => it.series && `고문서 › ${it.series}`,
  gallery: (it) => it.series && `IIIF 갤러리 › ${it.series}`,
  ledger: (it) => it.series || '',
  okchf: (it) => it.series && `국외소재문화유산재단 › ${it.series}`,
  nrich: (it) => it.series && `국립문화유산연구원 › ${it.series}`, // 발간자료 › 조사보고서 포함
  dnz: (it) => it.series && `NZ › ${it.series}`,
  ia: (it) => it.series && `IA Collection › ${it.series}`,
  tna: (it) => it.series && `TNA › ${it.series}`,
  europeana: (it) => it.series && `Europeana › ${it.series}`,
  gonghun: (it) => it.series && `운동계열 › ${it.series}`,
  indy: (it) => it.series && `판결기관 › ${it.series}`,
  heritage: (it) => it.series && `지정 › ${it.series}`,
  un: (it) => it.series && `UN › ${it.series}`,
  gallica: (it) => it.series && `Gallica › ${it.series}`,
  much: (it) => it.series && `박물관 › ${it.series}`,
  i815: (it) => it.series && `자료 › ${it.series}`,
  ktv: (it) => it.series && `영상 › ${it.series}`,
  seoul: (it) => it.series && `기술단위 › ${it.series}`,
  archives: (it) => it.series && (it.series.startsWith('[유형]') ? `국가기록원 › ${it.series.slice(5).trim()}` : `생산기관 › ${it.series}`),
  nedb: (it) => it.series && (it.series.startsWith('한국사DB') ? it.series : `한국사DB › ${it.series}`), // v2.3: 편찬 자료군(DB)이 곧 상위 계열
  nlk: (it) => it.series && `자료유형 › ${it.series}`,
  jsg: (it) => it.series && `四部 › ${it.series}`,
  kyudb: (it) => it.series && `소장 › ${it.series}`,
  ndl: (it) => it.series && `NDL › ${it.series}`,
  awm: (it) => it.series && `AWM 유형 › ${it.series}`,
  nlna: (it) => it.series && `NA(NL) › ${it.series}`,
  earchive: (it) => it.series && `수집처 › ${it.series}`,
  commons: (it) => it.series && `Commons › ${it.series}`,
};
const COLLECT = {
  tna: async (q, n, yr) => { // v2.99.1 yr = 생산연도 필터(sps.dateFrom/To) — 당대 국호 질의를 연도 문자열 대신 필터로
    q = koToEn(q) || q;
    const query = /^[A-Z]+ \d+\/\d+$/.test(q.trim()) ? `"${q.trim()}"` : q;
    const d = await tnaFetch(query, n, 1, yr, yr);
    return (d.records || []).map((r) => { const ref = String(r.reference || ''); return { title: r.title || r.description, date: r.coveringDates || '', id: ref, ...(ref.includes('/') ? { series: ref.split('/')[0] } : {}), url: `https://discovery.nationalarchives.gov.uk/details/r/${r.id}` }; });
  },
  ia: async (q, n) => {
    q = koToEn(q) || q;
    const r0 = await iaSearch(q, n, 'fl[]=identifier&fl[]=title&fl[]=date&fl[]=collection'); const d = { response: { docs: r0.docs } };
    // v1.87: NARA 재게시본 식별자 gov.archives.arc.<NAID> → sameAs(원본 NAID) — 추가 조회 없이 동일 기록 병합(44175 실측 일치)
    return ((d.response || {}).docs || []).map((x) => { const an = (String(x.identifier || '').match(/^gov\.archives\.arc\.(\d+)$/) || [])[1]; const al = (String(x.identifier || '').match(/^(\d{2,3}[a-z]?-[a-z]{1,6}-\d+[a-z]?)$/i) || [])[1]; /* v1.91.2: NARA 고유번호형 식별자(428-npc-171) → 원본 대조 */ return { title: String(x.title || ''), date: x.date || '', id: x.identifier, ...((Array.isArray(x.collection) ? x.collection[0] : x.collection) ? { series: String(Array.isArray(x.collection) ? x.collection[0] : x.collection) } : {}), ...(an ? { sameAs: `NAID ${an}` } : al ? { sameAs: `NARA ${al.toUpperCase()}` } : {}), url: `https://archive.org/details/${x.identifier}` }; });
  },
  gallica: async (q, n) => {
    q = gallicaKoToFr(q) || q;
    const query = encodeURIComponent(`gallica all "${q.replace(/"/g, '')}"`);
    let xml = '';
    try { xml = await (await robustFetch(`https://gallica.bnf.fr/SRU?operation=searchRetrieve&version=1.2&query=${query}&maximumRecords=${n}`)).text(); } catch { xml = ''; }
    if (!xml.includes('<srw:numberOfRecords>')) { const r = await bnfCatalog(q, n); return r.items.map((it) => ({ title: `${it.title}${it.gallica ? ' [Gallica 원문]' : ''}`, date: it.date, id: it.id, ...(it.series ? { series: it.series } : {}), url: it.url })); } // v1.93 BnF 카탈로그 폴백
    return xml.split('<srw:record>').slice(1, n + 1).map((b) => {
      const g = (t) => { const m = b.match(new RegExp(`<dc:${t}[^>]*>([^<]*)<`)); return m ? m[1].trim() : ''; };
      const ak = (g('identifier').match(/ark:\/12148\/(btv|bpt6k|bd6t)/) || [])[1]; const akn = { btv: '도판·사진(btv)', bpt6k: '인쇄본(bpt6k)', bd6t: '정기간행물(bd6t)' }[ak]; return { title: g('title'), date: g('date'), id: g('identifier'), ...(akn ? { series: akn } : {}), url: g('identifier') };
    });
  },
  europeana: async (q, n) => {
    q = koToEn(q) || q;
    const key = process.env.EUROPEANA_API_KEY || 'api2demo';
    const d = await jget(`https://api.europeana.eu/record/v2/search.json?wskey=${key}&query=${encodeURIComponent(q)}&rows=${n}&profile=standard`);
    return (d.items || []).map((it) => ({ title: (it.title || ['?'])[0], date: (it.year || [''])[0], id: it.id || '', ...(((it.dataProvider || [])[0]) ? { series: (it.dataProvider || [])[0] } : {}), ...(euMedia(it) ? { media: euMedia(it) } : {}), url: String(it.guid || '').split('?')[0] }));
  },
  nara: async (q, n) => {
    q = koToEn(q) || q;
    const key = process.env.NARA_API_KEY; if (!key) return [];
    const d = await jget(`https://catalog.archives.gov/api/v2/records/search?q=${encodeURIComponent(q)}&limit=${n}&page=1`, { 'x-api-key': key });
    return ((((d.body || {}).hits || {}).hits) || []).map((h) => { const rec = (h._source || {}).record || {}; const po = naraChain(rec); const d0u = String((((rec.digitalObjects || [])[0]) || {}).objectUrl || ''); return { title: rec.title || '', date: naraDate(rec), id: rec.naId ? `NAID ${rec.naId}` : '', ...(rec.localIdentifier ? { lid: `NARA ${String(rec.localIdentifier).toUpperCase()}` } : {}), ...(po ? { series: po } : {}), ...(d0u ? { media: d0u } : {}), url: `https://catalog.archives.gov/id/${rec.naId}` }; });
  },
  archives: async (q, n) => {
    const key = process.env.ARCHIVES_API_KEY; if (!key) return [];
    const sk = /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
    const xml = await gtext(`https://apis.data.go.kr/1741050/openapi/searcharc?serviceKey=${sk}&query=${encodeURIComponent(q)}&start=1&limit=${n}`);
    return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((i) => {
      const link = archLink(xtag(i, 'link')); // v2.7.1: API가 &amp;로 내려줌 → 클릭 시 빈 페이지(실측). 해제 + https
      const rid = ((link.match(/rc_rfile_no=(\d+)/) || [])[1] || '') + ((link.match(/rc_ritem_no=(\d+)/) || [])[1] ? '-' + (link.match(/rc_ritem_no=0*(\d+)/) || [])[1] : '');
      // v2.3: 생산기관이 없는 항목은 링크 유형으로 계열 구축(기록물철·기록건·기록정보콘텐츠) — '[유형]' 표시로 생산기관과 구분
      const kind = /rc_ritem_no=/.test(link) ? '기록건' : /rc_rfile_no=/.test(link) ? '기록물철' : /rc_code=/.test(link) ? '기록정보콘텐츠' : '';
      const ser = xtag(i, 'prod_name') || (kind ? `[유형] ${kind}` : '');
      return { title: xtag(i, 'title'), date: xtag(i, 'prod_year'), id: rid || xtag(i, 'prod_name'), ...(ser ? { series: ser } : {}), url: link };
    });
  },
  nlk: async (q, n) => {
    const key = process.env.NLK_API_KEY; if (!key) return [];
    // 실측 7.7s(최저속 축) — 6h TTL 캐시(마커 <item> — 정상 결과만)
    const xml = await cachedText(`nlk:${q}:${n}`, 6 * 3600e3, () => gtext(`https://www.nl.go.kr/NL/search/openApi/search.do?key=${encodeURIComponent(key)}&apiType=xml&srchTarget=total&kwd=${encodeURIComponent(q)}&pageSize=${n}&pageNum=1`), '<item>');
    return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => { let lk = xtag(it, 'detail_link') || xtag(it, 'org_link'); if (lk.startsWith('/')) lk = 'https://www.nl.go.kr' + lk; return { title: xtag(it, 'title_info') || xtag(it, 'title'), date: xtag(it, 'pub_year_info'), id: ((lk.match(/viewKey=([^&#\s]+)/) || [])[1] || xtag(it, 'control_no') || ''), ...(xtag(it, 'type_name') ? { series: xtag(it, 'type_name') } : {}), url: lk }; }); // v2.67 id=기록 고유번호(viewKey) — 종전 자료유형이라 원장에서 같은 유형의 다른 기록이 한 key로 합쳐지던 결함
  },
  nedb: async (q, n) => { // v1.93: 개방파일 인덱스 미설정이면 한국사DB 통합검색 라이브 조회 — 검색어가 등장하는 DB(편찬 자료군)를 기록 단위 진입점으로 수집(0건 고정 해소)
    const recs = await loadNedbIndex(); if (recs) return nedbFileSearch(recs, q, n);
    const dbs = (await nedbLive(q, 2)).filter((d) => d.total > 0).sort((a, b) => b.total - a.total); const out = [];
    for (let k = 0; k < 2; k++) for (const d of dbs) { const r = d.rows[k]; if (r && out.length < n) out.push({ series: `${d.era} › ${d.name}`, title: r.title.slice(0, 140), date: nedbDate(r.id), id: r.id, url: `${JDB}/id/${r.id}` }); }
    return out;
  },
  koreanwar: async (q, n) => {
    const cards = (await kwSearch({ keyword: q, viewType: 'archive' })).cards.slice(0, n);
    // v1.86: 상위 5건 상세 병렬 조회(24h 캐시·6s 상한) — 원본 NAID(sameAs)·생산시기 확보 → NARA 원본과 동일 기록 병합
    const det = await Promise.race([Promise.all(cards.slice(0, 5).map((c) => kwDetail(c.id).catch(() => null))), sleep(6000).then(() => [])]);
    return cards.map((c, i) => { const d = det[i] || {}; return { title: c.title, date: d.date || '', id: c.id, ...(c.hierarchy ? { series: c.hierarchy } : {}), ...(d.naid ? { sameAs: `NAID ${d.naid}` } : {}), url: c.url }; }); // v1.84: 상위계층 실값 승격
  },
  ndl: async (q, n) => { // 일본 국립국회도서관 서치 — OpenSearch 무키 실측(2026-11-21). 조선총독부 간행물·관보·도판 축(JACAR 공문서와 상보). 한→일 JA_MAP 우선 변환
    // v1.91.1: 일문·한자 입력(京城府·朝鮮総督府)이 영문 폴백('Korea')으로 바뀌던 결함 교정 — 한글 입력일 때만 영문 폴백, 부분 변환(京城부)은 폐기
    const hg = (t) => /[\uac00-\ud7a3]/.test(t);
    let ja = koToJa(q); if (!ja || hg(ja)) ja = hg(q) ? (koToEn(q) || q) : q;
    // v1.91.1: any= 는 광역 일치 후 표제 가나순 정렬로 잡음 상위화(실측 '朝鮮総督府'→アーカイブズ…) — title= 우선, 0건이면 any= 폴백
    const NUA = { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' };
    const ndlq = (f) => gtext(`https://ndlsearch.ndl.go.jp/api/opensearch?${f}=${encodeURIComponent(ja)}&cnt=${Math.min(n, 10)}`, NUA);
    // v1.96: 수천 건 일치 시 표제 가나순이라 무관 자료 상위 — 당대 자료(until=1945)를 병행 조회하고, 검색어(신·구자체)를 표제에 포함한 것부터
    // 순차 — NDL 동시접속 429 실측. v1.96.5: 두 질의 합이 소스 타임박스(12s)를 넘던 문제 — 당대 질의 5s 상한, 당대 결과가 충분하면 일반 질의 생략
    const bc = await Promise.race([gtext(`https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(ja)}&until=1945&cnt=${Math.min(n * 2, 20)}`, NUA).catch(() => ''), sleep(5000).then(() => '')]);
    const enough = (bc.match(/<item>/g) || []).length >= n;
    const ba = enough ? '' : await Promise.race([ndlq('title').catch(() => ''), sleep(6000).then(() => '')]);
    let b = (bc.includes('<item>') ? bc.replace(/<\/channel>[\s\S]*$/, '') : '') + ba;
    if (!b.includes('<item>') && !(b.includes('<error>') && b.includes('429'))) b = await ndlq('any');
    if (b.includes('<error>') && b.includes('429')) throw new Error('NDL 동시접속 제한(429) — 잠시 후 재시도');
    const out = []; const seenL = new Set();
    const KJ = { 總: '総', 國: '国', 鐵: '鉄', 經: '経', 會: '会', 學: '学', 臺: '台', 縣: '県', 圖: '図', 廳: '庁', 發: '発', 實: '実', 寫: '写', 眞: '真', 帖: '帖' };
    const nk = (t) => String(t).replace(/./g, (c) => KJ[c] || c);
    const qn = nk(ja).replace(/\s+/g, '');
    const items = b.split('<item>').slice(1).map((item, i) => { const tt = ((item.match(/<title[^>]*>([^<]+)/) || [])[1] || ''); return { item, i, hit: nk(tt).replace(/\s+/g, '').includes(qn) ? 0 : 1 }; });
    items.sort((x, y) => x.hit - y.hit || x.i - y.i);
    for (const { item } of items) {
      const g = (t) => ((item.match(new RegExp(`<${t}[^>]*>([^<]+)`)) || [])[1] || '').trim();
      const title = g('title'); const link = g('link');
      if (seenL.has(link)) continue; seenL.add(link);
      if (!title || !link) continue;
      const catArr = [...item.matchAll(/<category>([^<]+)/g)].map((m) => m[1]); // 자료형·매체(紙/デジタル)
      const cats = catArr.join('·');
      const author = g('author');
      // v1.96.8: 디지털화 자료는 dl.ndl.go.jp PID를 함께 — 권리(PDM·internet) 확인과 IIIF 원본 경로의 열쇠(별도 재조회로 429를 부르던 단계 제거)
      const pid = (item.match(/dl\.ndl\.go\.jp\/(?:api\/iiif\/|info:ndljp\/pid\/|pid\/)(\d{5,})/) || [])[1] || '';
      out.push({ title: `${title}${cats ? ` [${cats}]` : ''}${author ? ` — ${author}` : ''}${pid ? ` · 디지털 PID ${pid}` : ''}`.slice(0, 140), date: g('dc:date'), id: pid, ...(catArr[0] ? { series: catArr[0] } : {}), url: pid ? `https://dl.ndl.go.jp/pid/${pid}` : link });
      if (out.length >= n) break;
    }
    return out;
  },
  un: async (q, n) => { // UN 디지털도서관(digitallibrary.un.org) — Invenio of=xm(MARCXML) 무키 실측(2026-11-21). 안보리 결의·UNCURK 등. ※UN Archives(AtoM)는 별도·보류
    // v1.96.5: 문서기호(A/RES/46/1·S/RES/82(1950)) 입력은 기호 필드(191) 정확 검색 — 일반 검색은 A/RES/46/16 등 근접 기호가 섞임(실측)
    const sym = /^[A-Z]{1,4}(\/[A-Z0-9.()-]+)+$/i.test(q.trim()) ? q.trim().toUpperCase() : '';
    const en = sym ? `191:"${sym}"` : (koToEn(q) || q);
    const b = await gtext(`https://digitallibrary.un.org/search?p=${encodeURIComponent(en)}&of=xm&rg=${sym ? 50 : Math.min(n, 10)}`,
      { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' });
    const sf = (seg, tag, code) => (((seg.match(new RegExp(`<datafield tag="${tag}"[^>]*>([\\s\\S]*?)<\\/datafield>`)) || [])[1] || '').match(new RegExp(`<subfield code="${code}">([^<]+)`)) || [])[1] || '';
    const out = [];
    for (const seg of b.split(/<record>/).slice(1)) {
      const recid = (seg.match(/<controlfield tag="001">(\d+)/) || [])[1];
      if (!recid) continue;
      const sym = sf(seg, '191', 'a');
      const title = norm(sf(seg, '245', 'a') + ' ' + sf(seg, '245', 'b')).replace(/[\s/:]+$/, '');
      out.push({ title: `${sym ? `[${sym}] ` : ''}${title}`.slice(0, 110), date: sf(seg, '269', 'a') || sf(seg, '260', 'c'), id: sym || recid, ...(sym && sym.includes('/') ? { series: sym.split('/').slice(0, 2).join('/') } : {}), url: 'https://digitallibrary.un.org/record/' + recid });
      if (out.length >= (sym ? 50 : n)) break;
    }
    if (sym) { out.sort((x, y) => (String(y.title).startsWith(`[${sym}]`) ? 1 : 0) - (String(x.title).startsWith(`[${sym}]`) ? 1 : 0)); return out.slice(0, n); } // 기호 정확 일치 우선(191 필드는 접두 일치 — 실측)
    return out;
  },
  heritage: async (q, n) => { // 국가유산포털(국가유산청) OpenAPI — 무키 XML(이 작업망에선 차단·icn1 도달 확인). 국보·보물·사적 축
    const b = await gtext('https://www.khs.go.kr/cha/SearchKindOpenapiList.do?ccbaMnm1=' + encodeURIComponent(q) + '&pageUnit=' + Math.min(n, 15));
    const out = [];
    for (const it of b.split('<item>').slice(1)) {
      const g = (t) => xtag(it, t); // CDATA 래핑 대응(기존 xtag 재사용)
      const name = g('ccbaMnm1');
      if (!name) continue;
      const cpno = g('ccbaCpno');
      const rawId = (g('ccbaKdcd') && g('ccbaAsno') && g('ccbaCtcd')) ? `${g('ccbaKdcd')}-${g('ccbaAsno')}-${g('ccbaCtcd')}` : cpno; // 상세 API 원값 보존
      out.push({ title: `${name}${g('ccbaMnm2') ? `(${g('ccbaMnm2')})` : ''}${g('ccmaName') ? ` [${g('ccmaName')}]` : ''}${g('ccbaCtcdNm') ? ` — ${g('ccbaCtcdNm')} ${g('ccsiName')}` : ''}`.slice(0, 110),
        date: '', id: rawId, ...(g('ccmaName') ? { series: g('ccmaName') } : {}), ...(g('imageUrl') ? { media: g('imageUrl') } : {}), url: cpno ? `https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaCpno=${cpno}` : 'https://www.heritage.go.kr' });
      if (out.length >= n) break;
    }
    return out;
  },
  indy: async (q, n) => { // 국가기록원 독립운동판결문 테마관 — GET 실측(2026-11-21). 판결기관·날짜·주문+상세 딥링크(gonghun 수형기록의 원문 창구)
    const b = await gtext('https://theme.archives.go.kr/next/indy/listkeywordSrch.do?keyword=' + encodeURIComponent(q) + '&listSize=' + Math.min(n, 20));
    const out = [];
    for (const m of b.matchAll(/<a href="(\/next\/indy\/viewIndyDetail\.do[^"]+)">\s*<span>\s*([^<]+?)\s*<\/span>[\s\S]{0,400}?<td class="left">([^<]*)<\/td>\s*<td>(\d{8})<\/td>\s*<td class="left">([^<]*)<\/td>/g)) {
      out.push({ title: `[판결문] ${norm(m[2])} — ${norm(m[3])} · ${norm(m[5]).slice(0, 40)}`.slice(0, 115), date: m[4], id: '', ...(norm(m[3]) ? { series: norm(m[3]) } : {}), url: 'https://theme.archives.go.kr' + m[1].replace(/&amp;/g, '&') });
      if (out.length >= n) break;
    }
    return out;
  },
  much: async (q, n) => { // 대한민국역사박물관 근현대사아카이브 — POST 검색 역공학(2026-11-21). 소장품·포스터·간행물(근현대 실물)
    const r = await fetch('https://archive.much.go.kr/search.do', { method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ searchQuery: q }), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.text();
    const out = [];
    for (const m of b.matchAll(/<a href="(\/archive\/[\w/]+view\.do\?idnbr=[^"]+)">[\s\S]{0,420}?<strong>([\s\S]*?)<\/strong>[\s\S]{0,320}?자료연대\s*:\s*([^<]{1,20})/g)) {
      out.push({ title: norm(m[2].replace(/<[^>]+>/g, '')).slice(0, 110), date: norm(m[3]), id: (m[1].match(/idnbr=([\w-]+)/) || [])[1] || '', ...((m[1].split('/')[2] || '') ? { series: m[1].split('/')[2] } : {}), url: 'https://archive.much.go.kr' + m[1] });
      if (out.length >= n) break;
    }
    if (out.length < n) for (const c of b.matchAll(/<strong>([가-힣 ]{2,12})<\/strong><span>총 "([\d,]+)건"/g)) { // 카테고리 집계 신호 보충
      if (c[2] === '0') continue;
      out.push({ title: `역사박물관 ${norm(c[1])} ${c[2]}건 — 사이트 검색(POST)으로 열람`, date: '', id: '', url: 'https://archive.much.go.kr/index.do' });
      if (out.length >= n) break;
    }
    return out;
  },
  oldnews: async (q, n) => { // 대한민국신문아카이브(국립중앙도서관) — POST JSON 역공학(2026-11-21). 1883~1960 신문 기사 전문(공립신보·신한민보·황성신문 등)
    const r = await fetch('https://nl.go.kr/newspaper/search_newspaper.do', { method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Referer: 'https://nl.go.kr/newspaper/keyword_search.do' },
      body: JSON.stringify({ search_keyword: q, page_size: Math.min(n, 10), page_no: 1 }), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let d = await r.json();
    if (!(d.hits || []).length && /\s/.test(String(q).trim())) { // v1.96.4: 다어절 0건 → 가장 긴 단어로 완화 재검색(실측 '독립신문 창간' 0건, '독닙신문' 정상)
      const w = String(q).split(/\s+/).filter((x) => !/^\d+$/.test(x)).sort((x, y) => y.length - x.length)[0];
      if (w) { const r2 = await fetch('https://nl.go.kr/newspaper/search_newspaper.do', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Referer: 'https://nl.go.kr/newspaper/keyword_search.do' }, body: JSON.stringify({ search_keyword: w, page_size: Math.min(n, 10), page_no: 1 }), signal: AbortSignal.timeout(FETCH_TIMEOUT) }); if (r2.ok) d = await r2.json(); }
    }
    const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
    return (d.hits || []).slice(0, n).map((h) => ({
      title: `${first(h.label)} — ${first(h.newspaperKorName)}${first(h.newsposition) ? ` [${first(h.newsposition)}]` : ''}`.slice(0, 110), // v1.85: 지면 위치(n면 n단) — 신문 인용 좌표
      date: String(h.issued_date || ''), id: first(h.uri), ...(first(h.newspaperKorName) ? { series: first(h.newspaperKorName) } : {}),
      url: first(h.uri) ? `https://nl.go.kr/newspaper/detail.do?content_id=${first(h.uri)}` : 'https://nl.go.kr/newspaper/' }));
  },
  commons: async (q, n) => { // 위키미디어 공용 — 키 불요 검색 API(PD 사진·NARA/해군 재수집본 다수 — 원 소장처 역추적 창구). 공유 IP 429 시 채널 실패로 표시
    // commons는 한국어 네이티브 검색 가능 — TOPICS 미등재어(인명 등)가 'Korea' 단독으로 뭉개지면 원질의 유지(v1.62 실측 교정: '유관순'→일제감시대상인물카드 직결)
    const t = koToEn(q); const en = (!t || t === 'Korea') ? q : t;
    // v1.81: list=search → generator=search + prop=categories 1콜 전환 — 파일의 소속 카테고리(큐레이션 계층)를 목록 레벨에서 확보
    const d = await jget('https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&format=json&gsrlimit=' + Math.min(n, 10) + '&gsrsearch=' + encodeURIComponent(en) + '&prop=categories%7Cimageinfo&clshow=!hidden&cllimit=3&iiprop=url',
      { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' });
    return Object.values((d.query || {}).pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0)).map((it) => {
      const t2 = String(it.title || '');
      const cat = String((((it.categories || [])[0] || {}).title || '')).replace(/^Category:/, '');
      const iiu = String((((it.imageinfo || [])[0] || {}).url || '')).split('?')[0]; // v1.84: 원본 파일 직링크(utm 추적 파라미터 제거 — 절단 없는 영속 URL)
      // v1.88: NARA 기증본 파일명 규칙 — '… - NARA - <NAID>.tif'(520782 실측 일치) · 'NARA <고유번호> …'(127-N-A4501형)
      const cn = (t2.match(/[-_ ]NARA[-_ ]+(\d{5,10})\.\w+$/i) || [])[1]; const cl = !cn && (t2.match(/^File:NARA[ _]+(\d{2,3}[A-Z]?-[A-Z0-9]+-[A-Z0-9-]+?)[ _]/i) || [])[1];
      return { title: t2.replace(/^File:/, '').slice(0, 110), date: '', id: '', ...(cat ? { series: cat.slice(0, 80) } : {}), ...(iiu ? { media: iiu } : {}), ...(cn ? { sameAs: `NAID ${cn}` } : cl ? { sameAs: `NARA ${cl.toUpperCase()}` } : {}), url: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(t2.replace(/ /g, '_')) };
    });
  },

  nlna: async (q, n) => { // 네덜란드 국립문서보관소 — 공개 JSON API 실측(2026-11-20, Playwright 역추적). 주한 대사관 문서군 등
    const en = koToEn(q) || q;
    const d = await jget(`https://zvt.nationaalarchief.nl/api/search/eads?page=1&rows=${Math.min(n, 10)}&q=${encodeURIComponent(en)}&sortBy=_score`);
    // v1.81: 토이강(toegang) 번호 첫 두 세그먼트 = 형성기관 클러스터(2.05 외무부 등 — 2.05.202 'Zuid-Korea 대사관' 실측)
    const NLNA_CL = { '2.04': '내무부(Binnenlandse Zaken)', '2.05': '외무부(Buitenlandse Zaken)', '2.09': '법무부(Justitie)', '2.10': '식민성(Koloniën)', '2.12': '해군(Marine)', '2.13': '국방부(Defensie)', '2.19': '민간단체 문서', '2.21': '개인·가문 문서', '2.24': '사진·영상 컬렉션' };
    return ((d && d.results) || []).slice(0, n).map((r) => {
      const cl = String(r.id || '').split('.').slice(0, 2).join('.');
      const ser = NLNA_CL[cl] ? `${cl} ${NLNA_CL[cl]}` : (cl.includes('.') ? `토이강 ${cl}` : '');
      return {
        title: norm(String(r.title || '')).slice(0, 95) + (r.type === 'ARCHIVE' ? ' [문서군]' : ''),
        date: String(r.period || ''), id: String(r.id || ''), ...(ser ? { series: ser } : {}),
        url: 'https://www.nationaalarchief.nl/onderzoeken/archief/' + encodeURIComponent(String(r.id || '')),
      };
    });
  },
  nzarch: async (q, n) => { // Archives NZ Collections(Te Rua Mahara) — 연합검색 공개 API(SSE 프레임 JSON, 무키 평문 GET 실측).
    // v1.58: 사용자 요청 → GH 러너(유일한 Incapsula 통과 환경) 역공학 10차로 완결. accessStatus=권리 표시(발굴 우선).
    const en = koToEn(q) || q;
    try {
      const b = await gtext('https://collections.archives.govt.nz/federated-search/customers/aims/search?size=' + Math.min(n, 20)
        + '&facetSize=0&start=0&isFuzzy=true&sourceId=aims-archive&q=' + encodeURIComponent(en));
      // 0건 응답엔 hits 키가 없다(totalHits만) — totalHits로 스트림 판별(실측 함정)
      const line = b.split('\n').find((l) => l.startsWith('data:') && l.includes('"totalHits"'));
      if (!line) throw new Error('no-stream');
      const j = JSON.parse(line.slice(5));
      return (j.hits || []).map((h) => {
        const e = h.entity || {};
        const cf = (k) => { try { return String(e.custom[k].value[0].value); } catch { return ''; } };
        const acc = cf('accessStatus');
        return { title: `${norm(String(e.name || '(무제)')).slice(0, 92)}${acc ? ` [${acc}]` : ''}`,
          date: cf('resultDate'), id: String(e.id || ''), ...(cf('series') ? { series: cf('series') } : {}),
          url: e.id ? `https://collections.archives.govt.nz/web/arena/search#/entity/aims-archive/${e.id}?q=${encodeURIComponent(en)}` : '' };
      });
    } catch { // 간헐 Incapsula(클라우드 IP 신뢰점수) — GH 주간 수확 정적 인덱스 폴백(자체 도메인)
      const ix = await cachedText('nzIdx', 6 * 3600e3, () => gtext('https://korea-archive-mcp.vercel.app/nz-index.json'), '"records"');
      const j = JSON.parse(ix); const ql = en.toLowerCase();
      // R번호(id) 질의도 매칭 — 라이브 차단 중 'R17717658' 재조회가 0건이 되지 않게(실측 교훈)
      return (j.records || []).filter((r) => String(r.title || '').toLowerCase().includes(ql) || String(r.id || '').toLowerCase() === ql).slice(0, n)
        .map((r) => ({ title: `${String(r.title).slice(0, 86)}${r.access ? ` [${r.access}]` : ''} ·주간인덱스`,
          date: String(r.date || ''), id: String(r.id || ''),
          url: `https://collections.archives.govt.nz/web/arena/search#/entity/aims-archive/${r.id}` }));
    }
  },
  dnz: async (q, n) => { // DigitalNZ 집계 API(무키 JSON) — v1.57 합류: Papers Past(직접 차단 — 본 API로 우회 복구)·터닝불도서관·Te Papa 등 NZ 30+기관
    const en = koToEn(q) || q;
    // v1.91.1: 2026-11 실측 — 서버(icn1) 익명 호출 HTTP 403(작업망 익명은 200 — IP 기반). DNZ_API_KEY(digitalnz.org/developers 무료) 설정 시 키 헤더로 호출
    const dk = process.env.DNZ_API_KEY;
    let d;
    try {
      d = await jget('https://api.digitalnz.org/v3/records.json?per_page=' + Math.min(n, 20)
        + '&fields=id,title,display_date,landing_url,content_partner,primary_collection&text=' + encodeURIComponent(en), dk ? { 'Authentication-Token': dk } : {});
    } catch (e) { if (/403/.test(String(e))) throw new Error(`HTTP 403 — 서버 IP 익명 호출 차단${dk ? '(키 거부 — DNZ_API_KEY 확인)' : '(DNZ_API_KEY 미설정 — 등록 시 복구)'} · 대체: digitalnz.org/records?text=${encodeURIComponent(en)} 웹 검색`); throw e; }
    return (((d || {}).search || {}).results || []).map((r) => ({
      title: `${norm(String(r.title || '(무제)'))} — ${((r.content_partner || [])[0] || '')}${(r.primary_collection || [])[0] ? '·' + (r.primary_collection || [])[0] : ''}`.slice(0, 115),
      date: String(r.display_date || ''), id: String(r.id || ''),
      ...(((r.content_partner || [])[0]) ? { series: `${(r.content_partner || [])[0]}${(r.primary_collection || [])[0] ? ' › ' + (r.primary_collection || [])[0] : ''}` } : {}),
      url: String(r.landing_url || '') }));
  },
  awm: async (q, n) => { // 호주 전쟁기념관(AWM) — 검색 모자이크(SSR C-id) → 상세 병렬로 제목·수장번호 (2026-11-20 실측: 가평 파노라마 HOBJ3144 등)
    const en = koToEn(q) || q;
    const b = await gtext('https://www.awm.gov.au/advanced-search?query=' + encodeURIComponent(en));
    const ids = [...new Set([...b.matchAll(/href="\/collection\/(C\d+)"/g)].map((m) => m[1]))].slice(0, Math.min(n, 10)); // v1.96.3: 5→10(상세 병렬 조회 상한)
    const out = await Promise.all(ids.map(async (cid) => {
      try {
        const d = await cachedText('awm:' + cid, 24 * 3600e3, () => gtext('https://www.awm.gov.au/collection/' + cid), '<h1');
        const h1 = d.match(/<h1[^>]*>\s*(?:<[^>]+>\s*)*([^<]{3,120})/);
        const acc = d.match(/(?:Accession Number|ID number)[^A-Z0-9]{0,40}([A-Z0-9/.\-]{3,20})/);
        const pd = /Copyright expired - public domain|publicdomain\/mark/.test(d);
        const conf = d.match(/Conflict[^<]*<\/[a-z0-9]+>\s*<[^>]*>\s*(?:<[^>]+>\s*)*([^<]{4,40})/);
        const ot = d.match(/Object type<\/th>\s*<td>\s*([^<]{2,40})/); // v1.81: 소장품 유형(Photograph·Film·Firearm 등 — C285584 실측)
        return { title: (h1 ? norm(h1[1]) : cid) + (pd ? ' · 권리:PD(저작권 만료)' : ''), date: conf ? norm(conf[1]) : '', id: acc ? acc[1] : cid, ...(ot ? { series: norm(ot[1]) } : {}), url: 'https://www.awm.gov.au/collection/' + cid };
      } catch { return null; }
    }));
    return out.filter(Boolean);
  },
  jsg: async (q, n) => { // AKS 장서각 — ★검색 파라미터는 q=query|<어> (플레인 q는 무시되고 전체 열람 반환 — Playwright 실브라우저 재역공학으로 확정, 2026-11-20)
    const b = await jsgText('https://jsg.aks.ac.kr/search/group?q=' + encodeURIComponent('query|' + q));
    const out = []; const seen = new Set();
    for (const m of b.matchAll(/href="\/dir\/view\?dataId=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const t = norm(m[2]);
      if (!t || seen.has(m[1]) || /^JSG_K1-[1-5]$/.test(m[1])) continue;
      seen.add(m[1]);
      const jid = m[1].startsWith('JSG_') ? m[1].slice(4) : '';
      const sb = { K1: '經部(K1)', K2: '史部(K2)', K3: '子部(K3)', K4: '集部(K4)' }[jid.split('-')[0]];
      out.push({ title: t.slice(0, 95), date: '', id: jid, ...(sb ? { series: sb } : {}), url: 'https://jsg.aks.ac.kr/dir/view?dataId=' + encodeURIComponent(m[1]) });
      if (out.length >= n) break;
    }
    return out;
  },
  kyudb: async (q, n) => { // 서울대 규장각 — 기존 jKyu(목록+해제 POST) 코어 재사용
    const r = await jKyu(q);
    const list = Array.isArray(r['목록']) ? r['목록'] : [];
    const rows = r['목록항목'] || [];
    if (rows.length) return rows.slice(0, n).map((x) => { const km = x.call.match(/^(奎|古|想白|一簑)/); const kn = km && { '奎': '규장각도서(奎)', '古': '고도서(古)', '想白': '상백문고', '一簑': '일사문고' }[km[1]];
      const cls = String(x.cls || '').split(/\s+/).filter(Boolean).slice(0, 4).join(' › '); // v2.2: 사부분류(史部 › 政法類 › 度支 …)를 계열로 — 조선 기록의 분류 계층
      const bc = (r['목록코드'] || {})[norm(x.call)] || (r['해제코드'] || {})[norm(x.call)];
      return { title: `[${x.call}] ${x.title} · ${x.author}`.slice(0, 120), date: x.date, id: x.call, ...((kn || cls) ? { series: [kn, cls].filter(Boolean).join(' › ') } : {}), url: bc ? `${JKYU}/book/view.do?book_cd=${bc}` : 'https://kyudb.snu.ac.kr' }; });
    const cx = {};
    return list.slice(0, n).map((t) => { const km = String(t).match(/(奎|古|想白|一簑)\s*\d/); const kn = km && { '奎': '규장각도서(奎)', '古': '고도서(古)', '想白': '상백문고', '一簑': '일사문고' }[km[1]]; return { title: cx[t] ? `${t} ${cx[t]}`.slice(0, 110) : String(t), date: '', id: String(t), ...(kn ? { series: kn } : {}), url: 'https://kyudb.snu.ac.kr' }; });
  },
  i815: async (q, n) => { // 독립기념관 — v1.32 목록 실체화: 최대 카테고리의 실제 자료 제목+GET 딥링크(data-mngno/gubun → detail.do), 나머지는 집계 신호
    const base = 'https://search.i815.or.kr';
    const b = await gtext(base + '/main/totalSearch.do?searchWord=' + encodeURIComponent(q) + '&searchMenu=all');
    const cats = [];
    for (const m of b.matchAll(/href="(\/main\/moreContentsSearchList\.do[^"]*)"[^>]*>([^<]+?)\s*([\d,]+)\s*건</g)) {
      if (m[3] === '0') continue;
      cats.push({ u: m[1].replace(/&amp;/g, '&'), name: norm(m[2]), cnt: parseInt(m[3].replace(/,/g, ''), 10), disp: m[3] });
    }
    const out = [];
    if (cats.length) {
      const top = cats.reduce((a, c) => (c.cnt > a.cnt ? c : a));
      try { // 구분(gubun)→상세 GET 경로 — 목록 페이지 contentsFrm(method=get) 역공학(2026-11-20 실측)
        const DETAIL = { 2: ['contents/mijooAcademy/mijooAcademyDetailList.do', 'mngNo'], 3: ['contents/proGovernment/proGovernmentDetailList.do', 'mngNo'],
          4: ['contents/independenceFighter/detail.do', 'independenceFighterId'], 7: ['contents/missionary/detail.do', 'missionaryId'],
          8: ['contents/newsPaper/detail.do', 'newsPaperId'], 9: ['contents/medicalData/MedicalDataDetailList.do', 'mngNo'], 9999: ['contents/microFilm/detail.do', 'adminId'] };
        const lb = await gtext(base + top.u);
        for (const m of lb.matchAll(/data-mngno="([^"]+)"[^>]*data-gubun="(\d+)"[^>]*>([\s\S]*?)<\/strong>/g)) {
          const d = DETAIL[m[2]];
          out.push({ title: `[${top.name}] ${norm(m[3].replace(/<[^>]+>/g, ''))}`.slice(0, 110), date: '', id: m[1],
            series: top.name,
            url: d ? `${base}/${d[0]}?${d[1]}=${encodeURIComponent(m[1])}&sortNo=${m[2]}` : base + top.u });
          if (out.length >= Math.max(2, n - 2)) break;
        }
      } catch { /* 목록 실패 — 집계 신호로 폴백 */ }
    }
    for (const c of cats) {
      if (out.length >= n) break;
      out.push({ title: `독립기념관 ${c.name} ${c.disp}건`, date: '', id: '', series: c.name, url: base + c.u }); // v2.3: 집계 신호도 계열(카테고리) 부여
    }
    return out;
  },
  gonghun: async (q, n) => { // 공훈전자사료관(국가보훈부) — 독립유공자 공훈록. 2026-11-20 복구 실측(GET 검색·상세 딥링크)
    // 인명 검색 채널(nameKo) — 일반 키워드는 0건이 정상. 성명은 base64(utf8_decode JS), mngNo로 상세 GET 직행
    const b = await gtext('https://e-gonghun.mpva.go.kr/user/ContribuReportList.do?goTocode=20001&nameKd=NAME_KOR&nameKo=' + encodeURIComponent(q) + '&pageIndex=1&pageUnit=' + Math.min(Math.max(n, 1), 10));
    const out = [];
    for (const seg of b.split('fnContribuReportView(').slice(1)) {
      const mn = seg.match(/^'(\d+)'/);
      if (!mn) continue;
      const b64 = (seg.match(/utf8_decode\('([A-Za-z0-9+/=]+)'/) || [])[1];
      let name = ''; try { name = b64 ? Buffer.from(b64, 'base64').toString('utf8') : ''; } catch { /* b64 아님 — 성명 생략 */ }
      const tds = [...seg.matchAll(/<td[^>]*>\s*([^<]{1,60}?)\s*</g)].map((x) => norm(x[1])).filter(Boolean).slice(0, 6);
      // tds: 한자명·생몰년·운동계열·포상년도·포상훈격·생존여부
      out.push({ title: `${name}${tds[0] ? `(${tds[0]})` : ''} ${tds[1] || ''} · ${tds[2] || ''} · ${tds[3] || ''} ${tds[4] || ''}`.replace(/\s+/g, ' ').trim(),
        ...(tds[2] ? { series: tds[2] } : {}),
        date: tds[3] || '', id: mn[1],
        url: `https://e-gonghun.mpva.go.kr/user/ContribuReportDetail.do?goTocode=20001&mngNo=${mn[1]}&pageTitle=Report` });
      if (out.length >= n) break;
    }
    return out;
  },
  ktv: async (q, n) => { // v2.37 e영상역사관 자체 목록 검색 우선(ehistory.go.kr — 정직 UA 정상 응답, 2026-11-24 실측). ktv.go.kr 통합검색은 쿠키 확인 리다이렉트(303 → /)로 자동 요청을 받지 않음 → 보조
    const eh = await ehistorySearch(q, n).catch(() => []);
    if (eh.length) return eh;
    return ktvTotalSearch(q, n);
  },
  _ktvLegacy: async (q, n) => { // KTV e영상역사관 — ktv.go.kr 통합검색 iframe GET 실측(2026-11-19)
    // v1.94: 기본 정렬이 '최신순'(sort 파라미터 무효 실측)이라 최근 대통령 영상이 상위를 독점 → 기록 탭(ehistoryStleSe)별 병렬 조회 후 교차 병합, 대통령 기록영상(DT)은 뒤로
    const TABS = [['DH', '대한뉴스'], ['MH', '문화영화'], ['DK', '미공개 대한뉴스'], ['BK', '정부기록사진집'], ['PT', '국가기록사진'], ['', '전체']];
    const base = 'https://www.ktv.go.kr/totalSearch/ehistory?design=new&collection=ehistory&baseKeyword=' + encodeURIComponent(q);
    // v1.96.7: 제목은 <dt><a>…</a></dt> 전체 — 검색어 강조 <span>에서 잘려 '역사와 함께한'·'[2040호]'만 남던 결함 교정. 제작일·요지 동반
    const parse = (b, label) => { const seen = new Set(); const out = [];
      for (const blk of b.split('<div class="list">').slice(1)) {
        const m = blk.match(/<dt>\s*<a href="(https:\/\/www\.ehistory\.go\.kr\/view\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/)
          || blk.match(/href="(https:\/\/www\.ehistory\.go\.kr\/view\/[^"]+)"[^>]*>([^<]{4,120})/);
        if (!m) continue;
        const t = norm(m[2].replace(/<[^>]+>/g, '')); const u = m[1].replace(/&amp;/g, '&');
        if (!t || /paging|overflow/.test(t) || seen.has(u)) continue; seen.add(u);
        const g = (u.match(/mediagbn=(\w+)/) || [])[1] || (/\/photo\?/.test(u) ? 'PT' : '');
        const dt = ((blk.match(/제작일\s*:\s*([\d.]{4,10})/) || [])[1] || '').replace(/\.00/g, '').replace(/\.$/, '');
        const sn = norm(((blk.match(/<dd>\s*<p>([\s\S]*?)<\/p>/) || [])[1] || '').replace(/<[^>]+>/g, '')).replace(/^\.\.\.\s*|\s*\.\.\.$/g, '').slice(0, 90);
        out.push({ title: t.slice(0, 110), date: dt, id: '', series: label === '전체' ? ({ DT: '대통령 기록영상', DH: '대한뉴스', MH: '문화영화', DK: '미공개 대한뉴스' }[g] || 'e영상역사관') : label, url: u, ...(sn ? { desc: sn } : {}), _dt: g === 'DT' });
      } return out; };
    const res = await Promise.allSettled(TABS.map(([c, l]) => gtext(base + (c ? '&ehistoryStleSe=' + c : '')).then((b) => parse(b, l))));
    const lists = res.map((r) => (r.status === 'fulfilled' ? r.value : []));
    if (lists.every((l) => !l.length) && res.every((r) => r.status === 'rejected')) throw res[0].reason;
    const seen = new Set(); const out = []; const late = [];
    for (let k = 0; k < 10 && out.length < n; k++) for (const l of lists) { const it = l[k]; if (!it || seen.has(it.url)) continue; seen.add(it.url); (it._dt ? late : out).push(it); }
    return [...out, ...late].slice(0, n).map(({ _dt, ...it }) => it);
  },
  earchive: async (q, n) => { // 국사편찬위 전자사료관 — POST 검색 실측(2026-11-19). NARA 수집 사료(AUS…) 원문 소장. 상세는 세션 기반이라 사료ID 표기
    const r = await fetch('https://archive.history.go.kr/search/searchResult.do', {
      method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ allSearchQuery: q, searchQuery: q, searchPageIndex: '1', searchPageUnit: String(Math.min(n, 20)), searchPageSize: '10' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const b = await r.text();
    const out = [];
    // v1.81: 행 하단 스팬 전면 수확 — code(사료ID)·국내외·국가·소장기관·생산기간 (2026-11-21 실측: AUS033… → 미국 › 국립문서기록관리청)
    for (const seg of b.split('fnGoCatalogView(').slice(1)) {
      const t = (seg.match(/title="([^"]{3,140})/) || [])[1];
      if (!t) continue;
      const sid = (seg.match(/<span class="code">([^<]+)</) || [])[1] || (seg.match(/^'(\d+)'/) || [])[1] || '';
      const spans = [...seg.slice(0, 2500).matchAll(/<span class="date">\s*([^<]{1,80}?)\s*<\/span>/g)].map((x) => norm(x[1]));
      const meta = spans.filter((s) => !/^생산/.test(s)); // [국내외, 국가, 소장기관]
      const ser = [meta[1] || '', (meta[2] || '').split('(')[0].trim()].filter(Boolean).join(' › ');
      const prod = ((spans.find((s) => s.startsWith('생산기간')) || '').match(/[\d.~\s]{4,24}/) || [''])[0].trim();
      const sys = (seg.match(/^'(\d{6,})'/) || [])[1] || ''; // v2.35 fnGoCatalogView 첫 인자 = systemId → GET 고정 상세(세션 불필요, 2026-11-24 실측)
      out.push({ title: norm(t).slice(0, 110), date: prod, id: norm(sid), ...(ser ? { series: ser.slice(0, 60) } : {}), url: sys ? `https://archive.history.go.kr/record/catalog/catalogView.do?systemId=${sys}` : 'https://archive.history.go.kr' });
      if (out.length >= n) break;
    }
    return out;
  },
  jacar: async (q, n) => { // 일본 아시아역사자료센터 — GET 검색 실측(2026-11-19, docs/jacar-access-spec.md)
    // v1.96.5: 일문·한자 입력이 영문 'Korea'로 바뀌어 무관 결과(전후 A171…)가 나오던 결함 — 한글 없는 입력·한→일 사상은 일본어 검색(/aj/search, 일본어 표제·연대)으로
    const hasHg = /[\uac00-\ud7a3]/.test(q); const ja = hasHg ? koToJa(q) : q;
    const useJa = !!ja && !/[\uac00-\ud7a3]/.test(ja);
    const kw = useJa ? ja : (koToEn(q) || q);
    const b = await gtext(`https://www.jacar.archives.go.jp/aj/${useJa ? 'search' : 'search-en'}?kw=` + encodeURIComponent(kw)); // 파라미터는 kw — keyword는 무시됨(실측)
    const out = [];
    for (const blk of b.split('<li class="archive-result-table__body-item"').slice(1)) {
      const c = blk.match(/value="aj\d+\/([A-Z]\d{11})"/);
      const t = blk.match(/id="row-\d+-title"[\s\S]*?<span\s*>([^<]{3,150})/);
      const dt = (blk.match(/((?:明治|大正|昭和)[０-９\d]+年(?:[^<]{0,14}?年)?)/) || [])[1] || '';
      if (c && t) out.push({ title: norm(t[1]), date: dt, id: c[1], url: `https://www.jacar.archives.go.jp/das/meta${useJa ? '' : '-en'}/` + c[1] });
      if (out.length >= n) break;
    }
    return out;
  },
  seoul: async (q, n) => { // 서울기록원 — v1.36 기록 단위 실체화: /catalog/result 서버 렌더 파싱 + fnDetail 딥링크(/item·/aggregation GET 실측)
    const base = 'https://archives.seoul.go.kr';
    const deep = base + '/catalog/result?regclass=ALL&query=' + encodeURIComponent(q);
    const b = await gtext(deep);
    const out = []; const used = new Set();
    // ① 시리즈형: fnDetail 직후 2600자 내 d02 제목이 따르는 블록 — 제목+딥링크 완결
    for (const seg of b.split("fnDetail('").slice(1)) {
      const path = (seg.match(/^(\/[a-z-]+\/\d+)/) || [])[1];
      if (!path) continue;
      const tt = (seg.slice(0, 2600).match(/<p class="d02">\s*<span><b>([\s\S]*?)<\/b>/) || [])[1];
      if (tt) { used.add(norm(tt.replace(/<[^>]+>/g, ''))); out.push({ title: norm(tt.replace(/<[^>]+>/g, '')).slice(0, 110), date: '', id: path.split('/')[2] || '', ...(path.split('/')[1] ? { series: path.split('/')[1] } : {}), url: base + path }); }
      else out.push({ title: `[기록건·사진] ${path.split('/')[1]} ${path.split('/')[2]} — 제목·이용조건은 상세 URL 판독`, date: '', id: path.split('/')[2] || '', url: base + path });
      if (out.length >= n) break;
    }
    // ② 컬렉션 카드형: d02 제목만 있고 링크는 JS 바인딩 — 제목+전체결과 URL로 신호
    if (out.length < n) for (const m of b.matchAll(/<p class="d02">\s*<span><b>([\s\S]*?)<\/b>/g)) {
      const tt = norm(m[1].replace(/<[^>]+>/g, ''));
      if (!tt || used.has(tt)) continue;
      used.add(tt);
      out.push({ title: `[컬렉션] ${tt}`.slice(0, 110), date: '', id: '', url: deep });
      if (out.length >= n) break;
    }
    // v1.96.7: 기록건(사진) 행은 목록에 제목이 없다(썸네일만 — 실측) → 상세 페이지 <title>에서 제목 보강(최대 6건 병렬·5s)
    const need = out.filter((it) => it.title.startsWith('[기록건·사진]')).slice(0, 6);
    await Promise.all(need.map(async (it) => {
      try {
        const r = await fetch(it.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
        const h = await r.text();
        const t = ((h.match(/<title>[^<]*?상세보기\s*-\s*([^<|]{1,120}?)\s*\|/) || [])[1] || '').trim();
        if (t) it.title = `[기록건·${it.url.includes('/item/') ? '사진' : '기록'}] ${norm(t)}`.slice(0, 110);
      } catch { /* 제목 보강 실패 시 안내 문구 유지 */ }
    }));
    return out;
  },
  foia: async (q, n) => { // 정보공개 원문 라이브 채널: 서울정보소통광장 결재문서 — 전용 도구(foia_search)와 동일 경로
    // 기지 차단(연결 리셋 ~11s×2회 재시도=21s 소모 실측) — 단발 6s fail-fast로 health·연합 탐침 시간 보호. 복구 시 자동 정상화
    let r;
    try { r = await fetch('https://opengov.seoul.go.kr/sanction/list?searchKeyword=' + encodeURIComponent(q), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }); }
    catch (e) { const st = await openGoStatus(q); throw new Error(`서울정보소통광장 연결 실패(${e.name === 'TimeoutError' ? '시간 초과' : e.message})${st.msg ? ' · ' + st.msg : ''} → foia_search로 청구 경로 안내`); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.text();
    const seen = new Set(); const out = [];
    const re = /<a[^>]+href="(\/sanction\/\d+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
    while ((m = re.exec(b)) && out.length < n) { const t = norm(m[2]).replace(/^제목\s*:\s*/, ''); if (t && !seen.has(m[1])) { seen.add(m[1]); out.push({ title: t, date: '', id: '', url: 'https://opengov.seoul.go.kr' + m[1] }); } }
    return out;
  },
  gallery: async (q, n) => { // v1.97.1: 우리 IIIF 갤러리 — 30곳 탐방·100선 실물 기록 800장(권리 확인·출처 대장 완비)을 연합 검색에 합류. index.json 6h 캐시
    const GB = 'https://changgi.github.io/korea-archive-mcp/';
    const b = await cachedText('kaGallery', 6 * 3600e3, () => gtext(GB + 'iiif/index.json'), '"series"');
    const D = JSON.parse(b); const toks = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const en = (koToEn(q) || '').toLowerCase().split(/\s+/).filter((t) => t && t !== 'korea');
    const hit = (h) => toks.every((t) => h.includes(t)) || (en.length > 0 && en.every((t) => h.includes(t)));
    const out = [];
    for (const S of D.series) {
      const head = (S.label + ' ' + Object.values(S.rec || {}).join(' ') + ' ' + S.part).toLowerCase();
      const cs = S.c.map((c, k) => ({ c, k, h: head + ' ' + (c.t + ' ' + Object.values(c.md || {}).join(' ')).toLowerCase() })).filter((x) => hit(x.h));
      if (!cs.length) continue;
      const { c, k } = cs[0];
      out.push({ title: `${S.label} — ${c.t}`.slice(0, 130) + (cs.length > 1 ? ` (+${cs.length - 1}장)` : ''), date: (c.md || {})['연대'] || (S.rec || {}).date || '',
        id: `${S.key}/${k + 1}`, series: S.part, url: `${GB}iiif.html#${S.key}/${k + 1}`, media: GB + 'iiif/' + c.img });
      if (out.length >= n) break;
    }
    return out;
  },
  nrich: async (q, n) => { // v2.13 국립문화유산연구원 — 국외문화유산 DB(명칭) + 발간자료(보고서·초록·목차). 계층=국외문화유산 › 국가 › 소장처 / 발간자료 › 연구분야
    const [ov, rp, db] = await Promise.all([nrOvList(q).catch(() => []), nrRepApi(q, Math.max(2, Math.ceil(n / 2))).catch(() => []), nrDbQuick(q, n)]);
    const a = ov.slice(0, n).map((r) => ({ title: `[국외문화유산] ${r.title} — ${[r.nation, r.holder].filter(Boolean).join(' ')}`.slice(0, 160), date: r.era, id: `ov:${r.mseq}`, series: ['국외문화유산', r.nation, r.holder].filter(Boolean).join(' › '), url: r.url }));
    const b = rp.slice(0, Math.max(2, Math.ceil(n / 2))).map((r) => ({ title: `[발간자료] ${r.title}`.slice(0, 160), date: r.year, id: `rep:${r.idx}`, series: ['발간자료', nrField(r.field)].filter(Boolean).join(' › '), url: r.url, ...(r.img ? { media: r.img } : {}) }));
    const c = db.map(nrDbItem);
    return b.concat(c.slice(0, Math.max(2, Math.ceil(n / 2))), a, c.slice(Math.max(2, Math.ceil(n / 2)))).slice(0, n + b.length);
  },
  okchf: async (q, n) => { // v2.11 국외소재문화유산재단 대국민 아카이브 — 통합검색(국외문화유산·사진아카이브). 계층=유형 › 소장국가 › 소장처
    const [b, pub] = await Promise.all([cachedText(`okL:${n}:${q}`, 6 * 3600e3, () => gtext(`${OK_B}/archive/total-search.do?srSearchVal=${encodeURIComponent(q)}&pagerLimit=${n <= 10 ? 10 : n <= 20 ? 20 : 50}`, OK_UA), 'data-result'),
      okPubSearch(q).catch(() => ({ items: [] }))]); // 조사보고서(목차) — 소장처 단위 맥락
    const reps = pub.items.slice(0, Math.min(3, Math.max(1, Math.floor(n / 3)))).map((r) => ({ title: `[조사보고서] ${r.title}`.slice(0, 160), date: '', id: `pub:${r.no}`, series: '발간자료 › 조사보고서', url: r.url, ...(r.img ? { media: r.img } : {}) }));
    return reps.concat(okList(b).out.slice(0, n).map((r) => ({ title: `[${r.type}] ${r.title} — ${[r.country, r.holder].filter(Boolean).join(' ')}`.slice(0, 160), date: '', id: r.id,
      series: [r.type, r.country, r.holder].filter(Boolean).join(' › '), url: r.url, ...(r.img ? { media: r.img } : {}) }))).slice(0, n + reps.length);
  },
  ledger: async (q, n) => { // v2.6: 발견 누적 원장 — 사용자들이 이미 발굴한 기록(검색어 없음)을 다시 검색. docs/data/discovered.jsonl 1h 캐시. 'all'에는 넣지 않는다(원 기관 결과와 중복·교차확인 오인 방지) — sources='ledger'로 명시
    const b = await cachedText('kaLedger', 3600e3, () => gtext('https://changgi.github.io/korea-archive-mcp/data/discovered.jsonl'), '"key"');
    const toks = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const en = (koToEn(q) || '').toLowerCase().split(/\s+/).filter((t) => t && t !== 'korea');
    const out = [];
    for (const ln of b.split('\n')) {
      if (!ln.trim()) continue; let o; try { o = JSON.parse(ln); } catch { continue; }
      if (o.entry_type === '결함 출력') continue; // v2.34 옛 파서 오류 출력 — 원장에는 증거로 보존, 검색 결과에선 제외
      const h = `${o.title} ${o.partOf || o.partOf_derived || ''} ${o.id || ''} ${(o.sources || []).join(' ')} ${o.date || ''} ${(o.meta || []).map((m) => String(m[1] || '')).filter((v) => !/^https?:/.test(v)).join(' ')} ${o.summary || o.summary_composed || ''}`.toLowerCase(); // v2.42 기관 주제어·지명·요약까지 검색
      if (!(toks.every((t) => h.includes(t)) || (en.length && en.every((t) => h.includes(t))))) continue;
      out.push({ title: `[${(o.sources || []).join('+')} · 발견 ${o.seen}회 · 7일 ${o.seen_7d || 0} · ${o.days_total || 1}일 · 첫 ${String(o.first_seen).slice(0, 10)}${o.rank ? ` · 활용 ${o.rank}위` : ''}${(o.found_by || []).length ? ` · 경로 질의 ${o.found_by.length}` : (o.found_by_derived ? ' · 경로 원장(파생)' : '')}] ${o.entry_type === '검색 안내' ? '[검색 안내] ' : ''}${o.title}${o.link_note ? ` (${o.link_note})` : ''}`.slice(0, 220), date: o.date || (o.date_derived ? `${o.date_derived} [파생]` : ''), id: o.id || o.key, // v2.50 기관 메타(생산기간·발간연도)·심층 판독에서 세운 날짜는 [파생] 표시
        series: o.partOf || o.partOf_derived || '', url: o.url || '', // v2.27 원 기관 계층이 없으면 파생 계층([파생] 표시)
        media: o.media || '', ...(o.sameAs ? { sameAs: o.sameAs } : {}), seen: o.seen || 1, rank: o.rank || 1e9,
        ...(((o.same_keys || []).length || o.date_cross) ? { note: [(o.same_keys || []).length ? `같은 기록 ${o.same_keys.length + 1}곳 소장(${o.same_keys.join(', ')})` : '', o.date_cross ? `날짜 교차 ${String(o.date_cross.verdict || '').split('(')[0]}` : ''].filter(Boolean).join(' · ') } : {}) }); // v2.92.1 맥락·증거 — 제목 앞 꼬리표가 길어 제목이 잘리지 않게 별도 줄
    }
    return out.sort((a, b) => a.rank - b.rank || b.seen - a.seen).slice(0, n); // v2.7: 활용 순위(최근·지속·교차확인 가중)
  },
  aks: async (q, n) => { // 한국고문서자료관 소장처 매칭(내장 카탈로그 — 네트워크 0)
    const toks = q.split(/\s+/).filter(Boolean);
    return AKS_CAT.filter((c) => toks.length && toks.every((t) => (c.name + ' ' + c.grp).includes(t))).slice(0, n)
      .map((c) => ({ title: `[고문서 소장처] ${c.name} (${c.grp})`, date: '', id: c.id, series: c.grp, url: AKS_BASE + '/viewer/viewer.do' }));
  },
};

// ══════════ 조선 사료 심층 판독 (db.history.go.kr · sjw · kyudb — joseon-source-mining 이식) ══════════
const JDB = 'https://db.history.go.kr';
const JSJW = 'https://sjw.history.go.kr';
const JKYU = 'https://kyudb.snu.ac.kr';
const JDB_HDR = { Referer: JDB + '/' };
async function jdbPost(url, params, headers = {}) {
  const body = new URLSearchParams(params).toString();
  let lastErr;
  for (let a = 0; a < 3; a++) { // v1.96.2: 'terminated(UND_ERR_RES_CONTENT_LENGTH_MISMATCH)' 간헐 실측 — 3회·백오프, 재시도는 비압축 응답 요청
    try {
      const r = await fetch(url, { method: 'POST', body,
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', ...JDB_HDR, ...(a ? { 'Accept-Encoding': 'identity' } : {}), ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // v2.39.1 본문이 선언 길이보다 일찍 끊기는 응답(UND_ERR_RES_CONTENT_LENGTH_MISMATCH — 기관 측) — 받은 만큼 보존해 판독(결과는 페이지 앞부분)
      const reader = r.body.getReader(); const chunks = []; let got = 0;
      let cut = null;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; } }
      catch (e) { if (!got || !/terminated|CONTENT_LENGTH|other side closed|socket/i.test(errInfo(e))) throw e; cut = e; }
      const buf = new Uint8Array(got); let off = 0; for (const c of chunks) { buf.set(c, off); off += c.length; }
      const txt = new TextDecoder('utf-8').decode(buf);
      // v2.46.1 끊긴 본문은 결과 건수(총 N건)가 들어 있을 때만 채택 — 빈 앞부분을 '0건'으로 오인하면 '법전에 없음' 같은 거짓 결론이 나온다(실측)
      if (cut && !/총[\s\S]{0,40}?[\d,]+[\s\S]{0,20}?건/.test(txt)) throw cut;
      return txt;
    } catch (e) { lastErr = e; if (a < 2) await sleep(a ? 2500 : 800); }
  }
  // v2.46.1 POST가 끝내 끊기면 같은 인자의 GET(검색 결과 동일 — 2026-11-24 실측, 옛 'GET 재현 불가' 기록은 현재 사이트와 다름)
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + body, { headers: { 'User-Agent': UA, ...JDB_HDR, 'Accept-Encoding': 'identity', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (r.ok) { const t = await r.text(); if (/총[\s\S]{0,40}?[\d,]+[\s\S]{0,20}?건/.test(t)) return t; }
  } catch (e) { lastErr = e; }
  throw new Error(errInfo(lastErr));
}
const jCnt = (n) => (n < 0 ? '건수 확인 불가' : `${n}건`); // v2.47 -1 = 확인 불가
const jNoScript = (s) => String(s || '').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
const jClean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const jStrip = (s) => jClean(jNoScript(s));
const jLines = (s) => jNoScript(s).replace(/<[^>]+>/g, '\n').split('\n').map((l) => jClean(l)).filter(Boolean);
const jCite = (lid) => `${JDB}/id/${lid}`;
// v2.61 시대별 상세 경로 — 근대·현대·고대 DB를 조선 경로로 요청해 404가 나던 결함(실측 dh_·sg_). 접두가 표에 없으면 조선(종전 동작)
const J_ERA = { kd: 'modern', ij: 'modern', npda: 'modern', dh: 'contemp', pn: 'contemp', sg: 'ancient' };
const jEra = (lid) => J_ERA[String(lid).split('_')[0]] || 'joseon';
const jItemUrl = (lid) => JDB + (lid.startsWith('jlaw') ? '/joseon/item/level.do?levelId=' : `/${jEra(lid)}/level.do?levelId=`) + lid;
const J_LABELS = ['제목', '연월일', '출전', '발신자', '수신자', '발신일', '문서분류', '작성자', '날짜', '작성일', '신문명', '기사제목', '발행년월일', '발행구분', '면수', '단수', '표제어'];
const J_UI = /^(원문이미지|판본 전체|비교보기|.+본\(\d{4}년\))$/; // v2.61.1 본문 사이 화면 단추·판본 목록
const J_SEARCH_BASE = { pageIndex: '1', pageSize: '1', orderColumn: 'levelId', orderDir: 'ASC',
  synonym: 'off', chinessChar: 'on', titleWord: '', titleConjunction: 'AND',
  contentsWord: '', contentsConjunction: 'AND', creatorWord: '', creatorConjunction: 'AND',
  startDate: '', endDate: '' };

async function jLawSearch(query, n) {
  const b = await jdbPost(JDB + '/search/law/searchResultList.do',
    { ...J_SEARCH_BASE, searchItemId: 'jlaw', searchTarget: 'jlaw', pageUnit: String(Math.min(n, 200)), totalWord: query });
  const tm = jStrip(b).match(/총\s*([\d,]+)\s*건/); // v2.47 건수 표기가 없으면 0이 아니라 '확인 불가'(-1) — 부재 단정 금지
  const total = tm ? parseInt(tm[1].replace(/,/g, ''), 10) : -1;
  const results = [];
  const re = /fnGoItemView\('([^']+)',\s*'\d+'\)[\s\S]*?<ul class="tit">([\s\S]*?)<\/ul>\s*<p class="tx">([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(b))) {
    const parts = [...m[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => jStrip(x[1]).replace(/\s+/g, ''));
    results.push({ id: m[1], source: parts[0] || '', section: parts.slice(1).join('·'), excerpt: jStrip(m[3]).slice(0, 240) });
  }
  return { total, results };
}

async function jItemRead(lid, maxChars) {
  let b;
  try { b = await gtext(jItemUrl(lid), JDB_HDR); } catch (e) { return { lid, status: 'not_found', note: e.message }; }
  const lines = jLines(b);
  const title = lines.find((l) => /啓$|傳敎$|事目|節目|條例|大典|要覽|謄錄/.test(l) && l.length > 8 && l.length < 140) || '';
  let k = null;
  let lawTitle = '';
  if (lid.startsWith('jlaw')) {
    const i = lines.indexOf('다음글'); k = i >= 0 ? i + 1 : null;
    if (k === null) { // v2.69.1 현 조문 페이지 — '자료인용방법' 다음 줄들이 조문 제목, '상위목록' 다음부터 본문(실측 jlawa_102_0210_0010). 검색창 라벨을 기술 항목으로 오인하던 결함 차단
      const c0 = lines.indexOf('자료인용방법'), c1 = lines.indexOf('전체목록', c0), u = lines.indexOf('상위목록', c0);
      if (c0 >= 0 && c1 > c0) lawTitle = lines.slice(c0 + 1, c1).join(' ');
      if (u > c0) k = u + 1;
    }
    if (k === null) return { lid, title: lawTitle || title, status: (lawTitle || title) ? 'not_published' : 'parse_failed' }; // 법전은 기술 항목 판독을 쓰지 않는다
  }
  else { const i = lines.findIndex((l) => l.startsWith('◯') || l.startsWith('○')); k = i >= 0 ? i : null; }
  if (k === null) { // v2.61 '◯' 표시가 없는 기록(현대 자료·각사등록 장계 등) — 기술 항목(제목·연월일·출전·발신자…) 뒤가 본문
    const hoi = lines.indexOf('HOI'); const t2 = hoi > 0 ? lines[hoi - 1] : '';
    const fe = lines.findIndex((l) => l.includes('개인정보취급방침') || l.includes('경기도 과천시')); const stop = fe >= 0 ? fe : lines.length;
    const meta = [];
    for (let i = Math.max(0, hoi); i < stop; i++) { if (J_LABELS.includes(lines[i])) meta.push([lines[i], []]); else if (meta.length) meta[meta.length - 1][1].push(lines[i]); }
    if (meta.length) {
      const last = meta[meta.length - 1][1]; const rest = last.splice(1); const ttl = t2 || title; // 기록 자체 제목(HOI 앞 줄) 우선
      while (rest.length && (rest[0] === ttl || rest[0] === t2)) rest.shift();
      const mv = meta.map(([kk, v]) => [kk, v.join(' ').slice(0, 200)]).filter(([, v]) => v);
      const body = rest.join(' ').slice(0, maxChars || 1200);
      if (body) return { lid, title: ttl, body, chars: body.length, status: 'ok', isLaw: false, era: jEra(lid), meta: mv };
      if (lines.includes('원문이미지')) return { lid, title: ttl, status: 'image_only', meta: mv }; // v2.61.1 신문 지면 등 — 텍스트 없이 원문 이미지만(미공개 아님)
      return { lid, title: ttl, status: ttl ? 'not_published' : 'parse_failed', meta: mv };
    }
    // v2.61.1 기술 항목 표도 '◯'도 없는 기록(삼국사기 등) — 제목 반복 줄 뒤 '(날짜)'·본문(註 표시 포함)·주제분류 순
    const j0 = t2 ? lines.indexOf(t2, hoi + 2) : -1;
    if (j0 > 0) {
      let i = j0 + 1; const mv = []; let dt = '';
      if (lines[i] === '(') { const k2 = lines.indexOf(')', i); if (k2 > i && k2 - i < 8) { dt = lines.slice(i + 1, k2).join(' '); i = k2 + 1; } }
      if (dt) mv.push(['연월일', dt]);
      const cut = lines.findIndex((l, x) => x > i && (l.startsWith('註)') || l === '주제분류' || l.includes('개인정보취급방침')));
      // 본문은 section-read에서 — 각주 팝업(註 NNN) 내용은 본문이 아니므로 걷어 낸다(실측 삼국사기)
      const sr = (b.match(/<section class="section-read"[^>]*>([\s\S]*?)<\/section>/) || [])[1];
      const srText = sr ? jClean(sr.replace(/<div class="popup-nd[\s\S]*?<div class="cont">[\s\S]*?<\/div><\/div>/g, ' ').replace(/<sup>[^<]*<\/sup>/g, '')) : '';
      const seg = srText ? [srText] : lines.slice(i, cut > 0 ? cut : stop).filter((l) => !J_UI.test(l) && !/^註\s*\d+\)?$/.test(l));
      const ci = lines.indexOf('주제분류', i); if (ci > 0) { const cls = lines.slice(ci + 1, stop).filter((l) => l.includes('＞')).slice(0, 6); if (cls.length) mv.push(['주제분류', cls.join('; ')]); }
      const body = seg.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxChars || 1200);
      if (body.length > 20) return { lid, title: t2, body, chars: body.length, status: 'ok', isLaw: false, era: jEra(lid), meta: mv };
    }
    return { lid, title: title || t2, status: (title || t2) ? 'not_published' : 'parse_failed' };
  }
  let end = lines.slice(k).findIndex((l) => l.includes('경기도 과천시') || l.includes('개인정보') || l === '디지털역사자료 인용방법');
  end = end >= 0 ? k + end : Math.min(lines.length, k + 250);
  const body = lines.slice(k, end).join(' ').slice(0, maxChars || 1200);
  return { lid, title: lawTitle || title, body, chars: body.length, status: 'ok', isLaw: lid.startsWith('jlaw') };
}

async function jSibling(lid, span) {
  const m = lid.match(/^(.+_)(\d{4})$/);
  if (!m) return { error: '형제 조 스캔은 4자리 일련번호로 끝나는 levelId에만 적용됩니다.' };
  const stem = m[1]; const asked = parseInt(m[2], 10);
  const sibs = [];
  const nums = []; for (let n = 1; n <= span; n++) nums.push(n * 10);
  for (let i = 0; i < nums.length; i += 3) {
    const batch = nums.slice(i, i + 3);
    const rs = await Promise.all(batch.map(async (num) => {
      const id = stem + String(num).padStart(4, '0');
      const r = await jItemRead(id, 400).catch(() => null);
      if (!r || r.status !== 'ok' || (r.body || '').includes('조선시대법령자료 메뉴')) return null;
      const hm = (r.body || '').match(/^\s*([\u4e00-\u9fff]{2,6})/);
      return { id, head: hm ? hm[1] : (r.body || '').slice(0, 12), chars: r.chars, requested: num === asked };
    }));
    sibs.push(...rs.filter(Boolean));
    if (i + 3 < nums.length) await sleep(150);
  }
  return { stem: stem.replace(/_$/, ''), sibs, others: sibs.filter((s) => !s.requested) };
}

// v2.23 한국사DB 주요 DB 병렬 검색 — 통합검색 페이지(GET)는 검색어를 무시하고 메뉴만 돌려줘 '헌정사 자료 DB·포로신문보고서'(메뉴의 new 표시)를 결과로 오인하던 결함(실측). 시대별 하위 DB POST로 건수·기록 직접.
const NEDB_DBS = [['joseon', 'bb', '비변사등록', '조선'], ['joseon', 'ks', '각사등록', '조선'], ['modern', 'kd', '한국독립운동사자료', '근대'], ['modern', 'ij', '대한민국임시정부자료집', '근대'],
  ['modern', 'npda', '동아일보', '근대'], ['contemp', 'dh', '자료대한민국사', '현대'], ['contemp', 'pn', '휴전회담회의록', '현대'], ['ancient', 'sg', '삼국사기', '고대']];
const nedbDate = (id) => { const m = String(id).match(/_(1[5-9]\d\d|20\d\d)_(\d\d)_(\d\d)/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
async function nedbLive(q, per = 3) {
  const one = async ([site, iid, name, era]) => {
    const b = await cachedText(`nedbL:${iid}:${per}:${q}`, 6 * 3600e3, () => jdbPost(`${JDB}/${site}/search/searchResultList.do`, { ...J_SEARCH_BASE, searchItemId: iid, pageUnit: String(per), totalWord: q }), '총');
    const tm0 = jStrip(b).match(/총\s*([\d,]+)\s*건/); const total = tm0 ? parseInt(tm0[1].replace(/,/g, ''), 10) : -1; // v2.47 표기 없음 = 확인 불가(-1)
    const seen = new Set(); const rows = []; const re = /fnGoItemLevel\('[^']*',\s*'(\w+)'[^)]*\);[^>]*>([\s\S]*?)<\/a>/g; let m;
    while ((m = re.exec(b)) && rows.length < per) { const t = jStrip(m[2]).replace(/\s+/g, ' ').trim(); if (t && !seen.has(m[1])) { seen.add(m[1]); rows.push({ id: m[1], title: t }); } }
    return { site, iid, name, era, total, rows };
  };
  const rs = await Promise.allSettled(NEDB_DBS.map(one));
  return rs.map((r, i) => (r.status === 'fulfilled' ? r.value : { site: NEDB_DBS[i][0], iid: NEDB_DBS[i][1], name: NEDB_DBS[i][2], era: NEDB_DBS[i][3], total: -1, rows: [], err: String((r.reason && r.reason.message) || r.reason).slice(0, 40) }));
}
async function jRecordSearch(query, n) {
  const b = await jdbPost(JDB + '/joseon/search/searchResultList.do',
    { ...J_SEARCH_BASE, searchItemId: 'bb', searchTarget: 'bb', pageUnit: String(Math.min(n, 200)), totalWord: query });
  const tm0 = jStrip(b).match(/총\s*([\d,]+)\s*건/); const total = tm0 ? parseInt(tm0[1].replace(/,/g, ''), 10) : -1; // v2.47 표기 없음 = 확인 불가(-1)
  const seen = new Set(); const rows = [];
  const re = /fnGoItemLevel\('[^']*',\s*'(\w+)'[^)]*\);[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(b))) {
    const t = jStrip(m[2]);
    if (!t || seen.has(m[1])) continue;
    seen.add(m[1]);
    rows.push({ id: m[1], title: t, jwamok: /좌목\s*$/.test(t) });
  }
  return { total, rows, jwamok: rows.filter((r) => r.jwamok), real: rows.filter((r) => !r.jwamok) };
}

async function jSjw(query) {
  const b = await jdbPost(JSJW + '/search/searchResultList.do',
    { searchTerm: query, searchTermImages: '', topSearchWord: query, topSearchWord_ime: query,
      pageUnit: '50', pageIndex: '1', searchType: 'a' });
  const t = jStrip(b);
  const tm1 = t.match(/검색결과\s*([\d,]+)\s*건/) || t.match(/총\s*([\d,]+)\s*건/); const total = tm1 ? parseInt(tm1[1].replace(/,/g, ''), 10) : -1; // v2.47
  const REIGNS = ['태조', '정종', '태종', '세종', '문종', '단종', '세조', '예종', '성종', '연산군', '중종', '인종', '명종', '선조', '광해군', '인조', '효종', '현종', '숙종', '경종', '영조', '정조', '순조', '헌종', '철종', '고종', '순종'];
  const dist = {};
  for (const r of REIGNS) { const mm = t.match(new RegExp(r + '\\s*\\((\\d+)\\)')); if (mm) dist[r] = parseInt(mm[1], 10); }
  const me = t.match(new RegExp('(' + REIGNS.join('|') + ')\\s*(\\d+)년[^\\d]{0,12}(\\d{4})년'));
  const earliest = me ? { reign: `${me[1]} ${me[2]}년`, year: parseInt(me[3], 10) } : null;
  return { total, dist, earliest };
}

const kyuRows = (flat) => {
  const rows = [];
  const re = /(?:^|\s)\d{1,3}\.\s+(.{2,140}?)\s+청구기호\s*:\s*(\S{2,40})\s+편저자\s*:\s*(.{1,90}?)\s+간행년대\s*:\s*(.{1,50}?)\s+사부분류\s*:\s*(.{1,80}?)\s+(?:본문\s*:\s*(.{0,400}?)\s+)?상세정보/g;
  const seen = new Set();
  for (const m of flat.matchAll(re)) if (!seen.has(m[2]) && seen.add(m[2])) rows.push({ call: m[2], title: m[1].split(/\s\d{1,3}\.\s+/).pop().trim(), author: m[3].trim(), date: m[4].trim(), cls: m[5].trim(), body: (m[6] || '').replace(/\.\.\.$/, '').trim().slice(0, 160) });
  return rows.slice(0, 30);
};
// v2.56 장서각 해제의 기관 개체 태깅(data-xsl-tag) — 인명·지명·관청명 등과 인명 전거(한국역대인물 UCI). 원문 태그만 옮긴다(추출·추정 없음)
const JSG_ENT = ['인명', '지명', '관청명', '관직명', '나라명', '건물명', '문헌명', '서명'];
function jsgEntities(html) {
  const by = {}; const uci = []; const seenU = new Set();
  for (const m of String(html || '').matchAll(/<span data-xsl-tag="([^"]+)"([^>]*)>([\s\S]*?)(?:<div|<\/span>)/g)) {
    if (!JSG_ENT.includes(m[1])) continue;
    const t = m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); if (!t || t.length > 40) continue;
    const a = (by[m[1]] = by[m[1]] || []); if (!a.includes(t) && a.length < 12) a.push(t);
    const u = (m[2].match(/data-people-uci="([^"]+)"/) || [])[1]; if (u && !seenU.has(t)) { seenU.add(t); uci.push([t, u]); }
  }
  return { ent: JSG_ENT.filter((k) => by[k]).map((k) => [k, by[k]]), uci: uci.slice(0, 20) };
}
async function jKyu(query) {
  // 실측 10.2s(12s 타임박스 근접 — cross_search 간헐 탈락 위험) → 목록·해제 2건 병렬 + 6h TTL 캐시
  const ck = 'kyudb6:' + query; // v2.35.1 book_cd(강조 태그 수정) — 캐시 키 판 올림
  const hit = _ttlCache.get(ck);
  if (hit && Date.now() - hit.t < 6 * 3600e3) return JSON.parse(hit.v);
  const out = {};
  await Promise.all([['10', '목록'], ['20', '해제']].map(async ([code, label]) => {
    try {
      // v2.37 사이트 개편(2026-11-24 실측): POST는 CSRF 토큰 필수(403 'CSRF Token Validation Failed') — 공개 GET 검색으로(같은 결과·정직 UA 정상)
      const b = await gtext(`${JKYU}/search/search.do?totalSearchString=${encodeURIComponent(query)}&searchArea=${code}`, { Referer: JKYU + '/' });
      out[label] = [...new Set([...b.matchAll(/(奎[\d軸]+)/g)].map((x) => x[1]))].slice(0, 30);
      // v1.96.7: 번호만 나오던 결함 — 결과 행 'N. 서명 청구기호 : 奎… 편저자 : … 간행년대 : … 사부분류 : … [본문 : …] 상세정보'(실측) 구조 판독
      out[label + '항목'] = kyuRows(mclean(b));
      // 청구기호는 태그 제거 후 읽는다 — 청구기호 검색 시 강조 태그(<font><b>奎…</b></font>)가 끊던 것(골든 kyudb-bookcd-link 실측)
      // v2.35 행별 book_cd(fn_totalSearchResultView 4번째 인자) ↔ 청구기호 — /book/view.do?book_cd= GET 고정 상세(2026-11-24 실측)
      // v2.37 개편 마크업 data-book_cd="GK…" · 옛 onclick fn_totalSearchResultView(…'GK…') 둘 다
      out[label + '코드'] = Object.fromEntries(b.split(/class="schli[ "]/).slice(1).map((seg) => [norm((seg.replace(/<[^>]+>/g, '').match(/청구기호\s*:\s*([^\n\t]{2,30})/) || [])[1] || ''), (seg.match(/data-book_cd="([A-Z]{1,4}\d[\w-]*_\d\d)"/) || seg.match(/fn_totalSearchResultView\([^)]*?'([A-Z]{1,4}\d[\w-]*_\d\d)'/) || [])[1] || '']).filter(([c, k]) => c && k).reverse()); // reverse → 같은 청구기호면 앞 행(원본 GK…)이 이김 — 뒤의 마이크로필름 사본(TM…)이 덮어쓰던 것
    } catch (e) { out[label] = { error: e.message }; }
  }));
  // 정상 형태(양쪽 배열)이고 결과가 있을 때만 캐시 — 차단·오류 응답 오염 방지
  if (Array.isArray(out['목록']) && Array.isArray(out['해제']) && (out['목록'].length + out['해제'].length))
    _ttlCache.set(ck, { t: Date.now(), v: JSON.stringify(out) });
  return out;
}

const J_DOMAINS = { '노비·신분': ['奴婢', '婢', '良賤', '從良'], '재산·상속': ['分衿', '衿', '遺書', '文記', '和會'],
  '시험·교육': ['講', '生員', '成均館', '考講', '製述'], '형벌·소송': ['刑', '決訟', '杖', '徒', '流'],
  '군사': ['軍', '兵', '鎭', '營', '戰船'], '조운·선박': ['船', '漕', '津', '渡', '水站'], '재정·세': ['稅', '貢', '米', '錢', '貿'] };

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
// v1.86: 협약기관 상세 → 원본 연결 메타(입수처 NARA NAID·생산시기). 같은 원본의 국내 재수집본↔해외 원본 동일성 확정용
async function kwDetail(ref) {
  if (!ref || ref.startsWith('book:')) return null;
  const b = await cachedText('kwd:' + ref, 24 * 3600e3, () => gtext(`${KW_BASE}/searchDetail.do?archRfcd=${encodeURIComponent(ref)}`, KW_UA), '<dt');
  const rows = [...b.matchAll(/<dt[^>]*>\s*([\s\S]{1,60}?)\s*<\/dt>\s*<dd[^>]*>([\s\S]{0,400}?)<\/dd>/g)].map((m) => [kwClean(m[1]), kwClean(m[2])]);
  const all = rows.map(([, v]) => v).join(' ');
  const naid = (all.match(/catalog\.archives\.gov\/id\/(\d+)/) || [])[1] || '';
  const pd = ((rows.find(([k]) => /생산시기/.test(k)) || [])[1] || '').match(/\d{4}(?:-\d{2}){0,2}/);
  return { naid, date: pd ? pd[0].replace(/(-00)+$/, '') : '' }; // '1950-12-00'(일 미상) → '1950-12' ISO 축약
}
async function kwSearch(params) {
  const u = new URL(KW_BASE + '/search.do');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  const b = await gtext(u.toString(), KW_UA);
  return { total: (b.match(/totalCount">\s*([\d,]+)/) || [])[1] || '?', cards: kwParseCards(b), url: u.toString() };
}
// 수집구분(depth1) 코드 — 상세검색 폼 실측; 서버측 GET 필터로 동작 검증됨(철수 778 → 수집 633 · 기증 104).
const KW_DEPTH1 = { '수집': '00001041', '기증': '00001042', '기타': '00001047', '구입': '00001054', '기탁': '00001073', '제작': '00001125', '이관': '00001179', '차입': '00001410' };
// 후기 단계 전투 검색 앵커 — 서버 큐레이션(기관 전투 DB 아님). 사이트 DB(개전 초기 69건) 미수록
// 시기를 보완한다. t=통설 전사 시기, x=교차검색 앵커(쿼리·기록군 제안 — 수치·전과 주장 없음).
const KW_ANCHORS = [
  { p: /인천\s?상륙|仁川上陸|Inchon/i, n: '인천상륙작전', t: '1950-09-15 ~ 09-19', x: "en 'Inchon landing' · NARA RG 127(해병)·RG 80 · TNA ADM 116" },
  { p: /서울\s?수복/, n: '서울 수복', t: '1950-09-22 ~ 09-28', x: "en 'recapture of Seoul' · koreanwar_search(scope=archive '서울 수복')" },
  { p: /장진호|長津湖|长津湖|Chosin/i, n: '장진호 전투', t: '1950-11-27 ~ 12-11', x: "en 'Chosin Reservoir' · NARA RG 127 · ia_search 'Chosin'" },
  { p: /청천강|淸川江|清川江/, n: '청천강 전투', t: '1950-11-25 ~ 12-02', x: "en 'Chongchon River' · NARA RG 407" },
  { p: /흥남|興南|Hungnam/i, n: '흥남 철수', t: '1950-12 중순 ~ 12-24', x: "en 'Hungnam evacuation' · NARA RG 80·RG 127" },
  { p: /1[·.]4\s?후퇴/, n: '1·4 후퇴(서울 재실함)', t: '1951-01-04', x: "en 'fall of Seoul 1951'" },
  { p: /지평리|砥平里|Chipyong/i, n: '지평리 전투', t: '1951-02-13 ~ 02-15', x: "en 'Chipyong-ni' · 프랑스대대 — gallica_search 병행" },
  { p: /임진강\s?전투|글로스터|그로스터|Imjin/i, n: '임진강 전투(글로스터)', t: '1951-04-22 ~ 04-25', x: "en 'Imjin River' · TNA WO 281(부대 전쟁일지) — tna_search" },
  { p: /가평|加平|Kapyong/i, n: '가평 전투', t: '1951-04-23 ~ 04-25', x: "en 'Kapyong' · 영연방(호주·캐나다) — tna_search·archives 교차" },
  { p: /피의\s?능선/, n: '피의 능선 전투', t: '1951-08-18 ~ 09-05', x: "en 'Bloody Ridge'" },
  { p: /단장의\s?능선|Heartbreak/i, n: '단장의 능선 전투', t: '1951-09-13 ~ 10-15', x: "en 'Heartbreak Ridge' · 프랑스대대 — gallica_search 병행" },
  { p: /백마고지|白馬高地|白马高地/, n: '백마고지 전투', t: '1952-10-06 ~ 10-15', x: "en 'White Horse Hill' · NARA RG 407" },
  { p: /저격\s?능선|삼각\s?고지|상감령|上甘[嶺岭]/, n: '저격능선·삼각고지 전투', t: '1952-10-14 ~ 11월', x: "en 'Sniper Ridge'·'Triangle Hill'" },
  { p: /폭찹/, n: '폭찹힐 전투', t: '1953-04 · 1953-07', x: "en 'Pork Chop Hill'" },
  { p: /금성\s?전투|金城/, n: '금성 전투', t: '1953-07-13 ~ 07-19', x: "en 'Kumsong offensive'" },
  { p: /휴전|정전|판문점|Panmunjom/i, n: '정전협정 조인(판문점)', t: '1953-07-27', x: "en 'Korea armistice' · koreanwar_search(scope=archive '정전')" },
];
// 느리게 변하는 조회의 인메모리 TTL 캐시(웜 인스턴스 혜택 — 콜드스타트 시 자연 소멸)
const _ttlCache = new Map();
async function cachedText(key, ttlMs, fn, marker) {
  const hit = _ttlCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  // 마커(기대 구조)가 있는 정상 응답만 캐시 — 차단·점검 페이지의 6시간 오염 방지
  if (v && v.length > 100 && (!marker || v.includes(marker))) _ttlCache.set(key, { t: Date.now(), v });
  return v;
}
const kwAnchorLines = (q) => {
  if (!q) return [];
  return KW_ANCHORS.filter((a) => a.p.test(q)).slice(0, 5)
    .map((a) => `- [앵커] ${a.n} (${a.t}) → ${a.x}`);
};
// OpenAPI pbrcList.do — token은 Referer(https://korea-archive-mcp.vercel.app/) 바인딩 발급(2026-08-19 실측).
// JSON list (keyword param 없음, pageSize 상한 100) → scan pages, filter client-side.
// 토큰은 Vercel 환경변수 KOREANWAR_API_TOKEN로 주입(공개 저장소 노출 금지 — 커밋 금지).
const KW_API_HDR = { ...KW_UA, Referer: 'https://korea-archive-mcp.vercel.app/' };
async function kwApiScan(q, maxPages) {
  const token = process.env.KOREANWAR_API_TOKEN;
  if (!token) return null;
  const pages = Math.min(maxPages || Number(process.env.KOREANWAR_API_PAGES || 3), 10);
  const ql = q.toLowerCase(); const hits = []; let total = 0, checked = 0;
  for (let p = 1; p <= pages; p++) {
    const d = await jget(`${KW_BASE}/openapi/pbrcList.do?token=${encodeURIComponent(token)}&page=${p}&pageSize=100`, KW_API_HDR);
    if (d.resultCode !== 'OK') throw new Error(`OpenAPI ${d.resultCode}: ${d.resultMsg || ''} — 토큰이 Referer(korea-archive-mcp.vercel.app) 바인딩인지 확인`);
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
  // PlayMCP 응답 24KB 한도 — UTF-8 바이트 실측 공통 가드(여유 23,800B). 모든 도구에 일괄 적용.
  const LIMIT_B = 23800;
  const _enc = new TextEncoder(); const _dec = new TextDecoder('utf-8', { fatal: false });
  const guard24k = (cb) => async (...args) => {
    const res = await cb(...args);
    try {
      for (const c of (res && res.content) || []) {
        if (c.type === 'text' && typeof c.text === 'string') {
          const b = _enc.encode(c.text);
          if (b.length > LIMIT_B) c.text = _dec.decode(b.slice(0, LIMIT_B)).replace(/\uFFFD+$/, '')
            + `\n…[응답 24KB 한도 — ${b.length}B 중 절단. page·max_results로 분할 조회]`;
        }
      }
    } catch { /* 가드 실패 시 원응답 유지 */ }
    return res;
  };
  server.tool = (name, desc, schema, cb) => {
    const max = 1024 - SVC.length;
    const d = (desc.length > max ? desc.slice(0, max - 1) + '…' : desc) + SVC;
    const g = guard24k(cb);
    const logged = async (args, extra) => { const res = await REQ.run({ ...(REQ.getStore() || {}), ak: argKey(name, args) }, () => g(args, extra)); // v2.28 질의 지문을 요청 맥락에 — 발견 기록이 자기를 찾은 질의를 가리키게 // v2.26 모든 질의·회신 축적(자동 검사 X-KA-Probe 제외, 실패해도 응답 영향 없음)
      try { const t = ((res && res.content) || []).map((x) => x.text || '').join('\n'); await Promise.race([stashCall(name, args, t, { probe: (REQ.getStore() || {}).probe || false }), sleep(1500)]); } catch { /* 축적 실패 무시 */ }
      return res; };
    return _tool(name, d, schema,
      { title: TITLES[name] || name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      logged);
  };

  server.tool('tna_search',
    'Search the UK National Archives (TNA) Discovery catalog for Korea-related records. Queries in Korean·Japanese·Chinese·Russian·Spanish·German·Vietnamese·Hindi·Hebrew·Arabic etc. are auto-translated to English index terms (임진강→Imjin River, 長津湖→Chosin Reservoir, Корейская война→Korean War …). Reference codes like "FO 371/84053" are auto-quoted. 영국 국립기록관 검색 — 다국어 질의 자동 영문 변환.',
    { query: z.string().describe('한국어 또는 영어 — e.g. "임진강 전투", "Korea armistice", "FO 371 FK1015"'), max_results: z.number().int().min(1).max(50).default(15), year_from: z.number().int().optional().describe('연대 시작 e.g. 1950'), year_to: z.number().int().optional().describe('연대 끝 e.g. 1953'), page: z.number().int().min(1).default(1) },
    async ({ query, max_results, year_from, year_to, page }) => {
      const en = koToEn(query);
      const eff = en || query;
      const q = /^[A-Z]+ \d+\/\d+$/.test(eff.trim()) ? `"${eff.trim()}"` : eff;
      const vs = page === 1 ? tnaVariants(q) : [q];
      const rs = await Promise.allSettled(vs.map((x) => tnaFetch(x, max_results, page, year_from, year_to)));
      if (rs[0].status !== 'fulfilled') throw rs[0].reason;
      const d = rs[0].value; const seenR = new Set(); const recs = [];
      for (const r of (d.records || [])) { seenR.add(r.id); recs.push(r); }
      const vinfo = [];
      rs.slice(1).forEach((x, i) => { if (x.status !== 'fulfilled') return; vinfo.push(`'${vs[i + 1]}' ${x.value.count ?? '?'}건`);
        for (const r of (x.value.records || [])) if (!seenR.has(r.id) && recs.length < max_results + Math.ceil(max_results / 2)) { seenR.add(r.id); recs.push({ ...r, _v: vs[i + 1] }); } });
      const tags = [year_from || year_to ? `연대 ${year_from || ''}~${year_to || ''}` : '', page > 1 ? `p.${page}` : ''].filter(Boolean);
      const hint = (year_from || year_to) && !recs.length ? '\n※ 연대 필터는 연대 미상(Date unknown) 기록을 제외합니다 — 무필터로 재시도해 비교하십시오.' : '';
      return text(`TNA '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''}${tags.length ? ` [${tags.join(' · ')}]` : ''} — total ${d.count ?? '?'}:\n` + (recs.map((r) => tnaLine(r) + (r._v ? ` ⟨변형 '${r._v}'⟩` : '')).join('\n') || '(0 results)') + hint
        + (recs[0] && recs[0].id ? `\n※ 계층·IIIF(v2.1): 기록마다 https://korea-archive-mcp.vercel.app/iiif/tna/<C-id>/manifest.json(실제 계보 부서›시리즈›피스) · 상위·하위는 /collection.json — 예: ${tnaUrls(recs[0].id).manifest} · 시리즈 펼쳐 보기: ${tnaUrls(recs[0].parentId || recs[0].id).collection}` : '')
        + (vinfo.length ? `\n※ 표기 변형 병행(TNA는 단어 그대로 전부 일치): ${vinfo.join(' · ')} — ⟨변형⟩ 표시 행이 원 질의에서 빠졌던 기록. 더 보려면 그 변형으로 재검색.` : ''));
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
    { query: z.string().describe('한국어 또는 영어 (naid 지정 시 무시 가능 — 빈 문자열 허용)'), record_group: z.number().int().optional(), moving_images_only: z.boolean().default(false), max_results: z.number().int().min(1).max(50).default(15), page: z.number().int().min(1).default(1), naid: z.coerce.number().int().optional().describe('NAID 인접 채굴 중심값 e.g. 22015'), radius: z.number().int().min(0).max(8).default(3).describe('naid ±N 인접 범위'), output: z.enum(['text', 'iiif']).default('text').describe("iiif=naid 기록을 IIIF Presentation 3 매니페스트로(계보 partOf·생산일 navDate·권리·판독 지문·디지털 객체 — 공개 URL로 KV·Mirador에서 열림)") },
    async ({ query, record_group, moving_images_only, max_results, page, naid, radius, output }) => {
      const key = process.env.NARA_API_KEY;
      if (!key) return text('NARA_API_KEY not configured on this server. Free key: email Catalog_API@nara.gov (name + email). Meanwhile use catalog.archives.gov directly.');
      if (naid && output === 'iiif') { // v1.98: NARA→IIIF 브리지 — 맥락(계보)·증거성(판독 시각·기술 지문·권리 원문)·다매체(rendering)
        try {
          const man = await buildNaraManifest(naid, 40);
          if (!man) return text(`[NAID ${naid}] 카탈로그에 없음 — NAID를 확인하십시오.`);
          const U = naraUrls(naid); const lite = { ...man, items: man.items.slice(0, 12) };
          let js = JSON.stringify(lite); if (js.length > 15000) js = JSON.stringify({ ...lite, items: lite.items.slice(0, 4), summary: undefined });
          return text(`NARA→IIIF [NAID ${naid}] ${String(man.label.en[0]).slice(0, 90)}\n캔버스 ${man.items.length}장 · 원본 매체(rendering) ${(man.rendering || []).length}건 · 계보 ${man.partOf ? '있음(partOf → 상위 컬렉션)' : '없음'} · navDate ${man.navDate || '—'}\n`
            + `■ 공개 매니페스트(누구나·어느 IIIF 뷰어든): ${U.manifest}\n■ KV로 보기: ${U.kv}\n■ 상위 계층 컬렉션: ${man.partOf ? man.partOf[0].id : '—'} · 이 기록의 하위 컬렉션: ${U.collection}\n■ RiC-O JSON-LD(지식그래프·기록관리 등재): ${U.ric}\n`
            + `■ 매니페스트 JSON${man.items.length > lite.items.length ? `(앞 ${JSON.parse(js).items.length}장 — 전체는 위 URL)` : ''}:\n${js}`);
        } catch (e) { return text(`NARA→IIIF 실패(${String(e && e.message || e).slice(0, 80)}) — 공개 URL로 재시도: ${naraUrls(naid).manifest}`); }
      }
      if (naid) { // NAID ± 인접 채굴 — 사진 ±3·색인 ±1 간격 실무 지식. v2는 단수 naId만 수용(naIds=400 실측) → 순차 조회
        const ids = []; for (let i = naid - radius; i <= naid + radius; i++) if (i > 0) ids.push(i);
        const lines = [];
        for (const i of ids) {
          try {
            const d2 = await jget(`https://catalog.archives.gov/api/v2/records/search?naId=${i}&limit=1`, { 'x-api-key': key });
            const rec = (((((d2.body || {}).hits || {}).hits) || [])[0] || { _source: {} })._source.record || null;
            const po2 = rec ? naraChain(rec) : ''; // v1.82: 인접 채굴에도 계보 — 중심과 같은 시리즈인지 즉시 판별
            lines.push(rec && Number(rec.naId) === i ? `${i === naid ? '★' : ' '} [NAID ${i}] ${(rec.title || '').slice(0, 95)} | ${rec.localIdentifier || ''}${po2 ? ` | ${po2}` : ''} | https://catalog.archives.gov/id/${i}` : `  [NAID ${i}] (없음)`);
          } catch (e) { lines.push(`  [NAID ${i}] 오류(${e.message})`); }
          await sleep(150);
        }
        return text(`NARA NAID 인접 채굴 ${naid}±${radius} (★=중심, 한국 관련 여부는 제목으로 판별):\n` + lines.join('\n') + '\n※ 간격 지식: 사진 계열 ±3·색인 ±1 — 하나 찾으면 양옆을 훑는다(query_bank identifiers).');
      }
      const en = koToEn(query);
      const eff = en || query;
      const u = new URL('https://catalog.archives.gov/api/v2/records/search');
      u.searchParams.set('q', eff); u.searchParams.set('limit', String(max_results)); u.searchParams.set('page', String(page));
      if (record_group) u.searchParams.set('recordGroupNumber', String(record_group));
      if (moving_images_only) u.searchParams.set('typeOfMaterials', 'Moving Images');
      const d = await jget(u.toString(), { 'x-api-key': key });
      const hits = ((d.body || {}).hits || {});
      const rows = (hits.hits || []).map((h) => {
        const rec = (h._source || {}).record || {};
        const po = naraChain(rec);
        const nd = naraDate(rec);
        const ndo = (rec.digitalObjects || []).length; // v1.82: 디지털 객체 수 — 원본 매체 유무를 목록에서 판별(다매체)
        return `- [NAID ${rec.naId}] ${(rec.title || '').slice(0, 100)}${nd ? ` (${nd})` : ''} | ${rec.localIdentifier || ''}${ndo ? ` · 원본 ${ndo}점` : ' · 디지털 사본 없음'} | https://catalog.archives.gov/id/${rec.naId}` + (po ? `\n  계보: ${po}` : '');
      });
      const total = typeof hits.total === 'object' ? hits.total.value : hits.total;
      const rline = record_group ? (() => { const r = judgeRights(`RG ${record_group}`, '', 'NARA'); return `\n권리 초판정(RG ${record_group}): ${r[0]} — ${r[1]}\n※ 건별 실확인: judge_rights(naid=<NAID>) — 카탈로그 Use Restriction 실조회로 A/C 확정`; })() : '';
      return text(`NARA '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''}${record_group ? ` (RG ${record_group})` : ''} — total ${total}:\n` + (rows.join('\n') || '(0 results)') + rline);
    });

  server.tool('ia_search',
    'Search archive.org (advanced search syntax) — e.g. "identifier:111-adc*", "collection:universal_newsreels AND korea". Multilingual queries (한국어·日本語·中文·Русский 등) auto-translate to English terms. Pass identifier instead to inspect one item: metadata, license, original files with sizes (check before downloading). 다국어 질의 자동 영문 변환.',
    { query: z.string().default('').describe('search query (ignored when identifier is set)'), identifier: z.string().optional().describe('item identifier for metadata inspection'), max_results: z.number().int().min(1).max(50).default(15), year_from: z.number().int().optional().describe('연대 시작 e.g. 1950'), year_to: z.number().int().optional().describe('연대 끝 e.g. 1953'), page: z.number().int().min(1).default(1), radius: z.number().int().min(0).max(8).default(0).describe('identifier 끝 숫자 ±N 인접 채굴(0=단건 메타)') },
    async ({ query, identifier, max_results, year_from, year_to, page, radius }) => {
      if (identifier && radius > 0) { // 일련번호 인접 채굴 — identifier 말미 숫자 ±N 존재 확인(TNA식)
        const m = identifier.match(/^(.*?)(\d+)$/);
        if (!m) return text(`'${identifier}' — 말미가 숫자가 아니라 인접 채굴 불가. radius=0으로 단건 메타 조회.`);
        const [, stem, nums] = m; const base = parseInt(nums, 10); const pad = nums.length;
        const lines = [];
        for (let i = base - radius; i <= base + radius; i++) {
          if (i < 0) continue;
          const id2 = stem + String(i).padStart(pad, '0');
          try {
            const d2 = await jget(`https://archive.org/metadata/${encodeURIComponent(id2)}`);
            const md2 = d2 && d2.metadata;
            lines.push(md2 ? `${i === base ? '★' : ' '} ${id2} | ${String(md2.title || '').slice(0, 85)} (${md2.date || ''}) https://archive.org/details/${id2}` : `  ${id2} (없음)`);
          } catch { lines.push(`  ${id2} (없음)`); }
          await sleep(200);
        }
        return text(`archive.org 인접 채굴 ${stem}[${base}±${radius}] (★=중심):\n` + lines.join('\n') + '\n※ 같은 컬렉션의 절반이 다른 표기로 기술돼 검색에 안 걸리는 사례 — 번호 옆 훑기로 복구(열한 겹의 벽 §8).');
      }
      if (identifier) {
        const d = await jget(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
        const md = d.metadata || {};
        if (!d || !d.metadata || !Object.keys(d.metadata).length) return text(`archive.org '${identifier}' — 항목 없음(식별자 오기 또는 미등록). ia_search(query=…)로 검색하거나 NARA 원본은 nara_search·judge_rights(naid)로.`); // v1.96.1
        const files = (d.files || []).filter((f) => f.source === 'original').slice(0, 10);
        let scenes = ''; // v1.93: 영상 기록 장면 분석 — IA 파생 썸네일(.thumbs/<id>_<초>.jpg)을 시각 코드 장면 프레임으로(웹·모바일 경로: ffmpeg 없이 장면 열람)
        if (md.mediatype === 'movies') {
          const th = (d.files || []).map((f) => f.name).filter((nm) => /\.thumbs\/.+_(\d{6})\.jpg$/.test(nm)).sort();
          const vid = (d.files || []).find((f) => /\.(mp4|mpeg4)$/i.test(f.name) && /mpeg4|h\.264/i.test(f.format || ''));
          const naid = (String(md.description || '').match(/catalog\.archives\.gov\/id\/(\d+)/) || [])[1];
          const pick = th.length > 12 ? Array.from({ length: 12 }, (_, i) => th[Math.round(i * (th.length - 1) / 11)]) : th;
          const mmss = (nm) => { const sec = parseInt(nm.match(/_(\d{6})\.jpg$/)[1], 10); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
          scenes = `\n【영상 장면 프레임 — ${th.length}개 중 ${pick.length}개(시각 코드)】\n` + pick.map((nm) => `- ${mmss(nm)}  https://archive.org/download/${identifier}/${nm}`).join('\n')
            + (vid ? `\n영상 파일: https://archive.org/download/${identifier}/${encodeURIComponent(vid.name)} (${Math.round(Number(vid.length || 0))}초)` : '')
            + (naid ? `\n↔ NARA 원본 NAID ${naid} — judge_rights(naid=${naid})로 권리 실확인` : '')
            + `\n➤ 장면 해설: 각 프레임을 열어 '보이는 것만' 기술(인물 수·장비·문자·지형) → report_template(kind=video) 규칙으로 장면 해설 카드. 로컬은 analyze_video.py keyscenes로 장면 전환 기반 대표 프레임(고해상).`;
        }
        return text(`Title: ${md.title}\nDate: ${md.date} | License: ${md.licenseurl || md.rights || 'not stated'}\nDescription: ${String(md.description || '').slice(0, 300)}\nOriginal files:\n` + files.map((f) => `- ${f.name} (${(Number(f.size || 0) / 1e6).toFixed(1)}MB)`).join('\n') + scenes);
      }
      if (!query) return text('query 또는 identifier 중 하나는 필수.');
      const en = koToEn(query);
      let eff = en || query;
      // date:[A TO B] + page 실측 검증 (2026-11-18)
      if (year_from || year_to) eff = `(${eff}) AND date:[${year_from || 1800}-01-01 TO ${year_to || 2030}-12-31]`;
      const r0 = await iaSearch(eff, max_results, 'fl[]=identifier&fl[]=title&fl[]=date&fl[]=licenseurl', page); const d = { response: { numFound: r0.numFound, docs: r0.docs } }; // v2.24 관련성 질의(iaSearch)
      const docs = ((d.response || {}).docs) || [];
      const lshort = (lu) => { const m = String(lu || '').match(/(publicdomain\/(?:mark|zero)|licenses\/[a-z-]+)/); return m ? m[1].replace('licenses/', 'CC ') : ''; };
      const tags = [year_from || year_to ? `연대 ${year_from || ''}~${year_to || ''}` : '', page > 1 ? `p.${page}` : ''].filter(Boolean);
      return text(`archive.org '${query}'${en ? ` → 영문 자동 변환 '${en}'` : ''}${tags.length ? ` [${tags.join(' · ')}]` : ''} — total ${(d.response || {}).numFound}:\n` + (docs.map((x) => { const rt = lshort(x.licenseurl); return `- ${x.identifier} | ${String(x.title).slice(0, 90)} (${String(x.date || '').slice(0, 10)})${rt ? ` | 권리:${rt}` : ''} | https://archive.org/details/${x.identifier}`; }).join('\n') || '(0)') + '\n※ 권리 미표기 건은 judge_rights 초판정 — 발굴 우선, 권리는 표시.');
    });

  server.tool('gallica_search',
    'Search Gallica (Bibliothèque nationale de France, no key needed). Multilingual queries (한국어·日本語·中文 등) auto-translate to French index terms (병인양요→expédition de Corée 1866, 長津湖→Chosin …). French terms also work: Corée, guerre de Corée, missionnaires, Tchosen. 프랑스 국립도서관 검색 — 다국어 질의 자동 프랑스어 변환.',
    { query: z.string().describe('한국어 또는 프랑스어 — e.g. "병인양요 선교사", "Corée missionnaires"'), max_results: z.number().int().min(1).max(30).default(10), year_from: z.number().int().optional().describe('간행 연대 시작 e.g. 1866'), year_to: z.number().int().optional().describe('간행 연대 끝 e.g. 1871'), page: z.number().int().min(1).default(1) },
    async ({ query, max_results, year_from, year_to, page }) => {
      const fr = gallicaKoToFr(query);
      const eff = fr || query;
      const g = (block, tag) => { const m = block.match(new RegExp(`<dc:${tag}[^>]*>([^<]*)<`)); return m ? m[1].trim() : ''; };
      const base = `gallica all "${eff.replace(/"/g, '')}"`;
      // 연대 필터: BnF 공식 색인 dc.date(>=·<= 지원, api.bnf.fr) — 진단 응답이면 후처리 폴백
      const dateClause = (year_from ? ` and dc.date >= "${year_from}"` : '') + (year_to ? ` and dc.date <= "${year_to}"` : '');
      const sru = async (cql) => (await fetch(`https://gallica.bnf.fr/SRU?operation=searchRetrieve&version=1.2&query=${encodeURIComponent(cql)}&maximumRecords=${max_results}&startRecord=${(page - 1) * max_results + 1}`, { headers: { 'User-Agent': UA } })).text();
      let xml = await sru(base + dateClause);
      let total = (xml.match(/<srw:numberOfRecords>(\d+)</) || [])[1];
      let post = false;
      if (dateClause && total === undefined) { xml = await sru(base); total = (xml.match(/<srw:numberOfRecords>(\d+)</) || [])[1]; post = true; }
      if (total === undefined) { // SRU XML 아님 — Cloudflare 차단/점검 (2026-11-18 실측: 서버 IP 403) → v1.93: BnF 공식 카탈로그 SRU 폴백
        try {
          const r = await bnfCatalog(eff, max_results, '');
          if (r.items.length) return text(`Gallica '${query}'${fr ? ` → 프랑스어 자동 변환 '${eff}'` : ''} — Gallica 서버가 자동 조회를 차단해 ${r.via === 'data.bnf.fr' ? '**BnF 공식 개방데이터**(data.bnf.fr SPARQL — 같은 국립도서관 서지·Gallica 원문 링크)' : '**BnF 공식 카탈로그**(catalogue.bnf.fr, 같은 국립도서관 소장 목록)'}로 수집${r.relaxed ? ` (전체 단어 일치 0건 → '${r.relaxed}'로 완화)` : ''} — total ${r.total}:\n`
            + r.items.map((it) => `- ${it.title.slice(0, 110)} (${it.date || '연대 미상'})${it.type ? ` [${it.type}]` : ''}${it.extent ? ` · ${it.extent}` : ''}\n  ${it.gallica ? `Gallica 원문: ${it.gallica}` : `카탈로그: ${it.url}`}`).join('\n')
            + `\n※ Gallica 원문 링크는 브라우저에서 열람(서버 자동 조회만 차단). 사진 묶음(doctype i)만: '${eff}' 사진 — 카탈로그 질의에 doctype 'i'. BnF 디지털 자료 대부분 공유저작물(재이용 조건: gallica.bnf.fr/edit/und/conditions-dutilisation-des-contenus-de-gallica).`);
          return text(`Gallica '${query}' — Gallica 서버 차단, BnF 카탈로그도 0건(완화 질의 포함). 프랑스어 핵심어(예: Corée·Séoul·인명)로 다시 검색하십시오. 브라우저: https://catalogue.bnf.fr`);
        } catch { /* 카탈로그도 실패 — 아래 대체 경로 안내 */ }
        const web = `https://gallica.bnf.fr/services/engine/search/sru?operation=searchRetrieve&version=1.2&query=${encodeURIComponent(base)}`;
        return text(`Gallica '${query}'${fr ? ` → 프랑스어 자동 변환 '${eff}'` : ''} — 서버 자동 조회가 차단되었습니다(BnF측 봇 차단 — 간헐적).\n➤ 에이전트 지시: 당신의 웹 검색/브라우저 도구로 '${eff}'를 gallica.bnf.fr에서 검색해 상위 결과(제목·연대·ark 링크)를 표로 정리해 제시하세요.\n공식 검색: https://gallica.bnf.fr/services/engine/search/sru?operation=searchRetrieve&query=${encodeURIComponent(eff)}\nSRU(차단 해제 시): ${web}`);
      }
      let recs = xml.split('<srw:record>').slice(1);
      if (post) recs = recs.filter((b) => { const y = parseInt((g(b, 'date').match(/\d{4}/) || [])[0], 10); return y && (!year_from || y >= year_from) && (!year_to || y <= year_to); });
      const lines = recs.slice(0, max_results).map((b) => `- ${g(b, 'title').slice(0, 100)} (${g(b, 'date')}) [${g(b, 'type')}] ${g(b, 'identifier')}`);
      const tags = [year_from || year_to ? `간행 ${year_from || ''}~${year_to || ''}${post ? '·후처리·연대 미상 제외' : ''}` : '', page > 1 ? `p.${page}` : ''].filter(Boolean);
      return text(`Gallica '${query}'${fr ? ` → 프랑스어 자동 변환 '${eff}'` : ''}${tags.length ? ` [${tags.join(' · ')}]` : ''} — total ${total || '?'}${post ? `건 중 이 페이지 연대 일치 ${lines.length}건` : ''}:\n` + (lines.join('\n') || '(0)') + '\nTip: French variants — Corée·Coréens·Séoul·Fusan·guerre de Corée·Tchosen');
    });

  server.tool('europeana_search',
    'Search Europeana — 4,000+ institutions in 58 countries. Multilingual queries (한국어·日本語·中文 등) auto-translate to English terms. Works out of the box (shared demo key); set EUROPEANA_API_KEY for heavy use. media_type: VIDEO|IMAGE|TEXT|SOUND. 유럽 통합 검색 — 다국어 질의 자동 영문 변환.',
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(15), media_type: z.enum(['VIDEO', 'IMAGE', 'TEXT', 'SOUND']).optional(), year_from: z.number().int().optional().describe('연대 시작 e.g. 1950'), year_to: z.number().int().optional().describe('연대 끝 e.g. 1953'), page: z.number().int().min(1).default(1) },
    async ({ query, max_results, media_type, year_from, year_to, page }) => {
      const key = process.env.EUROPEANA_API_KEY || 'api2demo';
      const demo = !process.env.EUROPEANA_API_KEY;
      const en = koToEn(query);
      const eff = en || query;
      const u = new URL('https://api.europeana.eu/record/v2/search.json');
      u.searchParams.set('wskey', key); u.searchParams.set('query', eff);
      u.searchParams.set('rows', String(max_results)); u.searchParams.set('profile', 'standard');
      u.searchParams.set('start', String((page - 1) * max_results + 1));
      if (media_type) u.searchParams.append('qf', `TYPE:${media_type}`);
      // YEAR:[A TO B] 열린 범위(*)·다중 qf 실측 검증 (2026-11-18)
      if (year_from || year_to) u.searchParams.append('qf', `YEAR:[${year_from || '*'} TO ${year_to || '*'}]`);
      const d = await jget(u.toString());
      const items = d.items || [];
      const rshort = (r) => { const v = (Array.isArray(r) ? r[0] : r) || ''; const m = String(v).match(/(publicdomain\/(?:mark|zero)|licenses\/[a-z-]+|vocab\/[A-Za-z-]+)/); return m ? m[1].replace('licenses/', 'CC ').replace('vocab/', '') : ''; };
      const ytag = year_from || year_to ? ` [연대 ${year_from || ''}~${year_to || ''}${page > 1 ? ` · p.${page}` : ''}]` : (page > 1 ? ` [p.${page}]` : '');
      return text(`Europeana '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''}${media_type ? ` [${media_type}]` : ''}${ytag} — total ${d.totalResults}:\n` + (items.map((it) => { const rt = rshort(it.rights); return `- ${String((it.title || ['?'])[0]).slice(0, 90)} (${(it.year || [''])[0]}) — ${String((it.dataProvider || [''])[0]).slice(0, 40)}${rt ? ` | 권리:${rt}` : ''} | ${String(it.guid || '').split('?')[0]}${euMedia(it) ? `\n  원본: ${euMedia(it)}` : ''}`; }).join('\n') || '(0)') + '\nTip: multilingual — Corée(fr)·Korea-Krieg(de)·Corea(it/es)' + (demo ? '\n(shared demo key in use — for heavy use, set a free EUROPEANA_API_KEY from apis.europeana.eu)' : ''));
    });

const JB_RECIPES = `발굴 완주 레시피 — 주제 유형별 발굴→판독→권리 순서 (전 단계 실측 검증, 2026-11-21)
공통 원칙: ①cross_search로 폭 확보(variants=당대 표기) ②신호가 나온 소스의 전용 도구/판독 모드로 심층 ③권리는 표시(judge_rights·naid·라이선스) ④0건=부재가 아니다(표기 변형·인접 채굴·관리 행정으로 전환).

① 인물(독립운동가): gonghun '종합:이름'(★공훈록+인명사전+판결문 3채널 병렬 — 한자명·생몰로 동명이인 분리) → mngNo(공적조서·수형기록)·'사전:번호'(전기 전문)·indy URL(주문·원문) 심층 → 이명·한자명으로 i815·oldnews 재검색(당대 신문 — oldnews는 '본문:이명' OCR 전문까지) → jacar(일본 측 — 한자명) → commons(초상·PD) → 수형기록의 판결문 원문은 indy(국가기록원 판결문 테마관 — 판결기관·주문·원문) 직행.
② 한국전쟁 전투·부대: koreanwar(협약 — archRfcd→koreanwar_item 인접 채굴) → nara(RG 교차+naid 인접, judge_rights(naid) 실확인) → tna(연대 필터)·awm(가평 등 영연방)·nlna(네덜란드) → un(안보리 결의 — recid 판독으로 PDF) → commons(PD 사진·원 소장처 역추적).
③ 조선 제도·고문헌: nedb law(법전 근거)→★sibling(형제 조 전수)→sjw(최초 용례) → kyujanggak(목록+해제)·jsg(청구기호→해제 전문) → aks(문중 고문서) → 인용 2층위 준수.
④ 일제강점기 정책·기관: ndl(총독부 간행물·통계연보·관보) ⇄ jacar(공문서 메타·인접 ±100) → nedb(한국사DB)·earchive('키워드|순번' 이용조건) → i815(민족 측 시각 대조).
⑤ 도시·공간사(서울 등): seoul_archives_search(기록 단위→상세 URL 판독) → heritage(국보·사적+해설 전문 — 공간의 유산 맥락) → archives → ktv(view URL 판독) → much(실물·포스터) → commons·ia(항공·거리 사진) → cities 열쇠(Keijo·1914 경계).
⑥ 사진·영상·실물 소싱(게재용): commons(File 판독 — PD→A, 원본 고해상) → ia(radius) → nara(naid 실확인) → ktv(공공누리 표시 확인 — 영상은 무표시 多) → much(공공누리 자동판정 — 포스터·실물) → heritage(유산 해설·공공누리) → 게재윤리 4단계·출처 표기.
※ 각 단계의 투입 형식은 cross_search 푸터와 nedb_search 설명이 안내. 전 산출물 제작은 "풀패키지".`;

const JB_ALLIES = `한국전 참전·지원국 발굴 지도 — 22개국 소스 매핑 (◉=보유 소스 직행 / ○=대체 경로)
◉ 미국: nara(RG 111·127·242·342·428)·ia·earchive(국내 수집 원문) ◉ 영국: tna(WO 281 부대 전쟁일지·ADM·AIR)
◉ 호주: awm(사진·유물 — PD 다수, 가평) ◉ 네덜란드: nlna(주한대사관 2.05.202·UN파견대 2.13.56·적십자 2.19.309)
◉ 프랑스: gallica(차단 시 브라우저) + 지평리·단장의 능선 프랑스대대는 TOPICS 프랑스어 사상 자동
○ 캐나다: LAC는 Turnstile 차단 — PPCLI(가평)는 awm·tna 영연방 교차로 ○ 터키: nara RG 407 + ia "Turkish Brigade Kunu-ri"
○ 전투 참전(태국·필리핀·콜롬비아·에티오피아·그리스·벨기에·룩셈부르크·뉴질랜드·남아공): nara(유엔군 RG)·ia에서
  부대 고유명 영문 병기 — Kagnew Battalion(에티오피아)·PEFTOK/10th BCT(필리핀)·Gloster(영)·Van Heutsz(네)
○ 의료지원(스웨덴·덴마크·노르웨이·이탈리아·인도·서독): ia·europeana — 병원선 Jutlandia(덴)·NORMASH(노)·
  60th Parachute Field Ambulance(인도) 등 고유명 검색
※ 공통 열쇠: 부대 고유명(영문)+Korea 병기 · 유엔군 총괄은 nara RG 333(극동사령부) · UN 아카이브는 챌린지 보류(명세 참조).`;

const JB_WALLS = `열한 겹의 벽 — 한국 기록이 안 찾아지는 11가지 이유와 대응 (실증 기반)
1 일본식 독음: 금강산→Soto Kongo — 일제기 자료는 일본식 지명 병렬 / 2 로마자 철자: Corea·Korea 둘 다 / 3 기계번역 함정: 번역이 아니라 대조표(사람이 만들고 조합은 AI) / 4 외래 명명: 원산=Port Lazareff·제주=Quelpaert·거문도=Port Hamilton / 5 인명 표기: topic=persons 참조 / 6 언어 8+개국어 / 7 출처주의 분류: 찍은 사람이 서랍을 정한다(이승만 사진이 해병대 127-R-1438에) / 8 식별자: topic=identifiers / 9 기술심도: 제목만 있고 내용 없음 — 안을 열어야 함 / 10 결락: ①물리 소실(되찾을 수 없음)·②목록에 없는 것(목록에 올리면 되찾음 — 궁내청 의궤 77종 2011 환수 실증) / 11 음력/양력: 조선 기록=음력·서양=양력(대한제국 양력 채택 1896.1.1) — 두 자료를 겹칠 때 사건 순서가 뒤집힐 수 있다.
부록 — 한자 전사 오류 복원: 연호·간지·서명 3중 교차로 원 한자 확정(예: '한풍원년 신예'→咸豊元年 辛亥, 1851).`;
const JB_IDENT = `식별자 해독 — 번호가 곧 정보다 (첫 건은 검색어로, 나머지 수십 건은 번호 규칙으로)
· NARA 참조코드 127-GR-223-A164360 = 기록군-시리즈-주제묶음-낱건. 주제 묶음이 차면 다음 번호(223→226 실증). NAID 간격은 계열마다 다름(사진 3·색인 1) — 하나 찾으면 ±1·±3 다 넣기.
· 컬렉션 번호대: 같은 컬렉션인데 절반은 Chosen, 절반은 Seoul로 기술 — 검색어로는 절반만 걸린다 → NAID 앞뒤 훑기.
· 같은 기관 안에서도 표기가 갈린다: 'Log of U.S.S.' vs 'Smooth Log of the USS' → 수식어 빼고 고유명만.
· TNA 옆 훑기: 계열번호만 넣기(OCB 1→부산항 해도 82건·140년). 금지: 계열번호+주제어 조합(0건). 결락은 X 접미어(FO 881/9951X 병합 선언 등) — 남은 짝으로 우회. 지도는 MPKK·MFQ 등으로 추출 이관 — 원 문서철 번호로 역검색.
· Gallica ark: btv1b=도판·필사 / bpt6k=인쇄본 — 같은 책이 형태별로 갈린다. · 6·25아카이브: 수집연도-국가-매체-일련(인접 채굴 가능). [8층 코드 지도] 미 국무부 십진분류 895 실전: .00 정치(★625-711 구간=1919.4~1928.6 — 3·1운동·임시정부) · .04 재판·형무소 · .10 공안(치안유지법) · .20 군사 · .40 사회·교육 · .50 경제·이민(하와이·미주) · .60 산업 · .71 통신 — 총독부 재정은 일본 코드 894.51(895가 0건이어도 없는 게 아니다). 검색창에 숫자 그대로.`;
const JB_PERSONS = `인명 열쇠 — 지명은 나라마다 갈리지만 사람 이름은 하나다
절차: 자료 하나를 찾으면 찍은·쓴·모은·채집한 사람 이름으로 재검색 — 한 건이 컬렉션으로 열린다(Vráz→대한제국 사진 66건: 기관이 지명을 현대 표기 Inchon으로 정비해 Chemulpo 검색은 2건뿐이었다).
표기 변형 생성: 이=Lee·Yi·Rhee·Ri / 김=Kim·Gim / 박=Park·Pak·Bak + 성명 도치(장면=Myun Chang, Dr. John)·현지 발음(서영해=Seu Ring-Hai).
색인 함정: NARA Personalities 색인은 알파벳만이 기준 — 편철 제목에 Korea가 없어 '한국 자료'로는 안 걸린다. 구간 경계 이름(Kim·Park)은 두 칸 다 열기. 시기 구간 1940-54/1955-81 별도.
독립운동가는 독립기념관 인명사전(search.i815.or.kr)이 이명·가명·호를 대신 생성. 채집자명은 체류국 비중 확인 — coreana와 교집합 검색으로 판정. [성씨별 색인 칸 지도·NAID] 최 Choi=109921404 · 정/전/천=109921404-405 · 서/손 Sue-Sun=109921580·Soon=109921572 · 윤 Youn=109921617 · 유/이 Yu=109921751 · 양/안 Y-Yoksi=109921616 · 이 Rhee=109921542 · 호/홍=109921479+480(두 칸 걸침 — 둘 다 열 것).`;
const JB_WORLD = `세계 서고 지도 — 6개국+ 기관·분류체계 (조선 덱 2026-08-18 실측·조사분)
🇯🇵 일본 JACAR(jacar.go.jp): 3기관 한 창구 — A=국립공문서관·B=외무성 외교사료관(재외 한인 감시·독립운동)·C=방위연구소(군). 레퍼런스코드=영문1+숫자11(예 B04014056900) — 첫 글자가 기관, 코드 그대로 문서 직행(상세검색 All→Reference Code). 외무성 기록은 門-類-項-目 4단(한자 부수 분류 전통).
🇨🇳 중국: 제1역사당안관(베이징·명청 1,000만건·만주문 20%) / 제2역사당안관(난징·1912-49) — ★임시정부는 제2당안관(남경 임정 100여 권·괴뢰정권 91전종 10만권 — 재만 조선인 가능성). 체계: 全宗-类-案卷-文件(우리 철·건과 같은 자리). 당안관 4,234개 — 지방 당안관에 재만 기록 가능.
🇷🇺 러시아: ГАРФ(중앙 — '무엇을 하라' 결정) vs ГАХК 하바롭스크(지방 — '어떻게 했다' 집행). 1937 강제이주는 두 곳을 겹쳐야 실제가 나온다. 체계 ф(폰드)-оп(목록)-д(건).
🇲🇳 몽골 NCAM: 1674년~·126만 항목·6개 언어. 외국인은 다단계 허가 — '가서 보라' 할 수 없는 기관임을 명시.
🇰🇿 카자흐: 고려인 10만 도착지 — 중앙국립문서보관소 계열.
★비교표: 미 RG-Series-FileUnit-Item / 영 Dept-Series-Piece-Item / 일 소장관-資料群·門類項目-簿冊-件名 / 중 全宗-类-案卷-文件 / 러 ф-оп-д / 한 기록물군-계열-철-건 — 전부 ISAD(G) fonds·series·file·item 한 뼈대(출처주의). 하나를 익히면 여섯이 읽힌다.`;
const JB_CITIES = `도시명 계보 대조 — 표기 변형 실전표 (해외 카탈로그는 당대 표기로 적혀 있다)
서울: 한성·漢城 → 경성·京城·Keijo(일본 독음)·Kyongsong → Seoul (서울의 이름 13종 실측). 부산: Fusan(독음)·초량 Tsau-liang-hai(중국식) → Pusan → Busan. 평양: Heijo. 인천: Jinsen(독음)·Chemulpo(개항장) → Inchon. 원산: Gensan·Port Lazareff. 거문도: Port Hamilton. 제주: Quelpaert. 성진: Songchin → 김책(도시명 자체 소멸 — 이중 상실). 조선 국호 철자 7종: Corea·Korea·Chosen·Chosŏn·Joseon·Corée·朝鮮.
★규칙 1 — 1914 경계: 부군면 통폐합(1914)을 경계로 검색 어휘가 갈린다. 연도만 알면 어느 어휘를 쓸지 정해진다(4층 외래 명명은 논리가 없어 외워야 하지만 3층 개명은 규칙이 있다).
★규칙 2 — 로마자 표기법 연대: 1959 문교부식 → 1984 MR(매큔-라이샤워, 올림픽 계기) → 2000 국어의 로마자(인터넷 계기). 기록 생산·정리 시기를 알면 카탈로그 표기를 추정할 수 있다.
★규칙 3 — 국내 목록에 옛 표기 병기: 국내 기관이 Joseon으로만 기술할수록 Chosen으로 채워진 해외 목록과 영영 만나지 못한다 — Goguryeo(Koguryo) 방식 병기.`;
const JB_CROSS = `국내외 대조 절차 — 순서를 틀리면 헛수고한다
① 국내 연구사부터(사학사적 검토·수집정책 보고서 — 발굴의 첫 단계는 검색창이 아니라 보고서다) ② 번역본 존재 확인(원본 뒤지기 전에 우리말 번역으로 대목을 짚는다) ③ 해외 원본(번역에 없는 부분·사진·도판) ④ 국내 원사료와 같은 날짜 겹치기(승정원일기·실록 — 음/양력 주의).
같은 전투가 한쪽엔 '부상 30여 명', 다른 쪽엔 '승리'로 적힌다 — 둘 다 봐야 그날이 보인다.
국내 DB 요령: 검색어는 짧게(1단어), 인명은 하나씩. 국내 소장 해외자료 먼저(국편 NARA 문서·통일원 노획문서·국회도서관 국무부 문서·6·25아카이브 55,206건).
미기술 자료를 만나면: 기증이 어려우면 사본수집(공공기록물법 46조 — 국가기록원)·국립중앙도서관 책다모아(02-590-0700). 판단은 기관이 한다, 소장자는 연락만 하면 된다.`;

  server.tool('query_bank',
    'Browse validated discovery keywords (Song 2026). topic: "list" for groups, a group id (G-01..G-22, N-01..N-07), "RG" for NARA Record Group cross-map, "TNA" for the 14 strategy layers, "domestic" for the 5 domestic archives, or a domestic key (nedb/archives/nlk/warmemo/seoul) / domestic group id (e.g. NAK-L1). 전략 지식: "walls"=열한 겹의 벽(실패 원인 11층+대응), "identifiers"=식별자 해독(번호 규칙·옆 훑기), "persons"=인명 열쇠(표기 변형·색인 함정), "crosscheck"=국내외 대조 절차, "world"=6개국+ 서고 지도, "cities"=도시명 계보 대조(Keijo·Fusan·1914 경계), "allies"=한국전 참전·지원 22개국 발굴 지도(보유 소스 매핑·부대 고유명 열쇠), "recipes"=주제 유형별 발굴→판독→권리 완주 레시피 6종(인물·전투·조선·일제강점기·도시·이미지 소싱). 검증 쿼리 뱅크+조사 전략.',
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
      const STRAT = { walls: JB_WALLS, identifiers: JB_IDENT, persons: JB_PERSONS, crosscheck: JB_CROSS, world: JB_WORLD, cities: JB_CITIES, allies: JB_ALLIES, recipes: JB_RECIPES };
      if (STRAT[t.toLowerCase()]) return text(STRAT[t.toLowerCase()]);
      return text('Group not found — topic="list"(해외 G/N/RG/TNA)·"domestic"·전략(walls/identifiers/persons/crosscheck)');
    });

  server.tool('judge_rights',
    'First-pass copyright triage for a discovered record. A/B publishable · C permission needed · D unknown (do not publish). 공공누리(KOGL) 제1~4유형 자동 인식 — rg_series·title·archive 어디든 \"KOGL 2\"·\"공공누리 제1유형\" 표기를 넣으면 조건 판정. naid 지정 시 NARA 카탈로그의 Use Restriction 필드를 실제 조회해 자동판정(Unrestricted 실확인 → A 확정, Restricted → C). Final determination must be made by a human. 권리 등급 자동 초기판정 — 발굴 우선, 권리는 표시.',
    { rg_series: z.string().default('').describe('e.g. "RG 242/242-MID" (naid 지정 시 생략 가능)'), title: z.string().default(''), archive: z.string().default(''), naid: z.coerce.number().int().optional().describe('NARA NAID — 카탈로그 Use Restriction 실확인 e.g. 22015') },
    async ({ rg_series, title, archive, naid }) => {
      if (naid) { // NAID 실확인 자동판정 — "Unrestricted 확인 시 A 상향" 규칙의 자동화
        const key = process.env.NARA_API_KEY;
        if (!key) return text('NAID 실확인은 서버 NARA_API_KEY 필요 — rg_series 초판정을 사용하거나 catalog.archives.gov/id/' + naid + ' 의 Use Restriction을 직접 확인하십시오.');
        try {
          const d = await jget(`https://catalog.archives.gov/api/v2/records/search?naId=${naid}&limit=1`, { 'x-api-key': key });
          const rec = (((((d.body || {}).hits || {}).hits) || [])[0] || { _source: {} })._source.record || null;
          if (!rec || Number(rec.naId) !== naid) return text(`[NAID ${naid}] 카탈로그에 없음 — NAID를 확인하거나 rg_series 초판정을 사용하십시오.`);
          const ur = rec.useRestriction || {};
          const urs = typeof ur === 'string' ? ur : [ur.status, ur.note, (ur.specificUseRestrictions || []).join('/')].filter(Boolean).join(' · ');
          const rgnum = rec.recordGroupNumber || ((rec.ancestors || []).map((a) => a.recordGroupNumber).find(Boolean)) || '';
          const base = judgeRights(rgnum ? `RG ${rgnum}` : rg_series, rec.title || title, 'NARA');
          let cls = base[0], basis = base[1];
          if (/unrestricted/i.test(urs) && !/restricted\s*[-–]|possibly|fully restricted/i.test(urs)) { cls = 'A'; basis = `NARA 카탈로그 Use Restriction '${urs}' 실확인 — 제한 없음 확정 (출처 표기 권장)`; }
          else if (/restricted/i.test(urs)) { cls = 'C'; basis = `NARA 카탈로그 Use Restriction '${urs}' 실확인 — 제한 표기, 기관 확인 필요`; }
          else if (urs) basis += ` · Use Restriction '${urs.slice(0, 80)}' (판정 불변 — 문구 확인 필요)`;
          else basis += ' · 카탈로그에 Use Restriction 미기재 — RG 초판정 유지';
          // 맥락(v1.80): ancestors 전 계층 체인 — RG › 시리즈 › 파일단위, 각 층 NAID 포함(상·하위 항행 좌표)
          const chain = (rec.ancestors || []).map((a) => `${(a.levelOfDescription || '').replace(/recordGroup/i, 'RG')} ${a.recordGroupNumber || ''}${a.title ? ' ' + String(a.title).slice(0, 60) : ''}${a.naId ? ` [NAID ${a.naId}]` : ''}`.replace(/\s+/g, ' ').trim()).join(' › ');
          // 증거성(v1.80): 범위·내용 기술(scope note) 발췌 + 판독 시점 본문 지문
          const scope = String(rec.scopeAndContentNote || '').trim();
          const sfp = scope ? createHash('sha256').update(scope).digest('hex').slice(0, 16) : '';
          // 맥락·다매체(v1.82): 생산자·생산일·소장단위(청구 좌표)·디지털 객체 직링크
          const cre = String((((rec.creators || [])[0] || {}).heading || '')).slice(0, 90);
          const nd = naraDate(rec);
          const ru = String((((((rec.physicalOccurrences || [])[0] || {}).referenceUnits || [])[0] || {}).name || '')).slice(0, 80);
          const dob = rec.digitalObjects || [];
          const rank = (o) => { const t = String(o.objectType || '') + ' ' + String(o.objectUrl || ''); return (/tiff?\b/i.test(t) ? 3 : /jpe?g/i.test(t) ? 2 : /mp4|mov|video/i.test(t) ? 2 : /pdf/i.test(t) ? 1 : 0) * 1e12 + Number(o.objectFileSize || 0); };
          const d0 = [...dob].sort((x, y) => rank(y) - rank(x))[0] || {}; // v1.96.2: 첫 객체(작은 GIF 등) 대신 최선 원본(TIFF>JPG/영상>PDF, 큰 파일)
          return text(`[NAID ${naid}] ${(rec.title || '').slice(0, 95)}\n${rgnum ? `RG ${rgnum} · ` : ''}https://catalog.archives.gov/id/${naid}\n`
            + (chain ? `계보: ${chain.slice(0, 280)}\n` : '')
            + (cre || nd ? `생산: ${[cre, nd].filter(Boolean).join(' · ')}\n` : '')
            + (ru ? `소장단위: ${ru} (열람·복제 청구 좌표)\n` : '')
            + (dob.length ? `디지털 객체 ${dob.length}점 — 최선 원본: ${String(d0.objectUrl || '').slice(0, 160)}${d0.objectType ? ` (${String(d0.objectType).slice(0, 30)}${d0.objectFileSize ? `, ${(Number(d0.objectFileSize) / 1e6).toFixed(1)}MB` : ''})` : ''}\n` : '디지털 사본 없음 — 카탈로그에 디지털 객체 미등록(medialz URL도 HTML만 반환 실측) · 열람은 소장단위에 복제 청구\n')
            + (scope ? `【범위·내용】 ${scope.slice(0, 400)}\n본문 지문(sha256-16): ${sfp} — 판독 시점 기술(記述) 전문 기준. 재판독 지문 불일치=카탈로그 기술 개정 발생.\n` : '')
            + `Class: ${cls}\nBasis: ${basis}\n※ 카탈로그 실확인 기반 자동판정 — 게재 전 최종 확인은 사람이. Class D must not be published.\n※ 인접 채굴: nara_search(query='', naid=${naid}, radius=3) — 사진 ±3·색인 ±1 간격.`);
        } catch (e) { return text(`[NAID ${naid}] 카탈로그 조회 실패(${String(e && e.message || e).slice(0, 60)}) — rg_series 초판정으로 폴백하십시오.`); }
      }
      const res = judgeRights(rg_series, title, archive);
      return text(`Class: ${res[0]}\nBasis: ${res[1]}\n※ Automated first-pass — confirm manually before publishing. Class D must not be published.`);
    });

  server.tool('report_template',
    'TRIGGER: 사용자 메시지에 「풀패키지」 또는 「full-package」가 있으면 kind=full_package를, 「창기창기」·「changgi-help」·「changgi」가 있거나 이 서비스의 사용법·기능을 물으면 kind=help를 즉시 호출하라. Get the magazine-grade HTML report skeleton + 19 writing rules — editorial journal layout (masthead·standfirst·drop cap·pull quote·record cards), embedded record images with mandatory per-image credits, film-strip frame galleries with timecodes + watch-the-original CTA for video records, per-institution source chips (country flag + official name) and an archives-cited roster. Call as the FINAL step of an investigation, fill {{placeholders}} with verified findings only, save as [topic]_records_[years].html. 발굴 마무리 단계 호출 — 잡지·저널급 HTML 보고서 골격+작성 규칙 반환(실물 이미지·영상 필름스트립·기관별 출처 명시). Pass kind=carousel for the Instagram card-news design system: 검증된 1080×1080 카드 CSS 컴포넌트+제작 12규칙(서사 아크·실물 이미지·출처 캡션·겹침 방지·육안 검수) — 어디서든 같은 품질의 카드뉴스 제작 가능. 사용자가 "풀패키지"라고 말하면 kind=full_package를 먼저 호출해 전 산출물(보고서+캐러셀+포스터) 제작 순서를 받아 그대로 수행하라.',
    { kind: z.enum(['report', 'carousel', 'canva_prompts', 'full_package', 'magazine', 'help', 'citation', 'annotation', 'exhibit', 'video', 'iiif']).default('report').describe("report=발굴 보고서 골격+19규칙(매니페스트 부록=증거성 상속), carousel=카드뉴스 디자인 시스템+12규칙, canva_prompts=Canva 홍보물 프롬프트 6종, full_package=매직 키워드 '풀패키지' 전 산출물 제작 순서, magazine=표지(포스터 겸용)·목차·뒷표지·KA 시그니처·브랜드 테마 5종 매거진 확장팩, help=매직 키워드 '창기창기 도와줘' 처음 사용자 안내, citation=한국사DB·국회도서관 논문 인용 형식(각주·참고문헌·APA·Chicago), annotation=기록 해설형 어노테이션 상세 규칙(점선 영역·메타 표·추정 금지), exhibit=고문서 전시형(AKS 문중·서원 고문서 — 전시 페이지·카드·학습지 규칙+HTML 골격), video=영상 기록 장면 해설(장면 추출 로컬/웹 경로·보이는 것만 해설·장면 카드), iiif=IIIF 갤러리(연속 이미지 뷰 — 공개 갤러리·기관별 IIIF·권리 3단계·매니페스트·뷰어 골격)") },
    async ({ kind }) => kind === 'carousel'
      ? text(CAROUSEL_RULES + '\n\n===== CARD DESIGN SYSTEM (1080×1080 — .card를 그대로 복사해 채울 것) =====\n' + CAROUSEL_TEMPLATE)
      : kind === 'canva_prompts' ? text(CANVA_PROMPTS)
      : kind === 'full_package' ? text(FULL_PACKAGE)
      : kind === 'magazine' ? text(MAGAZINE_PACK)
      : kind === 'help' ? text(HELP_GUIDE)
      : kind === 'citation' ? text(CITATION_GUIDE)
      : kind === 'video' ? text(VIDEO_GUIDE)
      : kind === 'iiif' ? text(IIIF_GUIDE)
      : kind === 'annotation' ? text(ANNOTATION_GUIDE)
      : kind === 'exhibit' ? text(EXHIBIT_GUIDE)
      : text(REPORT_RULES + '\n\n===== HTML TEMPLATE (fill the {{placeholders}}) =====\n' + REPORT_TEMPLATE));

  // ===== 국내 아카이브 — 자동 브라우징(서버 사이드 fetch·파싱) v1.9.0 =====
  const dclean = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&lsquo;|&rsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&middot;/g, '·').replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).trim();
  const dbrowse = (u) => `\n열어보기: ${u}`;
  const agentBrowse = (name, q, u, why = '이 기관은 자동 페치가 제한적입니다') => `${name} '${q}' — ${why}.\n➤ 다음 단계(안내): 웹 검색이나 브라우저로 아래 공식 검색 URL을 열어 '${q}' 상위 결과(제목·연대·링크)를 표로 정리하면 됩니다. 결과가 있으면 report_template으로 HTML 보고서화도 가능합니다.\n공식 검색: ${u}`; // v1.96.2: 지시형('사용자에게 전달하지 마세요') 문구 제거 — 숨은 지시로 오인될 표현 정리


  server.tool('nedb_search',
    "국사편찬위 한국사DB(db.history.go.kr) 검색 + 기관별 심층 판독 모드. mode: total=통합검색(기본) · law=법전·편람 조문(한문 원문 제공 판정) · record=등록류(座目 자동 필터 — 건수 지표화 전 필수) · item=levelId 본문 판독(미공개/파싱실패 구분) · sibling=★형제 조 전수 스캔(levelId — 조문을 열었으면 반드시 이어 호출, 총론만으론 핵심을 놓친다) · matrix=법전 수록 대조(쉼표구분 어휘 ≤8 — 부재의 발견) · origin=어휘 연원('용어' 또는 '용어,영역') · sjw=승정원일기(왕대 분포) · kyujanggak=규장각 목록+해제 · aks=한국고문서자료관(문중·서원 172곳→분류→문서 면·썸네일) · jacar=일본 아시아역사자료센터(레퍼런스코드 직행·±span 인접) · gonghun=공훈전자사료관(이름→mngNo 투입 시 공적조서·공훈록) · i815=독립기념관(detail URL=본문·사전:이름/번호=전기·훈격) · ktv=KTV(→view URL 투입 시 영상 해설·상영정보, 공공누리 표시 확인) · earchive=국편 전자사료관(키워드 목록→'키워드|순번' 투입 시 상세: 열람·이용조건·등록번호) · commons=위키미디어 공용(키워드 목록→File URL 투입 시 라이선스·원 소장처·설명 판독) · jsg=장서각(→청구기호 K2-… 투입 시 서지·해제 전문) · un=UN(→recid 투입 시 요약·주제·PDF) · oldnews=신문(CNTS=색인어·관련기사 · '본문:…[|1905-1910]'=OCR+연대) · much=박물관(→idnbr 투입 시 재질·공공누리·설명) · indy=판결문(이름→상세 URL 투입 시 죄명·주문·사건개요·원문 뷰어) · heritage=국가유산(목록+딥링크) · nzarch=NZ기록원(R번호=상세 메타) · okchf=국외소재문화유산재단 · nrich=국립문화유산연구원. 판정: 건수보다 '492건이 座目'.",
    { query: z.string().describe("검색어 · levelId(item/sibling) · 쉼표구분 어휘(matrix) · '용어,영역'(origin) · 소장처명/L-ID(aks) · 이름/mngNo(gonghun)"), db: z.string().default(''), max_results: z.number().int().min(1).max(50).default(15), mode: z.enum(['total', 'law', 'record', 'item', 'sibling', 'matrix', 'origin', 'sjw', 'kyujanggak', 'aks', 'jacar', 'gonghun', 'i815', 'ktv', 'earchive', 'commons', 'jsg', 'un', 'oldnews', 'much', 'indy', 'heritage', 'nzarch', 'okchf', 'nrich']).default('total'), span: z.number().int().min(2).max(12).default(8).describe('sibling 모드 스캔 폭') },
    async ({ query, max_results, mode, span }) => {
      const q = query.trim();
      if (mode === 'nzarch') { // Archives NZ 상세 판독 — R번호 투입 시 entity 전체 메타(시리즈·기관·계층·열람·권리) + 메타 지문. v1.69
        try {
          const rn = q.match(/^[Rr](\d{5,9})$/) ? 'R' + q.match(/^[Rr](\d{5,9})$/)[1] : (q.match(/^\d{5,9}$/) ? 'R' + q : null);
          if (!rn) return text("nzarch 판독: R번호(예 R17717658)를 입력하십시오. 번호는 cross_search(sources='nzarch')가 제공.");
          const b = await gtext('https://collections.archives.govt.nz/federated-search/customers/aims/search?size=3&facetSize=0&start=0&isFuzzy=false&sourceId=aims-archive&q=' + rn);
          const line = b.split('\n').find((l) => l.startsWith('data:') && l.includes('"totalHits"'));
          if (!line) { // 간헐 Incapsula — 주간 수확 인덱스로 축약 판독 폴백
            try {
              const ix = await cachedText('nzIdx', 6 * 3600e3, () => gtext('https://korea-archive-mcp.vercel.app/nz-index.json'), '"records"');
              const r = (JSON.parse(ix).records || []).find((x) => String(x.id) === rn);
              if (r) return text(`Archives NZ 판독(축약 — ·주간인덱스, 라이브 간헐 차단 중) — ${rn}\n제목: ${r.title}\n`
                + [r.date && `연대 ${r.date}`, r.series && `시리즈 ${r.series}`, r.access && `접근 상태 ${r.access}`].filter(Boolean).join(' · ') + '\n'
                + `레코드: https://collections.archives.govt.nz/web/arena/search#/entity/aims-archive/${rn}\n`
                + '※ 전체 메타(생산 기관·열람 방법·메타 지문)는 라이브 재시도 시 제공. 출처: Archives New Zealand.');
            } catch { /* 인덱스도 실패 — 아래 안내 */ }
            return text(`[${rn}] 간헐 차단 — 잠시 후 재시도 또는 브라우저: https://collections.archives.govt.nz/web/arena/search#/entity/aims-archive/${rn}`);
          }
          const j = JSON.parse(line.slice(5));
          const h = (j.hits || []).find((x) => ((x.entity || {}).id || '') === rn) || (j.hits || [])[0];
          if (!h) return text(`[${rn}] 레코드 미발견 — 번호를 확인하십시오.`);
          const e = h.entity || {};
          const cf = (k) => { try { return String(e.custom[k].value.map((v) => v.value).join(' | ')); } catch { return ''; } };
          const mfp = createHash('sha256').update(String(e.name || '') + '\n' + JSON.stringify(e.custom || {})).digest('hex').slice(0, 16);
          return text(`Archives NZ(Te Rua Mahara) 판독 — ${e.id || rn}\n제목: ${e.name || '(무제)'}\n`
            + [e.descriptionLevel && `기술계층 ${e.descriptionLevel}`, cf('itemLevel') && `형태 ${cf('itemLevel')}`, cf('resultDate') && `연대 ${cf('resultDate')}`, e.holdingsLocation && `소장 ${e.holdingsLocation}`].filter(Boolean).join(' · ') + '\n'
            + (cf('series') ? `시리즈: ${cf('series')}${e.parentId ? ` (Series ${e.parentId})` : ''}\n` : '')
            + (cf('resultField4') ? `생산 기관: ${cf('resultField4').replace(/^Agency:\s*/, '')}\n` : '')
            + (cf('accessStatus') ? `접근 상태: ${cf('accessStatus')} — 발굴 우선: 권리는 표시 대상\n` : '')
            + ((e.orderType || []).length ? `열람 방법: ${e.orderType.join(' · ')}\n` : '')
            + `메타 지문(sha256-16): ${mfp} — 판독 시점 기술(記述) 전체 기준. 재판독 지문 불일치=기술 개정 발생.\n`
            + `레코드: https://collections.archives.govt.nz/web/arena/search#/entity/aims-archive/${e.id || rn}\n`
            + '※ 출처: Archives New Zealand Te Rua Mahara o te Kāwanatanga — 게재 시 출처 표기. May be restricted는 기관 열람 신청 대상.');
        } catch (err) { return text(`Archives NZ 오류(${String(err && err.message || err).slice(0, 60)}) — 잠시 후 재시도.`); }
      }
      if (mode === 'heritage') { // 국가유산 — 키워드 목록 / ccbaCpno 상세(해설·시대·소유/관리). cpno=구분1+종목2+시도2+지정8 분해
        try {
          const rid = q.match(/^(\d{2})-([0-9A-Za-z]+)-(\d{2})$/); // 목록이 보존한 원값(kdcd-asno-ctcd)
          if (rid) {
            const [, kdcd, asno, ctcd] = rid;
            const b = await cachedText(`heriD:${kdcd}|${asno}|${ctcd}`, 24 * 3600e3,
              () => gtext(`https://www.khs.go.kr/cha/SearchKindOpenapiDt.do?ccbaKdcd=${kdcd}&ccbaAsno=${asno}&ccbaCtcd=${ctcd}`), '<ccbaMnm1>');
            const g = (t) => xtag(b, t);
            const name = g('ccbaMnm1');
            if (!name) return text(`[${q}] 상세 미매칭 — 포털에서 열람하십시오(목록의 딥링크).`);
            let content = dclean(g('content'));
            const hfp = content ? createHash('sha256').update(content).digest('hex').slice(0, 16) : ''; // 판독 시점 해설 지문
            if (content.length > 3500) content = content.slice(0, 3500) + ` …(총 ${content.length}자 — 전문은 포털)`;
            return text(`국가유산 판독 — ${name}${g('ccbaMnm2') ? `(${g('ccbaMnm2')})` : ''} [${g('ccmaName') || ''}]\n`
              + [g('ccbaPoss') && `소유 ${g('ccbaPoss')}`, g('ccbaAdmin') && `관리 ${g('ccbaAdmin')}`, g('ccceName') && `시대 ${g('ccceName')}`, g('ccbaLcad') && `소재 ${dclean(g('ccbaLcad')).slice(0, 60)}`].filter(Boolean).join(' · ') + '\n'
              + (content ? `【해설】\n${content}\n` : '')
              + (hfp ? `본문 지문(sha256-16): ${hfp} — 판독 시점 해설 전문 기준. 재판독 지문 불일치=원문 개정 발생.\n` : '')
              + (await heritageImages(kdcd, asno, ctcd, g('imageUrl')))
              + `■ IIIF(맥락·증거성 포함, 어느 IIIF 뷰어든): ${bridgeUrl('heritage', `${kdcd}-${asno}-${ctcd}`)} · KV: ${kvUrl(bridgeUrl('heritage', `${kdcd}-${asno}-${ctcd}`))}\n`
              + '※ 출처: 국가유산청 국가유산포털 — 게재 시 출처 표기. 사진 이용은 공공누리 유형 확인.');
          }
          const hm = q.match(/ccbaCpno=(\d{13})/) || q.match(/^(\d{13})$/);
          if (hm) {
            const cpno = hm[1];
            const kdcd = cpno.slice(1, 3), ctcd = cpno.slice(3, 5), asno8 = cpno.slice(5);
            // asno 포맷이 종목별로 달라 후보 순차 시도(8자리·4자리·무패딩 — 빈 레코드면 다음)
            // 기관 원값 asno는 13자리('00'+지정4+'0000000') — 실측 역산 후보를 최우선
            const cands = [...new Set(['00' + asno8.slice(0, 4) + '0000000', asno8, asno8.slice(0, 4)])];
            let b = ''; let g = (t) => xtag(b, t);
            for (const asno of cands) {
              b = await cachedText(`heriD:${kdcd}|${asno}|${ctcd}`, 24 * 3600e3,
                () => gtext(`https://www.khs.go.kr/cha/SearchKindOpenapiDt.do?ccbaKdcd=${kdcd}&ccbaAsno=${asno}&ccbaCtcd=${ctcd}`), '<ccbaMnm1>');
              if (xtag(b, 'ccbaMnm1')) { var usedAsno = asno; break; } // eslint-disable-line no-var
            }
            const name = g('ccbaMnm1');
            if (!name) return text(`[${cpno}] 상세 API 미매칭(기관 식별 편차 — 2026-11-21 명세 기록). 해설은 포털에서: https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaCpno=${cpno}`);
            let content = dclean(g('content'));
            const hfp = content ? createHash('sha256').update(content).digest('hex').slice(0, 16) : ''; // 판독 시점 해설 지문
            if (content.length > 3500) content = content.slice(0, 3500) + ` …(총 ${content.length}자 — 전문은 포털)`;
            return text(`국가유산 판독 — ${name}${g('ccbaMnm2') ? `(${g('ccbaMnm2')})` : ''} [${g('ccmaName') || ''}${g('crltsnoNm') ? ` ${g('crltsnoNm')}` : ''}]\n`
              + [g('ccbaPoss') && `소유 ${g('ccbaPoss')}`, g('ccbaAdmin') && `관리 ${g('ccbaAdmin')}`, g('ccceName') && `시대 ${g('ccceName')}`, g('ccbaLcad') && `소재 ${dclean(g('ccbaLcad')).slice(0, 60)}`].filter(Boolean).join(' · ') + '\n'
              + (content ? `【해설】\n${content}\n` : '')
              + (hfp ? `본문 지문(sha256-16): ${hfp} — 판독 시점 해설 전문 기준. 재판독 지문 불일치=원문 개정 발생.\n` : '')
              + (await heritageImages(kdcd, usedAsno, ctcd, g('imageUrl')))
              + `포털 상세: https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaCpno=${cpno}\n`
              + '※ 출처: 국가유산청 국가유산포털 — 게재 시 출처 표기(해설문 인용 시 포털 명기). 사진 이용은 공공누리 유형 확인.');
          }
          const items = await COLLECT.heritage(q, Math.min(max_results, 15));
          if (!items.length) return text(`국가유산 '${q}' — 0건. 유산 명칭(전각·사적명 등)으로 재시도하십시오.`);
          return text(`국가유산 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title}${it.id ? ` [${it.id}]` : ''}\n  ${it.url}`).join('\n')
            + '\n※ 대괄호의 복합 id(예 11-02230000-11)를 mode=heritage query로 재투입 → 해설·시대·소유/관리 판독.');
        } catch (e) { return text(`국가유산 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://www.heritage.go.kr`); }
      }
      if (mode === 'indy') { // 독립운동판결문 — 이름 목록 / 상세 URL 판독(죄명·주문·사건개요·원문 뷰어)
        try {
          if (/viewIndyDetail\.do/.test(q) && /^https?:\/\/theme\.archives\.go\.kr\//.test(q)) {
            const evnt = (q.match(/FK_ARCHIVE_EVNT_ID=(\d+)/) || [])[1] || '';
            const b = await cachedText('indyD:' + (evnt || q.slice(-40)), 24 * 3600e3, () => gtext(q), '판결기관');
            const flat = dclean(b);
            const pick = (re2) => ((flat.match(re2) || [])[1] || '').trim();
            const name = pick(/이름\/별명\s*(.{2,40}?)\s*당시나이/);
            const age = pick(/당시나이\s*(.{1,20}?)\s*본적/);
            const addr = pick(/본적\/주소\s*(.{2,60}?)\s*판결기관/);
            const organ = pick(/판결기관\s*(\S{2,20})/);
            const crime = pick(/죄명\s*(.{2,50}?)\s*생산년도/);
            const sent = pick(/주문\s*(.{2,100}?)\s*관리번호/);
            const vdate = pick(/판결날짜\s*(\d{8})/);
            const kase = pick(/사건개요\s*([\s\S]{5,900}?)\s*판결문 원문보기/);
            if (!name && !kase) return text(`판결문 상세 파싱 실패 — viewIndyDetail URL을 확인하거나 mode=indy에 이름을 넣으십시오.`);
            return text(`독립운동판결문 판독 — ${name}${age ? ` (당시 ${age})` : ''}\n`
              + [addr && `본적/주소 ${addr}`, organ && `판결기관 ${organ}`, vdate && `판결 ${vdate}`].filter(Boolean).join(' · ') + '\n'
              + (crime ? `죄명: ${crime}\n` : '') + (sent ? `주문: ${sent}\n` : '')
              + (kase ? `【사건개요】\n${kase}\n` : '')
              + (kase ? `본문 지문(sha256-16): ${createHash('sha256').update(kase + '\n' + (sent || '')).digest('hex').slice(0, 16)} — 판독 시점 사건개요·주문 기준. 재판독 지문 불일치=원문 개정 발생.\n` : '')
              + (evnt ? `판결문 원문 뷰어: https://theme.archives.go.kr/viewer/common/archWebViewer.do?archiveEventId=${evnt}\n` : '')
              + '※ 출처: 국가기록원 독립운동판결문 — 게재 시 출처 표기. 수형 사실의 존엄 고려(게재윤리). gonghun 수형기록과 교차검증 권장.');
          }
          const items = await COLLECT.indy(q, Math.min(max_results, 15));
          if (!items.length) return text(`독립운동판결문 '${q}' — 0건. 이름(이명·한자 포함)으로 재시도하십시오.`);
          return text(`독립운동판결문 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title} (${it.date})\n  ${it.url}`).join('\n')
            + '\n※ 상세 URL을 mode=indy query로 재투입 → 죄명·주문·사건개요·원문 뷰어 판독.');
        } catch (e) { return text(`독립운동판결문 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://theme.archives.go.kr/next/indy/viewMain.do`); }
      }
      if (mode === 'much') { // 역사박물관 — 키워드 목록 / idnbr·URL 판독(재질·크기·공공누리 유형·설명)
        try {
          const im = q.match(/idnbr=([A-Z]{2}[\w-]+)/) || q.match(/^(PS\d[\w-]{8,})$/);
          if (im) {
            const id2 = im[1];
            const b = await cachedText('muchD:' + id2, 24 * 3600e3,
              () => gtext('https://archive.much.go.kr/archive/nrms/view.do?idnbr=' + encodeURIComponent(id2)), '소장품번호');
            const flat = dclean(b);
            const pick = (re2) => ((flat.match(re2) || [])[1] || '').trim();
            const mat = pick(/재질\s*(\S{1,14})\s*작가/);
            const artist = pick(/작가\s*(.{1,40}?)\s*크기/);
            const size = pick(/크기\s*(\S{1,50}?)\s*소장품번호/);
            const no2 = pick(/소장품번호\s*(\S{2,20})/);
            const km = flat.match(/제\s*(\d)\s*유형\s*:\s*(.{3,60}?)\s*본 저작물/);
            const di = flat.indexOf('이용할 수 있습니다.');
            let desc = di >= 0 ? flat.slice(di + 11, di + 1700).trim() : '';
            desc = desc.split(/자료열람|활용정보|이전글|다음글|사이트맵|COPYRIGHT/i)[0].replace(/&times;|×/g, '').trim();
            if (!no2 && !desc) return text(`[${id2}] 상세 미발견 또는 구조 상이 — idnbr을 확인하거나 mode=much에 검색어를 넣으십시오.`);
            const rline = km ? (() => { const r2 = judgeRights(`KOGL ${km[1]}`, '', '역사박물관'); return `\n권리 초판정(공공누리 제${km[1]}유형 — ${km[2].trim()}): ${r2[0]} — ${r2[1]}`; })() : '';
            const imgs = [...new Set([...b.matchAll(/<img[^>]+src="([^"]+)"/gi).map((m) => m[1]).filter((u) => !/\/(images?|img|common|layout|btn|icon|logo)\//i.test(u) && !/logo|icon|btn_|blank|kogl|open_?type/i.test(u) && /\.(jpe?g|png|gif)|image|file|down|view/i.test(u))])]
              .slice(0, 6).map((u) => (u.startsWith('http') ? u : 'https://archive.much.go.kr' + (u.startsWith('/') ? '' : '/') + u)); // v1.95: 원본 이미지 직링크
            return text((imgs.length ? `【원본 이미지 ${imgs.length}점】\n${imgs.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n` : '') + `역사박물관 소장품 판독 — [${id2}]\n`
              + [no2 && `소장품번호 ${no2}`, mat && `재질 ${mat}`, artist && `작가 ${artist}`, size && `크기 ${size}`].filter(Boolean).join(' · ') + rline + '\n'
              + (desc ? `【설명】\n${desc}\n` : '')
              + `원문·이미지: https://archive.much.go.kr/archive/nrms/view.do?idnbr=${encodeURIComponent(id2)}\n`
              + `■ IIIF(맥락·증거성 포함, 어느 IIIF 뷰어든): ${bridgeUrl('much', id2)} · KV: ${kvUrl(bridgeUrl('much', id2))}\n`
              + '※ 출처: 대한민국역사박물관 근현대사아카이브 — 게재 시 출처 표기, 공공누리 유형 조건 준수.');
          }
          const items = await COLLECT.much(q, Math.min(max_results, 10));
          if (!items.length) return text(`역사박물관 '${q}' — 0건. 사건명·실물 유형(포스터·잡지 등)으로 재시도하십시오.`);
          return text(`역사박물관 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title}${it.date ? ` (${it.date})` : ''}\n  ${it.url}`).join('\n')
            + '\n※ idnbr(또는 상세 URL)을 mode=much query로 재투입 → 재질·크기·공공누리 유형·설명 판독.');
        } catch (e) { return text(`역사박물관 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://archive.much.go.kr`); }
      }
      if (mode === 'oldnews') { // 대한민국신문아카이브 — 키워드 목록 / CNTS·URL 판독 / '본문:키워드' OCR 전문 발췌
        try {
          const bm = q.match(/^본문[:：]\s*(.+?)(?:\|(\d{4})\s*[-~]\s*(\d{4}))?$/);
          if (bm) { // OCR 본문 전문 검색('본문:키워드' 또는 '본문:키워드|1905-1910' 연대 한정 — 서버 faceted는 연결 거부라 후처리 필터)
            const kw = bm[1].trim(); const y1 = bm[2] ? +bm[2] : 0; const y2 = bm[3] ? +bm[3] : 9999;
            const r2 = await fetch('https://nl.go.kr/newspaper/search_bodytext.do', { method: 'POST',
              headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Referer: 'https://nl.go.kr/newspaper/bodytext_search.do' },
              body: JSON.stringify({ search_keyword: kw, page_size: y1 ? 30 : Math.min(max_results, 10), page_no: 1 }), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
            if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
            const d2 = await r2.json();
            const f1 = (v) => (Array.isArray(v) ? v[0] : v) || '';
            const dist = Object.entries(d2.by_issuedYear || {}).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' · ');
            const hits2 = (d2.hits || []).filter((h) => { const yy = parseInt(String(h.issued_date || '').slice(0, 4), 10) || 0; return yy >= y1 && yy <= y2; }).slice(0, Math.min(max_results, 10));
            const rows = hits2.map((h) => {
              const ex = dclean(String(f1(h.highlight_abstract) || f1(h.abstract) || ''));
              return `- ${f1(h.label)} — ${f1(h.newspaperKorName)} (${h.issued_date || ''})\n  발췌: ${ex.slice(0, 180)}\n  ${f1(h.uri) ? `https://nl.go.kr/newspaper/detail.do?content_id=${f1(h.uri)}` : ''}`;
            });
            if (!rows.length) return text(`신문아카이브 본문검색 '${kw}'${y1 ? ` (${y1}~${y2})` : ''} — 0건.${y1 ? ' 상위 30건 내 해당 연대 없음 — 범위를 넓히거나' : ''} 당대 표기(국한문·옛 한글)로 재시도하십시오.${dist ? `\n연도 분포(전체): ${dist}` : ''}`);
            return text(`신문아카이브 OCR 본문검색 '${kw}'${y1 ? ` (연대 ${y1}~${y2} 한정)` : ''} — 전체 ${d2.total_count || rows.length}건${dist ? ` · 연도 분포 ${dist}` : ''}\n표시 ${rows.length}건:\n` + rows.join('\n')
              + '\n※ 발췌는 OCR 원문(국한문 그대로). CNTS를 mode=oldnews로 재투입 → 색인어·관련기사 연쇄.');
          }
          const cm = q.match(/content_id=(CNTS-[\d]+)/) || q.match(/^(CNTS-[\d]+)$/);
          if (cm) {
            const cid = cm[1];
            const d = JSON.parse(await cachedText('oldnewsD:' + cid, 24 * 3600e3,
              async () => JSON.stringify(await jget(`https://nl.go.kr/newspaper/news_detail.do?content_id=${cid}&ko_trans=no&abstractExist=false`, { Referer: 'https://nl.go.kr/newspaper/detail.do' })), 'newspaperKorName'));
            const f1 = (v) => (Array.isArray(v) ? v[0] : v) || '';
            if (!f1(d.label)) return text(`[${cid}] 기사 미발견 — CNTS ID를 확인하십시오.`);
            const subj = [...(d.subjectEvent || []), ...(d.subjectPlace || [])].map((x) => String(x).split('|')[0]).slice(0, 8).join(' · ');
            const rel = (d.relatedArticles || []).slice(0, 5).map((r2) => `  · ${f1(r2.label)} (${f1(r2.issued)}) ${f1(r2.uri)}`).join('\n');
            return text(`신문아카이브 기사 판독 — ${f1(d.label)}\n`
              + `${f1(d.newspaperKorName)}${f1(d.newspaperForeignName) ? `(${f1(d.newspaperForeignName)})` : ''} · ${f1(d.issued)} · 발행 ${f1(d.publisher)}\n`
              + ((d.keyword || []).length ? `색인어(기사 내용 재구성): ${(d.keyword || []).join(', ').slice(0, 800)}\n` : '')
              + (subj ? `주제: ${subj}\n` : '')
              + (rel ? `관련기사 연쇄(→ CNTS를 mode=oldnews로 재투입):\n${rel}\n` : '')
              + ((d.description || []).length ? `원소장처: ${(d.description || []).join(' / ').slice(0, 200)}\n` : '')
              + `원문 이미지(뷰어): https://nl.go.kr/newspaper/detail.do?content_id=${cid}\n`
              + '※ 출처: 국립중앙도서관 대한민국신문아카이브 — 본문은 이미지 원문(뷰어 열람). 게재 시 신문명·발행일 출처 표기, 원소장처 병기.');
          }
          const items = await COLLECT.oldnews(q, Math.min(max_results, 10));
          if (!items.length) return text(`신문아카이브 '${q}' — 0건. 당대 표기(한자·옛 한글)로 재시도하십시오.`);
          return text(`신문아카이브 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title} (${it.date})\n  ${it.url}`).join('\n')
            + '\n※ CNTS ID(또는 상세 URL)를 mode=oldnews query로 재투입 → 색인어·관련기사 연쇄·주제어 판독.');
        } catch (e) { return text(`신문아카이브 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://nl.go.kr/newspaper/`); }
      }
      if (mode === 'nrich') { // v2.13 국립문화유산연구원 — 국외문화유산 상세(ov:mseq·URL)·발간자료 상세(rep:idx·URL: 초록·목차)·'보고서:키워드'·그 밖은 두 DB 목록
        try {
          const om = q.match(/overseasSearchView\.do\S*?mseq=(\d+)/) || q.trim().match(/^ov\s*[:#]\s*(\d+)$/);
          if (om) {
            const url = `${NR_B}/kor/overseasSearchView.do?menuIdx=840&mseq=${om[1]}`;
            const h = (await cachedText('nrO:' + om[1], 24 * 3600e3, () => gtext(url, OK_UA), '소장처명')).replace(/<script[\s\S]*?<\/script>/g, ' ');
            const F = {}; for (const m of h.matchAll(/<(?:th|dt)[^>]*>([\s\S]*?)<\/(?:th|dt)>\s*<(?:td|dd)[^>]*>([\s\S]*?)<\/(?:td|dd)>/g)) { const k = okText(m[1]); const v = okText(m[2]); if (k && v && !(k in F)) F[k] = v; }
            const imgs = [...new Set([...h.matchAll(/<img[^>]+src="(\/file_link\/[^"]+)"/g)].map((m) => NR_B + encodeURI(m[1])))];
            const nm = [F['한글명칭'], F['한자명칭'], F['원어명칭']].filter(Boolean).join(' · ') || `ov:${om[1]}`;
            return text(`국립문화유산연구원 국외문화유산 판독 — ${nm}\n` + Object.entries(F).filter(([k]) => !['한글명칭', '한자명칭', '원어명칭'].includes(k)).map(([k, v]) => `${k}: ${v.slice(0, 200)}`).join('\n') + '\n'
              + (imgs.length ? `이미지 ${imgs.length}장: ${imgs.slice(0, 4).join(' · ')}\n` : '') + `원문 뷰어: ${url}\n`
              + `※ 출처: 국립문화유산연구원 국가유산 지식이음 — ${F['이용범위'] || '이용조건 원 기관 확인'}. 공공누리 제4유형은 출처표시·비상업·변경금지(원형 그대로). 국외소재문화유산재단(okchf) 기록과 교차확인 권장.`);
          }
          const rm = q.match(/originalUsrView\.do\S*?info_idx=(\d+)/) || q.trim().match(/^rep\s*[:#]\s*(\d+)$/);
          if (rm) {
            const url = `${NR_B}/kor/originalUsrView.do?menuIdx=1046&info_idx=${rm[1]}`;
            const h = (await cachedText('nrR:' + rm[1], 24 * 3600e3, () => gtext(url, OK_UA), 'detail_tech')).replace(/<script[\s\S]*?<\/script>/g, ' ');
            const title = okText(((h.match(/<div class="detail_tech[^"]*">\s*<h3 class="tit">([\s\S]*?)<a /) || [])[1]) || `rep:${rm[1]}`);
            const F = {}; for (const m of h.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) { const k = okText(m[1]); const v = okText(m[2]); if (k && v && k.length < 12 && !(k in F)) F[k] = v; }
            const abs = okText((h.match(/<p id="mcctP"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
            const toc = ((h.match(/<pre id="listConPre">([\s\S]*?)<\/pre>/) || [])[1] || '').split('\n').map(okText).filter(Boolean);
            const img = (h.match(/<div class="techBox">[\s\S]*?<img src="([^"]+)"/) || [])[1];
            return text(`국립문화유산연구원 발간자료 판독 — ${title}\n` + Object.entries(F).slice(0, 8).map(([k, v]) => `${k}: ${v.slice(0, 160)}`).join(' · ') + '\n'
              + (abs ? `【초록】\n${abs.slice(0, 1500)}\n본문 지문(sha256-16): ${createHash('sha256').update(abs).digest('hex').slice(0, 16)} — 판독 시점 초록 기준.\n` : '')
              + (toc.length ? `【목차】\n${toc.join('\n').slice(0, 1800)}\n` : '') + (img ? `표지: ${NR_B}${img}\n` : '') + `원문 뷰어(PDF 열람·내려받기): ${url}\n`
              + '※ 출처: 국립문화유산연구원 발간자료 — 공공누리 유형은 원문 페이지 표기 확인(대부분 제4유형: 출처표시·비상업·변경금지). 인용 시 보고서명·발행년도·쪽수.');
          }
          const pm2 = q.trim().match(/^인물\s*[:：]\s*(.+)$/);
          if (pm2) { // v2.20 인물 색인 — 금석문 찬·서, 초상화 화가, 괘불 화승, 일기 저자(동명이인 가능 — 한자 병기로 구분)
            const P = await nrPeople(); const nm = pm2[1].trim(); const keys = nrPeopleKeys(P, nm);
            if (!keys.length) return text(`인물 '${nm}' — 연구DB 인물 색인(금석문 찬·서·제액, 초상화 화가, 괘불 화승, 일기 저자)에 없음. 본문 검색: cross_search(query='${nm}', sources='nrich')`);
            let left = 40;
            const blocks = keys.map((k) => { const e = P[k]; const tot = Object.values(e.r).reduce((a, v) => a + v.length, 0);
              return `■ ${k} — ${tot}건 (` + Object.entries(e.r).map(([r, v]) => `${r} ${v.length}`).join(' · ') + ')\n' + Object.entries(e.r).map(([r, v]) => v.slice(0, Math.max(0, Math.min(v.length, left))).map((x) => { left--; return `  - [${r}] ${x[1]}${x[2] ? ' · ' + x[2] : ''} → ${x[0]}`; }).join('\n')).filter(Boolean).join('\n'); });
            return text(`국립문화유산연구원 연구DB 인물 '${nm}' — ${keys.length}명(표기 기준)\n` + blocks.join('\n') + `\n※ 기록 판독: nedb_search(mode='nrich', query='<id>') · 동명이인 가능 — 한자 병기로 구분 · 서(書)에는 집자(옛 글씨를 모아 새김)가 포함될 수 있음 · 연대는 원 데이터 표기(피장자 시대·건립 시점 혼재 가능) — 생몰년과 대조 · 인물 색인 https://changgi.github.io/korea-archive-mcp/data/nrich/people.json(주 1회) · RiC-O(인물=rico:Person): data/nrich/export/<키>.jsonld`);
          }
          const dm = q.trim().match(new RegExp(`^(${NR_DS.join('|')})\\s*[:#]\\s*(\\S.*)$`));
          if (dm) { // 연구DB 기록 — 정적 색인 전체 필드(원 기관 상세 URL로 전문)
            const o = (await nrDb()).find((r) => r.id === `${dm[1]}:${dm[2]}`);
            if (!o && !/^\d+$/.test(dm[2])) { // 'ksm:광개토' = 데이터셋 안 키워드 검색(v2.16)
              const hit = await nrDbSearch(q.trim().slice(dm[1].length + 1).trim(), max_results, dm[1]);
              return text(`국립문화유산연구원 연구DB [${dm[1]}] '${q.trim().slice(dm[1].length + 1).trim()}' — ${hit.length}건\n` + (hit.map((r) => `- [${r.dn}] ${r.t}${r.a ? ' (' + r.a + ')' : ''}${r.d ? ' · ' + r.d : ''}${r.p ? ' · ' + r.p : ''} → ${r.id}`).join('\n') || '(0)') + `\n※ 기록 판독: nedb_search(mode='nrich', query='<id>')`);
            }
            if (!o) return text(`연구DB 기록 ${dm[1]}:${dm[2]} 미발견 — 색인(${NR_DB})은 주 1회 갱신. cross_search(sources='nrich')로 다시 찾으십시오.`);
            return text(`국립문화유산연구원 연구DB 판독 — [${o.dn}] ${o.t}${o.a ? ' · ' + o.a : ''}\n` + [o.d && `연대: ${o.d}`, o.p && `소재·소장: ${o.p}`].filter(Boolean).join(' · ') + '\n'
              + Object.entries(o.m || {}).map(([k, v]) => `${k}: ${v}`).join('\n') + (o.x ? `\n【해설(색인 150자)】\n${o.x}…` : '') + `\n원문 뷰어(전문·이미지): ${o.u || '—'}\n`
              + `※ 출처: 국립문화유산연구원 국가유산 지식이음 Open API(${o.dn}) — ${o.k ? '공공누리 ' + o.k : '이용조건 원문 확인'}. 정적 색인 주 1회 갱신(원 기관 요청 없음).`);
          }
          const qm = q.trim().match(/^보고서\s*[:：]\s*(.+)$/);
          const rp = await nrRepApi(qm ? qm[1] : q, qm ? max_results : Math.max(3, Math.ceil(max_results / 2))).catch(() => []);
          const ov = qm ? [] : await nrOvList(q).catch(() => []);
          return text(`국립문화유산연구원 국가유산 지식이음 '${qm ? qm[1] : q}' — 발간자료 ${rp.length}건${qm ? '' : ` · 국외문화유산 ${ov.length}건`}\n`
            + rp.map((r) => `- [발간자료] ${r.title} (${r.year}) · ${r.field} · ${r.kogl ? '공공누리 ' + r.kogl : ''} ${r.url}`).join('\n') + (rp.length ? '\n' : '')
            + ov.slice(0, max_results).map((r) => `- [국외문화유산] ${r.title} — ${r.nation} · ${r.holder} (${r.era}) ${r.url}`).join('\n')
            + await (async () => { if (qm) return ''; const db = await nrDbSearch(q, max_results).catch(() => []); return db.length ? `\n연구DB ${db.length}건:\n` + db.map((o) => `- [${o.dn}] ${o.t}${o.a ? ' (' + o.a + ')' : ''}${o.d ? ' · ' + o.d : ''}${o.p ? ' · ' + o.p : ''} → ${o.id}`).join('\n') : ''; })()
            + `\n※ 상세: nedb_search(mode='nrich', query=<상세 URL 또는 ov:번호·rep:번호·연구DB id(ksm:3 등)·'인물:이름'>) · 보고서만: query='보고서:키워드' · 포털 통합검색(브라우저): ${NR_B}/search.do · 국외소재문화유산 조사 현황: https://www.nrich.go.kr/kor/page.do?menuIdx=336`);
        } catch (e) { return text(`국립문화유산연구원 조회 실패(${String(e.message || e).slice(0, 60)}) — 브라우저 대체 경로: ${NR_B}/kor/index.do`); }
      }
      if (mode === 'okchf') { // v2.11 국외소재문화유산재단 — 상세 URL/'relic:ID' 판독(소장국가·소장처·관리번호·소장경위·시대·재질·크기·출판정보·설명·이미지), 그 밖은 키워드 목록
        try {
          const pm = q.match(/US_DF_PD\.do\S*?articleNo=(\d+)/) || q.trim().match(/^pub\s*[:#]\s*(\d+)$/);
          if (pm) { // 조사보고서 서지·목차
            const url = `${OK_PD}?mode=view&articleNo=${pm[1]}`;
            const h = (await cachedText('okP:' + pm[1], 24 * 3600e3, () => gtext(url, OK_UA), 'board-detail__tit')).replace(/<script[\s\S]*?<\/script>/g, ' ');
            const title = okText((h.match(/board-detail__tit">([\s\S]*?)<\/h5>/) || [])[1] || `pub:${pm[1]}`);
            const yr = okText((h.match(/발간연도 : <em>([^<]*)/) || [])[1] || '');
            const F = {}; for (const m of h.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) { const k = okText(m[1]); const v = okText(m[2]); if (k && v && !(k in F)) F[k] = v; }
            const toc = ((h.match(/<div class="fr-view">([\s\S]*?)<\/div>/) || [])[1] || '').split(/<\/p>/).map(okText).filter(Boolean);
            return text(`국외소재문화유산재단 조사보고서 판독 — ${title}\n` + [yr && `발간연도: ${yr}`, ...Object.entries(F).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join(' · ') + '\n'
              + (toc.length ? `【목차】\n${toc.join('\n').slice(0, 2500)}\n목차 지문(sha256-16): ${createHash('sha256').update(toc.join('|')).digest('hex').slice(0, 16)}\n` : '')
              + `원문 뷰어: ${url}\n※ 출처: 국외소재문화유산재단 발간자료 — 본문(전자책·PDF)은 재단 누리집 열람. 인용 시 보고서명·발간연도·쪽수 표기. robots 전체 Disallow(표시).`);
          }
          const qm = q.trim().match(/^보고서\s*[:：]\s*(.+)$/);
          if (qm) { const { items, total } = await okPubSearch(qm[1]);
            return text(`국외소재문화유산재단 조사보고서 '${qm[1]}'(제목+목차) — 전체 ${total || items.length}건\n` + (items.map((r) => `- ${r.title} ${r.url}`).join('\n') || '(0)') + `\n※ 서지·목차: nedb_search(mode='okchf', query=<보고서 URL>) · 전체 목록: ${OK_PD}`); }
          const um = q.match(/overseaschf\.or\.kr\/archive\/search\/(photo|category)\.do\S*?srSearchTy=(\w+)\S*?[?&]id=(\d+)/) || q.match(/overseaschf\.or\.kr\/archive\/search\/(photo|category)\.do\S*?[?&]id=(\d+)\S*?srSearchTy=(\w+)/);
          const im = q.trim().match(/^(relic|relic_gls|redemption)\s*[:#]\s*(\d+)$/);
          if (um || im) {
            const ty = im ? im[1] : (/srSearchTy=(\w+)/.exec(q) || [])[1] || 'relic'; const id = im ? im[2] : (/[?&]id=(\d+)/.exec(q) || [])[1];
            const page = ty === 'relic_gls' ? 'photo' : ty === 'redemption' ? 'search' : 'category';
            const url = `${OK_B}/archive/search/${page}.do?mode=view&srSearchTy=${ty}&id=${id}&iDivCd=${(/iDivCd=(\d+)/.exec(q) || [])[1] || ''}`;
            const h = (await cachedText('okD:' + ty + id, 24 * 3600e3, () => gtext(url, OK_UA), 'tit-cont')).replace(/<script[\s\S]*?<\/script>/g, ' ');
            const tm = h.match(/<div class="tit-cont">\s*<h2[^>]*>([\s\S]*?)<\/h2>/);
            const title = tm ? okText(tm[1].replace(/<span[^>]*>/g, ' · ').replace(/<\/span>/g, '')).replace(/(\s*·\s*)+/g, ' · ').replace(/\s*·\s*$/, '') : `${ty}:${id}`;
            const F = {}; for (const m of h.matchAll(/<(?:th|dt)[^>]*>([\s\S]*?)<\/(?:th|dt)>\s*<(?:td|dd)[^>]*>([\s\S]*?)<\/(?:td|dd)>/g)) { const k = okText(m[1]); const v = okText(m[2]); if (k && v && !(k in F)) F[k] = v; }
            const desc = (F['설명'] || '').replace(/\s*더보기\s*$/, ''); delete F['설명']; // 화면 버튼 글자 제거
            const imgs = [...new Set([...h.matchAll(/<img[^>]+src="(\/home\/data\/attach\/[^"]+)"/g)].map((m) => OK_B + m[1]))];
            const line = (ks) => ks.filter((k) => F[k]).map((k) => `${k}: ${F[k].slice(0, 160)}`).join(' · ');
            return text(`국외소재문화유산재단 아카이브 판독 — ${title}\n`
              + [line(['소장국가', '소장처', '소장처 관리번호']), line(['시대', '재질', '크기', '수량(점/책)', '촬영일', '촬영자', '촬영장소']), line(['소장경위']), line(['출판정보', '조사기관']),
                 line(Object.keys(F).filter((k) => !['소장국가', '소장처', '소장처 관리번호', '시대', '재질', '크기', '수량(점/책)', '촬영일', '촬영자', '촬영장소', '소장경위', '출판정보', '조사기관'].includes(k)).slice(0, 6))].filter(Boolean).join('\n') + '\n'
              + (desc ? `【설명】\n${desc.slice(0, 2500)}\n본문 지문(sha256-16): ${createHash('sha256').update(desc).digest('hex').slice(0, 16)} — 판독 시점 설명 전문 기준. 재판독 지문 불일치=원문 개정 발생.\n` : '')
              + (imgs.length ? `이미지 ${imgs.length}장(원 기관 썸네일): ${imgs.slice(0, 4).join(' · ')}${imgs.length > 4 ? ' …' : ''}\n` : '')
              + `원문 뷰어: ${url}\n`
              + '※ 출처: 국외소재문화유산재단 대국민 아카이브 — 소장기관과 공개 협의된 정보. 이미지·설명 게재는 재단·소장처 이용조건 확인 후(허가 전 링크만). robots.txt 전체 Disallow — 자동 대량수집 비허용 표시, 요청 시 1건 판독만.');
          }
          const { out, total } = okList(await gtext(`${OK_B}/archive/total-search.do?srSearchVal=${encodeURIComponent(q)}&pagerLimit=${max_results <= 10 ? 10 : max_results <= 20 ? 20 : 50}`, OK_UA));
          return text(`국외소재문화유산재단 아카이브 '${q}' — 전체 ${total || out.length}건 중 ${Math.min(out.length, max_results)}건 (유형 › 소장국가 › 소장처)\n`
            + (out.slice(0, max_results).map((r) => `- [${r.type}] ${r.title} — ${r.country} · ${r.holder} ${r.url}`).join('\n') || '(0)')
            + '\n※ 상세 판독: nedb_search(mode=\'okchf\', query=<상세 URL>) · 조사보고서: query=\'보고서:키워드\' · 전체 목록 브라우저: https://www.overseaschf.or.kr/archive/total-search.do · 발간 보고서: https://www.overseaschf.or.kr/okchf/data/US_DF_PD.do · robots 전체 Disallow(표시)');
        } catch (e) { return text(`국외소재문화유산재단 조회 실패(${String(e.message || e).slice(0, 60)}) — 브라우저 대체 경로: https://www.overseaschf.or.kr/archive/total-search.do?srSearchVal=${encodeURIComponent(q)}`); }
      }
      if (mode === 'un') { // UN 디지털도서관 — 키워드 목록 / recid·URL 판독(요약·주제·언어별 PDF)
        try {
          const UAH = { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' };
          const rm = q.match(/digitallibrary\.un\.org\/record\/(\d+)/) || q.match(/^(\d{4,9})$/);
          if (rm) {
            const recid = rm[1];
            // v2.66 공개 MARC XML 내보내기(/export/xm)가 1순위 — 기록 HTML은 봇 확인(202·빈 본문), recjson은 제목·날짜가 비어 판독이 공란이던 결함(실측 4132698)
            try {
              const x = await cachedText('unX:' + recid, 24 * 3600e3, () => gtext(`https://digitallibrary.un.org/record/${recid}/export/xm`, UAH), '<record');
              const df = (tag) => [...x.matchAll(new RegExp(`<datafield tag="${tag}"[^>]*>([\\s\\S]*?)<\\/datafield>`, 'g'))].map((m) => Object.fromEntries([...m[1].matchAll(/<subfield code="(.)">([\s\S]*?)<\/subfield>/g)].map((z) => [z[1], dclean(z[2])])));
              const t245 = df('245')[0] || {};
              const title = [t245.a, t245.b, t245.c].filter(Boolean).join(' ').replace(/\s*[:/]\s*$/, '').replace(/\s+([:/])/g, ' $1');
              if (title) {
                const sym = (df('191')[0] || {}).a || (df('791')[0] || {}).a || '';
                const date = (df('269')[0] || {}).a || (df('992')[0] || {}).a || (df('260')[0] || {}).c || '';
                const typ = { VOT: '표결 기록', RES: '결의', DOC: '문서', MTG: '회의록', SPE: '발언' }[(df('930')[0] || {}).a] || (df('930')[0] || {}).a || '';
                const agenda = df('991').map((z) => [z.a, z.c].filter(Boolean).join(' ')).filter(Boolean).slice(0, 3).join('; ');
                const rel = df('993').map((z) => z.a).filter(Boolean).slice(0, 6).join(', ');
                const subs = df('650').map((z) => z.a).filter(Boolean).slice(0, 8).join('; ');
                const abs = df('520').map((z) => z.a).filter(Boolean).join(' ');
                const files = df('856').map((z) => z.u).filter((u) => /^https?:/.test(u || ''));
                const en = files.find((u) => /-EN\.pdf$/i.test(u)) || '';
                return text(`UN 디지털도서관 판독 — ${title}\n`
                  + [sym && `문서기호: ${sym}`, typ && `유형: ${typ}`, date && `날짜: ${date}`].filter(Boolean).join(' · ') + '\n'
                  + (agenda ? `의제: ${agenda}\n` : '') + (rel ? `관련 문서: ${rel}\n` : '') + (subs ? `주제: ${subs}\n` : '')
                  + (abs ? `【요약】\n${abs.slice(0, 1500)}\n` : '')
                  + (en ? `영문 PDF: ${en}\n` : '') + (files.length > 1 ? `파일 ${files.length}종\n` : '')
                  + `레코드: https://digitallibrary.un.org/record/${recid}\n`
                  + '※ UN 공식문서 — 출처 표기 하에 인용 가능(문서기호 병기). 원 데이터: 기관 MARC XML(export/xm).');
              }
            } catch { /* MARC 실패 — recjson으로 */ }
            const d = JSON.parse(await cachedText('unD:' + recid, 24 * 3600e3,
              async () => JSON.stringify(await jget(`https://digitallibrary.un.org/search?p=recid%3A${recid}&of=recjson&rg=1`, UAH)), 'recid'));
            const r = Array.isArray(d) ? d[0] : null;
            if (!r) return text(`[recid ${recid}] 레코드 미발견 — record URL 또는 recid를 확인하십시오.`);
            const files = (r.files || []).filter((f) => f && f.url);
            const sym = ((files[0] || {}).full_name || '').replace(/-[A-Z]{2}\.pdf$/i, '').replace(/_/g, '/');
            const en = files.find((f) => /english/i.test(f.description || '') || /-EN\.pdf$/i.test(f.full_name || ''));
            const subs = (r.subject || []).map((s2) => s2.term).filter(Boolean).slice(0, 6).join(' · ');
            const abs = dclean(String((r.abstract || {}).summary || ''));
            return text(`UN 디지털도서관 판독 — ${sym || `recid ${recid}`}\n`
              + [(r.imprint || {}).date && `발행: ${(r.imprint || {}).date}`, subs && `주제: ${subs}`].filter(Boolean).join(' · ') + '\n'
              + (abs ? `【요약】\n${abs.slice(0, 1500)}\n본문 지문(sha256-16): ${createHash('sha256').update(abs).digest('hex').slice(0, 16)} — 판독 시점 요약 전문 기준. 재판독 지문 불일치=원문 개정 발생.\n` : '')
              + (en ? `영문 PDF: ${en.url}\n` : '') + (files.length > 1 ? `전체 언어판 ${files.length}종: ` + files.map((f) => f.description).filter(Boolean).join('·') + '\n' : '')
              + `레코드: https://digitallibrary.un.org/record/${recid}\n`
              + '※ UN 공식문서 — 출처 표기 하에 인용 가능(문서기호 병기). 결의·보고서 원문은 PDF 직링크로 분석 투입.');
          }
          const items = await COLLECT.un(q, Math.min(max_results, 10));
          if (!items.length) return text(`UN 디지털도서관 '${q}' — 0건. 영문 사건명·문서기호(S/RES/84 등)로 재시도하십시오.`);
          return text(`UN 디지털도서관 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title}${it.date ? ` (${it.date})` : ''}\n  ${it.url}`).join('\n')
            + '\n※ record URL(또는 recid 숫자)을 mode=un query로 재투입 → 요약·주제·언어별 PDF 직링크 판독.');
        } catch (e) { return text(`UN 디지털도서관 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://digitallibrary.un.org`); }
      }
      if (mode === 'jsg') { // 장서각 — 키워드 목록 / 청구기호·URL 서지+해제 전문 판독(서버 렌더 실측 2026-11-21)
        try {
          const du = q.match(/dataId=([^&\s#]+)/); // v1.96.6: 고문서(ANC_…)·기타 접두 dataId도 상세 판독
          const dm = du ? [0, decodeURIComponent(du[1].replace(/\+/g, '%2B'))] : (q.match(/^((?:JSG|ANC)_[\w.+-]+)$/) || q.match(/^([A-Z]\d+(?:-\d+)*(?:[A-Za-z]*\d*)?)$/));
          if (dm && !/\s/.test(q) && (/^[A-Z]{3}_/.test(dm[1]) || /^[A-Z]\d/.test(dm[1]))) {
            const did = /^[A-Z]{3}_/.test(dm[1]) ? dm[1] : 'JSG_' + dm[1];
            const b = await cachedText('jsgD:' + did, 24 * 3600e3, () => jsgText('https://jsg.aks.ac.kr/dir/view?dataId=' + encodeURIComponent(did)), '청구기호');
            const flat = dclean(b).replace(/&middot;/g, '·').replace(/\s*한국역대인물(?!정보)/g, ''); // v1.96.6: 인명 뒤 링크 라벨 제거
            const pick = (re2) => ((flat.match(re2) || [])[1] || '').trim();
            const name = pick(/자료명\(한글\)\s*([^·]{2,60}?)\s*·/) || pick(/자료명\s+(.{2,60}?)\s+(?:xml|저자)/);
            const ed = ['간행년\\(왕력\\)\\s*(.{3,60}?)\\s*간행년', '판사항\\s*(\\S{1,20})', '간략내용\\s*(.{6,200}?)\\s*MF'].map((r) => pick(new RegExp(r))); // v1.96.8: 의궤 간행·판본·요지
            const gx0 = [ed[0] && `간행: ${ed[0]}`, ed[1] && `판본: ${ed[1]}`, ed[2] && !flat.includes('해제내용') && `요지: ${ed[2]}`].filter(Boolean);
            const gx = [['소장', /소장정보\s+(.{4,90}?)\s+·/], ['집성', /집성정보\s+(.{4,90}?)\s+(?:·|형태사항)/], ['형태', /형태사항\s+(.{4,90}?)\s+\d{5}\s/], ['출판', /출판정보\s*:\s*(.{4,90}?)\s*\//]]
              .map(([k, re2]) => { const v = did.startsWith('ANC_') ? pick(re2) : ''; return v ? `${k}: ${v.replace(/\s*·\s*/g, ' · ').replace(/^[\s·]+|[\s·]+$/g, '')}` : ''; }).filter(Boolean); // 고문서 메타
            const callno = pick(/청구기호\s+(\S{2,20})/);
            const mf = pick(/MF번호\s+(?!유형분류)(\S{2,20})/).replace(/,$/, '');
            // 분류 3종은 연쇄 앵커로 — 단독 매칭은 내비게이션 필터 라벨과 혼동(실측)
            const cm = flat.match(/유형분류\s+(\S{2,20})\s+주제분류\s+(\S{2,30})\s+수집분류\s+(\S{2,30})/) || [];
            const cls = cm[1] || ''; const subj = cm[2] || '';
            const ih = flat.indexOf('해제내용'); const i0 = ih >= 0 ? ih + 4 : flat.indexOf('정의 '); // v1.96.8: 의궤(ARC_) 페이지는 '해제내용 … 【정의】' 형식
            let haeje = '';
            let jfp = '';
            if (i0 >= 0) {
              haeje = flat.slice(i0, i0 + 6000).split(/집필자|관련 멀티미디어|장서각 디지털아카이브 바로가기|13455 경기도/)[0].trim();
              jfp = createHash('sha256').update(haeje).digest('hex').slice(0, 16); // 판독 시점 해제 지문
              if (haeje.length > 4000) haeje = haeje.slice(0, 4000) + ` …(총 ${haeje.length}자 — 전문은 원문 링크)`;
            }
            if (!callno && !haeje) return text(`'${did}' — 상세 미발견 또는 구조 상이. 청구기호(K2-…)를 확인하거나 mode=jsg에 검색어를 넣으십시오.`);
            const { ent, uci } = jsgEntities(b);
            return text(`장서각 서지·해제 판독 — ${name || did}\n`
              + [callno && `청구기호 ${callno}`, mf && `MF ${mf}`, cls, subj].filter(Boolean).join(' · ') + '\n' + ([...gx0, ...gx].length ? [...gx0, ...gx].join('\n') + '\n' : '')
              + ent.map(([k, v]) => `${k}(장서각 태깅): ${v.join('; ')}\n`).join('')
              + (haeje ? `【해제】\n${haeje}\n` : '')
              + (jfp ? `본문 지문(sha256-16): ${jfp} — 판독 시점 해제 전문 기준. 재판독 지문 불일치=원문 개정 발생.\n` : '')
              + (uci.length ? `인물 전거(한국역대인물 UCI): ${uci.map(([n, u]) => `${n}=${u}`).join('; ')}\n` : '')
              + `원문·이미지: https://jsg.aks.ac.kr/dir/view?dataId=${encodeURIComponent(did)}\n`
              + (did.startsWith('ANC_') ? '※ 고문서 원문 이미지 이용 문의: 장서각 자료보존관리팀 031-730-8874 · 고문서자료관 원자료 병행 확인.\n' : '') + '※ 출처: 한국학중앙연구원 장서각 — 게재 시 출처 표기, 이미지 재이용은 기관 이용조건 준수. 해제 인용은 국역·해설(학술 인용 시 집필 해제임을 명기).');
          }
          const items = await COLLECT.jsg(q, Math.min(max_results, 10));
          if (!items.length) return text(`장서각 '${q}' — 0건. 서명·주제어(의궤·등록 등)로 재시도하십시오.`);
          return text(`장서각 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title}${it.id ? ` [${it.id}]` : ''}\n  ${it.url}`).join('\n')
            + '\n※ 청구기호(K2-… 등)나 상세 URL을 mode=jsg query로 재투입 → 서지·해제 전문 판독.');
        } catch (e) { return text(`장서각 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://jsg.aks.ac.kr`); }
      }
      if (mode === 'commons') { // 위키미디어 공용 — 키워드 목록 / File URL 판독(라이선스·원 소장처·설명)
        try {
          const UAH = { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' };
          let qd = q; try { if (/%[0-9A-F]{2}/i.test(q)) qd = decodeURIComponent(q); } catch { /* 그대로 */ } // v1.96.4: 'File%3A…' 인코딩 URL 허용
          const fm = qd.match(/^https?:\/\/commons\.wikimedia\.org\/wiki\/(File:.+)$/i) || qd.match(/^(File:.+)$/i);
          if (fm) {
            const title = decodeURIComponent(fm[1]).replace(/_/g, ' ');
            const d = JSON.parse(await cachedText('commonsD2:' + title, 24 * 3600e3, // v2.65 범주(숨김 제외)도 — Commons의 분류 체계 = 기록의 계층 맥락
              async () => JSON.stringify(await jget('https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo%7Ccategories&clshow=!hidden&cllimit=20&iiprop=url%7Cextmetadata%7Csize&format=json&titles=' + encodeURIComponent(title), UAH)), 'imageinfo'));
            const page = Object.values((d.query || {}).pages || {})[0] || {};
            const ii = (page.imageinfo || [{}])[0] || {};
            const em = ii.extmetadata || {};
            const g = (k) => dclean(String((em[k] || {}).value || ''));
            const lic = g('LicenseShortName');
            if (!ii.url && !lic) return text(`'${title}' — 파일 미발견 또는 메타 없음. File: 제목/URL을 확인하십시오.`);
            const jr = judgeRights('', '', lic); // KOGL(공공누리) 등 공용 판정 규칙 재사용
            const rights = /public domain/i.test(lic) ? 'A(퍼블릭 도메인 표기)' : /^cc/i.test(lic) ? `B(${lic} — 조건 준수 시 이용)` : jr[0] !== 'D' ? `${jr[0]}(${jr[1].replace('[자동초판] ', '')})` : `D('${lic || '미표기'}' — 확인 필요)`;
            let nline = ''; // v1.91: 파일명의 NARA 번호 → 카탈로그 원본 자동 대조(실재·계보·Use Restriction)
            const nm = title.match(/[-_ ]NARA[-_ ]+(\d{5,10})\.\w+$/i);
            if (nm) {
              const naid = nm[1], key = process.env.NARA_API_KEY;
              nline = `【NARA 원본 대조】 파일명 NAID ${naid} — ` + (key ? '조회 시간 초과 또는 실패, judge_rights(naid=' + naid + ')로 재확인\n' : '서버 키 없음, judge_rights(naid=' + naid + ')로 확인\n');
              if (key) await Promise.race([(async () => {
                try {
                  const raw = await cachedText('naid:' + naid, 24 * 3600e3, () => gtext(`https://catalog.archives.gov/api/v2/records/search?naId=${naid}&limit=1`, { Accept: 'application/json', 'x-api-key': key }), '"naId"');
                  const rec = (((((JSON.parse(raw).body || {}).hits || {}).hits) || [])[0] || { _source: {} })._source.record;
                  if (!rec || String(rec.naId) !== naid) { nline = `【NARA 원본 대조】 NAID ${naid} — 카탈로그에 없음(파일명 번호 오기 가능) → 업로더 라이선스만으로 게재 판단 금지\n`; return; }
                  const ur = rec.useRestriction || {};
                  const urs = typeof ur === 'string' ? ur : [ur.status, ur.note, (ur.specificUseRestrictions || []).join('/')].filter(Boolean).join(' · ');
                  const cls = /unrestricted/i.test(urs) && !/restricted\s*[-–]|possibly|fully restricted/i.test(urs) ? 'A(제한 없음 실확인)' : /restricted/i.test(urs) ? 'C(제한 표기 — 기관 확인 필요)' : '판정 보류(Use Restriction 미기재)';
                  nline = `【NARA 원본 대조】 NAID ${naid} 원본 실재 확인 — ${norm(rec.title || '').slice(0, 110)}\n`
                    + `  계보: ${naraChain(rec) || '—'} · 생산: ${naraDate(rec) || '—'} · 소장 번호: ${rec.localIdentifier || '—'}\n`
                    + `  Use Restriction '${urs || '미기재'}' → ${cls} · https://catalog.archives.gov/id/${naid}\n`;
                } catch { /* 실패 — 기본 안내 유지 */ }
              })(), sleep(6000)]);
            }
            return text(`위키미디어 공용 파일 판독 — ${title.replace(/^File:/, '')}\n`
              + [g('DateTimeOriginal') && `촬영/제작: ${g('DateTimeOriginal').slice(0, 40)}`, g('Artist') && `작가: ${g('Artist').slice(0, 70)}`, ii.width && `원본 ${ii.width}×${ii.height}`].filter(Boolean).join(' · ') + '\n'
              + `라이선스: ${lic || '(미표기)'} → 권리 초판정 ${rights}\n`
              + (g('Credit') ? `출처(원 소장처): ${g('Credit').slice(0, 160)}\n` : '')
              + ((page.categories || []).length ? `범주(Commons): ${page.categories.map((c) => String(c.title || '').replace(/^Category:/, '')).slice(0, 12).join('; ')}\n` : '')
              + (g('ImageDescription') ? `【설명】\n${g('ImageDescription').slice(0, 1200)}\n` : '')
              + nline
              + (ii.url ? `원본 이미지: ${String(ii.url).split('?')[0]}\n` : '') + `파일 페이지: https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}\n`
              + '※ 라이선스는 업로더 기재 — 게재 전 원 소장처(NH·NARA 번호 등) 카탈로그와 교차검증(nara_search·judge_rights).');
          }
          const items = await COLLECT.commons(q, Math.min(max_results, 10));
          if (!items.length) return text(`위키미디어 공용 '${q}' — 0건. 영문 지명·사건명으로 재시도하십시오.`);
          return text(`위키미디어 공용 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title}\n  ${it.url}`).join('\n')
            + '\n※ 파일 URL(또는 File:제목)을 mode=commons query로 재투입 → 라이선스·원 소장처·설명 판독.');
        } catch (e) { return text(`위키미디어 공용 오류(${String(e && e.message || e).slice(0, 60)}) — 공유 IP 요청 제한(429)일 수 있음. 잠시 후 재시도 또는 브라우저: https://commons.wikimedia.org`); }
      }
      if (mode === 'earchive') { // 국편 전자사료관 — 키워드 목록 / '키워드|순번' 세션 상세(검색 폼+searchPosition 재제출 — 2026-11-21 역공학)
        try {
          // v2.35 고정 상세 — catalogView.do?systemId= URL 또는 12자리 systemId(GET, 세션 불필요). 기관 계층(사료군 › 사료계열 › 하위사료계열)·생산·소장·주제어·해제
          const smm = q.match(/catalogView\.do\?systemId=(\d{6,})/) || q.match(/^(\d{12})$/);
          if (smm) {
            const u = `https://archive.history.go.kr/record/catalog/catalogView.do?systemId=${smm[1]}`;
            const b = await cachedText('eaD:' + smm[1], 24 * 3600e3, () => gtext(u), 'info-box');
            const title = dclean(((b.match(/<div class="info-box">\s*<div>\s*<p>([\s\S]*?)<\/p>/) || [])[1] || ''));
            const rowVal = (name) => dclean((b.match(new RegExp(`<div class="label">${name.replace(/[()]/g, '\\$&')}<\\/div>\\s*<div class="value">\\s*<p>([\\s\\S]*?)<\\/p>`)) || [])[1] || '').replace(/\s+/g, ' ').trim();
            const hist = [...((b.match(/<ul class="history-box">([\s\S]*?)<div class="info-box">/) || [])[1] || '').matchAll(/title="([^"]{2,160})"[\s\S]*?<span class="type">([^<]{2,40})<\/span>/g)].map((m) => `${dclean(m[2])} ${dclean(m[1])}`.slice(0, 120));
            const sid = (b.match(/사료건(?:&nbsp;|\s)*([0-9A-Za-z_]{6,})/) || [])[1] || '';
            if (!title) return text(`전자사료관 systemId ${smm[1]} 상세 파싱 실패 — 브라우저로 열람: ${u}`);
            const F = ['생산자', '생산기간', '문서번호', '소장자(처)', '사료구분', '사료유형', '언어', '취급지명', '주제어'].map((k) => [k, rowVal(k)]).filter(([, v]) => v);
            const ab = rowVal('해제'); const acc = rowVal('열람조건'); const use = rowVal('이용조건');
            return text(`국편 전자사료관 상세 — ${title}\n`
              + [sid && `사료건 ${sid}`, `systemId ${smm[1]}`].filter(Boolean).join(' · ') + '\n'
              + (hist.length ? `계층: 국사편찬위원회 전자사료관 › ${hist.join(' › ')}\n` : '')
              + F.map(([k, v]) => `${k}: ${v.slice(0, 160)}`).join('\n') + (F.length ? '\n' : '')
              + (acc ? `열람조건: ${acc}\n` : '') + (use ? `이용조건: ${use}\n` : '')
              + (ab ? `【해제】\n${ab.slice(0, 1200)}\n` : '') + `원문: ${u}\n`
              + '※ 출처: 국사편찬위원회 전자사료관. 이용조건 문구를 judge_rights에 투입해 초판정. 해외 수집 사료는 원 소장처(NARA 등) 권리 확인 병행.');
          }
          const pm = q.match(/^(.+)\|(\d{1,3})$/);
          if (pm) {
            const kw = pm[1].trim(); const pos = pm[2];
            const form = (extra) => new URLSearchParams({ allSearchQuery: kw, searchQuery: kw, searchPageIndex: '1', searchPageUnit: '10', searchPageSize: '10', ...extra });
            const hdr = { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' };
            const r1 = await fetch('https://archive.history.go.kr/search/searchResult.do', { method: 'POST', headers: hdr, body: form({}), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
            const ck = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') || '']).map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
            const r2 = await fetch('https://archive.history.go.kr/record/catalog/catalogView.do', { method: 'POST', headers: { ...hdr, Cookie: ck, Referer: 'https://archive.history.go.kr/search/searchResult.do' }, body: form({ searchPosition: pos }), signal: AbortSignal.timeout(FETCH_TIMEOUT) });
            const b = await r2.text();
            const title = dclean(((b.match(/<div class="info-box">\s*<div>\s*<p>([\s\S]*?)<\/p>/) || [])[1] || ''));
            // 메타는 row-box(label/value) 앵커로 — 평문 매칭은 내비게이션 '열람·이용조건' 메뉴와 혼동(실측)
            const rowVal = (name) => dclean((b.match(new RegExp(`<div class="label">${name}<\\/div>\\s*<div class="value">\\s*<p>([\\s\\S]*?)<\\/p>`)) || [])[1] || '');
            const sid = (b.match(/사료건(?:&nbsp;|\s)*([0-9A-Za-z_]{6,})/) || [])[1] || '';
            const series = (dclean(b).match(/사료계열\s+([0-9A-Za-z_]{5,24})/) || [])[1] || '';
            const acc = rowVal('열람조건');
            const use = rowVal('이용조건');
            const reg = (b.match(/<th scope="col">등록번호<\/th>\s*<th scope="col">청구기호<\/th>\s*<\/tr>\s*<tr>\s*<td>\s*([0-9A-Za-z]*)\s*<\/td>\s*<td>\s*([\s\S]*?)\s*<\/td>/) || []);
            if (!title) return text(`'${kw}' ${pos}번 상세 파싱 실패 — 순번 범위(0~9, 페이지1 기준)와 키워드를 확인하십시오.`);
            return text(`국편 전자사료관 상세 [${kw} · ${pos}번] ${title}\n`
              + [sid && `사료건 ${sid}`, series && `사료계열 ${series}`, reg[1] && `등록번호 ${reg[1]}`, reg[2] && dclean(reg[2]) && `청구기호 ${dclean(reg[2])}`].filter(Boolean).join(' · ') + '\n'
              + (acc ? `열람조건: ${acc}\n` : '') + (use ? `이용조건: ${use}\n` : '')
              + '원문 열람: https://archive.history.go.kr 에서 사료ID·청구기호로 재검색\n'
              + '※ 출처: 국사편찬위원회 전자사료관. 이용조건 문구를 judge_rights(archive 필드)에 투입해 초판정. 해외 수집 사료는 원 소장처(NARA 등) 권리 확인 병행.');
          }
          const items = await COLLECT.earchive(q, Math.min(max_results, 10));
          if (!items.length) return text(`국편 전자사료관 '${q}' — 0건. 다른 표기·주제어로 재시도하십시오.`);
          return text(`국편 전자사료관 '${q}' — ${items.length}건:\n` + items.map((it, i) => `- [${i}] ${it.title}${it.id ? ` (${it.id})` : ''}`).join('\n')
            + `\n※ '${q}|순번'을 mode=earchive query로 재투입 → 상세 판독(열람·이용조건·청구기호). 순번은 위 대괄호(페이지1 기준 0~9).`);
        } catch (e) { return text(`국편 전자사료관 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://archive.history.go.kr`); }
      }
      if (mode === 'ktv') { // KTV e영상역사관 — 키워드 목록 / ehistory view URL 판독(대한뉴스·기록영상 해설, KOGL)
        try {
          if (/^https?:\/\/www\.ehistory\.go\.kr\/view\//.test(q)) { // 상세 판독 — ehistory 도메인 한정(임의 URL 페치 방지)
            const b = await cachedText('ktvD:' + q, 24 * 3600e3, () => gtext(q), 'board_header');
            const pick = (re2) => dclean((b.match(re2) || [])[1] || '');
            const title = pick(/board_header[\s\S]*?<h4>\s*<strong>([\s\S]*?)<\/strong>/);
            const pdate = pick(/<p class="date">[\s\S]*?<\/strong>([\s\S]*?)<\/p>/);
            const ptime = pick(/<p class="time">[\s\S]*?<\/strong>([\s\S]*?)<\/p>/);
            const origin = pick(/<p class="origin">[\s\S]*?<\/strong>([\s\S]*?)<\/p>/);
            const raw = (b.match(/<div class="txt">([\s\S]*?)<\/div>/) || [])[1] || '';
            let body = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
              .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
            if (!title && !body) return text(`판독 실패 — 영상 상세 구조 상이. 브라우저로 열람: ${q}`);
            const kfp = body ? createHash('sha256').update(body).digest('hex').slice(0, 16) : ''; // 판독 시점 해설 지문
            if (body.length > 4000) body = body.slice(0, 4000) + ` …(총 ${body.length}자 — 전문은 원문 링크)`;
            const isPhoto = /\/view\/photo\?/.test(q); // v1.96.4: 사진 상세 — 라벨·공공누리 유형·이미지 경로
            const kogl = (b.match(/공공누리\s*(?:제\s*)?([1-4])\s*유형/) || [])[1] || '';
            const pimg = [...new Set([...b.matchAll(/((?:https?:\/\/[^"'\s]+)?\/(?:movie_pds|photo_pds)\/[^"'\s<>]+?\.(?:jpe?g|png|gif))/gi)].map((m) => m[1]))].slice(0, 3).map((u) => (u.startsWith('http') ? u : 'https://www.ehistory.go.kr' + u));
            if (isPhoto) return text(`KTV e영상역사관 사진 판독 — ${title || '(제목 미상)'}\n`
              + [pdate && `촬영/제작: ${pdate}`, origin && `출처: ${origin}`, kogl && `공공누리 제${kogl}유형${kogl === '4' ? '(출처표시·상업금지·변경금지 — 자르지 말고 원형 게재)' : ''}`].filter(Boolean).join(' · ') + '\n'
              + (body ? `【설명】\n${body}\n` : '') + (pimg.length ? `원본 이미지: ${pimg.join(' · ')}\n` : '') + `원문(사진): ${q}\n`
              + (kogl ? `※ judge_rights(archive='KOGL ${kogl}')로 초판정.` : '※ 페이지에 공공누리 표시 미검출 — 이용 전 KTV 확인.'));
            return text(`KTV e영상역사관 영상 판독 — ${title || '(제목 미상)'}${kogl ? ` [공공누리 제${kogl}유형]` : ''}\n`
              + [pdate && `제작연도: ${pdate}`, ptime && `상영시간: ${ptime}`, origin && `출처: ${origin}`].filter(Boolean).join(' · ') + '\n'
              + (body ? `【해설】\n${body}\n` : '')
              + (kfp ? `본문 지문(sha256-16): ${kfp} — 판독 시점 해설 전문 기준. 재판독 지문 불일치=원문 개정 발생.\n` : '')
              + `원문(영상 재생): ${q}\n`
              + '※ 권리: 페이지의 공공누리 표시를 확인 — 사진은 표시 유형대로(제4유형=변경·상업 금지), 영상 페이지에 표시가 없으면 KTV 나누리(nanuri.ktv.go.kr) 이용 신청 후 사용(2026-11 실측: 「대한뉴스의 발자취」 영상 무표시). 표시 유형을 judge_rights에 넣어 초판정.');
          }
          const items = await COLLECT.ktv(q, Math.min(max_results, 10));
          if (!items.length) return text(`KTV e영상역사관 '${q}' — 0건. '대한뉴스'·사건명·인명으로 재시도하십시오.\n${uaRefusedNote('ktv', q)}`);
          return text(`KTV e영상역사관 '${q}' — ${items.length}건:\n` + items.map((it) => `- [${it.series || 'e영상역사관'}] ${it.title}${it.date ? ` (${it.date})` : ''}${it.desc ? `\n  요지: ${it.desc}` : ''}\n  ${it.url}`).join('\n')
            + '\n※ 기록 탭(대한뉴스·문화영화·미공개 대한뉴스·정부기록사진집·국가기록사진) 교차 병합 — 사이트 기본 최신순이 최근 영상만 올리는 문제 보정.\n※ view URL을 mode=ktv query로 재투입 → 영상 해설·제작연도·상영시간 판독.');
        } catch (e) { return text(`KTV 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://www.ehistory.go.kr`); }
      }
      if (mode === 'i815') { // 독립기념관 — 키워드 목록 / detail.do URL 본문 판독(당대 신문기사·독립운동가 자료)
        try {
          if (/^사전\s*[:：]/.test(q)) { // 한국독립운동인명사전 — v1.56 복구 합류(retry-blocked 주간 재점검 실측으로 감지)
            const t = q.replace(/^사전\s*[:：]/, '').trim();
            const noScript = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, '');
            if (/^\d+$/.test(t)) { // 상세 — 기본정보(생몰·본관·이명·훈격) + 전기 본문
              const du = `https://search.i815.or.kr/dictionary/detail.do?searchWord=&reSearchWord=&searchType=all&index=&id=${t}`;
              const b = await cachedText('i815W:' + t, 24 * 3600e3, () => gtext(du), '기본정보');
              const flat = dclean(noScript(b));
              const ix = flat.indexOf('기본정보');
              if (ix < 0) return text(`인명사전 상세 실패(id=${t}) — '사전:이름' 검색으로 번호를 다시 확보하십시오. 브라우저: ${du}`);
              const seg = flat.slice(ix);
              const hm = seg.match(/^기본정보\s*([\s\S]{0,600}?포상훈격\(연도\)\s*\S+)\s/);
              const head = hm ? hm[1] : seg.slice(0, 350);
              let bio = seg.slice((hm ? hm[0] : head).length).trim();
              const cut = bio.search(/참고문헌|저작권 안내/);
              if (cut > 0) bio = bio.slice(0, cut).trim();
              const fp = createHash('sha256').update(head + '\n' + bio).digest('hex').slice(0, 16); // 판독 시점 본문 지문(고정성)
              if (bio.length > 3200) bio = bio.slice(0, 3200) + ` …(전기 총 ${bio.length}자 — 전문은 원문)`;
              return text(`독립기념관 한국독립운동인명사전 — 항목 ${t}\n【기본정보】 ${head}\n【전기】\n${bio}\n원문: ${du}\n`
                + `본문 지문(sha256-16): ${fp} — 판독 시점 전문(기본정보+전기) 기준. 재판독 지문 불일치=원문 개정 발생(인용 검증용).\n`
                + "※ 공공저작물 — 출처 표기(독립기념관 한국독립운동인명사전) 시 이용 가능. 이명·한자명은 gonghun·jacar·oldnews('본문:이명') 재검색에 투입.");
            }
            const b = await gtext('https://search.i815.or.kr/dictionary/searchResult.do?searchType=all&searchWord=' + encodeURIComponent(t));
            const rows = [];
            for (const blk of noScript(b).split('thumb_txt_case01').slice(1, 1 + Math.min(max_results, 15))) {
              const id = (blk.match(/goDetail\((\d+)\)/) || [])[1];
              const tt = blk.match(/dict_txt_title[^>]*>([\s\S]*?)<\/strong>/);
              if (!id || !tt) continue;
              const line = dclean(blk);
              const ser = (line.match(/운동계열:\s*([\s\S]{1,40}?)\s*관련단체:/) || [])[1];
              const act = (line.match(/주요활동:\s*([\s\S]{1,130}?)\s*본문내용:/) || [])[1];
              rows.push(`- [${id}] ${dclean(tt[1])}${ser ? ' · ' + ser.trim() : ''}${act ? `\n  ${act.trim()}` : ''}`);
            }
            if (!rows.length) return text(`인명사전 '${t}' — 0건. 한자명·이명으로 재시도(이명은 mode=gonghun이 제공).`);
            return text(`한국독립운동인명사전 '${t}' — ${rows.length}건:\n` + rows.join('\n')
              + "\n※ '사전:번호' 재투입 → 기본정보(생몰·본관·이명·포상훈격)+전기 전문 판독. 공공저작물(출처 표기).");
          }
          if (/^https?:\/\/search\.i815\.or\.kr\//.test(q)) { // 상세 판독 — i815 도메인 한정(임의 URL 페치 방지)
            const b = await cachedText('i815D:' + q, 24 * 3600e3, () => gtext(q), 'explain');
            const paras = [...b.matchAll(/<(?:strong|p)[^>]*class="explain[^"]*"[^>]*>([\s\S]*?)<\/(?:strong|p)>/g)]
              .map((m) => dclean(m[1])).filter(Boolean);
            if (!paras.length) return text(`판독 실패 — 본문(explain) 없음(목록형 상세 또는 구조 상이). 브라우저로 열람: ${q}`);
            const flat = dclean(b);
            const np = flat.match(/신문명\s+(.{1,40}?)\s+발행일\s+([\d.\-]+)/);
            const prod = flat.match(/생산정보\s+(\S.{0,60}?)\s+(?:기사제목|자료명|자료내용)/);
            let body = paras.join('\n');
            if (body.length > 4000) body = body.slice(0, 4000) + ` …(총 ${body.length}자 — 전문은 원문 링크)`;
            return text('독립기념관 자료 판독\n'
              + (np ? `신문명: ${np[1]} · 발행일: ${np[2]}\n` : '') + (prod ? `생산정보: ${prod[1]}\n` : '')
              + `【자료내용】\n${body}\n원문: ${q}\n`
              + '※ 출처: 독립기념관 한국독립운동정보시스템 — 게재 시 출처 표기. 원문이미지는 페이지 뷰어에서. 권리 초판정: judge_rights.');
          }
          const items = await COLLECT.i815(q, Math.min(max_results, 10));
          if (!items.length) return text(`독립기념관 '${q}' — 0건. 인명·사건명·부대명 등으로 재시도하거나 cross_search(variants)로 표기 변형을 팬아웃하십시오.`);
          return text(`독립기념관 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title}\n  ${it.url}`).join('\n')
            + "\n※ detail.do URL을 mode=i815 query로 재투입 → 자료 본문 판독. '사전:이름' → 한국독립운동인명사전(전기·생몰·훈격).");
        } catch (e) { return text(`독립기념관 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://search.i815.or.kr`); }
      }
      if (mode === 'gonghun') { // 공훈전자사료관 — 이름 목록 / mngNo 심층 판독(공적조서·공훈록 본문)
        try {
          const b64d = (s) => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; } };
          const strip = (s) => dclean(String(s || ''));
          if (/^종합\s*[:：]/.test(q)) { // 인물 종합 대조 — 레시피 ①의 도구화: 공훈록·인명사전·판결문 3채널 병렬(v1.57)
            const nm = q.replace(/^종합\s*[:：]/, '').trim();
            const dict = async () => {
              const b = await gtext('https://search.i815.or.kr/dictionary/searchResult.do?searchType=all&searchWord=' + encodeURIComponent(nm));
              const rows = [];
              for (const blk of b.replace(/<script[\s\S]*?<\/script>/gi, '').split('thumb_txt_case01').slice(1, 4)) {
                const id = (blk.match(/goDetail\((\d+)\)/) || [])[1];
                const tt = blk.match(/dict_txt_title[^>]*>([\s\S]*?)<\/strong>/);
                if (!id || !tt) continue;
                const ser = (dclean(blk).match(/운동계열:\s*([\s\S]{1,40}?)\s*관련단체:/) || [])[1];
                rows.push(`- [사전:${id}] ${dclean(tt[1])}${ser ? ' · ' + ser.trim() : ''}`);
              }
              return rows;
            };
            const why = (r) => r.status === 'rejected' ? String(r.reason && r.reason.message || r.reason).slice(0, 40) : '';
            const [g, d, j, k] = await Promise.allSettled([COLLECT.gonghun(nm, 3), dict(), COLLECT.indy(nm, 3), nrPeople().then((P) => nrPeopleLines(P, nrPeopleKeys(P, nm), 3))]);
            const gv = g.status === 'fulfilled' ? g.value.map((it) => `- [mngNo ${it.id}] ${it.title}`) : [];
            const dv = d.status === 'fulfilled' ? d.value : [];
            const jv = j.status === 'fulfilled' ? j.value.map((it) => `- ${it.title} (${it.date})\n  ${it.url}`) : [];
            const kv = k.status === 'fulfilled' ? k.value : [];
            const sec = (t, lines, e) => `【${t}】\n` + (lines.length ? lines.join('\n') : `(0건${e ? ` — 오류: ${e}` : ''})`);
            return text(`인물 종합 대조 '${nm}' — 공훈록·인명사전·판결문·연구원 인물 색인 4채널 병렬:\n`
              + sec('공훈전자사료관(국가보훈부) — 공적·훈격', gv, why(g)) + '\n'
              + sec('한국독립운동인명사전(독립기념관) — 학술 전기', dv, why(d)) + '\n'
              + sec('독립운동판결문(국가기록원) — 죄명·주문', jv, why(j)) + '\n'
              + sec('국립문화유산연구원 연구DB 인물 — 금석문 찬·서 · 초상화 · 괘불 화승 · 일기 저자(연대=원 데이터 표기, 생몰년과 대조)', kv, why(k)) + '\n'
              + "※ 심층: mngNo 숫자 재투입=공적조서·공훈록·수형기록 · mode=i815 '사전:번호'=전기 전문 · mode=indy 상세URL=주문·사건개요·원문 뷰어 · mode=nrich '인물:이름'=연구원 인물 전체·'ksm:번호' 등=기록 판독.\n"
              + "※ 대조 포인트: 한자명·생몰 일치로 동명이인 분리 → 훈격(공훈)↔전기(사전)↔형량(판결문) 정합 → 이명 확보 후 oldnews '본문:이명'으로 당대 신문 확장.");
          }
          if (/^\d+$/.test(q)) { // mngNo 상세
            const b = await cachedText('gonghunD:' + q, 24 * 3600e3,
              () => gtext(`https://e-gonghun.mpva.go.kr/user/ContribuReportDetail.do?goTocode=20001&mngNo=${q}&pageTitle=Report`), 'achivement_1');
            const pick = (re2) => (b.match(re2) || [])[1] || '';
            const name = b64d(pick(/utf8_decode\('([A-Za-z0-9+/=]+)',\s*'#namekoDiv'/));
            const hanja = strip(pick(/<th>한자<\/th>\s*<td>([\s\S]*?)<\/td>/));
            const alias = strip(pick(/<th>이명<\/th>\s*<td>([\s\S]*?)<\/td>/));
            const birth = b64d(pick(/utf8_decode\('([A-Za-z0-9+/=]*)',\s*'#birthdayenm'/));
            const death = b64d(pick(/utf8_decode\('([A-Za-z0-9+/=]*)',\s*'#deathdatenm'/));
            const bon = [...b.matchAll(/utf8_decode\('([A-Za-z0-9+/=]+)',\s*'#famp\d'/g)].map((m) => b64d(m[1])).filter(Boolean).join(' ');
            const flat = strip(b);
            const aw = flat.match(/포상년도\s*([\d/]+)\s*훈격\s*(\S{1,30})/);
            const summary = strip(pick(/id="achivement_1"[^>]*>([\s\S]*?)<\/div>/));
            const i2 = b.indexOf('id="tab2"');
            let rok = '', rokInfo = '', gfp = '';
            if (i2 >= 0) {
              const seg = strip(b.slice(b.indexOf('>', i2) + 1, i2 + 30000));
              rokInfo = (seg.match(/수록정보[:\s]*([^)]{3,40}\))/) || [])[1] || '';
              let body = seg.replace(/^[\s\S]{0,80}?수록정보[:\s]*[^)]{3,40}\)\s*/, '').trim();
              // 본문 경계: 게시판(감사의 글)·JS 찌꺼기 절단. 수형기록·묘소·현충시설 표는 분석 가치가 있어 유지
              body = body.split('감사의 글')[0].replace(/function\s+fn[\s\S]*$/, '').replace(/\$\{\w+\}/g, '').trim();
              rok = body.length > 4000 ? body.slice(0, 4000) + ` …(총 ${body.length}자 — 전문은 원문 링크)` : body;
              gfp = createHash('sha256').update((summary || '') + '\n' + body).digest('hex').slice(0, 16); // 판독 시점 본문 지문(고정성)
            }
            if (!name && !summary) return text(`[mngNo ${q}] 공훈전자사료관 상세 파싱 실패 — 관리번호를 확인하거나 mode=gonghun에 이름으로 검색하십시오.`);
            return text(`공훈전자사료관 독립유공자 [관리번호 ${q}] ${name}${hanja ? `(${hanja})` : ''}${alias ? ` — 이명: ${alias}` : ''}\n`
              + `생몰: ${birth || '?'} ~ ${death || '?'}${bon ? ` · 본적: ${bon}` : ''}${aw ? `\n포상: ${aw[1]} ${aw[2]}` : ''}\n`
              + `【공적개요(공적조서)】\n${summary || '(없음)'}\n`
              + (rok ? `【공훈록${rokInfo ? ` — ${rokInfo}` : ''}】\n${rok}\n` : '')
              + `원문: https://e-gonghun.mpva.go.kr/user/ContribuReportDetail.do?goTocode=20001&mngNo=${q}&pageTitle=Report\n`
              + (gfp ? `본문 지문(sha256-16): ${gfp} — 판독 시점 전문(공적조서+공훈록) 기준. 재판독 지문 불일치=원문 개정 발생(인용 검증용).\n` : '')
              + `※ 출처: 국가보훈부 공훈전자사료관 — 게재 시 출처 표기. 공적조서·공훈록은 원칙적 수정불가 원문(정부포상 결정·전문가 집필). 권리 초판정: judge_rights.`);
          }
          const items = await COLLECT.gonghun(q, Math.min(max_results, 10));
          if (!items.length) return text(`공훈전자사료관 '${q}' — 0건. 인명 검색 채널(독립유공자 공훈록)이므로 이름으로 검색하십시오. 이명·한자명도 시도 가치(예: 안응칠→안중근).`);
          return text(`공훈전자사료관 독립유공자 '${q}' — ${items.length}건:\n`
            + items.map((it) => `- [mngNo ${it.id}] ${it.title}\n  ${it.url}`).join('\n')
            + "\n※ mngNo 숫자를 mode=gonghun query로 재투입 → 공적조서·공훈록 본문 판독. '종합:이름' → 공훈록+인명사전+판결문 3채널 병렬 대조.");
        } catch (e) { return text(`공훈전자사료관 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://e-gonghun.mpva.go.kr/user/ContribuReportList.do?goTocode=20001`); }
      }
      if (mode === 'aks') {
        try {
          if (q.includes('/')) { // '분류ID/G002+AKS+...' — 문서 노드 페이지 목록(imgnode)
            const [fid, did] = q.split('/', 2);
            const exact = AKS_CAT.find((c) => c.id === fid); // 비표준 ID(공백 포함 4건) 포함 정확일치 우선
            const fm = fid.match(/^(L\d{6})(F\d{2,4})?$/);
            const col = exact || (fm && AKS_CAT.find((c) => c.id === fm[1]));
            if (!col) return text(`'${fid}' — 소장처 ID 불인식. mode=aks에 소장처명을 넣어 먼저 검색하십시오.`);
            const up = exact ? `${col.up}^${fid}` : [col.up, fm[1], ...aksChain(fm[1], fm[2] || '')].join('^');
            const j = JSON.parse(await gtext(`${AKS_BASE}/viewer/imgnode.do?itemId=book&gubun=booktree&depth=${up.split('^').length + 1}&upPath=${encodeURIComponent(up)}&dataId=${encodeURIComponent(did)}&itemType=`, AKS_UA));
            const items = j.imgItems || [];
            return text(`한국고문서자료관 문서 '${j.infoTitle || did}' — ${items.length}면${j.dataUCI ? ` · UCI ${j.dataUCI}` : ''}\n`
              + items.slice(0, 8).map((it, i) => `- ${i + 1}면: ${it.filename || ''}${it.thumb ? `\n  썸네일 ${AKS_BASE}${it.thumb}` : ''}`).join('\n')
              + (items.length > 8 ? `\n… 외 ${items.length - 8}면` : '')
              + `\n※ 원본 고해상 이미지 일괄 수집은 로컬 전용(aks-archive-harvester 스킬 — DZI 타일 복원). 웹에서는 뷰어 열람: ${AKS_BASE}/viewer/viewer.do`
              + `\n출처 표기: 한국학중앙연구원 한국고문서자료관. 이미지 재이용은 기관 이용조건 준수.`);
          }
          const exactCol = AKS_CAT.find((c) => c.id === q); // 비표준 ID 포함 정확일치 우선
          // 비표준 하위 분류('L0809  F0206' — 공백 포함, 카탈로그 밖): 부모 분류(F02)를 카탈로그에서 유도
          const nm = !exactCol && q.match(/^(L\d{4,6})(\s+)(F\d{4})$/);
          const nmParent = nm && AKS_CAT.find((c) => c.id === nm[1] + nm[2] + nm[3].slice(0, 3));
          const idm = exactCol || nmParent ? null : q.match(/^(L\d{6})(F\d{2,4})?$/);
          if (exactCol || nmParent || idm) { // 소장처/분류 노드 → 하위 트리 라이브 조회
            const col = exactCol || nmParent || AKS_CAT.find((c) => c.id === idm[1]);
            if (!col) return text(`'${q}' — 소장처 목록(172곳)에 없는 ID. mode=aks에 소장처명을 넣어 먼저 검색하십시오.`);
            const chain = (exactCol || nmParent) ? [] : aksChain(idm[1], idm[2] || '');
            const up = exactCol ? col.up : nmParent ? `${col.up}^${col.id}` : [col.up, ...(idm[2] ? [idm[1], ...chain.slice(0, -1)] : [])].join('^');
            const aksUrl = `${AKS_BASE}/viewer/treeAjax.do?itemId=book&gubun=booktree&depth=${up.split('^').length + 1}&upPath=${encodeURIComponent(up)}&dataId=${encodeURIComponent(q)}&itemType=`;
            const b = await cachedText('aks:' + q, 6 * 3600e3, () => gtext(aksUrl, AKS_UA), 'data-dataId');
            const kids = [...b.matchAll(/data-dataId='([^']+)'[\s\S]{0,300}?<span(?:\s+class='([^']*)')?\s+title='([^']*)'/g)]
              .map((m) => ({ id: m[1], leaf: /nochild/.test(m[2] || ''), name: m[3] }));
            const lines = kids.slice(0, 25).map((k) => k.leaf
              ? `- [문서] ${k.name}\n  원문 고정 링크(UCI): ${AKS_BASE}/link.do?dataUCI=${k.id}\n  상세: mode=aks query='${q}/${k.id}'`
              : `- [분류 ${k.id}] ${k.name} → mode=aks query='${k.id}'`);
            return text(`한국고문서자료관 ${col.name} [${q}] 하위 ${kids.length}건:\n` + (lines.join('\n') || '(0건)')
              + (kids.length > 25 ? `\n… 외 ${kids.length - 25}건` : '')
              + `\n※ 이미지 일괄 수집=로컬 스킬(aks-archive-harvester), 웹 열람=뷰어 ${AKS_BASE}. 출처 표기: 한국학중앙연구원 한국고문서자료관.`);
          }
          const toks = q.split(/\s+/).filter(Boolean);
          const hits = toks.length ? AKS_CAT.filter((c) => toks.every((t) => (c.name + ' ' + c.grp).includes(t))) : [];
          return text(`한국고문서자료관 소장처 '${q}' — ${hits.length}/172곳:\n`
            + (hits.slice(0, 20).map((c) => `- [${c.id}] ${c.name} (${c.grp})`).join('\n') || '(0곳 — 지역명·성씨·호 등으로 재시도. 예: "송준길", "문중 충청")')
            + `\n※ 다음 단계: mode=aks query='L013001'(분류 목록) → query='L013001F02'(문서 목록) → query='분류ID/문서ID'(면·썸네일).`
            + `\n172곳 전수는 2026-11 실측 스냅숏 — 신규 소장처는 ${AKS_BASE}에서 확인.`);
        } catch (e) { return text(`한국고문서자료관 자동조회 실패(${e.message}) — 뷰어 직접 열람: ${AKS_BASE}/viewer/viewer.do (분류 트리에서 소장처 탐색)`); }
      }
      if (mode === 'jacar') { // 일본 아시아역사자료센터 — 검색·메타 직행·인접 채굴(±span×100 — 간격 100 실측)
        try {
          const jm = async (code) => {
            const h = await cachedText('jacarM:' + code, 24 * 3600e3, async () => {
              const r = await fetch('https://www.jacar.archives.go.jp/das/meta-en/' + code, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
              return r.ok ? r.text() : '';
            }, 'Reference Code');
            if (!h) return null;
            const g = (label) => { const m2 = h.match(new RegExp(label + '</(?:th|dt)>\\s*<(?:td|dd)[^>]*>\\s*(?:<[^>]+>\\s*)*([^<]{1,160})')); return m2 ? norm(m2[1]) : ''; };
            return { title: g('Title'), creator: g('Creator'), imgs: g('Number of Images'), org: g('Organisation History'), cls: g('Classification Levels') };
          };
          const cm = q.match(/^([A-Z])(\d{11})$/);
          if (cm) {
            const base = await jm(q);
            if (!base || !base.title) return text(`JACAR '${q}' — 해당 레퍼런스코드 없음.`);
            let out = `JACAR [${q}] ${base.title}\n생산: ${base.creator || '-'} | 이미지 ${base.imgs || '?'}면 | ${base.org || ''}${base.cls ? ' | ' + base.cls : ''}\n원문 뷰어: https://www.jacar.archives.go.jp/das/meta/${q}`;
            const sp = Math.min(span, 8);
            const n0 = parseInt(cm[2], 10); const lines = [];
            for (let k = -sp; k <= sp; k++) {
              if (!k) continue;
              const code = cm[1] + String(n0 + k * 100).padStart(11, '0');
              const m3 = await jm(code).catch(() => null);
              lines.push(m3 && m3.title ? `  ${code} | ${m3.title.slice(0, 80)}` : `  ${code} (없음)`);
              await sleep(250);
            }
            out += `\n\n[인접 채굴 ±${sp}×100 — 簿冊 내 건 번호 간격 100 실측(±1·±10은 404)]\n` + lines.join('\n');
            return text(out + '\n※ 출처 병기: 国立公文書館アジア歴史資料センター(JACAR), Ref. ' + q);
          }
          const eff = koToJa(q) || koToEn(q) || q;
          const b = await gtext('https://www.jacar.archives.go.jp/aj/search-en?kw=' + encodeURIComponent(eff));
          const rows = [];
          for (const blk of b.split('<li class="archive-result-table__body-item"').slice(1)) {
            const c = blk.match(/value="aj\d+\/([A-Z]\d{11})"/); const t = blk.match(/id="row-\d+-title"[\s\S]*?<span\s*>([^<]{3,150})/);
            if (c && t) rows.push(`- [${c[1]}] ${norm(t[1]).slice(0, 90)}\n  https://www.jacar.archives.go.jp/das/meta-en/${c[1]}`);
            if (rows.length >= max_results) break;
          }
          return text(`JACAR '${q}'${eff !== q ? ` → '${eff}'` : ''} — 이 페이지 ${rows.length}건:\n` + (rows.join('\n') || '(0건 — 일본어 원표기(한자) 병행 권장)')
            + '\n※ 레퍼런스코드(영문1+숫자11)를 query로 주면 메타 직행 + span 인접 채굴(±span×100). A=공문서관·B=외무성 외교사료관·C=방위연구소.');
        } catch (e) { return text(`JACAR 조회 실패(${e.message}) — https://www.jacar.archives.go.jp 직접 검색.`); }
      }
      try {
        if (mode === 'law') {
          const r = await jLawSearch(q, max_results);
          const lines = r.results.slice(0, max_results).map((x) => `- [${x.id}] ${x.source}${x.section ? ' ' + x.section : ''}\n  ${x.excerpt.slice(0, 150)}\n  ${jCite(x.id)}`);
          let out = `법전·편람 '${q}' — 총 ${jCnt(r.total)}:\n` + (lines.join('\n') || '(0건)');
          if (r.total < 0) out += `\n※ 결과 건수를 확인하지 못했습니다(응답 구조 변경 또는 끊김) — 부재로 단정하지 마십시오. 공식 검색: ${JDB}/search/law/searchResultList.do`;
          if (r.total === 0) out += `\n★ '${q}'는 법전에 수록되어 있지 않습니다(한국사DB '총 0건' 응답 — 확정 0). 법전 밖 관행일 가능성 — mode=record·sjw로 등록류·일기를 조회하십시오.`;
          else out += '\n※ 법전·편람은 한문 원문 제공 — 인용 가능(표점은 DB 형태·교감본 미대조). 조문을 열었으면 mode=sibling으로 형제 조를 반드시 확인.';
          return text(out);
        }
        if (mode === 'record') {
          const r = await jRecordSearch(q, Math.max(max_results, 50));
          const lines = r.real.slice(0, max_results).map((x) => `- [${x.id}] ${x.title.slice(0, 90)}\n  ${jCite(x.id)}`);
          let out = `등록류(비변사등록) '${q}' — 보고 총계 ${jCnt(r.total)} · 페이지 내 ${r.rows.length}건 중 座目 ${r.jwamok.length}건 제외 → 실질 ${r.real.length}건:\n` + (lines.join('\n') || '(실질 기사 0건)');
          if (r.jwamok.length) out += `\n★ ${Math.round(r.jwamok.length / Math.max(r.rows.length, 1) * 100)}%가 座目(회의 참석 명단)입니다. 검색 건수를 주제 중요도 지표로 쓰지 마십시오.`;
          out += '\n※ 등록류는 국역만 노출 — 한문 역구성은 학술 인용 불가.';
          return text(out);
        }
        if (mode === 'item') {
          const r = await jItemRead(q, 3000);
          if (r.status === 'ok') return text(`[${q}] ${r.title || ''}\n${(r.meta || []).length ? r.meta.map(([kk, v]) => `${kk}: ${v}`).join(' · ') + '\n' : ''}${r.body}\n(${r.chars}자) ${jCite(q)}\n※ ${r.isLaw ? '한문 원문 제공 — 인용 가능(표점 DB 형태)' : r.era && r.era !== 'joseon' ? `원문 수록(${r.era === 'contemp' ? '현대' : r.era === 'modern' ? '근대' : '고대'} 자료) — 출전을 병기해 인용` : (r.meta || []).length ? '원문 수록(등록류 장계 등) — 출전·발신일 병기 인용' : '국역만 제공 — 역구성 한문은 학술 인용 불가'}. 조문이면 mode=sibling으로 형제 조 확인.`);
          if (r.status === 'image_only') return text(`[${q}] ${r.title}\n${(r.meta || []).map(([kk, v]) => `${kk}: ${v}`).join(' · ')}\n본문 텍스트 없음 — 원문 이미지(지면)로만 제공됩니다(미공개 아님). 원문 열람: ${jCite(q)}`);
          if (r.status === 'not_published') return text(`[${q}] ${r.title}\n본문이 공개되지 않았습니다 — 항목은 존재하고 URL도 유효하나 공개 범위 문제입니다. 재시도로 해결되지 않으며 국사편찬위원회 문의 대상. ${jCite(q)}`);
          return text(`[${q}] 조회 실패(${r.status}${r.note ? ': ' + r.note : ''}) — levelId와 경로(jlaw*=item/level.do)를 확인하십시오.`);
        }
        if (mode === 'sibling') {
          const r = await jSibling(q, span);
          if (r.error) return text(r.error);
          const lines = r.sibs.map((s) => `${s.requested ? '●' : '○'} ${s.id} [${s.head}] ${s.chars}자 ${jCite(s.id)}`);
          let out = `형제 조 전수 스캔 ${q} (편: ${r.stem}):\n` + (lines.join('\n') || '(형제 조 미검출 — span 확대 재시도 가능)');
          if (r.others.length) out += `\n★ 요청한 조 외에 ${r.others.length}개가 더 있습니다: ${[...new Set(r.others.map((s) => '[' + s.head + ']'))].join(' ')} — 전부 확인하십시오. 총론만 읽고 끝내면 핵심을 놓칩니다.`;
          return text(out);
        }
        if (mode === 'matrix') {
          const terms = q.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
          const rows = [];
          for (let i = 0; i < terms.length; i += 3) {
            const rs = await Promise.all(terms.slice(i, i + 3).map(async (t) => {
              const r = await jLawSearch(t, 10).catch(() => ({ total: -1, results: [] }));
              const srcs = r.results.map((x) => x.source);
              const code = ['經國大典', '續大典', '大典通編', '大典會通', '受敎輯錄', '六典條例'].find((c) => srcs.some((s) => s.includes(c)));
              return { t, total: r.total, earliest: code || srcs[0] || '', inCode: !!code };
            }));
            rows.push(...rs);
            if (i + 3 < terms.length) await sleep(150);
          }
          rows.sort((a, b) => b.total - a.total);
          const absent = rows.filter((r) => r.total === 0 || (r.total > 0 && !r.inCode)); // v2.47 확인 불가(-1)는 부재가 아님
          const unknown = rows.filter((r) => r.total < 0);
          let out = '법전 수록 대조표:\n' + rows.map((r) => `- ${r.t}: ${jCnt(r.total)}${r.earliest ? ' (' + r.earliest + (r.inCode ? '' : ' — 법전 아님') + ')' : ''}${r.total === 0 ? ' — 법전 미수록' : r.total < 0 ? ' — 확인 불가(조회 실패)' : ''}`).join('\n');
          if (unknown.length) out += `\n※ ${unknown.map((r) => r.t).join('·')}: 결과 건수 확인 불가(조회 실패) — 부재로 단정하지 않습니다. 잠시 후 다시.`;
          if (absent.length) out += `\n★ ${absent.map((r) => r.t).join('·')}는 법전에 오르지 못했습니다. 제도사를 법전으로만 재구성하면 이 요소는 존재하지 않습니다 — 등록류·일기류를 함께 읽으십시오.`;
          return text(out);
        }
        if (mode === 'origin') {
          const [term, domain] = q.split(',').map((t) => t.trim());
          const r = await jLawSearch(term, 100);
          if (r.total === 0) return text(`'${term}'은 법전에 나타나지 않습니다 — 법전 밖 관행 용어일 수 있습니다. mode=record·sjw로 조회하십시오.`);
          const domains = {};
          for (const item of r.results) {
            const blob = item.section + ' ' + item.excerpt;
            for (const [dom, hints] of Object.entries(J_DOMAINS)) if (hints.some((h) => blob.includes(h))) domains[dom] = (domains[dom] || 0) + 1;
          }
          const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]);
          let out = `어휘 연원 '${term}' — 법전 ${jCnt(r.total)} · 영역 분포: ` + (sorted.map(([d, c]) => `${d} ${c}`).join(' · ') || '(판별 불가)');
          out += '\n대표 용례:\n' + r.results.slice(0, 4).map((x) => `- ${x.source} ${x.section} | ${x.excerpt.slice(0, 110)}`).join('\n');
          if (domain && !domains[domain]) out += `\n★ '${domain}' 영역 용례가 0건 — 이 용어는 주로 '${(sorted[0] || ['?'])[0]}' 영역에서 쓰였고 '${domain}'으로 전용된 것으로 보입니다. 전용 시점을 등록류·일기에서 확인하십시오.`;
          return text(out);
        }
        if (mode === 'sjw') {
          const r = await jSjw(q);
          let out = `승정원일기 '${q}' — 총 ${jCnt(r.total)}`;
          const dist = Object.entries(r.dist);
          if (dist.length) out += '\n왕대 분포: ' + dist.map(([k, v]) => `${k} ${v}`).join(' · ');
          if (r.earliest) out += `\n★ 최초 용례 ${r.earliest.year}년(${r.earliest.reign}) — 관련 기구·제도의 성립 연대와 대조하십시오. 용어가 기구보다 앞서면 그 기구는 제도를 만든 것이 아니라 인수한 것입니다.`;
          return text(out + `\n검색: ${JSJW}/search/searchResultList.do (POST)`);
        }
        if (mode === 'kyujanggak') {
          const r = await jKyu(q);
          const fmt = (v, rows) => !Array.isArray(v) ? `오류(${v.error})` : (rows && rows.length)
            ? `${Math.max(v.length, rows.length)}건\n` + rows.slice(0, 10).map((x) => `- [${x.call}] ${x.title} · ${x.author} · ${x.date} · ${x.cls}${x.body ? `\n  해제: ${x.body}…` : ''}`).join('\n')
            : `${v.length}건 — ${v.slice(0, 12).join(' ')}`;
          let out = `규장각 '${q}'\n목록: ${fmt(r['목록'], r['목록항목'])}\n해제: ${fmt(r['해제'], r['해제항목'])}`;
          if ([r['목록'], r['해제']].some((v) => !Array.isArray(v) && /403/.test(String(v && v.error)))) out += '\n' + uaRefusedNote('kyudb', q);
          const lc = Array.isArray(r['목록']) ? Math.max(r['목록'].length, (r['목록항목'] || []).length) : 0; const ac = Array.isArray(r['해제']) ? Math.max(r['해제'].length, (r['해제항목'] || []).length) : 0;
          if (ac > lc) out += '\n★ 해제 검색이 목록보다 많습니다 — 절목·사목류가 상위 서명 아래 편차(編次)로 들어가 있을 수 있습니다.';
          out += `
■ 원문 이미지 접근 지식(실측 2026-08-18) — GET·web_fetch 불가, ImageServlet 직접 URL은 브라우저에서 열림:
https://kyudb.snu.ac.kr/ImageServlet.do?imgFileNm=[파일명]&path=/data01/stream/[item_cd]/IMG/[book_cd]/[book_cd]_0001/
item_cd 5종(자료 성격별): ART 도설·회화 / ETC 두루마리·축 / DRR 등록류 / FND 재정·사목 / POL 정책·절목.
파일명 2형: 표준 [book_cd]_00_IH_0001_[nnn]a.jpg · POL계 [book_cd]_00IH_0001_[nnnn].jpg (밑줄 없음·4자리).
★반드시 첫 장 URL을 실제로 받아 패턴 확정 후 순회 — 추정 순회는 전부 실패한다(200 OK·0바이트 함정 포함). 게재는 소장기관 허가 확인(02-880-5316).`;
          return text(out);
        }
      } catch (e) { return text(`조선 심층 판독(${mode}) 실패: ${e.message} — 한국사DB 응답이 끊겨 결과 건수를 확인하지 못했습니다(POST·GET 모두 시도 — 0건으로 단정하지 않음). 잠시 후 재시도.`); }
      // mode=total — 기존 통합검색
      const browse = 'https://db.history.go.kr/search/searchResultList.do?searchKeywordType=BI&searchKeyword=' + encodeURIComponent(query);
      const idx = await loadNedbIndex();
      if (idx) {
        const hits = nedbFileSearch(idx, query, max_results);
        return text(`한국사DB(공식 개방파일 인덱스) '${query}' — ${hits.length}건:\n`
          + (hits.map((h) => `- [${h.id}] ${h.title.slice(0, 95)}${h.url ? ' ' + h.url : ''}`).join('\n') || '(0건 — 다른 표기(한자 원표기 등) 시도)')
          + `\n※ data.go.kr 공식 파일(KOGL) 기반 — robots 무관. 전체 통합검색(브라우저): ${browse}`);
      }
      try {
        const dbs = await nedbLive(query, 3); const hit = dbs.filter((d) => d.total > 0).sort((a, b) => b.total - a.total);
        if (hit.length) return text(`한국사DB '${query}' — 주요 ${NEDB_DBS.length}개 DB 직접 검색(시대별 하위 DB POST): 검색어가 나오는 DB ${hit.length}종\n`
          + hit.map((d) => `■ [${d.era}] ${d.name} — ${d.total.toLocaleString()}건\n` + d.rows.map((r) => `  - ${r.title.slice(0, 90)}${nedbDate(r.id) ? ' (' + nedbDate(r.id) + ')' : ''} → ${JDB}/id/${r.id}`).join('\n')).join('\n')
          + (dbs.some((d) => d.total < 0) ? `\n(조회 실패: ${dbs.filter((d) => d.total < 0).map((d) => d.name).join('·')})` : '')
          + `\n※ 인용은 db.history.go.kr/id/<levelId>(고정 URL). 비변사등록 座目 제외·형제 조: mode=record·sibling. 그 밖의 DB(실록·승정원일기 등 100여 종): 통합검색(브라우저) ${browse}`);
        const failed = dbs.filter((d) => d.total < 0), zero = dbs.filter((d) => d.total === 0);
        // v2.47 '0건'은 확정 0 DB만. 조회 실패가 섞이면 부재로 단정하지 않고 실패 DB를 밝힌다
        return text(agentBrowse('한국사DB', query, browse, failed.length
          ? `주요 DB 확정 0건 ${zero.length}종 · 조회 실패 ${failed.length}종(${failed.map((d) => d.name).join('·')}) — 부재로 단정하지 마십시오(응답 끊김·지연). 잠시 후 재시도`
          : '주요 DB 모두 확정 0건 — 한자 원표기·다른 표기로 재시도'));
      } catch (e) { return text(agentBrowse('한국사DB', query, browse, `자동조회 실패(${e.message})`)); }
    });

  server.tool('archives_search',
    "Search 국가기록원 국가기록포털 (archives.go.kr) via official OpenAPI (RSS). Set a free data.go.kr key '나라기록물정보 서비스'(15000153) as ARCHIVES_API_KEY and the server auto-searches; otherwise returns the portal URL. 공공누리 확인 후 이용.",
    { query: z.string(), max_results: z.number().int().min(1).max(50).default(10), year_from: z.number().int().optional().describe('생산연도 시작(후처리 필터) e.g. 1950'), year_to: z.number().int().optional().describe('생산연도 끝 e.g. 1960') },
    async ({ query, max_results, year_from, year_to }) => {
      const key = process.env.ARCHIVES_API_KEY;
      const portal = 'https://www.archives.go.kr/next/newsearch/listSubjectDescription.do?query=' + encodeURIComponent(query);
      if (!key) return text(agentBrowse('국가기록원', query, portal, "OpenAPI 키(ARCHIVES_API_KEY, data.go.kr 15000153) 미설정"));
      const sk = /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
      const yf = year_from || 0, yt = year_to || 9999, filt = !!(year_from || year_to);
      const api = `https://apis.data.go.kr/1741050/openapi/searcharc?serviceKey=${sk}&query=${encodeURIComponent(query)}&start=1&limit=${filt ? 50 : Math.min(max_results, 50)}`;
      try {
        const xml = await gtext(api);
        if (!xml.includes('searchError') && !xml.includes('<item>') && /<total>\s*0\s*<\/total>/.test(xml)) return text(`국가기록원 '${query}' — 0건(API 정상 응답). 띄어쓰기·다른 표기(예: '한일협정 조인', '한일회담')로 재검색하거나 포털: ${portal}`); // v1.96.4: 0건을 API 오류로 표기하던 문제
        if (xml.includes('searchError') || !xml.includes('<item>')) return text(agentBrowse('국가기록원', query, portal, `API 오류: ${xtag(xml, 'message') || '결과 없음'}`));
        const tot = xtag(xml, 'total') || '?';
        let items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        if (filt) items = items.filter((i) => { const y = parseInt((xtag(i, 'prod_year').match(/\d{4}/) || [])[0], 10); return y && y >= yf && y <= yt; });
        const lines = items.slice(0, max_results).map((i) => `- ${xtag(i, 'title').slice(0, 90)} (${xtag(i, 'prod_year')}) · ${xtag(i, 'prod_name').slice(0, 20)} [${xtag(i, 'is_open') === '1' ? '공개' : '비공개'}] ${archLink(xtag(i, 'link'))}`);
        return text(`국가기록원 '${query}'${filt ? ` [생산 ${year_from || ''}~${year_to || ''} · 상위 50건 내 후처리·연대 미상 제외]` : ''} — 총 ${tot}건${filt ? ` 중 연대 일치 ${items.length}건` : ''}:\n` + (lines.join('\n') || '(0건)') + '\n공공누리(KOGL) 유형 확인 후 이용. 비공개 항목은 정보공개청구 대상.');
      } catch (e) { return text(agentBrowse('국가기록원', query, portal, `API 오류(${e.message})`)); }
    });

  server.tool('nlk_search',
    "Search 국립중앙도서관 (nl.go.kr) collections. collection: total·subject·newspaper(1883-1960 old newspapers, free use)·gwanbo·exhibit·koreanmemory·overseas. With NLK_API_KEY the server auto-searches. category (자료유형: 도서·고문헌·학위논문·잡지/학술지·신문·기사·멀티미디어) runs a 2nd concurrent type-scoped channel merged with the full-catalog channel (상호보완 이중수집).",
    { query: z.string(), collection: z.enum(['total', 'subject', 'newspaper', 'gwanbo', 'exhibit', 'koreanmemory', 'overseas']).default('total'), category: z.enum(['도서', '고문헌', '학위논문', '잡지/학술지', '신문', '기사', '멀티미디어']).optional(), max_results: z.number().int().min(1).max(50).default(15), year_from: z.number().int().optional().describe('발행연도 시작(후처리) e.g. 1900'), year_to: z.number().int().optional().describe('발행연도 끝 e.g. 1945') },
    async ({ query, collection, category, max_results, year_from, year_to }) => {
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
        const yfilt = !!(year_from || year_to); const yf = year_from || 0, yt2 = year_to || 9999;
        const base = `https://www.nl.go.kr/NL/search/openApi/search.do?key=${encodeURIComponent(key)}&apiType=xml&srchTarget=total&kwd=${encodeURIComponent(query)}&pageSize=${yfilt ? 50 : Math.min(max_results, 50)}&pageNum=1`;
        const parse = (xml) => {
          const tot = xtag(xml, 'total') || '?';
          let items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
          const pick = (b, tags) => { for (const t of tags) { const v = xtag(b, t); if (v) return v; } return ''; };
          if (yfilt) items = items.filter((it) => { const y = parseInt((pick(it, ['pub_year_info', 'pubYearInfo']).match(/\d{4}/) || [])[0], 10); return y && y >= yf && y <= yt2; });
          const matched = items.length;
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
          return { tot, lines, matched };
        };
        try {
          // 이중채널 동시 수집: (A) 전체 소장자료 + (B) 자료유형(category) 정밀 — 상호보완
          const [totalXml, catXml] = await Promise.all([
            gtext(base),
            // v1.96.8: category 미지정이면 '고문헌'을 자동 병행 — 전체 목록은 현대 영인·번역본이 상위를 채워 원본(1797 오륜행실도 등)이 묻힘(실측)
            gtext(base + '&category=' + encodeURIComponent(category || '고문헌')).catch(() => null),
          ]);
          if (totalXml.includes('<error')) return text(`NLK OpenAPI 오류: ${xtag(totalXml, 'msg') || '?'} — NLK_API_KEY 확인.` + dbrowse(openUrl));
          const A = parse(totalXml);
          let out = `국립중앙도서관 자동검색(전체 소장자료) '${query}'${yfilt ? ` [발행 ${year_from || ''}~${year_to || ''} · 상위 50건 내 후처리·연대 미상 제외]` : ''} — 총 ${A.tot}건${yfilt ? ` 중 연대 일치 ${A.matched}건` : ''}:\n` + (A.lines.join('\n') || '(0건)');
          if (category && catXml && !catXml.includes('<error')) {
            const B = parse(catXml);
            out += `\n\n[② 자료유형 '${category}' 정밀 채널 — 총 ${B.tot}건 (동시 수집)]\n` + (B.lines.join('\n') || '(0건)')
              + `\n※ 전체+자료유형 이중채널(상호보완).`;
          } else {
            const B = catXml && !catXml.includes('<error') ? parse(catXml) : null;
            if (B && B.lines.length && !yfilt) out += `\n\n[② 고문헌(원본) 자동 병행 — 총 ${B.tot}건]\n` + B.lines.slice(0, 6).join('\n') + '\n※ 현대 영인·번역본에 가려지는 원본 고서를 함께 보여 줍니다.';
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
    "Search 서울기록원 (archives.seoul.go.kr) — 기록 단위 검색(시리즈·기록건 제목+상세 딥링크). query에 /item·/aggregation 상세 URL 투입 시 심층 판독: 식별번호(RG-SR-IT)·기술계층·법적지위·소장처·이용조건(judge_rights 투입)·기술 본문. Seoul municipal records/photos/oral histories.",
    { query: z.string().describe('검색어 또는 archives.seoul.go.kr/item·/aggregation 상세 URL'), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, max_results }) => {
      const q = query.trim();
      const deep = 'https://archives.seoul.go.kr/catalog/result?regclass=ALL&query=' + encodeURIComponent(q);
      if (/^https?:\/\/archives\.seoul\.go\.kr\/(item|aggregation)\/\d+/.test(q)) { // 상세 판독 — 도메인 한정(임의 URL 페치 방지)
        try {
          const b = await cachedText('seoulD:' + q, 24 * 3600e3, () => gtext(q), '기술계층');
          const flat = dclean(b).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
          const pick = (re2) => ((flat.match(re2) || [])[1] || '').trim();
          const title = pick(/<-\s*(.{2,90}?)\s+(?:기술계층|생산자)/);
          const sid = pick(/식별번호\s+(\S{4,60})/); // v2.32 RG-SR-FI-IT 35자 이상 — 30자 제한으로 잘리던 결함
          // v2.32 기관 계층(브레드크럼) — '기술계층 시리즈(Series) X 기록철(File) Y 기록건(Item) <- 제목'의 상위 단계만(원 기관 계층 그대로)
          const crumb = pick(/기술계층\s+(.+?)\s+생산자\s/) || pick(/기술계층\s+(.+?)\s+기술계층\s/);
          const hier = [...crumb.matchAll(/([가-힣]{2,8})\(([A-Za-z][A-Za-z -]{1,20})\)\s+(.+?)(?=\s+[가-힣]{2,8}\([A-Za-z][A-Za-z -]{1,20}\)|$)/g)]
            .filter((m) => !/^<-/.test(m[3].trim())).map((m) => `${m[1]} ${m[3].trim().replace(/^<-\s*/, '')}`.slice(0, 80));
          const producers = pick(/생산자\s+(.+?)\s+기술계층\s/).split(/(?<=\))\s*,?\s+(?=\S)/).map((x) => x.trim()).filter(Boolean).slice(0, 4);
          const dateP = pick(/일자\s+\[생산\]\s*(.{0,40}?)\s+(?:연관정보|보존이력|수집|언어)/);
          const rtype = pick(/기록유형\s+(\S{2,20})/), ptype = pick(/보존유형\s+(\S{2,10})/), atype = pick(/접근유형\s*(\S{2,10})/);
          const custody = pick(/보존이력\s+(.{2,120}?)\s+(?:수집\/이관 기관|언어|보존유형)/), transfer = pick(/수집\/이관 기관\s+(.{2,80}?)\s+(?:언어|보존유형)/);
          const related = pick(/연관정보\s+(.{2,160}?)\s+(?:보존이력|수집\/이관|언어)/);
          const layers = [...flat.matchAll(/기술계층\s+(\S{2,20}\([A-Za-z]+\))/g)];
          const layer = layers.length ? layers[layers.length - 1][1] : ''; // 첫 일치는 브레드크럼 — 마지막이 본 기록의 계층
          const legal = pick(/법적지위\s+(\S{2,12})/);
          const use = pick(/이용조건\s*이용유형\s*(.{2,40}?)\s*(?:이용주기|검색도구|공개|관련)/);
          const useNote = pick(/이용주기\s*(.{5,160}?)\s*(?:검색도구|공개|관련)/);
          const desc = pick(/상세정보\s+기술\s+([\s\S]{10,1500}?)\s+(?:생산이력|입수이력|보존이력|관련 기록|열람|공개된)/);
          if (!sid && !title && !desc) return text(`상세 파싱 실패 — URL을 확인하거나 브라우저로 열람: ${q}`);
          return text(`서울기록원 상세 — ${title || '(제목 미상)'}\n`
            + [sid && `식별번호 ${sid}`, layer, legal && `법적지위 ${legal}`].filter(Boolean).join(' · ') + '\n'
            + (hier.length ? `계층: 서울기록원 › ${hier.join(' › ')}\n` : '')
            + (producers.length ? `생산자: ${producers.join('; ')}\n` : '')
            + (/\d/.test(dateP) ? `일자: 생산 ${dateP}\n` : '')
            + ([rtype && `기록유형 ${rtype}`, ptype && `보존유형 ${ptype}`, atype && `접근유형 ${atype}`].filter(Boolean).join(' · ') ? [rtype && `기록유형 ${rtype}`, ptype && `보존유형 ${ptype}`, atype && `접근유형 ${atype}`].filter(Boolean).join(' · ') + '\n' : '')
            + (custody || transfer ? `보존이력: ${[custody, transfer && `수집/이관 ${transfer}`].filter(Boolean).join(' · ')}\n` : '')
            + (related ? `연관정보: ${related}\n` : '')
            + (use ? `이용조건: ${use}${useNote ? ` — ${useNote}` : ''}\n` : '')
            + (desc ? `【기술】\n${desc}\n` : '') + `원문: ${q}\n`
            + '※ 출처: 서울기록원 — 게재 시 출처 표기. 이용조건·법적지위를 judge_rights에 투입해 초판정.');
        } catch (e) { return text(`서울기록원 상세 오류(${String(e && e.message || e).slice(0, 60)}) — 브라우저로 열람: ${q}`); }
      }
      try {
        const items = await COLLECT.seoul(q, Math.min(max_results, 20));
        if (items.length) return text(`서울기록원 '${q}' — ${items.length}건(시리즈·기록건):\n`
          + items.map((it) => `- ${it.title}\n  ${it.url}`).join('\n')
          + `\n전체 결과: ${deep}\n※ 상세 URL을 query로 재투입 → 식별번호·이용조건·기술 본문 판독.`);
        return text(agentBrowse('서울기록원', q, deep, '기록 미검출'));
      } catch (e) { return text(agentBrowse('서울기록원', q, deep, `자동조회 실패(${e.message})`)); }
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
        // 구 통합검색 개편(2026-11 실측: 응답은 오나 결과 구조 소멸) → 동일 재단 신 플랫폼으로 폴백
        const kw = await kwSearch({ keyword: query, viewType: 'archive' });
        const kl = kw.cards.slice(0, 10).map((c) => `- [${c.id}] ${c.title.slice(0, 90)}\n  ${c.url}`);
        if (kl.length) return text(`전쟁기념관 구 통합검색(archives.warmemo.or.kr)이 개편되어 결과를 내지 않습니다 — 동일 재단(전쟁기념사업회)의 6·25전쟁 아카이브센터(koreanwar.or.kr, 협약기관)에서 '${query}' 검색 결과로 대체합니다 (총 ${kw.total}건):\n` + kl.join('\n') + `\n※ 상세·인접 채굴: koreanwar_item. 구 사이트 직접 확인: ${url}`);
        return text(agentBrowse('전쟁기념관', query, url, '구 통합검색 개편(결과 구조 소멸) — 신 플랫폼(koreanwar.or.kr)도 0건'));
      } catch (e) { return text(agentBrowse('전쟁기념관', query, url, `자동조회 실패(${e.message})`)); }
    });

  // ── KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 (협약기관 — MOU) : TNA-style structured toolset (PlayMCP 준수: 2 tools) ──
  server.tool('koreanwar_search',
    "Search KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 (koreanwar.or.kr, War Memorial of Korea Foundation — MOU partner): 55,000+ items (documents·maps·photos·films·audio·oral histories). Parses result cards (title, archRfcd persistent ref code, producer, provenance hierarchy) and extracts NARA Record Group for origin tracing via nara_search. Verified server-side filters: year_from/year_to (production year), acquisition (수집구분: 수집·기증·구입·기탁·제작·이관·차입·기타). scope='battle' searches the battle-info DB instead (69 early-war battles + 16 server-curated later-phase anchors 인천상륙~금성 — for TNA WO 281 / NARA RG 407 cross-verification). Korean queries recommended (US-origin footage is re-described in Korean). With KOREANWAR_API_TOKEN, an official OpenAPI metadata channel (KOGL rights fields) joins automatically. Full filter code tables: source_profile('koreanwar').",
    { query: z.string().describe('한글 권장 — e.g. "장진호", "흥남철수", "인천상륙"'), scope: z.enum(['archive', 'battle']).default('archive').describe('archive=소장자료 통합검색, battle=전투정보 DB'), page: z.number().int().min(1).default(1), max_results: z.number().int().min(1).max(50).default(10).describe('페이지당 결과 수(=pageSize 10/20/50 자동 매핑)'), year_from: z.number().int().optional().describe('생산연도 시작 e.g. 1950'), year_to: z.number().int().optional().describe('생산연도 끝 e.g. 1951'), acquisition: z.enum(['수집', '기증', '기타', '구입', '기탁', '제작', '이관', '차입']).optional().describe('수집구분(depth1) 필터') },
    async ({ query, scope, page, max_results, year_from, year_to, acquisition }) => {
      if (scope === 'battle') {
        const listUrl = KW_BASE + '/warList.do';
        try {
          const b = await cachedText('kw:warList', 6 * 3600e3, () => gtext(listUrl, KW_UA), 'warDetail.do?warIdx=');
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
          const anchors = kwAnchorLines(t);
          const anchorBlock = anchors.length ? `\n\n[후기 단계 검색 앵커 — 서버 큐레이션(기관 전투 DB 아님), 시기는 통설 전사 기준]\n` + anchors.join('\n') : '';
          if (lines.length) return text(`6·25 전투정보 '${t || '(전체)'}' — ${matched.length}/${cards.length}건:\n` + lines.join('\n') + anchorBlock + '\n※ 전투명·시기·장소를 앵커로 TNA WO 281·NARA RG 407·koreanwar_search(scope=archive)와 교차. 기관 DB는 개전 초기(1950.6.25~9.14) 단계 수록(확장 중) — 이후 시기는 위 앵커로 보완.');
          if (anchors.length) return text(`6·25 전투정보 '${t}' — 기관 DB 0건 (개전 초기 ${cards.length}건만 수록).` + anchorBlock + `\n※ 앵커의 전투명·시기로 scope=archive·nara_search·tna_search를 교차 검색하십시오.`);
          return text(`6·25 전투정보 '${t}' — 0건 (전체 ${cards.length}건 중). 현재 기관 DB는 개전 초기(1950.6.25~9.14) 전투만 수록 — 이후 시기(백마고지 1952 등)는 서버 앵커(인천상륙·장진호·지평리·백마고지·금성 등 16건)로 보완되니 해당 전투명으로 재질의. scope=archive로 자료 검색은 가능.` + dbrowse(listUrl));
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
        let lvl = ''; // v1.96.2: 입수처 링크가 시리즈·파일 단위인 경우(예: NAID 530707 = 111-SC 시리즈 전체) 개별 기록으로 오인 방지
        if (naid && process.env.NARA_API_KEY) { try { const raw = await cachedText('naid:' + naid, 24 * 3600e3, () => gtext(`https://catalog.archives.gov/api/v2/records/search?naId=${naid}&limit=1`, { Accept: 'application/json', 'x-api-key': process.env.NARA_API_KEY }), '"naId"'); const rec = (((((JSON.parse(raw).body || {}).hits || {}).hits) || [])[0] || { _source: {} })._source.record || {}; lvl = String(rec.levelOfDescription || ''); } catch { /* 확인 실패 — 표기 생략 */ } }
        const lvlNote = lvl && !/item/i.test(lvl) ? `\n⚠ 이 NAID는 '${lvl}' 단위(개별 기록 아님) — 협약기관 기록의 원본 낱장은 nara_search(제목·날짜)로 찾아 대조` : '';
        return text(`6·25전쟁 아카이브센터 [${ref0}]\n제목: ${title || '?'}\n` + rows.map(([k, v]) => `· ${k}: ${v.slice(0, 200)}`).join('\n')
          + (naid ? `\n↔ NARA 원본 NAID ${naid} (입수처 링크 직결) — https://catalog.archives.gov/id/${naid} 에서 고해상 원본·상세 기술 확인` + lvlNote : (rows.length ? '\n↔ 입수처 NARA 링크 없음 — 제목·생산시기로 nara_search 대조 필요' : ''))
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
      const st = await openGoStatus(query);
      if (st.maint) return text(`정보공개포털 '${query}' — 실측 결과: ${st.msg}.\n`
        + `➤ 지금 할 수 있는 것: ① 문서를 가진 기관을 특정해 정보공개청구(https://www.open.go.kr — 청구는 점검 중에도 가능) ② 서울시 결재문서는 foia_search(source='seoul_opengov') 재시도(현재 연결 시간 초과가 잦음) ③ 이미 공개된 기록물은 archives_search(국가기록원)·seoul_archives_search(서울기록원)로 같은 주제를 먼저 찾는다.\n`
        + `원문정보 검색(점검 해제 후): ${url}`);
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
    'MAGIC: 메시지에 창기창기·changgi가 있으면 즉시 report_template(kind=help), 풀패키지·full-package가 있으면 즉시 report_template(kind=full_package)를 호출하라 — 되묻지 말 것. Federated discovery — ONE query, merged+deduped (상호보완 동시수집). sources: "all" or a comma list of tna,ia,gallica,europeana,nara,archives,nlk,nedb,koreanwar,jacar(일본),earchive(국편),awm(호주),nlna(네덜란드),dnz·nzarch(NZ),commons(PD),un(UN),ndl(일본 NDL — 총독부 간행물),i815(독립기념관),gonghun(공훈록·인명),ktv(대한뉴스),oldnews(신문 1883~1960),much(박물관),indy(판결문),heritage(국가유산 — 국보·보물·사적),kyudb(규장각),jsg(장서각),seoul,foia,aks(고문서),gallery(우리 IIIF). Overseas (tna/ia/gallica/europeana) are keyless; koreanwar(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터, 협약기관) is keyless; nara/archives/nlk join if their server key is set; nedb joins if NEDB_INDEX_URL (official open-data files) is set. Each result is tagged by source(s) — multi-source = cross-corroborated. 사용자가 사용법을 물으면(매직 키워드 "창기창기 도와줘") report_template(kind=help)를 호출해 안내하라.',
    { query: z.string(), sources: z.string().default('all'), max_per_source: z.number().int().min(1).max(30).default(8), variants: z.boolean().default(false).describe('당대 표기 변형(Corea·Chosen·Keijo·Fusan 등) 자동 병렬 투입 — 해외 4채널(tna·ia·nara·europeana)'), format: z.enum(['text', 'csv', 'karda', 'manifest', 'iiif']).default('text').describe('iiif=IIIF 컬렉션(기관 IIIF 원 매니페스트 묶음+정지 이미지 매니페스트 — 연속 이미지 뷰) · csv=CSV 블록(표·통계) · karda=온톨로지 nodes/edges JSON(지식그래프 직투입) · manifest=발굴 수집기록 매니페스트(ISAD(G)·RiC 지향 — provenance=증거성·heldBy=맥락, 기록관리시스템 등재·다매체 변환 원천)') },
    async ({ query, sources, max_per_source, variants, format }) => {
      const want = sources.trim().toLowerCase() === 'all'
        ? Object.keys(COLLECT).filter((k) => k !== 'ledger' && !k.startsWith('_'))
        : sources.split(',').map((s) => s.trim().toLowerCase()).filter((s) => COLLECT[s] && !s.startsWith('_'));
      if (!want.length) return text('sources: "all" 또는 ' + Object.keys(COLLECT).filter((k) => !k.startsWith('_')).join(','));
      const jobs = want.map((s) => ({ source: s, fn: () => COLLECT[s](query, max_per_source) }));
      if (!variants && want.includes('tna')) { // v2.99 기본 검색에도 — 개항기~대한제국기(1850~1909) 연도가 있는 변환어면 TNA에 당대 국호+연도 1건 추가(실측: 사건명 0건, 'Corea 1876'은 FO 405 강화도조약 문서철)
        const y = ((koToEn(query) || '').match(/\b(18[5-9]\d|190\d)\b/) || [])[1];
        if (y) jobs.push({ source: `tna·Corea ${y}`, fn: () => COLLECT.tna('Corea', max_per_source, y) }); // v2.99.1 'Corea'+연도 필터 — 'Corea 1876' 문자열은 선원 명부 등 연도만 맞는 기록이 섞임(실측)
      }
      if (variants) { // 당대 표기 자동 팬아웃 — query_bank '열한 겹의 벽' 지식의 도구화
        const eff = koToEn(query) || query;
        const SUBS = [['Korean', 'Corean'], ['Korea', 'Corea'], ['Korea', 'Chosen'], ['Seoul', 'Keijo'], ['Pusan', 'Fusan'],
          ['Inchon', 'Chemulpo'], ['Wonsan', 'Gensan'], ['Pyongyang', 'Heijo'], ['Cheju', 'Quelpaert'], ['Taegu', 'Taikyu']];
        const vs = [];
        for (const [a, b] of SUBS) {
          if (vs.length >= 2) break;
          const re = new RegExp(`\\b${a}\\b`, 'i');
          if (re.test(eff)) vs.push([b, eff.replace(re, b)]);
        }
        { const y = (eff.match(/\b(18[5-9]\d|190\d)\b/) || [])[1]; if (y) vs.push([`Corea ${y}`, `Corea ${y}`]); } // v2.98 개항기~대한제국기(1850~1909) 사건은 기관 색인이 사건명이 아니라 당대 국호+연도(TNA FO 405 'Corea … 1894' 실측) — 사건명 질의 0건 보완
        for (const src of ['tna', 'ia', 'nara', 'europeana']) {
          if (!want.includes(src)) continue;
          for (const [label, vq] of vs) { if (src === 'nara' && /^Corea \d{4}$/.test(vq)) continue; const ey = src === 'tna' && (vq.match(/^Corea (\d{4})$/) || [])[1]; jobs.push({ source: `${src}·${label}`, fn: () => (ey ? COLLECT.tna('Corea', max_per_source, ey) : COLLECT[src](vq, max_per_source)) }); } // v2.98.1 NARA는 'Corea <연도>'가 성씨 Corea·날짜만 맞는 문서철로 흐려져 제외(실측)
        }
      }
      const { items, stats } = await collectMerged(jobs);
      await resolveOrigins(items, stats);
      { const linked = linkOverseas(items); if (linked.length !== items.length) { items.length = 0; items.push(...linked); stats.push('국외 교차확인 ' + linked.filter((x) => x.crossOv).length + '건'); } }
      items.sort((a, b) => b.sources.length - a.sources.length);
      // v2.5 발견 누적 원장 — 발견 기록을 날짜 함에 적재(v2.26부터 질의·회신은 래퍼가 ka:q로 원문 그대로 별도 축적), 매일 GitHub 원장으로 병합. 미설정·한도 초과면 조용히 생략
      const kept = await stash(items, { fmt: format || 'text', probe: !!(REQ.getStore() || {}).probe, ak: (REQ.getStore() || {}).ak || '', partOf: (it) => { const h = it.sources[0].split('·')[0]; return (PART_OF[h] && PART_OF[h](it)) || ''; } });
      const uaNote = Object.keys(UA_REFUSED).filter((k) => stats.some((x) => x.startsWith(k + ':') && x.includes('⛔'))).map((k) => `\n※ ${uaRefusedNote(k, query)}`).join(''); // v2.36 정직 UA 거부 기관 — 0건 대신 브라우저 경로
      // v2.48 부재 단정 금지 — 조회 실패(—) 채널은 '그 기관에 없음'이 아니다. 0건(확정)과 구분해 명시
      const failedCh = [...new Set(stats.filter((x) => /^[a-z0-9_]+(?:·[^:]+)?:—/.test(x)).map((x) => x.split(':')[0].split('·')[0]))];
      const failNote = failedCh.length ? `\n※ 조회 실패 채널 ${failedCh.length}곳(${failedCh.join(', ')}) — 이번 응답에 없을 뿐 그 기관에 기록이 없다는 뜻이 아닙니다(시간 초과·차단·응답 끊김). 해당 수집처만 다시: sources='${failedCh.join(',')}'` : '';
      const keptNote = failNote + uaNote + ((kept || ledgerConf()) ? `\n※ 질의·회신·발견 기록은 원문 그대로 공개 누적 원장에 영구 축적됩니다(가공·삭제 없음 — 공개를 원치 않는 본인 정보는 질의에 넣지 마십시오) — ${LEDGER_PAGE}` : '');
      if (format === 'iiif') { // v1.97: 연속 이미지 뷰 — 결과 중 기관 IIIF가 있는 기록의 원 매니페스트를 컬렉션으로, 위키미디어는 정지 이미지 매니페스트로
        const L3 = (t) => ({ ko: [String(t || '').slice(0, 200)] });
        const ext = []; const cm = []; const none = [];
        for (const it of items) {
          const u = String(it.url || ''); const src = it.sources[0].split('·')[0]; let m = null;
          if (/archive\.org\/details\/([^/?#]+)/.test(u)) m = `https://iiif.archive.org/iiif/3/${u.match(/archive\.org\/details\/([^/?#]+)/)[1]}/manifest.json`;
          else if (/europeana\.eu\/(?:[a-z]{2}\/)?item\/([^/]+)\/([^/?#]+)/.test(u)) { const x = u.match(/europeana\.eu\/(?:[a-z]{2}\/)?item\/([^/]+)\/([^/?#]+)/); m = `https://iiif.europeana.eu/presentation/${x[1]}/${x[2]}/manifest`; }
          else if (/ark:\/12148\/([a-z0-9]+)/i.test(u) && /gallica/.test(u)) m = `https://gallica.bnf.fr/iiif/ark:/12148/${u.match(/ark:\/12148\/([a-z0-9]+)/i)[1]}/manifest.json`;
          else if (/catalog\.archives\.gov\/id\/(\d+)/.test(u)) m = naraUrls(u.match(/catalog\.archives\.gov\/id\/(\d+)/)[1]).manifest; // v1.98: NARA→IIIF 브리지
          else if (/korea-archive-mcp\/iiif\.html#(s\d+)/.test(u)) m = `https://changgi.github.io/korea-archive-mcp/iiif/m/${u.match(/iiif\.html#(s\d+)/)[1]}.json`;
          else if (/dl\.ndl\.go\.jp\/pid\/(\d+)/.test(u)) m = `https://dl.ndl.go.jp/api/iiif/${u.match(/dl\.ndl\.go\.jp\/pid\/(\d+)/)[1]}/manifest.json`;
          if (!m && !/commons\.wikimedia\.org/.test(u)) m = iiifFor(u, it.id); // v1.99: 국가유산·역사박물관·AWM 브리지
          const gk = `${(ARCHIVE_META[src] || {}).n || src} › ${(PART_OF[src] && PART_OF[src](it)) || it.series || '(계열 미상)'}`.slice(0, 120); // v2.2: 결과 계층(기관 › 계열)
          if (m) ext.push({ _g: gk, id: m, type: 'Manifest', label: L3(`[${src}] ${norm(it.title)}${it.date ? ' (' + it.date + ')' : ''}`), homepage: [{ id: u, type: 'Text', label: L3('원 기관 기록'), format: 'text/html' }] });
          else if (/commons\.wikimedia\.org\/wiki\/File/.test(u) && /\.(jpe?g|png|tiff?|gif)$/i.test(decodeURIComponent(u))) cm.push({ it, file: decodeURIComponent(u.split('/wiki/')[1]).replace(/_/g, ' ') });
          else { // v2.0: IIIF가 없는 기록 → 기록 봉투 IIIF로 구축(계층 구축·발견 증거·기록 카드 또는 원본 이미지)
            const tok = encodeEnv(envelopeOf({ ...it, title: norm(it.title).slice(0, 160) }, { query, inst: (ARCHIVE_META[src] || {}).n || src, part: (PART_OF[src] && PART_OF[src](it)) || it.series || '' }));
            none.push(`- [${src}] ${norm(it.title).slice(0, 70)}`);
            ext.push({ _g: gk, id: recUrls(tok).manifest, type: 'Manifest', label: L3(`[${src}] ${norm(it.title)}${it.date ? ' (' + it.date + ')' : ''} · 기록 봉투`), ...(u ? { homepage: [{ id: u, type: 'Text', label: L3('원 기관 기록'), format: 'text/html' }] } : {}) });
          }
        }
        let still = null;
        if (cm.length) { // 위키미디어: 한 번의 imageinfo 호출로 크기·1600px URL
          try {
            const q2 = new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'size|url|extmetadata', iiurlwidth: '1600', titles: cm.slice(0, 12).map((c) => c.file).join('|') });
            const j = await jget('https://commons.wikimedia.org/w/api.php?' + q2);
            const pages = Object.values((j.query || {}).pages || {});
            const base = 'https://korea-archive-mcp.vercel.app/iiif/wikimedia/' + encodeURIComponent(query);
            const cvs = pages.filter((pg) => pg.imageinfo).map((pg, i) => { const ii = pg.imageinfo[0]; const w = ii.thumbwidth || ii.width, h = ii.thumbheight || ii.height; const cid = `${base}/canvas/${i + 1}`;
              const lic = ((ii.extmetadata || {}).LicenseShortName || {}).value || '';
              return { id: cid, type: 'Canvas', label: L3(pg.title.replace(/^File:/, '')), width: w, height: h, metadata: [{ label: L3('권리'), value: L3(lic || '파일 페이지 확인') }],
                homepage: [{ id: ii.descriptionurl, type: 'Text', label: L3('위키미디어 파일 페이지'), format: 'text/html' }],
                items: [{ id: cid + '/p', type: 'AnnotationPage', items: [{ id: cid + '/p/a', type: 'Annotation', motivation: 'painting', target: cid, body: { id: ii.thumburl || ii.url, type: 'Image', format: 'image/jpeg', width: w, height: h } }] }] }; });
            if (cvs.length) still = { '@context': 'http://iiif.io/api/presentation/3/context.json', id: base + '/manifest.json', type: 'Manifest', label: L3(`위키미디어 공용 '${query}' 정지 이미지 ${cvs.length}장`), items: cvs };
          } catch (e) { none.push(`- [commons] 이미지 정보 조회 실패(${String(e.message).slice(0, 40)}) — 파일 페이지에서 확인`); }
        }
        // v2.2: 결과를 '기관 › 계열' 하위 컬렉션으로 묶어 계층을 준다(계열이 2개 이상일 때). 순서는 결과 순서 유지
        const sid = 'https://korea-archive-mcp.vercel.app/iiif/search/' + encodeURIComponent(query) + '/collection.json';
        const groups = []; for (const x of ext.slice(0, 30)) { let g = groups.find((y) => y.k === x._g); if (!g) groups.push(g = { k: x._g, items: [] }); const { _g, ...y } = x; g.items.push(y); }
        const tree = groups.length > 1 ? groups.map((g, i) => ({ id: `${sid}#g${i + 1}`, type: 'Collection', label: L3(`${g.k} (${g.items.length})`), items: g.items })) : (groups[0] ? groups[0].items : []);
        const coll = { '@context': 'http://iiif.io/api/presentation/3/context.json', id: sid, type: 'Collection',
          label: L3(`KOREA ARCHIVE 통합검색 '${query}' — ${ext.length}건(기관 IIIF·브리지·기록 봉투)`), summary: L3(`발견 ${new Date().toISOString().slice(0, 19)}Z · 출처 ${[...new Set(items.map((x) => x.sources[0].split('·')[0]))].join(', ')} · 계열 ${groups.length}개`), items: tree };
        // 검색 결과 전체를 KV 한 링크로 — 컬렉션을 압축해 주소 #c= 에 실음(서버 저장 없음, 링크=컬렉션)
        const kvAll = 'https://changgi.github.io/korea-archive-mcp/kv.html#c=' + deflateRawSync(Buffer.from(JSON.stringify(coll)), { level: 9 }).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const cj = JSON.stringify(coll);
        const out = `IIIF '${query}' — 매니페스트 ${ext.length}건(그중 기록 봉투 ${none.length}건 — IIIF가 없던 기록을 구축) · 정지 이미지 ${still ? still.items.length : 0}장\n`
          + `■ 전체를 한 번에 연속으로 보기(KV): ${kvAll}\n`
          + (cj.length < 13000 ? `① IIIF Collection(기관 원 매니페스트·브리지·기록 봉투):\n${cj}\n` : `① IIIF Collection ${ext.length}건(계열 ${groups.length}개) — 크기 상한으로 본문 생략(위 KV 링크에 전체 포함). 앞 8건:\n${ext.slice(0, 8).map((x) => `- ${x.label.ko[0].slice(0, 70)}\n  ${x.id}`).join('\n')}\n`)
          + (still ? `\n② 정지 이미지 Manifest(위키미디어 1600px — 권리는 캔버스별):\n${JSON.stringify(still)}\n` : '')
          + (none.length ? `\n③ 기록 봉투로 구축한 ${none.length}건(원본 이미지가 있으면 그 이미지, 없으면 기록 카드 · 계층 '기관 › 계열 › 기록' 구축 · 발견 질의·시각·봉투 지문 증거):\n${none.slice(0, 12).join('\n')}\n` : '')
          + `\n※ 보기: report_template(kind='iiif')의 뷰어 골격 SRC에 위 JSON 객체를 넣어 아티팩트로 게시하면 전체를 한 줄로 이어 넘기는 연속 이미지 뷰가 된다. 자체 뷰어 KV (Korea Archive Viewer)로 바로: https://changgi.github.io/korea-archive-mcp/kv.html?manifest=<URL>(컬렉션 전체 연속·비교·자동 넘김) · Mirador https://projectmirador.org/embed/?iiif-content=<URL> 로도 열린다. Gallica는 서버 자동 조회가 403이라 브라우저 뷰어에서만 열린다.`
          + `\n※ 예제: 30곳 탐방·100선 800장 공개 갤러리 https://changgi.github.io/korea-archive-mcp/iiif.html · 전체 이어보기 매니페스트 https://changgi.github.io/korea-archive-mcp/iiif/all.json`;
        return text(out.length > 23000 ? out.slice(0, 23000) + '\n…(24KB 상한 — max_per_source를 줄여 재요청)' : out);
      }
      if (format === 'manifest') { // 발굴 수집기록 매니페스트 — 발굴 행위 자체를 맥락·증거성 갖춘 현용기록으로(ISAD(G)·RiC 지향)
        const recs = items.slice(0, 30);
        const now = new Date().toISOString();
        const rid2 = (it, i) => 'rec:' + (it.id ? `${it.sources[0].split('·')[0]}:${it.id}` : `m${i}`); // karda 그래프와 동일 키 — 상호 참조
        const man = {
          '@context': { dcterms: 'http://purl.org/dc/terms/', rico: 'https://www.ica.org/standards/RiC/ontology#',
            title: 'dcterms:title', date: 'dcterms:date', identifier: 'dcterms:identifier', provenance: 'dcterms:provenance',
            accessUrl: 'dcterms:source', media: 'dcterms:hasFormat', iiif: { '@id': 'rico:hasOrHadInstantiation', '@type': '@id' }, sameAs: 'http://www.w3.org/2002/07/owl#sameAs', altTitle: 'dcterms:alternative', heldBy: { '@id': 'rico:hasOrHadHolder' }, records: { '@id': 'rico:hasRecordSetMember' } },
          '@type': ['DiscoveryManifest', 'rico:RecordSet'], standard: 'ISAD(G)/RiC-oriented',
          identifier: `kad-${now.slice(0, 10)}-${Math.abs([...query].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)).toString(36)}`,
          recordsFixity: '', // 아래에서 채움 — records 배열 JSON의 sha256(JSON 단독 전파 시에도 내장 무결성)
          provenance: { // 증거성 — 수집의 재현 가능한 기술(누가·무엇을·언제·어떻게)
            query, sources: want.join(','), variants, collectedAt: now,
            tool: 'KOREA ARCHIVE 통합검색 cross_search (Vercel icn1)',
            reproduce: `cross_search(query=${JSON.stringify(query)}, sources=${JSON.stringify(sources)}, format='manifest')`,
            channelStats: stats },
          records: recs.map((it, i) => {
            const hb = [...new Set(it.sources.map((s) => s.split('·')[0]))];
            const dr = DEEP_READ[hb[0]] && DEEP_READ[hb[0]](it);
            return {
              '@type': 'rico:Record', node: rid2(it, i), // karda 그래프 노드와 같은 키
              identifier: it.id || null, title: it.title, date: it.date || null,
              heldBy: hb.map((k) => ({ id: k, name: (ARCHIVE_META[k] || {}).n || k, country: (ARCHIVE_META[k] || {}).c || '' })), // 맥락 — 기관 정식명·국가
              accessUrl: it.url || null, evidence: `API 실조회 ${now.slice(0, 10)}` + (it.sources.includes('nara·원본확인') ? ` · NARA 카탈로그 원본 실재 확인(${it.id}) — 사본 ${it.sameAs || ''}` : (it.sameAs && it.sources.length > 1 ? ` · 기관 간 동일 기록 대조(${it.sameAs})` : '')),
              ...(it.media ? { media: it.media } : {}), // 다매체 — 원본 매체 직링크(게재 소싱)
              iiif: iiifFor(it.url, it.id) || recUrls(encodeEnv(envelopeOf({ ...it, title: norm(it.title).slice(0, 160) }, { query, inst: (ARCHIVE_META[hb[0]] || {}).n || hb[0], part: (PART_OF[hb[0]] && PART_OF[hb[0]](it)) || it.series || '' }))).manifest, // v2.0: 모든 기록에 IIIF — 기관 IIIF·브리지, 없으면 기록 봉투
              ...(it.sameAs ? { sameAs: it.sameAs } : {}), ...(it.altTitle ? { altTitle: it.altTitle } : {}), // 맥락·증거성 — 기관 간 동일 기록(재수집본↔원본)
              ...((PART_OF[hb[0]] && PART_OF[hb[0]](it)) ? { partOf: PART_OF[hb[0]](it) } : {}), // 맥락 — 상위 계층
              ...(dr ? { deepRead: dr } : {}) }; // 증거성 — 판독 재현 호출문
          }),
        };
        man.recordsFixity = 'sha256:' + createHash('sha256').update(JSON.stringify(man.records)).digest('hex'); // 내장 무결성
        const mj = JSON.stringify(man);
        const fx = createHash('sha256').update(mj).digest('hex'); // 고정성(fixity) — 전파 중 변조 검증
        return text(`발굴 수집기록 매니페스트 '${query}' — ${recs.length}건 (재현 가능·기관 등재용):\n`
          + '```json\n' + mj + '\n```'
          + `\nfixity(sha256): ${fx} — 위 JSON 바이트의 지문. 전파·보관본 대조 시 불일치=변조/손상.`
          + '\n공개 지문 원장(골든 기록 주간 감시·개정 이력): https://korea-archive-mcp.vercel.app/fixity-ledger.json'
          + '\n※ 현용기록물로서의 발굴기록: provenance(질의·소스·시각·재현 호출)=증거성 · heldBy·식별자=맥락 · fixity=고정성. 이 JSON을 그대로 기록관리시스템·KARDA에 등재.'
          + "\n※ 다매체 변환 사슬: 이 매니페스트 → report_template(kind=report/carousel/full_package)=보고서·카드뉴스 · format='karda'=지식그래프 · format='csv'=데이터셋 · media 필드=원본 매체 직링크(게재 소싱)."
          + '\n※ 지속가능성: 영속 식별자(archRfcd·NAID·levelId·R번호) 우선 인용 — URL이 썩어도 재발굴 가능. 채널 생존은 source_profile(health)·주간 CI가 감시. 권리는 judge_rights로 기록 단위 표시.');
      }
      if (format === 'karda') { // 온톨로지 직출력 — 로컬 스킬 전용이던 KARDA 노드·엣지 지식의 서버화(웹·모바일 동등성)
        const recs = items.slice(0, 30);
        const srcs = [...new Set(recs.flatMap((it) => it.sources.map((s) => s.split('·')[0])))];
        const rid = (it, i) => 'rec:' + (it.id ? `${it.sources[0].split('·')[0]}:${it.id}` : `m${i}`);
        const nodes = [{ id: 'topic:' + query, type: 'topic', label: query }]
          .concat(srcs.map((s) => ({ id: 'archive:' + s, type: 'archive', label: (ARCHIVE_META[s] || {}).n || s, ...(((ARCHIVE_META[s] || {}).c) ? { country: ARCHIVE_META[s].c } : {}) })))
          .concat(recs.map((it, i) => ({ id: rid(it, i), type: 'record', label: it.title.slice(0, 90),
            ...(it.id ? { identifier: it.id } : {}), // manifest와 동일 식별자 — 상호 참조
            ...(it.date ? { date: it.date } : {}), ...(it.url ? { url: it.url } : {}), ...(it.media ? { media: it.media } : {}), ...(it.altTitle ? { altTitle: it.altTitle } : {}) })));
        const edges = []; const serSeen = new Set();
        recs.forEach((it, i) => {
          edges.push({ from: 'topic:' + query, to: rid(it, i), rel: 'FOUND' });
          const hb0 = it.sources[0].split('·')[0];
          const po = PART_OF[hb0] && PART_OF[hb0](it);
          if (po) { // 계층 맥락 — series 노드·PART_OF 엣지(v1.72)
            const sid = 'series:' + po;
            if (!serSeen.has(sid)) { serSeen.add(sid); nodes.push({ id: sid, type: 'series', label: po }); }
            edges.push({ from: rid(it, i), to: sid, rel: 'PART_OF' });
          }
          [...new Set(it.sources.map((s) => s.split('·')[0]))].forEach((s) => edges.push({ from: rid(it, i), to: 'archive:' + s, rel: 'HELD_BY' }));
          if (it.sameAs) { const sa = 'ext:' + it.sameAs; if (!serSeen.has(sa)) { serSeen.add(sa); nodes.push({ id: sa, type: 'identifier', label: it.sameAs }); } edges.push({ from: rid(it, i), to: sa, rel: 'SAME_AS' }); } // v1.86 기관 간 동일 기록
        });
        return text(`교차수집 '${query}' KARDA 온톨로지 — 채널별 [${stats.join(' · ')}] → 노드 ${nodes.length}·엣지 ${edges.length} (레코드 ${recs.length}건, 상한 30):\n`
          + '```json\n' + JSON.stringify({ nodes, edges }) + '\n```'
          + '\n※ 그대로 KARDA·지식그래프 도구(Gephi·Neo4j·vis.js)에 투입. 한 레코드의 복수 HELD_BY=기관 교차확인. 권리 초판정: judge_rights. 인물 중심 그래프는 nedb_search(mode=gonghun, \'종합:이름\')과 결합.');
      }
      if (format === 'csv') { // 분석 투입용 구조화 출력 — "자료로써 분석할 수 있게". node=karda·manifest와 동일 조인 키(v1.71)
        const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const ridc = (it, i) => 'rec:' + (it.id ? `${it.sources[0].split('·')[0]}:${it.id}` : `m${i}`);
        const rows = items.slice(0, 45).map((it, i) => { const hb0 = it.sources[0].split('·')[0]; const po = (PART_OF[hb0] && PART_OF[hb0](it)) || ''; return [ridc(it, i), it.sources.join('+'), it.title, it.date, it.id, it.url, po, it.media || '', it.sameAs || ''].map(esc).join(','); });
        const csvBody = 'node,sources,title,date,id,url,partOf,media,sameAs\n' + rows.join('\n');
        const head = `교차수집 '${query}' CSV — 채널별 [${stats.join(' · ')}] → 병합 ${items.length}건 (45건 상한):\n`;
        const tail = '\n※ 그대로 스프레드시트·KARDA 온톨로지(nodes/edges)·통계 분석에 투입 가능. 권리 초판정: judge_rights.';
        // v2.4: 파일로 받기 — 링크 안에 CSV를 압축 봉인(서버 저장 없음). 응답 24KB·URL 12,000자 넘으면 링크 생략
        const dl = `https://korea-archive-mcp.vercel.app/export/csv/${encodeEnv({ q: String(query).slice(0, 80), at: new Date().toISOString().slice(0, 19) + 'Z', csv: csvBody })}.csv`;
        const fits = dl.length <= 12000 && Buffer.byteLength(head + csvBody + tail + dl, 'utf8') + 300 <= 24000;
        return text(head + csvBody + tail + keptNote + (fits ? `\n📥 CSV 파일 내려받기(엑셀 한글 BOM 포함): ${dl}` : '\n📥 파일 링크 생략(크기 상한) — 위 본문을 .csv로 저장하거나 max_per_source를 줄여 다시 실행'));
      }
      const lines = items.slice(0, 45).map((it) => `- [${it.sources.join('+')}] ${titleCut(it.title)}${it.date ? ` (${it.date})` : ''}${it.url ? ' ' + it.url : ''}${it.altTitle ? `\n  ↔ 동일 기록: ${it.altTitle.slice(0, 80)} (${it.sameAs})` : (it.sameAs ? `\n  ↔ ${it.sources.length > 1 ? '함께 묶인 기록' : '원본'}: ${it.sameAs}` : '')}${it.note ? `\n  ※ ${it.note}` : ''}`);
      return text(`교차수집 '${query}' — 채널별 [${stats.join(' · ')}] → 병합 ${items.length}건 (복수출처 우선 정렬):\n` + (lines.join('\n') || '(0)')
        + '\n※ [출처] 복수 표기 = 교차확인된 record. 국내(nara·archives·nlk)는 서버 키, nedb는 NEDB_INDEX_URL(공식 개방파일) 설정 시 포함. open.go.kr 본체(브라우저 전용)는 foia_search 전용 도구로.\n※ 발굴 우선 — 권리는 표시: 게재 전 judge_rights(참조코드·KOGL·naid)로 초판정. variants=true로 당대 표기(Corea·Chosen·Keijo…) 자동 팬아웃.'
        + keptNote + '\n※ 심층 판독 이어가기: [i815]→nedb_search(mode=i815, 상세URL) · [gonghun]→mode=gonghun(mngNo) · [ktv]→mode=ktv(view URL) · [earchive]→mode=earchive(\'키워드|순번\') · [jacar]→mode=jacar(레퍼런스코드) · [seoul]→seoul_archives_search(상세URL) · [koreanwar]→koreanwar_item(ref_code) · [okchf]→mode=okchf(상세URL·\'보고서:\') · [nrich]→mode=nrich(ov:·rep:·\'보고서:\') · [nara]→judge_rights(naid).');
    });

  server.tool('source_profile',
    'Structural profile of an archive for planning discovery: 자료구조(data model: hierarchy/classification/identifiers/metadata), 이용구조(access: API/auth/query syntax/robots/rights), 활용구조(utilization: how the 3 mismatches show up, which keyword set/cross-map to use, adjacent mining, cross-archive verification combos, rights rule). institution: "list" or a key — tna·nara·ia·gallica·europeana·nedb·archives·nlk·seoul·warmemo·koreanwar·foia; "health"=30채널 골든 질의 일괄 헬스체크(🟢🟡🔴+키 설정 상태). 기관 자료·이용·활용구조 프로파일.',
    { institution: z.string().default('list') },
    async ({ institution }) => {
      const t = (institution || 'list').trim().toLowerCase();
      if (t === 'health') { // 30채널 일괄 헬스체크 — 발굴 우선 원칙의 전제: 깨짐을 스스로 발견한다
        const GOLD = { tna: 'Korea', ia: 'Korea', gallica: 'Corée', europeana: 'Korea', nara: 'Korea',
          archives: '한국전쟁', nlk: '한국전쟁', nedb: '한강', koreanwar: '장진호', jacar: 'Chosen', earchive: '제주도', i815: '안중근', gonghun: '안중근', ktv: '대한뉴스', oldnews: '의병', much: '판문점', indy: '유관순', heritage: '숭례문', kyudb: '절목', jsg: '의궤', awm: 'Kapyong', nlna: 'Korea', dnz: 'Korean War', nzarch: 'Korea', commons: 'Seoul 1950', un: 'Korea armistice', ndl: '조선총독부', seoul: '한강', foia: '회의', aks: '문중', gallery: '흥남', okchf: '불화', nrich: '미륵사' };
        const keys = { NARA_API_KEY: !!process.env.NARA_API_KEY, ARCHIVES_API_KEY: !!process.env.ARCHIVES_API_KEY,
          NLK_API_KEY: !!process.env.NLK_API_KEY, EUROPEANA_API_KEY: !!process.env.EUROPEANA_API_KEY,
          KOREANWAR_API_TOKEN: !!process.env.KOREANWAR_API_TOKEN, NEDB_INDEX_URL: !!process.env.NEDB_INDEX_URL, LEDGER_REDIS: !!ledgerConf() };
        const timed = await Promise.all(Object.keys(GOLD).map(async (k) => {
          const s = Date.now();
          try { const v = await COLLECT[k](GOLD[k], 3); return { ok: true, n: v.length, ms: Date.now() - s }; }
          catch (e) { return { ok: false, err: String(e && e.message || e).slice(0, 60), ms: Date.now() - s }; }
        }));
        const rows = Object.keys(GOLD).map((k, i) => {
          const r = timed[i];
          if (r.ok) return `${r.n ? '🟢' : '🟡'} ${k}: ${r.n}건 · ${r.ms}ms (질의 '${GOLD[k]}')${r.n ? '' : ' — 연결 정상·결과/파싱 0'}`;
          return `🔴 ${k}: ${r.err} · ${r.ms}ms`;
        });
        return text('30채널 헬스체크 (골든 질의 실측):\n' + rows.join('\n')
          + '\n\n서버 키·설정: ' + Object.entries(keys).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' · ')
          + await (async () => { // v2.22 자동 파이프라인 신선도 — 정적 색인·원장이 오래되면 🔴(워크플로 고장 신호)
            const PB = 'https://changgi.github.io/korea-archive-mcp/data/';
            const chk = async (label, url, field, maxDays) => { try { const j = await jget(url + '?t=' + Math.floor(Date.now() / 3600e3)); const t = Date.parse(j[field]); const d = (Date.now() - t) / 86400e3;
              return `${d <= maxDays ? '🟢' : '🔴'} ${label}: ${String(j[field]).slice(0, 16)} (${d.toFixed(1)}일 전, 기준 ${maxDays}일)${j.warnings ? ' ⚠ 품질 경고 ' + j.warnings.length : ''}`; } catch (e) { return `🔴 ${label}: 확인 실패(${String(e.message || e).slice(0, 30)})`; } };
            const L = await Promise.all([chk('연구원 연구DB 색인(nrich-harvest, 주 1회)', PB + 'nrich_db_meta.json', 'harvested', 9), chk('발견 누적 원장(ledger, 매일)', PB + 'stats.json', 'updated', 2.5)]);
            return '\n\n자동 파이프라인 신선도:\n' + L.join('\n')
              + '\n\n접근 제한(정직 UA 거부 — 우회하지 않음):\n' + (Object.entries(UA_REFUSED).map(([k, r]) => `⛔ ${k} ${r.name}: ${r.how} (실측 ${r.since}) · 브라우저 ${r.browse}`).join('\n') || '없음 — 전 기관 정직 UA로 수집 중'); })()
          + '\n※ 🟡=연결 정상이나 0건(질의 특성 또는 파서 점검 필요) · 🔴=채널 실패(차단·타임아웃) · ms=채널 응답시간. nedb ✗=개방파일 인덱스 미설정.');
      }
      if (t !== 'list' && !PROFILES[t] && QUICK_PROFILES[t]) { const [nm, sr, dt, rt] = QUICK_PROFILES[t]; return text(`[${t}] ${nm} — 간이 프로파일\n· 검색: ${sr}\n· 상세 판독: ${dt}\n· 권리: ${rt}\n※ 상세 프로파일(자료·이용·활용구조) 미작성 기관 — 위 경로로 발굴하고 judge_rights로 초판정.`); }
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

  // ── MCP 프롬프트: 매직 키워드를 웹·모바일 클라이언트 UI(+메뉴)에 네이티브 노출 ──
  server.prompt('full-package',
    "매직 키워드 '풀패키지' — 주제 하나로 발굴 조사부터 매거진 보고서·카드뉴스·포스터·홍보·입문·메시지 카드·발표 PPTX·기록 해설·Canva 편집본·KARDA 연구 데이터·시연 영상(데모 GIF)까지 전 산출물 자동 제작" + SVC,
    { topic: z.string().describe('조사 주제 — 예: 장진호, 흥남철수, 조선의 조운 제도') },
    ({ topic }) => ({ messages: [{ role: 'user', content: { type: 'text',
      text: `${topic} 풀패키지로 만들어줘. 먼저 report_template(kind='full_package')를 호출해 제작 순서와 품질 게이트를 받고, 그 순서를 그대로 따라 전 산출물을 제작해줘.` } }] }));
  server.prompt('changgi-help',
    "매직 키워드 '창기창기 도와줘' — KOREA ARCHIVE 통합검색 처음 사용자 안내(연결법·매직 키워드·예시 문장·산출물 9종·검증 원칙·FAQ)" + SVC,
    () => ({ messages: [{ role: 'user', content: { type: 'text',
      text: "창기창기 도와줘. report_template(kind='help')를 호출해 받은 사용 안내를 처음 사용자 눈높이로 친절하게 정리해서 알려주고, 안내 페이지 링크(https://korea-archive-mcp.vercel.app/help.html)도 함께 줘." } }] }));
}, {
  instructions: '이 커넥터의 매직 키워드: (1) "풀패키지"가 포함된 요청(예: "장진호 풀패키지로 만들어줘") → 즉시 report_template(kind=full_package)를 호출해 그 순서로 전 산출물을 제작하라. (2) "창기창기"·"changgi-help"·"changgi"가 포함된 메시지, 또는 이 커넥터의 사용법·도움말·기능을 묻는 질문("사용법 알려줘", "뭘 할 수 있어?", "help me use this") → 즉시 report_template(kind=help)를 호출해 안내를 전달하라. "full-package"도 (1)과 동일. 두 경우 모두 되묻지 말고 바로 도구를 호출한다.',
}, { basePath: '/api' });

const REPORT_RULES = `HTML 발굴 보고서 작성 규칙 (19) — 잡지·저널급 편집 기준
1. 파일명: [주제영문]_records_[연도범위].html — 조사 완료 시 기본 산출물
2. 지면 구조(잡지형): masthead → kicker → 표제(h1) → standfirst → byline(기관 chip) → 목차(nav.toc) → 히어로 figure → Ⅰ서사 → Ⅱ핵심 기록 카드 → Ⅲ영상 필름스트립 → Ⅳ전수 목록 표 → Ⅴ재현 쿼리(details) → Ⅵ권리·게재 윤리 → 출처 총람(.sources) → footer
3. 서사 우선: 표만 나열 금지 — 발굴 경위·의미를 에세이로 서술(리드 문단 .lead 드롭캡, 풀인용 .pull 1개 이상). 문단이 실물을 설명하면 그 문단 옆에 인라인 도판(.fig-inline 플로트)을 배치 — 잡지처럼 글과 그림이 같은 화면에 보이게. 문체는 담백·구체 — 과장어(놀라운·혁신적 등)와 AI투 금지
4. 실물 이미지 필수: 게재 가능(권리 A/B+게재윤리 1·2단계) 기록은 기관 공개 원본을 base64 임베드 — 히어로 1장+핵심 기록마다, 공개 컷은 전량(.sheet 콘택트시트·컷별 라벨). 비식별판 우선. 이미지는 max-width:100% 자동 축소. 원본 URL은 cross_search(format='csv'·'manifest')의 media 열(실조회 검증 직링크 — NARA·commons 등)을 우선 사용. 환경별: 로컬=base64 임베드 / 웹·모바일(파일·base64 불가)=기관 공개 원본 URL을 img src로 직접 참조하고 footer에 그 사실을 명기. 한 장도 못 실으면 사유를 Ⅵ절에 명기
5. 모든 이미지에 figcaption + .credit 필수: "출처: 기관 정식명(국가) · 식별자 · 촬영자/생산자 · 원본 링크" — 출처 없는 이미지는 싣지 않는다
6. 영상 기록은 .film 필름스트립: 장면 전환마다 프레임을 충분히 추출(권장 8~16장)해 타임코드(.tc)+한 줄 설명으로 나열 — 표제가 가린 장면(ETC 뒤)을 드러내 원본을 직접 보고 싶게 만든다. 슬레이트·표지판 판독 프레임은 별도 확대 figure. 블록 끝에 .cta "▶ 원본 영상 보기 — [기관] 카탈로그"
7. 핵심 기록 3~6건은 .record 카드로: 이미지 + 한국어 제목(원제 병기) + .prov 출처 계보(국가→기관→RG/시리즈→상자→식별자) + 요약 + 바로가기 버튼 + 권리 배지 — .prov의 시리즈 층은 cross_search(format='csv'·'manifest')의 partOf 값을 그대로 옮긴다(수기 재구성 금지 — 지면과 데이터의 계보 일치)
8. 전수 목록 표(부록형): 식별자·원제 / 연대 / 소장처·계보(partOf — RG·시리즈·수집구조)·청구정보 / 내용 / 바로가기(원문→해제→카탈로그) / 권리초판 배지(b-A 공개확정 · b-B PD추정 · b-C 허가필요 · b-D 지위불명)
9. 출처 명시(전 지면): byline·본문에 기관 chip(국기 이모지+정식명 — 🇺🇸 NARA · 🇬🇧 TNA · 🇫🇷 BnF Gallica · 🇪🇺 Europeana · 🇺🇸 archive.org · 🇰🇷 국가기록원 · 🇰🇷 KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 등), 말미 .sources에 인용 기관 총람(국기·정식명·청구정보·이용조건·링크)
10. 재현 쿼리는 details 접이식 — 실제 실행한 쿼리만(목적/쿼리/URL 인코딩 실행 링크). '0건 ≠ 부재' note(인접 상자 ±2·피스 ±15 권고) 포함
11. 종합 색인·최신 연구 목록(ul.src) — details로 접어도 된다
12. Ⅵ 권리 절: 법적 근거(17 U.S.C. §105 · 36 CFR 1254.62 · Crown/OGL · domaine public · KOGL) + '출판 전 인간 최종 확인 필수' + D등급 공개 금지. 민감 주제(위안부·포로·학살)는 피해자 존엄 문구와 게재윤리 4단계(거부할 수 없었던 처지의 촬영 = 화면 미사용) 적용
13. 링크·수치는 도구 호출로 실확인한 것만 — 추정 URL 금지, footer에 '모든 링크 [날짜] 접속 확인' 명기
14. 연표·지도·관계도는 인라인 svg로 직접 작성 가능. 외부 리소스 금지(폰트·CDN) — 로컬은 단일 파일 자기완결(base64), 웹·모바일 산출만 기관 공개 이미지 URL 참조 예외 허용
15. 인쇄 대응: 템플릿의 @media print 유지 — 보고서는 그대로 출판물처럼 인쇄 가능해야 한다
16. 링크 신뢰장치: ①digitised 기록은 카탈로그 무료 미리보기 이미지를 공식 엔드포인트로 확보해 원문 figure로 임베드(예: TNA /image/getimage — 워터마크 원상태, 유료 전체본은 안내만) ②그 외 주요 링크는 페이지 캡쳐본 figure+credit(갈무리 일자) ③자동화 차단 시 명기하고 API 기술 원문 인용표로 대체. 훈격·날짜·건수는 API 원문 대조 '검증 기록'으로 — 초판 오류는 정정 이력을 남긴다
17. 카드뉴스·포스터 병행: 보고서와 함께 캐러셀(기본 8장, 1080×1080)과 포스터 시리즈(1080×1350 세로형 4~6장 — 표제·인물·문서·검증·초대의 연작 서사, 같은 검수 기준 — insta-carousel 스킬 또는 report_template(kind='carousel') 참조)을 제작하고, 보고서 말미 '카드뉴스' 절에 .cards-grid로 임베드한다 — 무크롭 전체 노출 + 카드별 figcaption, 잘림·겹침 금지. 커버는 히어로와 같은 실물 이미지, 검증 노트·따라하기 카드 포함, 보고서와 출처 대장 공유. PNG 원본·caption.txt·sources.txt를 보고서와 함께 납품
18. 더 보기 절(Ⅷ): 출처 총람 직전에 관련 공개 콘텐츠 소개 — 뉴스(📰)·기관 아카이브(🏛️)·해설/백과(📚)·SNS/영상 등을 카테고리 이모지+한 줄 설명으로. 접속 확인한 링크만(확인일 명기), 미확보 카테고리는 그 사실+추천 검색어 명시 — 발굴을 현재의 기억과 잇는 절
19. 수집기록 매니페스트 부록(증거성 상속): 보고서 끝에 cross_search(format='manifest') JSON을 <details> 부록으로 그대로 수록 — provenance(질의·소스·수집시각·재현 호출)와 기록별 heldBy·영속 식별자가 보고서를 떠나 전파되어도 따라간다. 카드뉴스·포스터 등 2차 매체에는 sources.txt에 매니페스트 identifier(kad-…)와 재현 호출문을 1줄 명기 — 어떤 매개로 변환되어도 원 발굴로 되돌아올 수 있게(현용기록물의 맥락·증거성 유지)`;

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
  img{max-width:100%;height:auto}
  h2{clear:both}
  /* 인라인 도판 — 문단 옆 플로트, 좁으면 전폭 */
  .fig-inline{float:right;width:min(46%,360px);margin:6px 0 14px 26px}
  .fig-inline.left{float:left;margin:6px 26px 14px 0}
  @media (max-width:640px){.fig-inline{float:none;width:100%;margin:16px 0}}
  /* 콘택트시트 — 공개 컷 전량 수록(.sub 라벨) */
  .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .sheet figure{margin:0}
  .sheet img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;border:1px solid var(--line)}
  .sheet .sub{font-size:12px;color:var(--sub);margin-top:5px;line-height:1.5}
  @media (max-width:640px){.sheet{grid-template-columns:1fr 1fr}}
  /* 카드 갤러리 — 무크롭+카드별 캡션, 잘림 금지 */
  .cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin:20px 0}
  .cards-grid figure{margin:0}
  .cards-grid img{width:100%;height:auto;display:block;border:1px solid var(--line)}
  .cards-grid figcaption{font-size:12px;color:var(--sub);margin-top:5px;line-height:1.5}
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
<p class="standfirst">{{스탠드퍼스트 2~3문장 — 무엇을·어디서·왜}}</p>
<div class="byline sans">
  <span>대상 시기 <b>{{대상시기}}</b></span> · <span>조사 도구 <b>KOREA ARCHIVE 통합검색</b></span>
  <span class="chip">🇺🇸 {{NARA · RG 111}}</span><span class="chip">🇬🇧 {{TNA · FO 371}}</span><span class="chip">🇰🇷 {{KOREAN WAR ARCHIVES}}</span>
  <!-- 조사 기관 전부 chip -->
</div>
<nav class="toc sans"><a href="#s1">서사</a><a href="#s2">핵심 기록</a><a href="#s3">영상</a><a href="#s4">전수 목록</a><a href="#s5">재현 쿼리</a><a href="#s6">권리·출처</a><a href="#s7">카드뉴스</a><a href="#s8">더 보기</a></nav>

<!-- 히어로: 실물 1장(권리·윤리 통과), credit 필수 -->
<figure>
  <img src="data:image/jpeg;base64,{{BASE64}}" alt="{{대체 텍스트}}">
  <figcaption><b>그림 1.</b> {{한 줄 설명 — 보는 이가 멈추게 되는 이유}}
  <span class="credit">출처: {{기관 정식명}}({{국가}}) · {{식별자}} · {{촬영자/생산자, 연도}} · <a href="{{원본URL}}">원본</a></span></figcaption>
</figure>

<h2 id="s1"><span class="no">I.</span> {{서사 절 제목 — 발굴 경위}}</h2>
<p class="lead">{{리드(드롭캡) — 질문에서 발견까지}}</p>
<p>{{서사 — 전략·단서·판독, 확인/추정 구분}}</p>
<!-- 인라인 도판: 설명하는 문단 옆에 배치 -->
<figure class="fig-inline">
  <img src="data:image/jpeg;base64,{{BASE64}}" alt="{{설명}}">
  <figcaption><b>그림 N.</b> {{이 문단이 설명하는 실물 — 판독 포인트(새김 문자·손글씨 등)}}
  <span class="credit">출처: {{기관 정식명(국가) · 식별자 · <a href="{{원본URL}}">원본</a>}}</span></figcaption>
</figure>
<p>{{인라인 도판이 붙는 문단 — 도판 속 실물을 직접 설명한다.}}</p>
<blockquote class="pull">{{풀인용 — 슬레이트 판독문·문서 원문·핵심 발견 한 구절}}</blockquote>
<p>{{서사 계속. 문단이 실물을 설명하면 반드시 그 옆에 figure 배치(각각 figcaption+credit 필수).}}</p>

<h2 id="s2"><span class="no">II.</span> 핵심 기록</h2>
<!-- 핵심 3~6건 카드. 이미지 없으면 img 생략 -->
<div class="record">
  <img src="data:image/jpeg;base64,{{BASE64}}" alt="{{설명}}">
  <div>
    <h3>{{한국어 제목 — 원제 병기}}</h3>
    <div class="prov sans">{{🇺🇸 미국}} → <b>{{NARA}}</b> → {{RG 111 · Entry NM-xx · Box nn}} → <b>{{식별자}}</b></div>
    <p>{{요약 2문장 — 표제가 가린 것부터}}</p>
    <div class="btns sans"><a href="{{원문URL}}">원문 보기</a><a href="{{카탈로그URL}}">카탈로그</a><span class="badge b-B">B · PD 추정</span></div>
  </div>
</div>

<h2 id="s3"><span class="no">III.</span> 영상 기록 — 프레임으로 먼저 본다</h2>
<!-- 영상 1건당 .film 1개 — 프레임 8~16장, 표제가 가린 장면을 드러낸다 -->
<div class="film">
  <h3>{{영상 제목 (원제)}}</h3>
  <div class="prov sans">{{🇺🇸 NARA · RG 111 · 식별자}} · {{러닝타임}} · {{연대}} · 촬영 {{부대/촬영자}}</div>
  <p>{{왜 중요한가 — 표제와 실제의 간극 2문장}}</p>
  <div class="filmstrip">
    <figure class="frame"><img src="data:image/jpeg;base64,{{BASE64}}" alt="{{장면}}"><figcaption><span class="tc">{{00:00:12}}</span>{{한 줄 장면 설명}}</figcaption></figure>
    <!-- 프레임 반복 (tc 타임코드+한 줄 설명) -->
  </div>
  <div class="hint sans">← 좌우 스크롤 · {{N}}장</div>
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
  <table>
    <thead><tr><th>목적</th><th>쿼리</th><th>실행</th></tr></thead>
    <tbody><tr><td>{{목적}}</td><td><code>{{쿼리}}</code></td><td><a href="{{URL인코딩된 검색URL}}">검색 실행</a></td></tr></tbody>
  </table>
  </div>
</details>
<div class="note"><strong>0건 ≠ 부재.</strong> {{미전산화 + 인접 상자·피스 추가 조사 권고}}</div>
<details>
  <summary>종합 색인 · 최신 연구</summary>
  <div class="inner"><ul class="src"><li><a href="{{URL}}">{{제목}}</a> — {{한 줄 설명}}</li></ul></div>
</details>

<h2 id="s6"><span class="no">VI.</span> 권리 판정과 게재 윤리</h2>
<p>{{판정 요약+법적 근거}}. <strong>출판 전 인간 최종 확인 필수</strong>, <span class="badge b-D">D등급</span> 공개 금지. {{민감 주제면 존엄·게재윤리 4단계 문구}}</p>

<!-- Ⅶ(선택) 카드뉴스 갤러리 — 미제작 시 절·toc 삭제 -->
<h2 id="s7"><span class="no">VII.</span> 카드뉴스 — 이 발굴을 {{N}}장으로</h2>
<p>{{소개 1문장 — 커버=히어로 실물, 출처 대장 공유}}</p>
<div class="cards-grid">
  <figure><img src="data:image/jpeg;base64,{{카드1 축소본}}" alt="카드 1 — 커버"><figcaption>{{1 — 커버 한 줄 설명}}</figcaption></figure>
  <!-- 카드 반복 (권장 8장, 축소 maxdim 540) — 무크롭 전체 노출·카드별 figcaption 필수, 잘림·겹침 금지 -->
</div>
<p class="small">게시용 1080×1080 PNG 원본 + 캡션(caption.txt) + 이미지 출처 대장(sources.txt)을 보고서와 함께 납품.</p>

<!-- Ⅷ 더 보기 — 접속 확인 링크만, 미확보 카테고리는 명시 -->
<h2 id="s8"><span class="no">VIII.</span> 더 보기 — 관련 기사·콘텐츠</h2>
<p>{{한 줄 — 발굴과 현재의 기억}}</p>
<ul class="src">
  <li>📰 <a href="{{URL}}">{{기사 제목}}</a> — {{매체(보도일)}} · {{한 줄 설명}}</li>
  <li>🏛️ <a href="{{URL}}">{{기관 아카이브·현장 기록}}</a> — {{기관명}}</li>
  <li>📚 <a href="{{URL}}">{{해설·백과}}</a> — {{한 줄 설명}}</li>
  <!-- 유튜브·인스타 등 SNS/영상: 검증된 공식 게시물만. 미확보 시 아래 문구로 대체 -->
</ul>
<p class="small">※ {{미확보 카테고리 명시 + 추천 검색어}} · 전부 {{확인일}} 접속 확인.</p>

<div class="sources">
  <h2 style="margin:0 0 10px;font-size:17px">기록 출처 <span class="small">Archives cited</span></h2>
  <ul class="src">
    <li>{{국기}} <b>{{기관 정식명}}</b> — {{청구정보·이용조건}} · <a href="{{URL}}">{{도메인}}</a></li>
    <!-- 전 기관: 국기·정식명·청구정보·이용조건·링크 -->
  </ul>
</div>

<footer>
  발굴 방법론: KOREA ARCHIVE 통합검색 · 모든 링크·수치 {{확인일}} 도구 확인 · 이미지 출처 표기 유지.{{웹 산출이면: 이미지는 기관 공개 URL 참조임을 명기}}
</footer>
</div>
</body>
</html>`;

const CAROUSEL_RULES = `인스타 캐러셀 카드뉴스 제작 규칙 (12) — 1080×1080 PNG 6~10장 + 캡션·출처 대장
1. 파이프라인: 재료 파악 → 발굴조사(실존 대상이면) → 실물 이미지 소싱·라이선스 판정 → 서사 설계 → HTML 카드 작성 → 1080×1080 렌더 → 전 카드 육안 검수(생략 금지) → 캡션·해시태그
2. 서사 아크(장수에 맞게 병합, 기본 8장): ①커버 후킹(실물 풀블리드+숫자·반전 훅) ②디테일/원리 확대 ③~⑥증거(실물 이미지 카드 — 심장) ⑦정리(표·지도·타임라인) ⑧검증 노트 ⑨따라하기(재현 단계) ⑩CTA(행동 1개+댓글 유도+출처·권리 고지)
3. 실물 이미지가 신뢰를 만든다: 주제가 실존 대상(기관·유물·사건·인물)이면 퍼블릭 도메인/공공누리 실물을 능동 발굴해 쓴다. cross_search media 열의 직링크(실조회 검증 원본) 우선, 기관 비식별(블러)판 제공 시 우선 사용
4. 이미지 카드마다 출처 캡션(.credit) 필수: "출처: 기관 정식명, 식별번호 (라이선스)" — 식별번호를 알면서 생략하면 부정확한 출처다. 시리즈 계보(partOf)를 알면 "기관 › 시리즈" 1줄 병기(데이터의 partOf 값 그대로). 이미지별 출처 대장(sources.txt) 동봉, 라이선스 미확정이면 '게시 전 [권리자] 확인' 안내
5. 사실 검증: 제목만 믿지 않는다 — 생산일자·원판번호·카탈로그 API 원문까지 대조. 실증 안 된 어록 금지(전승은 '전해지는 말'). 검증 불가한 비교 대신 산술
6. 레이아웃 다양화: 같은 아키타입 반복 금지 — 한 캐러셀에 3개 이상 혼합(풀블리드 커버·타임라인·인물+폴라로이드·문서 인용 docquote·빅넘버·목록 reel·파노라마 필름스트립·부채꼴 스택)
7. 겹침·잘림 절대 금지(최다 결함): 모든 콘텐츠는 .col(하단 안전영역 150px) 안에 — 페이지번호·브랜드와 구조적으로 안 겹치게. credit에 margin-top:auto 금지(고정 마진). 이미지는 고정 높이+object-fit:cover. 세로 예산: 키커+제목 제외 콘텐츠 가용 ~650px — 초과하면 잘린다
8. 검증 노트 카드가 차별점: 조사 중 발견한 반전(오표기·훈격 정정·인접 발굴)을 한 장으로 — 콘텐츠의 백미이자 신뢰 장치
9. 민감 주제(포로·사망자·학살·희생자): 존엄을 지키는 서술 + 보수적 이미지 선택 + 캡션에 존엄 문구
10. 캡션(caption.txt): 본문은 한 줄 한 호흡(긴 문단 금지), 질문형 오프닝, 한두 문장마다 빈 줄, 이모지 불릿 — 스크롤을 멈추는 시각 리듬. 릴스용 짧은 버전 + 해시태그(본문 ~20+첫 댓글 확장) + 게시 전 체크리스트
11. 렌더·검수: 아래 디자인 시스템의 .card(1080×1080)를 그대로 복사해 채우고, 카드별로 1080×1080 이미지로 캡처한다. 환경별 경로 — ①로컬(Claude Code): 헤드리스 브라우저 렌더 스크립트 ②웹·모바일: 카드 HTML을 아티팩트로 만들어 보여주고, Canva 커넥터가 있으면 report_template(kind='canva_prompts')의 프롬프트로 Canva 디자인 생성·교정 후 Canva에서 페이지별 PNG 내보내기(완전한 웹 완결 경로). 렌더 후 전 장을 눈으로 검수 — 하단 겹침·세로 넘침·이미지 적합성(빈 컷·워터마크·무관 컷)·어색한 줄바꿈. 결함 카드만 수정해 재렌더
12. 납품: 순서 번호 PNG 전체 + caption.txt + sources.txt + 자기완결 carousel.html. 발굴 보고서와 병행 제작 시 보고서 '카드뉴스' 절에 무크롭(.cards-grid)으로 임베드 — report_template(kind='report') 규칙 17 참조`;

const CAROUSEL_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>카드뉴스 디자인 시스템 v2 — 시작 템플릿</title>
<!--
  검증된 고대비 디자인 시스템. 이 파일을 복사해 카드를 채운다.
  팔레트는 :root만 바꾸면 전체 적용 (기본: 순흑+크림+크림슨/골드 — 아카이브·스토리텔링 무드.
  밝은 브랜드면 --bg를 밝게, --cream을 잉크색으로 뒤집는다).
  이미지는 {{img:경로|maxdim=760|q=72}} 토큰 (scripts/make_carousel.py가 처리).
  레이아웃 선택 기준은 references/layouts.md 참조.

  ★ 핵심 안전 규칙 ★
  - 모든 카드 콘텐츠는 <div class="col"> 안에 — 하단 안전영역 150px가 페이지번호·브랜드
    겹침을 구조적으로 막는다 (이 겹침이 실전에서 가장 잦은 결함이었다)
  - credit에 margin-top:auto 금지 — 고정 마진 사용
  - 이미지는 고정 height + object-fit:cover
-->
<style>
  :root{
    --bg:#0a0c10; --panel:#14171d; --crimson:#e03540; --gold:#e8b45a; --cream:#faf3e3;
    --sub:#8d94a2; --green:#5fd07f; --amber:#e8b45a;
  }
  *{box-sizing:border-box; margin:0; padding:0;}
  body{background:#000; font-family:'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif; padding:40px; color:var(--cream);}
  .card{width:1080px; height:1080px; margin:0 auto 56px; position:relative; overflow:hidden;
        background:var(--bg); box-shadow:0 10px 60px rgba(0,0,0,.7);}
  /* 콘텐츠 컬럼 — 하단 안전영역 150px (brand/pageno와 절대 안 겹침) */
  .col{position:relative; z-index:4; height:100%; display:flex; flex-direction:column; padding:70px 86px 150px;}
  /* 장식 */
  .grain{position:absolute; inset:0; pointer-events:none; opacity:.45; mix-blend-mode:overlay;
    background-image:repeating-linear-gradient(0deg, rgba(255,255,255,.03) 0 1px, transparent 1px 3px);}
  .frame{position:absolute; inset:24px; border:2px solid rgba(232,180,90,.55); pointer-events:none;}
  .corner{position:absolute; width:34px; height:34px; border:4px solid var(--gold);}
  .c-tl{top:16px; left:16px; border-right:none; border-bottom:none;}
  .c-tr{top:16px; right:16px; border-left:none; border-bottom:none;}
  .c-bl{bottom:16px; left:16px; border-right:none; border-top:none;}
  .c-br{bottom:16px; right:16px; border-left:none; border-top:none;}
  /* 타이포 */
  .kicker{display:inline-block; background:var(--crimson); color:#fff; font-weight:900;
          letter-spacing:.28em; font-size:24px; padding:13px 30px 13px 36px;}
  h1{font-size:80px; line-height:1.24; font-weight:900; word-break:keep-all; color:#fff;}
  h2{font-size:54px; line-height:1.27; font-weight:900; word-break:keep-all; color:#fff;}
  .gold{color:var(--gold);} .red{color:var(--crimson);}
  .lead{font-size:31px; line-height:1.6; word-break:keep-all; color:#e5ddc9;}
  .lead b{color:var(--gold);}
  .credit{font-size:19px; color:var(--sub); line-height:1.5;}
  .divider{height:6px; width:150px; background:linear-gradient(90deg,var(--gold),var(--crimson)); margin:24px 0;}
  .years{font-size:26px; color:var(--gold); font-weight:700; letter-spacing:.05em; margin:4px 0 12px; word-break:keep-all;}
  /* 하단 고정 표기 */
  .pageno{position:absolute; bottom:46px; right:76px; font-size:23px; color:var(--sub); letter-spacing:.12em; z-index:9;}
  .brand{position:absolute; bottom:46px; left:76px; font-size:23px; color:var(--sub); z-index:9;}
  .stamp{position:absolute; border:5px solid var(--crimson); color:var(--crimson); border-radius:10px;
         padding:10px 22px; font-weight:900; font-size:28px; letter-spacing:.1em;
         transform:rotate(-8deg); background:rgba(224,53,64,.08); z-index:6;}
  /* 사진 프레임 */
  .polaroid{background:#fbf8f1; padding:14px 14px 0; box-shadow:0 14px 34px rgba(0,0,0,.55);}
  .polaroid img{display:block; width:100%;}
  .polaroid .cap{font-size:20px; color:#3a3f49; padding:10px 4px 12px; font-weight:700; text-align:center; word-break:keep-all;}
  .tape{position:absolute; width:140px; height:38px; background:rgba(232,180,90,.75); box-shadow:0 2px 8px rgba(0,0,0,.3); z-index:3;}
  .shot{background:#fff; padding:10px; box-shadow:0 18px 44px rgba(0,0,0,.7);}
  .shot img{display:block; width:100%;}
  .shot .cap{font-size:20px; color:#3a3f49; padding:10px 4px 4px; font-weight:700; text-align:center; word-break:keep-all;}
  /* 파노라마 필름스트립 */
  .pano{border-top:16px solid #000; border-bottom:16px solid #000; background:#000; position:relative;
        box-shadow:0 14px 40px rgba(0,0,0,.6);}
  .pano:before,.pano:after{content:''; position:absolute; left:0; right:0; height:14px;
    background-image:repeating-linear-gradient(90deg, #fff 0 22px, transparent 22px 44px); opacity:.9;}
  .pano:before{top:-15px;} .pano:after{bottom:-15px;}
  .pano .row{display:flex; gap:6px;}
  .pano img{flex:1; height:300px; object-fit:cover; display:block; filter:contrast(1.15) brightness(1.05);}
  /* 시리즈 스트립 */
  .strip{display:flex; gap:10px;}
  .strip img{flex:1; height:130px; object-fit:cover; border:2px solid #3a4152;}
  /* 목록·상태 */
  .reel{background:var(--panel); border:1px solid #262b35; border-left:10px solid var(--gold); padding:16px 24px; margin:11px 0;}
  .reel .no{font-size:24px; font-weight:900; color:var(--gold); letter-spacing:.06em; font-family:Consolas,Menlo,monospace;}
  .reel .t{font-size:26px; font-weight:700; margin-top:4px; word-break:keep-all; line-height:1.4; color:#f2ecdb;}
  .reel .d{font-size:20px; color:var(--sub); margin-top:4px; word-break:keep-all;}
  .reel.locked{border-left-color:var(--crimson);}
  .badge{display:inline-block; border-radius:30px; padding:4px 16px; font-size:19px; font-weight:900; margin-left:8px; vertical-align:middle;}
  .b-lock{background:#38151a; color:#ff7a83; border:1px solid #ff7a83;}
  .b-half{background:#3a2c12; color:var(--amber); border:1px solid var(--amber);}
  .b-open{background:#153019; color:var(--green); border:1px solid var(--green);}
  .org{background:var(--panel); border:1px solid #262b35; border-left:8px solid var(--gold);
       padding:13px 22px; margin:10px 0; display:flex; justify-content:space-between; align-items:center; gap:16px;}
  .org .name{font-size:28px; font-weight:900; word-break:keep-all;}
  .org .name small{display:block; font-size:19px; color:var(--sub); font-weight:400; margin-top:2px;}
  .org .hits{font-size:26px; font-weight:900; white-space:nowrap;}
  .hit-y{color:var(--green);} .hit-w{color:var(--amber);} .hit-n{color:#ff7a83;}
  /* 3단계 분류 */
  .tier{flex:1; background:var(--panel); border:1px solid #262b35; border-top:10px solid; padding:24px;}
  .tier .icon{font-size:52px;}
  .tier .t{font-size:29px; font-weight:900; margin-top:10px; word-break:keep-all;}
  .tier .d{font-size:21px; color:var(--sub); margin-top:6px; line-height:1.5; word-break:keep-all;}
  /* 타임라인 */
  .tl{border-left:5px solid var(--gold); margin:20px 0 0 24px; padding-left:36px;}
  .tl .ev{margin:0 0 24px; position:relative;}
  .tl .ev:before{content:''; position:absolute; left:-47px; top:8px; width:18px; height:18px; border-radius:50%;
    background:var(--crimson); border:4px solid var(--bg); box-shadow:0 0 0 3px var(--gold);}
  .tl .yr{font-size:29px; font-weight:900; color:var(--gold); letter-spacing:.04em;}
  .tl .tx{font-size:27px; line-height:1.5; color:#e5ddc9; word-break:keep-all; margin-top:2px;}
  /* 인용 */
  .quote{border-left:6px solid var(--gold); padding:14px 22px; margin-top:20px;
         font-size:29px; line-height:1.55; color:#f2ecdb; font-style:italic; word-break:keep-all; background:rgba(232,180,90,.07);}
  .docquote{border-left:6px solid var(--gold); padding:16px 24px; margin-top:18px;
            font-size:30px; line-height:1.6; color:#f2ecdb; word-break:keep-all; background:rgba(232,180,90,.07);}
  .docquote small{display:block; font-size:21px; color:var(--sub); margin-top:8px; font-style:normal;}
  /* 빅넘버 */
  .bignum{font-size:190px; font-weight:900; color:var(--gold); line-height:1; letter-spacing:-.02em;}
  /* 번호 리스트 */
  .li{display:flex; gap:22px; align-items:flex-start; margin:22px 0; font-size:31px; line-height:1.5; word-break:keep-all; color:#eee6d2;}
  .li .n{flex:0 0 54px; height:54px; border-radius:50%; background:var(--crimson); color:#fff;
         font-weight:900; font-size:27px; display:flex; align-items:center; justify-content:center;}
  .li b{color:var(--gold);}
  /* 부채꼴 스택 — 제목 아래에만 배치할 것 */
  .fanwrap{position:relative; height:480px;}
  .fcard{position:absolute; width:600px; background:#f5efdf; color:#20242c; padding:22px 26px;
         box-shadow:0 18px 40px rgba(0,0,0,.65); border:1px solid #d8d0bc;}
  .fcard .no{font-family:Consolas,Menlo,monospace; font-weight:900; font-size:25px; color:#b3262f;}
  .fcard .t{font-size:25px; font-weight:900; margin-top:4px; line-height:1.35; word-break:keep-all;}
  .fcard .d{font-size:19px; color:#5a6070; margin-top:4px;}
</style>
</head>
<body>

<!-- 예시 1 · 풀블리드 커버: 실물 이미지 + 그라디언트 + 훅 -->
<div class="card">
  <img src="{{img:cover.jpg|maxdim=1000|q=76}}" alt=""
       style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:center 30%; filter:contrast(1.2) brightness(.95) sepia(.2);">
  <div style="position:absolute; inset:0; background:linear-gradient(180deg, rgba(0,0,0,.25), rgba(0,0,0,.92) 68%);"></div>
  <div class="grain"></div><div class="frame"></div>
  <div class="col">
    <div><span class="kicker">키커 문구</span></div>
    <div class="stamp" style="top:142px; right:82px;">도장</div>
    <div style="margin-top:auto;">
      <h1>훅 첫 줄,</h1>
      <h1 class="gold">숫자·반전이 있는 둘째 줄</h1>
      <div class="divider"></div>
      <p class="lead">부제 — <b>핵심어</b> 강조. 이미지의 정체와 연결.</p>
      <p class="credit" style="margin-top:16px;">출처: (정식 명칭, 라이선스)</p>
    </div>
  </div>
  <div class="brand">브랜드명</div><div class="pageno">1 / 10</div>
</div>

<!-- 예시 2 · 파노라마 필름스트립 -->
<div class="card">
  <div class="grain"></div><div class="frame"></div>
  <div class="col">
    <div><span class="kicker">장면 ①</span></div>
    <h2 style="margin:22px 0 8px;">제목 — <span class="gold">세 컷을 펼치다</span></h2>
    <div class="pano" style="margin-top:20px;">
      <div class="row">
        <img src="{{img:f1.jpg|maxdim=600|q=74}}"><img src="{{img:f2.jpg|maxdim=600|q=74}}"><img src="{{img:f3.jpg|maxdim=600|q=74}}">
      </div>
    </div>
    <p class="lead" style="margin-top:24px; font-size:29px;">컷1 — 컷2 — 컷3.<br>한 문장 해설로 <b>움직임</b>을 전달.</p>
    <p class="credit" style="margin-top:16px;">출처 · 링크</p>
  </div>
  <div class="brand">브랜드명</div><div class="pageno">4 / 10</div>
</div>

<!-- 예시 3 · 부채꼴 스택 (제목 아래에만!) -->
<div class="card">
  <div class="grain"></div><div class="frame"></div>
  <div class="col" style="padding-bottom:140px;">
    <div><span class="kicker">🔴 잠긴 기록</span></div>
    <h2 style="margin:20px 0 6px;">제목은 스택 위에,<br><span class="red">스택은 제목 아래에</span></h2>
    <div class="fanwrap" style="height:500px; margin-top:30px;">
      <div class="fcard" style="top:300px; left:0; transform:rotate(-6deg);"><div class="no">ID-004</div><div class="t">네 번째 기록</div><div class="d">부가 정보</div></div>
      <div class="fcard" style="top:210px; left:120px; transform:rotate(4deg); z-index:2;"><div class="no">ID-003</div><div class="t">세 번째 기록</div><div class="d">부가 정보</div></div>
      <div class="fcard" style="top:115px; left:230px; transform:rotate(-3deg); z-index:3;"><div class="no">ID-002 <span class="badge b-lock">미공개</span></div><div class="t">두 번째 기록</div><div class="d">부가 정보</div></div>
      <div class="fcard" style="top:20px; left:330px; transform:rotate(5deg); z-index:4;"><div class="no">ID-001 <span class="badge b-lock">미공개</span></div><div class="t">맨 위 카드는 정보 전부 보이게</div><div class="d">아래 카드는 일부만 보여도 OK</div></div>
    </div>
    <p class="lead" style="margin-top:16px; font-size:27px;">마무리 한 줄.</p>
  </div>
  <div class="brand">브랜드명</div><div class="pageno">7 / 10</div>
</div>

<!-- 예시 4 · 인물 카드 -->
<div class="card">
  <div class="grain"></div><div class="frame"></div>
  <div class="col">
    <div><span class="kicker">첫 번째 이름</span></div>
    <div style="display:flex; gap:40px; margin-top:28px; align-items:flex-start;">
      <div style="position:relative; flex:0 0 380px;">
        <div class="tape" style="top:-16px; left:32%; transform:rotate(-4deg);"></div>
        <div class="polaroid"><img src="{{img:person.jpg|maxdim=760|q=75}}" style="height:520px; object-fit:cover; object-position:center 15%;"><div class="cap">사진 캡션</div></div>
      </div>
      <div style="flex:1; padding-top:6px;">
        <h2><span class="gold">이름</span></h2>
        <div class="years">1900 – 1950 · 직함</div>
        <p class="lead" style="font-size:29px;">업적 3~4줄.<br><b>핵심</b>만 강조.</p>
        <div class="quote">"실증된 어록만.<br>전승이면 '전해지는 말' 표기."</div>
      </div>
    </div>
    <p class="credit" style="margin-top:20px;">출처: (라이선스)</p>
  </div>
  <div class="brand">브랜드명</div><div class="pageno">2 / 10</div>
</div>

<!-- 예시 5 · 지도 여정 (SVG 약식 지도 + 마커 + 목록 병치) -->
<div class="card">
  <div class="grain"></div><div class="frame"></div>
  <div class="col" style="padding-bottom:140px;">
    <div><span class="kicker">지도 위의 여정</span></div>
    <h2 style="margin:20px 0 4px;">지점들을 <span class="gold">한 장</span>에</h2>
    <div style="display:flex; gap:30px; align-items:center; margin-top:6px;">
      <svg viewBox="0 0 380 560" style="flex:0 0 380px; height:600px;">
        <path d="M150 30 L235 46 L300 70 L306 108 L282 196 L322 268 L296 322 L282 392 L240 444 L188 462 L142 478 L120 400 L108 288 L100 176 L126 92 Z"
              fill="#14171d" stroke="#e8b45a" stroke-width="3"/>
        <line x1="70" y1="218" x2="330" y2="218" stroke="#e03540" stroke-width="3" stroke-dasharray="14 10"/>
        <circle cx="152" cy="208" r="13" fill="#5fd07f"/>
        <text x="30" y="168" fill="#5fd07f" font-size="24" font-weight="bold">지점A</text>
        <circle cx="170" cy="248" r="13" fill="#e03540"/>
        <text x="200" y="258" fill="#ff7a83" font-size="24" font-weight="bold">지점B</text>
        <path d="M152 208 Q150 230 170 248" stroke="#faf3e3" stroke-width="2" stroke-dasharray="4 6" fill="none"/>
      </svg>
      <div style="flex:1;">
        <div class="reel" style="margin-top:0;"><div class="no">지점A</div><div class="t">설명</div><div class="d">🟢 상태</div></div>
        <div class="reel"><div class="no">지점B</div><div class="t">설명</div><div class="d">🔴 상태</div></div>
        <p class="credit" style="margin-top:14px;">라벨은 마커와 안 겹치게 — 렌더 후 확인</p>
      </div>
    </div>
  </div>
  <div class="brand">브랜드명</div><div class="pageno">3 / 10</div>
</div>

</body>
</html>`;

const CANVA_PROMPTS = `# Canva 생성 프롬프트 모음 — KOREA ARCHIVE 홍보물

발굴 조사 결과를 Canva AI(generate-design)로 홍보물화할 때 쓰는 검증된 프롬프트 템플릿.
2026-08-13 그로스터 연대 포스터 실전에서 검증·교정된 버전이다.

## 공통 원칙 (모든 프롬프트에 적용 — 어기면 실패한다)

1. **실물 자산 필수**: 반드시 asset_ids로 실물 기록 사진을 전달한다(공개 URL → upload-asset-from-url).
   자산 없이 역사 주제를 생성시키면 **가짜 병사·가짜 유물 이미지**가 나온다 (실측: 후보 4개 중 3개가 가짜 이미지 사용).
2. **AI 인물·역사장면 생성 금지 문구**를 프롬프트에 명시: "Do NOT generate any people, soldiers,
   or war imagery — only use the provided photos plus typographic and abstract archival motifs."
3. **한국어 텍스트는 반드시 환각 검수**: 생성 결과의 한국어는 깨지거나("사진 한 장 활서")
   광고 관용구가 끼어든다("20% 할인 제공"). 생성 후 **read-design → edit-design(replace_text)으로
   전 문구를 검증 카피로 교체**하는 것까지가 제작 절차다.
4. **후보 선별 기준**: 후보 중 제공한 실물 자산을 실제로 쓴 것만 채택. 하나도 없으면 재생성.
5. **카피는 조사에서**: 훅·수치·식별자는 보고서에서 검증된 것만 슬롯에 넣는다. 출처 크레디트 슬롯은 생략 불가.
6. **필기체 라틴 폰트 주의**: 영문이 스크립트체로 나오면 해당 요소를 delete_element 후 add_text로 재삽입(폰트 변경 연산 없음).

## 공통 스타일 블록 (프롬프트에 붙여넣기)


Mood: prestigious history journal — dignified, quiet, powerful. NOT playful, NOT colorful advertising.
Color palette: aged cream paper (#f5f1e8), deep crimson (#8a3033), antique gold (#a8853c), near-black ink (#211d18).
Subtle paper texture, thin double-rule borders like a newspaper masthead.
Treat the provided archival photographs with respect: duotone/sepia, generous margins, thin gold frame.
Do NOT generate any people, soldiers, or war imagery — only the provided photos + typographic archival motifs
(reference-code typography, subtle stamp marks, thin rules).
Typography: elegant Korean serif (명조) headline, clean sans labels. All Korean text professionally typeset.
Full-bleed, no watermark, no mockup.


## 1. 발굴 보고 포스터 (design_type: poster) — 검증본


Create a premium archival-journal style vertical poster for a historical records discovery report.
[공통 스타일 블록]
Top small kicker: 발굴 보고 · {{시기·주제}}
Large headline (2 lines): {{훅 헤드라인 — 예: 임진강에 남은 / 이름들}}
Subheadline: {{조사 훅 문장 — 예: 「할아버지가 참전한 부대를 찾아줘」— 한국어 한 문장이 연 두 나라 기록 65건}}
Credential lines with thin gold rules:
· {{검증 수치 1 — 예: 무공훈장 추천서 49건, 이름·군번 그대로}}
· {{검증 수치 2 — 예: 키워드 0건의 부대 일지, 인접 채굴로 발견}}
· {{검증 수치 3 — 예: 포로수용소에서 새긴 석조각, 한국에 실물}}
Bottom CTA: KOREA ARCHIVE 통합검색 — 발굴 보고서 공개
Tiny credit: 사진: {{기관 정식명}} · 실물 기록


## 2. 전시·추모행사 안내 포스터 (design_type: poster)


Create an announcement poster for a memorial/exhibition event, archival-journal style.
[공통 스타일 블록]
Kicker: {{행사 구분 — 예: 추모 · 전시 안내}}
Headline: {{행사명}}
Date/venue block in clean sans with gold rules: {{일시}} · {{장소}}
One-line story hook: {{이 행사의 역사적 근거 한 문장 — 검증된 사실만}}
Bottom: 주최 {{기관}} · 문의 {{연락처}} / Tiny credit: 사진: {{출처}}


## 3. 카드뉴스 시리즈 예고 (design_type: instagram_post)


Create a series-teaser social post, archival-journal style, 4:5 portrait.
[공통 스타일 블록]
Kicker: 연재 예고
Headline: {{시리즈명}} — 전 {{N}}부작
Use the provided cover photos as a small filmstrip row (do not crop faces).
Schedule lines: {{1부 제목 · 공개일}} / {{2부 제목 · 공개일}} / ...
CTA: 팔로우하고 첫 공개를 받아보세요
Tiny credit: 사진: {{출처 목록}}


## 4. 인물 조명 포스터 (design_type: poster)


Create a single-figure tribute poster, archival-journal style.
[공통 스타일 블록 + 인물 사진 존엄 조항: use the provided portrait respectfully, no colorization, no AI retouching]
Kicker: {{기록이 증언하는 사람}}
Headline: {{인물명}}
Fact lines (verified only): {{직위·부대}} / {{검증된 행적 1}} / {{검증된 행적 2 — 식별자 포함}}
Quote block only if verified from documents: {{문서 판독 인용 or 생략}}
Bottom: 기록 {{참조코드}} · KOREA ARCHIVE 통합검색 / Tiny credit: {{출처}}
※ 포로·사망자·희생자는 게재윤리 4단계 적용 — 존엄 우선, 확신 없으면 만들지 않는다.


## 5. 기록영상 공개 알림 (design_type: instagram_post)


Create a film-release announcement post, archival cinema mood (dark charcoal #171412 background variant).
[공통 스타일 블록 — 배경만 다크, 크림 텍스트]
Kicker: 기록영상
Headline: {{영상 제목}} ({{연대}})
Use provided real film frames as a horizontal filmstrip with timecode chips.
One line: {{표제가 가린 내용 훅 — 예: 카탈로그 한 줄 뒤에 숨어 있던 장면들}}
CTA: ▶ 원본 보기 — {{기관}} 카탈로그
Tiny credit: {{RG·식별자·출처}}


## 6. A4 리플릿 (design_type: flyer_a4 / import 시 a4)


Create a single-page A4 information leaflet, archival-journal style, print-ready.
[공통 스타일 블록]
Masthead: KOREA ARCHIVE 통합검색 — 기록 발굴 보고
Headline + standfirst: {{보고서 제목·요지 2문장}}
Three-column facts: {{핵심 기록 3건 — 식별자·한 줄 설명}}
Photo band: provided real photos with captions
Footer: 전체 보고서 QR/URL {{링크}} · 출처 총람 요약 · {{확인일}}


## 생성 후 체크리스트 (생략 금지)

1. 후보 전부 썸네일 검수 — 실물 자산 사용 여부·가짜 이미지 혼입 확인
2. 채택본 create-design-from-candidate → read-design(open_transaction)
3. **모든 한국어 문구를 검증 카피로 replace_text** (환각 문구는 반드시 있다)
4. 겹침·줄바꿈·폰트(필기체 라틴) 검수 → 교정 → commit
5. 출처 크레디트 존재 확인 — 없으면 add_text로 추가

# 7. 커머셜 임팩트 포스터 (design_type: poster) — 화려·그래픽·패셔너블

Create a BOLD, commercial, fashion-forward vertical poster — streetwear-drop / fashion-magazine energy, maximalist, NOT quiet.
Color blocking: deep crimson #8a3033 + warm gold #e8b45a + cream #f5f1e8 + black. Oversized Korean display typography,
the provided REAL photo as duotone hero inside a bold geometric frame, graphic accents (waves, starbursts, sticker badges,
thick rules, halftone). CRITICAL: only provided real photos — no AI people or history scenes.
Top badge: {{발굴 완료}} / Huge headline: {{찾았다, N건}} / Sub: {{훅 한 줄}} / Stat badges 3: {{검증 수치}} /
CTA bar: 발굴 보고서 공개 — KOREA ARCHIVE 통합검색 / Tiny credit: {{사진 출처·식별자}}
검증 실측: 후보 4개 중 3개가 가짜 이미지 — 실물 사용 후보만 채택하고 환각 문구는 전량 교정할 것.`;

const CITATION_GUIDE = `인용 형식 가이드 — 한국사DB·국회도서관 (khdb-citation·nanet-citation 스킬의 서버판. 사용자의 논문·보고서 인용 요청에 이 형식을 적용하라)

■ 한국사데이터베이스(db.history.go.kr) — 국사편찬위원회
· 영구 인용 URL: http://db.history.go.kr/id/[기사ID]  (검색 URL은 POST라 재현 불가 — 반드시 /id/ 형식)
· 각주(국내 표준): 저자, 〈[문서 제목]〉 작성일.(편찬기관 편, 연도, 《[총서명 권호]》) http://db.history.go.kr/id/[기사ID] (accessed YYYY.M.D.)
· 참고문헌: [편찬기관]. 『[총서명]』. [권호]. 국사편찬위원회 한국사데이터베이스(http://db.history.go.kr), 검색일: YYYY.MM.DD.
· 연대기(실록·승정원일기): 『[자료명]』 [왕명 연호년 월일(간지)], 국사편찬위원회 한국사데이터베이스, http://db.history.go.kr/id/[기사ID] (검색일: YYYY.MM.DD.)
· 예: 조선총독부 고등법원 예심계, 〈한용운 신문조서〉 1919.8.27.(국사편찬위원회 편, 1990, 《한민족독립운동사자료집 12》) http://db.history.go.kr/id/hd_012r_0010_0310 (accessed 2026.3.13.)
· ★인용 2층위 필수 고지 — 법전·편람(조선시대법령자료)은 한문 원문 제공 → 원문 인용 가능(표점은 DB 형태·교감본 미대조 명기). 등록·일기(비변사등록·승정원일기)는 국역만 노출 → 한문 역구성은 학술 인용 불가.
· 출처 표기: KOGL — 국사편찬위원회 출처 표기.

■ 국회도서관 전자도서관(dl.nanet.go.kr)
· 영구 인용 URL: https://dl.nanet.go.kr/SearchDetailView.do?cn=[CN코드]  (CN코드가 식별자 — 예 KDMT1201319543)
· 학위논문 각주: 저자명, 「논문 제목」, 학위논문(석사/박사), 대학교 대학원 학과명, YYYY.M, 쪽수.
· 학위논문 참고문헌: 저자명. 「논문 제목」. 학위논문(석사/박사). 대학교 대학원 학과명, YYYY. 대한민국 국회도서관 전자도서관(https://dl.nanet.go.kr/SearchDetailView.do?cn=CN코드), 검색일: YYYY.MM.DD.
· APA: 저자성, 이름. (연도). 제목 [학위 종류, 대학교명]. 국회도서관 전자도서관. https://dl.nanet.go.kr/SearchDetailView.do?cn=CN코드
· Chicago: 저자명, “제목” (학위논문(박사), 대학교명, 연도), 쪽수. https://dl.nanet.go.kr/SearchDetailView.do?cn=CN코드 (검색일: YYYY년 MM월 DD일).
· 단행본·학술기사·정부간행물도 같은 골격 — 「」=논문/기사, 『』=서명·총서명, CN코드 URL 동봉.

공통 원칙: 검색일 명기 · 링크는 실확인한 것만 · 기사ID/CN코드 없는 인용은 재현 불가이므로 금지.`;

const IIIF_GUIDE = "IIIF 갤러리 규칙 (v1.97 — 발굴 기록을 '연속으로 보는' 이미지 열람 경로. 로컬=build_iiif.py, 웹·모바일=cross_search format='iiif' + 아래 뷰어 골격)\n\n1. 공개 갤러리(바로 쓰기): https://changgi.github.io/korea-archive-mcp/iiif.html — 30곳 탐방·100선 실물 기록 800장(129 시리즈).\n   · 격자/연속/확대(딥줌) · '▶ 전체 연속 보기'(자동 넘김 3~12초·전체 화면·스페이스=멈춤) · 아래 띠 = 800장 전체(시리즈 경계 표시)\n   · 딥링크: iiif.html#s070/3 (070번 시리즈 3번째 장 확대) · 검색창=기관·기록·연대\n   · IIIF Presentation 3.0: iiif/collection.json(시리즈 129 매니페스트) · iiif/all.json(800장 한 매니페스트 — 처음부터 끝까지 이어보기) · iiif/m/sNNN.json(시리즈별)\n   · 자체 뷰어 KV (Korea Archive Viewer): https://changgi.github.io/korea-archive-mcp/kv.html?manifest=<URL> — 어떤 기관의 IIIF든(v2·v3 매니페스트·컬렉션) 딥줌·메타데이터·⧉ 나란히 비교(&compare=<URL2>)·회전·공유 링크(&canvas=n). 컬렉션을 열면 모든 기록의 모든 이미지가 한 줄로 이어진다(‹ ›·← →·전체 썸네일 띠·자동 넘김이 기록 경계를 넘어 계속, '전체 n / N' 표시). 기본값=우리 컬렉션 800장.\n   · 외부 뷰어: https://projectmirador.org/embed/?iiif-content=<매니페스트 URL> · https://uv-v4.netlify.app/#?manifest=<URL> — 우리 all.json·collection.json 모두 열림(실측). GitHub Pages가 CORS * 허용\n   · 계층: iiif/hierarchy.json(최상위 › 부 16 컬렉션 c/sNN-NN.json › 시리즈 129 매니페스트 › 이미지 800 캔버스) — 매니페스트마다 partOf(부·최상위), 캔버스마다 seeAlso(출처 대장 ledger.json)·고정성(sha256)·navDate·권리 근거·NARA 원 계보.\n   · 데이터: iiif/records.csv(장마다 식별자·연대·권리·계보·sha256·원 기관) · iiif/records.jsonld(RiC-O — RecordSet 계층·Record·Instantiation·PROV·owl:sameAs NARA).\n1-b. NARA→IIIF 브리지(v1.98 — NARA는 IIIF 미제공): https://korea-archive-mcp.vercel.app/iiif/nara/<NAID>/manifest.json — 맥락(ancestors 계보 metadata + partOf → 상위 /collection.json), 증거성(판독 시각·범위·내용 기술 sha256-16·이용/접근 제한 원문·소장단위·rights NoC-US/UND), 다매체(JPG·PNG 캔버스 + TIFF·PDF·영상 rendering), navDate. /collection.json=시리즈·파일단위 하위 기록(계보 대조로 확인한 것만) · /record.jsonld=RiC-O. 도구: nara_search(naid, output='iiif') · cross_search(format='iiif'|'manifest')가 NARA 결과에 이 주소를 단다.\n1-c. IIIF 브리지 2(v1.99 — IIIF 미제공 기관): https://korea-archive-mcp.vercel.app/iiif/{heritage|much|awm|commons}/<id>/manifest.json — heritage=국가유산청(id kdcd-asno-ctcd: 종목·지정번호·시대·소유·소재·해설+이미지 목록) · much=역사박물관(idnbr: 명칭·국적/시대·분류·재질·작가·크기·공공누리 유형 원문) · awm=호주 전쟁기념관(C-id: 수장번호·생산일·장소·저작권 만료 표시) · commons=위키미디어(File:…: 라이선스·작가·1600px+원본). 공통: 판독 시각·설명 지문(sha256-16)·원 기관 homepage·navDate. 정직한 식별자(KoreaArchiveMCP UA)로만 요청 — 자동 요청을 거부하는 기관은 기술적 불능으로 표시.\n1-f. 국립문화유산연구원 IIIF 브리지(v2.17): https://korea-archive-mcp.vercel.app/iiif/nrich/{ov-mseq|ksm-n|portrait-n|gwaebul-n}/manifest.json — 국외문화유산·금석문·국가지정 초상화·괘불의 원 기관 원본 이미지(변경 없이 연결, 공공누리 표기 그대로)·상세 항목·해설. cross_search(sources='nrich', format='iiif')가 자동으로 이 주소를 단다. 계층 컬렉션(v2.19): https://changgi.github.io/korea-archive-mcp/data/nrich/iiif/index.json(데이터셋 › 지역·소장처·분류 › 기록, 14종 12,019건) · 안내 https://changgi.github.io/korea-archive-mcp/data/nrich/index.html — KV는 큰 묶음을 48건씩 이어 불러온다.\n1-e. TNA→IIIF(v2.1 — 실제 계층 재구성): https://korea-archive-mcp.vercel.app/iiif/tna/<C-id>/manifest.json — Discovery parentId를 따라 '부서 › 분과 › 시리즈 › 피스'를 복원해 metadata·partOf(→ /iiif/tna/<부모>/collection.json)로, 참조번호·기간·소장·법적 지위·공개 상태·이전 참조·기술 지문·판독 시각. /collection.json=하위 기록(하위 계층=컬렉션, 말단=기록 봉투 — 추가 요청 없이 열림). KV는 하위 컬렉션 30개까지 자동 펼침(기관 서버 예의), 나머지는 폴더.\n1-d. 기록 봉투 IIIF(v2.0 — IIIF·브리지가 없는 모든 기록을 IIIF로 '구축'): cross_search(format='iiif')가 나머지 기록을 https://korea-archive-mcp.vercel.app/iiif/rec/<token>/manifest.json 로 만든다. 토큰=발견한 기록의 봉인된 기술(출처·식별자·연대·계열·원 기관 URL·원본 매체·발견 질의·발견 시각 — 서버 저장 없음). 계층이 없으면 '기관 › 계열 › 기록'을 구축해 명시, 증거=발견 경로·시각·봉투 지문(sha256-16), 원본 이미지가 있으면 그 이미지, 없으면 '기록 카드'(card.svg — 실제 기술 메타데이터만) 캔버스, /record.jsonld=RiC-O+PROV(발견 행위). format='manifest'의 iiif 필드도 모든 기록에 붙는다.\n   · 결과 계층(v2.2): 컬렉션은 '기관 › 계열'별 하위 컬렉션으로 묶인다(규장각은 사부분류 史部 › 政法類 › … 를 계열로) — KV는 계열 머리말과 함께 전체를 이어 보여 준다.\n   · 검색 결과 전체를 링크 하나로: 응답의 'KV 연속 보기' 링크(kv.html#c=<압축 컬렉션>) — 기관 IIIF·브리지·기록 봉투가 한 줄로 이어진다(서버 저장 없음, 링크=컬렉션). 전파는 이 링크 하나로.\n2. 기관별 IIIF 지원(실측 2026-11-22) — 원본은 기관 IIIF로 열면 원 해상도 딥줌:\n   · Internet Archive: https://iiif.archive.org/iiif/3/<identifier>/manifest.json\n   · Europeana: https://iiif.europeana.eu/presentation/<dataset>/<record>/manifest (v2)\n   · Gallica: https://gallica.bnf.fr/iiif/ark:/12148/<ark>/manifest.json (서버 IP 자동 조회는 403 — 브라우저 뷰어에서 열림)\n   · NDL: https://dl.ndl.go.jp/api/iiif/<PID>/manifest.json · 이미지 API https://dl.ndl.go.jp/api/iiif/<PID>/R<7자리>/full/1600,/0/default.jpg (PDM·internet 확인 후)\n   · 위키미디어 공용: IIIF 없음 → Special:FilePath/<파일>?width=1600 정지 이미지 캔버스\n   · NARA·TNA·국내 기관(국가기록원·NLK·장서각·규장각·AKS 등): IIIF 미제공 → 정지 이미지(직접 받은 원본) 캔버스, 이미지 게재 권리 확인 필수\n3. 웹·모바일 경로: cross_search(query, format='iiif') → (a) IIIF Collection — 결과 중 기관 IIIF가 있는 기록의 원 매니페스트 묶음 (b) 위키미디어 등 정지 이미지 Manifest. 이 JSON을 아래 뷰어 골격의 DATA에 넣어 아티팩트로 게시하면 '연속 이미지 뷰'가 된다. 로컬(Claude Code)=python3 docs/promo/build_iiif.py(출처 대장 ledger.json → collection·all·시리즈 매니페스트·이미지·썸네일).\n4. 권리 3단계(게재 시): ① 재이용 가능(PD·Unrestricted·CC·이용 제한 없음·기관 약관 허용) → 긴 변 1600px로 줄여 게재 ② 공공누리 제4유형 → 원본 파일을 크기·화질 변경 없이 그대로(자르기·글씨·필터 금지) ③ 웹페이지 캡처·이용 허가 필요(장서각·규장각·AKS All Rights Reserved·독립기념관 무표시) → 이미지 대신 원 기관 링크만. 캔버스마다 식별자·연대·소장·권리·보이는 것(metadata)과 원 기관 homepage를 단다. 포로·묘지·수형자 사진은 싣지 않는다. 협약기관(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터) 기록은 requiredStatement에 출처.\n5. 매니페스트 최소 구조(Presentation 3): {\"@context\":\"http://iiif.io/api/presentation/3/context.json\",\"id\":<URL>,\"type\":\"Manifest\",\"label\":{\"ko\":[..]},\"items\":[{\"id\":<canvas>,\"type\":\"Canvas\",\"width\":W,\"height\":H,\"label\":{\"ko\":[..]},\"metadata\":[{\"label\":{\"ko\":[\"권리\"]},\"value\":{\"ko\":[..]}}],\"items\":[{\"id\":<page>,\"type\":\"AnnotationPage\",\"items\":[{\"id\":<anno>,\"type\":\"Annotation\",\"motivation\":\"painting\",\"target\":<canvas>,\"body\":{\"id\":<이미지 URL>,\"type\":\"Image\",\"format\":\"image/jpeg\",\"width\":W,\"height\":H}}]}]}]}. 검증: https://presentation-validator.iiif.io/validate?version=3.0&url=<URL>\n6. 뷰어 골격(아티팩트·정적 페이지 — OpenSeadragon, v2/v3 매니페스트·컬렉션 모두 읽어 전체를 한 줄로 이어 넘김):\n<!DOCTYPE html><meta charset=\"utf-8\"><title>IIIF 연속 보기</title>\n<style>body{margin:0;background:#0b0c0f;color:#eee;font-family:system-ui}#v{height:78vh}#bar{display:flex;gap:8px;align-items:center;padding:8px}#strip{display:flex;gap:5px;overflow-x:auto;padding:6px}#strip img{height:56px;opacity:.5;cursor:pointer}#strip img.on{opacity:1;outline:2px solid #e0b04a}</style>\n<div id=\"bar\"><button id=\"p\">‹</button><button id=\"play\">▶ 자동</button><button id=\"n\">›</button><span id=\"t\"></span></div><div id=\"v\"></div><div id=\"strip\"></div>\n<script src=\"https://cdn.jsdelivr.net/npm/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js\"></script>\n<script>\nconst SRC = ['https://changgi.github.io/korea-archive-mcp/iiif/all.json']; // ← 매니페스트·컬렉션 URL 또는 cross_search format='iiif' JSON 객체\nconst L = (x) => typeof x === 'string' ? x : x ? (Object.values(x)[0] || [])[0] || x['@value'] || '' : '';\nasync function load(s, out) { const j = typeof s === 'string' ? await (await fetch(s)).json() : s;\n  const isColl = /Collection/.test(j.type || j['@type'] || '');\n  if (isColl) { for (const m of (j.items || j.manifests || [])) await load(m.items ? m : (m.id || m['@id']), out).catch(() => {}); return out; }\n  const cvs = j.items || (j.sequences && j.sequences[0].canvases) || [];\n  for (const c of cvs) { const b = c.items ? c.items[0].items[0].body : c.images[0].resource; const svc = [].concat(b.service || [])[0];\n    out.push({ t: L(j.label) + ' · ' + L(c.label), src: svc ? (svc.id || svc['@id']) + '/info.json' : { type: 'image', url: b.id || b['@id'] }, th: ((x) => x && (x.id || x['@id']))([].concat(c.thumbnail || [])[0]) || (svc ? (svc.id || svc['@id']) + '/full/,80/0/default.jpg' : b.id || b['@id']) }); }\n  return out; }\n(async () => { const A = []; for (const s of SRC) await load(s, A).catch((e) => console.warn('IIIF 불러오기 실패', s, e));\n  const v = OpenSeadragon({ id: 'v', prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@4.1.1/build/openseadragon/images/', showNavigator: true });\n  const st = document.getElementById('strip'); st.innerHTML = A.map((a, i) => `<img loading=\"lazy\" src=\"${a.th}\" data-i=\"${i}\">`).join('');\n  let k = 0, tm = null; const go = (i) => { if (i < 0 || i >= A.length) return; k = i; v.open(A[k].src); document.getElementById('t').textContent = `${k + 1}/${A.length} ${A[k].t}`;\n    st.querySelectorAll('img').forEach((x, j) => x.classList.toggle('on', j === k)); st.children[k].scrollIntoView({ inline: 'center', block: 'nearest' }); };\n  p.onclick = () => go(k - 1); n.onclick = () => go(k + 1); st.onclick = (e) => e.target.dataset.i && go(+e.target.dataset.i);\n  play.onclick = () => { if (tm) { clearInterval(tm); tm = null; play.textContent = '▶ 자동'; } else { tm = setInterval(() => go(k + 1 < A.length ? k + 1 : 0), 5000); play.textContent = '❚❚ 멈춤'; } };\n  document.onkeydown = (e) => { if (e.key === 'ArrowLeft') go(k - 1); if (e.key === 'ArrowRight') go(k + 1); }; go(0); })();\n</script>\n7. 산출 체크: 캔버스 수 = 게재 이미지 수 · 이미지마다 권리 표시 · 링크 전용 항목 목록 동봉 · 검증기 okay · 모바일(가로 넘침 없음) 확인."; // v1.97: IIIF 갤러리 규칙·기관별 IIIF·권리 3단계·뷰어 골격(웹·모바일 동등성)
const VIDEO_GUIDE = `영상 기록 장면 해설 규칙 (v1.93 — 영상 분석 기능의 서버판. 로컬=analyze_video.py keyscenes, 웹·모바일=IA 시각 코드 프레임)

1. 영상 찾기: cross_search/nara_search로 영상 기록 → 권리 실확인(judge_rights(naid) — Unrestricted=A, 연방 저작물 Undetermined=B 명기, Restricted=장면 사용 금지·제목만 인용). 협약기관(koreanwar) 영상은 입수처 NARA NAID로 원본 권리 확인.
2. 장면 추출 — 환경별 경로:
   · 로컬(Claude Code): python analyze_video.py keyscenes <영상|URL> --out <dir> — ffmpeg scene 전환 탐지 → 장면별 가장 선명한 프레임(원본 해상도, 업스케일 금지) · 리더/암전 자동 제외 → scenes.json(start·end·dur·대표 시각) + _keyscenes.jpg 밀착 인화.
   · 웹·모바일: ia_search(identifier=<IA 영상 id>) → 【영상 장면 프레임】 시각 코드 목록(IA 파생 썸네일 .thumbs/<id>_<초>.jpg)을 열어 장면을 본다. NARA 사본(예: 428-npc-170)은 IA에 같은 번호로 있는 경우가 많다(cross_search nara,ia가 [nara+ia]로 묶음). KTV(ehistory.go.kr) 영상은 nedb_search(mode=ktv, view URL)의 해설 목록(장면 순서)을 시각 코드 대용으로 쓴다.
3. 장면 해설은 '보이는 것만': 인물 수·복장·장비(전차·함정·선체 번호)·지형·화면 속 문자. 불명은 '판독 불가'. 사건 해석(무엇을 위한 폭파인가 등)은 기록 표제·기술(NARA Scope and Content·KTV 해설)에서 인용할 때만, 인용 출처를 붙인다.
4. 장면 해설 카드(1080×1080): 프레임 원본을 가득(object-fit cover, 업스케일 시 흐림 감수 대신 원 크기 근처 배치) + 좌상단 시각 코드 칩(mm:ss) + 하단 2줄 해설 + 장면 번호(n/N) + 출처 한 줄(기관·식별자·권리). 영상 1편 = 표지(대표 장면) + 장면 4~8장 + 밀착 인화(전 장면 타임라인) 1장.
5. 타임라인 카드: 밀착 인화(시각 코드 포함)로 영상 전체 흐름을 한 장에 — '몇 분 몇 초에 무엇이 보이는가'가 증거성의 핵심.
6. 존엄: 포로·시신·부상자 클로즈업 장면은 해설 카드에서 제외(게재윤리 4단계).
7. 출처 표기: 기관 정식명 · 영상 식별자(NAID/IA id/KTV mediaid) · 장면 시각 · 권리 등급 — 프레임마다.`;
const ANNOTATION_GUIDE = `기록 해설형 어노테이션 규칙 — 상세판 (record-annotation 스킬의 서버판. 웹에서는 HTML/아티팩트로 동일 문법 구현)

1. 영역 표시: 점선 영역 박스(dashed 1.5~2px) + 박스 모서리 바깥 번호 칩 — 점 찍기·내용 가림 금지. 좌표는 %(x,y,w,h)로 기록해 어느 해상도에서도 재현.
2. 전처리: 레터박스(검은 띠) 자동 크롭 후 원본 비율 유지. 저해상 프레임은 확대 금지 — 원본 크기 근처로 배치.
3. 메타데이터 표(7행 기준): 제목 · 식별번호(영구 식별자) · 원 제작(판독 근거 병기) · 사본 소재 · 생산시기 · 권리(원판/사본 구분) · 판독 근거.
4. 범례: 번호 칩 + 굵은 요소명 + 한 줄 해설. 순서는 판독 서사(제작 주체→내용→좌표→판본) 순.
5. ★추정 금지: 화면·원문에서 직접 읽히는 것만 적는다. 불명은 '판독 불가'로 명기 — '아마도·추정·으로 보임'류 어휘가 해설에 들어가면 재검토.
6. 원판/사본 계보 필수: 원판 권리(PD 등)와 디지털화본 표시(워터마크·업체)를 구분 명기.
7. 산출 3형: 보고서 부록 절('기록을 해설해 드립니다') · 카드뉴스(1080 — 범례 압축·2열 허용) · 슬라이드(도형 마커+노트에 판독 해설).
8. 권리 고지: 기관 정식명·식별자·열람 URL — 협약기관(KOREAN WAR ARCHIVES) 출처 표기 필수, 게재윤리 4단계.
9. 영상 프레임 판독 보강(슬레이트·화면 속 문자): 슬레이트/타이틀 카드에서 부대·촬영자·날짜·롤 번호·장소 필드를 파싱하고, 당대 지명(일본식 독음·외래 명명)은 현대 지명과 병기. 표지판·현수막·차량 표식 등 화면 속 문자는 OCR과 육안을 교차해 확정 — 불일치·판독 불가는 그대로 표기(추정 금지 원칙 동일).`;

const EXHIBIT_GUIDE = `고문서 전시형 산출물 규칙 — aks-archive-harvester 스킬 ④매개(Mediate) 단계의 서버판 (웹·모바일 동등성).
nedb_search(mode=aks)로 발굴한 문중·서원 고문서를 전시 페이지·카드뉴스·학습지로 만드는 규칙.

■ 산출물 4종
① 전시 페이지(단일 HTML): 표제·도입문(lead) → 시대 타임라인 → 문서별 패널(도판+캡션+이야기) → 출처 고지. 인쇄 시 패널 단위로 나뉘는 구성. 웹=아티팩트 미리보기, 로컬=파일 저장.
② 카드뉴스(1080×1350): 표지 1장 + 문서별 1장 + 클로징 1장. 문서 카드 = 도판(상단 70%)+캡션 띠(하단). 로컬=헤드리스 크롬 렌더, 웹=아티팩트/Canva 커넥터.
③ 학습지(A4 1장): "이 문서는 무엇인가"(유형·연대·발급자) · "찾아보기"(도판에서 날짜·수취인 찾기) · "생각해보기"(열린 질문 1개) · 요약 박스.
④ 게시 문구: 2~3문장 + 해시태그 — 기관명·소장처명 반드시 포함.

■ 캡션·서술 규칙 (추정 금지)
- 제목·문서유형·육안으로 보이는 것만 서술. 탈초(판독문)·번역·인물 생애는 사용자가 제공·확인한 것만 사실로 기술.
- 캡션 형식: [연대] [발급자→수취인] [문서유형] — 한 줄. 이야기(2문장 이내)는 주제와의 연결만.
- 검토 미완(사용자 확인 없는 항목)은 "초안" 표기를 지우지 않는다.

■ 권리·출처 (산출물 전체 공통)
- 전 산출물에 "자료: 한국학중앙연구원 한국고문서자료관 (archive.aks.ac.kr)" 고지 필수.
- 이미지 재이용은 기관 이용조건을 따름 — 게재 전 judge_rights로 초판정.

■ 전시 페이지 골격 (채워 쓸 것)
<!doctype html><html lang=ko><head><meta charset=utf-8><title>{{전시제목}}</title><style>
body{font-family:'Noto Serif KR',serif;max-width:860px;margin:0 auto;padding:2rem;color:#222}
.lead{font-size:1.15rem;border-left:4px solid #8a6d3b;padding-left:1rem;margin:1.5rem 0}
.tl{display:flex;gap:.6rem;flex-wrap:wrap;margin:1rem 0}.tl span{background:#f3ede2;padding:.2rem .7rem;border-radius:1rem;font-size:.85rem}
.panel{page-break-inside:avoid;margin:2.2rem 0;border-top:1px solid #ddd;padding-top:1.4rem}
.panel img{width:100%;border:1px solid #ccc}.cap{font-size:.92rem;color:#555;margin:.4rem 0}
.story{margin:.6rem 0}.draft{color:#b33;font-size:.8rem}
.src{margin-top:3rem;font-size:.85rem;color:#777;border-top:2px solid #8a6d3b;padding-top:.8rem}
</style></head><body><h1>{{전시제목}}</h1><p class=lead>{{도입문}}</p>
<div class=tl>{{<span>연대</span>…}}</div>
<div class=panel><img src="{{도판URL}}"><p class=cap>{{[연대] [발급자→수취인] [문서유형]}}</p><p class=story>{{이야기}}</p><span class=draft>{{검토 미완 시: 초안}}</span></div>
<p class=src>자료: 한국학중앙연구원 한국고문서자료관 (archive.aks.ac.kr) · 이미지 재이용은 기관 이용조건 준수</p></body></html>`;

const HELP_GUIDE = `사용 안내 — 매직 키워드 “창기창기 도와줘” (처음 사용자용. 이 내용을 친절한 안내로 정리해 사용자에게 전달하라. 시각 안내 페이지: https://korea-archive-mcp.vercel.app/help.html — 링크를 함께 제공)

■ 무엇을 하는 서비스인가
9개국 30개 아카이브(🇺🇸 NARA · 🇬🇧 TNA · Internet Archive · 🇫🇷 갈리카 · 🇪🇺 유러피아나 · 🇯🇵 아시아역사자료센터 JACAR · 🇦🇺 호주 전쟁기념관 · 🇳🇱 네덜란드 국립문서보관소 · 🌐 위키미디어 공용 · 🇺🇳 UN 디지털도서관 · 🇯🇵 NDL 서치 · 🇰🇷 국가기록원·국립중앙도서관(+신문아카이브 1883~1960)·한국사DB·국편 전자사료관·독립기념관·공훈전자사료관·독립운동판결문(국가기록원)·KTV e영상역사관·역사박물관·규장각·장서각·한국고문서자료관·국가유산포털·서울기록원·정보공개포털·KOREAN WAR ARCHIVES 협약기관)에서 한국 관련 기록·사진·영상(1860~현대)을 발굴하고, 검증하고, 전파물까지 만들어 준다. 한국어 한 문장이면 충분 — 표기 변형(Corea·Chosen·Corée·한자·朝鮮)과 색인 언어 변환은 자동. 카카오 PlayMCP 마켓 등록본으로도 연결 가능('KOREA ARCHIVE 통합검색' 검색 — 같은 서버).

■ 매직 키워드 2개
① “○○○ 풀패키지로 만들어줘” — 조사→검증→매거진 보고서→카드뉴스 8장→포스터→홍보·입문·메시지 카드→발표 PPTX(대본 포함)→기록 해설→Canva 편집본→KARDA 연구 데이터까지 전 산출물 자동(report_template kind=full_package 순서를 따름).
② “창기창기 도와줘” — 이 사용 안내.

■ 이렇게 물어보면 된다 (예시)
· “할아버지가 참전한 글로스터 연대 기록 찾아줘” (실전 1호 — TNA 훈장 추천서 원문까지)
· “장진호 전투 영상 기록 찾아줘” (실전 2호 — 3개국 3중 소장 실증)
· “조선시대 한강 나루의 행정을 정리해줘” (법전 판독→형제 조 전수→연대 검증 제도사)
· “병인양요 프랑스 기록 찾아줘” / “이 참조코드 주변을 더 캐줘”(인접 채굴) / “이 기록 게재 가능한지 판정해줘”
· “안중근 공훈록 전문 보여줘”(독립유공자 — 공적조서·수형기록·현충시설까지) / “이 NARA 기록 권리 실확인해줘”(naid)
· “장진호 기록, 같은 것끼리 묶어서 보여줘” (협약기관 재수집본·인터넷 아카이브·위키미디어 공용 사본을 NARA 원본과 한 건으로 — 원본은 NARA 목록 직접 조회로 실재 확인, 결과에 [nara·원본확인+koreanwar] 표시)
· “이 의궤 해제 읽어줘”(장서각 K2-…) / “안보리 결의 원문 PDF”(UN recid) / “이 1910년 기사 전문”(독립기념관 URL)

■ 검증 원칙(차별점) — 실물 기록만(AI 생성 인물·장면 금지)·원문 대조·출처 명시·정정 공개. 통과 산출물에만 검증 낙관.

■ 자주 묻는 것
· 0건 → 부재가 아니다. 표기 변형·인접 채굴·“대상을 관리한 행정”으로 전환.
· ZIP 일괄 납품은 로컬 환경 전용 — 웹·모바일은 개별 아티팩트+manifest.
· 이미지: 웹은 기관 공개 URL 참조 — 원본은 항상 기관 링크에서 열람.
· 조선 주제 → nedb_search 심층 판독 모드(law·sibling·matrix·origin·record·sjw·kyujanggak·aks[한국고문서자료관 — 문중·서원 고문서 172곳]). 심층 판독 11채널 — 발굴 결과의 URL·번호를 nedb_search 모드에 재투입: i815(당대 신문 전문·'사전:이름'=인명사전 전기)·gonghun(공적조서·공훈록·'종합:이름'=공훈+사전+판결문 3채널 인물 대조)·jacar(일본 공문서)·ktv(대한뉴스 해설)·earchive(수집 사료 이용조건)·commons(PD 라이선스)·jsg(장서각 해제)·un(UN 요약·PDF)·oldnews(신문 색인어·관련기사·'본문:' OCR 전문)·much(소장품·공공누리 자동판정) + seoul_archives_search(상세 URL). 연합 검색 푸터가 경로를 안내한다.\n· 연대로 좁히기 → 주요 검색 도구의 year_from/year_to. 번호 옆 훑기(인접 채굴) → TNA·NARA(naid)·archive.org(radius)·6·25아카이브. 당대 표기 자동 팬아웃 → cross_search(variants). 채널 상태 → source_profile('health').\n· 데이터화 3종 → cross_search format='csv'(표·통계) · 'karda'(지식그래프 nodes/edges) · 'manifest'(수집기록 매니페스트 JSON-LD — 증거성·맥락 보존, 기록관리시스템 등재·다매체 변환의 원천).

커넥터: korea-archive-mcp.vercel.app/api/mcp · 안내 페이지: korea-archive-mcp.vercel.app/help.html · 예제 갤러리(GitHub Pages): changgi.github.io/korea-archive-mcp/ — 30곳 탐방·100선 캐러셀, 전체 기록 IIIF 갤러리(iiif.html — 연속 보기·딥줌·IIIF 매니페스트)`;

const FULL_PACKAGE = `풀패키지 오케스트레이션 — 발굴에서 전파물까지 한 번에 (매직 키워드: "풀패키지" · "전부 다 만들어줘")
입력은 주제 하나면 충분하다. 아래 순서를 전부 수행해 모든 산출물을 함께 납품한다.

1. 발굴 조사: cross_search + 전문 도구(tna_search/nara_search/koreanwar_search/gallica_search…) — 표기 변형 병렬,
   시리즈 특정+tna_adjacent_mine 인접 채굴(±5~15), 국내 협약기관 교차검증, 카탈로그 API 원문으로 훈격·날짜·건수 검증
   (정정 발생 시 이력 기록), judge_rights 권리 초판. 핵심 기록은 심층 판독으로 본문·권리 실확인: nedb_search 모드(i815 당대 신문·gonghun 공훈록·ktv 영상·earchive 수집사료·commons PD파일·jsg 해제)와 seoul_archives_search(상세URL)·koreanwar_item·judge_rights(naid). 조선~대한제국 주제면 심층 판독 경로 추가: nedb_search 모드 활용 — law(법전 근거)→★sibling(조문을 열었으면 형제 조 전수 — 총론만 읽으면 핵심을 놓친다)→matrix(법전 수록 대조로 부재 발견)→origin(어휘 연원)→record(등록류 — 座目 필터)→sjw(최초 용례로 연대 검증)→kyujanggak(목록+해제). 보고서에 제도 재구성 절(등록·측정·운항·동원·보상 + 제도의 끝)·법전 대조표·자기 정정 이력을 추가하고, 인용은 2층위(법전=원문 인용 가능/등록·일기=국역만·역구성 학술 인용 불가) 명기.
2. 실물 이미지 수집: 기관 공개 원본 전량(비식별판 우선) + digitised 기록의 카탈로그 무료 미리보기.
   수집 즉시 출처 대장(sources.txt) 기록. AI 생성 인물·역사 장면 절대 금지.
3. HTML 보고서: report_template(kind='report') 19규칙 전부 — 히어로 실물·인라인 도판·콘택트시트·원문 미리보기·
   검증 기록·전수 목록·재현 쿼리·더 보기·카드뉴스 갤러리. 매거진 완성판은 kind=magazine 확장팩을 덧입힌다. 산출 방식 — 로컬: .html 파일 저장 / 웹·모바일: HTML 아티팩트로 게시(파일 저장 불가), 이미지는 기관 공개 URL 참조. 수치는 모든 산출물에서 동일해야 한다.
4. 캐러셀 8장: report_template(kind='carousel') 12규칙 — 커버는 보고서 히어로와 같은 실물, 검증 노트·따라하기 포함.
   렌더는 환경별: 로컬=헤드리스 렌더 / 웹·모바일=Canva 커넥터 생성→페이지별 PNG 내보내기. 전 장 육안 검수 생략 금지.
   caption.txt + sources.txt 동봉.
5. Canva 산출물(커넥터 연결 시): 캐러셀 편집본 + report_template(kind='canva_prompts') 1번 템플릿으로 포스터 1종 —
   생성 직후 전 한국어 문구를 검증 카피로 교정(replace_text) 후 저장.
6. 납품: 보고서 HTML + 카드 8장 + 포스터 시리즈 + caption/sources + Canva 링크. 로컬: 전체를 [주제영문]_fullpackage_[날짜].zip으로 묶어 함께 납품 — 구조 report/·cards/·posters/·canva/·pptx/·manifest.txt(산출물 목록+검증 요약). 웹·모바일: zip 생성 불가 — 개별 아티팩트로 제시하고 manifest 목록을 함께 출력. SNS 게시·공개 푸시는 사용자 확인 후. 발표자료(pptx): 발표·강의용 16:9 슬라이드 12~16장 병행 제작 — 표지·목차·발굴 경위·핵심 기록(실물 프레임+보고서 지면 캡쳐)·검증과 윤리·KARDA·전파물·CTA·출처 총람. 전 슬라이드 발표 노트(대본)와 도판별 출처 표기 필수, 저해상 프레임은 풀블리드 확대 대신 필름스트립 다컷 배치. Canva 편집본: 로컬은 공개 쇼케이스 URL 경유 import-design-from-url, 웹은 Canva 커넥터로 직접 생성해 편집 링크 제공.
7. 작업 로그(activity_log.md): 조사 중 모든 행위를 시간순 표로 기록 — 단계(발굴/교차검증/검증/수집/산출)·행위·도구와 쿼리·결과 건수·응답 규모. 이어서 분석 절: 도구·채널별 호출 통계와 성과, 0건→방법 전환 회수율, 검증 정정률, 소요·병목, 산출물 규모. LLM 토큰은 정확 집계 불가(클라이언트 영역) — 대리 지표(호출 수·바이트·소요)로 기록하고 그 사실을 명시. 로그+보고서 Ⅴ절+manifest가 감사 추적 3종 세트로 zip에 포함된다.
8. KARDA 온톨로지 산출물(kad/): 발굴 결과를 관계 그래프 입력으로 변환해 zip에 포함 — karda_nodes.csv(id·type[record/agent/unit/place/event]·label·속성)·karda_edges.csv(source·target·relation·relation_ko·basis·confidence)·kad_readme.txt. 신뢰도 필터: 확정(API·원문 판독)·높음만 그래프 수록, 부분 이하는 tentative로 readme에 명기(그래프 오염 방지). 관계마다 근거(basis)를 남겨 연구 재검증 가능하게. 로컬은 make_metadata.py 활용 가능. 품질 게이트 추가: ①보고서 CSS는 템플릿 전체를 그대로 포함(부분 복사 금지 — 영상 절 등 미사용 스타일도 포함해야 절 추가 시 깨지지 않는다) ②핵심 기록 카드는 수집된 실물이 있으면 반드시 이미지 포함(자료 화면 대체 시 그 사실 명기) ③갤러리·절은 placeholder 주석이 아니라 실제 임베드 — 납품 전 잔존 placeholder 검사. 홍보 카드뉴스 제작 시: 텍스트 위주 금지 — 매거진 실제 지면 캡쳐(표지·차례·본문 스프레드·필름스트립·기록 카드·갤러리·검증 낙관)를 카드마다 수록해 산출물 품질을 눈으로 증명한다. 입문 카드뉴스(키워드 정복형) 병행 제작: 처음 접하는 일반 시민 대상 — 후킹 문구(“○○은 처음이지?”·“○○ 완벽 해설”·“3분 정복”) 적극 사용, 카드마다 키워드 1개를 초대형 타이포로 강조하고 한두 줄 쉬운 설명(중학생 눈높이·비유 허용·전문용어 풀어쓰기), 실물 프레임·지면 캡쳐 동반, 마지막 카드는 “정복 완료!”+다음 키워드 참여 유도. ZIP에는 intro/ 폴더로 수록. 메시지형(미장센 문법) 병행 제작: 강연 오프닝·SNS 임팩트용 카드뉴스+슬라이드 — 1장 = 실물 미장센 이미지 1 + 메시지 한 문장, 서사 아크는 충격 오프닝→과거→반전→블랙아웃 테제(텍스트만)→원칙→결과→선언→CTA. 이미지는 실물 기록만(AI 연출 이미지 금지 — 저해상 프레임은 어둡게 깔아 무드로 사용), 장마다 출처 1줄, 슬라이드판은 발표 노트에 미장센·디렉팅 의도 기록. ZIP에는 message/ 폴더로 수록. 시연 영상(선택): 산출물·서비스 데모 GIF/MP4 병행 — 로컬은 demo-video 스킬(실브라우저 구동 녹화), 웹은 페이지 연속 캡쳐 프레임을 GIF로 합성. ZIP에는 video/ 폴더로 수록. 기록 해설형(도큐먼트 애노테이션) 병행 제작: 서울기록원류 해설 지면 문법 — 기록·프레임 위에 점선 영역 박스+외곽 모서리 번호 칩으로 요소를 하나하나 판독(마커가 내용을 가리지 않게 — 점 찍기 금지, 레터박스 검은 띠 제거 후 원본 비율 유지, 색은 지면 팔레트와 조화)(인장·타이틀·타임코드·워터마크·부대 표식 등), 상단에 메타데이터 표(제목·식별번호·제작·소재·시기·권리), 원판/사본 계보 명기. 판독은 화면·원문에서 직접 읽히는 것만(추정 금지, 불명은 표기). 보고서에는 ‘기록을 해설해 드립니다’ 부록 절로, 카드뉴스·슬라이드로도 병행(슬라이드 노트에 판독 해설). ZIP에는 annotate/ 폴더로 수록.

9. 보존 패키지(SIP — 현용기록물화): cross_search(format='manifest')로 수집기록 매니페스트(JSON-LD — provenance·heldBy·영속 식별자)를 생성해 manifest.json으로 ZIP 최상위에 동봉하고, 보고서 <details> 부록(규칙 19)·sources.txt(identifier+재현 호출 1줄)·karda 산출물(node 키 공유)이 전부 이 매니페스트를 참조하게 한다 — 패키지 전체가 하나의 기록 단위(RecordSet)로 등재·재검증 가능. 다른 매개로 재가공·전파될 때도 manifest.json을 함께 옮기는 것이 원칙.

품질 게이트: 수치 정합 · 전 이미지 캡션+출처(기관 정식명·국가·식별자·링크) · 실확인 링크만(확인일 명기) ·
게재윤리 4단계(포로·사망자 존엄) · 협약기관 출처 표기 필수 · manifest.json 동봉(증거성 상속).`;

const MAGAZINE_PACK = `매거진 확장팩 — kind='report' 보고서에 덧입히는 표지·목차·뒷표지·시그니처·테마 (일류 저널급)
사용법: 보고서 골격(kind='report') 완성 후 아래를 추가한다. 표지는 발굴 포스터를 겸한다(별도 포스터 제작 시 같은 구성).

[구조] <body> 직후: <section class='cover'> → <section class='contents'> → 기존 .wrap 본문 → </div> 뒤 <section class='backcover'>
[표지] 실물 히어로 사진 풀블리드 배경(.bg data URI)+그라디언트(.shade) 위에: KA인장+매스트헤드(제N호·날짜) /
 킥커 / 대형 제호 h1 / 훅 문장 .sub / 검증 팩트 3줄 .facts(골드 좌보더) / .foot "표지 겸 발굴 포스터 — 실물 사진과 검증 카피로만 구성"+사진 출처
[목차] .contents: CONTENTS 라벨 / 차례 ol — 각 항목: 로마숫자(.no2 이탤릭 세리프)+절 제목 앵커+우측 한 줄 설명(.d)
[뒷표지] .backcover(다크): KA인장+워드마크 / 서비스 소개 2줄 / 이 호의 기록 출처(국기+정식명) / 함께 나온 산출물 / 커넥터 URL+매직 키워드 '풀패키지' / 확인일
[스프레드 폴리시] h2 고스트 로마숫자(.no 64px opacity .13)+골드 틱(::before 26×3px) / figcaption b는 스몰캡스 /
 절 사이 풀블리드 포토 브레이크 .photobreak(실물 배경+어두운 오버레이+이탤릭 인용+출처 한 줄)
[시그니처 — KA 인장·검증 낙관] 인장 SVG(72 viewBox): 크림슨 라운드 사각 + 크림 이중 테두리 + K·A 스트로크 모노그램 + 상하좌우 조준 틱.
 검증 낙관 .ka-verified: 크림슨 2.5px 보더 라운드 박스 -1.2도 회전, 인장+"검증 낙관 — KOREA ARCHIVE"+
 "실물 이미지·훈격·건수·링크는 기관 원본 수집과 API 원문 대조를 마쳤습니다. 정정 이력은 Ⅴ절 공개 · [확인일]" — Ⅵ 권리절 끝에 배치. 검증 없이 낙관 금지.
[테마 5종 — data-theme 속성, CSS 변수 오버라이드] 기본 Injang(시그니처: 크림 종이+크림슨+골드 세리프) /
 minimal(화이트·#0071e3·산세리프, 애플풍) / dark(#0b0d12·#4c8dff, 삼성풍) / pop(#fee500 포인트, 카카오풍) / blue(#0064e0·산세리프, 메타풍).
 우하단 고정 .themebar(반투명 필, 5색 원 버튼, onclick으로 documentElement data-theme 토글, @media print 숨김)

[핵심 CSS — 그대로 복사]
.cover{position:relative;min-height:100vh;display:flex;flex-direction:column;background:#171412;color:#f4ecdd;overflow:hidden}
.cover .bg{position:absolute;inset:0;background-size:cover;background-position:70% center}
.cover .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,8,6,.35),rgba(10,8,6,.94) 70%)}
.cover .in{position:relative;z-index:2;display:flex;flex-direction:column;flex:1;max-width:880px;width:100%;margin:0 auto;padding:34px 26px 48px}
.cover .mast{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:#cbbfa8;border-bottom:3px double rgba(232,224,205,.6);padding-bottom:12px}
.cover .kick{margin-top:auto;font-size:13px;letter-spacing:.3em;color:#e8b45a;font-weight:700}
.cover h1{font-size:clamp(38px,7.5vw,68px);line-height:1.18;margin:10px 0 16px;color:#fff}
.cover .facts li{margin:6px 0;padding-left:16px;border-left:2px solid #a8853c;list-style:none}
.contents li{display:flex;gap:16px;align-items:baseline;padding:13px 2px;border-bottom:1px solid var(--line)}
.contents .no2{font-family:Georgia,serif;font-style:italic;color:var(--accent);flex:0 0 34px;font-size:19px}
.contents .d{color:var(--sub);font-size:13px;margin-left:auto;text-align:right;max-width:46%}
.backcover{background:#171412;color:#cbbfa8;margin-top:70px;padding:70px 26px 60px}
.photobreak{position:relative;margin:70px calc(50% - 50vw);padding:110px 26px;background-size:cover;color:#f4ecdd;text-align:center}
.photobreak::before{content:'';position:absolute;inset:0;background:rgba(12,9,7,.62)}
.photobreak blockquote{position:relative;z-index:1;max-width:640px;margin:0 auto;font-size:clamp(22px,3.4vw,30px);font-style:italic}
.ka-verified{display:flex;gap:16px;align-items:center;margin-top:26px;padding:16px 20px;border:2.5px solid var(--accent);border-radius:8px;max-width:560px;transform:rotate(-1.2deg)}
h2 .no{font-size:64px;position:absolute;top:-14px;left:-6px;opacity:.13}
@media print{.cover{page-break-after:always}.contents{page-break-after:always}.themebar{display:none}}

[KA 인장 SVG — 그대로 복사]
<svg class='ka-seal' viewBox='0 0 72 72' width='30' height='30'><path d='M36 1v6M36 65v6M1 36h6M65 36h6' stroke='#8a3033' stroke-width='2.6'/><rect x='9' y='9' width='54' height='54' rx='7' fill='#8a3033'/><rect x='13.5' y='13.5' width='45' height='45' rx='4.5' fill='none' stroke='#f5f1e8' stroke-width='1.6' opacity='.75'/><path d='M22 22v28M22 36l11-14M22 36l11 14' stroke='#f5f1e8' stroke-width='4.6' fill='none' stroke-linecap='square'/><path d='M38 50l7-28 7 28M41 41h8' stroke='#f5f1e8' stroke-width='4.6' fill='none' stroke-linecap='square'/></svg>`;

const wrapped = (req, ctx) => REQ.run({ probe: req.headers.get('x-ka-probe') || '' }, () => handler(req, ctx));
export { wrapped as GET, wrapped as POST, wrapped as DELETE };
