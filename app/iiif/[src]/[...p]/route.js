// IIIF 브리지 2 공개 엔드포인트 (v1.99) — /iiif/{heritage|much|awm|commons}/{id}/manifest.json  (NARA는 /iiif/nara/)
import { buildBridgeManifest } from '../../../../lib/ka_iiif.js';

export const maxDuration = 45;
export const preferredRegion = 'icn1'; // 국내 기관(국가유산청·역사박물관)은 해외·데이터센터 IP를 막는다 — 서울 리전에서 요청
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400' };
const out = (obj, status = 200) => new Response(JSON.stringify(obj, null, 1), { status, headers: { ...H, 'Content-Type': status === 200 ? 'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"' : 'application/json' } });

export async function OPTIONS() { return new Response(null, { status: 204, headers: H }); }
export async function GET(req, { params }) {
  const { src, p = [] } = await params;
  const id = decodeURIComponent(String(p[0] || ''));
  if (!id) return out({ error: `/iiif/${src}/{id}/manifest.json — id가 필요합니다` }, 400);
  try { const m = await buildBridgeManifest(src, id); return m ? out(m) : out({ error: `${src} ${id} 없음` }, 404); }
  catch (e) { return out({ error: String(e && e.message || e).slice(0, 200) }, /지원 기관|id는/.test(String(e && e.message)) ? 400 : 502); }
}
