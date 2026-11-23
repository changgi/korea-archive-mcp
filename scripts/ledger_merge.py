#!/usr/bin/env python3
"""발견 누적 원장 병합(v2.5) — 매일 GitHub Actions가 실행.
서버 공개 읽기(/api/ledger/{날짜})에서 최근 3일 날짜 함을 이어 받아(처리 위치는 _state.json) 중복 제거·병합한다.
산출(docs/data/, GitHub Pages 공개):
  discovered.jsonl  원장 본체(기록 1줄) — key·출처·제목·연대·식별자·URL·계열·매체·sameAs·처음/마지막 발견·발견 횟수
  discovered.csv    스프레드시트용(엑셀 BOM)
  discovered.jsonld RiC-O(Record·RecordSet 계열·PROV 첫 발견)
  collection.json   IIIF 컬렉션 — 최근 발견 300건(기관 IIIF가 있으면 그 매니페스트, 없으면 기록 봉투) → KV로 연속 열람
  popular.csv       자주 활용되는 기록 TOP 200(순위·전체/7일/30일 발견·발견 일수·활용 형식·추세)
  usage.json        일별 활용 추이(검색 묶음·발견 기록·신규) · 형식별 누계
  stats.json · index.html  집계·내려받기 페이지
중복 처리 = 같은 기록이 다시 발견되면 새 줄 대신 활용 컬럼을 갱신(seen·days·formats·tools·max_cross).
검색어·사용자 정보는 원장에 없다(서버가 애초에 적재하지 않음). 증거성 = 이 파일들의 git 커밋 이력."""
import base64, csv, datetime as dt, io, json, os, sys, urllib.request, zlib, html

API = os.environ.get("LEDGER_API", "https://korea-archive-mcp.vercel.app/api/ledger/")
ORIGIN = "https://korea-archive-mcp.vercel.app"
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
UA = "KoreaArchiveMCP/1.0 (+https://github.com/changgi/korea-archive-mcp; ledger merge)"

def get(u):
    r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=30)
    return json.load(r)

def key_of(r):
    h = (r.get("s") or ["?"])[0].split("·")[0]
    return f"{h}:{r.get('i') or r.get('u') or r.get('t', '')[:80]}"

def tok(env):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return base64.urlsafe_b64encode(c.compress(json.dumps(env, ensure_ascii=False, separators=(",", ":")).encode()) + c.flush()).decode().rstrip("=")

def main():
    os.makedirs(D, exist_ok=True)
    sp = os.path.join(D, "_state.json"); state = json.load(open(sp)) if os.path.exists(sp) else {"days": {}}
    lp = os.path.join(D, "discovered.jsonl")
    led = {}
    if os.path.exists(lp):
        for ln in open(lp, encoding="utf-8"):
            if ln.strip():
                o = json.loads(ln)
                o.setdefault("days", {o.get("first_seen", "")[:10]: o.get("seen", 1)}); o.setdefault("days_total", len(o["days"]))
                o.setdefault("formats", {}); o.setdefault("max_cross", len(o.get("sources") or []))
                led[o["key"]] = o
    today = dt.datetime.now(dt.timezone.utc).date()
    new_batches = new_recs = 0
    up = os.path.join(D, "usage.json"); usage = json.load(open(up)) if os.path.exists(up) else {"daily": {}, "formats": {}}
    for back in (2, 1, 0):
        d = (today - dt.timedelta(days=back)).isoformat(); pos = state["days"].get(d, 0)
        while True:
            try: j = get(f"{API}{d}?start={pos}&n=500")
            except Exception as e: print(f"{d}: 읽기 실패 {e}"); break
            items = j.get("items") or []
            for b in items:
                at = b.get("at") or d; fmt = b.get("f") or "text"; dd = at[:10]
                u = usage["daily"].setdefault(dd, {"batches": 0, "records": 0, "new": 0}); u["batches"] += 1
                usage["formats"][fmt] = usage["formats"].get(fmt, 0) + 1
                for r in b.get("rec") or []:
                    u["records"] += 1
                    k = key_of(r); o = led.get(k)
                    if not o:
                        o = led[k] = {"key": k, "sources": [], "title": r.get("t", ""), "date": r.get("d", ""), "id": r.get("i", ""), "url": r.get("u", ""),
                                      "partOf": r.get("p", ""), "media": r.get("m", ""), "sameAs": r.get("sa", ""), "first_seen": at, "last_seen": at, "seen": 0, "tools": []}
                        new_recs += 1; u["new"] += 1
                    for s in r.get("s") or []:
                        if s not in o["sources"]: o["sources"].append(s)
                    for f in ("partOf", "media", "sameAs", "date", "url"):
                        src = {"partOf": "p", "media": "m", "sameAs": "sa", "date": "d", "url": "u"}[f]
                        if not o.get(f) and r.get(src): o[f] = r[src]
                    if r.get("x"): o["iiif"] = r["x"]
                    o["seen"] += 1; o["last_seen"] = max(o["last_seen"], at); o["first_seen"] = min(o["first_seen"], at)
                    o.setdefault("days", {}); o.setdefault("formats", {})
                    if dd not in o["days"]: o["days_total"] = o.get("days_total", 0) + 1
                    o["days"][dd] = o["days"].get(dd, 0) + 1
                    o["formats"][fmt] = o["formats"].get(fmt, 0) + 1
                    o["max_cross"] = max(o.get("max_cross", 0), len(r.get("s") or []))
                    t = b.get("tool") or "cross_search"
                    if t not in o["tools"]: o["tools"].append(t)
            pos += len(items); new_batches += len(items)
            if len(items) < 500: break
        state["days"][d] = pos
    keep = (today - dt.timedelta(days=10)).isoformat()
    state["days"] = {k: v for k, v in state["days"].items() if k >= keep}
    def win(o, a, b):  # a~b일 전 사이 발견 횟수
        return sum(n for k, n in o["days"].items() if (today - dt.timedelta(days=b)).isoformat() < k <= (today - dt.timedelta(days=a)).isoformat())
    cut = (today - dt.timedelta(days=90)).isoformat()
    for o in led.values():
        o["days"] = {k: v for k, v in sorted(o["days"].items()) if k > cut}  # 날짜별 이력 90일 보관(누계는 seen·days_total)
        o["seen_7d"] = win(o, -1, 7); o["seen_30d"] = win(o, -1, 30); prev = win(o, 7, 14)
        o["trend"] = "신규" if o["first_seen"][:10] > (today - dt.timedelta(days=7)).isoformat() else ("↑" if o["seen_7d"] > prev else ("↓" if o["seen_7d"] < prev else "→"))
        o["score"] = round(o["seen_30d"] * 2 + o["seen"] + o.get("days_total", 1) * 3 + (o.get("max_cross", 1) - 1) * 2, 1)  # 최근 활용·지속 활용(일수)·교차확인 가중
    for i, o in enumerate(sorted(led.values(), key=lambda o: (-o["score"], o["key"])), 1): o["rank"] = i
    recs = sorted(led.values(), key=lambda o: (o["first_seen"], o["key"]))
    with open(lp, "w", encoding="utf-8") as f:
        for o in recs: f.write(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n")
    cols = ["key", "sources", "title", "date", "id", "url", "partOf", "media", "sameAs", "iiif", "first_seen", "last_seen", "seen", "seen_7d", "seen_30d", "days_total", "formats", "tools", "max_cross", "trend", "rank", "score"]
    fmtv = lambda v: " ".join(f"{k}:{n}" for k, n in sorted(v.items(), key=lambda kv: -kv[1])) if isinstance(v, dict) else ("+".join(v) if isinstance(v, list) else v)
    with open(os.path.join(D, "discovered.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); w.writerow(cols)
        for o in recs: w.writerow([fmtv(o.get(c, "")) for c in cols])
    pop = sorted(recs, key=lambda o: o["rank"])
    with open(os.path.join(D, "popular.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); pc = ["rank", "score", "seen", "seen_7d", "seen_30d", "days_total", "trend", "formats", "sources", "title", "date", "id", "partOf", "url", "first_seen", "last_seen"]; w.writerow(pc)
        for o in pop[:200]: w.writerow([fmtv(o.get(c, "")) for c in pc])
    keepu = (today - dt.timedelta(days=400)).isoformat()
    usage["daily"] = {k: v for k, v in sorted(usage["daily"].items()) if k > keepu}
    json.dump(usage, open(up, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    sets = {}
    graph = []
    for o in recs:
        inst = o["key"].split(":")[0]; ser = o.get("partOf") or "(계열 미상)"
        sid = f"set:{inst}:{ser}"; sets.setdefault(sid, {"@id": sid, "@type": "rico:RecordSet", "rico:title": ser, "rico:isOrWasIncludedIn": {"@id": f"inst:{inst}"}})
        graph.append({"@id": o.get("url") or f"rec:{o['key']}", "@type": "rico:Record", "rico:title": o["title"], **({"rico:identifier": o["id"]} if o.get("id") else {}),
                      **({"rico:isAssociatedWithDate": o["date"]} if o.get("date") else {}), "rico:isOrWasIncludedIn": {"@id": sid},
                      **({"owl:sameAs": o["sameAs"]} if o.get("sameAs") else {}),
                      "prov:wasGeneratedBy": {"@type": "prov:Activity", "prov:label": "KOREA ARCHIVE 통합검색 발견(검색어 비공개)", "prov:startedAtTime": o["first_seen"], "prov:used": o["sources"]}})
    json.dump({"@context": {"rico": "https://www.ica.org/standards/RiC/ontology#", "prov": "http://www.w3.org/ns/prov#", "owl": "http://www.w3.org/2002/07/owl#"},
               "@graph": list(sets.values()) + graph}, open(os.path.join(D, "discovered.jsonld"), "w", encoding="utf-8"), ensure_ascii=False)
    recent = sorted(recs, key=lambda o: o["last_seen"], reverse=True)[:300]
    items = []
    for o in recent:
        lab = {"none": [f"{o['title'][:120]}{' (' + o['date'] + ')' if o.get('date') else ''}"]}
        if o.get("iiif"): items.append({"id": o["iiif"], "type": "Manifest", "label": lab}); continue
        env = {"s": o["sources"], "t": o["title"][:160], "d": o.get("date", ""), "i": o.get("id", ""), "u": o.get("url", ""), "p": o.get("partOf", ""),
               "n": o["key"].split(":")[0], "m": o.get("media", ""), "q": "발견 누적 원장", "at": o["first_seen"][:19]}
        items.append({"id": f"{ORIGIN}/iiif/rec/{tok(env)}/manifest.json", "type": "Manifest", "label": lab})
    json.dump({"@context": "http://iiif.io/api/presentation/3/context.json", "id": "https://changgi.github.io/korea-archive-mcp/data/collection.json", "type": "Collection",
               "label": {"ko": ["KOREA ARCHIVE 통합검색 — 발견 누적 원장 최근 300건"]}, "items": items},
              open(os.path.join(D, "collection.json"), "w", encoding="utf-8"), ensure_ascii=False)
    by = {}
    for o in recs:
        h = o["key"].split(":")[0]; by[h] = by.get(h, 0) + 1
    st = {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "records": len(recs), "new_records": new_recs, "new_batches": new_batches,
          "by_source": dict(sorted(by.items(), key=lambda kv: -kv[1])), "first": recs[0]["first_seen"] if recs else "",
          "formats": usage["formats"], "repeat_records": sum(1 for o in recs if o["seen"] > 1),
          "top10": [{"rank": o["rank"], "seen": o["seen"], "days": o.get("days_total", 1), "title": o["title"][:100], "url": o.get("url", "")} for o in pop[:10]]}
    json.dump(st, open(os.path.join(D, "stats.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(state, open(sp, "w"), indent=1)
    E_ = html.escape
    rows = "".join(f"<tr><td>{E_(o['first_seen'][:10])}</td><td>{E_('+'.join(o['sources']))}</td><td><a href='{E_(o.get('url') or '#')}'>{E_(o['title'][:110])}</a></td><td>{E_(o.get('date',''))}</td><td>{E_(o.get('partOf',''))}</td><td>{o['seen']}</td></tr>" for o in recent[:100])
    prow = "".join(f"<tr><td>{o['rank']}</td><td>{E_('+'.join(o['sources']))}</td><td><a href='{E_(o.get('url') or '#')}'>{E_(o['title'][:100])}</a></td><td>{o['seen']}</td><td>{o['seen_7d']}</td><td>{o['seen_30d']}</td><td>{o.get('days_total', 1)}</td><td>{E_(fmtv(o.get('formats', {})))}</td><td>{E_(o['trend'])}</td></tr>" for o in pop[:30])
    urow = "".join(f"<tr><td>{k}</td><td>{v['batches']}</td><td>{v['records']}</td><td>{v['new']}</td></tr>" for k, v in sorted(usage['daily'].items(), reverse=True)[:14])
    srcs = " · ".join(f"{E_(k)} {v}" for k, v in st["by_source"].items())
    open(os.path.join(D, "index.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>발견 누적 원장 — KOREA ARCHIVE 통합검색</title><style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:1100px;margin:auto;padding:20px}}a{{color:#e0b04a}}table{{width:100%;border-collapse:collapse;font-size:14px}}td,th{{border-bottom:1px solid #2a2d35;padding:6px;text-align:left;vertical-align:top}}.b{{display:inline-block;margin:4px 8px 4px 0;padding:6px 12px;border:1px solid #e0b04a;border-radius:6px}}.wrap{{overflow-x:auto}}</style>
<main><h1>발견 누적 원장</h1><p>KOREA ARCHIVE 통합검색 사용자가 도구로 발굴한 기록이 매일 이곳에 쌓입니다(검색어·사용자 정보 없음). 기록 <b>{st['records']:,}</b>건 · 마지막 갱신 {st['updated']} · 이번 갱신 신규 {new_recs}건</p>
<p>{srcs}</p>
<p><a class="b" href="discovered.csv">CSV 내려받기</a><a class="b" href="discovered.jsonl">JSONL</a><a class="b" href="discovered.jsonld">RiC-O JSON-LD</a><a class="b" href="../kv.html?manifest=https://changgi.github.io/korea-archive-mcp/data/collection.json">KV로 최근 300건 연속 보기</a><a class="b" href="popular.csv">자주 활용 TOP 200</a><a class="b" href="stats.json">집계</a></p>
<p>증거성: 이 원장의 모든 변경은 저장소 git 이력(docs/data/)에 날짜별로 남습니다. 권리는 원 기관 표기를 따릅니다 — 게재 전 judge_rights로 확인.</p>
<h2>자주 활용되는 기록 TOP 30</h2><p>점수 = 최근 30일 발견×2 + 전체 발견 + 발견된 날 수×3 + 교차확인 기관 수 가중. 자동 검사(골든·헬스) 트래픽은 제외. 전체 순위 <a href="popular.csv">popular.csv</a>(200위).</p>
<div class="wrap"><table><tr><th>순위</th><th>출처</th><th>기록</th><th>발견</th><th>7일</th><th>30일</th><th>발견 일수</th><th>활용 형식</th><th>추세</th></tr>{prow}</table></div>
<h2>일별 활용(최근 14일)</h2><div class="wrap"><table><tr><th>날짜</th><th>검색 묶음</th><th>발견 기록</th><th>신규 기록</th></tr>{urow}</table></div><p>형식별 누계: {E_(fmtv(usage['formats']))} · <a href="usage.json">usage.json</a></p>
<h2>최근 발견 100건</h2><div class="wrap"><table><tr><th>처음 발견</th><th>출처</th><th>기록</th><th>연대</th><th>계열</th><th>발견 횟수</th></tr>{rows}</table></div></main></html>""")
    print(f"원장 {len(recs)}건 (신규 {new_recs}, 묶음 {new_batches})")

if __name__ == "__main__":
    main()
