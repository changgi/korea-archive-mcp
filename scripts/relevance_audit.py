#!/usr/bin/env python3
"""관련성 감사(v2.25) — '그럴듯한 오답'을 스스로 발견한다.

health는 결과 '건수'만 본다. 그런데 수집기가 검색 결과 대신 사이트 메뉴(한국사DB, 2026-11 실측)나
웹 크롤링 묶음(IA, 2026-11 실측)을 읽어도 건수는 정상으로 보인다. 이 감사는 수집처마다 골든 질의를 던져
결과 제목·계열에 검색어(또는 인정 번역어)가 실제로 들어 있는지, 알려진 오답 패턴이 없는지 검사한다.

사용: python3 scripts/relevance_audit.py [--url URL] [--only ia,nedb] [--md 요약.md]
종료 코드: 실패 1(이슈 생성 대상). 표준 라이브러리만.
"""
import argparse, csv, io, json, re, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="https://korea-archive-mcp.vercel.app/api/mcp")
ap.add_argument("--only", default="")
ap.add_argument("--md", default="")
a = ap.parse_args()
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "X-KA-Probe": "relevance"}  # 누적 원장 적재 제외

# 수집처: (질의, 인정 토큰 — 검색어·번역어·원표기, 최소 일치 건수). 0 = 결과 0건도 허용(기관 측 사정)
CASES = {
    "tna": ("Korea", ["korea", "corea"], 1), "ia": ("Hungnam", ["hungnam", "흥남"], 1), "gallica": ("Corée", ["corée", "coree", "korea"], 1),
    "europeana": ("Korea", ["korea", "corée", "korea"], 1), "nara": ("Korea", ["korea"], 1), "archives": ("한국전쟁", ["한국전쟁", "6·25", "6.25"], 1),
    "nlk": ("한국전쟁", ["한국전쟁"], 1), "nedb": ("한강", ["한강", "漢江"], 1), "koreanwar": ("장진호", ["장진호", "chosin", "changjin", "hagaru", "koto", "hungnam", "marine"], 1),
    "jacar": ("Chosen", ["朝鮮", "chosen", "korea", "韓国", "京城"], 1), "earchive": ("제주도", ["제주"], 1), "i815": ("안중근", ["안중근", "安重根"], 1),
    "gonghun": ("안중근", ["안중근", "安重根"], 1), "ktv": ("대한뉴스", ["대한뉴스", "뉴스"], 1), "oldnews": ("의병", ["의병", "義兵"], 1),
    "much": ("판문점", ["판문점", "板門店"], 1), "indy": ("유관순", ["유관순", "柳寬順"], 1), "heritage": ("숭례문", ["숭례문", "崇禮門"], 1),
    "kyudb": ("절목", ["절목", "節目"], 1), "jsg": ("의궤", ["의궤", "儀軌"], 1), "awm": ("Kapyong", ["kapyong", "kapyeong", "가평"], 1),
    "nlna": ("Korea", ["korea", "korea", "corea"], 1), "dnz": ("Korean War", ["korea"], 1), "nzarch": ("Korea", ["korea"], 1),
    "commons": ("Seoul 1950", ["seoul", "1950"], 1), "un": ("Korea armistice", ["korea", "armistice", "democratic people", "dprk"], 1),
    "ndl": ("조선총독부", ["朝鮮総督府", "朝鮮總督府", "조선총독부"], 1), "seoul": ("한강", ["한강"], 1), "foia": ("회의", ["회의"], 0),
    "aks": ("문중", ["문중", "종중", "종가", "후손"], 1), "gallery": ("흥남", ["흥남", "hungnam"], 1),
    "okchf": ("불화", ["불화", "탱", "감로", "보살", "나한", "지장", "불", "조사보고서"], 1), "nrich": ("미륵사", ["미륵사", "彌勒寺"], 1),
}
# 알려진 오답 패턴(옛 결함) — 다시 나오면 즉시 실패
JUNK = [r"Archive-It Crawl Data", r"^헌정사 자료 DB — ", r"^포로신문보고서 — ", r"— '.+' 수록$"]


def post(body, sid=None, t=150):
    h = dict(H, **({"Mcp-Session-Id": sid} if sid else {}))
    r = urllib.request.urlopen(urllib.request.Request(a.url, json.dumps(body).encode(), h), timeout=t)
    return r.headers.get("mcp-session-id"), r.read().decode("utf-8", "replace")


def call(sid, tool, args):
    _, raw = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}}, sid)
    line = next((ln[6:] if ln.startswith("data: ") else ln for ln in raw.splitlines() if ln.lstrip("data: ").startswith("{")), "{}")
    j = json.loads(line)
    return ((j.get("result") or {}).get("content") or [{}])[0].get("text", "")


sid, _ = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "relevance", "version": "1"}}})
post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
only = set(filter(None, a.only.split(",")))
rows, fails = [], 0
for src, (q, toks, need) in CASES.items():
    if only and src not in only:
        continue
    t0 = time.time(); prob = ""
    try:
        txt = call(sid, "cross_search", {"query": q, "sources": src, "max_per_source": 5, "format": "csv"})
        L = txt.split("\n"); s = next((i for i, l in enumerate(L) if l.startswith("node,")), None)
        recs = [r for r in csv.DictReader(io.StringIO("\n".join(L[s:])))] if s is not None else []
        recs = [r for r in recs if r.get("sources")]
        hit = sum(1 for r in recs if any(t.lower() in (r.get("title", "") + " " + r.get("partOf", "")).lower() for t in toks))
        junk = [r["title"][:60] for r in recs if any(re.search(p, r.get("title", "")) for p in JUNK)]
        if junk: prob = f"오답 패턴: {junk[0]}"
        elif need and not recs: prob = "결과 0건(채널 장애 — health와 대조)"
        elif need and hit < need: prob = f"검색어·번역어 미포함 {len(recs)}건 중 {hit}건 — 파서 오인 의심"
        note = f"{len(recs)}건 · 일치 {hit}"
    except Exception as e:
        prob, note = f"호출 실패 {type(e).__name__}: {str(e)[:60]}", "—"
    ms = int((time.time() - t0) * 1000)
    bad = bool(prob) and not prob.startswith("결과 0건")  # 0건은 health 담당 — 관련성 실패로 세지 않음
    fails += bad
    rows.append((src, q, note, ms, prob, bad))
    print(f"{'❌' if bad else ('⚠️' if prob else '✅')} {src:9} '{q}' {note} {ms}ms {prob}")
md = "## 관련성 감사\n\n| 수집처 | 질의 | 결과 | ms | 문제 |\n|---|---|---|---|---|\n" + "\n".join(f"| {'❌' if b else ('⚠️' if p else '✅')} {s} | {q} | {n} | {ms} | {p} |" for s, q, n, ms, p, b in rows)
md += f"\n\n실패 {fails}건 — 조치: 해당 수집기(route.js COLLECT·server.py _c_*)의 응답 원문을 열어 결과 영역을 읽는지 확인 → 양쪽 수정 → golden에 must/must_not 추가.\n"
if a.md:
    open(a.md, "w", encoding="utf-8").write(md)
print(f"\n실패 {fails}건 / {len(rows)}")
sys.exit(1 if fails else 0)
