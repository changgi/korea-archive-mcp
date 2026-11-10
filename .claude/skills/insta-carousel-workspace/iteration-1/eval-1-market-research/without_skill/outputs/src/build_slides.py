# -*- coding: utf-8 -*-
"""Generate 6 Instagram carousel slides (1080x1350) as self-contained HTML files."""
import base64, os

INPUT = r"D:\korea-archive-mcp\.claude\skills\insta-carousel-workspace\inputs"
OUT = r"D:\korea-archive-mcp\.claude\skills\insta-carousel-workspace\iteration-1\eval-1-market-research\without_skill\outputs"
SRC = os.path.join(OUT, "src")
os.makedirs(SRC, exist_ok=True)

def b64(name):
    with open(os.path.join(INPUT, name), "rb") as f:
        return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()

IMG = {k: b64(k + ".jpg") for k in ["market_a", "market_b", "market_c", "crowd"]}

BASE_CSS = """
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:1080px; height:1350px; overflow:hidden; }
body {
  font-family:'Malgun Gothic','Noto Sans KR',sans-serif;
  background:#F4ECDC; color:#2B2118; position:relative;
}
.frame { position:absolute; inset:28px; border:3px solid #2B2118; }
.topbar { position:absolute; top:60px; left:80px; right:80px;
  display:flex; justify-content:space-between; align-items:center;
  font-size:26px; font-weight:bold; letter-spacing:6px; color:#2B2118; }
.topbar .dot { color:#D96C3D; }
.pagenum { font-size:26px; letter-spacing:2px; }
.badge { display:inline-block; background:#D96C3D; color:#F4ECDC;
  font-size:30px; font-weight:bold; padding:12px 28px; border-radius:40px;
  letter-spacing:2px; }
.badge.mustard { background:#E0A83C; color:#2B2118; }
.badge.ink { background:#2B2118; color:#F4ECDC; }
.polaroid { background:#FFFDF6; padding:22px 22px 0 22px; border:3px solid #2B2118;
  box-shadow:14px 14px 0 #2B2118; }
.polaroid img { width:100%; display:block; border:2px solid #2B2118; }
.polaroid .cap { text-align:center; font-size:30px; font-weight:bold;
  padding:20px 0 24px; letter-spacing:1px; }
.bottom-cta { position:absolute; bottom:64px; left:80px; right:80px;
  display:flex; justify-content:space-between; align-items:center;
  font-size:28px; font-weight:bold; }
.arrow { color:#D96C3D; font-size:34px; }
h1,h2,h3 { line-height:1.25; }
.hl { background:linear-gradient(transparent 55%, #E0A83C 55%); padding:0 6px; }
.hl-o { background:linear-gradient(transparent 55%, #f0b98d 55%); padding:0 6px; }
"""

def page(body, name):
    html = f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><style>{BASE_CSS}</style></head>
<body>{body}</body></html>"""
    with open(os.path.join(SRC, name), "w", encoding="utf-8") as f:
        f.write(html)

def topbar(n):
    return f"""<div class="topbar"><span>SEONGSU<span class="dot"> ● </span>VINTAGE</span>
    <span class="pagenum">{n} / 6</span></div>"""

# ---------- Slide 1 : Cover ----------
page(f"""
<div style="position:absolute; inset:0;">
  <img src="{IMG['crowd']}" style="width:120%; height:120%; margin:-5%; object-fit:cover; filter:blur(10px) saturate(1.1);">
  <div style="position:absolute; inset:0; background:linear-gradient(180deg, rgba(28,20,12,.62) 0%, rgba(28,20,12,.86) 62%, rgba(28,20,12,.94) 100%);"></div>
</div>
<div class="frame" style="border-color:#F4ECDC;"></div>
<div class="topbar" style="color:#F4ECDC;"><span>SEONGSU<span class="dot"> ● </span>VINTAGE</span><span class="pagenum">1 / 6</span></div>
<div style="position:absolute; left:80px; right:80px; top:400px; color:#F4ECDC;">
  <span class="badge mustard">발품 조사 리포트</span>
  <h1 style="font-size:82px; margin-top:44px; letter-spacing:-2px; white-space:nowrap;">
    성수동 빈티지 마켓 3곳,<br>직접 돌아봤습니다
  </h1>
  <p style="font-size:38px; margin-top:40px; line-height:1.6; color:#EFE3C8;">
    주말 웨이팅부터 가격 비교까지 —<br>
    가기 전에 이것만 알고 가세요
  </p>
</div>
<div class="bottom-cta" style="color:#F4ECDC;">
  <span>@seongsu.vintage.log</span>
  <span>넘겨서 보기 <span class="arrow">→→</span></span>
</div>
""", "slide1.html")

# ---------- Slide 2 : Waiting time ----------
page(f"""
<div class="frame"></div>
{topbar(2)}
<div style="position:absolute; left:80px; right:80px; top:140px;">
  <span class="badge">CHECK 1 · 대기시간</span>
  <h2 style="font-size:64px; margin-top:36px;">주말엔 <span class="hl">평균 40분</span> 기다립니다</h2>
</div>
<div style="position:absolute; left:110px; right:110px; top:390px; transform:rotate(-1.2deg);">
  <div class="polaroid">
    <img src="{IMG['crowd']}" style="height:465px; object-fit:cover;">
    <div class="cap">토요일 오후 2시, 입장 줄 실제 상황</div>
  </div>
</div>
<div style="position:absolute; left:80px; right:80px; bottom:170px; background:#2B2118; color:#F4ECDC; padding:36px 44px; border-radius:18px;">
  <p style="font-size:34px; font-weight:bold; line-height:1.55;">
    꿀팁 — <span style="color:#E0A83C;">평일 오전엔 대기 없음.</span><br>
    여유롭게 구경하려면 평일 오픈 직후를 노리세요.
  </p>
</div>
<div class="bottom-cta"><span>3곳 모두 현장 방문 기준</span><span class="arrow">→→</span></div>
""", "slide2.html")

# ---------- Slide 3 : Market A ----------
page(f"""
<div class="frame"></div>
{topbar(3)}
<div style="position:absolute; left:80px; right:80px; top:140px;">
  <span class="badge ink">STOP 1</span>
  <h2 style="font-size:68px; margin-top:32px;">첫 번째 마켓 <span style="font-size:40px; color:#8a7a63;">— 마켓 A</span></h2>
</div>
<div style="position:absolute; left:110px; right:110px; top:380px; transform:rotate(1.1deg);">
  <div class="polaroid">
    <img src="{IMG['market_a']}" style="height:540px; object-fit:cover;">
    <div class="cap">빼곡한 셀렉션, 구경만 해도 시간 순삭</div>
  </div>
</div>
<div style="position:absolute; left:80px; right:80px; bottom:160px;">
  <p style="font-size:36px; line-height:1.7;">
    ● 아이템 밀도 최상 — 보물찾기형 매장<br>
    ● 주말 오후엔 <span class="hl-o">웨이팅 각오</span> (평균 40분 구간)
  </p>
</div>
<div class="bottom-cta"><span>다음 마켓 계속</span><span class="arrow">→→</span></div>
""", "slide3.html")

# ---------- Slide 4 : Market B ----------
page(f"""
<div class="frame"></div>
{topbar(4)}
<div style="position:absolute; left:80px; right:80px; top:140px;">
  <span class="badge ink">STOP 2</span>
  <h2 style="font-size:68px; margin-top:32px;">두 번째 마켓 <span style="font-size:40px; color:#8a7a63;">— 마켓 B</span></h2>
</div>
<div style="position:absolute; left:110px; right:110px; top:380px; transform:rotate(-1.1deg);">
  <div class="polaroid">
    <img src="{IMG['market_b']}" style="height:540px; object-fit:cover;">
    <div class="cap">정돈된 진열, 초심자도 부담 없는 분위기</div>
  </div>
</div>
<div style="position:absolute; left:80px; right:80px; bottom:160px;">
  <p style="font-size:36px; line-height:1.7;">
    ● 동선이 편해서 커플·친구 방문에 무난<br>
    ● 역시 주말엔 붐빔 — <span class="hl-o">평일 오전이 답</span>
  </p>
</div>
<div class="bottom-cta"><span>가성비 1위는 다음 장에</span><span class="arrow">→→</span></div>
""", "slide4.html")

# ---------- Slide 5 : Retro Changgo (winner) ----------
page(f"""
<div class="frame" style="border-width:5px; border-color:#D96C3D;"></div>
{topbar(5)}
<div style="position:absolute; left:80px; right:80px; top:140px;">
  <span class="badge">STOP 3 · 가성비 1위 🏆</span>
  <h2 style="font-size:76px; margin-top:32px;">'레트로창고'</h2>
</div>
<div style="position:absolute; left:110px; right:110px; top:380px; transform:rotate(0.9deg);">
  <div class="polaroid">
    <img src="{IMG['market_c']}" style="height:500px; object-fit:cover;">
    <div class="cap">같은 급 아이템, 지갑은 덜 아픈 곳</div>
  </div>
</div>
<div style="position:absolute; left:80px; right:80px; bottom:150px; background:#D96C3D; color:#FFF6E8; padding:40px 44px; border-radius:18px; box-shadow:12px 12px 0 #2B2118;">
  <p style="font-size:38px; font-weight:bold; line-height:1.55;">
    3곳 비교 결과, 가격이 <span style="font-size:56px;">평균 30% 저렴</span><br>
    <span style="font-size:30px; font-weight:normal;">예산이 빠듯하다면 여기부터 들르세요</span>
  </p>
</div>
<div class="bottom-cta"><span>정리 한 장 남았어요</span><span class="arrow">→→</span></div>
""", "slide5.html")

# ---------- Slide 6 : Summary + CTA ----------
page(f"""
<body style="background:#2B2118;"></body>
<div style="position:absolute; inset:0; background:#2B2118;"></div>
<div class="frame" style="border-color:#E0A83C;"></div>
<div class="topbar" style="color:#F4ECDC;"><span>SEONGSU<span class="dot"> ● </span>VINTAGE</span><span class="pagenum">6 / 6</span></div>
<div style="position:absolute; left:80px; right:80px; top:160px; color:#F4ECDC;">
  <span class="badge mustard">3줄 요약</span>
  <div style="margin-top:56px; font-size:42px; line-height:1.6;">
    <div style="border-bottom:2px dashed #6b5d49; padding:52px 0;">
      ① 주말 대기 <b style="color:#E0A83C;">평균 40분</b> — 각오하고 가기</div>
    <div style="border-bottom:2px dashed #6b5d49; padding:52px 0;">
      ② <b style="color:#E0A83C;">평일 오전</b>은 대기 없음 — 최적 타이밍</div>
    <div style="padding:52px 0;">
      ③ 가격은 <b style="color:#E0A83C;">'레트로창고'가 평균 30% 저렴</b></div>
  </div>
</div>
<div style="position:absolute; left:80px; right:80px; bottom:200px; background:#F4ECDC; color:#2B2118; padding:44px 48px; border-radius:20px; text-align:center; box-shadow:12px 12px 0 #D96C3D;">
  <p style="font-size:42px; font-weight:bold; line-height:1.5;">
    이런 발품 리포트, 매주 올라옵니다 👀<br>
    <span style="color:#D96C3D;">팔로우</span>하고 다음 성수 코스도 받아보세요
  </p>
  <p style="font-size:32px; margin-top:22px; letter-spacing:1px;">🔖 저장 · 🤝 친구 태그 · ➕ 팔로우</p>
</div>
<div class="bottom-cta" style="color:#F4ECDC;"><span>@seongsu.vintage.log</span><span>다음 리포트에서 만나요 ✌️</span></div>
""", "slide6.html")

print("HTML slides written to", SRC)
