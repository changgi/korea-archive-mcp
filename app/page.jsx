const S = {
  page: { fontFamily: "'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif", background: '#f5f1e8', color: '#211d18', minHeight: '100vh', margin: 0 },
  hero: { background: '#171412', color: '#e9e2d6', padding: '52px 24px 44px' },
  in: { maxWidth: 860, margin: '0 auto' },
  mast: { fontSize: 12, letterSpacing: '.22em', color: '#9d9384', textTransform: 'uppercase' },
  h1: { margin: '14px 0 10px', fontSize: 40, lineHeight: 1.2, fontWeight: 800 },
  gold: { color: '#e8b45a' },
  sub: { color: '#cfc5b4', maxWidth: 640, lineHeight: 1.7 },
  wrap: { maxWidth: 860, margin: '0 auto', padding: '30px 24px 70px' },
  btns: { display: 'flex', flexWrap: 'wrap', gap: 10, margin: '22px 0 6px' },
  btn: { display: 'inline-block', padding: '12px 20px', background: '#8a3033', color: '#fff', borderRadius: 8, textDecoration: 'none', fontWeight: 700 },
  btn2: { display: 'inline-block', padding: '12px 20px', background: '#fffdf7', color: '#8a3033', border: '1px solid #dcd4c5', borderRadius: 8, textDecoration: 'none', fontWeight: 700 },
  h2: { margin: '38px 0 10px', fontSize: 21, fontWeight: 800 },
  pre: { background: '#241d15', color: '#e8c15c', padding: '13px 16px', borderRadius: 8, overflowX: 'auto', fontSize: 14 },
  p: { lineHeight: 1.75 },
  small: { fontSize: 13, color: '#6b6257', lineHeight: 1.7 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12, margin: '14px 0' },
  cell: { background: '#fffdf7', border: '1px solid #dcd4c5', borderRadius: 8, padding: '14px 16px', fontSize: 14, lineHeight: 1.65 },
  ct: { display: 'block', color: '#8a3033', fontWeight: 700, marginBottom: 4 },
};

export default function Home() {
  return (
    <main style={S.page}>
      <div style={S.hero}>
        <div style={S.in}>
          <div style={S.mast}><b style={S.gold}>KOREA ARCHIVE</b> 통합검색 · Integrated Search</div>
          <h1 style={S.h1}>흩어진 한국의 기록,<br /><span style={S.gold}>한 문장으로 찾습니다</span></h1>
          <p style={S.sub}>국내외 15개 아카이브(1860–1960)를 도구 20종으로 발굴·검증하고, 매거진 보고서부터
          카드뉴스·발표자료까지 산출물 12종을 만들어 드립니다. 매직 키워드: <b>“○○ 풀패키지로 만들어줘”</b> · <b>“창기창기 도와줘”</b></p>
          <div style={S.btns}>
            <a style={S.btn} href="/help.html">사용 안내 (한국어)</a>
            <a style={S.btn2} href="/help-en.html">User Guide (English)</a>
            <a style={S.btn2} href="/ingitda.html">기록잇다 — 즉석 검색</a>
          </div>
        </div>
      </div>

      <div style={S.wrap}>
        <h2 style={S.h2}>연결 / Connect</h2>
        <p style={S.p}>Claude(웹·모바일): 설정 → 커넥터 → 커스텀 커넥터 추가</p>
        <pre style={S.pre}>https://korea-archive-mcp.vercel.app/api/mcp</pre>
        <p style={S.small}>Claude Code: <code>claude mcp add --transport http korea-archive https://korea-archive-mcp.vercel.app/api/mcp</code><br />
        카카오 PlayMCP 마켓에서 “KOREA ARCHIVE 통합검색” 검색으로도 연결됩니다. 로그인·키 불필요.</p>

        <h2 style={S.h2}>도구 20종</h2>
        <div style={S.grid}>
          <div style={S.cell}><b style={S.ct}>해외 6</b>tna_search · tna_adjacent_mine(인접 채굴) · nara_search · ia_search · gallica_search · europeana_search</div>
          <div style={S.cell}><b style={S.ct}>국내 9</b>nedb_search(한국사DB + 조선 심층 판독 9모드) · archives · nlk · seoul_archives · foia · warmemo · koreanwar_search/item(협약기관·OpenAPI) · scrape_plan</div>
          <div style={S.cell}><b style={S.ct}>유틸 5</b>cross_search(동시 교차수집) · query_bank(검증 키워드+전략 6토픽) · judge_rights · report_template(kind 8종 — 풀패키지·매거진·도움말·인용·해설) · source_profile</div>
        </div>

        <h2 style={S.h2}>실물로 증명합니다</h2>
        <p style={S.p}>전부 한 문장에서 나온 실제 산출물입니다 —
        <a href="/examples/hanriver.html"> 한강 강배 발굴 보고서(1485–1986) 원본</a> ·
        <a href="/examples/joseon-deck.html"> 강연 풀덱 403장 「Chosen과 Joseon 사이」</a> ·
        더 많은 미리보기는 <a href="/help.html">사용 안내의 갤러리(14유형 55컷)</a>에.</p>

        <p style={S.small}>검증 원칙: 실물 기록만(AI 생성 인물·장면 금지) · 원문 대조 · 출처 명시 · 정정 공개 — 통과 산출물에만 검증 낙관.<br />
        Methodology: Song, Chang-Gi (2026), National Archives of Korea. <a href="https://github.com/changgi/korea-archive-mcp">GitHub</a> · MIT · MOU: KOREAN WAR ARCHIVES 6·25전쟁 아카이브센터</p>
      </div>
    </main>
  );
}
