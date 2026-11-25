// 검색 결과 CSV 내려받기 (v2.4) — cross_search(format='csv') 응답의 링크. 토큰 = CSV 본문을 raw deflate + base64url로 봉인(서버 저장 없음, 링크가 곧 파일).
// 엑셀 한글 깨짐 방지 BOM, 첨부 파일명 = korea-archive_<질의>_<날짜>.csv
import { inflateRawSync } from 'node:zlib';
export const preferredRegion = 'icn1';
const H = { 'Access-Control-Allow-Origin': '*' };
export async function GET(_req, { params }) {
  const { tok } = await params;
  try {
    const j = JSON.parse(inflateRawSync(Buffer.from(String(tok).replace(/\.csv$/, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString('utf8'));
    const name = `korea-archive_${String(j.q || 'search').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}_${String(j.at || '').slice(0, 10)}.csv`;
    return new Response('﻿' + j.csv, { headers: { ...H, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } catch { return new Response('잘못된 CSV 링크입니다 — cross_search(format=\'csv\')를 다시 실행해 새 링크를 받으세요.', { status: 400, headers: { ...H, 'Content-Type': 'text/plain; charset=utf-8' } }); }
}
