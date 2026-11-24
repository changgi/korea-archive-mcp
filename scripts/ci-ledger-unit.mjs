// v2.58.1 원장 읽기·쓰기 단위 시험 — 모의 Redis로 readDay(in·q·qp)·stash·stashCall이 실제로 동작하는지(문법 검사로는 안 잡히는 '줄 주석이 코드를 삼킨' 결함 방지)
process.env.KV_REST_API_URL = 'https://ledger.invalid'; process.env.KV_REST_API_TOKEN = 'test';
const calls = [];
globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); calls.push(b);
  return { ok: true, json: async () => ({ result: b[0] === 'LLEN' ? 2 : b[0] === 'LRANGE' ? ['{"tool":"x","h":"a"}', 'not json'] : 1 }) }; };
const m = await import(new URL('../lib/ledger.js', import.meta.url));
let bad = 0; const ok = (c, msg) => { console.log((c ? '✓ ' : '❌ ') + msg); if (!c) bad++; };
for (const kind of ['in', 'q', 'qp']) {
  const r = await m.readDay('2026-01-01', 0, 10, kind);
  ok(r && r.len === 2 && r.items.length === 1 && calls.at(-1)[1] === `ka:${kind}:2026-01-01`, `readDay kind=${kind} → ka:${kind} 읽기`);
}
const r0 = await m.readDay('2026-01-01', 0, 10, 'bogus'); ok(r0 && calls.at(-1)[1] === 'ka:in:2026-01-01', 'readDay 알 수 없는 kind → ka:in');
await m.stashCall('t', { a: 1 }, 'body', { probe: 'golden' }); const p = calls.find((c) => c[0] === 'RPUSH' && String(c[1]).startsWith('ka:qp:'));
ok(p && JSON.parse(p[2]).probe === 'golden' && JSON.parse(p[2]).h, 'stashCall probe → ka:qp(probe 표기)');
await m.stashCall('t', { a: 1 }, 'body'); ok(calls.some((c) => c[0] === 'RPUSH' && String(c[1]).startsWith('ka:q:')), 'stashCall 일반 → ka:q');
ok(m.argKey('t', { b: 1, a: 2 }) === m.argKey('t', { a: 2, b: 1 }), 'argKey 키 순서 무관');
const n0 = calls.length; await m.stash([{ sources: ['nara'], title: 'x' }], { probe: 'golden' }); ok(calls.length === n0, 'stash probe → 발견 함 적재 안 함');
await m.stash([{ sources: ['nara'], title: 'x', url: 'u' }]); ok(calls.some((c) => c[0] === 'RPUSH' && String(c[1]).startsWith('ka:in:')), 'stash 일반 → ka:in');
if (bad) { console.error(`원장 단위 시험 실패 ${bad}건`); process.exit(1); }
console.log('원장 단위 시험 통과');
