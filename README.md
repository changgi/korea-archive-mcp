# Korea Archive MCP — Remote server (Vercel)

Remote MCP server exposing 9 Korea-records discovery tools over Streamable HTTP.
No local Python needed by users — they just add a connector URL.

## Deploy (once)
1. Push this folder to GitHub (e.g. `korea-archive-mcp`)
2. vercel.com → Add New Project → Import the repo → Deploy (Next.js auto-detected)
3. Optional env vars (Project Settings → Environment Variables):
   - `NARA_API_KEY` — enables nara_search (free: Catalog_API@nara.gov)
   - `EUROPEANA_API_KEY` — enables europeana_search (free: apis.europeana.eu)

## Users connect with one URL
- Claude (web/desktop): Settings → Connectors → Add custom connector → `https://<deployment>.vercel.app/api/mcp`
- Claude Code: `claude mcp add --transport http korea-archive https://<deployment>.vercel.app/api/mcp`

MIT · Methodology: Song, Chang-Gi (2026), National Archives of Korea
