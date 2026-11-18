#!/usr/bin/env node
// CI 패리티 검증: route.js ↔ marketplace server.py 2사본 — 도구명 집합 일치.
// 사용: node scripts/ci-parity.mjs <marketplace-clone-dir>
import fs from 'fs';
import path from 'path';

const mkt = process.argv[2];
if (!mkt) { console.error('usage: ci-parity.mjs <marketplace-dir>'); process.exit(2); }

const SRC = fs.readFileSync(new URL('../app/api/[transport]/route.js', import.meta.url), 'utf8');
const nodeTools = [...SRC.matchAll(/server\.tool\('([a-z_]+)'/g)].map((m) => m[1]).sort();

const pyTools = (file) => {
  const s = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /@mcp\.tool\(\)\s*\ndef ([a-z_]+)/g;
  for (const m of s.matchAll(re)) out.push(m[1]);
  return out.sort();
};

let fail = 0;
for (const rel of ['plugins/korea-archive/servers/server.py', 'mcp/server.py']) {
  const py = pyTools(path.join(mkt, rel));
  const same = JSON.stringify(py) === JSON.stringify(nodeTools);
  if (same) console.log(`✓ 패리티 OK (${rel}): ${py.length}종`);
  else { console.error(`✗ 패리티 불일치 (${rel})\n  node만: ${nodeTools.filter((t) => !py.includes(t))}\n  py만: ${py.filter((t) => !nodeTools.includes(t))}`); fail++; }
}
process.exit(fail ? 1 : 0);
