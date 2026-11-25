#!/usr/bin/env python3
"""변환어 실측(v2.97) — 다국어 변환표(TOPICS)의 영문 변환어가 기관 색인에서 실제로 기록을 끌어오는지 스스로 잰다.

v2.94~2.96.2에서 '피란민'(미변환), 'Cheju uprising 1948'·'Geochang massacre'(기관 색인에 없는 학술 명칭 — 무관한 결과·0건)를
사람이 손으로 찾았다. 이 스크립트는 route.js의 TOPICS 변환어를 하나씩 NARA·IA에 던져 결과 수와 상위 제목,
상위 5건 제목에 변환어 핵심 낱말이 든 비율(관련 신호)을 docs/data/topics_probe.json에 날짜별로 쌓는다(지우지 않음).
'약함'(두 기관 모두 상위 5건에 핵심 낱말 0) 목록이 다음 교정 후보다 — 학술 명칭이 아니라 기관이 실제 쓴 표기로 바꾼다.

사용: python3 scripts/topics_probe.py [--url URL] [--limit N] [--md 요약.md]
종료 코드는 항상 0(관찰 기록 — 0건이 기관에 기록이 없다는 뜻일 수도 있으므로 장애로 보지 않는다). 표준 라이브러리만.
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="https://korea-archive-mcp.vercel.app/api/mcp")
ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--md", default="")
a = ap.parse_args()
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "X-KA-Probe": "topics"}  # 점검 질의 — 활용 집계와 분리(ka:qp)
GENERIC = {"korea", "korean", "koreans", "the", "of", "in", "and", "to", "a", "un", "us", "rok", "chosen", "japan", "japanese", "seoul", "pusan"}


def anchored(en):
    """v3.8.2 실제 검색 경로와 같은 질의로 — route.js toIndexLang은 변환 결과에 EN_ANCHOR(Korea 계열 낱말)가 없으면 앞에 'Korea '를 붙인다.
    이전 실측은 변환어를 그대로 던져 사용자 검색과 다른 질의를 쟀다('Ito Hirobumi' 실측 vs 실제 'Korea Ito Hirobumi')."""
    s = open(os.path.join(ROOT, "app", "api", "[transport]", "route.js"), encoding="utf-8").read()
    m = re.search(r"const EN_ANCHOR = /(.+?)/i;", s)
    return en if (m and re.search(m[1], en, re.I)) else f"Korea {en}"


def topics():
    s = open(os.path.join(ROOT, "app", "api", "[transport]", "route.js"), encoding="utf-8").read()
    i = s.index("const TOPICS = ["); j = s.index("];", i)
    out, seen = [], set()
    for m in re.finditer(r"\{ p: '((?:[^'\\]|\\.)*)', en: '([^']*)'", s[i:j]):
        en = m[2].strip()
        if en and en not in seen and re.search(r"[A-Za-z]{3}", en): seen.add(en); out.append((m[1], en))
    return out


def post(body, sid=None, t=90):
    h = dict(H, **({"Mcp-Session-Id": sid} if sid else {}))
    r = urllib.request.urlopen(urllib.request.Request(a.url, json.dumps(body).encode(), h), timeout=t)
    return r.headers.get("mcp-session-id"), r.read().decode("utf-8", "replace")


def call(sid, tool, args):
    _, t = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}}, sid)
    for ln in t.splitlines():
        if ln.startswith("data:"): t = ln[5:]; break
    j = json.loads(t)
    return "".join(c.get("text", "") for c in (j.get("result") or {}).get("content", []))


def measure(txt, en):
    total = int((re.search(r"total ([\d,]+)", txt) or [0, "0"])[1].replace(",", ""))
    rows = [l for l in txt.splitlines() if l.startswith("- ")][:5]
    titles = [re.sub(r"^- (\[NAID \d+\] |\S+ \| )", "", l).split(" | ")[0][:110] for l in rows]
    keys = [w for w in re.findall(r"[a-z][a-z\-]{2,}", en.lower()) if w not in GENERIC]
    hit = sum(1 for t in titles if any(k in t.lower() for k in keys)) if keys else len(titles)
    return {"total": total, "hit": hit, "of": len(titles), "top": titles[:3]}


def main():
    sid, _ = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "topics-probe", "version": "1"}}})
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    T = topics()[: a.limit or None]
    res = {}
    for n, (pat, en) in enumerate(T, 1):
        r = {"pattern": pat}
        q = anchored(en); r["query"] = q  # v3.8.2 실제로 던져지는 질의
        for tool, args in (("nara_search", {"query": q, "max_results": 5}), ("ia_search", {"query": q, "rows": 5})):
            try: r[tool.split("_")[0]] = measure(call(sid, tool, args), en)
            except Exception as ex: r[tool.split("_")[0]] = {"error": str(ex)[:80]}
            time.sleep(0.5)
        res[en] = r
        print(f"[{n}/{len(T)}] {en}: nara {r['nara'].get('hit', '?')}/{r['nara'].get('of', '?')} ({r['nara'].get('total', '?')}) · ia {r['ia'].get('hit', '?')}/{r['ia'].get('of', '?')} ({r['ia'].get('total', '?')})", flush=True)
    weak = sorted(en for en, r in res.items() if all(isinstance(r.get(k), dict) and "hit" in r[k] and r[k]["hit"] == 0 for k in ("nara", "ia")))
    day = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    p = os.path.join(ROOT, "docs", "data", "topics_probe.json")
    J = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"note": "다국어 변환어 기관 색인 실측 — 날짜별 축적, 지우지 않는다. hit = 상위 5건 제목에 변환어 핵심 낱말이 든 수", "runs": {}}
    J["runs"][day] = {"terms": len(res), "weak": weak, "results": res}
    J["latest"] = {"day": day, "terms": len(res), "weak": weak}
    json.dump(J, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    md = f"## 변환어 실측 {day}\n- 변환어 {len(res)}개 · 약함(두 기관 상위 5건에 핵심 낱말 0) {len(weak)}개\n" + "".join(f"- {w}\n" for w in weak) + "\n교정 원칙: 학술 명칭이 아니라 기관이 실제 쓴 표기로(MAINTAINING.md v2.96.1)."
    print(md)
    if a.md: open(a.md, "w", encoding="utf-8").write(md)


if __name__ == "__main__":
    main()
