import { redirect } from 'next/navigation';

// 루트 진입 시 사용 안내 페이지로 — 커넥터 주소를 브라우저로 연 사용자를 위한 랜딩.
export default function Home() {
  redirect('/help.html');
}
