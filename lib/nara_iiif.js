// NARA → IIIF Presentation 3 · RiC-O JSON-LD (v1.98)
// NARA 카탈로그는 IIIF를 내지 않는다. 이 모듈은 NAID 하나를 '맥락(계보)·증거성(판독 시각·기술 지문·권리 원문)·
// 다매체(디지털 객체 전부 — 표시 가능한 이미지는 캔버스, TIFF·PDF·영상은 rendering)'을 갖춘 IIIF 매니페스트로 만든다.
// 계층: ancestors → partOf(상위 NARA 컬렉션 엔드포인트) · 하위: collection.json(시리즈·파일단위의 자식 기록).
// 공개 엔드포인트: /iiif/nara/{naid}/manifest.json · /collection.json · /record.jsonld  (app/iiif/nara/[...p]/route.js)
import { createHash } from 'node:crypto';
import { encodeEnv, recUrls } from './rec_iiif.js'; // v2.0: 표시 이미지가 없는 기록 → 기록 카드 캔버스(연속 열람에서 빠지지 않게)

export const ORIGIN = 'https://korea-archive-mcp.vercel.app';
const API = 'https://catalog.archives.gov/api/v2/records/search';
const UA = 'KoreaArchiveMCP/1.0 (https://github.com/changgi/korea-archive-mcp; IIIF bridge)';
const cache = new Map(); // naid → {t, rec}
const L = (s, lang = 'en') => ({ [lang]: [String(s ?? '').slice(0, 1000)] });
const KO = (s) => L(s, 'ko');
const MV = (k, v) => ({ label: KO(k), value: L(v, 'none') });

export async function naraRecord(naid) {
  const key = process.env.NARA_API_KEY;
  if (!key) throw new Error('NARA_API_KEY 미설정');
  const hit = cache.get(naid);
  if (hit && Date.now() - hit.t < 6 * 3600e3) return hit.rec;
  const r = await fetch(`${API}?naId=${naid}&limit=1`, { headers: { 'x-api-key': key, Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('NARA HTTP ' + r.status);
  const d = await r.json();
  const rec = (((((d.body || {}).hits || {}).hits) || [])[0] || { _source: {} })._source.record || null;
  if (!rec || Number(rec.naId) !== Number(naid)) return null;
  cache.set(naid, { t: Date.now(), rec });
  return rec;
}

// 자식 기록 — 후보 검색 후 ancestors에 부모 NAID가 실제로 있는 것만(잘못된 하위 연결 방지)
export async function naraChildren(naid, limit = 100) {
  const key = process.env.NARA_API_KEY;
  const out = [];
  for (const q of [`parentNaId=${naid}`, `ancestorNaId=${naid}`]) {
    try {
      const r = await fetch(`${API}?${q}&limit=${limit}`, { headers: { 'x-api-key': key, Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const d = await r.json();
      for (const h of (((d.body || {}).hits || {}).hits) || []) {
        const rec = (h._source || {}).record || {};
        const anc = rec.ancestors || [];
        if (rec.naId && Number(rec.naId) !== Number(naid) && anc.some((a) => Number(a.naId) === Number(naid)) && !out.some((x) => x.naId === rec.naId)) out.push(rec);
      }
      if (out.length) break;
    } catch { /* 다음 질의 형식 */ }
  }
  // 바로 아래 층만(파일단위의 자식 아이템 등) — 부모가 ancestors의 마지막이면 직계
  const direct = out.filter((rec) => { const a = rec.ancestors || []; return a.length && Number(a[a.length - 1].naId) === Number(naid); });
  return (direct.length ? direct : out).slice(0, limit);
}

const naraDateISO = (rec) => {
  const p = (rec.productionDates || [])[0] || {};
  const s = String(p.logicalDate || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10) + 'T00:00:00Z';
  const y = String(p.year || '').match(/^\d{4}$/) ? p.year : (s.match(/^\d{4}/) || [])[0];
  return y ? `${y}-01-01T00:00:00Z` : '';
};
const naraDateText = (rec) => { const p = (rec.productionDates || [])[0] || {}; return String(p.logicalDate || p.year || p.proximatePhrase || '').slice(0, 10); };
const useRestr = (rec) => { const u = rec.useRestriction || {}; return typeof u === 'string' ? u : [u.status, u.note, (u.specificUseRestrictions || []).join('/')].filter(Boolean).join(' · '); };
const accRestr = (rec) => { const u = rec.accessRestriction || {}; return typeof u === 'string' ? u : [u.status, u.note, (u.specificAccessRestrictions || []).join('/')].filter(Boolean).join(' · '); };
const chainOf = (rec) => (rec.ancestors || []).map((a) => ({ naId: a.naId, level: String(a.levelOfDescription || ''), rg: a.recordGroupNumber || '', title: String(a.title || '').slice(0, 160) }));
const chainText = (ch) => ch.map((a) => `${a.level.replace(/recordGroup/i, 'RG')}${a.rg ? ' ' + a.rg : ''} ${a.title} [NAID ${a.naId}]`.replace(/\s+/g, ' ').trim()).join(' › ');
const fp16 = (s) => (s ? createHash('sha256').update(String(s)).digest('hex').slice(0, 16) : '');

// 이미지 크기 — 파일 앞부분(128KB)만 받아 JPEG SOF·PNG IHDR·GIF 헤더 판독(IIIF 캔버스 필수값)
export async function imageSize(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-131071', 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok && r.status !== 206) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0, f: 'image/png' };
    if (b[0] === 0x47 && b[1] === 0x49) return { w: b[6] | b[7] << 8, h: b[8] | b[9] << 8, f: 'image/gif' };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1]; const len = b[i + 2] << 8 | b[i + 3];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b[i + 5] << 8 | b[i + 6], w: b[i + 7] << 8 | b[i + 8], f: 'image/jpeg' };
        i += 2 + len;
      }
    }
  } catch { /* 크기 미상 */ }
  return null;
}
const kindOf = (o) => { const t = (String(o.objectType || '') + ' ' + String(o.objectUrl || o.objectFilename || '')).toLowerCase();
  return /\.(jpe?g|png|gif)\b|image\/(jpe?g|png|gif)/.test(t) ? 'img' : /\.tiff?\b|tiff/.test(t) ? 'tiff' : /\.pdf\b|pdf/.test(t) ? 'pdf' : /\.(mp4|mov|m4v)\b|video/.test(t) ? 'video' : /\.(mp3|wav)\b|audio/.test(t) ? 'audio' : 'other'; };
const FMT = { tiff: 'image/tiff', pdf: 'application/pdf', video: 'video/mp4', audio: 'audio/mpeg', other: 'application/octet-stream' };

export const naraUrls = (naid) => ({ manifest: `${ORIGIN}/iiif/nara/${naid}/manifest.json`, collection: `${ORIGIN}/iiif/nara/${naid}/collection.json`, ric: `${ORIGIN}/iiif/nara/${naid}/record.jsonld`,
  kv: `https://changgi.github.io/korea-archive-mcp/kv.html?manifest=${encodeURIComponent(`${ORIGIN}/iiif/nara/${naid}/manifest.json`)}`, catalog: `https://catalog.archives.gov/id/${naid}` });

function common(rec) {
  const naid = rec.naId; const U = naraUrls(naid); const ch = chainOf(rec); const ur = useRestr(rec); const ar = accRestr(rec);
  const scope = String(rec.scopeAndContentNote || '').trim();
  const cre = (rec.creators || []).map((c) => c.heading).filter(Boolean).join(' · ');
  const ru = ((((rec.physicalOccurrences || [])[0] || {}).referenceUnits || [])[0] || {}).name || '';
  const md = [MV('NAID', String(naid)), rec.localIdentifier && MV('로컬 식별자', rec.localIdentifier), MV('기술 수준', rec.levelOfDescription || ''),
    ch.length && MV('계보(상위 계층)', chainText(ch)), cre && MV('생산자', cre), naraDateText(rec) && MV('생산일', naraDateText(rec)),
    ru && MV('소장단위(열람·복제 청구)', ru), ur && MV('이용 제한(원문)', ur), ar && MV('접근 제한(원문)', ar),
    MV('디지털 객체', String((rec.digitalObjects || []).length) + '점'), scope && MV('기술 지문(sha256-16)', fp16(scope) + ' — 범위·내용 기술 판독 시점 지문, 불일치=카탈로그 개정'),
    MV('판독 시각', new Date().toISOString()), MV('변환', 'KOREA ARCHIVE 통합검색 NARA→IIIF 브리지 v1.98 (원 데이터: NARA Catalog API v2)')].filter(Boolean);
  const rights = /unrestricted/i.test(ur) && !/restricted\s*[-–]|possibly|fully/i.test(ur) ? 'http://rightsstatements.org/vocab/NoC-US/1.0/' : 'http://rightsstatements.org/vocab/UND/1.0/';
  const parent = ch[ch.length - 1];
  return { naid, U, ch, scope, md, rights, nav: naraDateISO(rec),
    partOf: parent ? [{ id: naraUrls(parent.naId).collection, type: 'Collection', label: L(`${parent.level} ${parent.rg ? 'RG ' + parent.rg + ' ' : ''}${parent.title}`.trim()) }] : [],
    base: { requiredStatement: { label: KO('출처'), value: L(`National Archives and Records Administration (NARA), NAID ${naid}${rec.localIdentifier ? ' (' + rec.localIdentifier + ')' : ''}`) },
      provider: [{ id: 'https://www.archives.gov/', type: 'Agent', label: L('U.S. National Archives and Records Administration'), homepage: [{ id: 'https://catalog.archives.gov/', type: 'Text', label: L('NARA Catalog'), format: 'text/html' }] }],
      homepage: [{ id: U.catalog, type: 'Text', label: L('NARA Catalog record'), format: 'text/html' }],
      seeAlso: [{ id: U.ric, type: 'Dataset', label: KO('RiC-O 기록 기술(JSON-LD) — 계층·증거'), format: 'application/ld+json', profile: 'https://www.ica.org/standards/RiC/ontology' }] } };
}

export async function buildNaraManifest(naid, maxCanvas = 60) {
  const rec = await naraRecord(naid);
  if (!rec) return null;
  const C = common(rec); const id = C.U.manifest;
  const dob = rec.digitalObjects || [];
  const imgs = dob.filter((o) => kindOf(o) === 'img').slice(0, maxCanvas);
  const sizes = []; // 동시 6개로 크기 판독
  for (let i = 0; i < imgs.length; i += 6) sizes.push(...await Promise.all(imgs.slice(i, i + 6).map((o) => imageSize(o.objectUrl))));
  const items = []; const skipped = [];
  imgs.forEach((o, i) => {
    const sz = sizes[i]; if (!sz || !sz.w || !sz.h) { skipped.push(o); return; }
    const cid = `${id}/canvas/${items.length + 1}`;
    items.push({ id: cid, type: 'Canvas', label: L(o.objectFilename || `Image ${items.length + 1}`), width: sz.w, height: sz.h,
      metadata: [MV('파일', o.objectFilename || ''), o.objectFileSize && MV('크기', `${(Number(o.objectFileSize) / 1048576).toFixed(1)} MB`), MV('객체 URL', o.objectUrl)].filter(Boolean),
      items: [{ id: cid + '/p', type: 'AnnotationPage', items: [{ id: cid + '/p/a', type: 'Annotation', motivation: 'painting', target: cid, body: { id: o.objectUrl, type: 'Image', format: sz.f, width: sz.w, height: sz.h } }] }] });
  });
  // 원본 보존 매체(TIFF·PDF·영상·음성)와 크기 미상 이미지는 rendering으로 — 다매체·증거성(최선 원본을 잃지 않는다)
  const rendering = dob.filter((o) => kindOf(o) !== 'img').concat(skipped).slice(0, 80).map((o) => ({ id: o.objectUrl, type: kindOf(o) === 'video' ? 'Video' : kindOf(o) === 'audio' ? 'Sound' : kindOf(o) === 'pdf' ? 'Text' : 'Image',
    label: L(`${o.objectFilename || o.objectUrl}${o.objectFileSize ? ` (${(Number(o.objectFileSize) / 1048576).toFixed(1)} MB)` : ''}`), format: FMT[kindOf(o)] || 'application/octet-stream' }));
  const man = { '@context': 'http://iiif.io/api/presentation/3/context.json', id, type: 'Manifest', label: L(rec.title || `NAID ${naid}`),
    ...(C.scope ? { summary: L(C.scope.slice(0, 1500)) } : {}), metadata: C.md, ...(C.nav ? { navDate: C.nav } : {}), rights: C.rights, ...C.base,
    ...(C.partOf.length ? { partOf: C.partOf } : {}), ...(rendering.length ? { rendering } : {}), items };
  if (!items.length) {
    man.metadata.push(MV('표시 가능한 이미지', dob.length ? '없음 — 원본 매체는 rendering(내려받기) 참조' : '디지털 사본 없음 — 원본은 NARA 열람 청구'));
    const tok = encodeEnv({ s: ['nara'], t: String(rec.title || '').slice(0, 160), d: naraDateText(rec), i: `NAID ${naid}${rec.localIdentifier ? ' · ' + rec.localIdentifier : ''}`, u: C.U.catalog,
      p: chainText(C.ch).slice(0, 200), n: 'U.S. National Archives and Records Administration (NARA)', m: '', q: 'NARA→IIIF 브리지', at: new Date().toISOString().slice(0, 19) + 'Z' });
    const cid = `${id}/canvas/1`; const card = recUrls(tok).card;
    man.items = [{ id: cid, type: 'Canvas', label: { ko: ['기록 카드(기술 메타데이터 — 디지털 이미지 없음)'] }, width: 1200, height: 900,
      items: [{ id: cid + '/p', type: 'AnnotationPage', items: [{ id: cid + '/p/a', type: 'Annotation', motivation: 'painting', target: cid, body: { id: card, type: 'Image', format: 'image/svg+xml', width: 1200, height: 900 } }] }] }];
  }
  return man;
}

export async function buildNaraCollection(naid) {
  const rec = await naraRecord(naid);
  if (!rec) return null;
  const C = common(rec); const kids = await naraChildren(naid, 100);
  return { '@context': 'http://iiif.io/api/presentation/3/context.json', id: C.U.collection, type: 'Collection', label: L(rec.title || `NAID ${naid}`),
    ...(C.scope ? { summary: L(C.scope.slice(0, 1500)) } : {}), metadata: [...C.md, MV('하위 기록', `${kids.length}건 (NARA 검색 후 계보 대조로 확인한 것만)`)], ...(C.nav ? { navDate: C.nav } : {}), rights: C.rights, ...C.base,
    ...(C.partOf.length ? { partOf: C.partOf } : {}),
    items: kids.map((k) => ({ id: /item|fileunit/i.test(k.levelOfDescription || '') && (k.digitalObjects || []).length ? naraUrls(k.naId).manifest : ((k.digitalObjects || []).length ? naraUrls(k.naId).manifest : naraUrls(k.naId).collection),
      type: (k.digitalObjects || []).length ? 'Manifest' : 'Collection', label: L(`${k.title || 'NAID ' + k.naId}${naraDateText(k) ? ' (' + naraDateText(k) + ')' : ''}`) })) };
}

// RiC-O(Records in Contexts) JSON-LD — 기록·계층·생산자·생산일·권리·디지털 사본(IIIF)·출처(PROV)를 그래프로: 지식그래프·기록관리시스템 등재의 원천
export async function buildNaraRiC(naid) {
  const rec = await naraRecord(naid);
  if (!rec) return null;
  const C = common(rec); const U = C.U;
  const lvl = (s) => /item/i.test(s) ? 'rico:Record' : /file/i.test(s) ? 'rico:RecordSet' : 'rico:RecordSet';
  const anc = C.ch.map((a) => ({ '@id': U.catalog.replace(/\d+$/, a.naId), '@type': lvl(a.level), 'rico:title': a.title, 'rico:hasRecordSetType': a.level, ...(a.rg ? { 'rico:identifier': `RG ${a.rg}` } : {}) }));
  return { '@context': { rico: 'https://www.ica.org/standards/RiC/ontology#', prov: 'http://www.w3.org/ns/prov#', dct: 'http://purl.org/dc/terms/', iiif: 'http://iiif.io/api/presentation/3#' },
    '@id': U.catalog, '@type': lvl(rec.levelOfDescription || ''), 'rico:identifier': [`NAID ${naid}`, rec.localIdentifier].filter(Boolean), 'rico:title': rec.title || '',
    ...(C.scope ? { 'rico:scopeAndContent': C.scope, 'dct:conformsTo': `sha256-16:${fp16(C.scope)}` } : {}),
    'rico:hasRecordSetType': rec.levelOfDescription || '', ...(naraDateText(rec) ? { 'rico:isAssociatedWithDate': naraDateText(rec) } : {}),
    'rico:hasCreator': (rec.creators || []).map((c) => ({ '@type': 'rico:Agent', 'rico:name': c.heading })).filter((x) => x['rico:name']),
    'rico:isOrWasIncludedIn': anc.length ? anc[anc.length - 1] : undefined, 'rico:isOrWasIncludedInTransitive': anc,
    'rico:hasOrHadHolder': { '@type': 'rico:CorporateBody', 'rico:name': 'U.S. National Archives and Records Administration' },
    'rico:conditionsOfUse': useRestr(rec) || 'Undetermined', 'rico:conditionsOfAccess': accRestr(rec) || '', 'dct:rights': C.rights,
    'rico:hasOrHadInstantiation': [{ '@id': U.manifest, '@type': 'rico:Instantiation', 'rico:hasCarrierType': 'IIIF Presentation 3 Manifest' },
      ...(rec.digitalObjects || []).slice(0, 80).map((o) => ({ '@id': o.objectUrl, '@type': 'rico:Instantiation', 'dct:format': FMT[kindOf(o)] || (kindOf(o) === 'img' ? 'image' : ''), ...(o.objectFileSize ? { 'dct:extent': `${o.objectFileSize} bytes` } : {}) }))],
    'prov:wasDerivedFrom': `${API}?naId=${naid}`, 'prov:generatedAtTime': new Date().toISOString(), 'prov:wasAttributedTo': 'KOREA ARCHIVE 통합검색 NARA→IIIF 브리지 v1.98' };
}
