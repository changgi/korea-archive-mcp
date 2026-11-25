// TNA→IIIF 엔드포인트 (v2.1) — /iiif/tna/{C-id}/manifest.json · /collection.json (실제 계층 재구성)
import { buildTnaManifest, buildTnaCollection } from '../../../../lib/tna_iiif.js';

export const maxDuration = 45;
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' };
const out = (o, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { ...H, 'Content-Type': s === 200 ? 'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"' : 'application/json' } });

export async function OPTIONS() { return new Response(null, { status: 204, headers: H }); }
export async function GET(req, { params }) {
  const { p = [] } = await params; const id = String(p[0] || ''); const what = String(p[1] || 'manifest.json');
  if (!/^[A-Za-z0-9]{2,20}$/.test(id)) return out({ error: 'TNA 레코드 id(C로 시작 — Discovery details/r/{id})가 필요합니다' }, 400);
  try { const r = /^collection/.test(what) ? await buildTnaCollection(id) : await buildTnaManifest(id); return r ? out(r) : out({ error: `TNA ${id} 없음` }, 404); }
  catch (e) { return out({ error: String(e && e.message || e).slice(0, 200) }, 502); }
}
