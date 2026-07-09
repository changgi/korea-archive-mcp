export const metadata = { title: 'Korea Archive MCP', description: 'Remote MCP server for discovering Korea-related records in foreign archives' };
export default function RootLayout({ children }) {
  return (<html lang="ko"><body style={{fontFamily:'system-ui,sans-serif',maxWidth:720,margin:'40px auto',padding:'0 20px',lineHeight:1.7}}>{children}</body></html>);
}
