// TNA(영국 국립기록관) → IIIF (v2.1) — 실제 계층(부서 › 시리즈 › … › 피스 › 아이템)을 Discovery API의 parentId·children으로 재구성.
//   /iiif/tna/{C-id}/manifest.json   기록 1건 — 계보(실제)·참조번호·기간·소장·법적 지위·공개 상태·이전 참조, 판독 시각·기술 지문, partOf → 상위 컬렉션
//   /iiif/tna/{C-id}/collection.json 하위 기록 — 하위 계층은 컬렉션, 말단 기록은 기록 봉투(토큰에 제목·참조·기간·계보 봉인 → 추가 요청 없이 열림)
// 예의: 부모 기술은 캐시(6h), 컬렉션 1회 = TNA 요청 2~8회(상세+계보 캐시+자식 1쪽). 정직한 식별자 UA.
import { createHash } from 'node:crypto';
import { encodeEnv, recUrls } from './rec_iiif.js';

export const ORIGIN = 'https://korea-archive-mcp.vercel.app';
const API = 'https://discovery.nationalarchives.gov.uk/API/records/v1';
const UA = 'KoreaArchiveMCP/1.0 (+https://github.com/changgi/korea-archive-mcp; IIIF bridge)';
const cache = new Map();
const LEVEL = { 1: 'Department', 2: 'Division', 3: 'Series', 4: 'Sub-series', 5: 'Sub-sub-series', 6: 'Piece', 7: 'Item' };
const KLEVEL = { 1: '부서', 2: '분과', 3: '시리즈', 4: '하위 시리즈', 5: '하위 시리즈 2', 6: '피스(파일)', 7: '아이템' };
const clean = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const fp16 = (s) => (s ? createHash('sha256').update(String(s)).digest('hex').slice(0, 16) : '');
const L = (s, lang = 'none') => ({ [lang]: [String(s ?? '').slice(0, 1500)] });
const MV = (k, v) => ({ label: { ko: [k] }, value: L(v) });
export const tnaUrls = (id) => ({ manifest: `${ORIGIN}/iiif/tna/${id}/manifest.json`, collection: `${ORIGIN}/iiif/tna/${id}/collection.json`, page: `https://discovery.nationalarchives.gov.uk/details/r/${id}` });
const navOf = (s) => { const m = String(s || '').match(/(?<!\d)(1[5-9]\d\d|20\d\d)(?!\d)/); return m ? `${m[1]}-01-01T00:00:00Z` : ''; };

async function getJ(u) {
  const hit = cache.get(u); if (hit && Date.now() - hit.t < 6 * 3600e3) return hit.v;
  const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null; if (!r.ok) throw new Error('TNA HTTP ' + r.status);
  const v = await r.json(); cache.set(u, { t: Date.now(), v }); return v;
}
export const tnaDetail = (id) => getJ(`${API}/details/${id}`);
const titleOf = (d) => clean(d.title || '') || clean((d.scopeContent || {}).description || '') || d.citableReference || d.id;

export async function tnaChain(id) { // 위로 걸어 올라가며 실제 계보 — 최대 8층
  const out = []; let cur = await tnaDetail(id); let n = 0;
  while (cur && cur.parentId && n++ < 8) { const p = await tnaDetail(cur.parentId); if (!p) break; out.unshift({ id: p.id, ref: p.citableReference || '', level: p.catalogueLevel, title: titleOf(p).slice(0, 120) }); cur = p; }
  return out;
}
const chainText = (ch) => ch.map((a) => `${a.ref || ''}${a.ref ? ' ' : ''}${a.title}${a.level ? ` (${KLEVEL[a.level] || a.level})` : ''}`).join(' › ');

function meta(d, ch) {
  const desc = clean((d.scopeContent || {}).description || '');
  return [MV('참조번호', d.citableReference || d.id), MV('기술 수준', `${LEVEL[d.catalogueLevel] || d.catalogueLevel} (${KLEVEL[d.catalogueLevel] || ''})`),
    ch.length && MV('계층(실제 — Discovery parentId)', chainText(ch)), d.coveringDates && MV('기간', d.coveringDates),
    (d.heldBy || []).length && MV('소장', d.heldBy.map((h) => h.xReferenceName).filter(Boolean).join(' · ')), d.legalStatus && MV('법적 지위', d.legalStatus),
    d.closureStatus && MV('공개 상태', { O: 'Open (열람 가능)', C: 'Closed', D: 'Retained', R: 'Retained by department' }[d.closureStatus] || d.closureStatus),
    d.formerReferenceDep && MV('이전 참조(부서)', d.formerReferenceDep), d.formerReferencePro && MV('이전 참조(PRO)', d.formerReferencePro),
    desc && MV('기술 지문(sha256-16)', fp16(desc) + ' — 범위·내용 기술 판독 시점 지문'), MV('판독 시각', new Date().toISOString()),
    MV('변환', 'KOREA ARCHIVE 통합검색 TNA→IIIF 브리지 v2.1 (원 데이터: TNA Discovery API)')].filter(Boolean);
}
const base = (d, ch) => ({ requiredStatement: { label: { ko: ['출처'] }, value: L(`The National Archives, Kew — ${d.citableReference || d.id}`) },
  provider: [{ id: 'https://www.nationalarchives.gov.uk/', type: 'Agent', label: L('The National Archives (UK)'), homepage: [{ id: 'https://discovery.nationalarchives.gov.uk/', type: 'Text', label: L('TNA Discovery'), format: 'text/html' }] }],
  homepage: [{ id: tnaUrls(d.id).page, type: 'Text', label: L('TNA Discovery record'), format: 'text/html' }],
  ...(d.parentId ? { partOf: [{ id: tnaUrls(d.parentId).collection, type: 'Collection', label: L(ch.length ? `${ch[ch.length - 1].ref} ${ch[ch.length - 1].title}`.trim() : d.parentId) }] } : {}),
  ...(navOf(d.coveringDates) ? { navDate: navOf(d.coveringDates) } : {}) });

export async function buildTnaManifest(id) {
  const d = await tnaDetail(id); if (!d) return null; const ch = await tnaChain(id); const U = tnaUrls(id);
  const tok = encodeEnv({ s: ['tna'], t: titleOf(d).slice(0, 160), d: d.coveringDates || '', i: d.citableReference || id, u: U.page, p: chainText(ch).slice(0, 220), n: 'The National Archives (UK)', m: '', q: 'TNA→IIIF 브리지', at: new Date().toISOString().slice(0, 19) + 'Z' });
  const cid = U.manifest + '/canvas/1';
  return { '@context': 'http://iiif.io/api/presentation/3/context.json', id: U.manifest, type: 'Manifest', label: L(`${d.citableReference || ''} ${titleOf(d)}`.trim()),
    ...(clean((d.scopeContent || {}).description) ? { summary: L(clean(d.scopeContent.description)) } : {}), metadata: meta(d, ch), ...base(d, ch),
    ...(d.digitised ? { rendering: [{ id: U.page, type: 'Text', label: { ko: ['디지털 사본 — Discovery에서 열람·내려받기'] }, format: 'text/html' }] } : {}),
    items: [{ id: cid, type: 'Canvas', label: { ko: [d.digitised ? '기록 카드(디지털 사본은 Discovery에서)' : '기록 카드(원본은 Kew에서 열람)'] }, width: 1200, height: 900,
      items: [{ id: cid + '/p', type: 'AnnotationPage', items: [{ id: cid + '/p/a', type: 'Annotation', motivation: 'painting', target: cid, body: { id: recUrls(tok).card, type: 'Image', format: 'image/svg+xml', width: 1200, height: 900 } }] }] }] };
}

export async function buildTnaCollection(id) {
  const d = await tnaDetail(id); if (!d) return null; const ch = await tnaChain(id);
  const kids = await getJ(`${API}/children/${id}?limit=100`) || { assets: [] };
  const here = chainText([...ch, { ref: d.citableReference || '', title: titleOf(d).slice(0, 120), level: d.catalogueLevel }]).slice(0, 220);
  const items = (kids.assets || []).map((k) => {
    const t = clean(k.title) || clean((k.scopeContent || {}).description) || k.citableReference || k.id;
    const lab = `${k.citableReference || k.referencePart || ''} ${t}${k.coveringDates ? ' (' + k.coveringDates + ')' : ''}`.trim();
    if (k.isParent) return { id: tnaUrls(k.id).collection, type: 'Collection', label: L(lab) };
    const tok = encodeEnv({ s: ['tna'], t: t.slice(0, 160), d: k.coveringDates || '', i: k.citableReference || k.id, u: tnaUrls(k.id).page, p: here, n: 'The National Archives (UK)', m: '', q: `TNA 계층 ${d.citableReference || id}`, at: new Date().toISOString().slice(0, 19) + 'Z' });
    return { id: recUrls(tok).manifest, type: 'Manifest', label: L(lab) };
  });
  return { '@context': 'http://iiif.io/api/presentation/3/context.json', id: tnaUrls(id).collection, type: 'Collection', label: L(`${d.citableReference || ''} ${titleOf(d)}`.trim()),
    metadata: [...meta(d, ch), MV('하위 기록', `${items.length}건${kids.hasMoreAfterLast ? ' (더 있음 — Discovery에서 이어 보기)' : ''} — 하위 계층=컬렉션, 말단=기록 봉투`)], ...base(d, ch), items };
}
