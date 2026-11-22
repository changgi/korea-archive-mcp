// NARA → IIIF 공개 엔드포인트 (v1.98) — 어떤 NAID든 IIIF로 열린다(KV·Mirador·UV).
//   /iiif/nara/{naid}               → 매니페스트(기본)
//   /iiif/nara/{naid}/manifest.json → IIIF Presentation 3 Manifest
//   /iiif/nara/{naid}/collection.json → 하위 기록 Collection(시리즈·파일단위)
//   /iiif/nara/{naid}/record.jsonld → RiC-O JSON-LD(계층·생산자·권리·디지털 사본·PROV)
import { buildNaraManifest, buildNaraCollection, buildNaraRiC } from '../../../../lib/nara_iiif.js';

export const maxDuration = 45;
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400' };
const out = (obj, type, status = 200) => new Response(JSON.stringify(obj, null, 1), { status, headers: { ...H, 'Content-Type': type } });

export async function OPTIONS() { return new Response(null, { status: 204, headers: H }); }
export async function GET(req, { params }) {
  const { p = [] } = await params;
  const naid = Number(String(p[0] || '').replace(/\D/g, ''));
  const what = String(p[1] || 'manifest.json');
  if (!naid) return out({ error: 'NAID가 필요합니다 — /iiif/nara/{NAID}/manifest.json' }, 'application/json', 400);
  try {
    if (/^collection/.test(what)) { const c = await buildNaraCollection(naid); return c ? out(c, 'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"') : out({ error: `NAID ${naid} 없음` }, 'application/json', 404); }
    if (/^record|jsonld|ric/.test(what)) { const r = await buildNaraRiC(naid); return r ? out(r, 'application/ld+json') : out({ error: `NAID ${naid} 없음` }, 'application/json', 404); }
    const m = await buildNaraManifest(naid); return m ? out(m, 'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"') : out({ error: `NAID ${naid} 없음` }, 'application/json', 404);
  } catch (e) { return out({ error: String(e && e.message || e).slice(0, 200) }, 'application/json', 502); }
}
