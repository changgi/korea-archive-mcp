// 발견 누적 원장 공개 읽기(v2.5) — 날짜 함의 발견 기록(검색어·사용자 정보 없음). 쓰기·삭제 경로는 없다.
import { readDay } from '../../../../lib/ledger.js';
export const preferredRegion = 'icn1';
export const dynamic = 'force-dynamic';
const H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
export async function GET(req, { params }) {
  const { day } = await params; const q = new URL(req.url).searchParams;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Response(JSON.stringify({ error: 'day=YYYY-MM-DD' }), { status: 400, headers: H });
  const start = Math.max(0, parseInt(q.get('start') || '0', 10) || 0), n = Math.min(500, Math.max(1, parseInt(q.get('n') || '500', 10) || 500)); const kind = q.get('kind') === 'q' ? 'q' : 'in'; // v2.26 kind=q: 질의·회신
  try { const r = await readDay(day, start, n, kind); if (!r) return new Response(JSON.stringify({ error: 'ledger 미설정(Upstash Redis 연결 필요)' }), { status: 503, headers: H });
    return new Response(JSON.stringify(r), { headers: H }); }
  catch (e) { return new Response(JSON.stringify({ error: String(e.message || e).slice(0, 80) }), { status: 502, headers: H }); }
}
