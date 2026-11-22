// 기록 봉투 IIIF 엔드포인트 (v2.0) — /iiif/rec/{token}/manifest.json · /card.svg · /record.jsonld (stateless: 토큰=봉인된 기록 기술)
import { buildRecManifest, buildRecRiC, cardSvg, decodeEnv } from '../../../../lib/rec_iiif.js';

export const maxDuration = 30;
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'public, max-age=86400, s-maxage=31536000, immutable' }; // 토큰이 내용 — 불변
const json = (o, s = 200, t = 'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"') => new Response(JSON.stringify(o, null, 1), { status: s, headers: { ...H, 'Content-Type': s === 200 ? t : 'application/json' } });

export async function OPTIONS() { return new Response(null, { status: 204, headers: H }); }
export async function GET(req, { params }) {
  const { p = [] } = await params; const tok = String(p[0] || ''); const what = String(p[1] || 'manifest.json');
  try {
    if (/^card/.test(what)) return new Response(cardSvg(decodeEnv(tok)), { headers: { ...H, 'Content-Type': 'image/svg+xml; charset=utf-8' } });
    if (/^record|jsonld/.test(what)) return json(buildRecRiC(tok), 200, 'application/ld+json');
    return json(await buildRecManifest(tok));
  } catch (e) { return json({ error: '토큰 해독 실패 — cross_search(format=\'iiif\')가 만든 주소를 그대로 쓰십시오. ' + String(e && e.message || e).slice(0, 80) }, 400); }
}
