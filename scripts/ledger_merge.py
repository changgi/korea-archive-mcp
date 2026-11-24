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
             (r"portal\.nrich\.go\.kr/kor/(overseasSearchView|ksmUsrView|portraitNdUsrView|buddhaNdUsrView)\.do\S*?(?:mseq|ksm_idx|portrait_idx|buddha_idx)=(\d+)",
              lambda m: f"{O}/iiif/nrich/{ {'overseasSearchView': 'ov', 'ksmUsrView': 'ksm', 'portraitNdUsrView': 'portrait', 'buddhaNdUsrView': 'gwaebul'}[m[1]] }-{m[2]}/manifest.json"),
             (r"commons\.wikimedia\.org/wiki/(File(?:%3A|:)[^?#]+)", lambda m: f"{O}/iiif/commons/{urllib.parse.quote(urllib.parse.unquote(m[1]).replace('_', ' '), safe='')}/manifest.json"),
             (r"korea-archive-mcp/iiif\.html#(s\d+)", lambda m: f"https://changgi.github.io/korea-archive-mcp/iiif/m/{m[1]}.json"),
             (r"archive\.org/details/([^/?#]+)", lambda m: f"https://iiif.archive.org/iiif/3/{m[1]}/manifest.json"),
             (r"europeana\.eu/(?:[a-z]{2}/)?item/([^/]+)/([^/?#]+)", lambda m: f"https://iiif.europeana.eu/presentation/{m[1]}/{m[2]}/manifest"),
             (r"dl\.ndl\.go\.jp/pid/(\d+)", lambda m: f"https://dl.ndl.go.jp/api/iiif/{m[1]}/manifest.json")]
    mi = re.match(r"^(ksm|portrait|gwaebul|diary|mokgan|jcphoto|arch|design|pattern|oldbook|hyanggyo|stone|gaesong|assay):(\d+)$", str(i or ""))
    if mi: return f"{O}/iiif/nrich/{mi.group(1)}-{mi.group(2)}/manifest.json"  # v2.18 연구DB 이미지 데이터셋
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
NO_DERIV = re.compile(r"변경금지|제\s*[34]\s*유형|NoDerivs|\bND\b", re.I)  # 변경금지(공공누리 3·4유형·CC ND) — 카드 자르기·축소 게재는 원형 변경이므로 썸네일 대신 링크
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
        "seoul": ("seoul_archives_search", lambda o: o.get("url") and {"query": o["url"]}),
        "earchive": ("nedb_search", lambda o: "catalogView.do?systemId=" in (o.get("url") or "") and {"mode": "earchive", "query": o["url"]}),
        "okchf": ("nedb_search", lambda o: o.get("url") and {"mode": "okchf", "query": o["url"]}),
        "nrich": ("nedb_search", lambda o: {"mode": "nrich", "query": o["id"] if re.match(r"^(ksm|portrait|gwaebul|diary|mokgan|jcbib|jcphoto|dict|arch|koguryo|gaesong|design|pattern|oldbook|hyanggyo|stone|journal|iron|dolmen|assay|material):", str(o.get("id", ""))) else o.get("url")} if (o.get("id") or o.get("url")) else None)}
DEEP_V = {"seoul": 2}  # v2.32 판독기 판 — 판이 오르면 이미 보강된 기록도 한 번 다시 판독(서울기록원: 기관 계층·생산자·보존이력 추가)
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
    if src0 in DEEP_V and o.get("enrich_status") == "ok" and o.get("deep_v", 1) < DEEP_V[src0]: done = False  # 판독기 개선분 소급
    if not m and src0 in DEEP and budget > 0 and not done:
        tool, af = DEEP[src0]; args = af(o)
        if args:
            try:
                txt = mcp_call(tool, args); summ, md = parse_deep(txt)
                o["summary"] = (summ + " " if summ else "") + f"(KOREA ARCHIVE 심층 판독 {tool})"
                o["meta"] = md; o["deep_call"] = f"{tool}({json.dumps(args, ensure_ascii=False)})"; o["enrich_status"] = "ok"; o["deep_v"] = DEEP_V.get(src0, 1)
                hv = next((v for k, v in md if k == "계층"), "")
                if hv and not o.get("partOf"): o["partOf"] = hv; o["partOf_src"] = "기관 상세 판독(브레드크럼)"  # 원 기관 계층 — [파생] 아님
            except Exception:
                o["enrich_status"] = "fail"
            o["enriched"] = today; o["thumb_ok"] = False
            return 1
    if o.get("enriched") and (o.get("enrich_status") != "fail" or o["enriched"] > (dt.date.today() - dt.timedelta(days=1)).isoformat()):
        th = o.get("thumb") or ""  # 이미 보강된 기록도 썸네일 게재 규칙은 매번 다시 적용(규칙 변경 소급)
        o["thumb_ok"] = bool(th) and not re.search(r"card\.svg|image/svg", th) and not SENSITIVE.search(f"{o.get('title', '')} {o.get('summary', '')}") and (
            o["key"].split(":")[0] in ("nara", "gallery") or (bool(OPEN_RIGHTS.search(o.get("rights") or "")) and not NO_DERIV.search(o.get("rights") or "")))
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
        src in ("nara", "gallery") or (bool(OPEN_RIGHTS.search(o.get("rights") or "")) and not NO_DERIV.search(o.get("rights") or "")))
    o["enriched"] = today
    return used

SRC_NAME = {"nara": "미국 국립기록관리청 NARA", "tna": "영국 국립기록관 TNA", "archives": "국가기록원", "ia": "인터넷 아카이브", "ndl": "일본 국립국회도서관", "jacar": "일본 아시아역사자료센터",
            "europeana": "Europeana", "gallica": "Gallica(BnF)", "un": "UN 디지털도서관", "awm": "호주 전쟁기념관", "commons": "위키미디어 공용", "gallery": "KOREA ARCHIVE IIIF 갤러리",
            "kyudb": "규장각", "jsg": "장서각", "nlk": "국립중앙도서관", "nedb": "한국사DB", "oldnews": "대한민국신문아카이브", "i815": "독립기념관", "gonghun": "공훈전자사료관",
            "indy": "독립운동판결문", "koreanwar": "6·25전쟁 아카이브센터", "earchive": "국편 전자사료관", "ktv": "KTV", "seoul": "서울기록원", "okchf": "국외소재문화유산재단", "nrich": "국립문화유산연구원",
            "much": "대한민국역사박물관", "heritage": "국가유산청", "aks": "한국고문서자료관", "nlna": "네덜란드 국립기록관", "dnz": "DigitalNZ", "nzarch": "뉴질랜드 기록원"}

def tree_path(o):
    """계층 경로 = 기관 › partOf 단계들(앞 단계가 기관명과 같으면 접음). 계층이 없으면 '(계열 미상)'을 명시."""
    src = o["key"].split(":")[0]; top = SRC_NAME.get(src, src)
    segs = [x.strip() for x in (o.get("partOf") or o.get("partOf_derived") or "").split("›") if x.strip()]
    if segs and (segs[0] in top or top in segs[0] or segs[0] in ("국가기록원", "국외소재문화유산재단", "국립문화유산연구원", "IIIF 갤러리", "한국사DB", "TNA", "NARA", "AWM 유형")): segs = segs[1:] if segs[0] != "AWM 유형" else segs
    return [top] + (segs or ["(계열 미상)"])

ERAS = ["광복이후", "광복 이후", "선사", "고조선", "삼국", "고구려", "백제", "신라", "가야", "통일신라", "발해", "남북국", "고려", "조선", "대한제국", "일제강점기", "대한민국"]
DATE_KEYS = ("생산일", "생산연도", "생산", "연대", "날짜", "시대", "시대분류", "출판정보", "발행", "발행일", "제작연도", "제작시기", "국적/시대", "작성연대 / 간행시기")
ERA_KEYS = ("시대", "시대분류", "제작시기", "국적/시대")

def date_derived(o):
    """v2.32 심층 판독 응답의 '라벨 붙은' 자기 날짜만 — 신문 발행일(제호 · YYYYMMDD · 발행)·판결일(판결 YYYYMMDD). 본문 속 연도는 쓰지 않는다."""
    if o.get("date"): return "", ""
    sm = o.get("summary") or ""
    m = re.search(r"판결 (1[0-9]\d\d|20\d\d)(0[1-9]|1[0-2])([0-3]\d)(?!\d)", sm)
    if m: return f"{m[1]}-{m[2]}-{m[3]}", "심층 판독 — 판결일"
    m = re.match(r"^[^·]{1,40} · (1[0-9]\d\d|20\d\d)(0[1-9]|1[0-2])([0-3]\d) · 발행", sm)
    if m: return f"{m[1]}-{m[2]}-{m[3]}", "심층 판독 — 신문 발행일"
    return "", ""

ERA_BASE = {"明治": 1867, "메이지": 1867, "大正": 1911, "다이쇼": 1911, "昭和": 1925, "쇼와": 1925, "平成": 1988, "令和": 2018,
            "建陽": 1895, "건양": 1895, "光武": 1896, "광무": 1896, "隆熙": 1906, "융희": 1906, "檀紀": -2333, "단기": -2333}
_KN = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}

def _kanji_num(t):
    """元·一~九·十·百·千 한자 수(예: 三十五 → 35, 四二九二 → 4292). 아라비아 숫자도."""
    if t == "元": return 1
    if t.isdigit(): return int(t)
    if not any(c in t for c in "十百千"): return int("".join(str(_KN[c]) for c in t)) if all(c in _KN for c in t) else None
    n = cur = 0
    for c in t:
        if c in _KN: cur = _KN[c]
        elif c in ("十", "百", "千"):
            n += (cur or 1) * {"十": 10, "百": 100, "千": 1000}[c]; cur = 0
        else: return None
    return n + cur

def era_year(text):
    """v2.33 연호 연도 → 서기(제목·날짜에 적힌 그대로만). 明治三十五年 → 1902, 檀紀四二九二年 → 1959, 光武 9년 → 1905."""
    for m in re.finditer(r"(明治|메이지|大正|다이쇼|昭和|쇼와|平成|令和|建陽|건양|光武|광무|隆熙|융희|檀紀|단기)\s*(元|[〇零一二三四五六七八九十百千]+|\d{1,4})\s*[年년]", text or ""):
        n = _kanji_num(m[2])
        if n is None: continue
        y = ERA_BASE[m[1]] + n
        if 1000 <= y <= 2099: return y
    return None

DEFECT_RE = re.compile(r"Archive-It Crawl Data|^(헌정사 자료 DB|포로신문보고서) — '.+' 수록$")

def entry_type(o):
    """v2.34 원장 항목 유형 — 기록 / 검색 안내(결과 묶음·검색 페이지) / 결함 출력(옛 파서 오류: v2.23 한국사DB 메뉴 오인·v2.24 IA 크롤링 묶음).
    축적 정보는 지우지 않는다 — 표시만 하고 인용·피드·타임라인·인기 순위에서 뺀다."""
    t, u = o.get("title") or "", o.get("url") or ""
    if DEFECT_RE.search(t): return "결함 출력"
    if re.search(r"moreContentsSearchList|catalog/result\?", u) or re.match(r"^독립기념관 .+ \d+건$", t): return "검색 안내"
    if o["key"].startswith("aks:") and t.startswith("[고문서 소장처]"): return "소장처(컬렉션)"
    return "기록"

def link_quality(o):
    u = (o.get("url") or "").rstrip("/")
    return "사이트 첫 화면 — 식별자로 원 기관 검색" if re.match(r"^https?://[^/]+$", u) or u.endswith("/viewer/viewer.do") else ""

def decade(o):
    """연대 — date → 제목 → 메타(생산·시대·출판) 순. 4자리 연도면 'NNN0년대', 없으면 '18세기'처럼 세기, 그도 없으면 왕조·시대명. 지정일·등록일(지정 시점)은 쓰지 않는다."""
    cands = [o.get("date") or o.get("date_derived") or "", o.get("title") or ""] + [str(v) for k, v in (o.get("meta") or []) if k in DATE_KEYS]  # 제목 연도(내용 시점)가 메타 생산일(업로드일일 수 있음)보다 우선
    for c in cands:
        m = re.search(r"(?<!\d)(1[0-9]\d\d|20\d\d)(?:(?!\d)|(?=(?:0[1-9]|1[0-2])[0-3]\d(?!\d)))", c)
        if m: return m.group(1)[:3] + "0년대"
    for c in cands:  # 연호 연도(明治·大正·昭和·光武·隆熙·檀紀 …) — 서기 연도가 없을 때
        y = era_year(c)
        if y: return str(y)[:3] + "0년대"
    for c in cands:
        m = re.search(r"(?<!\d)(\d{1,2})\s*(?:-\s*\d{1,2}\s*)?세기", c) or re.search(r"(?<!\d)(\d{1,2})(?:st|nd|rd|th)[ -]century", c, re.I)
        if m and 1 <= int(m.group(1)) <= 21: return f"{int(m.group(1))}세기"
    for c in [str(v) for k, v in (o.get("meta") or []) if k in ERA_KEYS]:  # 왕조·시대명은 기관의 '시대' 필드에서만(제목의 '조선총독부'·'대한민국역사박물관' 같은 오인 방지)
        for e in sorted(ERAS, key=len, reverse=True):
            if e in c: return {"대한민국": "대한민국(1948~)", "일제강점기": "일제강점기", "광복이후": "광복 이후(1945~)", "광복 이후": "광복 이후(1945~)"}.get(e, e + "시대")
    return ""

def period_order(lbl):
    """타임라인 정렬 — 시대명 < 세기 < 연대 순으로 시간축에 근사(세기 N → (N-1)*100년)."""
    m = re.match(r"(\d{3,4})0년대", lbl)
    if m: return (1, int(m.group(1)) * 10)
    m = re.match(r"(\d{1,2})세기", lbl)
    if m: return (1, (int(m.group(1)) - 1) * 100 + 50)
    base = {"선사": -3000, "고조선": -1000, "삼국": 300, "고구려": 300, "백제": 300, "신라": 300, "가야": 300, "통일신라": 800, "발해": 800, "남북국": 800, "고려": 1100, "조선": 1600, "대한제국": 1900, "일제강점기": 1925, "광복 이후(1945~)": 1965, "대한민국(1948~)": 1970}
    for e, y in base.items():
        if lbl.startswith(e): return (1, y)
    return (2, 0)

def derive_path(o):
    """v2.27 계층정보가 없는 기록에 파생 계층을 구축 — 원 기관 계층(partOf)과 구분해 '[파생]'으로 표시. 근거: 유형 표기·제목 주제부·연대·매체."""
    src = o["key"].split(":")[0]; t = o.get("title") or ""; segs = []
    m = re.match(r"\[([^\]]+)\]", t)
    if m: segs.append(m.group(1))  # 서울기록원 [기록건·사진]·[컬렉션] 등 유형 표기
    elif src == "nzarch" and " - " in t: segs.append(t.split(" - ")[0].strip()[:60])  # AIMS 제목 첫 단(주제 분류)
    elif src == "un":
        m2 = re.match(r"(Cooperation between the United Nations and|Report of|Question of|Letter dated|Resolution)", t)
        segs.append(m2.group(1) if m2 else "문서")
    elif src == "commons":
        u = (o.get("url") or "").lower(); segs.append("영상" if re.search(r"\.(webm|ogv|mp4)$", u) else ("문서" if u.endswith((".pdf", ".djvu", ".tif")) else "이미지"))
    d = decade(o)
    segs.append(d or "연대 미상")
    return "[파생] " + " › ".join(segs)

def leaf_manifest(o):
    if o.get("iiif"): return o["iiif"]
    env = {"s": o["sources"], "t": o["title"][:160], "d": o.get("date", ""), "i": o.get("id", ""), "u": o.get("url", ""), "p": o.get("partOf", ""),
           "n": o["key"].split(":")[0], "m": o.get("media", ""), "q": "발견 누적 원장", "at": o["first_seen"][:19]}
    return f"{ORIGIN}/iiif/rec/{tok(env)}/manifest.json"

def build_tree(recs):
    """계층구조도 — tree.json(중첩 트리)·hierarchy.json(IIIF 중첩 컬렉션)·h/<기관>.json(기관별 IIIF)·tree.html(접이식 트리)."""
    root = {"name": "발견 누적 원장", "kids": {}, "recs": []}
    for o in recs:
        n = root
        for seg in tree_path(o):
            n = n["kids"].setdefault(seg, {"name": seg, "kids": {}, "recs": []})
        n["recs"].append(o)
    def count(n): n["n"] = len(n["recs"]) + sum(count(k) for k in n["kids"].values()); return n["n"]
    count(root)
    def js(n): return {"name": n["name"], "count": n["n"], "children": [js(k) for k in sorted(n["kids"].values(), key=lambda k: -k["n"])],
                       "records": [{"key": o["key"], "title": o["title"][:160], "url": o.get("url", ""), "date": o.get("date", ""), "seen": o["seen"]} for o in n["recs"]]}
    json.dump(js(root), open(os.path.join(D, "tree.json"), "w", encoding="utf-8"), ensure_ascii=False)
    PB = "https://changgi.github.io/korea-archive-mcp/data/"
    def coll(n, cid):
        items = [coll(k, f"{cid}/{i}") for i, k in enumerate(sorted(n["kids"].values(), key=lambda k: -k["n"]))]
        items += [{"id": leaf_manifest(o), "type": "Manifest", "label": {"none": [o["title"][:120]]}} for o in n["recs"]]
        return {"id": f"{PB}{cid}", "type": "Collection", "label": {"ko": [f"{n['name']} ({n['n']})"]}, "items": items}
    os.makedirs(os.path.join(D, "h"), exist_ok=True)
    tops = sorted(root["kids"].values(), key=lambda k: -k["n"]); idx = {}
    for i, t in enumerate(tops):
        slug = next((k for k, v in SRC_NAME.items() if v == t["name"]), f"src{i}")
        c = coll(t, f"h/{slug}.json"); c["@context"] = "http://iiif.io/api/presentation/3/context.json"; c["id"] = f"{PB}h/{slug}.json"
        json.dump(c, open(os.path.join(D, "h", f"{slug}.json"), "w", encoding="utf-8"), ensure_ascii=False); idx[t["name"]] = slug
    json.dump({"@context": "http://iiif.io/api/presentation/3/context.json", "id": f"{PB}hierarchy.json", "type": "Collection",
               "label": {"ko": [f"KOREA ARCHIVE 통합검색 — 발견 누적 원장 계층구조 ({root['n']}건)"]},
               "summary": {"ko": ["기관 › 계열(원 기관 계층 또는 구축 계층) › … › 기록. 계층이 없는 기록은 '(계열 미상)'으로 명시."]},
               "items": [{"id": f"{PB}h/{idx[t['name']]}.json", "type": "Collection", "label": {"ko": [f"{t['name']} ({t['n']})"]}} for t in tops]},
              open(os.path.join(D, "hierarchy.json"), "w", encoding="utf-8"), ensure_ascii=False)
    E_ = html.escape; KV = "https://changgi.github.io/korea-archive-mcp/kv.html?manifest="
    def node_html(n, depth, href=None):
        kids = "".join(node_html(k, depth + 1) for k in sorted(n["kids"].values(), key=lambda k: -k["n"]))
        leaves = "".join(f"<li class='r'><a href='{E_(o.get('url') or '#')}'>{E_(o['title'][:110])}</a>{' <span>' + E_(' · '.join(x for x in (o.get('date'), o.get('id')) if x)) + '</span>' if o.get('date') or o.get('id') else ''} <a class='kv' href='{KV}{E_(leaf_manifest(o))}'>KV</a></li>" for o in n["recs"][:200])
        more = f"<li class='r'>… 외 {len(n['recs']) - 200}건(CSV 참조)</li>" if len(n["recs"]) > 200 else ""
        kvn = f" <a class='kv' href='{KV}{E_(href)}'>이 계층 KV로 보기</a>" if href else ""
        miss = " miss" if n["name"] == "(계열 미상)" else ""
        return f"<details{' open' if depth < 1 else ''}><summary class='d{min(depth, 4)}{miss}'>{E_(n['name'])} <b>{n['n']}</b>{kvn}</summary><ul>{kids}{leaves}{more}</ul></details>"
    body = "".join(node_html(t, 0, f"{PB}h/{idx[t['name']]}.json") for t in tops)
    # v2.14 국외 소장처 교차 보기 — 재단(okchf)·연구원(nrich) 기록을 '국가 › 소장처'로 모아 두 DB의 수록 범위를 나란히(같은 소장처를 두 기관이 각각 조사·공개한 정도)
    ALIAS = {"대영박물관": "영국박물관", "british museum": "영국박물관", "메트로폴리탄박물관": "메트로폴리탄미술관"}
    ov = {}
    for o in recs:
        segs = [x.strip() for x in (o.get("partOf") or "").split("›")]
        if "국외문화유산" not in segs: continue
        i = segs.index("국외문화유산"); nat = segs[i + 1] if len(segs) > i + 1 else "?"; hol = segs[i + 2] if len(segs) > i + 2 else "?"
        hol = ALIAS.get(hol.lower(), ALIAS.get(hol, hol))
        e = ov.setdefault((nat, hol), {"okchf": 0, "nrich": 0, "recs": []})
        for sname in o["sources"]:
            b0 = sname.split("·")[0]
            if b0 in ("okchf", "nrich"): e[b0] += 1
        e["recs"].append(o)
    with open(os.path.join(D, "overseas_holders.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); w.writerow(["국가", "소장처", "국외소재문화유산재단(okchf)", "국립문화유산연구원(nrich)", "두 기관 모두", "기록 수"])
        for (nat, hol), e in sorted(ov.items(), key=lambda kv: (kv[0][0], -len(kv[1]["recs"]))): w.writerow([nat, hol, e["okchf"], e["nrich"], "Y" if e["okchf"] and e["nrich"] else "", len(e["recs"])])
    both = sum(1 for e in ov.values() if e["okchf"] and e["nrich"])
    orow = "".join(f"<tr><td>{E_(nat)}</td><td>{E_(hol)}</td><td>{e['okchf'] or ''}</td><td>{e['nrich'] or ''}</td><td>{'◎' if e['okchf'] and e['nrich'] else ''}</td></tr>"
                   for (nat, hol), e in sorted(ov.items(), key=lambda kv: (-(bool(kv[1]['okchf']) and bool(kv[1]['nrich'])), kv[0][0], -len(kv[1]['recs']))))
    ovsec = (f"<h2>국외 소장처 교차 보기</h2><p>국외소재문화유산재단·국립문화유산연구원 두 DB에서 발견된 국외 소재 기록을 <b>국가 › 소장처</b>로 모았습니다. 소장처 {len(ov)}곳 · 두 기관 모두 수록 {both}곳(◎). "
             f"같은 유물이 두 DB에 있으면 검색 결과에서 한 건으로 묶여 출처가 둘 다 표기됩니다(명칭+소장처 일치). <a href='overseas_holders.csv'>CSV</a></p>"
             f"<table><tr><th>국가</th><th>소장처</th><th>재단</th><th>연구원</th><th>교차</th></tr>{orow}</table>") if ov else ""
    miss = sum(len(k["recs"]) for t in tops for k in t["kids"].values() if k["name"] == "(계열 미상)")
    depth = {}
    def walk(n, d):
        for o in n["recs"]: depth[d] = depth.get(d, 0) + 1
        for k in n["kids"].values(): walk(k, d + 1)
    walk(root, 0)
    dd = " · ".join(f"{d - 1}단계 {c}건" for d, c in sorted(depth.items()) if d > 1)
    open(os.path.join(D, "tree.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>계층구조도 — 발견 누적 원장</title><style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:1000px;margin:auto;padding:16px}}a{{color:#e0b04a}}
details{{margin:2px 0 2px 0}}ul{{list-style:none;margin:0;padding-left:16px;border-left:1px dashed #33363f}}summary{{cursor:pointer;padding:4px 2px}}summary b{{color:#9b9a93;font-weight:400;font-size:13px;margin-left:4px}}
table{{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}}td,th{{border-bottom:1px solid #2a2d35;padding:5px;text-align:left}}.d0{{font-size:18px;font-weight:700}}.d1{{font-size:16px;font-weight:600}}.d2,.d3,.d4{{font-size:15px}}.miss{{color:#c97a6a}}li.r{{font-size:14px;padding:3px 0;line-height:1.4}}li.r span{{color:#9b9a93;font-size:12px}}a.kv{{font-size:12px;border:1px solid #e0b04a;border-radius:4px;padding:0 4px;margin-left:4px;text-decoration:none}}</style>
<main><h1>계층구조도</h1><p>발견 누적 원장 {root['n']}건을 <b>기관 › 계열(원 기관 계층 또는 구축 계층) › … › 기록</b>으로 펼친 구조입니다. 기관 {len(tops)}곳 · 계열 깊이: {dd or '—'} · 계열 미상 {miss}건(붉은색 — 계층 보강 대상).</p>
<p><a href="index.html">← 원장</a> · <a href="tree.json">tree.json</a> · <a href="hierarchy.json">IIIF 계층 컬렉션</a> · <a href="{KV}{PB}hierarchy.json">전체 계층을 KV로</a>{' · <a href="#ov">국외 소장처 교차 보기</a>' if ov else ''}</p>{body}<div id="ov">{ovsec}</div></main></html>""")
    return root

def key_of(r):
    h = (r.get("s") or ["?"])[0].split("·")[0]
    return f"{h}:{r.get('i') or r.get('u') or r.get('t', '')[:80]}"

def tok(env):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return base64.urlsafe_b64encode(c.compress(json.dumps(env, ensure_ascii=False, separators=(",", ":")).encode()) + c.flush()).decode().rstrip("=")

def merge_queries(state, today):
    """v2.26 모든 질의·회신 영구 축적 — 날짜 함 ka:q → docs/data/queries/YYYY-MM.jsonl.gz.
    같은 도구·같은 인자·같은 회신 지문(h)이면 중복(seen·last만 갱신), 회신이 바뀌면 새 판으로 보존(증거성 — 응답 변화 이력). 절대 삭제하지 않는다."""
    import gzip, hashlib
    qdir = os.path.join(D, "queries"); os.makedirs(qdir, exist_ok=True)
    qs = state.setdefault("qdays", {}); added = 0; books = {}
    def book(month):
        if month not in books:
            f = os.path.join(qdir, f"{month}.jsonl.gz"); rows = {}
            if os.path.exists(f):
                for ln in gzip.open(f, "rt", encoding="utf-8"):
                    if ln.strip(): o = json.loads(ln); rows[o["k"]] = o
            books[month] = rows
        return books[month]
    for back in (2, 1, 0):
        d = (today - dt.timedelta(days=back)).isoformat(); pos = qs.get(d, 0)
        while True:
            try: j = get(f"{API}{d}?kind=q&start={pos}&n=500")
            except Exception as e: print(f"질의 {d}: 읽기 실패 {e}"); break
            items = j.get("items") or []
            for r in items:
                at = r.get("at") or d; args = r.get("args") or {}
                k = hashlib.sha256((r.get("tool", "") + json.dumps(args, ensure_ascii=False, sort_keys=True) + r.get("h", "")).encode()).hexdigest()[:20]
                B = book(at[:7]); o = B.get(k)
                if o: o["seen"] += 1; o["last"] = max(o["last"], at); continue
                B[k] = {"k": k, "ak": r.get("ak", ""), "tool": r.get("tool", ""), "args": args, "first": at, "last": at, "seen": 1, "h": r.get("h", ""), "n": r.get("n", 0), "z": r.get("z", "")}; added += 1
            pos += len(items)
            if len(items) < 500: break
        qs[d] = pos
    keep = (today - dt.timedelta(days=10)).isoformat(); state["qdays"] = {k: v for k, v in qs.items() if k >= keep}
    for month, rows in books.items():
        with gzip.open(os.path.join(qdir, f"{month}.jsonl.gz"), "wt", encoding="utf-8") as fo:
            for o in sorted(rows.values(), key=lambda o: (o["first"], o["k"])): fo.write(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n")
    # 질의 색인(회신 본문 제외 — 가볍게): 전 기간 질의 목록, 도구별 건수
    idx = []
    for f in sorted(os.listdir(qdir)):
        if f.endswith(".jsonl.gz"):
            for ln in gzip.open(os.path.join(qdir, f), "rt", encoding="utf-8"):
                if ln.strip():
                    o = json.loads(ln); idx.append({k: o[k] for k in ("k", "tool", "args", "first", "last", "seen", "h", "n")} | {"ak": o.get("ak", ""), "month": f[:7]})
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "total": len(idx), "queries": idx}, open(os.path.join(qdir, "index.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"질의 축적: 신규 {added} · 누적 {len(idx)}")
    bt = {}
    for o in idx: bt[o["tool"]] = bt.get(o["tool"], 0) + o["seen"]
    recent = sorted(idx, key=lambda o: o["last"], reverse=True)[:20]
    return {"added": added, "total": len(idx), "calls": sum(o["seen"] for o in idx), "by_tool": dict(sorted(bt.items(), key=lambda kv: -kv[1])), "recent": recent}

def build_provenance(recs):
    """v2.28 발견 경로(맥락·증거 사슬) — 질의 지문(ak) ↔ 발견 기록을 양방향으로. 질의는 queries/index.json, 회신 원문은 queries/<월>.jsonl.gz(같은 ak)."""
    qp = os.path.join(D, "queries", "index.json")
    Q = json.load(open(qp, encoding="utf-8")).get("queries", []) if os.path.exists(qp) else []
    byak = {}
    for q in Q:
        if q.get("ak"):
            e = byak.setdefault(q["ak"], {"ak": q["ak"], "tool": q["tool"], "args": q["args"], "first": q["first"], "last": q["last"], "calls": 0, "versions": 0, "records": []})
            e["calls"] += q["seen"]; e["versions"] += 1; e["first"] = min(e["first"], q["first"]); e["last"] = max(e["last"], q["last"])
            e.setdefault("responses", []).append({"h": q["h"], "first": q["first"], "last": q["last"], "seen": q["seen"], "bytes": q.get("n", 0), "month": q.get("month", "")})
    orphan = 0
    for o in recs:
        for ak in o.get("found_by") or []:
            e = byak.get(ak)
            if not e: e = byak[ak] = {"ak": ak, "tool": "", "args": None, "first": o["first_seen"], "last": o["last_seen"], "calls": 0, "versions": 0, "records": []}; orphan += 1
            if o["key"] not in e["records"]: e["records"].append(o["key"])
    out = sorted(byak.values(), key=lambda e: (-len(e["records"]), e["first"]))
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "queries": len(out), "linked_records": sum(1 for o in recs if o.get("found_by")),
               "note": "ak=질의 지문(도구+인자). 회신 원문은 queries/<월>.jsonl.gz에서 같은 ak로(versions = 회신 판 수). args=None은 질의 축적(v2.26) 이전·병합 대기 분",
               "provenance": out}, open(os.path.join(D, "provenance.json"), "w", encoding="utf-8"), ensure_ascii=False)
    build_query_records(out, {o["key"]: o for o in recs})
    return len(out), orphan

def build_query_records(prov, bykey):
    """v2.38 질의별 발굴 기록물 — 질의 하나를 현용기록물 한 건으로: docs/data/q/<ak>.json(IIIF Collection — 그 질의가 찾은 기록의 매니페스트,
    메타데이터에 도구·인자·처음/마지막·호출 수·회신 판 지문) + q/index.html. 지우지 않는다(같은 ak면 갱신)."""
    qd = os.path.join(D, "q"); os.makedirs(qd, exist_ok=True)
    L1v = lambda k, v: {"label": {"ko": [k]}, "value": {"none": [str(v)]}}
    rows = []
    byref = {}
    for k, o in bykey.items():  # 심층 판독 도구(상세 URL·식별자 질의)는 인자가 곧 기록 — URL·id로 연결
        for r in (o.get("url"), o.get("id")):
            if r and len(str(r)) >= 6: byref.setdefault(str(r).strip(), k)
    for e in prov:
        if not e.get("tool"): continue
        refs = [byref[str(v).strip()] for v in (e.get("args") or {}).values() if isinstance(v, str) and str(v).strip() in byref]
        for k in refs:
            if k not in e["records"]: e["records"].append(k); e.setdefault("read_records", []).append(k)
        items = []
        for k in e["records"]:
            o = bykey.get(k)
            if not o: continue
            mf = o.get("iiif") or o.get("iiif_built") or leaf_manifest(o)
            items.append({"id": mf, "type": "Manifest", "label": {"none": [o["title"][:120] + (f" ({o['date']})" if o.get("date") else "")]}})
        args = json.dumps(e["args"], ensure_ascii=False, sort_keys=True) if e.get("args") is not None else ""
        resp = e.get("responses", [])
        md = [L1v("도구", e["tool"]), L1v("질의 인자", args), L1v("질의 지문(ak)", e["ak"]), L1v("처음 질의", e["first"]), L1v("마지막 질의", e["last"]),
              L1v("누적 호출", e["calls"]), L1v("회신 판 수", len(resp)), L1v("발견 기록 수", len(items))] + ([L1v("판독 대상 기록", ", ".join(e["read_records"][:5]))] if e.get("read_records") else [])
        md += [L1v(f"회신 판 {i + 1}", f"지문 {r['h']} · {r['first'][:16]}~{r['last'][:16]} · {r['seen']}회 · {r['bytes']}B · 원문 queries/{r['month']}.jsonl.gz") for i, r in enumerate(resp[:20])]
        col = {"@context": "http://iiif.io/api/presentation/3/context.json", "id": f"{PAGES}q/{e['ak']}.json", "type": "Collection",
               "label": {"ko": [f"질의 발굴 기록 — {e['tool']} {args[:120]}"]},
               "summary": {"ko": [f"KOREA ARCHIVE 통합검색 질의 한 건이 찾은 기록 {len(items)}건. 회신 원문은 질의·회신 축적(queries/)에서 같은 지문으로 확인 — 질의 → 회신 → 발견 기록의 증거 사슬."]},
               "metadata": md, "requiredStatement": {"label": {"ko": ["출처"]}, "value": {"ko": ["각 기록의 권리는 원 기관 표기를 따름 — 게재 전 judge_rights"]}},
               "seeAlso": [{"id": f"{PAGES}provenance.json", "type": "Dataset", "format": "application/json", "label": {"ko": ["발견 경로 전체"]}}], "items": items}
        json.dump(col, open(os.path.join(qd, f"{e['ak']}.json"), "w", encoding="utf-8"), ensure_ascii=False)
        rows.append((e, args, len(items), len(resp)))
    E_ = html.escape; KV = "https://changgi.github.io/korea-archive-mcp/kv.html?manifest="
    kvl = lambda ak: " · <a href='" + KV + E_(PAGES + "q/" + ak + ".json") + "'>KV</a>"
    tr = "".join(f"<tr><td>{E_(e['last'][:16])}</td><td>{E_(e['tool'])}</td><td>{E_(a[:160])}</td><td>{n}</td><td>{v}</td><td>{e['calls']}</td>"
                 f"<td><a href='{E_(e['ak'])}.json'>IIIF</a>{kvl(e['ak']) if n else ''}</td></tr>"
                 for e, a, n, v in sorted(rows, key=lambda r: r[0]["last"], reverse=True))
    open(os.path.join(qd, "index.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>질의별 발굴 기록 — KOREA ARCHIVE 통합검색</title><style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:1100px;margin:auto;padding:16px}}a{{color:#e0b04a}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{border-bottom:1px solid #2a2d35;padding:6px;text-align:left;vertical-align:top}}</style>
<main><h1>질의별 발굴 기록</h1><p>질의 한 건 = 기록물 한 건. 각 질의가 찾은 기록을 IIIF 컬렉션으로 묶고, 회신 판 지문(같은 질의의 응답이 바뀌면 새 판)을 메타데이터로 남깁니다. 회신 원문은 <a href="../queries/index.json">질의·회신 축적</a>, 경로 전체는 <a href="../provenance.json">provenance.json</a>. 지우지 않습니다.</p>
<table><tr><th>마지막</th><th>도구</th><th>질의 인자</th><th>발견</th><th>회신 판</th><th>호출</th><th>열람</th></tr>{tr}</table></main></html>""")
    return len(rows)

PAGES = "https://changgi.github.io/korea-archive-mcp/data/"

def kind_of(o):
    """매체 유형(인용 형식용) — 제목·URL 표기 근거. 근거가 없으면 문서."""
    t = (o.get("title", "") + " " + (o.get("url") or "") + " " + (o.get("media") or "")).lower()
    if re.search(r"영상|동영상|필름|film|motion picture|newsreel|대한뉴스|\.webm|\.mp4|video", t): return "motion_picture"
    if re.search(r"사진|圖|畵|畫|photo|\.jpe?g|\.png|\.gif|\.tif|image|도판|그림|회화|탱화|불화|초상", t): return "graphic"
    if re.search(r"지도|map\b|도면", t): return "map"
    return "document"

def build_media(recs_all):
    """v2.29 다매체 확산 — 같은 원장을 구독(Atom)·인용 관리자(CSL-JSON·RIS)·시각화(연대 타임라인)로. 원 기관 표기 그대로, 파생 계층은 [파생] 유지."""
    recs = [o for o in recs_all if o.get("entry_type", "기록") == "기록"]  # v2.34 검색 안내·결함 출력은 인용·피드·타임라인에서 제외(원장에는 보존)
    import xml.sax.saxutils as X
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    inst = lambda o: SRC_NAME.get(o["key"].split(":")[0], o["key"].split(":")[0])
    ser = lambda o: o.get("partOf") or o.get("partOf_derived") or ""
    yr = lambda o: (re.search(r"(?<!\d)(1[0-9]\d\d|20\d\d)(?:(?!\d)|(?=(?:0[1-9]|1[0-2])[0-3]\d(?!\d)))", o.get("date") or o.get("date_derived") or "") or [None, None])[1] if (o.get("date") or o.get("date_derived")) else None
    # 1) Atom 피드 — 새로 발견된 기록 100건(구독기·RSS 앱·자동화로 퍼짐)
    new = sorted(recs, key=lambda o: o["first_seen"], reverse=True)[:100]
    ent = "".join(f"""<entry><title>{X.escape(o['title'][:200])}</title><id>{X.escape(o.get('url') or PAGES + '#' + o['key'])}</id><link href="{X.escape(o.get('url') or PAGES)}"/>
<updated>{o['first_seen']}</updated><author><name>{X.escape(inst(o))}</name></author>{''.join(f'<category term="{X.escape(x)}"/>' for x in o['sources'])}
<summary>{X.escape(' · '.join(x for x in (o.get('date'), ser(o), o.get('id'), (o.get('summary') or '')[:300]) if x))}</summary></entry>""" for o in new)
    open(os.path.join(D, "feed.xml"), "w", encoding="utf-8").write(f"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>KOREA ARCHIVE 통합검색 — 새로 발견된 기록</title><id>{PAGES}feed.xml</id><link rel="self" href="{PAGES}feed.xml"/><link href="{PAGES}"/>
<updated>{now}</updated><subtitle>사용자들이 도구로 발굴한 한국 관련 기록(원 기관 링크·권리는 원 기관 표기)</subtitle>{ent}</feed>""")
    # 2) CSL-JSON — Zotero·Mendeley·Pandoc 인용
    csl = []
    for o in recs:
        it = {"id": o["key"], "type": kind_of(o), "title": o["title"], "archive": inst(o), "URL": o.get("url", ""),
              "accessed": {"date-parts": [[int(x) for x in o["first_seen"][:10].split("-")]]}, "note": f"KOREA ARCHIVE 통합검색 발견 원장 — 처음 발견 {o['first_seen'][:10]}, 발견 {o['seen']}회"}
        if o.get("id"): it["archive_location"] = o["id"]
        if ser(o): it["collection-title"] = ser(o)
        ymd = re.match(r"^(1[0-9]\d\d|20\d\d)-?(0[1-9]|1[0-2])-?([0-3]\d)$", (o.get("date") or o.get("date_derived") or "").strip())
        if ymd: it["issued"] = {"date-parts": [[int(ymd[1]), int(ymd[2]), int(ymd[3])]]}  # YYYYMMDD·YYYY-MM-DD는 일 단위까지
        elif yr(o): it["issued"] = {"date-parts": [[int(yr(o))]]}
        elif o.get("date"): it["issued"] = {"literal": o["date"]}
        if o.get("summary"): it["abstract"] = o["summary"][:1000]
        csl.append(it)
    json.dump(csl, open(os.path.join(D, "records.csl.json"), "w", encoding="utf-8"), ensure_ascii=False)
    # 3) RIS — EndNote·RefWorks·Zotero
    TY = {"motion_picture": "VIDEO", "graphic": "ART", "map": "MAP", "document": "GEN"}
    with open(os.path.join(D, "records.ris"), "w", encoding="utf-8") as f:
        for o in recs:
            L = [f"TY  - {TY[kind_of(o)]}", f"TI  - {o['title']}", f"DB  - {inst(o)}"]
            if yr(o): L.append(f"PY  - {yr(o)}")
            if o.get("date"): L.append(f"DA  - {o['date']}")
            if o.get("id"): L.append(f"AN  - {o['id']}")
            if ser(o): L.append(f"T2  - {ser(o)}")
            if o.get("url"): L.append(f"UR  - {o['url']}")
            if o.get("summary"): L.append(f"AB  - {o['summary'][:1000]}")
            L += [f"N1  - KOREA ARCHIVE 통합검색 발견 원장 — 처음 발견 {o['first_seen'][:10]} · 출처 {'+'.join(o['sources'])}", "ER  - ", ""]
            f.write("\n".join(L) + "\n")
    # 4) 연대 타임라인 — 시각화·전시용(연대 × 기관 × 매체)
    tl = {}
    for o in recs:
        d = decade(o) or "연대 미상"; e = tl.setdefault(d, {"decade": d, "records": 0, "by_source": {}, "by_kind": {}, "samples": []})
        e["records"] += 1; h = o["key"].split(":")[0]; k = kind_of(o)
        e["by_source"][h] = e["by_source"].get(h, 0) + 1; e["by_kind"][k] = e["by_kind"].get(k, 0) + 1
        if len(e["samples"]) < 5: e["samples"].append({"title": o["title"][:120], "url": o.get("url", ""), "iiif": o.get("iiif") or o.get("iiif_built", "")})
    json.dump({"updated": now, "note": "구간 = 연대(4자리 연도·8자리 날짜·연호 연도 明治·大正·昭和·光武·隆熙·檀紀 환산) → 세기 → 왕조·시대명. 근거 순서 date → 제목 → 메타(생산·시대·출판). 세기·시대 구간은 시간축 근사 정렬", "timeline": sorted(tl.values(), key=lambda e: period_order(e["decade"]))},
              open(os.path.join(D, "timeline.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    # 5) 연대 타임라인 페이지 — 사람이 보는 매체(막대·대표 기록·KV 열람)
    E_ = html.escape; KV = "https://changgi.github.io/korea-archive-mcp/kv.html?manifest="; T = sorted(tl.values(), key=lambda e: period_order(e["decade"])); mx = max((e["records"] for e in T), default=1)
    li = lambda x: f"<li><a href='{E_(x['url'] or '#')}'>{E_(x['title'])}</a>" + (f" <a class='kv' href='{KV}{E_(x['iiif'])}'>KV</a>" if x["iiif"] else "") + "</li>"
    KN = {"motion_picture": "영상", "graphic": "사진·그림", "map": "지도", "document": "문서"}
    rows = "".join(f"""<section><h3>{E_(e['decade'])} <small>{e['records']}건 · {' '.join(f"{KN[k]} {n}" for k, n in sorted(e['by_kind'].items(), key=lambda kv: -kv[1]))}</small></h3>
<div class="bar" style="width:{max(2, round(e['records'] / mx * 100))}%"></div><p class="src">{' · '.join(f"{E_(SRC_NAME.get(h, h))} {n}" for h, n in sorted(e['by_source'].items(), key=lambda kv: -kv[1]))}</p>
<ul>{''.join(li(x) for x in e['samples'])}</ul></section>""" for e in T)
    open(os.path.join(D, "timeline.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>연대 타임라인 — KOREA ARCHIVE 발견 원장</title><style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:960px;margin:auto;padding:16px}}a{{color:#e0b04a}}
section{{border-left:3px solid #e0b04a;padding:4px 14px;margin:14px 0}}h3{{margin:4px 0}}small{{color:#9b9a93;font-weight:400}}.bar{{height:8px;background:#e0b04a;border-radius:4px}}.src{{font-size:13px;color:#9b9a93}}li{{font-size:14px;margin:3px 0}}.kv{{font-size:12px;margin-left:6px}}</style>
<main><h1>연대 타임라인</h1><p>발견 누적 원장 {len(recs)}건을 시대 구간으로. 구간 = 4자리 연도 → 세기 → 기관 '시대' 필드의 왕조·시대명(근거 순서 date → 제목 → 메타). 세기·시대 구간은 시간축 근사 위치. 구간마다 대표 기록 5건(IIIF·KV 열람). <a href="timeline.json">timeline.json</a> · <a href="index.html">원장</a></p>{rows}</main></html>""")
    return len(new), len(csl), len(tl)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

def _csv_rows(txt):
    L = txt.split("\n"); i = next((k for k, l in enumerate(L) if l.startswith("node,")), None)
    if i is None: return []
    body = []
    for l in L[i:]:
        if l.startswith("※"): break
        body.append(l)
    return [r for r in csv.DictReader(io.StringIO("\n".join(body))) if r.get("sources")]

RESOLVE = {"earchive": lambda o: o.get("id") and {"query": o["id"], "sources": "earchive", "max_per_source": 5, "format": "csv"},
           "kyudb": lambda o: o.get("id") and {"query": o["id"], "sources": "kyudb", "max_per_source": 5, "format": "csv"}}

def resolve_links(led, today, budget):
    """v2.35 원 기관 첫 화면만 가리키던 기록 → 실제 기록 고정 링크. 식별자(사료ID·청구기호)로 우리 서버를 다시 검색해 같은 식별자 행의 상세 URL을 받는다(추정 없음 — 식별자 일치만).
    옛 URL은 지우지 않고 url_history에 남긴다."""
    used = fixed = 0
    for o in led.values():
        src = o["key"].split(":")[0]
        if used >= budget: break
        if src not in RESOLVE or not link_quality(o) or o.get("link_tried", "") >= today.isoformat(): continue
        args = RESOLVE[src](o)
        if not args: continue
        used += 1; o["link_tried"] = today.isoformat()
        try: rows = _csv_rows(mcp_call("cross_search", args))
        except Exception: continue
        hit = next((r for r in rows if (r.get("id") or "").strip() == str(o["id"]).strip() and r.get("url") and not re.match(r"^https?://[^/]+/?$", r["url"])), None)
        if hit:
            o.setdefault("url_history", []).append({"at": today.isoformat(), "url": o.get("url", ""), "note": "원 기관 첫 화면(식별자 재검색으로 고정 상세 확보)"})
            o["url"] = hit["url"]; o["link_src"] = f"식별자 재검색 cross_search({src}, '{o['id']}')"; fixed += 1
            if o.get("enrich_status") in ("ok", "none", "fail"): o["enrich_status"] = ""; o.pop("enriched", None)  # 새 상세로 다시 판독
        time.sleep(0.6)
    return used, fixed

def aks_drill(led, today, budget):
    """v2.35 고문서자료관 소장처(컬렉션) 항목 → 안의 실제 문서를 원장 기록으로 발굴. nedb_search(mode='aks')로 분류 → 문서까지 내려가
    문서마다 UCI 고정 링크(link.do?dataUCI=)·소장처 계층·제목 속 연도. 소장처 항목은 지우지 않고 '소장처(컬렉션)'으로 두고 하위 문서 목록을 단다."""
    used = added = 0
    for o in [x for x in led.values() if x["key"].startswith("aks:") and x.get("entry_type") != "결함 출력"]:
        if used >= budget: break
        if o.get("drilled", "") >= today.isoformat() or o.get("children"): continue
        cid = str(o.get("id") or ""); queue = [cid] if re.match(r"^L\d{6}", cid) else []; docs = []
        while queue and used < budget and len(docs) < 40:
            q = queue.pop(0); used += 1
            try: t = mcp_call("nedb_search", {"mode": "aks", "query": q})
            except Exception: break
            queue += re.findall(r"\[분류 (L\d{6}F[0-9A-Z]*)\]", t)
            for m in re.finditer(r"- \[문서\] (.+)\n\s+원문 고정 링크\(UCI\): (https://archive\.aks\.ac\.kr/link\.do\?dataUCI=\S+)", t): docs.append((m[1].strip(), m[2].strip()))
            time.sleep(0.6)
        o["drilled"] = today.isoformat()
        if not docs: continue
        coll = re.sub(r"\s*\([^()]*\)$", "", re.sub(r"^\[고문서 소장처\]\s*", "", o["title"])); o["children"] = [{"title": d, "url": u} for d, u in docs]
        for d, u in docs:
            k = "aks:" + u.split("dataUCI=")[1]
            if k in led: continue
            led[k] = {"key": k, "sources": ["aks"], "title": d, "date": "", "id": u.split("dataUCI=")[1], "url": u, "partOf": f"한국고문서자료관 › {o.get('partOf') or ''} › {coll}".replace(" ›  › ", " › "),
                      "media": "", "sameAs": "", "first_seen": today.isoformat() + "T00:00:00Z", "last_seen": today.isoformat() + "T00:00:00Z", "seen": 0, "tools": ["nedb_search"],
                      "days": {}, "formats": {}, "days_total": 0, "max_cross": 1, "drilled_from": o["key"], "found_via": "소장처 하위 문서 발굴(nedb_search mode=aks)"}
            added += 1
    return used, added


def parser_version():
    """판독기 판 — route.js·lib/*.js 지문(ledger 체크아웃 = main = 배포본). 지문이 바뀌면 '판독기 변경 동반'으로 구분."""
    import glob, hashlib
    h = hashlib.sha256()
    for f in [os.path.join(ROOT, "app", "api", "[transport]", "route.js")] + sorted(glob.glob(os.path.join(ROOT, "lib", "*.js"))):
        if os.path.exists(f): h.update(open(f, "rb").read())
    return h.hexdigest()[:12]

VOLATILE = re.compile(r"판독 시각|발견 시각|\d{4}-\d\d-\d\dT\d\d:\d\d|캐시|cache", re.I)

def fixity_text(o):
    """원 기관 응답(우리 판독기를 거친 정규형) — 심층 판독 도구 응답 또는 IIIF 매니페스트(변동 항목 제외)."""
    src = o["key"].split(":")[0]
    m = o.get("iiif") or ""
    if m:
        j = get(m)
        if not j.get("label") or not (j.get("metadata") or j.get("items") or j.get("sequences")): return None  # 빈·오류 응답은 지문 대상 아님(거짓 '원문 변경' 방지)
        md = [e for e in (j.get("metadata") or []) if not VOLATILE.search(json.dumps(e.get("label"), ensure_ascii=False))]
        core = {"label": j.get("label"), "summary": j.get("summary"), "metadata": md, "rights": j.get("rights"), "requiredStatement": j.get("requiredStatement"),
                "items": len(j.get("items") or (j.get("sequences") or [{}])[0].get("canvases") or [])}
        return json.dumps(core, ensure_ascii=False, sort_keys=True)
    if src in DEEP:
        tool, af = DEEP[src]; args = af(o)
        if args:
            t = mcp_call(tool, args)
            if re.search(r"파싱 실패|오류\(|조회 실패|시간 초과|브라우저로 열람", t[:300]): return None  # 판독 실패 응답은 지문 대상 아님
            return "\n".join(l for l in t.splitlines() if not VOLATILE.search(l))
    return None

def fixity_pass(led, today, budget):
    """v2.35 원문 고정성(fixity) 감시 — 기록의 원 기관 응답 지문을 순환 재확인. 바뀌면 지우지 않고 이력에 추가:
    첫 지문 / 판독기 변경 동반(우리 route.js·lib가 바뀜 — 원문 변경 아닐 수 있음) / 원문 변경 의심(판독기 그대로인데 응답이 바뀜)."""
    import hashlib
    pv = parser_version(); used = changed = 0
    cand = [o for o in led.values() if o.get("entry_type", "기록") == "기록" and (o.get("iiif") or o["key"].split(":")[0] in DEEP)]
    for o in sorted(cand, key=lambda o: o.get("fixity_checked", "")):
        if used >= budget: break
        if o.get("fixity_checked", "") >= today.isoformat(): continue
        try:
            t = fixity_text(o)
        except Exception:
            o["fixity_checked"] = today.isoformat(); used += 1; continue
        used += 1; o["fixity_checked"] = today.isoformat()
        if not t: continue
        h = hashlib.sha256(t.encode()).hexdigest()[:16]; fx = o.setdefault("fixity", [])
        if fx and fx[-1]["h"] == h: continue
        kind = "첫 지문" if not fx else ("판독기 변경 동반" if fx[-1].get("pv") != pv else "원문 변경 의심")
        fx.append({"at": today.isoformat(), "h": h, "pv": pv, "kind": kind}); changed += kind != "첫 지문"
        time.sleep(0.6)
    return used, changed, pv

def write_fixity(recs):
    ch = [{"key": o["key"], "title": o["title"][:160], "url": o.get("url", ""), "history": o["fixity"]} for o in recs if len(o.get("fixity") or []) > 1]
    sus = [c for c in ch if any(f["kind"] == "원문 변경 의심" for f in c["history"])]
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "watched": sum(1 for o in recs if o.get("fixity")),
               "changed_records": len(ch), "suspected_source_changes": len(sus),
               "note": "지문 = 원 기관 응답(우리 판독기 정규형, 판독 시각 등 변동 항목 제외)의 SHA-256-16. pv = 판독기(route.js·lib) 지문. 이력은 지우지 않는다.",
               "changes": sorted(ch, key=lambda c: c["history"][-1]["at"], reverse=True)}, open(os.path.join(D, "fixity_changes.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    return len(ch), len(sus)

def merge_classes(recs):
    """v2.26 기준·분류 정보 축적 — 발견된 모든 계층 경로(기관 › 계열 › …)의 각 단계를 분류 사전으로. 지우지 않고 갱신만(사라진 경로도 보존)."""
    p = os.path.join(D, "classifications.json")
    C = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"paths": {}}
    P = C["paths"]
    for o in recs:
        segs = tree_path(o)
        for i in range(1, len(segs) + 1):
            path = " › ".join(segs[:i]); e = P.setdefault(path, {"depth": i, "first": o["first_seen"], "last": o["last_seen"], "records": 0, "sources": []})
            e["first"] = min(e["first"], o["first_seen"]); e["last"] = max(e["last"], o["last_seen"])
            for s_ in o["sources"]:
                b = s_.split("·")[0]
                if b not in e["sources"]: e["sources"].append(b)
    cnt = {}
    for o in recs:
        segs = tree_path(o)
        for i in range(1, len(segs) + 1): cnt[" › ".join(segs[:i])] = cnt.get(" › ".join(segs[:i]), 0) + 1
    for k, e in P.items(): e["records"] = max(e.get("records", 0), cnt.get(k, 0))  # 기록 수는 줄지 않는다(지우지 않음 원칙)
    C["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"); C["total"] = len(P)
    json.dump(C, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    return len(P)

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
                    if b.get("ak") and b["ak"] not in o.setdefault("found_by", []): o["found_by"].append(b["ak"])  # v2.28 발견 경로 — 이 기록을 찾은 질의 지문(queries/index.json의 ak)
            pos += len(items); new_batches += len(items)
            if len(items) < 500: break
        state["days"][d] = pos
    keep = (today - dt.timedelta(days=10)).isoformat()
    state["days"] = {k: v for k, v in state["days"].items() if k >= keep}  # 처리 위치(작업 상태)일 뿐 축적 정보 아님
    nq = merge_queries(state, today)
    for o in led.values(): o["entry_type"] = entry_type(o)
    rl_used, rl_fixed = resolve_links(led, today, int(os.environ.get("RESOLVE_MAX", "20")))
    ad_used, ad_added = aks_drill(led, today, int(os.environ.get("AKS_DRILL_MAX", "30")))
    print(f"첫 화면 링크 해소 {rl_fixed}/{rl_used} · 고문서 소장처 하위 문서 발굴 {ad_added}건({ad_used}회 호출)")
    budget = int(os.environ.get("ENRICH_MAX", "80"))  # 하루 매니페스트 판독 상한(기관 서버 예의 — 순차·간격)
    for o in sorted(led.values(), key=lambda o: o.get("last_seen", ""), reverse=True):
        n_ = enrich(o, budget); budget -= n_
        if n_: time.sleep(0.6)
    for o in led.values(): o["entry_type"] = entry_type(o)
    for o in led.values(): o["entry_type"] = entry_type(o)
    fx_used, fx_changed, fx_pv = fixity_pass(led, today, int(os.environ.get("FIXITY_MAX", "30")))  # v2.35 하루 30건 순환(기관 서버 예의)
    print(f"고정성 재확인 {fx_used}건 · 지문 변경 {fx_changed}건 · 판독기 {fx_pv}")
    def win(o, a, b):  # a~b일 전 사이 발견 횟수
        return sum(n for k, n in o["days"].items() if (today - dt.timedelta(days=b)).isoformat() < k <= (today - dt.timedelta(days=a)).isoformat())
    cut = (today - dt.timedelta(days=90)).isoformat()
    for o in led.values():
        o["days"] = dict(sorted(o["days"].items()))  # v2.26 축적 정보는 지우지 않는다 — 날짜별 이력 전체 보존(이전 90일 제한 해제)
        o["seen_7d"] = win(o, -1, 7); o["seen_30d"] = win(o, -1, 30); prev = win(o, 7, 14)
        o["trend"] = "신규" if o["first_seen"][:10] > (today - dt.timedelta(days=7)).isoformat() else ("↑" if o["seen_7d"] > prev else ("↓" if o["seen_7d"] < prev else "→"))
        o["score"] = round(o["seen_30d"] * 2 + o["seen"] + o.get("days_total", 1) * 3 + (o.get("max_cross", 1) - 1) * 2, 1)  # 최근 활용·지속 활용(일수)·교차확인 가중
    for i, o in enumerate(sorted(led.values(), key=lambda o: (-o["score"], o["key"])), 1): o["rank"] = i
    recs = sorted(led.values(), key=lambda o: (o["first_seen"], o["key"]))
    # v2.27 계층·IIIF가 없는 기록은 만들어 구축 — 원 기관 정보와 구분되는 필드에(partOf_derived · iiif_built)
    for o in recs:
        o["entry_type"] = entry_type(o)
        if o["entry_type"] == "결함 출력": o["defect_note"] = "옛 파서 오류 출력(한국사DB 메뉴 오인 v2.23 수정 · IA 웹 크롤링 묶음 v2.24 수정) — 기록 아님, 증거로 보존"
        else: o.pop("defect_note", None)
        lq_ = link_quality(o)
        if lq_: o["link_note"] = lq_
        else: o.pop("link_note", None)
        dd_, db_ = date_derived(o)
        if dd_: o["date_derived"], o["date_basis"] = dd_, db_
        else: o.pop("date_derived", None); o.pop("date_basis", None)
        if not o.get("partOf"): o["partOf_derived"] = derive_path(o)
        else: o.pop("partOf_derived", None)
        o["iiif_kind"] = "기관 매니페스트" if o.get("iiif") else "브리지 매니페스트(기록 봉투)"
        o["iiif_built"] = "" if o.get("iiif") else leaf_manifest(o)
    with open(lp, "w", encoding="utf-8") as f:
        for o in recs: f.write(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n")
    cols = ["key", "entry_type", "fixity", "defect_note", "link_note", "sources", "title", "date", "date_derived", "date_basis", "id", "url", "partOf", "partOf_derived", "media", "sameAs", "iiif", "iiif_built", "iiif_kind", "found_by", "first_seen", "last_seen", "seen", "seen_7d", "seen_30d", "days_total", "formats", "tools", "max_cross", "trend", "rank", "score", "summary", "rights", "thumb", "meta"]
    fmtv = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":")) if isinstance(v, list) and v and isinstance(v[0], dict) else " | ".join(f"{a}: {b}" for a, b in v) if isinstance(v, list) and v and isinstance(v[0], list) else (" ".join(f"{k}:{n}" for k, n in sorted(v.items(), key=lambda kv: -kv[1])) if isinstance(v, dict) else ("+".join(v) if isinstance(v, list) else v))
    with open(os.path.join(D, "discovered.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); w.writerow(cols)
        for o in recs: w.writerow([fmtv(o.get(c, "")) for c in cols])
    pop = sorted((o for o in recs if o.get("entry_type", "기록") == "기록"), key=lambda o: o["rank"])  # v2.34 인기 순위는 기록만
    with open(os.path.join(D, "popular.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); pc = ["rank", "score", "seen", "seen_7d", "seen_30d", "days_total", "trend", "formats", "sources", "title", "date", "id", "partOf", "partOf_derived", "summary", "url", "iiif", "iiif_built", "first_seen", "last_seen"]; w.writerow(pc)
        for o in pop[:200]: w.writerow([fmtv(o.get(c, "")) for c in pc])
    usage["daily"] = dict(sorted(usage["daily"].items()))  # v2.26 일별 활용 전체 보존(이전 400일 제한 해제)
    json.dump(usage, open(up, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    sets = {}
    graph = []
    for o in recs:
        inst = o["key"].split(":")[0]; ser = o.get("partOf") or o.get("partOf_derived") or "(계열 미상)"
        sid = f"set:{inst}:{ser}"; sets.setdefault(sid, {"@id": sid, "@type": "rico:RecordSet", "rico:title": ser, "rico:isOrWasIncludedIn": {"@id": f"inst:{inst}"},
                                                         **({"rico:generalDescription": "KOREA ARCHIVE 파생 계층(유형·제목 주제부·연대 근거) — 원 기관 계층 아님"} if ser.startswith("[파생]") else {})})
        mf = o.get("iiif") or o.get("iiif_built")
        graph.append({"@id": o.get("url") or f"rec:{o['key']}", "@type": "rico:Record", "rico:title": o["title"], **({"rico:identifier": o["id"]} if o.get("id") else {}),
                      **({"rico:isAssociatedWithDate": o["date"]} if o.get("date") else {}), "rico:isOrWasIncludedIn": {"@id": sid},
                      **({"owl:sameAs": o["sameAs"]} if o.get("sameAs") else {}), **({"rico:hasOrHadInstantiation": {"@id": mf, "@type": "rico:Instantiation", "rico:title": o["iiif_kind"]}} if mf else {}), **({"rico:scopeAndContent": o["summary"]} if o.get("summary") else {}),
                      "prov:wasGeneratedBy": {"@type": "prov:Activity", "prov:label": "KOREA ARCHIVE 통합검색 발견", "prov:startedAtTime": o["first_seen"], "prov:used": o["sources"],
                                             **({"prov:wasInformedBy": [{"@id": f"https://changgi.github.io/korea-archive-mcp/data/provenance.json#{ak}"} for ak in o["found_by"]]} if o.get("found_by") else {})}})
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
          "formats": usage["formats"], "queries": {k: nq[k] for k in ("added", "total", "calls", "by_tool")}, "repeat_records": sum(1 for o in recs if o["seen"] > 1), "entry_types": {t: sum(1 for o in recs if o.get("entry_type", "기록") == t) for t in ("기록", "소장처(컬렉션)", "검색 안내", "결함 출력")}, "site_root_links": sum(1 for o in recs if o.get("link_note")),
          "top10": [{"rank": o["rank"], "seen": o["seen"], "days": o.get("days_total", 1), "title": o["title"][:100], "url": o.get("url", "")} for o in pop[:10]]}
    json.dump(st, open(os.path.join(D, "stats.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(state, open(sp, "w"), indent=1)
    E_ = html.escape
    KV = "https://changgi.github.io/korea-archive-mcp/kv.html?manifest="
    def card(o, big=True):
        th = (f"<img loading='lazy' src='{E_(o['thumb'])}' alt='' referrerpolicy='no-referrer' onerror=\"this.replaceWith(Object.assign(document.createElement('div'),{{className:'ph',textContent:'{E_(o['key'].split(':')[0])}'}}))\">"
              if o.get("thumb_ok") else f"<div class='ph'>{E_(o['key'].split(':')[0])}<small>{'원본 이미지 없음(기록 카드)' if ('card.svg' in (o.get('thumb') or '')) else ('이미지 링크만(권리·게재윤리)' if o.get('thumb') else '이미지 없음')}</small></div>")
        chips = "".join(f"<span>{E_(x)}</span>" for x in [o.get("date"), o.get("id"), o.get("partOf") or o.get("partOf_derived")] if x)
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
    qrow = "".join(f"<tr><td>{E_(o['last'][:16])}</td><td>{E_(o['tool'])}</td><td>{E_(json.dumps(o['args'], ensure_ascii=False)[:140])}</td><td>{o['seen']}</td></tr>" for o in nq["recent"])
    open(os.path.join(D, "index.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>발견 누적 원장 — KOREA ARCHIVE 통합검색</title><link rel="alternate" type="application/atom+xml" title="새로 발견된 기록" href="feed.xml"><style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:1100px;margin:auto;padding:16px}}a{{color:#e0b04a}}
.b0{{display:inline-block;margin:4px 8px 4px 0;padding:6px 12px;border:1px solid #e0b04a;border-radius:6px;text-decoration:none}}
.g{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}}.c{{background:#1c1f26;border:1px solid #2a2d35;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}}
.c img,.ph{{width:100%;height:170px;object-fit:cover;background:#0f1115}}.ph{{height:64px!important;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#6f6e68;font-weight:700;letter-spacing:.05em}}.ph small{{font-weight:400;font-size:12px;margin-top:4px}}
.b{{padding:10px 12px;display:flex;flex-direction:column;gap:6px}}.s{{font-size:12px;color:#9b9a93}}h3{{font-size:15px;margin:0;line-height:1.35}}h3 a{{text-decoration:none}}
.ch span{{display:inline-block;font-size:12px;background:#2a2d35;border-radius:4px;padding:2px 6px;margin:0 4px 4px 0;word-break:break-all}}.sm{{font-size:13px;margin:0;color:#cfcdc5;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}}
details{{font-size:12px}}dl{{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;margin:6px 0}}dt{{color:#e0b04a}}dd{{margin:0;word-break:break-all}}.u{{font-size:12px;color:#9b9a93}}.l{{font-size:13px}}
table{{width:100%;border-collapse:collapse;font-size:14px}}td,th{{border-bottom:1px solid #2a2d35;padding:6px;text-align:left}}</style>
<main><h1>발견 누적 원장</h1><p>KOREA ARCHIVE 통합검색 사용자가 도구로 발굴한 기록이 매일 이곳에 쌓입니다(검색어·사용자 정보 없음). 기록 <b>{st['records']:,}</b>건 · 마지막 갱신 {st['updated']} · 이번 갱신 신규 {new_recs}건 · 내용·메타정보 보강 {enr}건 · 썸네일 {thn}건</p>
<p>{srcs}</p>
<p><a class="b0" href="discovered.csv">CSV 내려받기</a><a class="b0" href="discovered.jsonl">JSONL</a><a class="b0" href="discovered.jsonld">RiC-O JSON-LD</a><a class="b0" href="../kv.html?manifest=https://changgi.github.io/korea-archive-mcp/data/collection.json">KV로 최근 300건 연속 보기</a><a class="b0" href="tree.html">계층구조도</a><a class="b0" href="queries/index.json">질의·회신 축적</a><a class="b0" href="classifications.json">분류 사전</a><a class="b0" href="provenance.json">발견 경로(질의↔기록)</a><a class="b0" href="q/index.html">질의별 발굴 기록(IIIF)</a><a class="b0" href="fixity_changes.json">원문 변경 감시</a><a class="b0" href="feed.xml">새 발견 구독(Atom)</a><a class="b0" href="records.csl.json">인용 CSL-JSON(Zotero)</a><a class="b0" href="records.ris">인용 RIS(EndNote)</a><a class="b0" href="timeline.html">연대 타임라인</a><a class="b0" href="nrich/index.html">연구원 연구DB IIIF 계층</a><a class="b0" href="popular.csv">자주 활용 TOP 200</a><a class="b0" href="stats.json">집계</a></p>
<p style="font-size:13px;color:#9b9a93">주요 내용·메타정보·썸네일은 기관 IIIF·우리 브리지 매니페스트를 하루 한 번 판독해 채웁니다(하루 상한·순차 요청). 썸네일은 재이용 가능 표시가 확인된 것만 싣고, 포로·사망자·묘지·수형자 관련 기록과 허가가 필요한 이미지는 링크만 둡니다. 권리는 원 기관 표기를 따릅니다 — 게재 전 judge_rights로 확인. 모든 변경은 저장소 git 이력(docs/data/)에 남습니다.</p>
<h2>자주 활용되는 기록 TOP 30</h2><p style="font-size:13px">점수 = 최근 30일 발견×2 + 전체 발견 + 발견된 날 수×3 + 교차확인 기관 수 가중. 자동 검사 트래픽 제외.</p><div class="g">{prow}</div>
<h2>일별 활용(최근 14일)</h2><table><tr><th>날짜</th><th>검색 묶음</th><th>발견 기록</th><th>신규 기록</th></tr>{urow}</table><p style="font-size:13px">형식별 누계: {E_(fmtv(usage['formats']))} · <a href="usage.json">usage.json</a></p>
<h2>질의·회신 축적</h2><p style="font-size:13px">모든 도구 호출의 질의와 회신 본문을 원문 그대로(가공·삭제 없이) 영구 보존합니다. 같은 질의·같은 회신은 한 번만 두고 횟수만 셉니다. 회신이 달라지면 새 판으로 남겨 기관 응답 변화의 증거로 씁니다. 고유 질의 {nq['total']}건 · 누적 호출 {nq['calls']}회 · 도구별 {E_(fmtv(nq['by_tool']))} · <a href="queries/index.json">queries/index.json</a> (월별 회신 원문 queries/YYYY-MM.jsonl.gz)</p><table><tr><th>최근</th><th>도구</th><th>질의</th><th>횟수</th></tr>{qrow}</table>
<h2>최근 발견 100건</h2><div class="g">{rows}</div></main></html>""")
    build_tree(recs); ncls = merge_classes(recs); nprov, _orph = build_provenance(recs); nfx = write_fixity(recs); nmed = build_media(recs)
    print(f"원장 {len(recs)}건 (신규 {new_recs}, 묶음 {new_batches})")
    print(f"질의 고유 {nq['total']}건(신규 {nq['added']}) · 분류 경로 {ncls}개 · 발견 경로 질의 {nprov}종 · 다매체(피드 {nmed[0]}·인용 {nmed[1]}·연대 {nmed[2]})")

if __name__ == "__main__":
    main()
