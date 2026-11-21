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
  // ── v1.17 증보: 6·25 후기 단계 전투 ──
  { p: '지평리|砥平里', en: 'Chipyong-ni', fr: 'bataillon français Corée Chipyong-ni' },
  { p: '가평\\s?전투|加平', en: 'Kapyong' },
  { p: '노근리|老斤里', en: 'No Gun Ri' },
  { p: '철의\\s?삼각지?대?', en: 'Iron Triangle Korea' },
  { p: '폭찹\\s?힐|폭찹\\s?고지', en: 'Pork Chop Hill' },
  { p: '피의\\s?능선', en: 'Bloody Ridge Korea' },
  { p: '저격\\s?능선|狙擊稜線|狙击岭', en: 'Sniper Ridge Korea' },
  { p: '삼각\\s?고지|상감령|上甘嶺|上甘岭', en: 'Triangle Hill Korea' },
  { p: '금성\\s?전투|金城\\s?戰鬪|金城战役', en: 'Kumsong offensive 1953' },
  { p: '청천강|淸川江|清川江', en: 'Chongchon River' },
  { p: '부산\\s?교두보|워커\\s?라인', en: 'Pusan Perimeter' },
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
  { p: '금강산|金剛山|金刚山', en: 'Kumgang Diamond Mountains', fr: 'monts Kumgang' },
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
  { p: '제주\\s?4[·.]3|4[·.]3\\s?사건', en: 'Cheju uprising 1948' },
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
const tnaLine = (r) => `- [${r.reference || '?'}] ${(r.title || r.description || '').replace(/<[^>]+>/g, '').slice(0, 110)} (${r.coveringDates || ''}) https://discovery.nationalarchives.gov.uk/details/r/${r.id}`;

// ══════════ 상호보완 다중채널 수집 (concurrent collect + merge/dedup) ══════════
const norm = (s) => (s == null ? '' : String(s)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const dedupKey = (it) => norm(it.title).toLowerCase().replace(/[^a-z0-9가-힣一-鿿]/g, '').slice(0, 50) + '|' + (it.id || '');
// run collectors concurrently; merge, dedup by title|id, union the source tags (상호보완: 한 record를 여러 채널이 확인)
const SOURCE_TIMEBOX_MS = 12000; // 소스별 타임박스 — 최저속(차단 대기) 소스가 전체 지연을 지배하지 않게 (실측 21.7s → ~12s)
async function collectMerged(collectors) {
  const boxed = (fn) => Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timebox 12s')), SOURCE_TIMEBOX_MS))]);
  const settled = await Promise.allSettled(collectors.map((c) => boxed(c.fn)));
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

// ── 한국고문서자료관(한국학중앙연구원, archive.aks.ac.kr) — 소장처 172곳 (2026-11-17 treeAjax 전수 실측) ──
// 형식: id|상위경로(upPath)|분류|소장처명. 트리·문서목록은 라이브 조회, 이미지 일괄 수집은 로컬 전용.
const AKS_BASE = 'https://archive.aks.ac.kr';
const AKS_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': AKS_BASE + '/viewer/viewer.do' };
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
    // 실측 7.7s(최저속 축) — 6h TTL 캐시(마커 <item> — 정상 결과만)
    const xml = await cachedText(`nlk:${q}:${n}`, 6 * 3600e3, () => gtext(`https://www.nl.go.kr/NL/search/openApi/search.do?key=${encodeURIComponent(key)}&apiType=xml&srchTarget=total&kwd=${encodeURIComponent(q)}&pageSize=${n}&pageNum=1`), '<item>');
    return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => { let lk = xtag(it, 'detail_link') || xtag(it, 'org_link'); if (lk.startsWith('/')) lk = 'https://www.nl.go.kr' + lk; return { title: xtag(it, 'title_info') || xtag(it, 'title'), date: xtag(it, 'pub_year_info'), id: xtag(it, 'type_name'), url: lk }; });
  },
  nedb: async (q, n) => { const recs = await loadNedbIndex(); return recs ? nedbFileSearch(recs, q, n) : []; },
  koreanwar: async (q, n) => (await kwSearch({ keyword: q, viewType: 'archive' })).cards.slice(0, n).map((c) => ({ title: c.title, date: '', id: c.id, url: c.url })),
  ndl: async (q, n) => { // 일본 국립국회도서관 서치 — OpenSearch 무키 실측(2026-11-21). 조선총독부 간행물·관보·도판 축(JACAR 공문서와 상보). 한→일 JA_MAP 우선 변환
    const ja = koToJa(q) || koToEn(q) || q;
    const b = await gtext(`https://ndlsearch.ndl.go.jp/api/opensearch?any=${encodeURIComponent(ja)}&cnt=${Math.min(n, 10)}`,
      { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' });
    if (b.includes('<error>') && b.includes('429')) throw new Error('NDL 동시접속 제한(429) — 잠시 후 재시도');
    const out = [];
    for (const item of b.split('<item>').slice(1)) {
      const g = (t) => ((item.match(new RegExp(`<${t}[^>]*>([^<]+)`)) || [])[1] || '').trim();
      const title = g('title'); const link = g('link');
      if (!title || !link) continue;
      const cats = [...item.matchAll(/<category>([^<]+)/g)].map((m) => m[1]).join('·'); // 자료형·매체(紙/デジタル)
      const author = g('author');
      out.push({ title: `${title}${cats ? ` [${cats}]` : ''}${author ? ` — ${author}` : ''}`.slice(0, 120), date: g('dc:date'), id: '', url: link });
      if (out.length >= n) break;
    }
    return out;
  },
  un: async (q, n) => { // UN 디지털도서관(digitallibrary.un.org) — Invenio of=xm(MARCXML) 무키 실측(2026-11-21). 안보리 결의·UNCURK 등. ※UN Archives(AtoM)는 별도·보류
    const en = koToEn(q) || q;
    const b = await gtext(`https://digitallibrary.un.org/search?p=${encodeURIComponent(en)}&of=xm&rg=${Math.min(n, 10)}`,
      { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' });
    const sf = (seg, tag, code) => (((seg.match(new RegExp(`<datafield tag="${tag}"[^>]*>([\\s\\S]*?)<\\/datafield>`)) || [])[1] || '').match(new RegExp(`<subfield code="${code}">([^<]+)`)) || [])[1] || '';
    const out = [];
    for (const seg of b.split(/<record>/).slice(1)) {
      const recid = (seg.match(/<controlfield tag="001">(\d+)/) || [])[1];
      if (!recid) continue;
      const sym = sf(seg, '191', 'a');
      const title = norm(sf(seg, '245', 'a') + ' ' + sf(seg, '245', 'b')).replace(/[\s/:]+$/, '');
      out.push({ title: `${sym ? `[${sym}] ` : ''}${title}`.slice(0, 110), date: sf(seg, '269', 'a') || sf(seg, '260', 'c'), id: sym || recid, url: 'https://digitallibrary.un.org/record/' + recid });
      if (out.length >= n) break;
    }
    return out;
  },
  commons: async (q, n) => { // 위키미디어 공용 — 키 불요 검색 API(PD 사진·NARA/해군 재수집본 다수 — 원 소장처 역추적 창구). 공유 IP 429 시 채널 실패로 표시
    const en = koToEn(q) || q;
    const d = await jget('https://commons.wikimedia.org/w/api.php?action=query&list=search&srnamespace=6&format=json&srlimit=' + Math.min(n, 10) + '&srsearch=' + encodeURIComponent(en),
      { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' });
    return ((d.query || {}).search || []).map((it) => {
      const t = String(it.title || '');
      return { title: t.replace(/^File:/, '').slice(0, 110), date: '', id: '', url: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(t.replace(/ /g, '_')) };
    });
  },
  nlna: async (q, n) => { // 네덜란드 국립문서보관소 — 공개 JSON API 실측(2026-11-20, Playwright 역추적). 주한 대사관 문서군 등
    const en = koToEn(q) || q;
    const d = await jget(`https://zvt.nationaalarchief.nl/api/search/eads?page=1&rows=${Math.min(n, 10)}&q=${encodeURIComponent(en)}&sortBy=_score`);
    return ((d && d.results) || []).slice(0, n).map((r) => ({
      title: norm(String(r.title || '')).slice(0, 95) + (r.type === 'ARCHIVE' ? ' [문서군]' : ''),
      date: String(r.period || ''), id: String(r.id || ''),
      url: 'https://www.nationaalarchief.nl/onderzoeken/archief/' + encodeURIComponent(String(r.id || '')),
    }));
  },
  awm: async (q, n) => { // 호주 전쟁기념관(AWM) — 검색 모자이크(SSR C-id) → 상세 병렬로 제목·수장번호 (2026-11-20 실측: 가평 파노라마 HOBJ3144 등)
    const en = koToEn(q) || q;
    const b = await gtext('https://www.awm.gov.au/advanced-search?query=' + encodeURIComponent(en));
    const ids = [...new Set([...b.matchAll(/href="\/collection\/(C\d+)"/g)].map((m) => m[1]))].slice(0, Math.min(n, 5));
    const out = await Promise.all(ids.map(async (cid) => {
      try {
        const d = await cachedText('awm:' + cid, 24 * 3600e3, () => gtext('https://www.awm.gov.au/collection/' + cid), '<h1');
        const h1 = d.match(/<h1[^>]*>\s*(?:<[^>]+>\s*)*([^<]{3,120})/);
        const acc = d.match(/(?:Accession Number|ID number)[^A-Z0-9]{0,40}([A-Z0-9/.\-]{3,20})/);
        const pd = /Copyright expired - public domain|publicdomain\/mark/.test(d);
        const conf = d.match(/Conflict[^<]*<\/[a-z0-9]+>\s*<[^>]*>\s*(?:<[^>]+>\s*)*([^<]{4,40})/);
        return { title: (h1 ? norm(h1[1]) : cid) + (pd ? ' · 권리:PD(저작권 만료)' : ''), date: conf ? norm(conf[1]) : '', id: acc ? acc[1] : cid, url: 'https://www.awm.gov.au/collection/' + cid };
      } catch { return null; }
    }));
    return out.filter(Boolean);
  },
  jsg: async (q, n) => { // AKS 장서각 — ★검색 파라미터는 q=query|<어> (플레인 q는 무시되고 전체 열람 반환 — Playwright 실브라우저 재역공학으로 확정, 2026-11-20)
    const b = await gtext('https://jsg.aks.ac.kr/search/group?q=' + encodeURIComponent('query|' + q));
    const out = []; const seen = new Set();
    for (const m of b.matchAll(/href="\/dir\/view\?dataId=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const t = norm(m[2]);
      if (!t || seen.has(m[1]) || /^JSG_K1-[1-5]$/.test(m[1])) continue;
      seen.add(m[1]);
      out.push({ title: t.slice(0, 95), date: '', id: m[1].startsWith('JSG_') ? m[1].slice(4) : '', url: 'https://jsg.aks.ac.kr/dir/view?dataId=' + encodeURIComponent(m[1]) });
      if (out.length >= n) break;
    }
    return out;
  },
  kyudb: async (q, n) => { // 서울대 규장각 — 기존 jKyu(목록+해제 POST) 코어 재사용
    const r = await jKyu(q);
    const list = Array.isArray(r['목록']) ? r['목록'] : [];
    return list.slice(0, n).map((t) => ({ title: String(t), date: '', id: '', url: 'https://kyudb.snu.ac.kr' }));
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
            url: d ? `${base}/${d[0]}?${d[1]}=${encodeURIComponent(m[1])}&sortNo=${m[2]}` : base + top.u });
          if (out.length >= Math.max(2, n - 2)) break;
        }
      } catch { /* 목록 실패 — 집계 신호로 폴백 */ }
    }
    for (const c of cats) {
      if (out.length >= n) break;
      out.push({ title: `독립기념관 ${c.name} ${c.disp}건`, date: '', id: '', url: base + c.u });
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
        date: tds[3] || '', id: mn[1],
        url: `https://e-gonghun.mpva.go.kr/user/ContribuReportDetail.do?goTocode=20001&mngNo=${mn[1]}&pageTitle=Report` });
      if (out.length >= n) break;
    }
    return out;
  },
  ktv: async (q, n) => { // KTV e영상역사관(대한뉴스·기록영상, KOGL) — ktv.go.kr 통합검색 iframe GET 실측(2026-11-19)
    const b = await gtext('https://www.ktv.go.kr/totalSearch/ehistory?design=new&collection=ehistory&baseKeyword=' + encodeURIComponent(q));
    const out = [];
    for (const m of b.matchAll(/href="(https:\/\/www\.ehistory\.go\.kr\/view\/[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{4,80})/g)) {
      const t = norm(m[2]);
      if (!t || /paging|overflow/.test(t)) continue;
      out.push({ title: t, date: '', id: '', url: m[1].replace(/&amp;/g, '&') });
      if (out.length >= n) break;
    }
    return out;
  },
  earchive: async (q, n) => { // 국사편찬위 전자사료관 — POST 검색 실측(2026-11-19). NARA 수집 사료(AUS…) 원문 소장. 상세는 세션 기반이라 사료ID 표기
    const r = await fetch('https://archive.history.go.kr/search/searchResult.do', {
      method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ allSearchQuery: q, searchQuery: q, searchPageIndex: '1', searchPageUnit: String(Math.min(n, 20)), searchPageSize: '10' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const b = await r.text();
    const out = [];
    for (const m of b.matchAll(/fnGoCatalogView\('(\d+)'[^"]*"\s+title="([^"]{3,120})"/g)) {
      const seg = b.slice(m.index, m.index + 700);
      const sid = (seg.match(/([A-Z]{2,3}\d{3}_[0-9A-Za-z_]{6,})/) || [])[1] || '';
      out.push({ title: norm(m[2]), date: '', id: sid || m[1], url: 'https://archive.history.go.kr' });
      if (out.length >= n) break;
    }
    return out;
  },
  jacar: async (q, n) => { // 일본 아시아역사자료센터 — GET 검색 실측(2026-11-19, docs/jacar-access-spec.md)
    const en = koToJa(q) || koToEn(q) || q; // 일본어 사상 우선 → 영어 → 원문
    const b = await gtext('https://www.jacar.archives.go.jp/aj/search-en?kw=' + encodeURIComponent(en)); // 파라미터는 kw — keyword는 무시됨(실측)
    const out = [];
    for (const blk of b.split('<li class="archive-result-table__body-item"').slice(1)) {
      const c = blk.match(/value="aj\d+\/([A-Z]\d{11})"/);
      const t = blk.match(/id="row-\d+-title"[\s\S]*?<span\s*>([^<]{3,150})/);
      if (c && t) out.push({ title: norm(t[1]), date: '', id: c[1], url: 'https://www.jacar.archives.go.jp/das/meta-en/' + c[1] });
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
      if (tt) { used.add(norm(tt.replace(/<[^>]+>/g, ''))); out.push({ title: norm(tt.replace(/<[^>]+>/g, '')).slice(0, 110), date: '', id: path.split('/')[2] || '', url: base + path }); }
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
    return out;
  },
  foia: async (q, n) => { // 정보공개 원문 라이브 채널: 서울정보소통광장 결재문서 — 전용 도구(foia_search)와 동일 경로
    // 기지 차단(연결 리셋 ~11s×2회 재시도=21s 소모 실측) — 단발 6s fail-fast로 health·연합 탐침 시간 보호. 복구 시 자동 정상화
    const r = await fetch('https://opengov.seoul.go.kr/sanction/list?searchKeyword=' + encodeURIComponent(q), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.text();
    const seen = new Set(); const out = [];
    const re = /<a[^>]+href="(\/sanction\/\d+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
    while ((m = re.exec(b)) && out.length < n) { const t = norm(m[2]).replace(/^제목\s*:\s*/, ''); if (t && !seen.has(m[1])) { seen.add(m[1]); out.push({ title: t, date: '', id: '', url: 'https://opengov.seoul.go.kr' + m[1] }); } }
    return out;
  },
  aks: async (q, n) => { // 한국고문서자료관 소장처 매칭(내장 카탈로그 — 네트워크 0)
    const toks = q.split(/\s+/).filter(Boolean);
    return AKS_CAT.filter((c) => toks.length && toks.every((t) => (c.name + ' ' + c.grp).includes(t))).slice(0, n)
      .map((c) => ({ title: `[고문서 소장처] ${c.name} (${c.grp})`, date: '', id: c.id, url: AKS_BASE + '/viewer/viewer.do' }));
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
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(url, { method: 'POST', body,
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', ...JDB_HDR, ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { lastErr = e; if (a === 0) await sleep(300); }
  }
  throw new Error(errInfo(lastErr));
}
const jNoScript = (s) => String(s || '').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
const jClean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const jStrip = (s) => jClean(jNoScript(s));
const jLines = (s) => jNoScript(s).replace(/<[^>]+>/g, '\n').split('\n').map((l) => jClean(l)).filter(Boolean);
const jCite = (lid) => `${JDB}/id/${lid}`;
const jItemUrl = (lid) => JDB + (lid.startsWith('jlaw') ? '/joseon/item/level.do?levelId=' : '/joseon/level.do?levelId=') + lid;
const J_SEARCH_BASE = { pageIndex: '1', pageSize: '1', orderColumn: 'levelId', orderDir: 'ASC',
  synonym: 'off', chinessChar: 'on', titleWord: '', titleConjunction: 'AND',
  contentsWord: '', contentsConjunction: 'AND', creatorWord: '', creatorConjunction: 'AND',
  startDate: '', endDate: '' };

async function jLawSearch(query, n) {
  const b = await jdbPost(JDB + '/search/law/searchResultList.do',
    { ...J_SEARCH_BASE, searchItemId: 'jlaw', searchTarget: 'jlaw', pageUnit: String(Math.min(n, 200)), totalWord: query });
  const total = parseInt(((jStrip(b).match(/총\s*([\d,]+)건/) || [])[1] || '0').replace(/,/g, ''), 10);
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
  if (lid.startsWith('jlaw')) { const i = lines.indexOf('다음글'); k = i >= 0 ? i + 1 : null; }
  else { const i = lines.findIndex((l) => l.startsWith('◯') || l.startsWith('○')); k = i >= 0 ? i : null; }
  if (k === null) return { lid, title, status: title ? 'not_published' : 'parse_failed' };
  let end = lines.slice(k).findIndex((l) => l.includes('경기도 과천시') || l.includes('개인정보'));
  end = end >= 0 ? k + end : Math.min(lines.length, k + 250);
  const body = lines.slice(k, end).join(' ').slice(0, maxChars || 1200);
  return { lid, title, body, chars: body.length, status: 'ok', isLaw: lid.startsWith('jlaw') };
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

async function jRecordSearch(query, n) {
  const b = await jdbPost(JDB + '/joseon/search/searchResultList.do',
    { ...J_SEARCH_BASE, searchItemId: 'bb', searchTarget: 'bb', pageUnit: String(Math.min(n, 200)), totalWord: query });
  const total = parseInt(((jStrip(b).match(/총\s*([\d,]+)건/) || [])[1] || '0').replace(/,/g, ''), 10);
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
  const total = parseInt((((t.match(/검색결과\s*([\d,]+)\s*건/) || t.match(/총\s*([\d,]+)\s*건/)) || [])[1] || '0').replace(/,/g, ''), 10);
  const REIGNS = ['태조', '정종', '태종', '세종', '문종', '단종', '세조', '예종', '성종', '연산군', '중종', '인종', '명종', '선조', '광해군', '인조', '효종', '현종', '숙종', '경종', '영조', '정조', '순조', '헌종', '철종', '고종', '순종'];
  const dist = {};
  for (const r of REIGNS) { const mm = t.match(new RegExp(r + '\\s*\\((\\d+)\\)')); if (mm) dist[r] = parseInt(mm[1], 10); }
  const me = t.match(new RegExp('(' + REIGNS.join('|') + ')\\s*(\\d+)년[^\\d]{0,12}(\\d{4})년'));
  const earliest = me ? { reign: `${me[1]} ${me[2]}년`, year: parseInt(me[3], 10) } : null;
  return { total, dist, earliest };
}

async function jKyu(query) {
  // 실측 10.2s(12s 타임박스 근접 — cross_search 간헐 탈락 위험) → 목록·해제 2건 병렬 + 6h TTL 캐시
  const ck = 'kyudb:' + query;
  const hit = _ttlCache.get(ck);
  if (hit && Date.now() - hit.t < 6 * 3600e3) return JSON.parse(hit.v);
  const out = {};
  await Promise.all([['10', '목록'], ['20', '해제']].map(async ([code, label]) => {
    try {
      const b = await jdbPost(JKYU + '/search/search.do', { totalSearchString: query, searchArea: code }, { Referer: JKYU + '/' });
      out[label] = [...new Set([...b.matchAll(/(奎[\d軸]+)/g)].map((x) => x[1]))].slice(0, 30);
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
  { p: /서울\s?수복/, n: '서울 수복', t: '1950-09-22 ~ 09-28', x: "en 'Seoul recapture 1950' · koreanwar_search(scope=archive '서울 수복')" },
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
    return _tool(name, d, schema,
      { title: TITLES[name] || name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      guard24k(cb));
  };

  server.tool('tna_search',
    'Search the UK National Archives (TNA) Discovery catalog for Korea-related records. Queries in Korean·Japanese·Chinese·Russian·Spanish·German·Vietnamese·Hindi·Hebrew·Arabic etc. are auto-translated to English index terms (임진강→Imjin River, 長津湖→Chosin Reservoir, Корейская война→Korean War …). Reference codes like "FO 371/84053" are auto-quoted. 영국 국립기록관 검색 — 다국어 질의 자동 영문 변환.',
    { query: z.string().describe('한국어 또는 영어 — e.g. "임진강 전투", "Korea armistice", "FO 371 FK1015"'), max_results: z.number().int().min(1).max(50).default(15), year_from: z.number().int().optional().describe('연대 시작 e.g. 1950'), year_to: z.number().int().optional().describe('연대 끝 e.g. 1953'), page: z.number().int().min(1).default(1) },
    async ({ query, max_results, year_from, year_to, page }) => {
      const en = koToEn(query);
      const eff = en || query;
      const q = /^[A-Z]+ \d+\/\d+$/.test(eff.trim()) ? `"${eff.trim()}"` : eff;
      const d = await tnaFetch(q, max_results, page, year_from, year_to);
      const recs = d.records || [];
      const tags = [year_from || year_to ? `연대 ${year_from || ''}~${year_to || ''}` : '', page > 1 ? `p.${page}` : ''].filter(Boolean);
      const hint = (year_from || year_to) && !recs.length ? '\n※ 연대 필터는 연대 미상(Date unknown) 기록을 제외합니다 — 무필터로 재시도해 비교하십시오.' : '';
      return text(`TNA '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''}${tags.length ? ` [${tags.join(' · ')}]` : ''} — total ${d.count ?? '?'}:\n` + (recs.map(tnaLine).join('\n') || '(0 results)') + hint);
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
    { query: z.string().describe('한국어 또는 영어 (naid 지정 시 무시 가능 — 빈 문자열 허용)'), record_group: z.number().int().optional(), moving_images_only: z.boolean().default(false), max_results: z.number().int().min(1).max(50).default(15), page: z.number().int().min(1).default(1), naid: z.number().int().optional().describe('NAID 인접 채굴 중심값 e.g. 22015'), radius: z.number().int().min(0).max(8).default(3).describe('naid ±N 인접 범위') },
    async ({ query, record_group, moving_images_only, max_results, page, naid, radius }) => {
      const key = process.env.NARA_API_KEY;
      if (!key) return text('NARA_API_KEY not configured on this server. Free key: email Catalog_API@nara.gov (name + email). Meanwhile use catalog.archives.gov directly.');
      if (naid) { // NAID ± 인접 채굴 — 사진 ±3·색인 ±1 간격 실무 지식. v2는 단수 naId만 수용(naIds=400 실측) → 순차 조회
        const ids = []; for (let i = naid - radius; i <= naid + radius; i++) if (i > 0) ids.push(i);
        const lines = [];
        for (const i of ids) {
          try {
            const d2 = await jget(`https://catalog.archives.gov/api/v2/records/search?naId=${i}&limit=1`, { 'x-api-key': key });
            const rec = (((((d2.body || {}).hits || {}).hits) || [])[0] || { _source: {} })._source.record || null;
            lines.push(rec && Number(rec.naId) === i ? `${i === naid ? '★' : ' '} [NAID ${i}] ${(rec.title || '').slice(0, 95)} | ${rec.localIdentifier || ''} | https://catalog.archives.gov/id/${i}` : `  [NAID ${i}] (없음)`);
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
        return `- [NAID ${rec.naId}] ${(rec.title || '').slice(0, 100)} | ${rec.localIdentifier || ''} | https://catalog.archives.gov/id/${rec.naId}`;
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
        const files = (d.files || []).filter((f) => f.source === 'original').slice(0, 10);
        return text(`Title: ${md.title}\nDate: ${md.date} | License: ${md.licenseurl || md.rights || 'not stated'}\nDescription: ${String(md.description || '').slice(0, 300)}\nOriginal files:\n` + files.map((f) => `- ${f.name} (${(Number(f.size || 0) / 1e6).toFixed(1)}MB)`).join('\n'));
      }
      if (!query) return text('query 또는 identifier 중 하나는 필수.');
      const en = koToEn(query);
      let eff = en || query;
      // date:[A TO B] + page 실측 검증 (2026-11-18)
      if (year_from || year_to) eff = `(${eff}) AND date:[${year_from || 1800}-01-01 TO ${year_to || 2030}-12-31]`;
      const u = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(eff)}&fl[]=identifier&fl[]=title&fl[]=date&fl[]=licenseurl&rows=${max_results}&page=${page}&output=json`;
      const d = await jget(u);
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
      if (total === undefined) { // SRU XML 아님 — Cloudflare 차단/점검 (2026-11-18 실측: 서버 IP 403)
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
      return text(`Europeana '${query}'${en ? ` → 영문 자동 변환 '${eff}'` : ''}${media_type ? ` [${media_type}]` : ''}${ytag} — total ${d.totalResults}:\n` + (items.map((it) => { const rt = rshort(it.rights); return `- ${String((it.title || ['?'])[0]).slice(0, 90)} (${(it.year || [''])[0]}) — ${String((it.dataProvider || [''])[0]).slice(0, 40)}${rt ? ` | 권리:${rt}` : ''} | ${it.guid || ''}`; }).join('\n') || '(0)') + '\nTip: multilingual — Corée(fr)·Korea-Krieg(de)·Corea(it/es)' + (demo ? '\n(shared demo key in use — for heavy use, set a free EUROPEANA_API_KEY from apis.europeana.eu)' : ''));
    });

const JB_RECIPES = `발굴 완주 레시피 — 주제 유형별 발굴→판독→권리 순서 (전 단계 실측 검증, 2026-11-21)
공통 원칙: ①cross_search로 폭 확보(variants=당대 표기) ②신호가 나온 소스의 전용 도구/판독 모드로 심층 ③권리는 표시(judge_rights·naid·라이선스) ④0건=부재가 아니다(표기 변형·인접 채굴·관리 행정으로 전환).

① 인물(독립운동가): gonghun(이름→mngNo→공훈록·수형기록. 훈격·이명 확보) → 이명·한자명으로 i815 재검색(당대 신문 전문 판독) → jacar(일본 측 — 한자명) → commons(초상·PD) → 수형기록의 판결문은 국가기록원 교차.
② 한국전쟁 전투·부대: koreanwar(협약 — archRfcd→koreanwar_item 인접 채굴) → nara(RG 교차+naid 인접, judge_rights(naid) 실확인) → tna(연대 필터)·awm(가평 등 영연방)·nlna(네덜란드) → un(안보리 결의 — recid 판독으로 PDF) → commons(PD 사진·원 소장처 역추적).
③ 조선 제도·고문헌: nedb law(법전 근거)→★sibling(형제 조 전수)→sjw(최초 용례) → kyujanggak(목록+해제)·jsg(청구기호→해제 전문) → aks(문중 고문서) → 인용 2층위 준수.
④ 일제강점기 정책·기관: ndl(총독부 간행물·통계연보·관보) ⇄ jacar(공문서 메타·인접 ±100) → nedb(한국사DB)·earchive('키워드|순번' 이용조건) → i815(민족 측 시각 대조).
⑤ 도시·공간사(서울 등): seoul_archives_search(기록 단위→상세 URL 판독: 식별번호·이용조건) → archives(국가기록원) → ktv(대한뉴스 view URL 판독) → commons·ia(항공·거리 사진) → cities 열쇠(Keijo·1914 경계).
⑥ 사진·영상 소싱(게재용): commons(File 판독 — PD→A 자동, 원본 고해상) → ia(identifier radius) → nara(naid→judge_rights 실확인) → ktv(KOGL) → 게재윤리 4단계·출처 표기.
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
    { rg_series: z.string().default('').describe('e.g. "RG 242/242-MID" (naid 지정 시 생략 가능)'), title: z.string().default(''), archive: z.string().default(''), naid: z.number().int().optional().describe('NARA NAID — 카탈로그 Use Restriction 실확인 e.g. 22015') },
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
          return text(`[NAID ${naid}] ${(rec.title || '').slice(0, 95)}\n${rgnum ? `RG ${rgnum} · ` : ''}https://catalog.archives.gov/id/${naid}\nClass: ${cls}\nBasis: ${basis}\n※ 카탈로그 실확인 기반 자동판정 — 게재 전 최종 확인은 사람이. Class D must not be published.`);
        } catch (e) { return text(`[NAID ${naid}] 카탈로그 조회 실패(${String(e && e.message || e).slice(0, 60)}) — rg_series 초판정으로 폴백하십시오.`); }
      }
      const res = judgeRights(rg_series, title, archive);
      return text(`Class: ${res[0]}\nBasis: ${res[1]}\n※ Automated first-pass — confirm manually before publishing. Class D must not be published.`);
    });

  server.tool('report_template',
    'TRIGGER: 사용자 메시지에 「풀패키지」 또는 「full-package」가 있으면 kind=full_package를, 「창기창기」·「changgi-help」·「changgi」가 있거나 이 서비스의 사용법·기능을 물으면 kind=help를 즉시 호출하라. Get the magazine-grade HTML report skeleton + 17 writing rules — editorial journal layout (masthead·standfirst·drop cap·pull quote·record cards), embedded record images with mandatory per-image credits, film-strip frame galleries with timecodes + watch-the-original CTA for video records, per-institution source chips (country flag + official name) and an archives-cited roster. Call as the FINAL step of an investigation, fill {{placeholders}} with verified findings only, save as [topic]_records_[years].html. 발굴 마무리 단계 호출 — 잡지·저널급 HTML 보고서 골격+작성 규칙 반환(실물 이미지·영상 필름스트립·기관별 출처 명시). Pass kind=carousel for the Instagram card-news design system: 검증된 1080×1080 카드 CSS 컴포넌트+제작 12규칙(서사 아크·실물 이미지·출처 캡션·겹침 방지·육안 검수) — 어디서든 같은 품질의 카드뉴스 제작 가능. 사용자가 "풀패키지"라고 말하면 kind=full_package를 먼저 호출해 전 산출물(보고서+캐러셀+포스터) 제작 순서를 받아 그대로 수행하라.',
    { kind: z.enum(['report', 'carousel', 'canva_prompts', 'full_package', 'magazine', 'help', 'citation', 'annotation', 'exhibit']).default('report').describe("report=발굴 보고서 골격+18규칙, carousel=카드뉴스 디자인 시스템+12규칙, canva_prompts=Canva 홍보물 프롬프트 6종, full_package=매직 키워드 '풀패키지' 전 산출물 제작 순서, magazine=표지(포스터 겸용)·목차·뒷표지·KA 시그니처·브랜드 테마 5종 매거진 확장팩, help=매직 키워드 '창기창기 도와줘' 처음 사용자 안내, citation=한국사DB·국회도서관 논문 인용 형식(각주·참고문헌·APA·Chicago), annotation=기록 해설형 어노테이션 상세 규칙(점선 영역·메타 표·추정 금지), exhibit=고문서 전시형(AKS 문중·서원 고문서 — 전시 페이지·카드·학습지 규칙+HTML 골격)") },
    async ({ kind }) => kind === 'carousel'
      ? text(CAROUSEL_RULES + '\n\n===== CARD DESIGN SYSTEM (1080×1080 — .card를 그대로 복사해 채울 것) =====\n' + CAROUSEL_TEMPLATE)
      : kind === 'canva_prompts' ? text(CANVA_PROMPTS)
      : kind === 'full_package' ? text(FULL_PACKAGE)
      : kind === 'magazine' ? text(MAGAZINE_PACK)
      : kind === 'help' ? text(HELP_GUIDE)
      : kind === 'citation' ? text(CITATION_GUIDE)
      : kind === 'annotation' ? text(ANNOTATION_GUIDE)
      : kind === 'exhibit' ? text(EXHIBIT_GUIDE)
      : text(REPORT_RULES + '\n\n===== HTML TEMPLATE (fill the {{placeholders}}) =====\n' + REPORT_TEMPLATE));

  // ===== 국내 아카이브 — 자동 브라우징(서버 사이드 fetch·파싱) v1.9.0 =====
  const dclean = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();
  const dbrowse = (u) => `\n열어보기: ${u}`;
  const agentBrowse = (name, q, u, why = '이 기관은 자동 페치가 제한적입니다') => `${name} '${q}' — ${why}.\n➤ 에이전트 지시: 이 메시지를 그대로 사용자에게 전달하지 마세요. 대신 당신의 웹 검색(WebSearch)으로 '${q}'를 이 기관에서 찾거나 아래 공식 검색 URL을 열람해 상위 결과(제목·연대·링크)를 표로 정리해 사용자에게 제시하세요. 결과가 있으면 report_template으로 HTML 보고서화도 가능합니다.\n공식 검색: ${u}`;


  server.tool('nedb_search',
    "국사편찬위 한국사DB(db.history.go.kr) 검색 + 기관별 심층 판독 모드. mode: total=통합검색(기본) · law=법전·편람 조문(한문 원문 제공 판정) · record=등록류(座目 자동 필터 — 건수 지표화 전 필수) · item=levelId 본문 판독(미공개/파싱실패 구분) · sibling=★형제 조 전수 스캔(levelId — 조문을 열었으면 반드시 이어 호출, 총론만으론 핵심을 놓친다) · matrix=법전 수록 대조(쉼표구분 어휘 ≤8 — 부재의 발견) · origin=어휘 연원('용어' 또는 '용어,영역') · sjw=승정원일기(왕대 분포·최초 용례) · kyujanggak=규장각 목록+해제(절목류는 해제에서 발견) · aks=한국고문서자료관(문중·서원 — 소장처 172곳→분류→문서 면·썸네일, query=소장처명/L-ID/'분류ID/문서ID') · jacar=일본 아시아역사자료센터(한→일 변환·레퍼런스코드 직행·±span×100 인접) · gonghun=공훈전자사료관(이름 검색→mngNo 투입 시 공적조서·공훈록 판독) · i815=독립기념관(query=키워드 목록→detail.do URL 투입 시 당대 신문기사·독립운동가 자료 본문 판독) · ktv=KTV(→view URL 투입 시 영상 해설·상영정보, KOGL) · earchive=국편 전자사료관(키워드 목록→'키워드|순번' 투입 시 상세: 열람·이용조건·등록번호) · commons=위키미디어 공용(키워드 목록→File URL 투입 시 라이선스·원 소장처·설명 판독) · jsg=장서각(키워드 목록→청구기호 K2-…/URL 투입 시 서지·해제 전문 판독) · un=UN 디지털도서관(키워드 목록→recid/URL 투입 시 요약·주제·언어별 PDF 직링크). 판정 우선: '601건' 아니라 '492건이 座目'을 반환.",
    { query: z.string().describe("검색어 · levelId(item/sibling) · 쉼표구분 어휘(matrix) · '용어,영역'(origin) · 소장처명/L-ID(aks) · 이름/mngNo(gonghun)"), db: z.string().default(''), max_results: z.number().int().min(1).max(50).default(15), mode: z.enum(['total', 'law', 'record', 'item', 'sibling', 'matrix', 'origin', 'sjw', 'kyujanggak', 'aks', 'jacar', 'gonghun', 'i815', 'ktv', 'earchive', 'commons', 'jsg', 'un']).default('total'), span: z.number().int().min(2).max(12).default(8).describe('sibling 모드 스캔 폭') },
    async ({ query, max_results, mode, span }) => {
      const q = query.trim();
      if (mode === 'un') { // UN 디지털도서관 — 키워드 목록 / recid·URL 판독(요약·주제·언어별 PDF)
        try {
          const UAH = { 'User-Agent': 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; archival discovery)' };
          const rm = q.match(/digitallibrary\.un\.org\/record\/(\d+)/) || q.match(/^(\d{4,9})$/);
          if (rm) {
            const recid = rm[1];
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
              + (abs ? `【요약】\n${abs.slice(0, 1500)}\n` : '')
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
          const dm = q.match(/dataId=(JSG_[\w.-]+)/) || q.match(/^(JSG_[\w.-]+)$/) || q.match(/^([A-Z]\d+(?:-\d+)*(?:[A-Za-z]*\d*)?)$/);
          if (dm && !/\s/.test(q) && (dm[1].startsWith('JSG_') || /^[A-Z]\d/.test(dm[1]))) {
            const did = dm[1].startsWith('JSG_') ? dm[1] : 'JSG_' + dm[1];
            const b = await cachedText('jsgD:' + did, 24 * 3600e3, () => gtext('https://jsg.aks.ac.kr/dir/view?dataId=' + encodeURIComponent(did)), '청구기호');
            const flat = dclean(b).replace(/&middot;/g, '·');
            const pick = (re2) => ((flat.match(re2) || [])[1] || '').trim();
            const name = pick(/자료명\(한글\)\s*([^·]{2,60}?)\s*·/);
            const callno = pick(/청구기호\s+(\S{2,20})/);
            const mf = pick(/MF번호\s+(\S{2,20})/);
            // 분류 3종은 연쇄 앵커로 — 단독 매칭은 내비게이션 필터 라벨과 혼동(실측)
            const cm = flat.match(/유형분류\s+(\S{2,20})\s+주제분류\s+(\S{2,30})\s+수집분류\s+(\S{2,30})/) || [];
            const cls = cm[1] || ''; const subj = cm[2] || '';
            const i0 = flat.indexOf('정의 ');
            let haeje = '';
            if (i0 >= 0) {
              haeje = flat.slice(i0, i0 + 6000).split(/집필자|관련 멀티미디어|장서각 디지털아카이브 바로가기/)[0].trim();
              if (haeje.length > 4000) haeje = haeje.slice(0, 4000) + ` …(총 ${haeje.length}자 — 전문은 원문 링크)`;
            }
            if (!callno && !haeje) return text(`'${did}' — 상세 미발견 또는 구조 상이. 청구기호(K2-…)를 확인하거나 mode=jsg에 검색어를 넣으십시오.`);
            return text(`장서각 서지·해제 판독 — ${name || did}\n`
              + [callno && `청구기호 ${callno}`, mf && `MF ${mf}`, cls, subj].filter(Boolean).join(' · ') + '\n'
              + (haeje ? `【해제】\n${haeje}\n` : '')
              + `원문·이미지: https://jsg.aks.ac.kr/dir/view?dataId=${encodeURIComponent(did)}\n`
              + '※ 출처: 한국학중앙연구원 장서각 — 게재 시 출처 표기, 이미지 재이용은 기관 이용조건 준수. 해제 인용은 국역·해설(학술 인용 시 집필 해제임을 명기).');
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
          const fm = q.match(/^https?:\/\/commons\.wikimedia\.org\/wiki\/(File:.+)$/i) || q.match(/^(File:.+)$/i);
          if (fm) {
            const title = decodeURIComponent(fm[1]).replace(/_/g, ' ');
            const d = JSON.parse(await cachedText('commonsD:' + title, 24 * 3600e3,
              async () => JSON.stringify(await jget('https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize&format=json&titles=' + encodeURIComponent(title), UAH)), 'imageinfo'));
            const page = Object.values((d.query || {}).pages || {})[0] || {};
            const ii = (page.imageinfo || [{}])[0] || {};
            const em = ii.extmetadata || {};
            const g = (k) => dclean(String((em[k] || {}).value || ''));
            const lic = g('LicenseShortName');
            if (!ii.url && !lic) return text(`'${title}' — 파일 미발견 또는 메타 없음. File: 제목/URL을 확인하십시오.`);
            const rights = /public domain/i.test(lic) ? 'A(퍼블릭 도메인 표기)' : /^cc/i.test(lic) ? `B(${lic} — 조건 준수 시 이용)` : `D('${lic || '미표기'}' — 확인 필요)`;
            return text(`위키미디어 공용 파일 판독 — ${title.replace(/^File:/, '')}\n`
              + [g('DateTimeOriginal') && `촬영/제작: ${g('DateTimeOriginal').slice(0, 40)}`, g('Artist') && `작가: ${g('Artist').slice(0, 70)}`, ii.width && `원본 ${ii.width}×${ii.height}`].filter(Boolean).join(' · ') + '\n'
              + `라이선스: ${lic || '(미표기)'} → 권리 초판정 ${rights}\n`
              + (g('Credit') ? `출처(원 소장처): ${g('Credit').slice(0, 160)}\n` : '')
              + (g('ImageDescription') ? `【설명】\n${g('ImageDescription').slice(0, 1200)}\n` : '')
              + (ii.url ? `원본 이미지: ${ii.url}\n` : '') + `파일 페이지: https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}\n`
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
            if (body.length > 4000) body = body.slice(0, 4000) + ` …(총 ${body.length}자 — 전문은 원문 링크)`;
            return text(`KTV e영상역사관 영상 판독 — ${title || '(제목 미상)'}\n`
              + [pdate && `제작연도: ${pdate}`, ptime && `상영시간: ${ptime}`, origin && `출처: ${origin}`].filter(Boolean).join(' · ') + '\n'
              + (body ? `【해설】\n${body}\n` : '') + `원문(영상 재생): ${q}\n`
              + '※ KTV 콘텐츠는 KOGL(공공누리) — judge_rights에 "KOGL" 표기로 초판정. 게재 시 출처 표기.');
          }
          const items = await COLLECT.ktv(q, Math.min(max_results, 10));
          if (!items.length) return text(`KTV e영상역사관 '${q}' — 0건. '대한뉴스'·사건명·인명으로 재시도하십시오.`);
          return text(`KTV e영상역사관 '${q}' — ${items.length}건:\n` + items.map((it) => `- ${it.title}\n  ${it.url}`).join('\n')
            + '\n※ view URL을 mode=ktv query로 재투입 → 영상 해설·제작연도·상영시간 판독.');
        } catch (e) { return text(`KTV 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://www.ehistory.go.kr`); }
      }
      if (mode === 'i815') { // 독립기념관 — 키워드 목록 / detail.do URL 본문 판독(당대 신문기사·독립운동가 자료)
        try {
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
            + '\n※ detail.do URL을 mode=i815 query로 재투입 → 자료 본문 판독.');
        } catch (e) { return text(`독립기념관 오류(${String(e && e.message || e).slice(0, 60)}) — 잠시 후 재시도 또는 브라우저: https://search.i815.or.kr`); }
      }
      if (mode === 'gonghun') { // 공훈전자사료관 — 이름 목록 / mngNo 심층 판독(공적조서·공훈록 본문)
        try {
          const b64d = (s) => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; } };
          const strip = (s) => dclean(String(s || ''));
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
            let rok = '', rokInfo = '';
            if (i2 >= 0) {
              const seg = strip(b.slice(b.indexOf('>', i2) + 1, i2 + 30000));
              rokInfo = (seg.match(/수록정보[:\s]*([^)]{3,40}\))/) || [])[1] || '';
              let body = seg.replace(/^[\s\S]{0,80}?수록정보[:\s]*[^)]{3,40}\)\s*/, '').trim();
              // 본문 경계: 게시판(감사의 글)·JS 찌꺼기 절단. 수형기록·묘소·현충시설 표는 분석 가치가 있어 유지
              body = body.split('감사의 글')[0].replace(/function\s+fn[\s\S]*$/, '').replace(/\$\{\w+\}/g, '').trim();
              rok = body.length > 4000 ? body.slice(0, 4000) + ` …(총 ${body.length}자 — 전문은 원문 링크)` : body;
            }
            if (!name && !summary) return text(`[mngNo ${q}] 공훈전자사료관 상세 파싱 실패 — 관리번호를 확인하거나 mode=gonghun에 이름으로 검색하십시오.`);
            return text(`공훈전자사료관 독립유공자 [관리번호 ${q}] ${name}${hanja ? `(${hanja})` : ''}${alias ? ` — 이명: ${alias}` : ''}\n`
              + `생몰: ${birth || '?'} ~ ${death || '?'}${bon ? ` · 본적: ${bon}` : ''}${aw ? `\n포상: ${aw[1]} ${aw[2]}` : ''}\n`
              + `【공적개요(공적조서)】\n${summary || '(없음)'}\n`
              + (rok ? `【공훈록${rokInfo ? ` — ${rokInfo}` : ''}】\n${rok}\n` : '')
              + `원문: https://e-gonghun.mpva.go.kr/user/ContribuReportDetail.do?goTocode=20001&mngNo=${q}&pageTitle=Report\n`
              + `※ 출처: 국가보훈부 공훈전자사료관 — 게재 시 출처 표기. 공적조서·공훈록은 원칙적 수정불가 원문(정부포상 결정·전문가 집필). 권리 초판정: judge_rights.`);
          }
          const items = await COLLECT.gonghun(q, Math.min(max_results, 10));
          if (!items.length) return text(`공훈전자사료관 '${q}' — 0건. 인명 검색 채널(독립유공자 공훈록)이므로 이름으로 검색하십시오. 이명·한자명도 시도 가치(예: 안응칠→안중근).`);
          return text(`공훈전자사료관 독립유공자 '${q}' — ${items.length}건:\n`
            + items.map((it) => `- [mngNo ${it.id}] ${it.title}\n  ${it.url}`).join('\n')
            + `\n※ mngNo 숫자를 mode=gonghun query로 재투입 → 공적조서·공훈록 본문 판독.`);
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
              ? `- [문서] ${k.name}\n  상세: mode=aks query='${q}/${k.id}'`
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
          let out = `법전·편람 '${q}' — 총 ${r.total}건:\n` + (lines.join('\n') || '(0건)');
          if (r.total === 0) out += `\n★ '${q}'는 법전에 수록되어 있지 않습니다. 법전 밖 관행일 가능성 — mode=record·sjw로 등록류·일기를 조회하십시오.`;
          else out += '\n※ 법전·편람은 한문 원문 제공 — 인용 가능(표점은 DB 형태·교감본 미대조). 조문을 열었으면 mode=sibling으로 형제 조를 반드시 확인.';
          return text(out);
        }
        if (mode === 'record') {
          const r = await jRecordSearch(q, Math.max(max_results, 50));
          const lines = r.real.slice(0, max_results).map((x) => `- [${x.id}] ${x.title.slice(0, 90)}\n  ${jCite(x.id)}`);
          let out = `등록류(비변사등록) '${q}' — 보고 총계 ${r.total}건 · 페이지 내 ${r.rows.length}건 중 座目 ${r.jwamok.length}건 제외 → 실질 ${r.real.length}건:\n` + (lines.join('\n') || '(실질 기사 0건)');
          if (r.jwamok.length) out += `\n★ ${Math.round(r.jwamok.length / Math.max(r.rows.length, 1) * 100)}%가 座目(회의 참석 명단)입니다. 검색 건수를 주제 중요도 지표로 쓰지 마십시오.`;
          out += '\n※ 등록류는 국역만 노출 — 한문 역구성은 학술 인용 불가.';
          return text(out);
        }
        if (mode === 'item') {
          const r = await jItemRead(q, 3000);
          if (r.status === 'ok') return text(`[${q}] ${r.title || ''}\n${r.body}\n(${r.chars}자) ${jCite(q)}\n※ ${r.isLaw ? '한문 원문 제공 — 인용 가능(표점 DB 형태)' : '국역만 제공 — 역구성 한문은 학술 인용 불가'}. 조문이면 mode=sibling으로 형제 조 확인.`);
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
          const absent = rows.filter((r) => r.total === 0 || !r.inCode);
          let out = '법전 수록 대조표:\n' + rows.map((r) => `- ${r.t}: ${r.total}건${r.earliest ? ' (' + r.earliest + (r.inCode ? '' : ' — 법전 아님') + ')' : ''}${r.total === 0 ? ' — 법전 미수록' : ''}`).join('\n');
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
          let out = `어휘 연원 '${term}' — 법전 ${r.total}건 · 영역 분포: ` + (sorted.map(([d, c]) => `${d} ${c}`).join(' · ') || '(판별 불가)');
          out += '\n대표 용례:\n' + r.results.slice(0, 4).map((x) => `- ${x.source} ${x.section} | ${x.excerpt.slice(0, 110)}`).join('\n');
          if (domain && !domains[domain]) out += `\n★ '${domain}' 영역 용례가 0건 — 이 용어는 주로 '${(sorted[0] || ['?'])[0]}' 영역에서 쓰였고 '${domain}'으로 전용된 것으로 보입니다. 전용 시점을 등록류·일기에서 확인하십시오.`;
          return text(out);
        }
        if (mode === 'sjw') {
          const r = await jSjw(q);
          let out = `승정원일기 '${q}' — 총 ${r.total}건`;
          const dist = Object.entries(r.dist);
          if (dist.length) out += '\n왕대 분포: ' + dist.map(([k, v]) => `${k} ${v}`).join(' · ');
          if (r.earliest) out += `\n★ 최초 용례 ${r.earliest.year}년(${r.earliest.reign}) — 관련 기구·제도의 성립 연대와 대조하십시오. 용어가 기구보다 앞서면 그 기구는 제도를 만든 것이 아니라 인수한 것입니다.`;
          return text(out + `\n검색: ${JSJW}/search/searchResultList.do (POST)`);
        }
        if (mode === 'kyujanggak') {
          const r = await jKyu(q);
          const fmt = (v) => Array.isArray(v) ? `${v.length}건 — ${v.slice(0, 12).join(' ')}` : `오류(${v.error})`;
          let out = `규장각 '${q}'\n목록: ${fmt(r['목록'])}\n해제: ${fmt(r['해제'])}`;
          const lc = Array.isArray(r['목록']) ? r['목록'].length : 0; const ac = Array.isArray(r['해제']) ? r['해제'].length : 0;
          if (ac > lc) out += '\n★ 해제 검색이 목록보다 많습니다 — 절목·사목류가 상위 서명 아래 편차(編次)로 들어가 있을 수 있습니다.';
          out += `
■ 원문 이미지 접근 지식(실측 2026-08-18) — GET·web_fetch 불가, ImageServlet 직접 URL은 브라우저에서 열림:
https://kyudb.snu.ac.kr/ImageServlet.do?imgFileNm=[파일명]&path=/data01/stream/[item_cd]/IMG/[book_cd]/[book_cd]_0001/
item_cd 5종(자료 성격별): ART 도설·회화 / ETC 두루마리·축 / DRR 등록류 / FND 재정·사목 / POL 정책·절목.
파일명 2형: 표준 [book_cd]_00_IH_0001_[nnn]a.jpg · POL계 [book_cd]_00IH_0001_[nnnn].jpg (밑줄 없음·4자리).
★반드시 첫 장 URL을 실제로 받아 패턴 확정 후 순회 — 추정 순회는 전부 실패한다(200 OK·0바이트 함정 포함). 게재는 소장기관 허가 확인(02-880-5316).`;
          return text(out);
        }
      } catch (e) { return text(`조선 심층 판독(${mode}) 실패: ${e.message} — 한국사DB 계열은 전부 POST이며 GET 재현이 불가합니다. 잠시 후 재시도.`); }
      // mode=total — 기존 통합검색
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
        while ((m = re.exec(b))) { const nm = dclean(m[1].replace(/<span[^>]*class="btn-new"[^>]*>[\s\S]*?<\/span>/g, '')); if (nm && !seen.has(nm)) { seen.add(nm); dbs.push(nm); } }
        if (dbs.length) return text(`한국사DB '${query}' — 검색어가 등장하는 DB ${dbs.length}종:\n` + dbs.slice(0, max_results).map((d) => '- ' + d).join('\n') + dbrowse(browse) + '\n각 DB에서 문서 단위로 열람. 한자 원표기 병행 검색 권장. 조선 제도사 심층 판독은 mode=law·record·sibling·matrix·origin·sjw·kyujanggak.');
        return text(agentBrowse('한국사DB', query, browse, '통합검색에서 매칭 DB 미검출'));
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
        if (xml.includes('searchError') || !xml.includes('<item>')) return text(agentBrowse('국가기록원', query, portal, `API 오류: ${xtag(xml, 'message') || '결과 없음'}`));
        const tot = xtag(xml, 'total') || '?';
        let items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        if (filt) items = items.filter((i) => { const y = parseInt((xtag(i, 'prod_year').match(/\d{4}/) || [])[0], 10); return y && y >= yf && y <= yt; });
        const lines = items.slice(0, max_results).map((i) => `- ${xtag(i, 'title').slice(0, 90)} (${xtag(i, 'prod_year')}) · ${xtag(i, 'prod_name').slice(0, 20)} [${xtag(i, 'is_open') === '1' ? '공개' : '비공개'}] ${xtag(i, 'link')}`);
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
            category ? gtext(base + '&category=' + encodeURIComponent(category)).catch(() => null) : Promise.resolve(null),
          ]);
          if (totalXml.includes('<error')) return text(`NLK OpenAPI 오류: ${xtag(totalXml, 'msg') || '?'} — NLK_API_KEY 확인.` + dbrowse(openUrl));
          const A = parse(totalXml);
          let out = `국립중앙도서관 자동검색(전체 소장자료) '${query}'${yfilt ? ` [발행 ${year_from || ''}~${year_to || ''} · 상위 50건 내 후처리·연대 미상 제외]` : ''} — 총 ${A.tot}건${yfilt ? ` 중 연대 일치 ${A.matched}건` : ''}:\n` + (A.lines.join('\n') || '(0건)');
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
    "Search 서울기록원 (archives.seoul.go.kr) — 기록 단위 검색(시리즈·기록건 제목+상세 딥링크). query에 /item·/aggregation 상세 URL 투입 시 심층 판독: 식별번호(RG-SR-IT)·기술계층·법적지위·소장처·이용조건(judge_rights 투입)·기술 본문. Seoul municipal records/photos/oral histories.",
    { query: z.string().describe('검색어 또는 archives.seoul.go.kr/item·/aggregation 상세 URL'), max_results: z.number().int().min(1).max(50).default(15) },
    async ({ query, max_results }) => {
      const q = query.trim();
      const deep = 'https://archives.seoul.go.kr/catalog/result?regclass=ALL&query=' + encodeURIComponent(q);
      if (/^https?:\/\/archives\.seoul\.go\.kr\/(item|aggregation)\/\d+/.test(q)) { // 상세 판독 — 도메인 한정(임의 URL 페치 방지)
        try {
          const b = await cachedText('seoulD:' + q, 24 * 3600e3, () => gtext(q), '기술계층');
          const flat = dclean(b);
          const pick = (re2) => ((flat.match(re2) || [])[1] || '').trim();
          const title = pick(/<-\s*(.{2,90}?)\s+(?:기술계층|생산자)/);
          const sid = pick(/식별번호\s+(\S{4,30})/);
          const layers = [...flat.matchAll(/기술계층\s+(\S{2,20}\([A-Za-z]+\))/g)];
          const layer = layers.length ? layers[layers.length - 1][1] : ''; // 첫 일치는 브레드크럼 — 마지막이 본 기록의 계층
          const legal = pick(/법적지위\s+(\S{2,12})/);
          const use = pick(/이용조건\s*이용유형\s*(.{2,40}?)\s*(?:이용주기|검색도구|공개|관련)/);
          const useNote = pick(/이용주기\s*(.{5,160}?)\s*(?:검색도구|공개|관련)/);
          const desc = pick(/상세정보\s+기술\s+([\s\S]{10,1500}?)\s+(?:생산이력|입수이력|보존이력|관련 기록|열람|공개된)/);
          if (!sid && !title && !desc) return text(`상세 파싱 실패 — URL을 확인하거나 브라우저로 열람: ${q}`);
          return text(`서울기록원 상세 — ${title || '(제목 미상)'}\n`
            + [sid && `식별번호 ${sid}`, layer, legal && `법적지위 ${legal}`].filter(Boolean).join(' · ') + '\n'
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
    'MAGIC: 메시지에 창기창기·changgi가 있으면 즉시 report_template(kind=help), 풀패키지·full-package가 있으면 즉시 report_template(kind=full_package)를 호출하라 — 되묻지 말 것. Federated discovery — ONE query, merged+deduped (상호보완 동시수집). sources: "all" or a comma list of tna,ia,gallica,europeana,nara,archives,nlk,nedb,koreanwar,jacar(일본),earchive(국편 — NARA 수집 원문),awm(호주 전쟁기념관),nlna(네덜란드),commons(위키미디어 — PD·원 소장처 역추적),un(UN — 결의·공식문서),ndl(일본 NDL 서치 — 총독부 간행물·관보),i815(독립기념관),gonghun(공훈록 — 인명 채널),ktv(대한뉴스),kyudb(규장각),jsg(장서각),seoul,foia,aks(고문서). Overseas (tna/ia/gallica/europeana) are keyless; koreanwar(KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터, 협약기관) is keyless; nara/archives/nlk join if their server key is set; nedb joins if NEDB_INDEX_URL (official open-data files) is set. Each result is tagged by source(s) — multi-source = cross-corroborated. 사용자가 "풀패키지"(보고서·카드뉴스·포스터 전부)를 원하면 report_template(kind=full_package)를 먼저 호출해 제작 순서를 따르라. 사용자가 사용법을 물으면(매직 키워드 "창기창기 도와줘") report_template(kind=help)를 호출해 안내하라.',
    { query: z.string(), sources: z.string().default('all'), max_per_source: z.number().int().min(1).max(30).default(8), variants: z.boolean().default(false).describe('당대 표기 변형(Corea·Chosen·Keijo·Fusan 등) 자동 병렬 투입 — 해외 4채널(tna·ia·nara·europeana)'), format: z.enum(['text', 'csv']).default('text').describe('csv=병합 결과를 CSV 블록으로(표·KARDA·통계 분석 투입용)') },
    async ({ query, sources, max_per_source, variants, format }) => {
      const want = sources.trim().toLowerCase() === 'all'
        ? Object.keys(COLLECT)
        : sources.split(',').map((s) => s.trim().toLowerCase()).filter((s) => COLLECT[s]);
      if (!want.length) return text('sources: "all" 또는 ' + Object.keys(COLLECT).join(','));
      const jobs = want.map((s) => ({ source: s, fn: () => COLLECT[s](query, max_per_source) }));
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
        for (const src of ['tna', 'ia', 'nara', 'europeana']) {
          if (!want.includes(src)) continue;
          for (const [label, vq] of vs) jobs.push({ source: `${src}·${label}`, fn: () => COLLECT[src](vq, max_per_source) });
        }
      }
      const { items, stats } = await collectMerged(jobs);
      items.sort((a, b) => b.sources.length - a.sources.length);
      if (format === 'csv') { // 분석 투입용 구조화 출력 — "자료로써 분석할 수 있게"
        const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const rows = items.slice(0, 45).map((it) => [it.sources.join('+'), it.title, it.date, it.id, it.url].map(esc).join(','));
        return text(`교차수집 '${query}' CSV — 채널별 [${stats.join(' · ')}] → 병합 ${items.length}건 (45건 상한):\n`
          + 'sources,title,date,id,url\n' + rows.join('\n')
          + '\n※ 그대로 스프레드시트·KARDA 온톨로지(nodes/edges)·통계 분석에 투입 가능. 권리 초판정: judge_rights.');
      }
      const lines = items.slice(0, 45).map((it) => `- [${it.sources.join('+')}] ${it.title.slice(0, 95)}${it.date ? ` (${it.date})` : ''}${it.url ? ' ' + it.url : ''}`);
      return text(`교차수집 '${query}' — 채널별 [${stats.join(' · ')}] → 병합 ${items.length}건 (복수출처 우선 정렬):\n` + (lines.join('\n') || '(0)')
        + '\n※ [출처] 복수 표기 = 교차확인된 record. 국내(nara·archives·nlk)는 서버 키, nedb는 NEDB_INDEX_URL(공식 개방파일) 설정 시 포함. open.go.kr 본체(브라우저 전용)는 foia_search 전용 도구로.\n※ 발굴 우선 — 권리는 표시: 게재 전 judge_rights(참조코드·KOGL·naid)로 초판정. variants=true로 당대 표기(Corea·Chosen·Keijo…) 자동 팬아웃.'
        + '\n※ 심층 판독 이어가기: [i815]→nedb_search(mode=i815, 상세URL) · [gonghun]→mode=gonghun(mngNo) · [ktv]→mode=ktv(view URL) · [earchive]→mode=earchive(\'키워드|순번\') · [jacar]→mode=jacar(레퍼런스코드) · [seoul]→seoul_archives_search(상세URL) · [koreanwar]→koreanwar_item(archRfcd) · [nara]→judge_rights(naid).');
    });

  server.tool('source_profile',
    'Structural profile of an archive for planning discovery: 자료구조(data model: hierarchy/classification/identifiers/metadata), 이용구조(access: API/auth/query syntax/robots/rights), 활용구조(utilization: how the 3 mismatches show up, which keyword set/cross-map to use, adjacent mining, cross-archive verification combos, rights rule). institution: "list" or a key — tna·nara·ia·gallica·europeana·nedb·archives·nlk·seoul·warmemo·koreanwar·foia; "health"=24채널 골든 질의 일괄 헬스체크(🟢🟡🔴+키 설정 상태). 기관 자료·이용·활용구조 프로파일.',
    { institution: z.string().default('list') },
    async ({ institution }) => {
      const t = (institution || 'list').trim().toLowerCase();
      if (t === 'health') { // 24채널 일괄 헬스체크 — 발굴 우선 원칙의 전제: 깨짐을 스스로 발견한다
        const GOLD = { tna: 'Korea', ia: 'Korea', gallica: 'Corée', europeana: 'Korea', nara: 'Korea',
          archives: '한국전쟁', nlk: '한국전쟁', nedb: '한강', koreanwar: '장진호', jacar: 'Chosen', earchive: '제주도', i815: '안중근', gonghun: '안중근', ktv: '대한뉴스', kyudb: '절목', jsg: '의궤', awm: 'Kapyong', nlna: 'Korea', commons: 'Seoul 1950', un: 'Korea armistice', ndl: '조선총독부', seoul: '한강', foia: '회의', aks: '문중' };
        const keys = { NARA_API_KEY: !!process.env.NARA_API_KEY, ARCHIVES_API_KEY: !!process.env.ARCHIVES_API_KEY,
          NLK_API_KEY: !!process.env.NLK_API_KEY, EUROPEANA_API_KEY: !!process.env.EUROPEANA_API_KEY,
          KOREANWAR_API_TOKEN: !!process.env.KOREANWAR_API_TOKEN, NEDB_INDEX_URL: !!process.env.NEDB_INDEX_URL };
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
        return text('24채널 헬스체크 (골든 질의 실측):\n' + rows.join('\n')
          + '\n\n서버 키·설정: ' + Object.entries(keys).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' · ')
          + '\n※ 🟡=연결 정상이나 0건(질의 특성 또는 파서 점검 필요) · 🔴=채널 실패(차단·타임아웃) · ms=채널 응답시간. nedb ✗=개방파일 인덱스 미설정.');
      }
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

const REPORT_RULES = `HTML 발굴 보고서 작성 규칙 (18) — 잡지·저널급 편집 기준
1. 파일명: [주제영문]_records_[연도범위].html — 조사 완료 시 기본 산출물
2. 지면 구조(잡지형): masthead → kicker → 표제(h1) → standfirst → byline(기관 chip) → 목차(nav.toc) → 히어로 figure → Ⅰ서사 → Ⅱ핵심 기록 카드 → Ⅲ영상 필름스트립 → Ⅳ전수 목록 표 → Ⅴ재현 쿼리(details) → Ⅵ권리·게재 윤리 → 출처 총람(.sources) → footer
3. 서사 우선: 표만 나열 금지 — 발굴 경위·의미를 에세이로 서술(리드 문단 .lead 드롭캡, 풀인용 .pull 1개 이상). 문단이 실물을 설명하면 그 문단 옆에 인라인 도판(.fig-inline 플로트)을 배치 — 잡지처럼 글과 그림이 같은 화면에 보이게. 문체는 담백·구체 — 과장어(놀라운·혁신적 등)와 AI투 금지
4. 실물 이미지 필수: 게재 가능(권리 A/B+게재윤리 1·2단계) 기록은 기관 공개 원본을 base64 임베드 — 히어로 1장+핵심 기록마다, 공개 컷은 전량(.sheet 콘택트시트·컷별 라벨). 비식별판 우선. 이미지는 max-width:100% 자동 축소. 환경별: 로컬=base64 임베드 / 웹·모바일(파일·base64 불가)=기관 공개 원본 URL을 img src로 직접 참조하고 footer에 그 사실을 명기. 한 장도 못 실으면 사유를 Ⅵ절에 명기
5. 모든 이미지에 figcaption + .credit 필수: "출처: 기관 정식명(국가) · 식별자 · 촬영자/생산자 · 원본 링크" — 출처 없는 이미지는 싣지 않는다
6. 영상 기록은 .film 필름스트립: 장면 전환마다 프레임을 충분히 추출(권장 8~16장)해 타임코드(.tc)+한 줄 설명으로 나열 — 표제가 가린 장면(ETC 뒤)을 드러내 원본을 직접 보고 싶게 만든다. 슬레이트·표지판 판독 프레임은 별도 확대 figure. 블록 끝에 .cta "▶ 원본 영상 보기 — [기관] 카탈로그"
7. 핵심 기록 3~6건은 .record 카드로: 이미지 + 한국어 제목(원제 병기) + .prov 출처 계보(국가→기관→RG/시리즈→상자→식별자) + 요약 + 바로가기 버튼 + 권리 배지
8. 전수 목록 표(부록형): 식별자·원제 / 연대 / 소장처·청구정보(RG·Entry·Box) / 내용 / 바로가기(원문→해제→카탈로그) / 권리초판 배지(b-A 공개확정 · b-B PD추정 · b-C 허가필요 · b-D 지위불명)
9. 출처 명시(전 지면): byline·본문에 기관 chip(국기 이모지+정식명 — 🇺🇸 NARA · 🇬🇧 TNA · 🇫🇷 BnF Gallica · 🇪🇺 Europeana · 🇺🇸 archive.org · 🇰🇷 국가기록원 · 🇰🇷 KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터 등), 말미 .sources에 인용 기관 총람(국기·정식명·청구정보·이용조건·링크)
10. 재현 쿼리는 details 접이식 — 실제 실행한 쿼리만(목적/쿼리/URL 인코딩 실행 링크). '0건 ≠ 부재' note(인접 상자 ±2·피스 ±15 권고) 포함
11. 종합 색인·최신 연구 목록(ul.src) — details로 접어도 된다
12. Ⅵ 권리 절: 법적 근거(17 U.S.C. §105 · 36 CFR 1254.62 · Crown/OGL · domaine public · KOGL) + '출판 전 인간 최종 확인 필수' + D등급 공개 금지. 민감 주제(위안부·포로·학살)는 피해자 존엄 문구와 게재윤리 4단계(거부할 수 없었던 처지의 촬영 = 화면 미사용) 적용
13. 링크·수치는 도구 호출로 실확인한 것만 — 추정 URL 금지, footer에 '모든 링크 [날짜] 접속 확인' 명기
14. 연표·지도·관계도는 인라인 svg로 직접 작성 가능. 외부 리소스 금지(폰트·CDN) — 로컬은 단일 파일 자기완결(base64), 웹·모바일 산출만 기관 공개 이미지 URL 참조 예외 허용
15. 인쇄 대응: 템플릿의 @media print 유지 — 보고서는 그대로 출판물처럼 인쇄 가능해야 한다
16. 링크 신뢰장치: ①digitised 기록은 카탈로그 무료 미리보기 이미지를 공식 엔드포인트로 확보해 원문 figure로 임베드(예: TNA /image/getimage — 워터마크 원상태, 유료 전체본은 안내만) ②그 외 주요 링크는 페이지 캡쳐본 figure+credit(갈무리 일자) ③자동화 차단 시 명기하고 API 기술 원문 인용표로 대체. 훈격·날짜·건수는 API 원문 대조 '검증 기록'으로 — 초판 오류는 정정 이력을 남긴다
17. 카드뉴스·포스터 병행: 보고서와 함께 캐러셀(기본 8장, 1080×1080)과 포스터 시리즈(1080×1350 세로형 4~6장 — 표제·인물·문서·검증·초대의 연작 서사, 같은 검수 기준 — insta-carousel 스킬 또는 report_template(kind='carousel') 참조)을 제작하고, 보고서 말미 '카드뉴스' 절에 .cards-grid로 임베드한다 — 무크롭 전체 노출 + 카드별 figcaption, 잘림·겹침 금지. 커버는 히어로와 같은 실물 이미지, 검증 노트·따라하기 카드 포함, 보고서와 출처 대장 공유. PNG 원본·caption.txt·sources.txt를 보고서와 함께 납품
18. 더 보기 절(Ⅷ): 출처 총람 직전에 관련 공개 콘텐츠 소개 — 뉴스(📰)·기관 아카이브(🏛️)·해설/백과(📚)·SNS/영상 등을 카테고리 이모지+한 줄 설명으로. 접속 확인한 링크만(확인일 명기), 미확보 카테고리는 그 사실+추천 검색어 명시 — 발굴을 현재의 기억과 잇는 절`;

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
3. 실물 이미지가 신뢰를 만든다: 주제가 실존 대상(기관·유물·사건·인물)이면 퍼블릭 도메인/공공누리 실물을 능동 발굴해 쓴다. 기관 비식별(블러)판 제공 시 우선 사용
4. 이미지 카드마다 출처 캡션(.credit) 필수: "출처: 기관 정식명, 식별번호 (라이선스)" — 식별번호를 알면서 생략하면 부정확한 출처다. 이미지별 출처 대장(sources.txt) 동봉, 라이선스 미확정이면 '게시 전 [권리자] 확인' 안내
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
국내외 24개 아카이브(🇺🇸 NARA · 🇬🇧 TNA · Internet Archive · 🇫🇷 갈리카 · 🇪🇺 유러피아나 · 🇯🇵 아시아역사자료센터 JACAR · 🇦🇺 호주 전쟁기념관 · 🇳🇱 네덜란드 국립문서보관소 · 🌐 위키미디어 공용 · 🇺🇳 UN 디지털도서관 · 🇯🇵 NDL 서치 · 🇰🇷 국가기록원·국립중앙도서관·한국사DB·국편 전자사료관·독립기념관·공훈전자사료관·KTV e영상역사관·규장각·장서각·한국고문서자료관·서울기록원·정보공개포털·KOREAN WAR ARCHIVES 협약기관)에서 한국 관련 기록·사진·영상(1860~1960)을 발굴하고, 검증하고, 전파물까지 만들어 준다. 한국어 한 문장이면 충분 — 표기 변형(Corea·Chosen·Corée·한자·朝鮮)과 색인 언어 변환은 자동. 카카오 PlayMCP 마켓 등록본으로도 연결 가능('KOREA ARCHIVE 통합검색' 검색 — 같은 서버).

■ 매직 키워드 2개
① “○○○ 풀패키지로 만들어줘” — 조사→검증→매거진 보고서→카드뉴스 8장→포스터→홍보·입문·메시지 카드→발표 PPTX(대본 포함)→기록 해설→Canva 편집본→KARDA 연구 데이터까지 전 산출물 자동(report_template kind=full_package 순서를 따름).
② “창기창기 도와줘” — 이 사용 안내.

■ 이렇게 물어보면 된다 (예시)
· “할아버지가 참전한 글로스터 연대 기록 찾아줘” (실전 1호 — TNA 훈장 추천서 원문까지)
· “장진호 전투 영상 기록 찾아줘” (실전 2호 — 3개국 3중 소장 실증)
· “조선시대 한강 나루의 행정을 정리해줘” (법전 판독→형제 조 전수→연대 검증 제도사)
· “병인양요 프랑스 기록 찾아줘” / “이 참조코드 주변을 더 캐줘”(인접 채굴) / “이 기록 게재 가능한지 판정해줘”
· “안중근 공훈록 전문 보여줘”(독립유공자 — 공적조서·수형기록·현충시설까지) / “이 NARA 기록 권리 실확인해줘”(naid)
· “이 의궤 해제 읽어줘”(장서각 K2-…) / “안보리 결의 원문 PDF”(UN recid) / “이 1910년 기사 전문”(독립기념관 URL)

■ 검증 원칙(차별점) — 실물 기록만(AI 생성 인물·장면 금지)·원문 대조·출처 명시·정정 공개. 통과 산출물에만 검증 낙관.

■ 자주 묻는 것
· 0건 → 부재가 아니다. 표기 변형·인접 채굴·“대상을 관리한 행정”으로 전환.
· ZIP 일괄 납품은 로컬 환경 전용 — 웹·모바일은 개별 아티팩트+manifest.
· 이미지: 웹은 기관 공개 URL 참조 — 원본은 항상 기관 링크에서 열람.
· 조선 주제 → nedb_search 심층 판독 모드(law·sibling·matrix·origin·record·sjw·kyujanggak·aks[한국고문서자료관 — 문중·서원 고문서 172곳]). 심층 판독 9채널 — 발굴 결과의 URL·번호를 nedb_search 모드에 재투입: i815(당대 신문 전문)·gonghun(공적조서·공훈록)·jacar(일본 공문서 메타)·ktv(대한뉴스 해설)·earchive(수집 사료 이용조건)·commons(PD 파일 라이선스·원 소장처)·jsg(장서각 해제 전문)·un(UN 문서 요약·PDF) + seoul_archives_search(상세 URL). 연합 검색 푸터가 경로를 안내한다.\n· 연대로 좁히기 → 주요 검색 도구의 year_from/year_to. 번호 옆 훑기(인접 채굴) → TNA·NARA(naid)·archive.org(radius)·6·25아카이브. 당대 표기 자동 팬아웃 → cross_search(variants). 채널 상태 → source_profile('health').

커넥터: korea-archive-mcp.vercel.app/api/mcp · 안내 페이지: korea-archive-mcp.vercel.app/help.html`;

const FULL_PACKAGE = `풀패키지 오케스트레이션 — 발굴에서 전파물까지 한 번에 (매직 키워드: "풀패키지" · "전부 다 만들어줘")
입력은 주제 하나면 충분하다. 아래 순서를 전부 수행해 모든 산출물을 함께 납품한다.

1. 발굴 조사: cross_search + 전문 도구(tna_search/nara_search/koreanwar_search/gallica_search…) — 표기 변형 병렬,
   시리즈 특정+tna_adjacent_mine 인접 채굴(±5~15), 국내 협약기관 교차검증, 카탈로그 API 원문으로 훈격·날짜·건수 검증
   (정정 발생 시 이력 기록), judge_rights 권리 초판. 핵심 기록은 심층 판독으로 본문·권리 실확인: nedb_search 모드(i815 당대 신문·gonghun 공훈록·ktv 영상·earchive 수집사료·commons PD파일·jsg 해제)와 seoul_archives_search(상세URL)·koreanwar_item·judge_rights(naid). 조선~대한제국 주제면 심층 판독 경로 추가: nedb_search 모드 활용 — law(법전 근거)→★sibling(조문을 열었으면 형제 조 전수 — 총론만 읽으면 핵심을 놓친다)→matrix(법전 수록 대조로 부재 발견)→origin(어휘 연원)→record(등록류 — 座目 필터)→sjw(최초 용례로 연대 검증)→kyujanggak(목록+해제). 보고서에 제도 재구성 절(등록·측정·운항·동원·보상 + 제도의 끝)·법전 대조표·자기 정정 이력을 추가하고, 인용은 2층위(법전=원문 인용 가능/등록·일기=국역만·역구성 학술 인용 불가) 명기.
2. 실물 이미지 수집: 기관 공개 원본 전량(비식별판 우선) + digitised 기록의 카탈로그 무료 미리보기.
   수집 즉시 출처 대장(sources.txt) 기록. AI 생성 인물·역사 장면 절대 금지.
3. HTML 보고서: report_template(kind='report') 18규칙 전부 — 히어로 실물·인라인 도판·콘택트시트·원문 미리보기·
   검증 기록·전수 목록·재현 쿼리·더 보기·카드뉴스 갤러리. 매거진 완성판은 kind=magazine 확장팩을 덧입힌다. 산출 방식 — 로컬: .html 파일 저장 / 웹·모바일: HTML 아티팩트로 게시(파일 저장 불가), 이미지는 기관 공개 URL 참조. 수치는 모든 산출물에서 동일해야 한다.
4. 캐러셀 8장: report_template(kind='carousel') 12규칙 — 커버는 보고서 히어로와 같은 실물, 검증 노트·따라하기 포함.
   렌더는 환경별: 로컬=헤드리스 렌더 / 웹·모바일=Canva 커넥터 생성→페이지별 PNG 내보내기. 전 장 육안 검수 생략 금지.
   caption.txt + sources.txt 동봉.
5. Canva 산출물(커넥터 연결 시): 캐러셀 편집본 + report_template(kind='canva_prompts') 1번 템플릿으로 포스터 1종 —
   생성 직후 전 한국어 문구를 검증 카피로 교정(replace_text) 후 저장.
6. 납품: 보고서 HTML + 카드 8장 + 포스터 시리즈 + caption/sources + Canva 링크. 로컬: 전체를 [주제영문]_fullpackage_[날짜].zip으로 묶어 함께 납품 — 구조 report/·cards/·posters/·canva/·pptx/·manifest.txt(산출물 목록+검증 요약). 웹·모바일: zip 생성 불가 — 개별 아티팩트로 제시하고 manifest 목록을 함께 출력. SNS 게시·공개 푸시는 사용자 확인 후. 발표자료(pptx): 발표·강의용 16:9 슬라이드 12~16장 병행 제작 — 표지·목차·발굴 경위·핵심 기록(실물 프레임+보고서 지면 캡쳐)·검증과 윤리·KARDA·전파물·CTA·출처 총람. 전 슬라이드 발표 노트(대본)와 도판별 출처 표기 필수, 저해상 프레임은 풀블리드 확대 대신 필름스트립 다컷 배치. Canva 편집본: 로컬은 공개 쇼케이스 URL 경유 import-design-from-url, 웹은 Canva 커넥터로 직접 생성해 편집 링크 제공.
7. 작업 로그(activity_log.md): 조사 중 모든 행위를 시간순 표로 기록 — 단계(발굴/교차검증/검증/수집/산출)·행위·도구와 쿼리·결과 건수·응답 규모. 이어서 분석 절: 도구·채널별 호출 통계와 성과, 0건→방법 전환 회수율, 검증 정정률, 소요·병목, 산출물 규모. LLM 토큰은 정확 집계 불가(클라이언트 영역) — 대리 지표(호출 수·바이트·소요)로 기록하고 그 사실을 명시. 로그+보고서 Ⅴ절+manifest가 감사 추적 3종 세트로 zip에 포함된다.
8. KARDA 온톨로지 산출물(kad/): 발굴 결과를 관계 그래프 입력으로 변환해 zip에 포함 — karda_nodes.csv(id·type[record/agent/unit/place/event]·label·속성)·karda_edges.csv(source·target·relation·relation_ko·basis·confidence)·kad_readme.txt. 신뢰도 필터: 확정(API·원문 판독)·높음만 그래프 수록, 부분 이하는 tentative로 readme에 명기(그래프 오염 방지). 관계마다 근거(basis)를 남겨 연구 재검증 가능하게. 로컬은 make_metadata.py 활용 가능. 품질 게이트 추가: ①보고서 CSS는 템플릿 전체를 그대로 포함(부분 복사 금지 — 영상 절 등 미사용 스타일도 포함해야 절 추가 시 깨지지 않는다) ②핵심 기록 카드는 수집된 실물이 있으면 반드시 이미지 포함(자료 화면 대체 시 그 사실 명기) ③갤러리·절은 placeholder 주석이 아니라 실제 임베드 — 납품 전 잔존 placeholder 검사. 홍보 카드뉴스 제작 시: 텍스트 위주 금지 — 매거진 실제 지면 캡쳐(표지·차례·본문 스프레드·필름스트립·기록 카드·갤러리·검증 낙관)를 카드마다 수록해 산출물 품질을 눈으로 증명한다. 입문 카드뉴스(키워드 정복형) 병행 제작: 처음 접하는 일반 시민 대상 — 후킹 문구(“○○은 처음이지?”·“○○ 완벽 해설”·“3분 정복”) 적극 사용, 카드마다 키워드 1개를 초대형 타이포로 강조하고 한두 줄 쉬운 설명(중학생 눈높이·비유 허용·전문용어 풀어쓰기), 실물 프레임·지면 캡쳐 동반, 마지막 카드는 “정복 완료!”+다음 키워드 참여 유도. ZIP에는 intro/ 폴더로 수록. 메시지형(미장센 문법) 병행 제작: 강연 오프닝·SNS 임팩트용 카드뉴스+슬라이드 — 1장 = 실물 미장센 이미지 1 + 메시지 한 문장, 서사 아크는 충격 오프닝→과거→반전→블랙아웃 테제(텍스트만)→원칙→결과→선언→CTA. 이미지는 실물 기록만(AI 연출 이미지 금지 — 저해상 프레임은 어둡게 깔아 무드로 사용), 장마다 출처 1줄, 슬라이드판은 발표 노트에 미장센·디렉팅 의도 기록. ZIP에는 message/ 폴더로 수록. 시연 영상(선택): 산출물·서비스 데모 GIF/MP4 병행 — 로컬은 demo-video 스킬(실브라우저 구동 녹화), 웹은 페이지 연속 캡쳐 프레임을 GIF로 합성. ZIP에는 video/ 폴더로 수록. 기록 해설형(도큐먼트 애노테이션) 병행 제작: 서울기록원류 해설 지면 문법 — 기록·프레임 위에 점선 영역 박스+외곽 모서리 번호 칩으로 요소를 하나하나 판독(마커가 내용을 가리지 않게 — 점 찍기 금지, 레터박스 검은 띠 제거 후 원본 비율 유지, 색은 지면 팔레트와 조화)(인장·타이틀·타임코드·워터마크·부대 표식 등), 상단에 메타데이터 표(제목·식별번호·제작·소재·시기·권리), 원판/사본 계보 명기. 판독은 화면·원문에서 직접 읽히는 것만(추정 금지, 불명은 표기). 보고서에는 ‘기록을 해설해 드립니다’ 부록 절로, 카드뉴스·슬라이드로도 병행(슬라이드 노트에 판독 해설). ZIP에는 annotate/ 폴더로 수록.

품질 게이트: 수치 정합 · 전 이미지 캡션+출처(기관 정식명·국가·식별자·링크) · 실확인 링크만(확인일 명기) ·
게재윤리 4단계(포로·사망자 존엄) · 협약기관 출처 표기 필수.`;

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

export { handler as GET, handler as POST, handler as DELETE };
