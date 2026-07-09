export default function Home() {
  return (<main>
    <h1>🇰🇷 Korea Archive MCP</h1>
    <p>Remote MCP server for discovering Korea-related records (1860–1960) in NARA, TNA, archive.org, Gallica, and Europeana. 해외 아카이브 한국 기록 발굴 원격 MCP 서버.</p>
    <h2>Connect / 연결</h2>
    <p>MCP endpoint (Streamable HTTP):</p>
    <pre style={{background:'#f4f4f4',padding:'12px',borderRadius:8}}>https://&lt;your-deployment&gt;.vercel.app/api/mcp</pre>
    <p>Claude: Settings → Connectors → Add custom connector → paste the URL above.<br/>Claude Code: <code>claude mcp add --transport http korea-archive https://&lt;your-deployment&gt;.vercel.app/api/mcp</code></p>
    <h2>Tools (9)</h2>
    <p>tna_search · tna_adjacent_mine · nara_search · ia_search · ia_metadata · gallica_search · europeana_search · query_bank · judge_rights</p>
    <p>Methodology: Song, Chang-Gi (2026), National Archives of Korea — F1 0.931. <a href="https://github.com/changgi/korea-archive-marketplace">GitHub</a> · MIT</p>
  </main>);
}
