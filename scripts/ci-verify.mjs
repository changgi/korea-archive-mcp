#!/usr/bin/env node
// CI 정적 검증: 도구 20종·설명 길이(PlayMCP 1024자)·TOPICS 정규식 컴파일·24KB 가드 존재.
import fs from 'fs';

const SRC = fs.readFileSync(new URL('../app/api/[transport]/route.js', import.meta.url), 'utf8');
let fail = 0;
const bad = (msg) => { console.error('✗', msg); fail++; };
const ok = (msg) => console.log('✓', msg);

// 1) 도구 정확히 20종
const tools = [...SRC.matchAll(/server\.tool\('([a-z_]+)'/g)].map((m) => m[1]);
tools.length === 20 ? ok(`도구 20종: ${tools.length}`) : bad(`도구 수 ${tools.length} ≠ 20: ${tools.join(',')}`);

// 2) 전 도구 description ≤ 1024자 (SVC 17자 부착 후)
const SVC_LEN = ' — KOREA ARCHIVE 통합검색'.length;
for (const m of SRC.matchAll(/server\.tool\('([a-z_]+)',\s*\n\s*(['"])((?:[^\n\\]|\\.)*?)\2,/g)) {
  const len = [...m[3].replace(/\\(['"])/g, '$1')].length + SVC_LEN;
  if (len > 1024) bad(`${m[1]} description ${len}자 > 1024`);
}
ok('description 길이 검사 완료');

// 3) TOPICS 전 패턴 컴파일
const tblock = SRC.match(/const TOPICS = \[([\s\S]*?)\n\];/);
if (!tblock) bad('TOPICS 블록 미발견');
else {
  let n = 0;
  for (const m of tblock[1].matchAll(/\{ p: '((?:[^'\\]|\\.)*)'/g)) { new RegExp(m[1].replace(/\\\\/g, '\\'), 'giu'); n++; }
  n >= 80 ? ok(`TOPICS ${n}패턴 컴파일`) : bad(`TOPICS 패턴 수 이상: ${n}`);
}

// 4) 24KB 가드·SVC 래퍼 존재
SRC.includes('guard24k') ? ok('24KB 가드 존재') : bad('24KB 가드(guard24k) 소실');
SRC.includes("const SVC = ' — KOREA ARCHIVE 통합검색'") ? ok('SVC 상수 존재') : bad('SVC 상수 소실');

process.exit(fail ? 1 : 0);
