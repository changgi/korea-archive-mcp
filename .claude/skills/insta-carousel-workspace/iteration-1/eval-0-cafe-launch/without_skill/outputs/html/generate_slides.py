# -*- coding: utf-8 -*-
"""볕뜰로스터스 원두 구독 카드뉴스 8장 HTML 생성기 (1080x1350, 4:5)"""
import io, os

OUT = os.path.dirname(os.path.abspath(__file__))

COMMON_CSS = """
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1350px;overflow:hidden}
body{font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#33231A;background:#F7EFE2;
     -webkit-font-smoothing:antialiased;word-break:keep-all}
.slide{position:relative;width:1080px;height:1350px;padding:88px 84px;display:flex;flex-direction:column;overflow:hidden;background:#F7EFE2}
.topbar{display:flex;justify-content:space-between;align-items:center;position:relative;z-index:5}
.brand{display:flex;align-items:center;gap:16px;font-weight:700;font-size:30px;letter-spacing:1px;color:#5A3E2B}
.pagenum{font-size:26px;font-weight:700;color:#B99D77;letter-spacing:3px}
.kicker{display:inline-block;font-size:30px;font-weight:700;color:#C56A2B;letter-spacing:6px;margin-bottom:28px}
h1{font-size:88px;line-height:1.28;letter-spacing:-2px;font-weight:800}
h1 .accent{color:#C56A2B}
.hl{background:linear-gradient(transparent 68%, #F2C879 68%)}
.sub{font-size:36px;line-height:1.7;color:#6B5138;font-weight:400}
.footer{position:absolute;left:84px;right:84px;bottom:64px;display:flex;justify-content:space-between;align-items:center;font-size:25px;color:#B99D77;letter-spacing:2px;z-index:5}
.card{background:#FFFDF6;border-radius:28px;box-shadow:0 6px 0 #E8DCC4;padding:44px 48px}
.divider{width:88px;height:8px;border-radius:4px;background:#E89A3C;margin:40px 0}
"""

SUN_MARK = """<svg width="44" height="44" viewBox="0 0 44 44"><g stroke="#E89A3C" stroke-width="3.4" stroke-linecap="round"><circle cx="22" cy="22" r="9.5" fill="#E89A3C" stroke="none"/><line x1="22" y1="2" x2="22" y2="8"/><line x1="22" y1="36" x2="22" y2="42"/><line x1="2" y1="22" x2="8" y2="22"/><line x1="36" y1="22" x2="42" y2="22"/><line x1="7.9" y1="7.9" x2="12.1" y2="12.1"/><line x1="31.9" y1="31.9" x2="36.1" y2="36.1"/><line x1="7.9" y1="36.1" x2="12.1" y2="31.9"/><line x1="31.9" y1="12.1" x2="36.1" y2="7.9"/></g></svg>"""

BEAN = """<svg viewBox="0 0 120 160" width="%(w)s" height="%(h)s"><g fill="none"><ellipse cx="60" cy="80" rx="52" ry="74" fill="%(fill)s"/><path d="M60 10 C 38 46, 84 62, 60 106 C 44 134, 58 144, 60 150" stroke="%(line)s" stroke-width="9" stroke-linecap="round" fill="none"/></g></svg>"""

def bean(w, h, fill="#8A5A3B", line="#F7EFE2"):
    return BEAN % {"w": w, "h": h, "fill": fill, "line": line}

def page(n, body, extra_css=""):
    return """<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><style>%s%s</style></head>
<body><div class="slide">
<div class="topbar"><div class="brand">%s<span>볕뜰로스터스</span></div><div class="pagenum">%02d / 08</div></div>
%s
</div></body></html>""" % (COMMON_CSS, extra_css, SUN_MARK, n, body)

slides = {}

# ---------- 1. 커버 ----------
slides[1] = page(1, """
<div style="margin-top:120px;position:relative;z-index:4">
  <span class="kicker">NEW · 다음 달 시작</span>
  <h1 style="font-size:104px">갓 볶은 원두,<br>매주 <span class="accent">문 앞</span>으로.</h1>
  <div class="divider"></div>
  <p class="sub" style="font-size:40px">볕뜰로스터스 <b style="color:#33231A">주 1회 원두 구독</b><br>서비스를 시작합니다</p>
</div>
<div style="position:absolute;left:0;right:0;bottom:0;height:520px;z-index:1">
  <svg width="1080" height="520" viewBox="0 0 1080 520">
    <g stroke="#E8B463" stroke-width="10" stroke-linecap="round" opacity="0.9">
      <line x1="540" y1="30"  x2="540" y2="110"/>
      <line x1="330" y1="90"  x2="384" y2="150"/>
      <line x1="750" y1="90"  x2="696" y2="150"/>
      <line x1="210" y1="250" x2="290" y2="250"/>
      <line x1="870" y1="250" x2="790" y2="250"/>
    </g>
    <circle cx="540" cy="430" r="260" fill="#E89A3C"/>
    <circle cx="540" cy="430" r="205" fill="#EFA94E"/>
    <rect x="0" y="430" width="1080" height="90" fill="#5A3E2B"/>
    <g transform="translate(487,268)">
      <ellipse cx="53" cy="75" rx="50" ry="72" fill="#5A3E2B"/>
      <path d="M53 8 C 32 42, 76 58, 53 100 C 38 126, 51 138, 53 144" stroke="#F7EFE2" stroke-width="9" stroke-linecap="round" fill="none"/>
    </g>
  </svg>
</div>
<div class="footer" style="color:#F7EFE2;bottom:34px"><span>BYEOTTEUL ROASTERS</span><span>주 1회 원두 구독</span></div>
""")

# ---------- 2. 문제 제기 ----------
slides[2] = page(2, """
<div style="margin-top:96px">
  <span class="kicker">COFFEE FACT</span>
  <h1>지금 드시는 원두,<br><span class="accent">언제 볶은 건지</span><br>아시나요?</h1>
  <div class="divider"></div>
  <p class="sub">커피 향은 로스팅 직후가 가장 풍부하고,<br>시간이 지날수록 조금씩 사라져요.<br>날짜 없는 원두, 이미 몇 주 지났을지도 몰라요.</p>
</div>
<div style="position:absolute;left:84px;right:84px;bottom:140px">
  <div style="display:flex;align-items:flex-end;gap:56px;height:190px">
    <div style="flex:1;text-align:center;display:flex;flex-direction:column;justify-content:flex-end;height:190px"><div style="height:190px;background:#E89A3C;border-radius:18px 18px 0 0"></div></div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:190px"><div style="height:110px;background:#D9B98C;border-radius:18px 18px 0 0"></div></div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:190px"><div style="height:52px;background:#E4D5BE;border-radius:18px 18px 0 0"></div></div>
  </div>
  <div style="height:6px;background:#5A3E2B;border-radius:3px;margin-top:2px"></div>
  <div style="display:flex;gap:56px;margin-top:16px">
    <p style="flex:1;text-align:center;font-size:28px;font-weight:700;color:#5A3E2B">갓 볶은 날</p>
    <p style="flex:1;text-align:center;font-size:28px;font-weight:700;color:#8A7358">2주 뒤</p>
    <p style="flex:1;text-align:center;font-size:28px;font-weight:700;color:#B99D77">한 달 뒤</p>
  </div>
  <p style="margin-top:18px;font-size:26px;color:#B99D77;text-align:right;letter-spacing:1px">원두의 향, 시간이 지나면 이렇게 줄어요</p>
</div>
""")

# ---------- 3. 서비스 소개 ----------
slides[3] = page(3, """
<div style="margin-top:96px">
  <span class="kicker">SO, WE MADE IT</span>
  <h1>그래서<br>준비했어요.<br><span class="accent">주 1회 원두 구독</span></h1>
  <div class="divider"></div>
  <p class="sub">매주 정해진 요일에 로스팅하고,<br>그 주에 갓 볶은 원두만 담아 보내드려요.</p>
</div>
<div style="position:absolute;left:84px;right:84px;bottom:140px;display:flex;flex-direction:column;gap:26px">
  <div class="card" style="display:flex;align-items:center;gap:30px"><span style="font-size:44px">📦</span><p style="font-size:34px;font-weight:700">매주 1회, 같은 요일에 정기 배송</p></div>
  <div class="card" style="display:flex;align-items:center;gap:30px"><span style="font-size:44px">🫘</span><p style="font-size:34px;font-weight:700">블렌드·싱글오리진 중 취향대로 선택</p></div>
  <div class="card" style="display:flex;align-items:center;gap:30px"><span style="font-size:44px">🌙</span><p style="font-size:34px;font-weight:700">여행 갈 땐 언제든 한 주 쉬어가기</p></div>
</div>
""")

# ---------- 4. 핵심: 24시간 ----------
slides[4] = page(4, """
<div style="margin-top:80px;text-align:center">
  <span class="kicker">OUR PROMISE</span>
  <h1 style="font-size:76px">볕뜰의 약속</h1>
  <p style="margin-top:44px;font-size:172px;font-weight:800;letter-spacing:-6px;color:#C56A2B;line-height:1">24<span style="font-size:88px;letter-spacing:0">시간</span></p>
  <p class="sub" style="margin-top:36px;font-size:42px;color:#33231A;font-weight:700">로스팅 후 <span style="color:#C56A2B">24시간 안에</span> 배송합니다</p>
  <p class="sub" style="margin-top:20px;font-size:32px">가장 향이 좋은 순간의 원두가, 식기 전에 떠납니다.</p>
</div>
<div style="position:absolute;left:84px;right:84px;bottom:160px">
  <div style="position:relative;height:8px;background:#E4D5BE;border-radius:4px;margin:0 40px 40px">
    <div style="position:absolute;left:0;top:0;height:8px;width:100%;background:linear-gradient(90deg,#E89A3C,#C56A2B);border-radius:4px"></div>
  </div>
  <div style="display:flex;justify-content:space-between;text-align:center;margin-top:-64px">
    <div style="flex:1"><div style="width:34px;height:34px;border-radius:50%;background:#E89A3C;border:8px solid #F7EFE2;margin:0 auto"></div><p style="margin-top:16px;font-size:30px;font-weight:700">아침, 로스팅</p><p style="font-size:25px;color:#B99D77;margin-top:6px">0시간</p></div>
    <div style="flex:1"><div style="width:34px;height:34px;border-radius:50%;background:#D9853A;border:8px solid #F7EFE2;margin:0 auto"></div><p style="margin-top:16px;font-size:30px;font-weight:700">소분·밀봉 포장</p><p style="font-size:25px;color:#B99D77;margin-top:6px">당일</p></div>
    <div style="flex:1"><div style="width:34px;height:34px;border-radius:50%;background:#C56A2B;border:8px solid #F7EFE2;margin:0 auto"></div><p style="margin-top:16px;font-size:30px;font-weight:700">배송 출발</p><p style="font-size:25px;color:#B99D77;margin-top:6px">24시간 이내</p></div>
  </div>
</div>
""")

# ---------- 5. 원두 라인업 ----------
slides[5] = page(5, """
<div style="margin-top:64px">
  <span class="kicker">PICK YOUR BEANS</span>
  <h1>원두는<br><span class="accent">취향대로</span> 골라요</h1>
  <div class="divider" style="margin:32px 0"></div>
</div>
<div style="margin-top:8px;display:flex;flex-direction:column;gap:26px">
  <div class="card" style="display:flex;gap:36px;align-items:center;padding:34px 44px">
    <div style="flex-shrink:0">%s</div>
    <div><p style="font-size:26px;font-weight:700;color:#C56A2B;letter-spacing:3px">OPTION A</p>
      <p style="font-size:40px;font-weight:800;margin-top:8px">볕뜰 블렌드</p>
      <p style="font-size:28px;color:#6B5138;margin-top:10px;line-height:1.55">고소하고 달큰한 밸런스.<br>매일 마셔도 질리지 않는 데일리 커피.</p></div>
  </div>
  <div class="card" style="display:flex;gap:36px;align-items:center;padding:34px 44px">
    <div style="flex-shrink:0">%s</div>
    <div><p style="font-size:26px;font-weight:700;color:#C56A2B;letter-spacing:3px">OPTION B</p>
      <p style="font-size:40px;font-weight:800;margin-top:8px">이달의 싱글오리진</p>
      <p style="font-size:28px;color:#6B5138;margin-top:10px;line-height:1.55">매달 바뀌는 산지 한 곳의 개성.<br>새로운 향미가 궁금한 분께.</p></div>
  </div>
</div>
<div class="card" style="margin-top:auto;margin-bottom:24px;padding:30px 44px">
  <p style="font-size:29px;font-weight:700;color:#5A3E2B;text-align:center">🫙 홀빈 · 핸드드립 · 에스프레소 분쇄 중 선택 가능</p>
</div>
""" % (bean(84, 112, "#8A5A3B"), bean(84, 112, "#C56A2B")))

# ---------- 6. 이용 방법 ----------
slides[6] = page(6, """
<div style="margin-top:88px">
  <span class="kicker">HOW TO JOIN</span>
  <h1>신청은<br><span class="accent">이렇게</span> 하세요</h1>
  <div class="divider"></div>
</div>
<div style="margin-top:24px;display:flex;flex-direction:column;gap:34px">
  <div style="display:flex;gap:36px;align-items:flex-start">
    <div style="flex-shrink:0;width:96px;height:96px;border-radius:50%;background:#E89A3C;color:#FFFDF6;font-size:42px;font-weight:800;display:flex;align-items:center;justify-content:center">1</div>
    <div><p style="font-size:40px;font-weight:800">DM 또는 매장에서 신청</p><p style="font-size:30px;color:#6B5138;margin-top:10px;line-height:1.6">원두 종류·분쇄도·받을 요일을 알려주세요.</p></div>
  </div>
  <div style="display:flex;gap:36px;align-items:flex-start">
    <div style="flex-shrink:0;width:96px;height:96px;border-radius:50%;background:#D9853A;color:#FFFDF6;font-size:42px;font-weight:800;display:flex;align-items:center;justify-content:center">2</div>
    <div><p style="font-size:40px;font-weight:800">매주 그 요일에 맞춰 로스팅</p><p style="font-size:30px;color:#6B5138;margin-top:10px;line-height:1.6">주문받은 만큼만 소량으로 볶습니다.</p></div>
  </div>
  <div style="display:flex;gap:36px;align-items:flex-start">
    <div style="flex-shrink:0;width:96px;height:96px;border-radius:50%;background:#C56A2B;color:#FFFDF6;font-size:42px;font-weight:800;display:flex;align-items:center;justify-content:center">3</div>
    <div><p style="font-size:40px;font-weight:800">24시간 안에 문 앞으로</p><p style="font-size:30px;color:#6B5138;margin-top:10px;line-height:1.6">갓 볶은 향 그대로, 매주 새 원두가 도착해요.</p></div>
  </div>
</div>
<div style="position:absolute;left:84px;right:84px;bottom:120px" class="card">
  <p style="font-size:30px;font-weight:700;color:#5A3E2B;text-align:center">💬 가격·구독 옵션은 프로필 링크와 DM으로 안내드려요</p>
</div>
""")

# ---------- 7. 즐기는 팁 ----------
slides[7] = page(7, """
<div style="margin-top:52px">
  <span class="kicker">BREW TIP · 저장해 두세요</span>
  <h1>갓 볶은 원두,<br><span class="accent">이렇게</span> 즐겨요</h1>
  <div class="divider" style="margin:30px 0"></div>
</div>
<div style="margin-top:12px;display:flex;flex-direction:column;gap:22px">
  <div class="card" style="padding:32px 44px"><p style="font-size:35px;font-weight:800">☀️ 도착 후 2~3일, 향이 활짝 피어요</p><p style="font-size:28px;color:#6B5138;margin-top:10px;line-height:1.55">갓 볶은 원두는 가스를 내보내는 중.<br>며칠 두고 마시면 맛이 더 안정돼요.</p></div>
  <div class="card" style="padding:32px 44px"><p style="font-size:35px;font-weight:800">🫙 밀봉해서 서늘한 곳에 보관</p><p style="font-size:28px;color:#6B5138;margin-top:10px;line-height:1.55">햇빛·습기·냄새를 피하면<br>마지막 잔까지 신선하게 즐길 수 있어요.</p></div>
  <div class="card" style="padding:32px 44px"><p style="font-size:35px;font-weight:800">⏱️ 분쇄는 마시기 직전에</p><p style="font-size:28px;color:#6B5138;margin-top:10px;line-height:1.55">갈아 두면 향이 빨리 날아가요.<br>홀빈 구독이라면 내리기 직전에 갈아주세요.</p></div>
</div>
""")

# ---------- 8. CTA ----------
slides[8] = page(8, """
<div style="margin-top:150px;text-align:center;position:relative;z-index:4">
  <span class="kicker">OPEN NEXT MONTH</span>
  <h1 style="font-size:92px">다음 달,<br>첫 로스팅을<br><span class="accent">시작합니다</span></h1>
  <div class="divider" style="margin:44px auto"></div>
  <p class="sub" style="font-size:36px">구독 신청과 문의는<br><b style="color:#33231A">인스타그램 DM</b> 또는 <b style="color:#33231A">매장 방문</b>으로!</p>
  <div style="margin-top:56px;display:inline-block;background:#C56A2B;color:#FFFDF6;font-size:36px;font-weight:800;padding:28px 64px;border-radius:60px;letter-spacing:1px">프로필 링크에서 자세히 보기 →</div>
</div>
<div style="position:absolute;left:0;right:0;bottom:0;height:300px;z-index:1">
  <svg width="1080" height="300" viewBox="0 0 1080 300">
    <circle cx="540" cy="330" r="230" fill="#E89A3C"/>
    <circle cx="540" cy="330" r="180" fill="#EFA94E"/>
    <g stroke="#E8B463" stroke-width="9" stroke-linecap="round">
      <line x1="540" y1="30" x2="540" y2="80"/>
      <line x1="360" y1="80" x2="400" y2="126"/>
      <line x1="720" y1="80" x2="680" y2="126"/>
      <line x1="270" y1="210" x2="336" y2="222"/>
      <line x1="810" y1="210" x2="744" y2="222"/>
    </g>
  </svg>
</div>
<div class="footer" style="bottom:44px;color:#8A5A3B"><span>볕뜰로스터스 · BYEOTTEUL ROASTERS</span><span>주 1회 갓볶은 원두 구독</span></div>
""")

for n, html in slides.items():
    p = os.path.join(OUT, "slide-%02d.html" % n)
    with io.open(p, "w", encoding="utf-8") as f:
        f.write(html)
    print("wrote", p)
