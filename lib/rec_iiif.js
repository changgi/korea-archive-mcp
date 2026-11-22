// 기록 봉투(Record Envelope) IIIF (v2.0) — IIIF가 없는 기록도 IIIF로 '만들어' 연속 열람·확산되게 한다.
// 발견한 기록 1건의 핵심 기술(출처·식별자·연대·계열·원 기관 URL·원본 매체·발견 경로·발견 시각)을 압축 토큰에 봉인 →
//   /iiif/rec/{token}/manifest.json  IIIF Presentation 3 매니페스트(원본 이미지가 있으면 그 이미지, 없으면 '기록 카드' 캔버스)
//   /iiif/rec/{token}/card.svg       기록 카드(실제 기술 메타데이터만 — 생성 이미지 아님)
//   /iiif/rec/{token}/record.jsonld  RiC-O + PROV(발견 행위 자체를 현용기록으로)
// 계층: 원 기관 계층이 없으면 '기관 › 계열(series·partOf) › 기록'을 구축해 metadata에 명시(구축 표시). 증거성: 봉투 지문(sha256-16)·발견 시각·발견 질의.
// 서버 저장 없음(stateless) — 토큰이 곧 기록 봉투이므로 링크만 있으면 언제든 같은 매니페스트가 다시 만들어진다.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { imageSize } from './nara_iiif.js';

export const ORIGIN = 'https://korea-archive-mcp.vercel.app';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
export const encodeEnv = (env) => b64u(deflateRawSync(Buffer.from(JSON.stringify(env)), { level: 9 }));
export const decodeEnv = (tok) => JSON.parse(inflateRawSync(unb64u(tok)).toString('utf8'));
export const recUrls = (tok) => ({ manifest: `${ORIGIN}/iiif/rec/${tok}/manifest.json`, card: `${ORIGIN}/iiif/rec/${tok}/card.svg`, ric: `${ORIGIN}/iiif/rec/${tok}/record.jsonld` });
const fp16 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const L = (s, lang = 'none') => ({ [lang]: [String(s ?? '').slice(0, 1500)] });
const MV = (k, v) => ({ label: { ko: [k] }, value: L(v) });
const navOf = (s) => { s = String(s || ''); let m = s.match(/(1[5-9]\d\d|20\d\d)[-./](\d{1,2})[-./](\d{1,2})/); if (m && +m[2] <= 12 && +m[3] <= 31) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00Z`;
  m = s.match(/(?<!\d)(1[5-9]\d\d|20\d\d)(?!\d)/); return m ? `${m[1]}-01-01T00:00:00Z` : ''; };

// 봉투 만들기 — cross_search 병합 결과 1건 → 최소 기술. inst=기관 정식명, part=상위 계열(partOf/series)
export function envelopeOf(it, { query = '', inst = '', part = '' } = {}) {
  const env = { s: it.sources || [], t: String(it.title || '').slice(0, 300), d: it.date || '', i: it.id || '', u: it.url || '', p: part || it.series || '', n: inst, m: it.media || '', q: String(query).slice(0, 120), at: new Date().toISOString().slice(0, 19) + 'Z' };
  if (it.sameAs) env.sa = it.sameAs;
  return env;
}
const hier = (e) => [e.n || (e.s[0] || '기관 미상'), e.p || '(계열 미상)', e.i || e.t.slice(0, 40)];

// 기록 카드 SVG — 실제 기술 메타데이터만(제목·기관·식별자·연대·계층·원 기관 URL). 원본 이미지가 없는 기록의 '열람 가능한 얼굴'
export function cardSvg(e) {
  const W = 1200, H = 900; const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wrap = (t, max) => { const out = []; let line = '', w = 0; for (const ch of String(t)) { const cw = /[\u0000-ɏ]/.test(ch) ? 0.55 : 1; if (w + cw > max && line) { out.push(line); line = ''; w = 0; } line += ch; w += cw; } if (line) out.push(line); return out; };
  const title = wrap(e.t || '(제목 없음)', 24).slice(0, 5); const h = hier(e);
  const rows = [['기관', e.n || e.s.join(' + ')], ['식별자', e.i || '—'], ['연대', e.d || '—'], ['계층', h.join(' › ')], ['원 기관', e.u || '—']];
  let y = 300 + title.length * 0;
  const body = rows.map(([k, v]) => { const ls = wrap(v, k === '원 기관' ? 30 : 34).slice(0, k === '원 기관' ? 3 : 2); const s = `<text x="90" y="${y}" class="k">${esc(k)}</text>` + ls.map((l, j) => `<text x="250" y="${y + j * 38}" class="v">${esc(l)}</text>`).join(''); y += 40 + ls.length * 38; return s; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>.t{font:800 46px 'Noto Sans KR','Apple SD Gothic Neo',sans-serif;fill:#f3f1ea}.k{font:800 26px 'Noto Sans KR',sans-serif;fill:#e0b04a}.v{font:400 28px 'Noto Sans KR',sans-serif;fill:#e6e4dc}.f{font:400 20px 'Noto Sans KR',sans-serif;fill:#9b9a93}</style>
<rect width="${W}" height="${H}" fill="#14161b"/><rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="#e0b04a" stroke-width="2"/>
<text x="90" y="110" class="k">KOREA ARCHIVE 통합검색 · 기록 카드 (원본 이미지 없음 — 원 기관에서 열람)</text>
${title.map((l, j) => `<text x="90" y="${180 + j * 58}" class="t">${esc(l)}</text>`).join('')}
<g transform="translate(0,${Math.max(0, title.length - 2) * 58})">${body}</g>
<text x="90" y="${H - 70}" class="f">발견 ${esc(e.at)} · 질의 "${esc(e.q)}" · 봉투 지문 ${fp16(JSON.stringify(e))} — 실제 기술 메타데이터로만 구성</text></svg>`;
}

export async function buildRecManifest(tok) {
  const e = decodeEnv(tok); const U = recUrls(tok); const h = hier(e); const built = !e.p;
  const md = [MV('출처 기관', e.n || e.s.join(' + ')), MV('교차 출처', e.s.join(' + ') + (e.s.length > 1 ? ' — 복수 기관 교차확인' : '')), e.i && MV('식별자', e.i), e.d && MV('연대', e.d),
    MV('계층', h.join(' › ') + (built ? ' (구축 — 원 기관 계층 정보가 없어 기관·식별자로 재구성)' : '')), e.sa && MV('동일 기록(sameAs)', e.sa),
    MV('원 기관 기록', e.u || '—'), MV('발견 경로', `KOREA ARCHIVE 통합검색 cross_search "${e.q}"`), MV('발견 시각', e.at), MV('봉투 지문(sha256-16)', fp16(JSON.stringify(e)) + ' — 봉투 내용이 바뀌면 지문이 바뀐다'),
    MV('변환', 'KOREA ARCHIVE 통합검색 기록 봉투 IIIF v2.0 — 원 기관 IIIF·브리지가 없는 기록을 IIIF로 구축')].filter(Boolean);
  let canvas = null; const rendering = [];
  if (/\.(jpe?g|png|gif)(\?|$)/i.test(e.m) || /thumb|image/i.test(e.m)) { const sz = await imageSize(e.m); if (sz) canvas = { url: e.m, w: sz.w, h: sz.h, f: sz.f, label: '원본 이미지(원 기관 제공)' }; }
  if (e.m && !canvas) rendering.push({ id: e.m, type: /\.pdf/i.test(e.m) ? 'Text' : /\.(mp4|mov)/i.test(e.m) ? 'Video' : 'Image', label: { ko: ['원본 매체(원 기관)'] }, format: /\.pdf/i.test(e.m) ? 'application/pdf' : /\.(mp4|mov)/i.test(e.m) ? 'video/mp4' : 'image/jpeg' });
  if (!canvas) canvas = { url: U.card, w: 1200, h: 900, f: 'image/svg+xml', label: '기록 카드(기술 메타데이터)' };
  const cid = U.manifest + '/canvas/1';
  return { '@context': 'http://iiif.io/api/presentation/3/context.json', id: U.manifest, type: 'Manifest', label: L(e.t || e.i), metadata: md,
    ...(navOf(e.d) ? { navDate: navOf(e.d) } : {}),
    requiredStatement: { label: { ko: ['출처'] }, value: L(`${e.n || e.s.join(' + ')}${e.i ? ' · ' + e.i : ''} — 원 기관 표기 권리 확인 후 이용`) },
    provider: [{ id: 'https://changgi.github.io/korea-archive-mcp/', type: 'Agent', label: { ko: ['KOREA ARCHIVE 통합검색'] } }],
    ...(e.u ? { homepage: [{ id: e.u, type: 'Text', label: { ko: ['원 기관 기록'] }, format: 'text/html' }] } : {}),
    seeAlso: [{ id: U.ric, type: 'Dataset', label: { ko: ['RiC-O·PROV 기술(발견 행위 포함)'] }, format: 'application/ld+json' }],
    ...(rendering.length ? { rendering } : {}),
    items: [{ id: cid, type: 'Canvas', label: { ko: [canvas.label] }, width: canvas.w, height: canvas.h,
      items: [{ id: cid + '/p', type: 'AnnotationPage', items: [{ id: cid + '/p/a', type: 'Annotation', motivation: 'painting', target: cid, body: { id: canvas.url, type: 'Image', format: canvas.f, width: canvas.w, height: canvas.h } }] }] }] };
}

export function buildRecRiC(tok) {
  const e = decodeEnv(tok); const U = recUrls(tok); const h = hier(e);
  return { '@context': { rico: 'https://www.ica.org/standards/RiC/ontology#', prov: 'http://www.w3.org/ns/prov#', dct: 'http://purl.org/dc/terms/', owl: 'http://www.w3.org/2002/07/owl#' },
    '@id': e.u || U.manifest, '@type': 'rico:Record', 'rico:title': e.t, ...(e.i ? { 'rico:identifier': e.i } : {}), ...(e.d ? { 'rico:isAssociatedWithDate': e.d } : {}),
    'rico:isOrWasIncludedIn': { '@type': 'rico:RecordSet', 'rico:title': h[1], 'rico:isOrWasIncludedIn': { '@type': 'rico:RecordSet', 'rico:title': h[0] }, 'dct:description': e.p ? '원 기관 계열' : '구축 계층(원 기관 정보 없음)' },
    'rico:hasOrHadHolder': { '@type': 'rico:CorporateBody', 'rico:name': e.n || e.s.join(' + ') },
    'rico:hasOrHadInstantiation': [{ '@id': U.manifest, '@type': 'rico:Instantiation', 'rico:hasCarrierType': 'IIIF Presentation 3 Manifest' }, ...(e.m ? [{ '@id': e.m, '@type': 'rico:Instantiation' }] : [])],
    ...(e.sa ? { 'owl:sameAs': e.sa } : {}),
    'prov:wasGeneratedBy': { '@type': 'prov:Activity', 'prov:label': `KOREA ARCHIVE 통합검색 cross_search "${e.q}"`, 'prov:endedAtTime': e.at, 'prov:used': e.s },
    'prov:value': 'sha256-16:' + fp16(JSON.stringify(e)) };
}
