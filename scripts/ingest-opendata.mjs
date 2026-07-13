#!/usr/bin/env node
// ingest-opendata — 국사편찬위 한국사DB 등 data.go.kr 공식 개방파일(KOGL)을 검색 인덱스로 변환.
// robots가 막은 라이브 검색을 대체하는 "파일 배치 수집"의 1단계: 다운로드한 파일 → nedb_index.json.
//
// 사용법:
//   node scripts/ingest-opendata.mjs <입력폴더> [출력파일=lib/nedb_index.json]
//   입력폴더에 data.go.kr에서 받은 .xml/.csv/.json 파일들을 넣어두면, 레코드를 추출해 인덱스를 만든다.
//   각 데이터셋(DB)의 필드명이 다르므로 FIELD_MAP을 실제 파일 구조에 맞춰 조정할 것(샘플 확인 후).
//
// 출력 형식: { built, count, records: [{ db, title, text, date, url }] }
//   → 이 파일을 웹에 배치(Vercel public/ 또는 별도 호스팅)하고 NEDB_INDEX_URL 로 지정하면 MCP가 검색한다.

import fs from 'fs';
import path from 'path';

const inputDir = process.argv[2];
const outFile = process.argv[3] || 'lib/nedb_index.json';
if (!inputDir) { console.error('usage: node scripts/ingest-opendata.mjs <input-dir> [out.json]'); process.exit(1); }

// 데이터셋별 라벨(파일명 → DB명). 실제 파일명에 맞게 조정.
const DB_LABEL = [
  [/비변사|bibyeon/i, '비변사등록'],
  [/사료총서|saryo/i, '한국사료총서'],
  [/인물|person/i, '근현대인물자료'],
  [/시소러스|thesaurus|용어/i, '한국역사용어시소러스'],
  [/관보|gwanbo/i, '관보'],
];
const labelFor = (fname) => (DB_LABEL.find(([re]) => re.test(fname)) || [null, '한국사DB'])[1];

// 필드 후보(여러 데이터셋의 흔한 태그/열 이름). 샘플 확인 후 보강.
const TITLE_KEYS = ['제목', '표제', 'title', '자료명', '문서명', '기사명', '항목명', 'name'];
const TEXT_KEYS = ['원문', '내용', '본문', 'content', 'text', '해제', '초록', 'desc', 'description'];
const DATE_KEYS = ['연대', '날짜', '일자', 'date', '생산일자', '발행일', '간행년'];
const URL_KEYS = ['url', 'link', '원문링크', 'URL', '상세링크', 'detail'];

const clean = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const pick = (obj, keys) => { for (const k of Object.keys(obj)) { if (keys.some((c) => k.toLowerCase() === c.toLowerCase())) return clean(String(obj[k])); } return ''; };

const RECOGNIZED = [...TITLE_KEYS, ...TEXT_KEYS, ...DATE_KEYS, ...URL_KEYS].map((k) => k.toLowerCase());
function extractXml(xml, recTag, db) {
  const out = [];
  for (const m of xml.matchAll(new RegExp(`<${recTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${recTag}>`, 'g'))) {
    const block = m[1]; const fields = {};
    for (const f of block.matchAll(/<([\w가-힣_.:-]+)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/g)) fields[f[1]] = f[2];
    const hasField = Object.keys(fields).some((k) => RECOGNIZED.includes(k.toLowerCase()));
    const title = pick(fields, TITLE_KEYS) || clean(block).slice(0, 80);
    if (!title) continue;
    out.push({ db, title, text: pick(fields, TEXT_KEYS).slice(0, 400), date: pick(fields, DATE_KEYS), url: pick(fields, URL_KEYS), _hasField: hasField });
  }
  return out;
}
function fromXml(xml, db) {
  const tags = {};
  for (const m of xml.matchAll(/<([A-Za-z가-힣_][\w가-힣_.:-]*)[^>]*>/g)) tags[m[1]] = (tags[m[1]] || 0) + 1;
  // fully-anchored exclusion so <resultItem>/<headerRecord> aren't wrongly dropped
  const candidates = Object.entries(tags).filter(([t]) => !/^(?:\?xml|root|response|result|header|body)$/i.test(t))
    .sort((a, b) => b[1] - a[1]).map(([t]) => t);
  // prefer the most-frequent wrapper whose records actually contain recognized fields (avoids picking a repeated child field)
  for (const recTag of candidates.slice(0, 6)) {
    const recs = extractXml(xml, recTag, db);
    if (recs.length && recs.filter((r) => r._hasField).length >= recs.length / 2) return recs.map(({ _hasField, ...r }) => r);
  }
  return candidates.length ? extractXml(xml, candidates[0], db).map(({ _hasField, ...r }) => r) : [];
}
// RFC-4180-aware split (quoted fields may contain commas / escaped "")
function csvSplit(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function fromCsv(csv, db) {
  const rows = csv.split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return [];
  const head = csvSplit(rows[0]).map((h) => h.trim());
  const idx = (keys) => head.findIndex((h) => keys.some((c) => h.toLowerCase() === c.toLowerCase()));
  const ti = idx(TITLE_KEYS), xi = idx(TEXT_KEYS), di = idx(DATE_KEYS), ui = idx(URL_KEYS);
  return rows.slice(1).map((r) => { const c = csvSplit(r).map(clean); return { db, title: ti >= 0 ? c[ti] : c[0], text: xi >= 0 ? (c[xi] || '').slice(0, 400) : '', date: di >= 0 ? c[di] : '', url: ui >= 0 ? c[ui] : '' }; }).filter((r) => r.title);
}
function fromJson(txt, db) {
  let data; try { data = JSON.parse(txt); } catch { return []; }
  const arr = Array.isArray(data) ? data : (data.records || data.data || data.items || []);
  return arr.map((o) => ({ db, title: pick(o, TITLE_KEYS), text: pick(o, TEXT_KEYS).slice(0, 400), date: pick(o, DATE_KEYS), url: pick(o, URL_KEYS) })).filter((r) => r.title);
}

const records = [];
for (const fname of fs.readdirSync(inputDir)) {
  const fp = path.join(inputDir, fname);
  if (!fs.statSync(fp).isFile()) continue;
  const ext = path.extname(fname).toLowerCase();
  const db = labelFor(fname);
  const txt = fs.readFileSync(fp, 'utf8');
  let recs = [];
  if (ext === '.xml') recs = fromXml(txt, db);
  else if (ext === '.csv') recs = fromCsv(txt, db);
  else if (ext === '.json') recs = fromJson(txt, db);
  else continue;
  console.log(`${fname} [${db}] → ${recs.length} records`);
  records.push(...recs);
}
const index = { built: new Date().toISOString(), source: 'data.go.kr 국사편찬위 한국사DB 개방파일(KOGL)', count: records.length, records };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(index));
console.log(`\n→ ${outFile} (${records.length} records). 웹 배치 후 NEDB_INDEX_URL 로 지정하세요.`);
