// 발견 누적 원장(Discovery Ledger) v2.5 — 사용자가 도구로 발굴한 기록이 유실되지 않게, 무료로 매일 누적한다.
//   1) cross_search가 끝나면 발견 기록을 Upstash Redis 날짜 함 ka:in:YYYY-MM-DD에 RPUSH(+EXPIRE 3일) — v2.28부터 질의 지문(ak)으로 질의·회신(ka:q)과 연결
//   2) 공개 읽기 /api/ledger/{YYYY-MM-DD}?start=&n= (어차피 공개될 기록만 담김 — 쓰기·삭제 경로 없음)
//   3) GitHub Actions ledger.yml이 매일 꺼내 중복 제거·병합 → docs/data/discovered.* 커밋(git 이력 = 발견의 증거) → Pages 공개
// 무료 한도(Upstash Free: 월 50만 명령·250MB): 검색 1회 = 명령 2회 → 하루 약 8천 검색. 한도 초과·미설정이어도 검색은 그대로(조용히 생략).
import { createHash } from 'node:crypto';
// v2.28 질의 지문(ak) — 같은 도구·같은 인자면 같은 값. 발견 기록(ka:in)과 질의·회신(ka:q)을 잇는 열쇠(발견 경로 맥락·증거 사슬)
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : (v && typeof v === 'object') ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}` : JSON.stringify(v ?? null);
export const argKey = (tool, args) => createHash('sha256').update(String(tool) + stable(args || {})).digest('hex').slice(0, 16);
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
export async function stash(items, { tool = 'cross_search', fmt = 'text', probe = false, ak = '', partOf = () => '', iiif = () => '' } = {}) {
  const c = ledgerConf(); if (!c || !items || !items.length || probe) return false; // probe=자동 검사(골든·헬스) — 활용 집계를 부풀리지 않게 적재 안 함 // 원장에서 다시 찾은 기록(ledger 단독)은 재적재하지 않는다
  try {
    const rec = items.filter((it) => !(it.sources || []).every((x) => String(x).startsWith('ledger')) && !/Archive-It Crawl Data|^(헌정사 자료 DB|포로신문보고서) — '.+' 수록$/.test(String(it.title || ''))) // v2.34 알려진 결함 출력 패턴은 적재하지 않음.slice(0, 45).map((it) => { const o = { s: it.sources || [], t: String(it.title || '').slice(0, 300), d: it.date || '', i: it.id || '', u: it.url || '' };
      const p = partOf(it); if (p) o.p = p; if (it.media) o.m = it.media; if (it.sameAs) o.sa = it.sameAs; const x = iiif(it); if (x) o.x = x; return o; });
    if (!rec.length) return false;
    const k = `ka:in:${day()}`;
    await cmd(c, ['RPUSH', k, JSON.stringify({ at: new Date().toISOString().slice(0, 19) + 'Z', tool, f: fmt, ...(ak ? { ak } : {}), rec })]);
    await cmd(c, ['EXPIRE', k, String(3 * 86400)]);
    return true;
  } catch { return false; } // 무료 한도 초과·장애 — 검색 응답은 영향 없음
}
// v2.26 질의·회신 전부 축적 — 20개 도구의 질의(인자)와 회신 본문(압축)을 날짜 함 ka:q:YYYY-MM-DD에. v2.26.1부터 원문 그대로 저장(scrub 미사용 — 소유자 결정).
// 원장 병합(scripts/ledger_merge.py)이 docs/data/queries/YYYY-MM.jsonl.gz로 영구 축적 — 같은 질의·같은 회신(지문 동일)만 중복으로 합치고, 회신이 바뀌면 새 판으로 보존(증거성).
const PII = [[/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[이메일 제거]'], [/(?<!\d)(?:\+?82[- ]?)?0?1[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)/g, '[전화 제거]'], [/(?<!\d)\d{6}-?[1-4]\d{6}(?!\d)/g, '[주민번호 제거]'],
  [/(?<!\d)\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}(?!\d)/g, '[카드번호 제거]'], [/(?<!\d)\d{13,}(?!\d)/g, '[긴 숫자 제거]']];
export const scrub = (t) => PII.reduce((a, [re, r]) => a.replace(re, r), String(t ?? ''));
export async function stashCall(tool, args, text, { probe = false } = {}) {
  const c = ledgerConf(); if (!c || probe) return false;
  try {
    const { deflateRawSync } = await import('node:zlib'); const { createHash } = await import('node:crypto');
    const a = args || {}; const body = String(text ?? ''); // v2.26.1 원문 그대로 — 질의·회신은 기록이므로 어떤 패턴도 지우거나 바꾸지 않는다(소유자 결정)
    const rec = { at: new Date().toISOString().slice(0, 19) + 'Z', tool, args: a, ak: argKey(tool, a), h: createHash('sha256').update(body).digest('hex').slice(0, 16), n: Buffer.byteLength(body), z: deflateRawSync(Buffer.from(body), { level: 9 }).toString('base64') };
    const k = `ka:q:${day()}`;
    await cmd(c, ['RPUSH', k, JSON.stringify(rec)]); await cmd(c, ['EXPIRE', k, String(3 * 86400)]);
    return true;
  } catch { return false; } // 한도 초과·장애 — 응답에는 영향 없음
}
export async function readDay(d, start = 0, n = 500, kind = 'in') {
  const c = ledgerConf(); if (!c) return null;
  const k = `ka:${kind === 'q' ? 'q' : 'in'}:${d}`; const len = await cmd(c, ['LLEN', k], 5000);
  const rows = len ? await cmd(c, ['LRANGE', k, String(start), String(start + n - 1)], 8000) : [];
  return { day: d, kind, len, start, items: rows.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) };
}
