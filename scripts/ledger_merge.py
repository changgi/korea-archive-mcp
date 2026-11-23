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
import base64, csv, datetime as dt, io, json, os, re, sys, time, urllib.parse, urllib.request, zlib, html

API = os.environ.get("LEDGER_API", "https://korea-archive-mcp.vercel.app/api/ledger/")
ORIGIN = "https://korea-archive-mcp.vercel.app"
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
UA = "KoreaArchiveMCP/1.0 (+https://github.com/changgi/korea-archive-mcp; ledger merge)"

def get(u):
    r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=30)
    return json.load(r)

def clean_url(u):  # v2.7.1: 원 기관 API가 &amp;로 내려준 링크(국가기록원)는 클릭 시 빈 페이지 — 해제·https 정규화(기존 원장도 소급)
    u = html.unescape(str(u or "")).strip()
    return re.sub(r"^http://www\.archives\.go\.kr", "https://www.archives.go.kr", u)

def iiif_for(u, i=""):  # Node iiifFor 패리티 — 원 기관 IIIF·우리 브리지 주소
    u = str(u or ""); O = ORIGIN
    rules = [(r"catalog\.archives\.gov/id/(\d+)", lambda m: f"{O}/iiif/nara/{m[1]}/manifest.json"),
             (r"discovery\.nationalarchives\.gov\.uk/details/r/([A-Za-z0-9]{2,20})", lambda m: f"{O}/iiif/tna/{m[1]}/manifest.json"),
             (r"much\.go\.kr/.*idnbr=([A-Z]{2}[\w-]+)", lambda m: f"{O}/iiif/much/{m[1]}/manifest.json"),
             (r"awm\.gov\.au/collection/(C\d+)", lambda m: f"{O}/iiif/awm/{m[1]}/manifest.json"),
             (r"commons\.wikimedia\.org/wiki/(File(?:%3A|:)[^?#]+)", lambda m: f"{O}/iiif/commons/{urllib.parse.quote(urllib.parse.unquote(m[1]).replace('_', ' '), safe='')}/manifest.json"),
             (r"korea-archive-mcp/iiif\.html#(s\d+)", lambda m: f"https://changgi.github.io/korea-archive-mcp/iiif/m/{m[1]}.json"),
             (r"archive\.org/details/([^/?#]+)", lambda m: f"https://iiif.archive.org/iiif/3/{m[1]}/manifest.json"),
             (r"europeana\.eu/(?:[a-z]{2}/)?item/([^/]+)/([^/?#]+)", lambda m: f"https://iiif.europeana.eu/presentation/{m[1]}/{m[2]}/manifest"),
             (r"dl\.ndl\.go\.jp/pid/(\d+)", lambda m: f"https://dl.ndl.go.jp/api/iiif/{m[1]}/manifest.json")]
    if "heritage.go.kr" in u and re.match(r"^\d{2}-[0-9A-Za-z]+-\d{2}$", str(i or "")):
        return f"{O}/iiif/heritage/{i}/manifest.json"
    for rx, f in rules:
        m = re.search(rx, u)
        if m: return f(m)
    return ""

L1 = lambda x: (x if isinstance(x, str) else (next(iter(x.values()), [""])[0] if isinstance(x, dict) and x and isinstance(next(iter(x.values())), list) else (x.get("@value", "") if isinstance(x, dict) else (L1(x[0]) if isinstance(x, list) and x else "")))) if x else ""
strip = lambda t: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(t or "")))).strip()
# 게재윤리 — 포로·사망자·묘지·수형자 관련은 썸네일을 싣지 않는다(링크만)
SENSITIVE = re.compile(r"\b(POWs?|prisoners?|captured|dead|bod(y|ies)|corpses?|graves?|cemetery|burial|execution|executed|massacre|mugshot|wounded)\b|포로|시신|사망|전사자|묘지|매장|처형|학살|수형|부상자", re.I)
OPEN_RIGHTS = re.compile(r"publicdomain|creativecommons\.org/licenses|rightsstatements\.org/vocab/(NoC|NKC)|Public Domain|Unrestricted|저작권 만료|이용 제한 없음|공공누리", re.I)

AR_KEEP = ["생산기관", "관리번호", "생산연도", "문서유형", "기록물형태", "매체유형", "보존기간", "공개구분", "서고정보", "페이지정보", "발간번호", "서비스권자", "기록물계열"]

def enrich_archives(o):
    """국가기록원 상세(공개 페이지) 1회 판독 — 매니페스트가 없는 기록의 메타정보·실제 계층(기록물계열 › 상위 철) 구축."""
    r = urllib.request.urlopen(urllib.request.Request(o["url"], headers={"User-Agent": UA}), timeout=25)
    s = r.read().decode("utf-8", "replace")
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", s, flags=re.S)
    i = s.find("제목</th>")
    if i < 0: raise ValueError("상세 표 없음")
    f = {}; titles = []
    for m in re.finditer(r"<th[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)</td>", s[i - 400:], re.S):
        k = strip(m[1]); v = strip(m[2])
        if "개인정보" in k: break
        if k.endswith("제목"): titles.append(v); continue
        if k in AR_KEEP and v and k not in f: f[k] = v.split("※")[0].strip()[:140]
    parent = titles[1] if len(titles) > 1 else ""
    if parent and strip(parent) == strip(titles[0] if titles else o.get("title", "")): parent = ""  # 간행물 등 철=건 동일 — 계층 아님
    md = [[k, f[k]] for k in AR_KEEP if f.get(k)]
    if parent: md.insert(0, ["상위 철", parent[:140]])
    o["meta"] = md[:10]
    ser = f.get("기록물계열", "")
    if ser or parent:  # 계층 구축(실제 값 — 상세 판독)
        o["partOf_src"] = o.get("partOf_src") or o.get("partOf", "")
        o["partOf"] = " › ".join(x for x in ["국가기록원", ser, parent] if x)
    bits = [f.get("생산연도"), f.get("생산기관") and f"{f['생산기관']} 생산", f.get("문서유형") and f"{f['문서유형']}" + (f"({f['기록물형태']})" if f.get("기록물형태") and f["기록물형태"] != f["문서유형"] else ""),
            parent and f"상위 철 「{parent}」", ser and f"기록물계열 {ser}", f.get("매체유형"), f.get("페이지정보") and (f"{f['페이지정보']}쪽" if f["페이지정보"].isdigit() else f"쪽 {f['페이지정보']}"),
            f.get("서고정보") and f"{f['서고정보']} 소장", f.get("공개구분")]
    o["summary"] = " · ".join(b for b in bits if b)[:400] + " (국가기록원 상세 판독 — 기술 메타데이터)"
    o["rights"] = f.get("서비스권자", "") and f"서비스권자 {f['서비스권자']} — 이용조건 원 기관 확인"

# v2.10: 매니페스트가 없는 국내외 기록 — 우리 서버의 검증된 심층 판독 도구(골든 검사 대상)를 그대로 호출(파서 중복 없음)
MCP = os.environ.get("LEDGER_MCP", f"{ORIGIN}/api/mcp")
DEEP = {"i815": ("nedb_search", lambda o: o.get("url") and {"mode": "i815", "query": o["url"]}),
        "indy": ("nedb_search", lambda o: o.get("url") and {"mode": "indy", "query": o["url"]}),
        "gonghun": ("nedb_search", lambda o: o.get("id") and {"mode": "gonghun", "query": o["id"]}),
        "jacar": ("nedb_search", lambda o: o.get("id") and {"mode": "jacar", "query": o["id"]}),
        "oldnews": ("nedb_search", lambda o: o.get("id") and {"mode": "oldnews", "query": o["id"]}),
        "un": ("nedb_search", lambda o: o.get("url") and {"mode": "un", "query": o["url"]}),
        "jsg": ("nedb_search", lambda o: o.get("id") and {"mode": "jsg", "query": o["id"]}),
        "ktv": ("nedb_search", lambda o: o.get("url") and {"mode": "ktv", "query": o["url"]}),
        "koreanwar": ("koreanwar_item", lambda o: o.get("id") and not str(o["id"]).startswith("book:") and {"ref_code": o["id"]}),
        "seoul": ("seoul_archives_search", lambda o: o.get("url") and {"query": o["url"]})}
_sid = [None]

def mcp_call(tool, args):
    H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": UA, "X-KA-Probe": "ledger"}  # 원장 보강 호출은 적재 안 함
    def post(body, sid=None):
        h = dict(H, **({"Mcp-Session-Id": sid} if sid else {}))
        r = urllib.request.urlopen(urllib.request.Request(MCP, data=json.dumps(body).encode(), headers=h, method="POST"), timeout=90)
        return r.headers.get("mcp-session-id"), r.read().decode("utf-8", "replace")
    if not _sid[0]:
        _sid[0], _ = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "ledger-merge", "version": "1"}}})
        post({"jsonrpc": "2.0", "method": "notifications/initialized"}, _sid[0])
    _, t = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}}, _sid[0])
    for ln in t.splitlines():
        if ln.startswith("data:"):
            j = json.loads(ln[5:]); break
    else:
        j = json.loads(t)
    if "error" in j: raise ValueError(str(j["error"])[:80])
    txt = "".join(c.get("text", "") for c in (j.get("result") or {}).get("content", []))
    if not txt or txt.startswith("MCP error") or (j.get("result") or {}).get("isError"): raise ValueError(txt[:80])
    return txt

def parse_deep(txt):
    """심층 판독 텍스트 → 주요 내용·메타정보·지문·원문 뷰어. 판독 결과에 있는 값만 옮긴다(재구성·추정 없음)."""
    L = [x.strip() for x in txt.splitlines()]
    body = []; grab = False
    for x in L:
        if x.startswith("【"): grab = True; continue
        if grab:
            if not x or x.startswith(("※", "본문 지문", "원문", "판결문 원문", "관련기사", "[")) : break
            body.append(x)
    meta = []
    for x in L[:8]:
        if x.startswith(("※", "[")): continue
        for part in re.split(r" · | \| ", x):
            mm = re.match(r"^([^:：]{1,14})[:：]\s*(.+)$", part.strip().lstrip("·- ").strip())
            if mm and not mm[2].startswith("//") and "→" not in part and len(meta) < 8: meta.append([mm[1].strip(), mm[2].strip()[:140]])
    for x in L:
        mm = re.search(r"지문\(sha256-16\):\s*([0-9a-f]{16})", x)
        if mm: meta.append(["본문 지문(sha256-16)", mm[1]])
        mm = re.search(r"뷰어[^:：]*[:：]\s*(https?://\S+)", x)
        if mm and len(meta) < 11: meta.append(["원문 뷰어", mm[1]])
    head = [x for x in L[1:4] if x and not x.startswith(("※", "[", "【")) and "→" not in x and not x.endswith((":", "："))]
    summ = " ".join(body) if body else " · ".join(head)
    summ = re.sub(r"(\s*·\s*){2,}", " · ", summ).strip(" ·")
    seen_v = set(); md = []
    for k, v in meta:  # 같은 값(뷰어 링크 등) 중복 제거
        if v in seen_v: continue
        seen_v.add(v); md.append([k, v])
    return summ[:400], md[:11]

def enrich(o, budget):
    """IIIF 매니페스트 1회 판독 → 주요 내용(summary)·메타정보·썸네일·권리. 실패는 다음 날 재시도. 반환: 사용한 요청 수."""
    m = o.get("iiif") or iiif_for(o.get("url"), o.get("id"))
    if m: o["iiif"] = m
    today = dt.date.today().isoformat()
    src0 = o["key"].split(":")[0]
    done = o.get("enrich_status") == "ok" or (o.get("enrich_status") == "fail" and o.get("enriched", "") > (dt.date.today() - dt.timedelta(days=1)).isoformat())
    if not m and src0 == "archives" and o.get("url") and budget > 0 and not done:
        try: enrich_archives(o); o["enrich_status"] = "ok"
        except Exception: o["enrich_status"] = "fail"
        o["enriched"] = today; o["thumb_ok"] = False
        return 1
    if not m and src0 in DEEP and budget > 0 and not done:
        tool, af = DEEP[src0]; args = af(o)
        if args:
            try:
                txt = mcp_call(tool, args); summ, md = parse_deep(txt)
                o["summary"] = (summ + " " if summ else "") + f"(KOREA ARCHIVE 심층 판독 {tool})"
                o["meta"] = md; o["deep_call"] = f"{tool}({json.dumps(args, ensure_ascii=False)})"; o["enrich_status"] = "ok"
            except Exception:
                o["enrich_status"] = "fail"
            o["enriched"] = today; o["thumb_ok"] = False
            return 1
    if o.get("enriched") and (o.get("enrich_status") != "fail" or o["enriched"] > (dt.date.today() - dt.timedelta(days=1)).isoformat()):
        th = o.get("thumb") or ""  # 이미 보강된 기록도 썸네일 게재 규칙은 매번 다시 적용(규칙 변경 소급)
        o["thumb_ok"] = bool(th) and not re.search(r"card\.svg|image/svg", th) and not SENSITIVE.search(f"{o.get('title', '')} {o.get('summary', '')}") and (
            o["key"].split(":")[0] in ("nara", "gallery") or bool(OPEN_RIGHTS.search(o.get("rights") or "")))
        return 0
    if m and budget <= 0:
        return 0  # 오늘 상한 소진 — 다음 실행에서 보강
    used = 0; o["enrich_status"] = "none"
    if m and budget > 0:
        used = 1
        try:
            j = get(m)
            o["summary"] = strip(L1(j.get("summary")) or L1(j.get("description")))[:400]
            md = []
            for e in (j.get("metadata") or [])[:12]:
                k, v = strip(L1(e.get("label"))), strip(L1(e.get("value")))
                if k and v and k not in ("판독 시각", "변환", "발견 시각", "발견 경로") and len(md) < 8: md.append([k[:30], v[:140]])
            o["meta"] = md
            rs = j.get("rights") or strip(L1((j.get("requiredStatement") or {}).get("value"))) or strip(L1(j.get("attribution"))) or strip(L1(j.get("license")))
            o["rights"] = str(rs)[:200]
            th = j.get("thumbnail"); th = (th[0] if isinstance(th, list) and th else th) or {}
            tu = th.get("id") or th.get("@id") if isinstance(th, dict) else (th if isinstance(th, str) else "")
            if not tu:
                try:
                    if j.get("items"):
                        b = j["items"][0]["items"][0]["items"][0]["body"]
                    else:
                        b = j["sequences"][0]["canvases"][0]["images"][0]["resource"]
                    svc = b.get("service"); svc = (svc[0] if isinstance(svc, list) and svc else svc) or {}
                    sid = svc.get("id") or svc.get("@id") if isinstance(svc, dict) else ""
                    tu = f"{sid.rstrip('/')}/full/240,/0/default.jpg" if sid else (b.get("id") or b.get("@id") or "")
                except Exception:
                    tu = ""
            o["thumb"] = tu
            o["enrich_status"] = "ok"
        except Exception:
            o["enrich_status"] = "fail"
    if not o.get("thumb") and re.search(r"\.(jpe?g|png|gif)(\?|$)|thumb|image", o.get("media") or "", re.I):
        o["thumb"] = o["media"]
    src = o["key"].split(":")[0]; th = o.get("thumb") or ""
    o["thumb_ok"] = bool(th) and not re.search(r"card\.svg|image/svg", th) and not SENSITIVE.search(f"{o.get('title', '')} {o.get('summary', '')}") and (
        src in ("nara", "gallery") or bool(OPEN_RIGHTS.search(o.get("rights") or "")))
    o["enriched"] = today
    return used

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
                for f in ("url", "media", "sameAs", "iiif"):
                    if o.get(f): o[f] = clean_url(o[f])
                for f in ("title", "partOf"):
                    if o.get(f): o[f] = html.unescape(o[f])
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
                    for f in ("u", "m", "sa", "x"):
                        if r.get(f): r[f] = clean_url(r[f])
                    for f in ("t", "p"):
                        if r.get(f): r[f] = html.unescape(r[f])
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
    budget = int(os.environ.get("ENRICH_MAX", "80"))  # 하루 매니페스트 판독 상한(기관 서버 예의 — 순차·간격)
    for o in sorted(led.values(), key=lambda o: o.get("last_seen", ""), reverse=True):
        n_ = enrich(o, budget); budget -= n_
        if n_: time.sleep(0.6)
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
    cols = ["key", "sources", "title", "date", "id", "url", "partOf", "media", "sameAs", "iiif", "first_seen", "last_seen", "seen", "seen_7d", "seen_30d", "days_total", "formats", "tools", "max_cross", "trend", "rank", "score", "summary", "rights", "thumb", "meta"]
    fmtv = lambda v: " | ".join(f"{a}: {b}" for a, b in v) if isinstance(v, list) and v and isinstance(v[0], list) else (" ".join(f"{k}:{n}" for k, n in sorted(v.items(), key=lambda kv: -kv[1])) if isinstance(v, dict) else ("+".join(v) if isinstance(v, list) else v))
    with open(os.path.join(D, "discovered.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); w.writerow(cols)
        for o in recs: w.writerow([fmtv(o.get(c, "")) for c in cols])
    pop = sorted(recs, key=lambda o: o["rank"])
    with open(os.path.join(D, "popular.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); pc = ["rank", "score", "seen", "seen_7d", "seen_30d", "days_total", "trend", "formats", "sources", "title", "date", "id", "partOf", "summary", "url", "iiif", "first_seen", "last_seen"]; w.writerow(pc)
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
                      **({"owl:sameAs": o["sameAs"]} if o.get("sameAs") else {}), **({"rico:scopeAndContent": o["summary"]} if o.get("summary") else {}),
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
    KV = "https://changgi.github.io/korea-archive-mcp/kv.html?manifest="
    def card(o, big=True):
        th = (f"<img loading='lazy' src='{E_(o['thumb'])}' alt='' referrerpolicy='no-referrer' onerror=\"this.replaceWith(Object.assign(document.createElement('div'),{{className:'ph',textContent:'{E_(o['key'].split(':')[0])}'}}))\">"
              if o.get("thumb_ok") else f"<div class='ph'>{E_(o['key'].split(':')[0])}<small>{'원본 이미지 없음(기록 카드)' if ('card.svg' in (o.get('thumb') or '')) else ('이미지 링크만(권리·게재윤리)' if o.get('thumb') else '이미지 없음')}</small></div>")
        chips = "".join(f"<span>{E_(x)}</span>" for x in [o.get("date"), o.get("id"), o.get("partOf")] if x)
        md = "".join(f"<dt>{E_(k)}</dt><dd>{E_(v)}</dd>" for k, v in (o.get("meta") or []))
        links = f"<a href='{E_(o.get('url') or '#')}'>원 기관</a>" + (f" · <a href='{KV}{E_(o['iiif'])}'>KV로 보기</a> · <a href='{E_(o['iiif'])}'>IIIF</a>" if o.get("iiif") else "")
        use = f"발견 {o['seen']}회 · 7일 {o['seen_7d']} · 30일 {o['seen_30d']} · {o.get('days_total', 1)}일 · {E_(o['trend'])} · 활용 {o['rank']}위 · 형식 {E_(fmtv(o.get('formats', {})))}"
        return (f"<article class='c'>{th}<div class='b'><div class='s'>{E_('+'.join(o['sources']))}</div><h3><a href='{E_(o.get('url') or '#')}'>{E_(o['title'][:140])}</a></h3>"
                f"<div class='ch'>{chips}</div>" + (f"<p class='sm'>{E_(o['summary'][:260])}</p>" if o.get("summary") and big else "")
                + (f"<details><summary>메타정보 {len(o.get('meta') or [])}항목{' · 권리 ' + E_(o['rights'][:60]) if o.get('rights') else ''}</summary><dl>{md}</dl></details>" if md or o.get("rights") else "")
                + f"<div class='u'>{use}</div><div class='l'>{links}</div></div></article>")
    prow = "".join(card(o) for o in pop[:30])
    rows = "".join(card(o, False) for o in recent[:100])
    urow = "".join(f"<tr><td>{k}</td><td>{v['batches']}</td><td>{v['records']}</td><td>{v['new']}</td></tr>" for k, v in sorted(usage['daily'].items(), reverse=True)[:14])
    srcs = " · ".join(f"{E_(k)} {v}" for k, v in st["by_source"].items())
    enr = sum(1 for o in recs if o.get("enrich_status") == "ok"); thn = sum(1 for o in recs if o.get("thumb_ok"))
    open(os.path.join(D, "index.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>발견 누적 원장 — KOREA ARCHIVE 통합검색</title><style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:1100px;margin:auto;padding:16px}}a{{color:#e0b04a}}
.b0{{display:inline-block;margin:4px 8px 4px 0;padding:6px 12px;border:1px solid #e0b04a;border-radius:6px;text-decoration:none}}
.g{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}}.c{{background:#1c1f26;border:1px solid #2a2d35;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}}
.c img,.ph{{width:100%;height:170px;object-fit:cover;background:#0f1115}}.ph{{height:64px!important;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#6f6e68;font-weight:700;letter-spacing:.05em}}.ph small{{font-weight:400;font-size:12px;margin-top:4px}}
.b{{padding:10px 12px;display:flex;flex-direction:column;gap:6px}}.s{{font-size:12px;color:#9b9a93}}h3{{font-size:15px;margin:0;line-height:1.35}}h3 a{{text-decoration:none}}
.ch span{{display:inline-block;font-size:12px;background:#2a2d35;border-radius:4px;padding:2px 6px;margin:0 4px 4px 0;word-break:break-all}}.sm{{font-size:13px;margin:0;color:#cfcdc5;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}}
details{{font-size:12px}}dl{{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;margin:6px 0}}dt{{color:#e0b04a}}dd{{margin:0;word-break:break-all}}.u{{font-size:12px;color:#9b9a93}}.l{{font-size:13px}}
table{{width:100%;border-collapse:collapse;font-size:14px}}td,th{{border-bottom:1px solid #2a2d35;padding:6px;text-align:left}}</style>
<main><h1>발견 누적 원장</h1><p>KOREA ARCHIVE 통합검색 사용자가 도구로 발굴한 기록이 매일 이곳에 쌓입니다(검색어·사용자 정보 없음). 기록 <b>{st['records']:,}</b>건 · 마지막 갱신 {st['updated']} · 이번 갱신 신규 {new_recs}건 · 내용·메타정보 보강 {enr}건 · 썸네일 {thn}건</p>
<p>{srcs}</p>
<p><a class="b0" href="discovered.csv">CSV 내려받기</a><a class="b0" href="discovered.jsonl">JSONL</a><a class="b0" href="discovered.jsonld">RiC-O JSON-LD</a><a class="b0" href="../kv.html?manifest=https://changgi.github.io/korea-archive-mcp/data/collection.json">KV로 최근 300건 연속 보기</a><a class="b0" href="popular.csv">자주 활용 TOP 200</a><a class="b0" href="stats.json">집계</a></p>
<p style="font-size:13px;color:#9b9a93">주요 내용·메타정보·썸네일은 기관 IIIF·우리 브리지 매니페스트를 하루 한 번 판독해 채웁니다(하루 상한·순차 요청). 썸네일은 재이용 가능 표시가 확인된 것만 싣고, 포로·사망자·묘지·수형자 관련 기록과 허가가 필요한 이미지는 링크만 둡니다. 권리는 원 기관 표기를 따릅니다 — 게재 전 judge_rights로 확인. 모든 변경은 저장소 git 이력(docs/data/)에 남습니다.</p>
<h2>자주 활용되는 기록 TOP 30</h2><p style="font-size:13px">점수 = 최근 30일 발견×2 + 전체 발견 + 발견된 날 수×3 + 교차확인 기관 수 가중. 자동 검사 트래픽 제외.</p><div class="g">{prow}</div>
<h2>일별 활용(최근 14일)</h2><table><tr><th>날짜</th><th>검색 묶음</th><th>발견 기록</th><th>신규 기록</th></tr>{urow}</table><p style="font-size:13px">형식별 누계: {E_(fmtv(usage['formats']))} · <a href="usage.json">usage.json</a></p>
<h2>최근 발견 100건</h2><div class="g">{rows}</div></main></html>""")
    print(f"원장 {len(recs)}건 (신규 {new_recs}, 묶음 {new_batches})")

if __name__ == "__main__":
    main()
