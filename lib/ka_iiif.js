// IIIF 브리지 2 (v1.99) — IIIF를 내지 않는 기관의 기록을 IIIF Presentation 3 매니페스트로.
//   /iiif/heritage/{kdcd-asno-ctcd}/manifest.json  국가유산청 국가유산포털(종목·시대·소유·소재·해설 + 이미지 목록 API)
//   /iiif/much/{idnbr}/manifest.json               대한민국역사박물관 근현대사아카이브(재질·크기·공공누리 유형·설명 + 이미지)
//   /iiif/awm/{C-id}/manifest.json                 호주 전쟁기념관(제목·수장번호·저작권 만료 표시 + 공개 이미지)
//   /iiif/commons/{File:…}/manifest.json           위키미디어 공용(라이선스·작가·설명 + 1600px·원본)
// 원칙: 기관이 표시한 권리 문구를 원문 그대로 metadata에, 판독 시각·설명 지문(sha256-16)으로 증거성, 원 기관 페이지 homepage.
import { encodeEnv, buildRecManifest } from './rec_iiif.js';
import { createHash } from 'node:crypto';
import { imageSize } from './nara_iiif.js';

export const ORIGIN = 'https://korea-archive-mcp.vercel.app';
const UA = 'KoreaArchiveMCP/1.0 (+https://github.com/changgi/korea-archive-mcp; IIIF bridge)'; // 정직한 식별자 — 브라우저 위장 금지(CLAUDE.md). 자동 요청을 거부하는 기관은 '기술적 불능'으로 표시
const L = (s, lang = 'none') => ({ [lang]: [String(s ?? '').slice(0, 1500)] });
const MV = (k, v) => ({ label: { ko: [k] }, value: L(v) });
const fp16 = (s) => (s ? createHash('sha256').update(String(s)).digest('hex').slice(0, 16) : '');
const clean = (h) => String(h || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim();
const xtag = (b, t) => { const m = String(b).match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)); return m ? m[1].trim() : ''; };
const get = async (u, t = 15000) => { const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(t) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); };
const navOf = (s) => { s = String(s || ''); let m = s.match(/(1[5-9]\d\d|20\d\d)[-./](\d{1,2})[-./](\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00Z`;
  m = s.match(/(?<!\d)(1[5-9]\d\d|20\d\d)(?!\d)/); return m ? `${m[1]}-01-01T00:00:00Z` : ''; };
export const bridgeUrl = (src, id) => `${ORIGIN}/iiif/${src}/${encodeURIComponent(id)}/manifest.json`;
export const kvUrl = (m) => `https://changgi.github.io/korea-archive-mcp/kv.html?manifest=${encodeURIComponent(m)}`;

async function canvases(id, imgs) { // imgs: [{url, label, md?}] → 크기 판독(동시 6) 후 캔버스, 크기 미상은 rendering으로
  const sizes = [];
  for (let i = 0; i < imgs.length; i += 6) sizes.push(...await Promise.all(imgs.slice(i, i + 6).map((x) => imageSize(x.url))));
  const items = []; const rest = [];
  imgs.forEach((x, i) => { const sz = sizes[i]; if (!sz || !sz.w || !sz.h) { rest.push({ id: x.url, type: 'Image', label: L(x.label || x.url), format: 'image/jpeg' }); return; }
    const cid = `${id}/canvas/${items.length + 1}`;
    items.push({ id: cid, type: 'Canvas', label: L(x.label || `이미지 ${items.length + 1}`), width: sz.w, height: sz.h, ...(x.md ? { metadata: x.md } : {}),
      items: [{ id: cid + '/p', type: 'AnnotationPage', items: [{ id: cid + '/p/a', type: 'Annotation', motivation: 'painting', target: cid, body: { id: x.url, type: 'Image', format: sz.f, width: sz.w, height: sz.h } }] }] }); });
  return { items, rest };
}
const shell = (src, id, o) => ({ '@context': 'http://iiif.io/api/presentation/3/context.json', id: bridgeUrl(src, id), type: 'Manifest', label: L(o.label, 'ko'),
  ...(o.summary ? { summary: L(o.summary, 'ko') } : {}),
  metadata: [...o.md.filter(Boolean), ...(o.summary ? [MV('설명 지문(sha256-16)', fp16(o.summary) + ' — 판독 시점 설명 전문 기준, 불일치=원문 개정')] : []), MV('판독 시각', new Date().toISOString()), MV('변환', `KOREA ARCHIVE 통합검색 IIIF 브리지 v1.99 (원 데이터: ${o.inst})`)],
  ...(o.nav ? { navDate: o.nav } : {}), ...(o.rights ? { rights: o.rights } : {}),
  requiredStatement: { label: { ko: ['출처'] }, value: L(o.credit, 'ko') },
  provider: [{ id: o.instUrl, type: 'Agent', label: L(o.inst, 'ko'), homepage: [{ id: o.instUrl, type: 'Text', label: L(o.inst, 'ko'), format: 'text/html' }] }],
  homepage: [{ id: o.page, type: 'Text', label: { ko: ['원 기관 기록'] }, format: 'text/html' }],
  ...(o.rendering && o.rendering.length ? { rendering: o.rendering } : {}), items: o.items });

async function heritage(id) {
  const m = String(id).match(/^(\d{2})-([0-9A-Za-z]+)-(\d{2})$/); if (!m) throw new Error('국가유산 id는 kdcd-asno-ctcd (nedb_search mode=heritage 목록의 id)');
  const [, kdcd, asno, ctcd] = m; const q = `ccbaKdcd=${kdcd}&ccbaAsno=${asno}&ccbaCtcd=${ctcd}`;
  const [d, im] = await Promise.all([get(`https://www.khs.go.kr/cha/SearchKindOpenapiDt.do?${q}`), get(`https://www.khs.go.kr/cha/SearchImageOpenapi.do?${q}`).catch(() => '')]);
  const g = (t) => clean(xtag(d, t)); const name = g('ccbaMnm1'); if (!name) return null;
  const https = (u) => u.replace(/^http:\/\/www\.khs\.go\.kr/, 'https://www.khs.go.kr');
  const urls = []; const main = xtag(d, 'imageUrl'); if (main) urls.push({ url: https(main), label: `${name} — 대표 이미지` });
  const iu = [...im.matchAll(/<imageUrl>(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?<\/imageUrl>/g)].map((x) => https(x[1]));
  const ds = [...im.matchAll(/<ccimDesc>(?:<!\[CDATA\[)?\s*([^<\]]*?)\s*(?:\]\]>)?<\/ccimDesc>/g)].map((x) => x[1]);
  iu.forEach((u, i) => { if (!urls.some((x) => x.url === u)) urls.push({ url: u, label: ds[i] || `${name} ${i + 1}` }); });
  const { items, rest } = await canvases(bridgeUrl('heritage', id), urls.slice(0, 40));
  const cpno = g('ccbaCpno');
  return shell('heritage', id, { label: `${name}${g('ccbaMnm2') ? ` (${g('ccbaMnm2')})` : ''}`, summary: g('content').slice(0, 1500), inst: '국가유산청 국가유산포털', instUrl: 'https://www.heritage.go.kr/',
    page: cpno ? `https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaCpno=${cpno}` : 'https://www.heritage.go.kr/',
    md: [MV('종목', g('ccmaName')), MV('지정번호', cpno || id), g('ccceName') && MV('시대', g('ccceName')), g('ccbaPoss') && MV('소유', g('ccbaPoss')), g('ccbaAdmin') && MV('관리', g('ccbaAdmin')),
      g('ccbaLcad') && MV('소재', g('ccbaLcad')), g('ccbaAsdt') && MV('지정일', g('ccbaAsdt')), MV('이미지', `${urls.length}점(국가유산청 이미지 목록 API)`), MV('권리', '국가유산포털 사진 — 공공누리 유형은 포털 표시 확인 후 이용')],
    nav: navOf(g('ccbaAsdt')), credit: `국가유산청 국가유산포털 — ${name}`, items, rendering: rest });
}

async function much(id) {
  if (!/^[A-Z]{2}[\w-]{6,}$/.test(id)) throw new Error('역사박물관 id는 idnbr (예: PS0100…)');
  const page = 'https://archive.much.go.kr/archive/nrms/view.do?idnbr=' + encodeURIComponent(id);
  const b = await get(page); const flat = clean(b); const pick = (re) => ((flat.match(re) || [])[1] || '').trim();
  const no = pick(/소장품번호\s*(\S{2,20})/); if (!no && !/소장품/.test(flat)) return null;
  const nm = pick(/명칭\s+(.{1,120}?)\s+다른 명칭/); const alt = clean(String((b.match(/id="bigImg"[^>]*alt="([^"]*)"/) || [])[1] || '').replace(/&lt;/g, '‹').replace(/&gt;/g, '›'));
  const title = (alt && (!nm || (alt.includes(nm) && alt.length > nm.length)) ? alt : nm) || id; // '명칭' 필드 — 꺾쇠(<…>)가 태그로 지워지면 이미지 alt(원문) 사용
  const km = flat.match(/제\s*(\d)\s*유형\s*:\s*(.{3,60}?)\s*본 저작물/);
  const di = flat.indexOf('이용할 수 있습니다.'); let desc = di >= 0 ? flat.slice(di + 11, di + 1600).trim() : '';
  desc = desc.split(/자료열람|활용정보|이전글|다음글|사이트맵|COPYRIGHT/i)[0].trim();
  // 원본 이미지 = 소장품 뷰어의 /rms/thumb.do?…path=… (bigImg·목록) — 사이트 공통 이미지(/images/…)는 제외
  const imgs = [...new Set([...b.matchAll(/["'](\/rms\/thumb\.do\?[^"']+)["']/gi)].map((x) => x[1].replace(/&amp;/g, '&')))].slice(0, 30).map((u) => 'https://archive.much.go.kr' + u);
  const { items, rest } = await canvases(bridgeUrl('much', id), imgs.map((u, i) => ({ url: u, label: `${title} ${i + 1}` })));
  const kogl = km ? `공공누리 제${km[1]}유형 — ${km[2].trim()}${km[1] === '4' ? ' (원형 그대로만 — 자르기·글씨·필터 금지)' : ''}` : '공공누리 표시 미확인 — 원 페이지 확인';
  return shell('much', id, { label: title, summary: desc, inst: '대한민국역사박물관 근현대사아카이브', instUrl: 'https://archive.much.go.kr/', page,
    md: [MV('소장품번호', no || id), pick(/다른 명칭\s+(.{1,80}?)\s+국적/) && MV('다른 명칭', pick(/다른 명칭\s+(.{1,80}?)\s+국적/)),
      pick(/국적\/시대\s+(.{1,40}?)\s+분류/) && MV('국적/시대', pick(/국적\/시대\s+(.{1,40}?)\s+분류/)), pick(/분류\s+(\S{2,60})\s+재질/) && MV('분류', pick(/분류\s+(\S{2,60})\s+재질/)), pick(/재질\s*(\S{1,14})\s*작가/) && MV('재질', pick(/재질\s*(\S{1,14})\s*작가/)), pick(/작가\s*(.{1,40}?)\s*크기/) && MV('작가', pick(/작가\s*(.{1,40}?)\s*크기/)),
      pick(/크기\s*(\S{1,50}?)\s*소장품번호/) && MV('크기', pick(/크기\s*(\S{1,50}?)\s*소장품번호/)), MV('권리(원문)', kogl)], nav: navOf(title + ' ' + desc.slice(0, 80)),
    credit: `대한민국역사박물관 — ${title} (${no || id})`, items, rendering: rest });
}

async function awm(id) {
  if (!/^C\d+$/.test(id)) throw new Error('AWM id는 C+숫자 (예: C326698)');
  const page = 'https://www.awm.gov.au/collection/' + id; const d = await get(page);
  const h1 = clean((d.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || id);
  const acc = (d.match(/(?:Accession Number|ID number)[^A-Z0-9]{0,40}([A-Z0-9/.\-]{3,20})/) || [])[1] || '';
  const pd = /Copyright expired - public domain|publicdomain\/mark/.test(d);
  // v2.63 기관 상세 표(th/td) 전부 + 본문 Description — 'Place made'를 'Place'로만 찾아 장소가 비던 결함, og:description이 없으면 설명이 비던 결함(실측 HOBJ3143)
  const row = {}; for (const m of d.matchAll(/<th scope="row">\s*([\s\S]*?)\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) { const k = clean(m[1]); if (k && !row[k]) row[k] = clean(m[2].replace(/<br\s*\/?>/g, '; ')).replace(/;\s*$/, ''); }
  const body = clean((d.match(/<strong>Description<\/strong>[\s\S]*?<div class="entry-content">([\s\S]*?)<\/div>/) || [])[1] || '');
  const desc = body || clean((d.match(/<meta property="og:description" content="([^"]*)"/) || [])[1] || '');
  const place = row['Place made'] || row['Place'] || '';
  const date = row['Date made'] || '';
  const imgs = [...new Set([...d.matchAll(/https:\/\/s3-ap-southeast-2\.amazonaws\.com\/awm-media\/collection\/[^"' )]+\/screen\/[^"' )]+\.(?:jpe?g|JPG|png)/g)].map((x) => x[0]))].slice(0, 30);
  const { items, rest } = await canvases(bridgeUrl('awm', id), imgs.map((u, i) => ({ url: u, label: `${acc || id} ${i + 1}` })));
  return shell('awm', id, { label: h1, summary: desc, inst: 'Australian War Memorial', instUrl: 'https://www.awm.gov.au/', page,
    md: [MV('수장번호', acc || id), row['Collection type'] && MV('자료 유형', row['Collection type']), row['Object type'] && MV('매체 형태', row['Object type']), row['Maker'] && MV('제작자', row['Maker']),
      date && MV('생산일', date), place && MV('장소', place), row['Conflict'] && MV('분쟁', row['Conflict']), row['Unit'] && MV('부대', row['Unit']),
      MV('권리(원문)', row['Copyright'] || (pd ? 'Copyright expired - public domain' : '원 페이지 권리 표시 확인')), MV('이미지 크기', 'AWM 공개 화면용(screen) 이미지')].filter(Boolean),
    nav: navOf(date), rights: pd ? 'http://creativecommons.org/publicdomain/mark/1.0/' : '', credit: `Australian War Memorial ${acc || id}`, items, rendering: rest });
}

async function commons(id) {
  const title = String(id).replace(/^File:/i, '').replace(/_/g, ' ');
  const q = new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'size|url|extmetadata|mime', iiurlwidth: '2000', titles: 'File:' + title });
  const j = JSON.parse(await get('https://commons.wikimedia.org/w/api.php?' + q));
  const pg = Object.values((j.query || {}).pages || {})[0]; const ii = pg && (pg.imageinfo || [])[0]; if (!ii) return null;
  const em = ii.extmetadata || {}; const v = (k) => clean((em[k] || {}).value || '');
  const w = ii.thumbwidth || ii.width, h = ii.thumbheight || ii.height; const mid = bridgeUrl('commons', 'File:' + title); const cid = mid + '/canvas/1';
  const lic = v('LicenseUrl'); const rights = /creativecommons\.org\/(licenses|publicdomain)\//.test(lic) ? lic.replace(/^https?:/, 'http:').replace(/\/?$/, '/').replace(/\/deed\.\w+\/$/, '/') : (/public domain/i.test(v('LicenseShortName')) ? 'http://creativecommons.org/publicdomain/mark/1.0/' : '');
  return shell('commons', 'File:' + title, { label: title, summary: v('ImageDescription'), inst: 'Wikimedia Commons', instUrl: 'https://commons.wikimedia.org/', page: ii.descriptionurl,
    md: [MV('라이선스(원문)', v('LicenseShortName') || '파일 페이지 확인'), v('Artist') && MV('작가', v('Artist')), v('DateTimeOriginal') && MV('생산일', v('DateTimeOriginal')), v('Credit') && MV('출처(업로더 기재)', v('Credit')),
      MV('원본', `${ii.width}×${ii.height} ${ii.mime || ''}`), MV('주의', '업로더 기재는 2차 정보 — 원 소장처 카탈로그로 확정(nedb_search mode=commons가 NARA 번호면 원본 자동 대조)')],
    nav: navOf(v('DateTimeOriginal')), rights, credit: `Wikimedia Commons — ${v('Artist') || title} · ${v('LicenseShortName')}`,
    items: [{ id: cid, type: 'Canvas', label: L(title), width: w, height: h, items: [{ id: cid + '/p', type: 'AnnotationPage', items: [{ id: cid + '/p/a', type: 'Annotation', motivation: 'painting', target: cid, body: { id: ii.thumburl || ii.url, type: 'Image', format: 'image/jpeg', width: w, height: h } }] }] }],
    rendering: [{ id: ii.url, type: 'Image', label: L(`원본 파일 ${ii.width}×${ii.height}`), format: ii.mime || 'image/jpeg' }] });
}

// v2.17 국립문화유산연구원 국가유산 지식이음 — id: ov-{mseq}(국외문화유산) · ksm-{n}(금석문) · portrait-{n}(국가지정 초상화) · gwaebul-{n}(괘불)
//   명칭·해설·권리 = 주간 정적 색인(docs/data/nrich/<키>.jsonl, 데이터셋별) · 이미지·상세 항목 = 원 페이지(file_link 원본, 공공누리 4유형은 원형 그대로 — 캔버스는 원본 이미지 그대로 연결)
const NR = 'https://portal.nrich.go.kr';
const NR_PAGE = { ksm: (n) => `http://portal.nrich.go.kr/kor/ksmUsrView.do?menuIdx=584&ksm_idx=${n}`, portrait: (n) => `${NR}/kor/portraitNdUsrView.do?menuIdx=1258&portrait_idx=${n}`,
  gwaebul: (n) => `http://portal.nrich.go.kr/kor/buddhaNdUsrView.do?menuIdx=1086&buddha_idx=${n}`, ov: (n) => `${NR}/kor/overseasSearchView.do?menuIdx=840&mseq=${n}` };
// v2.18 이미지가 있는 데이터셋 전부 — 원 페이지 주소는 색인(u)에서. 공공누리 기본값 = Open API 개방목록 표기(색인 k가 있으면 그것 우선)
const K1 = '공공누리 제1유형(출처표시)', K4 = '공공누리 제4유형(출처표시·상업적 이용금지·변경금지 — 원형 그대로)';
const NR_KOGL = { ksm: K1, portrait: K4, gwaebul: K1, diary: K4, mokgan: K1, jcphoto: K1, arch: K4, design: K1, pattern: K1, oldbook: K1, hyanggyo: K1, stone: K1, gaesong: K1, assay: K1 };
const NR_NAME = { ov: '국외문화유산 DB', ksm: '금석문', portrait: '초상화(국가지정)', gwaebul: '괘불(국가지정 불화)', diary: '조선시대 개인일기', mokgan: '목간', jcphoto: '조선고적도보', arch: '한국고고학저널(유적)',
  design: '공예도설', pattern: '한국의 전통문양', oldbook: '고문헌 조사목록', hyanggyo: '향교 건축', stone: '석조문화유산', gaesong: '개성 문화유적(북한)', assay: '보존과학연구(분석)' };
export const NR_IIIF_DS = Object.keys(NR_NAME).filter((k) => k !== 'ov');
const koglText = (k, ds) => (k ? (/^\d|유형/.test(k) ? k : `공공누리 — ${k}`) : '') || NR_KOGL[ds] || '이용조건 원 페이지 확인';
const isThumb = (p) => /\/thumb(nail)?\/|\/t_\d|thumb_/i.test(p);
const nrIdx = new Map();
async function nrRec(ds, n) {
  const hit = nrIdx.get(ds); let rows = hit && Date.now() - hit.t < 6 * 3600e3 ? hit.rows : null;
  if (!rows) { const t = await get(`https://changgi.github.io/korea-archive-mcp/data/nrich/${ds}.jsonl`, 30000); rows = new Map(t.split('\n').filter(Boolean).map((l) => { try { const o = JSON.parse(l); return [o.id, o]; } catch { return [null, null]; } })); nrIdx.set(ds, { t: Date.now(), rows }); }
  return rows.get(`${ds}:${n}`) || null;
}
async function nrich(id) {
  const m = String(id).match(/^([a-z]+)-(\d+)$/); if (!m || !NR_NAME[m[1]]) throw new Error('국립문화유산연구원 id는 {키}-{번호} — 키: ' + Object.keys(NR_NAME).join('·'));
  const [, ds, n] = m;
  const rec = ds === 'ov' ? null : await nrRec(ds, n).catch(() => null);
  const page = ds === 'ov' ? NR_PAGE.ov(n) : (rec && rec.u) || (NR_PAGE[ds] && NR_PAGE[ds](n)); if (!page) return null;
  const h0 = await get(page, 28000);
  const h = h0.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const F = {}; for (const x of h.matchAll(/<(?:th|dt)[^>]*>([\s\S]*?)<\/(?:th|dt)>\s*<(?:td|dd)[^>]*>([\s\S]*?)<\/(?:td|dd)>/g)) { const k = clean(x[1]); const v = clean(x[2]); if (k && v && k.length < 16 && !(k in F) && !/바로보기|다운로드|바로가기/.test(v)) F[k] = v.slice(0, 300); }
  const title = ds === 'ov' ? [F['한글명칭'], F['한자명칭']].filter(Boolean).join(' (') + (F['한자명칭'] ? ')' : '') || `ov-${n}` : rec ? `${rec.t}${rec.a ? ` (${rec.a})` : ''}` : `${ds}-${n}`;
  if (!Object.keys(F).length && !rec) return null;
  const paths = [...new Set([...h0.matchAll(/<img[^>]+src="((?:https?:\/\/portal\.nrich\.go\.kr)?\/?file_link\/[^"]+)"/g)].map((x) => '/' + x[1].replace(/^https?:\/\/portal\.nrich\.go\.kr/, '').replace(/^\/+/, '')))];
  const full = paths.filter((p) => !isThumb(p)); const pick = (full.length ? full : paths).slice(0, 24); // 원본·대형이 있으면 썸네일 제외
  const imgs = pick.map((p, i) => ({ url: NR + encodeURI(decodeURI(p)), label: `${title.split(' (')[0]} ${i + 1}` }));
  const { items, rest } = await canvases(bridgeUrl('nrich', id), imgs);
  if (!items.length) { // 캔버스 0 = 이미지 없는 기록 — 같은 주소에서 기록 카드(기록 봉투) 매니페스트로(연속 보기에서 빠지지 않게)
    if (!rec && ds !== 'ov') return null;
    const env = { s: ['nrich'], t: title.slice(0, 160), d: (rec && rec.d) || F['시대분류'] || '', i: `${ds}:${n}`, u: page, p: `국립문화유산연구원 › 연구DB › ${NR_NAME[ds]}`, n: '국립문화유산연구원 국가유산 지식이음', m: '', q: 'IIIF 브리지(이미지 없음)', at: new Date().toISOString().slice(0, 19) + 'Z' };
    const mf = await buildRecManifest(encodeEnv(env)); mf.id = bridgeUrl('nrich', id); return mf;
  }
  const rights = ds === 'ov' ? (F['이용범위'] || '이용범위 원 페이지 확인') : koglText(rec && rec.k, ds);
  const md = [MV('데이터셋', NR_NAME[ds]), MV('식별자', `${ds}:${n}`), paths.length > pick.length ? MV('이미지 총수', `${paths.length}점 중 ${pick.length}점 캔버스(나머지는 원 페이지)`) : null,
    ...Object.entries(F).filter(([k]) => !['한글명칭', '한자명칭', '이용범위'].includes(k)).slice(0, 14).map(([k, v]) => MV(k, v)),
    ...(rec ? Object.entries(rec.m || {}).filter(([k]) => !(k in F)).slice(0, 6).map(([k, v]) => MV(k, v)) : []), MV('권리(원문)', rights), MV('이미지', `${imgs.length}점(원 기관 원본 — 변경 없이 연결)`)];
  return shell('nrich', id, { label: title, summary: rec ? rec.x || '' : '', inst: '국립문화유산연구원 국가유산 지식이음', instUrl: `${NR}/kor/index.do`, page, md,
    nav: navOf(`${F['연대'] || F['제작시기'] || F['시대분류'] || (rec && rec.d) || ''}`), credit: `국립문화유산연구원 국가유산 지식이음 — ${title} (${rights.split('(')[0].trim()})`, items, rendering: rest });
}
export const BRIDGES = { heritage, much, awm, commons, nrich };
export async function buildBridgeManifest(src, id) { const f = BRIDGES[src]; if (!f) throw new Error('지원 기관: ' + Object.keys(BRIDGES).join(', ') + ' (NARA는 /iiif/nara/)'); return f(id); }
