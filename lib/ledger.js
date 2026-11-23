// 발견 누적 원장(Discovery Ledger) v2.5 — 사용자가 도구로 발굴한 기록이 유실되지 않게, 무료로 매일 누적한다.
//   1) cross_search가 끝나면 발견 기록만(검색어·사용자 정보 없음) Upstash Redis 날짜 함 ka:in:YYYY-MM-DD에 RPUSH(+EXPIRE 3일)
//   2) 공개 읽기 /api/ledger/{YYYY-MM-DD}?start=&n= (어차피 공개될 기록만 담김 — 쓰기·삭제 경로 없음)
//   3) GitHub Actions ledger.yml이 매일 꺼내 중복 제거·병합 → docs/data/discovered.* 커밋(git 이력 = 발견의 증거) → Pages 공개
// 무료 한도(Upstash Free: 월 50만 명령·250MB): 검색 1회 = 명령 2회 → 하루 약 8천 검색. 한도 초과·미설정이어도 검색은 그대로(조용히 생략).
const envPick = (suf) => { for (const [k, v] of Object.entries(process.env)) if (v && k.endsWith(suf) && !/READ_ONLY/.test(k)) return v; return ''; };
export const ledgerConf = () => {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envPick('_KV_REST_API_URL') || envPick('_REDIS_REST_URL');
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envPick('_KV_REST_API_TOKEN') || envPick('_REDIS_REST_TOKEN');
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
};
export const LEDGER_PAGE = 'https://changgi.github.io/korea-archive-mcp/data/';
const day = () => new Date().toISOString().slice(0, 10);
async function cmd(c, body, ms = 1200) {
  const r = await fetch(c.url, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('ledger HTTP ' + r.status); return (await r.json()).result;
}
// 기록 묶음 1건 = 검색 1회. tool=발견 도구, rec=[{s,t,d,i,u,p,m,sa,f}] (f=원본 확인 등 출처 표기 원문)
export async function stash(items, { tool = 'cross_search', partOf = () => '', iiif = () => '' } = {}) {
  const c = ledgerConf(); if (!c || !items || !items.length) return false;
  try {
    const rec = items.slice(0, 45).map((it) => { const o = { s: it.sources || [], t: String(it.title || '').slice(0, 300), d: it.date || '', i: it.id || '', u: it.url || '' };
      const p = partOf(it); if (p) o.p = p; if (it.media) o.m = it.media; if (it.sameAs) o.sa = it.sameAs; const x = iiif(it); if (x) o.x = x; return o; });
    const k = `ka:in:${day()}`;
    await cmd(c, ['RPUSH', k, JSON.stringify({ at: new Date().toISOString().slice(0, 19) + 'Z', tool, rec })]);
    await cmd(c, ['EXPIRE', k, String(3 * 86400)]);
    return true;
  } catch { return false; } // 무료 한도 초과·장애 — 검색 응답은 영향 없음
}
export async function readDay(d, start = 0, n = 500) {
  const c = ledgerConf(); if (!c) return null;
  const k = `ka:in:${d}`; const len = await cmd(c, ['LLEN', k], 5000);
  const rows = len ? await cmd(c, ['LRANGE', k, String(start), String(start + n - 1)], 8000) : [];
  return { day: d, len, start, items: rows.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) };
}
