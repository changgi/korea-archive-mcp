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

def ktv_id(u):
    """v3.5 lib/ka_iiif.js ktvId 패리티 — e영상역사관 상세 URL → '{photo|movie}~mediasrcgbn~mediaid~mediadtl[~mediagbn]'."""
    m = re.search(r"ehistory\.go\.kr/view/(photo|movie)\?(\S+)", str(u or ""))
    if not m: return ""
    q = dict(urllib.parse.parse_qsl(m[2].replace("&amp;", "&")))
    v = [q.get(k, "") for k in ("mediasrcgbn", "mediaid", "mediadtl")]
    return "~".join([m[1], *v] + ([q["mediagbn"]] if q.get("mediagbn") else [])) if all(v) else ""

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
    se_ = re.search(r"archives\.seoul\.go\.kr/item/(\d{1,9})(?:[?#]|$)", u)
    if se_: return f"{O}/iiif/seoul/{se_[1]}/manifest.json"  # v3.10 서울기록원 브리지(Node 패리티)
    kw_ = re.search(r"koreanwar\.or\.kr(?::8443)?/searchDetail\.do\?archRfcd=(\d{4}-[A-Z]{2}-\d{2}-[A-Z]{2}-[A-Z]-\d+)", u)
    if kw_: return f"{O}/iiif/kw/{kw_[1]}/manifest.json"  # v3.5.2 6·25전쟁 아카이브센터 브리지(Node 패리티)
    kt = ktv_id(u)
    if kt: return f"{O}/iiif/ktv/{urllib.parse.quote(kt, safe='')}/manifest.json"  # v3.5 KTV e영상역사관 브리지(Node ktvId 패리티)
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

AR_PARSER_V = "ar1"  # v2.51 국가기록원 상세 판독기 판 — 아래 archives_fields를 고치면 올린다(지문 변경을 '판독기 변경 동반'으로 구분)

def archives_fields(url):
    """국가기록원 상세(공개 페이지) 표 판독 — (기술 항목 dict, 제목 목록[건, 상위 철…]). 상세 표가 없으면 ValueError."""
    r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=25)
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
    return f, titles

def enrich_archives(o):
    """국가기록원 상세(공개 페이지) 1회 판독 — 매니페스트가 없는 기록의 메타정보·실제 계층(기록물계열 › 상위 철) 구축."""
    f, titles = archives_fields(o["url"])
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
        "aks": ("nedb_search", lambda o: o.get("aks_cat") and o.get("id") and {"mode": "aks", "query": f"{o['aks_cat']}/{o['id']}"}),
        "earchive": ("nedb_search", lambda o: "catalogView.do?systemId=" in (o.get("url") or "") and {"mode": "earchive", "query": o["url"]}),
        "okchf": ("nedb_search", lambda o: o.get("url") and {"mode": "okchf", "query": o["url"]}),
        "nrich": ("nedb_search", lambda o: {"mode": "nrich", "query": o["id"] if re.match(r"^(ksm|portrait|gwaebul|diary|mokgan|jcbib|jcphoto|dict|arch|koguryo|gaesong|design|pattern|oldbook|hyanggyo|stone|journal|iron|dolmen|assay|material):", str(o.get("id", ""))) else o.get("url")} if (o.get("id") or o.get("url")) else None)}
DEEP["nedb"] = ("nedb_search", lambda o: re.match(r"^[a-z]{2,5}_[0-9a-z_]+$", o["key"].split(":", 1)[1]) and {"mode": "item", "query": o["key"].split(":", 1)[1]})  # v2.61 한국사DB 기록(levelId) — 시대별 경로 판독
DEEP["nlk"] = ("nlk_search", lambda o: o.get("id") and o.get("title") and {"query": re.sub(r"\s*[:;\[].*$", "", o["title"])[:60] or o["title"][:60], "max_results": 20})  # v2.72 국립중앙도서관 — 같은 기록 번호 줄만(nlk_own)
DEEP["kyudb"] = ("nedb_search", lambda o: re.match(r"^[^\x00-\x7f]{1,4}[0-9][0-9.\-]*$", str(o.get("id") or "")) and {"mode": "kyujanggak", "query": o["id"]})  # v2.55 규장각 해제(기관 해설문) — 같은 청구기호 행만 쓴다
IIIF_V = {"koreanwar": 2, "ktv": 2, "seoul": 2, "awm": 2, "commons": 3, "europeana": 2, "heritage": 2, "much": 2, "nrich": 2, "nara": 3, "tna": 2, "ia": 2, "ndl": 2, "gallery": 2}  # v2.76 권리/출처 표기 분리로 IIIF 기록 전부 재판독  # commons 2 = 범주(Commons, 숨김 제외)  # v2.63 우리 IIIF 브리지 판 — awm 2 = 기관 상세 표 전부(자료 유형·매체 형태·제작자·제작지·분쟁)와 본문 설명
DEEP_V = {"oldnews": 2, "seoul": 2, "aks": 2, "jsg": 2, "nedb": 5, "un": 2}  # nedb 5 = 실패 응답으로 비워진 메타 복구(v2.69.3)  # nedb 4 = 기술 항목 줄 판별 엄격화(v2.69.2)  # nedb 3 = 법전 조문 판독 교정(v2.69.1 — 검색창 문구 오인)  # un 2 = 기관 MARC XML(제목·문서기호·유형·날짜·의제)  # v2.61.1 nedb 2 = 표 없는 기록(삼국사기)·원문 이미지만(신문) 판독  # v2.56 jsg 2 = 장서각 개체 태깅·인물 전거(UCI)  # v2.32 판독기 판 — 판이 오르면 이미 보강된 기록도 한 번 다시 판독(서울기록원: 기관 계층·생산자·보존이력 추가)
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

def nlk_own(txt, vid):
    """nlk_search 응답에서 이 기록 번호(viewKey·cno)의 줄만 — '- 제목 [자료유형] · 발행처 (날짜) 링크'. (요약 없음, 메타)."""
    for ln in txt.splitlines():
        if not ln.startswith("- ") or not re.search(rf"(?:viewKey|cno)={re.escape(vid)}(?:[&\s]|$)", ln): continue
        m = re.match(r"^- (.+?) \[([^\]]+)\](?: · (.+?))?(?: \(([^()]{2,20})\))? (https?://\S+)$", ln.strip())
        if not m: continue
        md = [["자료유형", m[2]]] + ([["발행처", m[3].strip(" ,")]] if m[3] else []) + ([["발행", m[4]]] if m[4] else [])
        md.append(["원문 열람", "원문 이미지 뷰어(디지털화 원문 공개)" if "viewer.nl.go.kr" in m[5] else "소장 정보(원문 열람은 기관 확인)"])
        if "viewer.nl.go.kr" in m[5]: md.append(["원문 뷰어", m[5]])
        return "", md
    return "", []

def kyu_own(txt, cid):
    """규장각 판독 응답에서 이 청구기호([奎NNNN]) 행의 서지와 해제 원문만. (요약, 메타)."""
    L = txt.splitlines(); row = ""; hj = ""
    for i, x in enumerate(L):
        if x.startswith(f"- [{cid}]"):
            nx = L[i + 1] if i + 1 < len(L) else ""
            own = nx.startswith("  해제:")  # 들여쓴 '해제:'만 이 책의 해제(들여쓰지 않은 '해제: N건'은 다음 절 머리)
            if not row or own: row = x[len(f"- [{cid}]"):].strip()
            if own and not hj: hj = nx.strip()[3:].strip()
    parts = [p.strip() for p in row.split(" · ")]
    md = [[k, v] for k, v in zip(("서명", "편저자", "연대", "분류"), parts) if v]
    if hj: md.append(["해제(규장각, 앞부분)", hj[:300]])
    return (f"[규장각 해제] {hj}" if hj else ""), md

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
                if re.search(r"조회 실패|파싱 실패|상세 파싱 실패|오류\(|시간 초과|브라우저로 열람|상세 미발견|메타 미검출|자동조회 실패|다음 단계\(안내\)", txt[:600]): raise ValueError("판독 실패 응답 — 보강하지 않음(기존 값 보존, 다음 날 재시도)")  # v2.69.3 실패를 성공으로 받아 메타를 비우던 결함
                if src0 == "nedb" and re.search(r"문자입력기|AND OR", txt[:600]): raise ValueError("판독 결함 출력(검색창 문구) — 보강하지 않음")  # v2.69.1 방어
                if src0 == "nedb":  # v2.61 한국사DB 원문 — 기술 항목 줄(제목·연월일·출전…)은 메타로, 본문 앞부분은 요약으로(미공개·실패는 요약 비움)
                    L2 = txt.splitlines()
                    is_meta = len(L2) > 1 and re.match(r"^[가-힣A-Za-z ()]{1,12}: ", L2[1]) and all(re.match(r"^[가-힣A-Za-z ()]{1,12}: ", p) for p in L2[1].split(" · "))  # v2.69.2 기술 항목 줄만(본문 속 '‘一’: [만력]' 같은 콜론 오인 방지)
                    md = [[p.split(": ", 1)[0], p.split(": ", 1)[1]] for p in L2[1].split(" · ")] if is_meta else []
                    bi = 2 if md else 1
                    summ = f"[한국사DB 원문 앞부분] {L2[bi][:380]}" if len(L2) > bi and not re.search(r"공개되지 않았|조회 실패|본문 텍스트 없음", txt[:1200]) else ""
                    if "공개되지 않았" in txt[:400]: md = [["본문 공개", "미공개 — 항목·URL은 유효, 기관 공개 범위(국사편찬위원회 문의 대상)"]]  # 부재가 아니라 비공개라는 증거
                    if "본문 텍스트 없음" in txt[:1200]: summ = ""; md = md + [["본문 공개", "원문 이미지(지면)만 — 텍스트 없음(미공개 아님)"]]  # v2.61.1
                if src0 == "nlk":  # v2.72 같은 기록 번호 줄만(검색 순위·다른 기록은 섞지 않음)
                    summ, md = nlk_own(txt, o["id"])
                    if not md: raise ValueError("검색 응답에 이 기록 줄이 없음 — 보강하지 않음")
                if src0 == "kyudb":  # v2.55 규장각 — 같은 청구기호 행의 서지와 해제 원문만(다른 책의 해제·안내 문구 제외)
                    summ, md = kyu_own(txt, o["id"])
                if src0 == "aks":  # v2.40.2 고문서 문서 판독은 면 목록 — 요약은 머리줄의 면 수·UCI만(파일명 나열 아님)
                    hm = re.search(r"문서 '(.+?)' — (\d+)면(?: · UCI (\S+))?", txt)
                    summ = f"{hm[2]}면{' · UCI ' + hm[3] if hm[3] else ''} — 한국고문서자료관 원문 이미지(뷰어 열람)" if hm else ""
                    md = [["면 수", hm[2]]] + ([["UCI", hm[3]]] if hm and hm[3] else []) if hm else md
                if summ or src0 not in ("kyudb", "nedb", "nlk"): o["summary"] = (summ + " " if summ else "") + f"(KOREA ARCHIVE 심층 판독 {tool})"  # 규장각 해제가 없으면 요약을 비워 둔다(서지는 메타·메타 합성으로)
                if md or not o.get("meta"):  # v2.69.3 빈 판독 결과로 축적된 메타를 지우지 않는다
                    nk = {m[0] for m in md}
                    o["meta"] = md + [m for m in (o.get("meta") or []) if m and m[0] not in nk]  # v2.79 기존에만 있던 항목 보존
                o["deep_call"] = f"{tool}({json.dumps(args, ensure_ascii=False)})"; o["enrich_status"] = "ok"; o["deep_v"] = DEEP_V.get(src0, 1)
                um = re.search(r"인물 전거\(한국역대인물 UCI\):\s*(.+)", txt)  # v2.56 기관이 붙인 인명 전거 — 이름=UCI
                if um: o["authority"] = {"scheme": "한국역대인물 UCI(장서각 태깅)", "persons": dict(x.split("=", 1) for x in um[1].strip().split("; ") if "=" in x)}
                hv = next((v for k, v in md if k == "계층"), "")
                if hv and not o.get("partOf"): o["partOf"] = hv; o["partOf_src"] = "기관 상세 판독(브레드크럼)"  # 원 기관 계층 — [파생] 아님
            except Exception:
                o["enrich_status"] = "fail"
            o["enriched"] = today; o["thumb_ok"] = False
            return 1
    if any("[object Object]" in str(x[1]) for x in (o.get("meta") or []) if x and len(x) > 1): o["iiif_v"] = 0  # v3.6.3 '[object Object]'로 판독된 접근 제한 — 브리지 교정 뒤 다시 판독
    rebridge = bool(m) and src0 in IIIF_V and o.get("enrich_status") == "ok" and o.get("iiif_v", 1) < IIIF_V[src0] and budget > 0  # v2.63 브리지 판이 오르면 한 번 다시 판독
    if o.get("enriched") and not rebridge and (o.get("enrich_status") != "fail" or o["enriched"] > (dt.date.today() - dt.timedelta(days=1)).isoformat()):
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
            sm_ = strip(L1(j.get("summary")) or L1(j.get("description")))[:400]
            if sm_ or not o.get("summary"): o["summary"] = sm_  # v2.69.3 빈 매니페스트 요약으로 축적된 요약을 지우지 않는다
            md = []
            for e in (j.get("metadata") or [])[:12]:
                k, v = strip(L1(e.get("label"))), strip(L1(e.get("value")))
                if k and v and k not in ("판독 시각", "변환", "발견 시각", "발견 경로") and len(md) < 10: md.append([k[:30], v[:140]])
            if md or not o.get("meta"):  # v2.69.3 빈 매니페스트 메타로 축적된 메타를 지우지 않는다
                nk = {m[0] for m in md}
                o["meta"] = md + [m for m in (o.get("meta") or []) if m and m[0] not in nk]  # v2.79 새 메타 + 기존에만 있던 항목 보존(8개 상한으로 잘려 나가던 결함)
            # v2.76 권리 = rights·license(권리 URI·문구)만. requiredStatement·attribution은 '출처 표기'라 권리로 쓰지 않는다 —
            #   Europeana·국가유산청·역사박물관 매니페스트의 출처 문구(제목 - 링크)가 권리 칸에 들어가던 결함. 출처 표기는 attribution 필드에 따로.
            rq = strip(L1((j.get("requiredStatement") or {}).get("value"))) or strip(L1(j.get("attribution")))
            rl = strip(L1((j.get("requiredStatement") or {}).get("label")))
            lic = j.get("rights") or strip(L1(j.get("license")))
            if not lic and rq and (RIGHTS_KEY.search(rl) or OPEN_RIGHTS.search(rq) or NO_DERIV.search(rq) or re.search(r"rightsstatements|creativecommons|저작권|공공누리|rights reserved", rq, re.I)): lic = rq
            if rq: o["attribution"] = rq[:300]
            o["rights"] = str(lic or "")[:200]  # 출처 문구가 권리로 들어가 있던 값은 attribution으로 옮겨 보존된다(지우는 것이 아니라 제자리로)
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
            o["enrich_status"] = "ok"; o["iiif_v"] = IIIF_V.get(src0, 1)
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
DATE_KEYS = ("생산일", "생산연도", "생산", "연대", "날짜", "시대", "시대분류", "출판정보", "발행", "발행일", "제작연도", "제작시기", "국적/시대", "작성연대 / 간행시기", "생산기간", "발간연도", "date", "발행년도", "기간", "생산 기간", "생산시기", "Publication Date", "일자", "연월일", "발신일", "발행년월일", "포괄 기간(이 기록)")  # v2.56 연구원 발행년도·TNA 기간·6·25 생산시기·NDL 발행일·서울 일자  # v2.50 생산기간(전자사료관)·발간연도(국외문화유산)·date(IA·Europeana) — 인수·등록·업로드일(보존이력·addeddate)은 넣지 않는다
ERA_KEYS = ("시대", "시대분류", "제작시기", "국적/시대")

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

def date_derived(o):
    """v2.32 심층 판독 응답의 '라벨 붙은' 자기 날짜만 — 신문 발행일(제호 · YYYYMMDD · 발행)·판결일(판결 YYYYMMDD). 본문 속 연도는 쓰지 않는다."""
    if o.get("date"): return "", ""
    sm = o.get("summary") or ""
    m = re.search(r"판결 (1[0-9]\d\d|20\d\d)(0[1-9]|1[0-2])([0-3]\d)(?!\d)", sm)
    if m: return f"{m[1]}-{m[2]}-{m[3]}", "심층 판독 — 판결일"
    m = re.match(r"^[^·]{1,40} · (1[0-9]\d\d|20\d\d)(0[1-9]|1[0-2])([0-3]\d) · 발행", sm)
    if m: return f"{m[1]}-{m[2]}-{m[3]}", "심층 판독 — 신문 발행일"
    m = re.match(r"^\[한국사DB 원문 앞부분\] (1[0-9]\d\d|20\d\d)년 (0[1-9]|1[0-2])월 ([0-3]\d)일", sm)  # v2.71 한국사DB 본문 머리의 서기 날짜(국사편찬위원회 환산 — 왕력 '광해군 9년' 등을 우리가 환산하지 않는다)
    if m: return f"{m[1]}-{m[2]}-{m[3]}", "기관 본문 머리 날짜(한국사DB 서기 표기)"
    if o["key"].startswith("jsg:"):  # v2.71 장서각 해제 '정의' 첫 문장의 연도(기관 집필 — '1828년(순조 28)에 …', '…에서 1917년에 인쇄·발행한')
        m = re.match(r"^정의\s+[^。.]{0,40}?(1[0-9]\d\d)(?:\s*~\s*(1[0-9]\d\d))?년", sm)
        if m: return m[1], "기관 해제 정의문 연도(장서각)" + (f" — 기간 {m[1]}~{m[2]}" if m[2] else "")
    md = {k: str(v) for k, v in (o.get("meta") or [])}
    m = re.match(r"^\s*(1[0-9]\d\d|20\d\d)(?:\.(0[1-9]|1[0-2]))?(?:\.([0-3]\d))?\s*(?:~|$)", md.get("생산기간", ""))  # v2.50 전자사료관 생산기간 시작(1950.12.21 ~ …)
    if m: return "-".join(x for x in m.groups() if x), "기관 메타 — 생산기간(시작)"
    m = re.match(r"^\s*(1[0-9]\d\d|20\d\d)\s*년?\s*$", md.get("발간연도", ""))
    if m: return m[1], "기관 메타 — 발간연도"
    m = re.match(r"^((?:ca\. )?(1[0-9]\d\d|20\d\d)(?:~(?:ca\. )?(1[0-9]\d\d|20\d\d))?)$", md.get("포괄 기간(이 기록)", ""))  # v3.0 NARA coverage/inclusive(파일단위·영상 아이템 — productionDates 없음)
    if m: return m[1], "기관 메타 — 포괄 기간(이 기록, NARA coverage·inclusive)"
    m = re.match(r"^((?:ca\. )?(1[0-9]\d\d|20\d\d)(?:~(?:ca\. )?(1[0-9]\d\d|20\d\d))?) — (\w+ NAID \d+)", md.get("포괄 기간(상위 계층)", ""))
    if m and int(m[3] or m[2]) - int(m[2]) <= 10: return m[1], f"상위 계층 포괄 기간({m[4]}) — 이 기록 자체 날짜 아님, 범위 10년 이하만"
    m = re.match(r"^\s*(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (1[89]\d\d|20\d\d)\b", md.get("date", ""))  # v2.84 IA 영문 날짜 'October 24, 1950–…'(첫 날짜)
    if m: return f"{m[3]}-{MONTHS.index(m[1]) + 1:02d}-{int(m[2]):02d}", "기관 메타 — date(영문 표기, 범위면 첫 날짜)"
    for k_ in ("생산일", "생산시기", "발행일", "발신일", "발행년월일", "제작연도", "생산연도", "발행년도", "일자", "날짜", "Publication Date", "시대"):  # v3.5.4 생산시기(6·25전쟁 아카이브센터 'YYYY-MM-00 ~ …')·날짜  # v3.0.2 라벨 붙은 기관 날짜 칸(생산일 Date made·발행일·발신일) — 읽지 않던 공백
        dv_, q_ = meta_date(md.get(k_, ""), era=(k_ == "시대"))
        if dv_: return dv_, f"기관 메타 — {k_}" + (f"({q_})" if q_ else "") + (" · 위키미디어 공용 업로더 기재(2차 정보)" if o["key"].startswith("commons:") else "")
    return title_date(o.get("title") or "")


def meta_date(v, era=False):
    """v3.0.2 기관 날짜 칸 값 → 정규 날짜. 반환 (날짜, 한정어). 세기·왕조·기원전·불명은 날짜로 쓰지 않는다(연대 decade가 맡음).
    era=True(시대 칸)는 단일 서기 연도만('1911' · '1887년(고종24)' · '조선 태조 7년(1398)')."""
    v = str(v or "").strip(); Y = r"(1[0-9]\d\d|20[0-2]\d)"
    if not v or re.search(r"기원전|BC|不明|불명|미상", v): return "", ""
    mm = re.match(r"^(\d{4})-(\d{2})-(\d{2})\s*~\s*(\d{4})-(\d{2})-(\d{2})$", v)  # v3.5.4 6·25전쟁 아카이브센터 생산시기 — '-00'은 미상, '0000'은 날짜 없음
    if mm:
        a_ = "-".join(x for x in mm.groups()[:3] if x not in ("00", "0000")) if mm[1] != "0000" else ""
        b_ = "-".join(x for x in mm.groups()[3:] if x not in ("00", "0000")) if mm[4] != "0000" else ""
        if not a_ or not re.match(r"^" + Y, a_): return "", ""
        return (a_, "") if (not b_ or b_ == a_) else ((f"{a_[:4]}~{b_[:4]}", "범위") if a_[:4] != b_[:4] else (a_[:7] if a_[:7] == b_[:7] else a_[:4], "범위"))
    if era:
        m = re.match(r"^" + Y + r"년?(?:\s*\([^)]*\))?$", v) or re.search(r"\d+년\s*\(" + Y + r"\)$", v)
        return (m[1], "") if m else ("", "")
    q = []
    m = re.search(r"\(" + Y + r"년\s*(\d{1,2})월(?:\s*(\d{1,2})일)?\s*(\(음\))?\s*\)", v)  # 한국사DB 발신일 '癸卯十月二十七日 (1783년 10월 27일 (음))' — 기관 환산 서기
    if m:
        return "-".join([m[1], m[2].zfill(2)] + ([m[3].zfill(2)] if m[3] else [])), "기관 서기 환산" + (" · 음력" if m[4] else "")
    if re.match(r"^c\.?\s", v): q.append("c — 대략"); v = re.sub(r"^c\.?\s*", "", v)
    if "Exif" in v: q.append("Exif 촬영 정보")
    v = re.sub(r"^Taken on\s+", "", re.sub(r"\s*\(according to Exif data\)?", "", v)).strip()
    ys = sorted({int(y) for y in re.findall(r"(?<!\d)" + Y + r"(?!\d)", v)})
    if len(ys) > 1 and re.search(r"[-–~;]", v): return f"{ys[0]}~{ys[-1]}", " · ".join(q + ["범위"])
    m = re.match(r"^" + Y + r"-(0[1-9]|1[0-2])-([0-3]\d)(?:[ T][\d:]+)?$", v)
    if m: return f"{m[1]}-{m[2]}-{m[3]}", " · ".join(q)
    m = re.match(r"^([0-3]?\d) (" + "|".join(MONTHS) + r") " + Y + r"$", v)
    if m: return f"{m[3]}-{MONTHS.index(m[2]) + 1:02d}-{int(m[1]):02d}", " · ".join(q)
    m = re.match(r"^(" + "|".join(MONTHS) + r") " + Y + r"$", v)
    if m: return f"{m[2]}-{MONTHS.index(m[1]) + 1:02d}", " · ".join(q)
    m = re.match(r"^" + Y + r"(?:[.-](0?[1-9]|1[0-2]))?(?:[.-]([0-3]?\d))?\.?$", v)
    if m: return "-".join([m[1]] + [x.zfill(2) for x in (m[2], m[3]) if x]), " · ".join(q)
    return "", ""


_MON = "|".join(MONTHS)
def title_date(t):
    """v3.0.1 기관 표제 속 명시 날짜 — 형식이 분명한 것만(괄호 날짜·'on D Month YYYY'·'Month D, YYYY'·끝의 ', YYYY'·첫머리 'YYYY년').
    본문 중간의 맨 연도('1950 INVASION …')·번호('Nr. 1939.')는 쓰지 않는다. 표제 날짜는 내용 시점(촬영·사건)일 수 있음을 근거에 적는다."""
    t = re.sub(r"^\[[^\]]{0,160}\]\s*", "", t)  # 원장 꼬리표·수집처 표시
    Y = r"(1[5-9]\d\d|20[0-2]\d)"; B = "기관 표제 속 날짜(제목 원문 — 내용·사건 시점일 수 있음)"
    if re.search(r"\b(?:" + _MON + r"|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b", t) and re.search(r"\d\s?(?:-|–|through|to)\s?(?:" + _MON + r"|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b", t):  # 기간 표제('Feb. 8, 1876 - Aug. 22, 1876', 'March 2, 1919 through March 13, 1919') — 연도 범위로
        ys = sorted({int(y) for y in re.findall(r"(?<!\d)" + Y + r"(?!\d)", t)})
        if ys: return (f"{ys[0]}~{ys[-1]}" if len(ys) > 1 else str(ys[0])), B + " — 기간 표제"
    m = re.search(r"\(" + Y + r"(?:\.\s*(0?[1-9]|1[0-2]))?(?:\.\s*([0-3]?\d))?\.?\)", t)
    if m: return "-".join([m[1]] + [x.zfill(2) for x in (m[2], m[3]) if x]), B
    m = re.search(r"(?<![\d-])" + Y + r"-(0[1-9]|1[0-2])-([0-3]\d)(?![\d-])", t)  # AWM 'Kapyong Valley, Korea. 1952-04-16.'
    if m: return f"{m[1]}-{m[2]}-{m[3]}", B
    m = re.search(r"(?:^|(?<![Nn]o)(?<!Nr)(?<!Vol)[.,]\s)(" + _MON + r") " + Y + r"\.(?:\s|$)", t)  # AWM 캡션 날짜 칸 'Kapyong, South Korea. June 1952. …'
    if m: return f"{m[2]}-{MONTHS.index(m[1]) + 1:02d}", B
    m = re.search(r"(?:^|(?<![Nn]o)(?<!Nr)(?<!Vol)[.,]\s)" + Y + r"-(0[1-9]|1[0-2])\.(?:\s|$)", t)  # 'Taegu, Korea. 1951-04. …'
    if m: return f"{m[1]}-{m[2]}", B
    m = re.search(r"\b([0-3]?\d) (" + _MON + r") " + Y + r"\b", t)
    if m: return f"{m[3]}-{MONTHS.index(m[2]) + 1:02d}-{int(m[1]):02d}", B
    m = re.search(r"\b(" + _MON + r") ([0-3]?\d), " + Y + r"\b", t)
    if m: return f"{m[3]}-{MONTHS.index(m[1]) + 1:02d}-{int(m[2]):02d}", B
    m = re.search(r", " + Y + r"(?:\s*[-–~]\s*" + Y + r")?\s*(?:\.\w{3,4})?$", t)
    if m: return m[1] + (f"~{m[2]}" if m[2] else ""), B
    m = re.match(r"^" + Y + r"년(?!대)", t)
    if m: return m[1], B
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
    if o["key"].startswith("nedb:"):  # v2.71 한국사DB의 시대별 DB 구분(기관 분류 — /joseon/·/ancient/ 경로, 법전·편람은 조선 구획) — 날짜가 없을 때만
        em = re.match(r"한국사DB › (조선|고대|근대|현대)", o.get("partOf") or "")
        if em: return {"조선": "조선시대", "고대": "고대", "근대": "근대", "현대": "현대"}[em[1]]
        if o["key"].startswith("nedb:jlaw"): return "조선시대"
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
    base = {"고대": 300, "근대": 1900, "현대": 1960, "선사": -3000, "고조선": -1000, "삼국": 300, "고구려": 300, "백제": 300, "신라": 300, "가야": 300, "통일신라": 800, "발해": 800, "남북국": 800, "고려": 1100, "조선": 1600, "대한제국": 1900, "일제강점기": 1925, "광복 이후(1945~)": 1965, "대한민국(1948~)": 1970}
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
    if o.get("iiif") and not o.get("iiif_status"): return o["iiif"]  # v2.52 기관 매니페스트가 비공개 응답이면 브리지
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
        leaves = "".join(f"<li class='r'><a href='{E_(o.get('url') or '#')}'>{E_(o['title'][:110])}</a>{' <span>' + E_(' · '.join(x for x in (o.get('date'), o.get('id')) if x)) + '</span>' if o.get('date') or o.get('id') else ''} <a class='kv' href='{KV}{E_(leaf_manifest(o))}'>KV</a> <a class='kv' href='r/{rec_slug(o["key"])}.html'>기록</a></li>" for o in n["recs"][:200])
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
    i = r.get("i") or ""
    if h == "ktv":  # v2.69 KTV 개별 영상 = mediadtl — 수집기 개편으로 key가 URL·'분류:번호'로 갈려 같은 영상이 둘이 되던 결함
        md = re.search(r"mediadtl=(\d+)", r.get("u") or "") or re.search(r":(\d+)$", i)
        if md: return f"ktv:{md.group(1)}"
    if h == "nlk" and i and not re.search(r"\d", i) and r.get("u"):  # v2.67 nlk 옛 수집기의 분류어 id(자료유형) — 기록 번호(viewKey)로. 다른 수집처는 숫자 없는 고유 식별자(IA 등)를 쓰므로 적용하지 않는다
        vk = re.search(r"viewKey=([^&#\s]+)", r["u"]); i = vk.group(1) if vk else ""
    return f"{h}:{i or r.get('u') or r.get('t', '')[:80]}"

def recover_from_replies(led):
    """v2.67 축적된 회신 원문(queries/*.jsonl.gz)에서 원장에 없는 nlk 기록을 복원 — 옛 분류어 key 충돌로 첫 기록만 남고 사라졌던 기록.
    회신에 실제로 있던 값(제목·날짜·URL)만 옮기고, 복원 근거(질의 지문·회신 판)를 recovered에 남긴다. 사용자 질의만(점검 질의 제외)."""
    import gzip
    qd = os.path.join(D, "queries"); add = 0
    rx = re.compile(r"^- \[([a-z0-9_·+]*nlk[a-z0-9_·+]*)\] (.+?)(?: \(([^()]{2,24})\))? (https://www\.nl\.go\.kr/NL/contents/search\.do#viewKey=([^&\s]+)&viewType=\w+)\s*$", re.M)
    for f in sorted(os.listdir(qd)) if os.path.isdir(qd) else []:
        if not f.endswith(".jsonl.gz"): continue
        for ln in gzip.open(os.path.join(qd, f), "rt", encoding="utf-8"):
            if not ln.strip(): continue
            q = json.loads(ln)
            if not q.get("z") or "ledger" in str((q.get("args") or {}).get("sources", "")): continue
            try: body = zlib.decompress(base64.b64decode(q["z"] + "=" * (-len(q["z"]) % 4)), -15).decode("utf-8", "replace")
            except Exception: continue
            if "nl.go.kr" not in body: continue
            rows = [(m[1], m[2], m[3] or "", m[4], m[5]) for m in rx.finditer(body)]
            for r in _csv_rows(body):
                vk = re.search(r"viewKey=([^&\s]+)", r.get("url") or "")
                if vk and "nlk" in (r.get("sources") or ""): rows.append((r.get("sources"), r.get("title", ""), r.get("date", ""), r["url"], vk.group(1)))
            for srcs, title, date, url, vk in rows:
                k = f"nlk:{vk}"
                if k in led: continue
                ak = q.get("ak") or arg_key(q.get("tool", ""), q.get("args") or {})
                led[k] = {"key": k, "sources": ["nlk"], "title": html.unescape(title.strip())[:300], "date": date.strip(), "id": vk, "url": url, "partOf": "", "media": "", "sameAs": "",
                          "first_seen": q.get("first", ""), "last_seen": q.get("last", q.get("first", "")), "seen": 1, "tools": [q.get("tool", "cross_search")],
                          "days": {q.get("first", "")[:10]: 1}, "days_total": 1, "formats": {}, "max_cross": len(str(srcs).split("+")), "found_by": [ak],
                          "found_by_basis": {ak: "회신 본문 대조(복원)"}, "recovered": f"v2.67 질의 회신 원문에서 복원 — 옛 분류어 key 충돌로 원장에 없던 기록(queries/{f} k={q.get('k', '')})"}
                add += 1
    return add

NEDB_ERA = {"bb": ("조선", "비변사등록"), "ks": ("조선", "각사등록"), "kd": ("근대", "한국독립운동사자료"), "ij": ("근대", "대한민국임시정부자료집"), "npda": ("근대", "동아일보"),
            "dh": ("현대", "자료대한민국사"), "pn": ("현대", "휴전회담회의록"), "sg": ("고대", "삼국사기")}

def harvest_deep_replies(led):
    """v2.68 개별 심층 검색(nedb_search 법전·등록류·통합·KTV) 회신에 나온 기록을 원장 발견으로 거둔다 — 원장 적재가 cross_search에서만 일어나
    사용자가 개별 도구로 찾은 기록이 질의·회신 원문에만 남던 공백. 회신에 있던 값(ID·제목·연도·URL)만, 근거(질의 지문·모드)를 harvested에. 사용자 질의만."""
    import gzip
    qd = os.path.join(D, "queries"); add = 0
    ktv_have = {(re.search(r"mediadtl=(\d+)", o.get("url") or "") or [None, None])[1] for k, o in led.items() if k.startswith("ktv:")}  # 개별 영상 = mediadtl(mediaid는 시리즈)
    for f in sorted(os.listdir(qd)) if os.path.isdir(qd) else []:
        if not f.endswith(".jsonl.gz"): continue
        for ln in gzip.open(os.path.join(qd, f), "rt", encoding="utf-8"):
            if not ln.strip(): continue
            q = json.loads(ln); a = q.get("args") or {}; mode = a.get("mode", "total")
            if q.get("tool") != "nedb_search" or mode not in ("law", "record", "total", "ktv", "sjw") or not q.get("z"): continue
            try: body = zlib.decompress(base64.b64decode(q["z"] + "=" * (-len(q["z"]) % 4)), -15).decode("utf-8", "replace")
            except Exception: continue
            ak = q.get("ak") or arg_key(q.get("tool", ""), a); head = ""
            for line in body.splitlines():
                if line.startswith("- "): head = line[2:].strip(); continue
                u = line.strip()
                m1 = re.fullmatch(r"https://db\.history\.go\.kr/id/([a-z]+_[0-9a-z_]+)", u)
                m2 = re.fullmatch(r"https://www\.ehistory\.go\.kr/view/movie\?\S*mediadtl=(\d+)\S*", u)
                if not head or not (m1 or m2): continue
                if m1:
                    lid = m1[1]; k = f"nedb:{lid}"
                    if k in led: head = ""; continue
                    title = re.sub(r"^\[[^\]]+\]\s*", "", head); era = NEDB_ERA.get(lid.split("_")[0])
                    dm = re.search(r"_(1[5-9]\d\d|20\d\d)_(\d\d)_(\d\d)", lid)
                    part = ("한국사DB › 법전·편람 › " + title.split(" ")[0]) if lid.startswith("jlaw") else (f"한국사DB › {era[0]} › {era[1]}" if era else "")
                    o = {"key": k, "sources": ["nedb"], "title": title[:300], "date": f"{dm[1]}-{dm[2]}-{dm[3]}" if dm else "", "id": lid, "url": u, "partOf": part}
                else:
                    if m2[1] in ktv_have: head = ""; continue
                    ktv_have.add(m2[1]); k = f"ktv:{m2[1]}"
                    ym = re.search(r"\((1[89]\d\d|20\d\d)\)\s*$", head)
                    cat = (re.match(r"^\[([^\]]+)\]\s*", head) or [None, ""])[1]  # 기존 원장 형식: 제목은 분류 머리 없이, 계층 '영상 › 분류'
                    o = {"key": k, "sources": ["ktv"], "title": re.sub(r"\s*\((1[89]\d\d|20\d\d)\)\s*$", "", re.sub(r"^\[[^\]]+\]\s*", "", head))[:300], "date": ym[1] if ym else "", "id": "", "url": u,
                         "partOf": f"영상 › {cat}" if cat else ""}
                o.update({"media": "", "sameAs": "", "first_seen": q.get("first", ""), "last_seen": q.get("last", q.get("first", "")), "seen": 1, "tools": ["nedb_search"],
                          "days": {q.get("first", "")[:10]: 1}, "days_total": 1, "formats": {}, "max_cross": 1, "found_by": [ak], "found_by_basis": {ak: "심층 검색 회신(거둠)"},
                          "harvested": f"v2.68 nedb_search(mode={mode}) 회신에서 거둠 — 질의 지문 {ak} · queries/{f}"})
                led[k] = o; add += 1; head = ""
    return add

def merge_into(dst, src, old_key):
    """v2.69 같은 기록의 중복 항목을 합친다(중복만 지운다 — 정보는 합산·보존). 횟수·날짜·출처·도구·발견 경로를 합치고, 빈 칸만 채우며, 옛 key는 key_aliases에."""
    dst["seen"] = dst.get("seen", 1) + src.get("seen", 1)
    for f, fn in (("first_seen", min), ("last_seen", max)):
        if src.get(f): dst[f] = fn(dst.get(f) or src[f], src[f])
    days = dict(dst.get("days") or {})
    for d, n in (src.get("days") or {}).items(): days[d] = days.get(d, 0) + n
    dst["days"] = days; dst["days_total"] = len(days)
    for f in ("sources", "tools", "found_by"):
        v = list(dst.get(f) or [])
        for x in src.get(f) or []:
            if x not in v: v.append(x)
        if v: dst[f] = v
    fb = dict(src.get("found_by_basis") or {}); fb.update(dst.get("found_by_basis") or {})
    if fb: dst["found_by_basis"] = fb
    fm = dict(dst.get("formats") or {})
    for x, n in (src.get("formats") or {}).items(): fm[x] = fm.get(x, 0) + n
    dst["formats"] = fm; dst["max_cross"] = max(dst.get("max_cross", 0), src.get("max_cross", 0))
    for f, v in src.items():
        if f not in dst or dst.get(f) in (None, "", [], {}): dst[f] = v
    al = dst.setdefault("key_aliases", [])
    for x in [old_key] + list(src.get("key_aliases") or []):
        if x not in al and x != dst["key"]: al.append(x)

def rekey_ktv(led):
    """v2.69 KTV 항목을 ktv:<mediadtl>로 — 같은 영상의 중복 항목은 merge_into로 합친다."""
    n = 0
    for k in [k for k in led if k.startswith("ktv:")]:
        o = led.get(k)
        if o is None: continue
        nk = key_of({"s": ["ktv"], "i": o.get("id") or "", "u": o.get("url") or ""})
        if nk == k: continue
        led.pop(k)
        if nk in led: merge_into(led[nk], o, k)
        else: o["key"] = nk; o.setdefault("key_aliases", []).append(k); led[nk] = o
        n += 1
    return n

GUARD_FIELDS = ("summary", "meta", "partOf", "date", "url", "iiif", "authority", "id")

def loss_guard(led, prev, today):
    """v2.70 '축적된 정보는 절대 지우지 않는다'를 기계적으로 강제 — 이번 실행 전 원장과 비교해
    (1) 사라진 항목(별칭으로 옮겨진 것 제외)은 되살리고, (2) 값이 있던 필드가 비면 이전 값을, (3) 지문 이력이 줄면 이전 이력을 되살린다.
    무엇을 되살렸는지 loss_guard.json에 날짜별로 남긴다(이 기록도 지우지 않는다). 반환: 되살린 건수."""
    alias = {}
    for k, o in led.items():
        for a in o.get("key_aliases") or []: alias[a] = k
    ev = []
    for k, po in prev.items():
        cur = led.get(k) or led.get(alias.get(k, ""))
        if cur is None:
            po["restored_by_guard"] = today.isoformat(); led[k] = po; ev.append({"key": k, "what": "항목 소실 → 되살림"}); continue
        for f in GUARD_FIELDS:
            if po.get(f) not in (None, "", [], {}) and cur.get(f) in (None, "", [], {}):
                cur[f] = po[f]; ev.append({"key": cur["key"], "what": f"{f} 비워짐 → 이전 값 되살림"})
        if po.get("meta") and cur.get("meta"):  # v2.79 메타 항목 단위 — 이전 판의 항목(라벨)이 사라지면 되살린다(교체로 인한 손실 방지)
            ck = {m[0] for m in cur["meta"] if m}
            miss = [m for m in po["meta"] if m and m[0] not in ck]
            if miss: cur["meta"] = cur["meta"] + miss; ev.append({"key": cur["key"], "what": f"메타 항목 {len(miss)}개 사라짐 → 되살림({', '.join(str(m[0]) for m in miss[:5])})"})
        if len(po.get("fixity") or []) > len(cur.get("fixity") or []):
            cur["fixity"] = po["fixity"]; ev.append({"key": cur["key"], "what": "지문 이력 감소 → 이전 이력 되살림"})
    p = os.path.join(D, "loss_guard.json")
    J = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"note": "원장 불삭제 검사 — 사라질 뻔한 값을 되살린 기록(날짜별, 지우지 않음)", "daily": {}}
    if ev: J["daily"].setdefault(today.isoformat(), []).extend(ev)
    J["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"); J["total_restored"] = sum(len(v) for v in J["daily"].values())
    json.dump(J, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return len(ev)

def rekey_collisions(led):
    """v2.67 옛 규칙으로 분류어 key(nlk:기사 등)를 받은 항목을 올바른 key로 옮긴다 — 지우지 않고 이름만 바꾸며, 옛 key는 key_aliases에 남긴다.
    발견 횟수가 2 이상이면 같은 유형의 다른 기록이 합쳐졌을 수 있음을 merge_note로 밝힌다(합쳐진 기록의 URL은 첫 것만 남아 있음)."""
    moved = 0
    for k in [k for k in led if ":" in k]:
        h, i = k.split(":", 1); o = led[k]
        if i and not re.search(r"\d", i) and not i.startswith("http") and o.get("url") and h in ("nlk",):
            vk = re.search(r"viewKey=([^&#\s]+)", o["url"])  # 고친 수집기와 같은 key(nlk:<viewKey>) — 이후 발견이 이 항목으로 모이게
            nk = f"{h}:{vk.group(1)}" if vk else key_of({"s": [h], "i": "", "u": o["url"]})
            o["id"] = vk.group(1) if vk else o.get("id", "")
            if nk == k or nk in led: continue
            o["key"] = nk; o.setdefault("key_aliases", []).append(k)
            if o.get("seen", 1) > 1: o["merge_note"] = f"v2.67 이전 key 충돌({k}) — 같은 자료유형의 다른 기록 최대 {o['seen']}회분이 이 항목에 합쳐졌을 수 있음(남은 URL은 첫 기록). 이후 발견은 기록별 key로 분리"
            led[nk] = led.pop(k); moved += 1
    return moved

def tok(env):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return base64.urlsafe_b64encode(c.compress(json.dumps(env, ensure_ascii=False, separators=(",", ":")).encode()) + c.flush()).decode().rstrip("=")

def merge_queries(state, today, kind="q"):
    """v2.26 모든 질의·회신 영구 축적 — 날짜 함 ka:q → docs/data/queries/YYYY-MM.jsonl.gz.
    같은 도구·같은 인자·같은 회신 지문(h)이면 중복(seen·last만 갱신), 회신이 바뀌면 새 판으로 보존(증거성 — 응답 변화 이력). 절대 삭제하지 않는다."""
    import gzip, hashlib
    # v2.58 kind="qp" — 자동 점검(골든·헬스·원장 보강) 질의·회신을 queries/probe/에 따로(활용 집계·발견 경로와 섞지 않음, 지우지 않음)
    qdir = os.path.join(D, "queries", "probe") if kind == "qp" else os.path.join(D, "queries"); os.makedirs(qdir, exist_ok=True)
    qs = state.setdefault("qpdays" if kind == "qp" else "qdays", {}); added = 0; books = {}
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
            try: j = get(f"{API}{d}?kind={kind}&start={pos}&n=500")
            except Exception as e: print(f"질의 {d}: 읽기 실패 {e}"); break
            items = j.get("items") or []
            for r in items:
                if not r.get("tool") or "h" not in r: continue  # 질의·회신 형식이 아닌 항목(옛 배포가 kind를 모르면 발견 함을 돌려줌) — 받지 않는다
                at = r.get("at") or d; args = r.get("args") or {}
                k = hashlib.sha256((r.get("tool", "") + json.dumps(args, ensure_ascii=False, sort_keys=True) + r.get("h", "")).encode()).hexdigest()[:20]
                B = book(at[:7]); o = B.get(k)
                if o: o["seen"] += 1; o["last"] = max(o["last"], at); continue
                B[k] = {"k": k, "ak": r.get("ak", ""), "tool": r.get("tool", ""), "args": args, "first": at, "last": at, "seen": 1, "h": r.get("h", ""), "n": r.get("n", 0), "z": r.get("z", ""), **({"probe": r["probe"]} if r.get("probe") else {})}; added += 1
            pos += len(items)
            if len(items) < 500: break
        qs[d] = pos
    keep = (today - dt.timedelta(days=10)).isoformat(); state["qpdays" if kind == "qp" else "qdays"] = {k: v for k, v in qs.items() if k >= keep}
    for month, rows in books.items():
        with gzip.open(os.path.join(qdir, f"{month}.jsonl.gz"), "wt", encoding="utf-8") as fo:
            for o in sorted(rows.values(), key=lambda o: (o["first"], o["k"])): fo.write(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n")
    # 질의 색인(회신 본문 제외 — 가볍게): 전 기간 질의 목록, 도구별 건수
    idx = []
    for f in sorted(os.listdir(qdir)):
        if f.endswith(".jsonl.gz"):
            for ln in gzip.open(os.path.join(qdir, f), "rt", encoding="utf-8"):
                if ln.strip():
                    o = json.loads(ln); idx.append({k: o[k] for k in ("k", "tool", "args", "first", "last", "seen", "h", "n")} | {"ak": o.get("ak", ""), "month": f[:7]} | ({"probe": o["probe"]} if o.get("probe") else {}))
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "total": len(idx), "queries": idx}, open(os.path.join(qdir, "index.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{'점검 ' if kind == 'qp' else ''}질의 축적: 신규 {added} · 누적 {len(idx)}")
    bt = {}
    for o in idx: bt[o["tool"]] = bt.get(o["tool"], 0) + o["seen"]
    recent = sorted(idx, key=lambda o: o["last"], reverse=True)[:20]
    return {"added": added, "total": len(idx), "calls": sum(o["seen"] for o in idx), "by_tool": dict(sorted(bt.items(), key=lambda kv: -kv[1])), "recent": recent}

def _stable(v):
    if isinstance(v, list): return "[" + ",".join(_stable(x) for x in v) + "]"
    if isinstance(v, dict): return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + _stable(v[k]) for k in sorted(v)) + "}"
    return "null" if v is None else json.dumps(v, ensure_ascii=False)

def arg_key(tool, args):
    """lib/ledger.js argKey와 같은 값(키 정렬 직렬화 sha256-16) — 지문이 없던 v2.26~2.27 질의에도 같은 지문을 준다(29/29 일치 실측)."""
    import hashlib
    return hashlib.sha256((str(tool) + _stable(args or {})).encode()).hexdigest()[:16]

def backfill_found_by(led):
    """v2.41 발견 경로 소급 — 축적된 회신 원문(queries/*.jsonl.gz)에 기록의 URL 또는 노드(rec:<key>)가 실제로 들어 있으면 그 질의를 발견 경로로.
    실시간 지문과 구분해 found_by_basis에 '회신 본문 대조(소급)'. 원장 재검색(sources=ledger)은 순환이라 제외."""
    import gzip
    for o in led.values():  # 먼저 실시간 지문 근거를 단다(소급이 덮지 않게)
        for ak in o.get("found_by") or []: o.setdefault("found_by_basis", {}).setdefault(ak, "질의 지문(실시간)")
    qd = os.path.join(D, "queries"); added = 0
    refs = []
    for k, o in led.items():
        if o.get("entry_type", "기록") != "기록": continue
        r = [f"rec:{k}"] + ([o["url"]] if len(o.get("url") or "") >= 20 and not re.match(r"^https?://[^/]+/?$", o["url"]) else [])
        refs.append((k, r))
    for f in sorted(os.listdir(qd)) if os.path.isdir(qd) else []:
        if not f.endswith(".jsonl.gz"): continue
        for ln in gzip.open(os.path.join(qd, f), "rt", encoding="utf-8"):
            if not ln.strip(): continue
            q = json.loads(ln); a = q.get("args") or {}
            if "ledger" in str(a.get("sources", "")) or not q.get("z"): continue
            try: body = zlib.decompress(base64.b64decode(q["z"] + "=" * (-len(q["z"]) % 4)), -15).decode("utf-8", "replace")
            except Exception: continue
            ak = q.get("ak") or arg_key(q.get("tool", ""), a)
            for k, rr in refs:
                if any(x in body for x in rr):
                    o = led[k]; fb = o.setdefault("found_by", []); bs = o.setdefault("found_by_basis", {})
                    if ak not in fb: fb.append(ak); added += 1
                    bs.setdefault(ak, "회신 본문 대조(소급)")
    return added

def build_provenance(recs):
    """v2.28 발견 경로(맥락·증거 사슬) — 질의 지문(ak) ↔ 발견 기록을 양방향으로. 질의는 queries/index.json, 회신 원문은 queries/<월>.jsonl.gz(같은 ak)."""
    qp = os.path.join(D, "queries", "index.json")
    Q = json.load(open(qp, encoding="utf-8")).get("queries", []) if os.path.exists(qp) else []
    byak = {}
    for q in Q:
        if not q.get("ak"): q["ak"] = arg_key(q.get("tool", ""), q.get("args"))  # v2.41 지문 이전 질의도 같은 지문으로
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

def qlabel(e):
    """사람이 읽는 질의 표기 — 도구 '질의' (주요 인자). JSON 따옴표가 뷰어에서 깨지지 않게."""
    a = e.get("args") or {}; q = a.get("query") or a.get("ref_code") or a.get("institution") or a.get("naid") or ""
    extra = ", ".join(f"{k}={v}" for k, v in a.items() if k in ("sources", "mode", "kind", "format") and v not in ("", None))
    return f"{e['tool']} ‘{str(q)[:80]}’" + (f" ({extra[:80]})" if extra else "")

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
            mf = (o.get("iiif") if not o.get("iiif_status") else "") or o.get("iiif_built") or leaf_manifest(o)
            items.append({"id": mf, "type": "Manifest", "label": {"none": [o["title"][:120] + (f" ({o['date']})" if o.get("date") else "")]}})
        args = json.dumps(e["args"], ensure_ascii=False, sort_keys=True) if e.get("args") is not None else ""
        resp = e.get("responses", [])
        md = [L1v("도구", e["tool"]), L1v("질의 인자", args), L1v("질의 지문(ak)", e["ak"]), L1v("처음 질의", e["first"]), L1v("마지막 질의", e["last"]),
              L1v("누적 호출", e["calls"]), L1v("회신 판 수", len(resp)), L1v("발견 기록 수", len(items))] + ([L1v("판독 대상 기록", ", ".join(e["read_records"][:5]))] if e.get("read_records") else [])
        md += [L1v(f"회신 판 {i + 1}", f"지문 {r['h']} · {r['first'][:16]}~{r['last'][:16]} · {r['seen']}회 · {r['bytes']}B · 원문 queries/{r['month']}.jsonl.gz") for i, r in enumerate(resp[:20])]
        col = {"@context": "http://iiif.io/api/presentation/3/context.json", "id": f"{PAGES}q/{e['ak']}.json", "type": "Collection",
               "label": {"ko": [f"질의 발굴 기록 — {qlabel(e)}"]},
               "summary": {"ko": [f"KOREA ARCHIVE 통합검색 질의 한 건이 찾은 기록 {len(items)}건. 회신 원문은 질의·회신 축적(queries/)에서 같은 지문으로 확인 — 질의 → 회신 → 발견 기록의 증거 사슬."]},
               "metadata": md, "requiredStatement": {"label": {"ko": ["출처"]}, "value": {"ko": ["각 기록의 권리는 원 기관 표기를 따름 — 게재 전 judge_rights"]}},
               "seeAlso": [{"id": f"{PAGES}provenance.json", "type": "Dataset", "format": "application/json", "label": {"ko": ["발견 경로 전체"]}}], "items": items}
        json.dump(col, open(os.path.join(qd, f"{e['ak']}.json"), "w", encoding="utf-8"), ensure_ascii=False)
        rows.append((e, args, len(items), len(resp)))
    E_ = html.escape; KV = "https://changgi.github.io/korea-archive-mcp/kv.html?manifest="
    kvl = lambda ak: " · <a href='" + KV + E_(PAGES + "q/" + ak + ".json") + "'>KV</a>"
    tr = "".join(f"<tr><td>{E_(e['last'][:16])}</td><td>{E_(e['tool'])}</td><td>{E_(qlabel(e))}</td><td>{n}</td><td>{v}</td><td>{e['calls']}</td>"
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
    ent = "".join(f"""<entry><title>{X.escape(o['title'][:200])}</title><id>{X.escape(o.get('url') or PAGES + '#' + o['key'])}</id><link href="{X.escape(o.get('url') or PAGES)}"/><link rel="related" href="{PAGES}r/{rec_slug(o['key'])}.html"/>
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
        if o.get("summary") or o.get("summary_composed"): it["abstract"] = (o.get("summary") or o["summary_composed"])[:1000]
        if o.get("rights_view"): it["license"] = o["rights_view"]; it["note"] += f" · 권리 근거: {o.get('rights_basis', '')}"
        if not o.get("date") and o.get("date_derived"): it["note"] += f" · 날짜 {o['date_derived']}는 파생(원 기관 날짜 칸 아님) — 근거: {o.get('date_basis', '')}"  # v3.7.1 인용자가 기관 날짜로 오인하지 않게
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
            if not o.get("date") and o.get("date_derived"): L.append(f"N1  - 날짜 {o['date_derived']}는 파생(원 기관 날짜 칸 아님) — 근거: {o.get('date_basis', '')}")  # v3.7.1
            L += [f"N1  - KOREA ARCHIVE 통합검색 발견 원장 — 처음 발견 {o['first_seen'][:10]} · 출처 {'+'.join(o['sources'])}", "ER  - ", ""]
            f.write("\n".join(L) + "\n")
    # 5) v2.53 OAI-PMH oai_dc — 아카이브·도서관 수집기(하베스터)가 읽는 표준 교환형(Dublin Core 15요소). 정적 ListRecords 1건(파생 계층·날짜는 [파생] 유지)
    BYK = {x["key"]: x for x in recs_all}
    DCT = {"motion_picture": "MovingImage", "graphic": "StillImage", "map": "Image", "document": "Text"}
    def dc(o):
        E = lambda t, v: f"<dc:{t}>{X.escape(str(v))}</dc:{t}>" if v else ""
        dd = o.get("date") or (o.get("date_derived") and f"{o['date_derived']} [파생: {o.get('date_basis', '')}]")
        return "".join([E("title", o["title"]), E("identifier", o.get("url")), E("identifier", o.get("id")), E("identifier", f"{PAGES}r/{rec_slug(o['key'])}.html"), E("date", dd), E("coverage", decade(o)),
                        E("source", inst(o)), E("relation", o.get("partOf") or (o.get("partOf_derived") and f"[파생] {o['partOf_derived']}")),
                        E("description", (o.get("summary") or o.get("summary_composed") or "")[:1500]), E("rights", o.get("rights_view")), E("type", DCT[kind_of(o)]),
                        E("relation", (o.get("iiif") if not o.get("iiif_status") else "") or o.get("iiif_built")), E("publisher", "KOREA ARCHIVE 통합검색 발견 원장(재기술·집성)"),
                        *[E("relation", f"같은 기록(다른 소장처 {inst(BYK[b_])}): {BYK[b_].get('url') or b_} — 근거 {bs_}") for t_, b_, bs_ in REL.get(o["key"], []) if t_ == "같은 기록(다른 소장처)" and b_ in BYK]])  # v2.89 하베스터에도 같은 기록 연결
    recx = "".join(f"""<record><header><identifier>oai:changgi.github.io:korea-archive-mcp:{X.escape(o['key'])}</identifier><datestamp>{o['last_seen'][:10]}</datestamp><setSpec>{X.escape(o['key'].split(':')[0])}</setSpec></header>
<metadata><oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/">{dc(o)}</oai_dc:dc></metadata></record>
""" for o in recs)
    open(os.path.join(D, "records.oai_dc.xml"), "w", encoding="utf-8").write(f"""<?xml version="1.0" encoding="utf-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><responseDate>{now}</responseDate><request verb="ListRecords" metadataPrefix="oai_dc">{PAGES}records.oai_dc.xml</request><ListRecords>
{recx}</ListRecords></OAI-PMH>""")
    # 6) v2.53 BibTeX — LaTeX·학위논문 인용(biblatex @misc)
    import hashlib
    bx = lambda t: re.sub(r"([{}%&$#_\\])", r"\\\1", str(t))
    with open(os.path.join(D, "records.bib"), "w", encoding="utf-8") as f:
        for o in recs:
            bk = re.sub(r'[^A-Za-z0-9]+', '_', o['key'])[:48].rstrip('_') + "_" + hashlib.sha256(o['key'].encode()).hexdigest()[:8]  # 키 충돌 방지(원장 key 지문)
            L = [f"@misc{{ka_{bk},", f"  title = {{{bx(o['title'])}}},", f"  organization = {{{bx(inst(o))}}},"]
            if yr(o): L.append(f"  year = {{{yr(o)}}},")
            if o.get("date"): L.append(f"  date = {{{bx(o['date'])}}},")
            if not o.get("date") and o.get("date_derived"): L.append(f"  addendum = {{{bx('날짜 ' + o['date_derived'] + '는 파생(원 기관 날짜 칸 아님) — 근거: ' + o.get('date_basis', ''))}}},")  # v3.7.1
            if o.get("url"): L.append(f"  url = {{{o['url']}}},")
            if o.get("id"): L.append(f"  number = {{{bx(o['id'])}}},")
            if ser(o): L.append(f"  series = {{{bx(ser(o))}}},")
            L.append(f"  urldate = {{{o['first_seen'][:10]}}},")
            L.append(f"  note = {{KOREA ARCHIVE 통합검색 발견 원장 · 출처 {bx('+'.join(o['sources']))}{' · 권리 ' + bx(o['rights_view']) if o.get('rights_view') else ''}}}")
            f.write("\n".join(L) + "\n}\n\n")
    # 4) 연대 타임라인 — 시각화·전시용(연대 × 기관 × 매체)
    tl = {}
    for o in recs:
        d = decade(o) or "연대 미상"; e = tl.setdefault(d, {"decade": d, "records": 0, "by_source": {}, "by_kind": {}, "samples": []})
        e["records"] += 1; h = o["key"].split(":")[0]; k = kind_of(o)
        if not o.get("date") and o.get("date_derived"): e["derived"] = e.get("derived", 0) + 1  # v3.8.5 이 연대 칸 중 파생 날짜(근거 date_basis)로 정해진 건수 — 증거 강도 구분
        e["by_source"][h] = e["by_source"].get(h, 0) + 1; e["by_kind"][k] = e["by_kind"].get(k, 0) + 1
        if len(e["samples"]) < 5: e["samples"].append({"title": o["title"][:120], "url": o.get("url", ""), "iiif": o.get("iiif") or o.get("iiif_built", "")})
    json.dump({"updated": now, "note": "구간 = 연대(4자리 연도·8자리 날짜·연호 연도 明治·大正·昭和·光武·隆熙·檀紀 환산) → 세기 → 왕조·시대명. 근거 순서 date → 제목 → 메타(생산·시대·출판). 세기·시대 구간은 시간축 근사 정렬", "timeline": sorted(tl.values(), key=lambda e: period_order(e["decade"]))},
              open(os.path.join(D, "timeline.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    # 5) 연대 타임라인 페이지 — 사람이 보는 매체(막대·대표 기록·KV 열람)
    E_ = html.escape; KV = "https://changgi.github.io/korea-archive-mcp/kv.html?manifest="; T = sorted(tl.values(), key=lambda e: period_order(e["decade"])); mx = max((e["records"] for e in T), default=1)
    li = lambda x: f"<li><a href='{E_(x['url'] or '#')}'>{E_(x['title'])}</a>" + (f" <a class='kv' href='{KV}{E_(x['iiif'])}'>KV</a>" if x["iiif"] else "") + "</li>"
    KN = {"motion_picture": "영상", "graphic": "사진·그림", "map": "지도", "document": "문서"}
    rows = "".join(f"""<section><h3>{E_(e['decade'])} <small>{e['records']}건{f" (파생 날짜 {e['derived']}건)" if e.get('derived') else ''} · {' '.join(f"{KN[k]} {n}" for k, n in sorted(e['by_kind'].items(), key=lambda kv: -kv[1]))}</small></h3>
<div class="bar" style="width:{max(2, round(e['records'] / mx * 100))}%"></div><p class="src">{' · '.join(f"{E_(SRC_NAME.get(h, h))} {n}" for h, n in sorted(e['by_source'].items(), key=lambda kv: -kv[1]))}</p>
<ul>{''.join(li(x) for x in e['samples'])}</ul></section>""" for e in T)
    open(os.path.join(D, "timeline.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>연대 타임라인 — KOREA ARCHIVE 발견 원장</title><style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:960px;margin:auto;padding:16px}}a{{color:#e0b04a}}
section{{border-left:3px solid #e0b04a;padding:4px 14px;margin:14px 0}}h3{{margin:4px 0}}small{{color:#9b9a93;font-weight:400}}.bar{{height:8px;background:#e0b04a;border-radius:4px}}.src{{font-size:13px;color:#9b9a93}}li{{font-size:14px;margin:3px 0}}.kv{{font-size:12px;margin-left:6px}}</style>
<main><h1>연대 타임라인</h1><p>발견 누적 원장 {len(recs)}건을 시대 구간으로. 구간 = 4자리 연도 → 세기 → 기관 '시대' 필드의 왕조·시대명(근거 순서 date → 제목 → 메타). 세기·시대 구간은 시간축 근사 위치. 구간마다 대표 기록 5건(IIIF·KV 열람). <a href="timeline.json">timeline.json</a> · <a href="index.html">원장</a></p>{rows}</main></html>""")
    return len(new), len(csl), len(tl)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

# v2.60 데이터 목록(DCAT) + schema.org Dataset — 데이터 포털·검색엔진(Google 데이터셋 검색)이 원장 산출물을 스스로 찾아 가져가게
DISTS = [("discovered.csv", "text/csv", "발견 기록 표(CSV)"), ("discovered.jsonl", "application/jsonl", "발견 기록(JSONL)"),
         ("discovered.jsonld", "application/ld+json", "RiC-O·PROV 연결 데이터(JSON-LD)"), ("collection.json", "application/ld+json", "IIIF Presentation 3 컬렉션(최근 300건)"),
         ("hierarchy.json", "application/ld+json", "IIIF 계층 컬렉션"), ("subjects.jsonld", "application/ld+json", "주제·인물·장소·형태 SKOS 개념 체계"),
         ("records.oai_dc.xml", "application/xml", "OAI-PMH Dublin Core"), ("activity/collection.json", "application/ld+json", "IIIF Change Discovery 1.0 활동 스트림(매니페스트 생성·갱신)"), ("day/index.json", "application/ld+json", "IIIF 컬렉션 — 같은 날 다른 기관 기록 묶음(날짜순)"), ("places.json", "application/json", "지명 사전 — 표준명·표기 변이·기록(v3.14)"), ("places.jsonld", "application/ld+json", "지명 사전 SKOS·rico:Place"), ("authorities.json", "application/json", "기관 전거(KSH·KAC) — 국립중앙도서관 LOD·외부 전거 연결(v3.23)"), ("place/index.json", "application/ld+json", "IIIF 컬렉션 — 지명별 기록(연대순, v3.16)"), ("records.csl.json", "application/vnd.citationstyles.csl+json", "인용 CSL-JSON"),
         ("records.ris", "application/x-research-info-systems", "인용 RIS"), ("records.bib", "application/x-bibtex", "인용 BibTeX"),
         ("feed.xml", "application/atom+xml", "새 발견 Atom 피드"), ("timeline.json", "application/json", "연대 타임라인"), ("tree.json", "application/json", "계층구조"),
         ("classifications.json", "application/json", "분류 사전"), ("provenance.json", "application/json", "발견 경로(질의↔기록)"), ("relations.json", "application/json", "기록↔기록 맥락 연결(근거 포함)"), ("relations.html", "text/html", "맥락 연결 묶음(읽기용)"), ("quality.json", "application/json", "데이터 품질 시계열"),
         ("fixity_changes.json", "application/json", "원문 고정성 변경 이력"), ("loss_guard.json", "application/json", "불삭제 검사 — 되살린 값 기록"), ("queries/index.json", "application/json", "질의·회신 축적 색인"),
         ("queries/probe/index.json", "application/json", "자동 점검 질의·회신 색인"), ("records/index.json", "application/json", "일일 기록물 등록부 해시 사슬")]

def iiif_kind(o):
    m = (o.get("iiif") or "") if not o.get("iiif_status") else ""
    if not m: return "기록 봉투(이미지 없음 — 기록 정보만 담은 브리지)"
    if re.search(r"/iiif/(ktv|kw|seoul)/", m) and o.get("enrich_status") == "ok" and not o.get("thumb"): return "기록 봉투(브리지 — 원 기관 페이지에 이 기록의 공개 이미지 없음)"  # v3.5 이미지 없는 KTV 브리지는 봉투로
    if re.search(r"korea-archive-mcp\.vercel\.app/iiif/|changgi\.github\.io/korea-archive-mcp/", m): return "원 기관 이미지로 구축(KOREA ARCHIVE 브리지)"
    return "원 기관 제공 매니페스트"

# v3.9.2 기록 봉투 사유 — '이미지 없음'이 왜인지(권리·기술·매체·미구축)를 기준 정보로 축적. 근거는 source_profile 간이 프로파일·MAINTAINING 실측.
#   '미구축'은 다음 개선 대상(기관 IIIF·공개 이미지 경로를 아직 확인하지 못함) — 부재 단정이 아니다.
ENVELOPE_WHY = {
    "okchf": ("권리", "재단·소장처 이용조건 — 허가 전 링크만(이미지 게재 협의 대상)"),
    "i815": ("권리", "공공누리 표시 없는 원문 이미지는 독립기념관 사전 협의 대상"),
    "jsg": ("권리", "장서각 이미지 게재는 공문 신청·허가 대상"),
    "kyudb": ("권리", "규장각 원문 이미지 게재는 기관 허가 대상"),
    "aks": ("기술", "원문 이미지가 DZI 타일 뷰어(IIIF 아님) · 재이용 조건 미표기 — 게재 전 기관 확인"),
    "oldnews": ("기술", "지면 이미지 엔드포인트가 자동 조회에 404 — 기관 뷰어에서 열람"),
    "nzarch": ("기술", "본 사이트 봇 차단(Incapsula) — 우회하지 않음, 기관 페이지에서 열람"),
    "gallica": ("기술", "서버 자동 조회 403 — 원 기관 IIIF는 iiif_origin(브라우저 열람)"),
    "archives": ("기술", "국가기록원 IIIF 미제공 — 원문은 기관 뷰어"),
    "indy": ("기술", "판결문 원문은 국가기록원 뷰어 — IIIF 미제공"),
    "jacar": ("기술", "원본 이미지는 国立公文書館 뷰어(PDF) — IIIF 미제공"),
    "nedb": ("매체", "한국사DB 텍스트 원문 — 이미지 대상 아님(지면 이미지 자료는 기관 뷰어)"),
    "gonghun": ("매체", "공적조서·공훈록 텍스트"),
    "un": ("매체", "UN 공식문서 PDF(6개 언어) — IIIF 미제공, 원 기관 PDF로 열람"),
    "ndl": ("매체", "서지 레코드 — 디지털화 자료(dl.ndl.go.jp PID) 미연결(2026-11-25 SRU 표본: 타 도서관 소장 서지)"),
    "dnz": ("기술", "집계 서비스 — 이미지는 각 제공기관 페이지(usage·rights 확인)"),
    "nlna": ("매체", "문서군(inventaris) 기술 — 사진은 Europeana dataset 경로"),
    "seoul": ("매체", "집합 기술(aggregation·컬렉션) — 이미지는 하위 기록건(item)에, 기록건은 /iiif/seoul 브리지"),
    "earchive": ("기술", "원문 이미지는 기관 PDF 뷰어(fnPdfViewer, 스크립트) 전용 · robots 전체 Disallow(표시) · 이용조건 원문은 기관 표기(예: 제한적 이용 가능 — 출처·비상업·원 소장처 권리 확인), 2026-11-25 실측. 사본이면 origin_holder(원 소장처 계층) 참조"),
    "nrich": ("미구축", "브리지 대상 유형(국외문화유산·금석문·초상화·괘불·연구DB 이미지) 밖의 기록(발간자료 등)"),
}

_md = lambda o: {m[0]: m[1] for m in (o.get("meta") or []) if m and len(m) > 1}
ENVELOPE_RULES = {  # v3.11.1 2026-11-25 실측 근거
    "nrich": [lambda o: ("매체", "발간 보고서 — 원문은 기관 파일 다운로드(PDF, 스크립트 양식) · 공공누리 표기는 상세 페이지 원문") if o["key"].startswith("nrich:rep:") else None,
              lambda o: ("매체", "한국고고학사전 항목 텍스트 — 상세 페이지 대표이미지(data-original-url) 없음(2026-11-25 실측 4건) · 공공누리 제4유형 표기") if o["key"].startswith("nrich:dict:") else None],
    "nlk": [lambda o: ("기술", "디지털화 원문은 국립중앙도서관 원문 뷰어(viewer.nl.go.kr — 스크립트 전용, robots 전체 Disallow 표시) — IIIF 미제공") if (o["key"].startswith("nlk:CNTS-") or _md(o).get("원문 뷰어")) else None,
            lambda o: ("매체", "소장 서지 — 디지털화 원문 미연결(기관 표기 '소장 정보(원문 열람은 기관 확인)')") if "소장 정보" in _md(o).get("원문 열람", "") else None],
}

# v3.13 지명 사전 — route.js 다국어 변환표(TOPICS)의 지명 대응(흥남·興南→Hungnam 등)과 기관 로마자 변형(Incheon·Busan·Jeju…)을 한 표준명으로.
#   '같은 날(다른 기관)' 간선의 근거에 같은 지명을 붙인다(표제·기관 장소 칸에서만 — 요약 본문 속 언급은 쓰지 않음: 다른 곳 언급 오탐 방지).
PLACES = {"흥남": r"흥남|興南|Hungnam|Hŭngnam", "함흥": r"함흥|咸興|Hamhung|Hamhŭng", "장진호": r"장진호|長津|Chosin|Changjin", "하갈우리": r"하갈우리|Hagaru", "고토리": r"고토리|Koto-?ri",
          "인천": r"인천|제물포|仁川|Inchon|Incheon|Chemulpo", "서울": r"서울|경성|京城|漢城|Seoul|Keijo", "부산": r"부산|釜山|Pusan|Busan", "평양": r"평양|平壤|平壌|Pyongyang|P'yŏngyang",
          "원산": r"원산(?!지)|元山|Wonsan", "대구": r"대구|大邱|Taegu|Daegu", "개성": r"개성(?![적이을은있])|開城|Kaesong|Gaeseong", "판문점": r"판문점|板門店|Panmunjom", "낙동강": r"낙동강|洛東江|Naktong|Nakdong",
          "가평": r"가평|加平|Kapyong|Gapyeong", "제주": r"제주|濟州|Cheju|Jeju", "김포": r"김포|金浦|Kimpo|Gimpo", "수원": r"수원(?!지)|水原|Suwon", "대전": r"대전|大田|Taejon|Daejeon",
          "영등포": r"영등포|Yongdungpo|Yeongdeungpo", "여의도": r"여의도|汝矣島|Yeouido|Yoido", "한강": r"한강|漢江|Han River",
          # v3.15 원장 실측 2건 이상 추가(2026-11-25) — 오탐 규칙: 진주선(유물명)·增修崇慶州志(중국 숭경주)·원주김씨(본관)는 지명 아님
          "38선": r"38선|38th Parallel|三十八度線", "진주": r"진주(?![선알목])|晉州|晋州|Chinju|Jinju", "경주": r"경주|(?<!崇)慶州|Kyongju|Gyeongju", "의정부": r"의정부|議政府|Uijongbu|Uijeongbu",
          "강화": r"강화도|강화군|江華|Kanghwa|Ganghwa", "문산": r"문산|汶山|Munsan", "용평": r"Yongpyang|Yongp'yang", "광주": r"광주(?!김씨)|光州|Kwangju|Gwangju"}
_PL = {k: re.compile(r"(?<![A-Za-z가-힣])(?:" + v + r")(?![a-z])", re.I) for k, v in PLACES.items()}
PLACE_META = re.compile(r"^(장소|장소\(기관 전거\)|취급지명|연관정보|지명.*|place.*|Place made|관련사건|생산지|촬영지|위치)$", re.I)
def places(o):
    t = " ".join([str(o.get("title") or "")] + [str(v) for k, v in ((m[0], m[1]) for m in (o.get("meta") or []) if m and len(m) > 1) if PLACE_META.match(str(k))])
    return {k for k, rx in _PL.items() if rx.search(t)}

# v3.17 사건-날짜 정합 — 표제에 알려진 사건이 있으면 기록 날짜를 사건 시기와 대조(기관 값은 고치지 않고 판정만 둔다).
#   사건 이전 날짜 = 모순(그 사건의 기록이 먼저 생산될 수 없음 — 표기 확인 필요), 사건 이후 = 사후 기록 가능(오류 단정 아님).
EVENTS = [("흥남 철수", r"흥남\s?철수|Hungnam evacuation|EVACUATION[^;]{0,30}HUNGNAM|HUNGNAM[^;]{0,20}EVACUATION", "1950-12-09", "1950-12-24"),
          ("인천상륙작전", r"인천\s?상륙|Inchon landing|LANDING[^;]{0,30}INCHON|INCHON[^;]{0,20}LANDING|仁川上陸", "1950-09-15", "1950-09-19"),
          ("서울 수복", r"서울\s?수복|9[·.]28\s?수복|recapture of Seoul|RECAPTURE OF SEOUL|Liberation of Seoul", "1950-09-20", "1950-09-29"),
          ("장진호 전투", r"장진호\s?전투|Battle of (?:the )?Chosin", "1950-11-27", "1950-12-13"),  # 'Chosin Reservoir'는 지역명 — 사건 아님
          ("가평 전투", r"가평\s?전투|Battle of Kapyong", "1951-04-22", "1951-04-25"),
          ("정전협정 조인", r"정전\s?협정\s?조인|휴전\s?협정\s?조인|signing of the (?:Korean )?armistice", "1953-07-27", "1953-07-27"),
          # v3.19 원장 제목 실측 2건 이상(2026-11-25) — 구체 사건을 먼저, '한국전쟁(전 기간)'은 마지막(다른 사건이 먼저 맞으면 그것으로)
          ("판문점(휴전) 회담", r"판문점\s?(?:휴전\s?)?회담|휴전\s?회담|정전\s?회담|armistice talks|truce talks|talks at Panmunjom|PEACE TALKS", "1951-07-10", "1953-07-27"),
          ("중공군 개입", r"중공군\s?(?:개입|참전)|Chinese (?:Communist )?intervention", "1950-10-19", "1950-11-30"),
          ("1·4 후퇴", r"1[·.]4\s?후퇴", "1951-01-03", "1951-01-07"),
          ("3·1운동", r"3[·.]1\s?운동|삼일운동|三一運動|March 1st Movement", "1919-03-01", "1919-05-31"),
          ("한국전쟁(전 기간)", r"한국전쟁|6[·.]25\s?전쟁|Korean War|朝鮮戦争", "1950-06-25", "1953-07-27")]
_EV = [(n, re.compile(rx, re.I), a, b) for n, rx, a, b in EVENTS]

def date_norm(o):
    """v3.20 기관 날짜 칸의 비ISO 표기 → 정규 날짜(원 표기는 date에 그대로, 정규값·근거만 따로). 일/월 순서가 모호한 표기는
    기관 관행이 확인된 곳만(dnz — 뉴질랜드 DD/MM/YYYY). 반환 {"value", "basis"} 또는 None."""
    d = str(o.get("date") or "").strip(); src = o["key"].split(":")[0]
    if not d or re.match(r"^\d{4}(-\d{2}(-\d{2})?)?$|^\d{4}~\d{4}$", d): return None  # 이미 정규
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})T00:00:00Z$", d)
    if m: return {"value": m[1] if (m[2], m[3]) == ("01", "01") else f"{m[1]}-{m[2]}-{m[3]}", "basis": f"원 표기 '{d}'" + (" — 1월 1일 0시는 연도만 표기로" if (m[2], m[3]) == ("01", "01") else " — 시각 제거")}
    m = re.match(r"^(1[0-9]\d\d|20[0-2]\d)(0[1-9]|1[0-2])([0-3]\d)$", d)
    if m: return {"value": f"{m[1]}-{m[2]}-{m[3]}", "basis": f"원 표기 '{d}' — 8자리 YYYYMMDD"}
    m = re.match(r"^\[(\d{4})\]$", d)
    if m: return {"value": m[1], "basis": f"원 표기 '{d}' — 추정 연도 괄호(목록 관행) 표기"}
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", d)
    if m:
        a, b, y = int(m[1]), int(m[2]), m[3]
        if src == "dnz" and 1 <= b <= 12 and 1 <= a <= 31: return {"value": f"{y}-{b:02d}-{a:02d}", "basis": f"원 표기 '{d}' — DigitalNZ 일/월/연(DD/MM/YYYY) 관행"}
        if a > 12 and 1 <= b <= 12: return {"value": f"{y}-{b:02d}-{a:02d}", "basis": f"원 표기 '{d}' — 첫 수 {a} > 12라 일/월/연"}
        return None  # 모호 — 정규화하지 않음
    m = re.match(r"^\[?(\d{4})\s*(?:or|ou|oder|또는|-)\s*(\d{4})\]?$", d)
    if m: return {"value": f"{m[1]}~{m[2]}", "basis": f"원 표기 '{d}' — 둘 중 한 해(범위로)"}
    v, q = meta_date(d)
    if v: return {"value": v, "basis": f"원 표기 '{d}'" + (f" — {q}" if q else "")}
    ys = [era_year(x) for x in re.split(r"[～~]", d)]
    if ys and ys[0]: return {"value": f"{ys[0]}" + (f"~{ys[-1]}" if len(ys) > 1 and ys[-1] and ys[-1] != ys[0] else ""), "basis": f"원 표기 '{d}' — 연호 연도 서기 환산(연도만)"}
    return None

def event_date_check(o):
    d = str((o.get("date_norm") or {}).get("value") or o.get("date") or o.get("date_derived") or "")  # v3.20 정규화 날짜 우선
    d = re.sub(r"-01-01T00:00:00Z$", "", d)  # IA 등 '연도만'을 1월 1일 0시로 적은 표기
    m = re.match(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", d)
    if not m or int(m[1]) < 1000: return None  # '0000' = 기관의 날짜 미상 표기(6·25전쟁 아카이브센터) — 대조하지 않음
    lo = f"{m[1]}-{m[2] or '01'}-{m[3] or '01'}"; hi = f"{m[1]}-{m[2] or '12'}-{m[3] or '31'}"  # 기록 날짜의 가능한 범위(연·월 단위 표기면 넓게)
    rng = re.search(r"~(\d{4})", d)
    if rng: hi = f"{rng[1]}-12-31"
    for n, rx, a, b in _EV:
        if not rx.search(str(o.get("title") or "")): continue
        src = (f"기관 날짜 칸 정규화({o['date_norm']['basis']})" if o.get("date_norm") else "기관 날짜 칸") if o.get("date") else f"파생 날짜({o.get('date_basis', '')})"
        if hi[:4] < a[:4]: v = "사건 이전 연도 — 표기 확인 필요(그 사건의 기록이 그해보다 먼저 생산될 수 없음)"
        elif hi < a: v = "사건 직전 — 준비·이동 단계 기록이거나 날짜 정밀도 차이(오류 단정 아님)"
        elif lo > b: v = "사건 이후 — 사후 기록(보고·편집·재제작)일 수 있음"
        else: v = "일치"
        return {"event": n, "event_period": a if a == b else f"{a}~{b}", "recorded": d, "date_source": src, "verdict": v, "basis": f"표제의 사건명 '{n}' ↔ 기록 날짜 {d}"}
    return None

LOD_NLK = "http://lod.nl.go.kr/resource/"  # v3.23 국립중앙도서관 LOD 전거 리소스(정식 식별자) — 사람용 페이지는 https://lod.nl.go.kr/page/<번호>

def build_authorities(recs, cap=20):
    """v3.23 기관 전거(KSH·KAC) → 국립중앙도서관 LOD 페이지 판독(표제·owl:sameAs 외부 전거 LOC·VIAF·Wikidata·ISNI). authorities.json 누적 —
    새 번호만(실패는 7일 뒤 재시도), 쌓인 값은 지우지 않는다. 조회 실패는 이전 값 보존."""
    p = os.path.join(D, "authorities.json")
    A = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"note": "국립중앙도서관 LOD 전거 — 원장 기록의 기관 전거 번호(KSH 주제명표목·KAC 인명/단체)와 LOD 페이지의 외부 전거 연결(owl:sameAs). 누적, 지우지 않음.", "authorities": {}}
    ids = {}
    for o in recs:
        for t, i in ((o.get("authority_ids") or {}).get("terms") or {}).items(): ids.setdefault(i, {"term": t, "records": set()})["records"].add(o["key"])
    today = dt.date.today().isoformat(); used = 0
    for i, e in sorted(ids.items()):
        a = A["authorities"].setdefault(i, {"id": i, "term": e["term"], "uri": LOD_NLK + i, "page": f"https://lod.nl.go.kr/page/{i}", "records": []})
        a["records"] = sorted(set(a["records"]) | e["records"])
        stale = not a.get("checked") or (a.get("status") == "fail" and a["checked"] < (dt.date.today() - dt.timedelta(days=7)).isoformat())
        if not stale or used >= cap: continue
        used += 1
        try:
            h = urllib.request.urlopen(urllib.request.Request(a["page"], headers={"User-Agent": UA}), timeout=30).read().decode("utf-8", "replace")
            tm = re.search(r"<title>([\s\S]*?)</title>", h)
            lab = re.sub(r"\s*\|\s*lod\.nl\.go\.kr\s*$", "", re.sub(r"\s+", " ", tm[1]).strip()) if tm else ""
            sa = sorted(set(re.findall(r'href="(https?://(?:id\.loc\.gov|viaf\.org|www\.wikidata\.org/entity|isni\.org|d-nb\.info/gnd|id\.ndl\.go\.jp)[^"\s]+)"', h)))
            if lab: a["label_lod"] = lab
            if sa: a["sameAs"] = sorted(set(a.get("sameAs", [])) | set(sa))  # 누적
            a["status"] = "ok"
        except Exception:
            a["status"] = "fail"  # 이전 label_lod·sameAs는 그대로
        a["checked"] = today
    A["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    json.dump(A, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    AUTH.clear(); AUTH.update(A["authorities"])
    return sum(1 for a in A["authorities"].values() if a.get("sameAs"))

AUTH = {}

def place_id(n): return f"{PAGES}places.jsonld#" + urllib.parse.quote(n, safe="")

def place_slug(n):
    """v3.16 지명 컬렉션 파일명 — 첫 로마자 표기(소문자·하이픈), 없으면 지문."""
    import hashlib
    la = next((x for x in place_labels(n) if re.match(r"^[A-Za-z0-9' -]+$", x)), "")
    return re.sub(r"[^a-z0-9]+", "-", la.lower()).strip("-") or "p-" + hashlib.sha1(n.encode()).hexdigest()[:8]

def place_labels(n):
    """PLACES 정규식 대안에서 표기 변이(altLabel)만 — 정규식 문법(부정 전방탐색·?)은 걷어 낸다."""
    out = []
    for x in PLACES[n].split("|"):
        x = re.sub(r"\(\?[!<=][^)]*\)", "", x).replace("-?", "-").replace("?", "")
        if x and x not in out: out.append(x)
    return out

def build_places(recs):
    """v3.14 지명 사전 산출물 — places.json(표준명·표기 변이·기록·수집처)과 places.jsonld(SKOS ConceptScheme). 기준 정보 축적:
    기록 목록은 지우지 않는다(원장에서 빠진 기록이 없으니 누적과 같음, 이전 파일의 기록은 합집합으로 보존)."""
    p = os.path.join(D, "places.json")
    P0 = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}
    out = {}
    for n in PLACES:
        rs = sorted({o["key"] for o in recs if n in (o.get("places_std") or [])} | set(((P0.get("places") or {}).get(n) or {}).get("records") or []))
        out[n] = {"labels": place_labels(n), "records": rs, "sources": sorted({k.split(":")[0] for k in rs})}
        if rs: out[n]["collection"] = f"{PAGES}place/{place_slug(n)}.json"
    # v3.16 지명별 IIIF 컬렉션 — 같은 지명의 기록을 기관 구분 없이 연대순으로(KV에서 한 줄로 이어 보기). 매니페스트 = 원 기관 제공·브리지 구축·기록 봉투
    by = {o["key"]: o for o in recs}; pd_ = os.path.join(D, "place"); os.makedirs(pd_, exist_ok=True); pidx = []
    dkey = lambda o: ((o.get("date_norm") or {}).get("value") or o.get("date") or o.get("date_derived") or "9999")[:10]
    for n, e in out.items():
        L = sorted((by[k] for k in e["records"] if k in by), key=lambda o: (dkey(o), o["key"]))
        items = []
        for o in L:
            mf = (o.get("iiif") if not o.get("iiif_status") else "") or o.get("iiif_built")
            if mf: items.append({"id": mf, "type": "Manifest", "label": {"ko": [f"{SRC_NAME.get(o['key'].split(':')[0], o['key'].split(':')[0])} — {o['title'][:100]}" + (f" ({dkey(o)})" if dkey(o) != "9999" else "")]}})
        if not items: continue
        cid = f"{PAGES}place/{place_slug(n)}.json"; insts = sorted({o["key"].split(":")[0] for o in L})
        json.dump({"@context": "http://iiif.io/api/presentation/3/context.json", "id": cid, "type": "Collection", "label": {"ko": [f"지명 {n} — {len(insts)}개 기관 {len(items)}건(연대순)"]},
                   "summary": {"ko": [f"KOREA ARCHIVE 지명 사전 '{n}'(표기 변이: {', '.join(e['labels'][:8])}) — 표제·기관 장소 칸에 이 지명이 있는 원장 기록. 같은 장소라는 연결 단서(같은 사건·장면 단정 아님). 날짜 없는 기록은 끝에."]},
                   "seeAlso": [{"id": f"{PAGES}places.jsonld", "type": "Dataset", "format": "application/ld+json"}], "items": items}, open(os.path.join(pd_, f"{place_slug(n)}.json"), "w", encoding="utf-8"), ensure_ascii=False)
        pidx.append({"id": cid, "type": "Collection", "label": {"ko": [f"{n} ({len(items)}건 · {len(insts)}개 기관)"]}})
    json.dump({"@context": "http://iiif.io/api/presentation/3/context.json", "id": f"{PAGES}place/index.json", "type": "Collection", "label": {"ko": ["지명별 기록 — KOREA ARCHIVE 지명 사전"]},
               "items": sorted(pidx, key=lambda x: -int(re.search(r"\((\d+)건", x["label"]["ko"][0])[1]))}, open(os.path.join(pd_, "index.json"), "w", encoding="utf-8"), ensure_ascii=False)
    J = {"note": "KOREA ARCHIVE 지명 사전 — 다국어 변환표(TOPICS) 지명 대응 + 기관 로마자 변형을 표준명으로. 표제·기관 장소 칸에서만 매칭(요약 본문 제외). 기관 표기 장소는 subjects.json 그대로 — 이 사전은 그 위의 연결 층. 지우지 않음.",
         "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "places": out}
    json.dump(J, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    sch = f"{PAGES}places.jsonld"
    g = [{"@id": sch, "@type": "skos:ConceptScheme", "skos:prefLabel": {"@value": "KOREA ARCHIVE 지명 사전", "@language": "ko"}}]
    for n, e in out.items():
        g.append({"@id": place_id(n), "@type": ["skos:Concept", "rico:Place"], "skos:inScheme": {"@id": sch}, "skos:prefLabel": {"@value": n, "@language": "ko"},
                  "skos:altLabel": [x for x in e["labels"] if x != n], "rdfs:seeAlso": ([{"@id": e["collection"]}] if e.get("collection") else []) + [{"@id": f"{PAGES}r/{rec_slug(k)}.html"} for k in e["records"][:200]], "ka:records": len(e["records"])})
    json.dump({"@context": {"skos": "http://www.w3.org/2004/02/skos/core#", "rico": "https://www.ica.org/standards/RiC/ontology#", "rdfs": "http://www.w3.org/2000/01/rdf-schema#", "ka": f"{PAGES}#"}, "@graph": g},
              open(os.path.join(D, "places.jsonld"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    return sum(1 for e in out.values() if e["records"])

def envelope_basis(o):
    k = o.get("iiif_kind") or ""
    if not k.startswith("기록 봉투"): return None
    src = o["key"].split(":")[0]
    if "원 기관 페이지에 이 기록의 공개 이미지 없음" in k: t, w = "원 기관 이미지 없음", "브리지가 원 기관 페이지를 판독했으나 이 기록의 공개 이미지 없음"
    elif (r_ := next((f(o) for f in ENVELOPE_RULES.get(src, []) if f(o)), None)): t, w = r_  # v3.11.1 기록 단위 규칙(같은 기관 안에서도 자료 유형별 사유가 다름)
    else: t, w = ENVELOPE_WHY.get(src, ("미구축", "원 기관 IIIF·공개 이미지 경로 미확인 — 다음 개선 대상(부재 단정 아님)"))
    return {"type": t, "why": w, **({"see": "iiif_same"} if o.get("iiif_same") else {}), **({"see_origin": "iiif_origin"} if o.get("iiif_origin") else {})}

def origin_holder(o):
    """v3.11 사본 기록의 원 소장처 계층 — 전자사료관(earchive) 등이 해외 원본의 사본을 낼 때 기관 메타 '소장자(처)'·'문서번호'·계층(Record Group)으로
    원본 쪽 계층을 세운다. 원본 기록의 개별 디지털 사본 존재는 단정하지 않는다(NARA 111-SC 사진은 대부분 번호대 shelflist 목록 단위로만 등재)."""
    md = {m[0]: m[1] for m in (o.get("meta") or []) if m and len(m) > 1}
    holder = md.get("소장자(처)", "")
    if not re.search(r"National Archives and Records Administration|국립문서기록관리청", holder): return None
    rg = re.search(r"Record Group (\d+):?\s*([^›]*)", md.get("계층", "") or str(o.get("partOf") or ""))
    out = {"institution": "NARA(미국 국립문서기록관리청)", "basis": f"사본 기관 메타 '소장자(처)'={holder[:60]}" + (f" · 계층 Record Group {rg[1]}" if rg else ""), "kind": "사본(원본은 원 소장처)"}
    if rg: out["record_group"] = f"RG {rg[1]} {rg[2].strip()}".strip()[:120]
    sc = re.match(r"^SC\s*(\d{3,7})$", md.get("문서번호", "").strip())
    if sc and rg and rg[1] == "111":
        n = int(sc[1]); lo = n // 1000 * 1000
        out["local_id"] = f"111-SC-{n}"
        out["series"] = "111-SC Signal Corps Photographs(흑백)"
        out["finding_aid"] = {"label": f"Shelflist to U.S. Army Signal Corps Black-and-White Photographs: 111-SC-{lo} to 111-SC-{lo + 999}",
                              "search": "https://catalog.archives.gov/search?q=" + urllib.parse.quote(f'"111-SC-{lo} to 111-SC-{lo + 999}"'),
                              "note": "번호대 목록(shelflist) 단위 — 원본 사진 개별 디지털 사본 존재는 미확인"}
        out["basis"] += f" · 문서번호 {md['문서번호']} → NARA 로컬 식별자 111-SC-{n}"
    return out

def iiif_origin(o):
    """v3.9 Node iiifFor의 Gallica 규칙 패리티 — Gallica는 서버 IP 자동 조회가 403(2026-11-23 실측)이라 원장이 매니페스트를 받아 확인할 수 없다.
    그래서 iiif(원장이 판독·수집하는 경로)에 넣지 않고, 디지털 원문 ark(btv1b·bpt6k 등 — 카탈로그 cb ark 아님)로 만든 기관 공식 IIIF 주소를
    '확인 불가·브라우저 열람' 근거와 함께 따로 둔다. 기록 봉투(iiif_built)는 그대로 — 지우지 않는다."""
    u = str(o.get("url") or "")
    m = re.search(r"gallica\.bnf\.fr/ark:/12148/((?!cb)[a-z0-9]+)", u, re.I)
    if m and not (o.get("iiif") and not o.get("iiif_status")):
        return {"manifest": f"https://gallica.bnf.fr/iiif/ark:/12148/{m[1]}/manifest.json", "viewer": f"https://gallica.bnf.fr/ark:/12148/{m[1]}",
                "basis": "Gallica(BnF) 공식 IIIF 규칙 주소(디지털 원문 ark) — 서버 자동 조회 403이라 원장은 내용을 확인하지 못함, 브라우저 뷰어(KV·Mirador)에서 열림"}
    return None

def rec_slug(k):
    import hashlib
    return hashlib.sha1(k.encode("utf-8")).hexdigest()[:12]

REL = {}  # v2.82 key → [(관계, 상대 key, 근거)] — 매 실행 재계산(원장 값에서 파생, 원장 필드는 바꾸지 않음)

def _loc_ids(o):
    """기록 하나가 기관 표기로 가진 식별자들(정규화 소문자) — key·id·옛 key·메타의 로컬 식별자/NAID"""
    out = {o["key"].lower(), (o.get("id") or "").lower()} | {a.lower() for a in (o.get("key_aliases") or [])}
    for k, v in (o.get("meta") or []):
        if k in ("로컬 식별자", "NAID", "identifier", "식별자"): out.add(str(v).strip().lower())
    if o["key"].startswith("nara:NAID "): out.add("naid " + o["key"].split(" ", 1)[1].lower())
    return {x for x in out if x}

ISO_D = re.compile(r"^(1[0-9]\d\d|20\d\d)(-(0[1-9]|1[0-2]))?(-([0-3]\d))?$")

def _norm_d(o, allow_derived=True):
    """비교·차용용 기관 날짜 — ISO 날짜, IA의 'YYYY-01-01T00:00:00Z'(연도만 아는 값의 정규화)는 연도로. 파생은 기관 메타 근거만(같은 기록 차용은 사슬 금지)"""
    d = (o.get("date") or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}T00:00:00Z$", d): d = d[:10]
    if ISO_D.match(d): return (d[:4] if d.endswith("-01-01") else d), "기관 날짜"
    dd = o.get("date_derived") or ""; bs = o.get("date_basis") or ""
    if allow_derived and ISO_D.match(dd) and not bs.startswith("같은 기록"): return dd, "기관 파생 — " + bs
    return "", ""

def date_from_same(recs):
    """v2.84 같은 기록(다른 소장처)끼리 날짜 — ① 교차 확인: 소장처마다 적은 날짜를 나란히 두고 일치·불일치를 기록(date_cross — 증거)
    ② 날짜도 파생 날짜도 없는 기록은 상대 소장처 날짜를 [파생]으로(소장처들이 서로 어긋나면 쓰지 않음). 원 기관 date 필드는 건드리지 않는다."""
    by = {o["key"]: o for o in recs}; n = 0
    for o in recs:
        if (o.get("date_basis") or "").startswith("같은 기록"): o.pop("date_derived", None); o.pop("date_basis", None)
        ps = [(by[b], bs) for t, b, bs in REL.get(o["key"], []) if t == "같은 기록(다른 소장처)" and b in by]
        if not ps: o.pop("date_cross", None); continue
        mine, mb = _norm_d(o)
        cross = [{"key": p["key"], "inst": SRC_NAME.get(p["key"].split(":")[0], p["key"].split(":")[0]), "date": d, "basis": db} for p, _ in ps for d, db in [_norm_d(p)] if d]
        if mine and cross:
            for c in cross: c["agree"] = c["date"].startswith(mine) or mine.startswith(c["date"])
            o["date_cross"] = {"mine": mine, "mine_basis": mb, "others": cross, "verdict": "일치" if all(c["agree"] for c in cross) else "불일치(소장처 표기 다름 — 단정 금지)"}
        else: o.pop("date_cross", None)
        if o.get("date") or o.get("date_derived") or not cross: continue
        best = max(cross, key=lambda c: len(c["date"]))
        if any(not best["date"].startswith(c["date"]) for c in cross): continue  # 소장처 날짜가 서로 다르면 단정하지 않음
        o["date_derived"], o["date_basis"] = best["date"], f"같은 기록의 다른 소장처 표기 — {best['inst']} {best['key']}({best['basis']})"; n += 1
    return n

def ser_key(o):
    """v2.88 같은 계열 비교 열쇠 — 기관 계층 그대로. 단 6·25전쟁 아카이브센터 카드 계층은 도구가 글자 수로 잘라('…Chief' / '…Chief Signal Of')
    같은 계열이 갈라지므로, 기관 표기의 'Record Group 번호'까지로 비교한다(번호 뒤 설명만 버림 — 지어내지 않음)."""
    p = o.get("partOf") or ""
    if o["key"].startswith("koreanwar:"): p = re.sub(r"(Record Group \d+)\b.*$", r"\1", p)
    return p

def build_relations(recs_all):
    """v2.82 맥락 연결 — 기록과 기록을 원장에 이미 있는 기관 표기만으로 잇는다(지어내지 않음). 관계마다 근거를 단다.
    ① 같은 기록(다른 소장처): 기관이 준 sameAs·로컬 식별자 일치(IA 111-adc-N ↔ NARA 로컬 식별자 111-ADC-N 등)
    ② 같은 계열: 기관 계층(partOf)이 같은 기록 — 날짜가 가까운 순 최대 8건(파생 계층은 쓰지 않음)
    ③ 같은 날: 기관 표기 날짜(YYYY-MM-DD)가 같은 다른 기관 기록 — 교차 대조 단서
    docs/data/relations.json(간선 목록)으로 내보내고 기록 페이지·RiC-O에 싣는다."""
    R = [o for o in recs_all if o.get("entry_type", "기록") == "기록"]
    by_id = {}
    for o in R:
        for i in _loc_ids(o): by_id.setdefault(i, set()).add(o["key"])
    rel = {o["key"]: {} for o in R}
    byk = {o["key"]: o for o in R}
    def add(a, b, t, basis):
        if a == b or a not in rel or b not in rel: return
        rel[a].setdefault((t, b), basis); rel[b].setdefault((t, a), basis)
    for o in R:  # ① 기관이 같은 기록이라고 적은 상대(sameAs·입수처 링크·IA 기술 속 NARA 링크, v2.83)
        for kind, v, basis in same_targets(o):
            for x in target_ids(kind, v):
                for k in by_id.get(x, ()):
                    if not k.startswith(TARGET_INST[kind]): continue
                    lv = next((str(m[1]) for m in (byk.get(k, {}).get("meta") or []) if m and m[0] == "기술 수준"), "item")
                    if k.startswith("nara:") and not o["key"].startswith("nara:") and lv.lower() in ("fileunit", "series", "collection", "recordgroup"):  # v3.7.5 입수처 링크가 낱장이 아닌 NARA 파일·시리즈 — 같은 기록이 아니라 그 단위에 포함
                        add(o["key"], k, "원본이 속한 NARA 단위(포함)", f"{basis} — 상대 기술 수준 {lv}(낱장 아님, 같은 기록으로 보지 않음)")
                    else: add(o["key"], k, "같은 기록(다른 소장처)", basis)
        for kind, v in gallery_targets(o):  # v3.7.4 갤러리 재게시(원본 포함) — 같은 기록 아님
            for x in target_ids(kind, v):
                for k in by_id.get(x, ()):
                    if k.startswith(TARGET_INST[kind]): add(o["key"], k, "갤러리 재게시(원본 포함)", "갤러리 카드 '원 기록' 표기 — KOREA ARCHIVE 갤러리 이야기 카드가 이 원본을 포함(같은 기록 아님 — 카드는 여러 기록을 엮음)")
        if o["key"].startswith("ia:"):  # IA 업로드가 NARA 로컬 식별자를 그대로 쓰는 경우
            for k in by_id.get(o["key"][3:].lower(), ()):
                if not k.startswith("ia:"): add(o["key"], k, "같은 기록(다른 소장처)", f"식별자 일치 '{o['key'][3:]}'(IA 식별자 = 기관 로컬 식별자)")
    grp = {}
    for o in R:
        if o.get("partOf"): grp.setdefault((o["key"].split(":")[0], ser_key(o)), []).append(o)
    dk = lambda o: (o.get("date") or o.get("date_derived") or "9999")
    for (inst, part), L in grp.items():  # ② 같은 계열 — 날짜 이웃
        if len(L) < 2: continue
        L.sort(key=lambda o: (dk(o), o["key"]))
        for i, o in enumerate(L):
            for j in sorted(range(len(L)), key=lambda j: (abs(j - i), j))[1:9]:
                rel[o["key"]].setdefault(("같은 계열", L[j]["key"]), f"같은 기관 계층 '{part[:80]}'")
    day = {}; dsrc = {}
    for o in R:
        d = o.get("date") or ""
        if not d and (o.get("date_basis") or "").startswith("기관 메타"):  # v3.3 기관 메타 날짜 칸(생산일·발행일·발신일·포괄 기간)에서 온 일 단위 파생 날짜도 — 표제·상위 계층·다른 소장처 파생은 쓰지 않는다
            d = o.get("date_derived") or ""; dsrc[o["key"]] = o.get("date_basis", "")
        nv = (o.get("date_norm") or {}).get("value", "")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d) and re.match(r"^\d{4}-\d{2}-\d{2}$", nv):  # v3.21 기관 날짜 칸의 일 단위 정규화(원 표기 근거 포함)도
            d = nv; dsrc[o["key"]] = "기관 날짜 칸 정규화 — " + o["date_norm"]["basis"]
        if re.match(r"^\d{4}-\d{2}-\d{2}$", d): day.setdefault(d, []).append(o)
    for d, L in day.items():  # ③ 같은 날 다른 기관
        for a in L:
            for b in L:
                if a["key"].split(":")[0] != b["key"].split(":")[0]:
                    bs = [f"{x['key']} {dsrc[x['key']]}" for x in (a, b) if x["key"] in dsrc]
                    sp = sorted(places(a) & places(b))  # v3.13 같은 지명(지명 사전 — 다국어 변환표 TOPICS 대응) — 같은 날·같은 곳은 같은 사건의 더 강한 단서
                    rel[a["key"]].setdefault(("같은 날(다른 기관)", b["key"]), f"기관 표기 날짜 {d}" + (f" · 같은 지명 {', '.join(sp)}(표제·기관 장소 칸)" if sp else "") + (f" (파생 날짜 포함 — {'; '.join(bs)})" if bs else ""))
    order = {"같은 기록(다른 소장처)": 0, "같은 날(다른 기관)": 1, "원본이 속한 NARA 단위(포함)": 2, "갤러리 재게시(원본 포함)": 3, "같은 계열": 4}
    REL.clear()
    for k, m in rel.items():
        if m: REL[k] = sorted(((t, b, basis) for (t, b), basis in m.items()), key=lambda x: (order[x[0]], x[1]))
    title = {o["key"]: o["title"] for o in R}
    edges = [{"from": a, "to": b, "type": t, "basis": basis} for a, L in sorted(REL.items()) for t, b, basis in L if t != "같은 계열" or a < b]
    cnt = {}
    for e in edges: cnt[e["type"]] = cnt.get(e["type"], 0) + 1
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "note": "기록↔기록 맥락 연결 — 원장의 기관 표기(sameAs·식별자·계층·날짜)에서만 파생, 관계마다 근거. 같은 기록·같은 날은 양방향, 같은 계열은 날짜 이웃 최대 8건",
               "counts": cnt, "records_linked": len(REL), "edges": edges, "titles": {k: title[k][:160] for k in REL}},
              open(os.path.join(D, "relations.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    return cnt

def relations_page(R):
    """v2.86 relations.html — 같은 기록 묶음(기관을 넘는 연결 요소)·같은 날 묶음을 읽기용으로. 묶음마다 기관·날짜·근거, 기록 페이지로 연결"""
    E_ = html.escape; by = {o["key"]: o for o in R}
    def comps(t):
        seen = set(); out = []
        for k in sorted(REL):
            if k in seen or not any(x[0] == t for x in REL[k]): continue
            st = [k]; c = []
            while st:
                a = st.pop()
                if a in seen: continue
                seen.add(a); c.append(a); st += [b for tt, b, _ in REL.get(a, []) if tt == t and b not in seen]
            out.append(sorted(c, key=lambda x: (by[x].get("date") or by[x].get("date_derived") or "", x)))
        return out
    def li(k):
        o = by[k]; inst = SRC_NAME.get(k.split(":")[0], k.split(":")[0]); d = o.get("date") or (("[파생] " + o["date_derived"]) if o.get("date_derived") else "")
        dc = (o.get("date_cross") or {}).get("verdict", "")
        return f"<li><a href='r/{rec_slug(k)}.html'>{E_(o['title'][:110])}</a> <small>{E_(inst)} · {E_(d)}{' · 날짜 교차 ' + E_(dc) if dc else ''}</small></li>"
    def basis(c, t):
        return " · ".join(sorted({bs for a in c for tt, b, bs in REL.get(a, []) if tt == t and b in c}))[:400]
    same = comps("같은 기록(다른 소장처)"); day = comps("같은 날(다른 기관)"); gal = comps("갤러리 재게시(원본 포함)"); inc = comps("원본이 속한 NARA 단위(포함)")  # v3.7.6
    import hashlib
    sd = os.path.join(D, "same"); os.makedirs(sd, exist_ok=True); gids = {}
    for c in same:  # v2.90 같은 기록 묶음마다 IIIF 컬렉션 — 소장처별 매니페스트(원 기관 제공 또는 우리 브리지)를 나란히, 같은 묶음은 같은 파일명(구성 key 지문)
        gid = hashlib.sha1("|".join(sorted(c)).encode()).hexdigest()[:12]; gids[c[0]] = gid
        items = []
        for k in c:
            o = by[k]; mf = (o.get("iiif") if not o.get("iiif_status") else "") or o.get("iiif_built")
            if mf: items.append({"id": mf, "type": "Manifest", "label": {"ko": [f"{SRC_NAME.get(k.split(':')[0], k.split(':')[0])} — {o['title'][:100]}"]}})
        json.dump({"@context": "http://iiif.io/api/presentation/3/context.json", "id": f"{PAGES}same/{gid}.json", "type": "Collection",
                   "label": {"ko": [f"같은 기록 — {len(c)}개 소장처: {by[c[0]]['title'][:80]}"]},
                   "summary": {"ko": ["KOREA ARCHIVE 발견 원장 — 기관 표기(sameAs·식별자·입수처 링크)로 확인된 같은 기록의 소장처별 매니페스트. 근거: " + basis(c, "같은 기록(다른 소장처)")[:300]]},
                   "items": items}, open(os.path.join(sd, f"{gid}.json"), "w", encoding="utf-8"), ensure_ascii=False)
    dd_ = os.path.join(D, "day"); os.makedirs(dd_, exist_ok=True); dids = {}; didx = []
    for o in by.values(): o.pop("same_day", None)  # v3.7.3 매 실행 재계산(원장 값에서 파생)
    for c in day:  # v3.6 같은 날(다른 기관) 묶음마다 IIIF 컬렉션 — 기관별 매니페스트를 한 날짜로(예: 1950-12-24 흥남 — NARA 필름·협약기관 사진·공용 사진). 날짜 근거는 간선 basis 그대로
        dm = re.search(r"\d{4}-\d{2}-\d{2}", basis(c, "같은 날(다른 기관)")); dk_ = dm[0] if dm else ""
        if not dk_: continue
        did = f"{dk_}-{hashlib.sha1('|'.join(sorted(c)).encode()).hexdigest()[:6]}"; dids[c[0]] = did
        items = []
        for k in c:
            o = by[k]; mf = (o.get("iiif") if not o.get("iiif_status") else "") or o.get("iiif_built")
            if mf: items.append({"id": mf, "type": "Manifest", "label": {"ko": [f"{SRC_NAME.get(k.split(':')[0], k.split(':')[0])} — {o['title'][:100]}"]}})
        insts = sorted({SRC_NAME.get(k.split(":")[0], k.split(":")[0]) for k in c})
        for k in c: by[k]["same_day"] = {"date": dk_, "records": len(c), "institutions": len(insts), "collection": f"{PAGES}day/{did}.json"}  # v3.7.3 도구 응답·외부 소비자가 relations.json 없이
        json.dump({"@context": "http://iiif.io/api/presentation/3/context.json", "id": f"{PAGES}day/{did}.json", "type": "Collection",
                   "label": {"ko": [f"같은 날 {dk_} — {len(insts)}개 기관 {len(c)}건"]}, "navDate": f"{dk_}T00:00:00Z",
                   "summary": {"ko": ["KOREA ARCHIVE 발견 원장 — 기관 표기 날짜(원 날짜 칸 또는 기관 메타 날짜 칸)가 같은 다른 기관 기록. 같은 사건의 교차 대조 단서(같은 장면이라는 단정 아님). 근거: " + basis(c, "같은 날(다른 기관)")[:300]]},
                   "items": items}, open(os.path.join(dd_, f"{did}.json"), "w", encoding="utf-8"), ensure_ascii=False)
        didx.append({"id": f"{PAGES}day/{did}.json", "type": "Collection", "label": {"ko": [f"{dk_} — {', '.join(insts)} ({len(c)}건)"]}, "navDate": f"{dk_}T00:00:00Z"})
    json.dump({"@context": "http://iiif.io/api/presentation/3/context.json", "id": f"{PAGES}day/index.json", "type": "Collection", "label": {"ko": ["같은 날 — 다른 기관 기록 묶음(날짜순)"]},
               "items": sorted(didx, key=lambda x: x["navDate"])}, open(os.path.join(dd_, "index.json"), "w", encoding="utf-8"), ensure_ascii=False)
    KV_ = "../kv.html?manifest="
    kvl = lambda c, t: (f" · <a href='{KV_}{PAGES}same/{gids[c[0]]}.json'>KV로 소장처별 나란히 보기</a> · <a href='same/{gids[c[0]]}.json'>IIIF 컬렉션</a>") if t == "같은 기록(다른 소장처)" and c[0] in gids else ((f" · <a href='{KV_}{PAGES}day/{dids[c[0]]}.json'>KV로 기관별 이어 보기</a> · <a href='day/{dids[c[0]]}.json'>IIIF 컬렉션</a>") if t == "같은 날(다른 기관)" and c[0] in dids else "")
    sec = lambda title, note, cs, t: f"<h2>{title} <small>{len(cs)}묶음</small></h2><p><small>{note}</small></p>" + "".join(f"<div class='c'><ul>{''.join(li(k) for k in c)}</ul><p><small>근거: {E_(basis(c, t))}{kvl(c, t)}</small></p></div>" for c in cs)
    open(os.path.join(D, "relations.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>기록↔기록 맥락 연결 — KOREA ARCHIVE 발견 원장</title>
<style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:900px;margin:auto;padding:16px}}a{{color:#e0b04a}}small{{color:#9b9a93}}.c{{border:1px solid #333;border-radius:8px;padding:4px 12px;margin:8px 0}}</style>
<main><p><small>KOREA ARCHIVE 통합검색 · <a href="index.html">원장</a> · <a href="relations.json">relations.json</a> · <a href="tree.html">계층</a> · <a href="subjects.html">주제</a></small></p>
<h1>기록↔기록 맥락 연결</h1><p>원장에 있는 기관 표기(sameAs·식별자·입수처 링크·날짜)만으로 이은 묶음입니다. 지어낸 연결은 없고, 묶음마다 근거를 적었습니다. 같은 계열(기관 계층) 연결은 각 기록 페이지의 '관련 기록'에 있습니다.</p>
{sec("같은 기록 — 여러 소장처", "한 기록이 여러 기관에 있는 경우. 날짜 교차 확인은 기관들이 적은 날짜의 일치 여부", same, "같은 기록(다른 소장처)")}
{sec("같은 날 — 다른 기관 기록", "기관이 적은 날짜가 같은 다른 기관 기록 — 교차 대조 단서(같은 사건이라는 뜻은 아님)", day, "같은 날(다른 기관)")}
{sec("원본이 속한 NARA 단위", "기관 입수처 링크가 낱장이 아닌 NARA 파일·시리즈를 가리키는 경우 — 같은 기록이 아니라 그 단위에 포함(v3.7.5)", inc, "원본이 속한 NARA 단위(포함)")}
{sec("갤러리 재게시 — 원본 포함", "KOREA ARCHIVE 갤러리 이야기 카드가 원 기관 원본을 포함(카드는 여러 기록을 엮음 — 같은 기록 아님, v3.7.4)", gal, "갤러리 재게시(원본 포함)")}
</main></html>""")

def cite_of(o, inst, pu):
    """v2.85 기록별 인용문 — 기관 표기 그대로(소장 기관, 제목, 계층, 식별자, 날짜) + 원 기관 주소 + 확인일(원장 최근 발견) + 원장 영구 페이지.
    파생 날짜는 [파생]으로 밝힌다. 한국어 학술 각주형 · Chicago 형 두 가지."""
    d = o.get("date") or ""; dd = o.get("date_derived") or ""
    dtxt = d or (f"[파생] {dd}" if dd else "날짜 미상")
    seen = (o.get("last_seen") or o.get("first_seen") or "")[:10]
    part = o.get("partOf") or ""; ident = o.get("id") or o["key"]; url = o.get("url") or ""
    ko = f"{inst}, 「{o['title'][:200]}」" + (f", {part}" if part else "") + f", {ident}, {dtxt}" + (f", {url}" if url else "") + f" (확인 {seen}; KOREA ARCHIVE 발견 원장 {pu})."
    en = f"\u201c{o['title'][:200]}.\u201d {dtxt}. " + (f"{part}. " if part else "") + f"{ident}. {inst}." + (f" {url}" if url else "") + f" Accessed {seen}. Ledger page: {pu}."
    return ko, en

def build_record_pages(recs_all):
    """v2.73 기록마다 영구 공개 페이지(docs/data/r/<slug>.html) — 맥락(소장·계층·날짜와 근거)·증거(지문 이력·발견 경로·옛 key)·IIIF·권리를 한 장에,
    schema.org ArchiveComponent JSON-LD로 검색엔진이 읽게. r/index.json(key→페이지)·sitemap.xml. 결함 출력·검색 안내도 만들되 상단에 고지(v2.74 — 다른 산출물 링크가 끊기지 않게)."""
    E_ = html.escape; KV = "https://changgi.github.io/korea-archive-mcp/kv.html?manifest="
    rd = os.path.join(D, "r"); os.makedirs(rd, exist_ok=True)
    idx = {}; urls = []; TITLES = {o["key"]: o["title"] for o in recs_all}; TURL = {o["key"]: o.get("url") for o in recs_all if o.get("url")}
    for o in recs_all:
        # v2.74 결함 출력·검색 안내도 페이지를 만든다 — 다른 산출물의 링크가 끊기지 않게, 상단에 결함 고지
        sl = rec_slug(o["key"]); idx[o["key"]] = f"r/{sl}.html"; pu = f"{PAGES}r/{sl}.html"; urls.append((pu, o.get("last_seen", "")[:10]))
        inst = SRC_NAME.get(o["key"].split(":")[0], o["key"].split(":")[0])
        part = o.get("partOf") or ""; pder = o.get("partOf_derived") or ""
        date = o.get("date") or ""; dd = o.get("date_derived") or ""
        mf = (o.get("iiif") if not o.get("iiif_status") else "") or o.get("iiif_built") or ""
        row = lambda k, v: f"<tr><th>{E_(k)}</th><td>{v}</td></tr>" if v else ""
        meta = "".join(row(str(k), E_(str(v))) for k, v in (o.get("meta") or []) if not str(v).startswith("http"))
        fx = "".join(f"<li>{E_(f.get('at', ''))} · {E_(f.get('kind', ''))} · {E_(f.get('h', ''))}</li>" for f in (o.get("fixity") or []))
        fb = "".join(f"<li><a href='../q/{E_(ak)}.json'>질의 {E_(ak)}</a> — {E_((o.get('found_by_basis') or {}).get(ak, ''))}</li>" for ak in (o.get("found_by") or []))
        ld = {"@context": "https://schema.org", "@type": "ArchiveComponent", "name": o["title"][:300], "url": pu, "sameAs": [x for x in (o.get("url"),) if x] + [TURL[b_] for t_, b_, _ in REL.get(o["key"], []) if t_ == "같은 기록(다른 소장처)" and TURL.get(b_)],  # v2.91 다른 소장처의 같은 기록 주소
              "identifier": o.get("id") or o["key"], "holdingArchive": {"@type": "ArchiveOrganization", "name": inst}, **({"dateCreated": date or dd} if (date or dd) else {}),
              **({"isPartOf": part or pder} if (part or pder) else {}), **({"description": (o.get("summary") or o.get("summary_composed") or "")[:500]} if (o.get("summary") or o.get("summary_composed")) else {}),
              **({"usageInfo": o["rights_view"][:300]} if o.get("rights_view") else {}), **({"associatedMedia": {"@type": "MediaObject", "contentUrl": mf, "encodingFormat": "application/ld+json;profile=iiif"}} if mf else {}), **({"isRelatedTo": [f"{PAGES}r/{rec_slug(b_)}.html" for t_, b_, _ in REL.get(o["key"], [])[:20]]} if REL.get(o["key"]) else {})}
        ld["citation"] = cite_of(o, inst, pu)[0]
        js = json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")
        cko, cen = cite_of(o, inst, pu)
        rj = {k: v for k, v in o.items() if k not in ("days",)}  # v2.85 기록별 기계 판독 JSON — 원장 항목 그대로 + 관계·인용
        rj.update({"page": pu, "related": [{"type": t_, "key": b_, "page": f"{PAGES}r/{rec_slug(b_)}.html", "basis": bs_} for t_, b_, bs_ in REL.get(o["key"], [])], "cite": {"ko": cko, "chicago": cen}})
        json.dump(rj, open(os.path.join(rd, f"{sl}.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        dc = o.get("date_cross") or {}
        dch = (E_(dc["verdict"]) + " — 이 기록 " + E_(dc["mine"]) + "".join(" · <a href='" + E_(rec_slug(c["key"])) + ".html'>" + E_(c["inst"]) + "</a> " + E_(c["date"]) + ("" if c.get("agree") else " ✕") for c in dc["others"])) if dc else ""
        open(os.path.join(rd, f"{sl}.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{E_(o['title'][:120])} — KOREA ARCHIVE 발견 원장</title><link rel="canonical" href="{pu}"><link rel="alternate" type="application/json" href="{sl}.json"><script type="application/ld+json">{js}</script>
<style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:860px;margin:auto;padding:16px}}a{{color:#e0b04a}}th{{text-align:left;color:#9b9a93;font-weight:400;padding:3px 10px 3px 0;vertical-align:top;white-space:nowrap}}td{{padding:3px 0}}small{{color:#9b9a93}}</style>
<main><p><small>KOREA ARCHIVE 통합검색 · 발견 원장 기록 · <a href="../index.html">원장</a> · <a href="../tree.html">계층</a> · <a href="../subjects.html">주제</a></small></p>
{f"<p style='border:1px solid #c66;padding:8px'>⚠ {E_(o.get('entry_type', ''))} — {E_(o.get('defect_note') or '옛 판독기 오류 출력. 원장에는 증거로 보존하나 인용·피드·타임라인에서는 제외')}</p>" if o.get('entry_type', '기록') != '기록' else ''}
<h1>{E_(o['title'][:300])}</h1><table>
{row('소장 기관', E_(inst))}{row('원 기관 링크', f"<a href='{E_(o.get('url') or '')}'>{E_((o.get('url') or '')[:100])}</a>" if o.get('url') else '')}{row('식별자', E_(o.get('id') or ''))}
{row('계층', E_(part) + (f" <small>(근거: {E_(o.get('partOf_src', ''))})</small>" if o.get('partOf_src') else '') if part else (E_(pder) + ' <small>[파생]</small>' if pder else ''))}
{row('날짜', E_(date) if date else (E_(dd) + f" <small>[파생 — {E_(o.get('date_basis', ''))}]</small>" if dd else ''))}{row('연대', E_(decade(o)))}{row('날짜 교차 확인', dch)}
{row('요약', E_(o.get('summary') or '') or (E_(o.get('summary_composed') or '')))}{row('권리', E_(o.get('rights_view') or '') + (f" <small>({E_(o.get('rights_basis', ''))})</small>" if o.get('rights_basis') else ''))}
{row('IIIF', f"<a href='{KV}{E_(mf)}'>KV 뷰어로 보기</a> · <a href='{E_(mf)}'>매니페스트</a> <small>({E_(o.get('iiif_kind', ''))})</small>" if mf else '')}{row('같은 날 다른 기관 기록', f"{E_(o['same_day']['date'])} — {o['same_day']['institutions']}개 기관 {o['same_day']['records']}건 · <a href='{KV}{E_(o['same_day']['collection'])}'>KV로 기관별 이어 보기</a> · <a href='{E_(o['same_day']['collection'])}'>IIIF 컬렉션</a> <small>(같은 사건 교차 대조 단서 — 같은 장면이라는 단정 아님)</small>" if o.get('same_day') else '')}{row('원 소장처(사본의 원본)', f"{E_(o['origin_holder']['institution'])}{' · ' + E_(o['origin_holder']['record_group']) if o['origin_holder'].get('record_group') else ''}{' · ' + E_(o['origin_holder']['local_id']) if o['origin_holder'].get('local_id') else ''}{' · 목록 단위 <a href=' + chr(39) + E_(o['origin_holder']['finding_aid']['search']) + chr(39) + '>' + E_(o['origin_holder']['finding_aid']['label']) + '</a>' if o['origin_holder'].get('finding_aid') else ''} <small>({E_(o['origin_holder']['basis'])})</small>" if o.get('origin_holder') else '')}{row('기관 전거', ' · '.join(f"{E_(t)} <a href='https://lod.nl.go.kr/page/{E_(i)}'>{E_(i)}</a>" + ''.join(f" <a href='{E_(x)}'>{E_(re.sub(r'^https?://(www[.])?', '', x).split('/')[0])}</a>" for x in (AUTH.get(i) or {}).get('sameAs', [])[:4]) for t, i in o['authority_ids']['terms'].items()) + " <small>(국립중앙도서관 LOD — 외부 전거는 LOD 페이지의 owl:sameAs)</small>" if o.get('authority_ids') else '')}{row('날짜 정규화', f"{E_(o['date_norm']['value'])} <small>({E_(o['date_norm']['basis'])} — 원 표기는 날짜 칸 그대로)</small>" if o.get('date_norm') else '')}{row('날짜 주의', E_(o['date_note']['note']) if o.get('date_note') else '')}{row('사건-날짜 대조', f"{E_(o['event_date_check']['event'])}({E_(o['event_date_check']['event_period'])}) ↔ 기록 {E_(o['event_date_check']['recorded'])} [{E_(o['event_date_check']['date_source'])}] — <b>{E_(o['event_date_check']['verdict'])}</b>" if o.get('event_date_check') else '')}{row('지명(표준)', ' · '.join(f"<a href='{KV}{PAGES}place/{place_slug(n)}.json'>{E_(n)}</a>" for n in o['places_std']) + " <small>(지명 사전 — 표제·기관 장소 칸 매칭)</small>" if o.get('places_std') else '')}{row('이미지 없는 사유', f"{E_(o['envelope_basis']['type'])} — {E_(o['envelope_basis']['why'])}" if o.get('envelope_basis') else '')}{row('원 기관 IIIF(브라우저 열람)', f"<a href='{KV}{E_(o['iiif_origin']['manifest'])}'>KV 뷰어로 보기</a> · <a href='{E_(o['iiif_origin']['manifest'])}'>매니페스트</a> · <a href='{E_(o['iiif_origin']['viewer'])}'>기관 뷰어</a> <small>({E_(o['iiif_origin']['basis'])})</small>" if o.get('iiif_origin') else '')}{row('같은 기록 실물 이미지', f"<a href='{KV}{E_(o['iiif_same']['manifest'])}'>KV 뷰어로 보기</a> · <a href='{E_(o['iiif_same']['manifest'])}'>매니페스트</a> <small>({E_(o['iiif_same']['basis'])})</small>" if o.get('iiif_same') else '')}
{row('발견', f"처음 {E_(o.get('first_seen', '')[:10])} · 최근 {E_(o.get('last_seen', '')[:10])} · {o.get('seen', 1)}회 · 출처 {E_('+'.join(o.get('sources') or []))}")}
{row('같은 기록(기관 표기)', E_(o.get('sameAs') or '') + ('' if any(t_ == '같은 기록(다른 소장처)' for t_, _, _ in REL.get(o['key'], [])) else ' <small>(원장에 아직 없는 기록 — 기관 sameAs 표기 그대로)</small>') if o.get('sameAs') else '')}{row('옛 key', E_(', '.join(o.get('key_aliases') or [])))}{row('비고', E_(o.get('merge_note') or o.get('recovered') or o.get('harvested') or ''))}{row('발굴 경위', E_(o.get('found_via') or '') + (f" <small>(출발 기록 <a href='{E_(rec_slug(o['drilled_from']))}.html'>{E_(o['drilled_from'])}</a>)</small>" if o.get('drilled_from') else '') if o.get('found_via') else '')}
</table>{('<h2>주제·분류 (기관 표기)</h2><p>' + ' · '.join(f"<a href='../subjects.html#{E_(subj_anchor(f_, t_))}'>{E_(f_)}: {E_(t_)}</a>" for f_, t_ in record_concepts(o)[:30]) + '</p>') if record_concepts(o) else ''}
{('<h2>관련 기록 (맥락 연결)</h2><ul>' + ''.join(f"<li>{E_(t_)} · <a href='{E_(rec_slug(b_))}.html'>{E_(TITLES.get(b_, b_)[:120])}</a> <small>({E_(bs_)})</small></li>" for t_, b_, bs_ in REL.get(o['key'], [])[:20]) + '</ul>') if REL.get(o['key']) else ''}
{('<h2>기관 메타</h2><table>' + meta + '</table>') if meta else ''}{('<h2>원문 지문 이력</h2><ul>' + fx + '</ul>') if fx else ''}{('<h2>발견 경로</h2><ul>' + fb + '</ul>') if fb else ''}
<h2>인용</h2><p style="font-size:14px">{E_(cko)}</p><p style="font-size:13px;color:#9b9a93">{E_(cen)}</p><p><small><a href="{sl}.json">이 기록 JSON(기계 판독 — 원장 항목·관계·인용)</a></small></p>
<p><small>원장 key <code>{E_(o['key'])}</code> · 원 기관 표기 그대로, 파생 정보는 [파생]·근거 표시 · 축적 정보는 지우지 않는다</small></p></main></html>""")
    json.dump({"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "pages": idx}, open(os.path.join(rd, "index.json"), "w", encoding="utf-8"), ensure_ascii=False)
    sm = "".join(f"<url><loc>{u}</loc>{f'<lastmod>{d}</lastmod>' if d else ''}</url>" for u, d in [(PAGES, ""), (PAGES + "subjects.html", ""), (PAGES + "tree.html", ""), (PAGES + "timeline.html", ""), (PAGES + "relations.html", "")] + urls)
    open(os.path.join(D, "sitemap.xml"), "w", encoding="utf-8").write(f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{sm}</urlset>')
    return len(idx)

def build_digest(recs_all, today):
    """v2.77 주간 발견 소식 — 그 주(ISO 주)에 처음 발견된 기록을 수집처별로 묶은 HTML·JSON(docs/data/digest/YYYY-Www.*). 주마다 새 파일로 쌓고 지우지 않는다
    (지난 주 파일은 그 주가 끝나면 더 바뀌지 않는다 — 처음 발견 시각이 고정이므로). 각 항목은 기록별 영구 페이지로."""
    E_ = html.escape; dd = os.path.join(D, "digest"); os.makedirs(dd, exist_ok=True)
    recs = [o for o in recs_all if o.get("entry_type", "기록") == "기록" and o.get("first_seen")]
    weeks = {}
    for o in recs:
        try: y, w, _ = dt.date.fromisoformat(o["first_seen"][:10]).isocalendar()
        except ValueError: continue
        weeks.setdefault(f"{y}-W{w:02d}", []).append(o)
    for wk, L in weeks.items():
        by = {}
        for o in sorted(L, key=lambda o: o["first_seen"]): by.setdefault(SRC_NAME.get(o["key"].split(":")[0], o["key"].split(":")[0]), []).append(o)
        sec = "".join(f"<h2>{E_(inst)} <small>{len(v)}건</small></h2><ul>" + "".join(
            f"<li><a href='../r/{rec_slug(o['key'])}.html'>{E_(o['title'][:140])}</a> <small>{E_(o.get('date') or o.get('date_derived') or decade(o) or '')}"
            f"{' · ' + E_((o.get('partOf') or '')[:60]) if o.get('partOf') else ''}</small></li>" for o in v) + "</ul>" for inst, v in sorted(by.items(), key=lambda kv: -len(kv[1])))
        open(os.path.join(dd, f"{wk}.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>주간 발견 소식 {wk} — KOREA ARCHIVE 발견 원장</title><link rel="alternate" type="application/atom+xml" href="../feed.xml">
<style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:860px;margin:auto;padding:16px}}a{{color:#e0b04a}}small{{color:#9b9a93}}li{{margin:4px 0}}</style>
<main><p><small><a href="index.html">주간 소식 목록</a> · <a href="../index.html">원장</a></small></p><h1>주간 발견 소식 {wk}</h1>
<p>이 주에 사용자들이 KOREA ARCHIVE 통합검색으로 처음 발굴한 기록 {len(L)}건(수집처 {len(by)}곳). 원 기관 표기 그대로, 파생 정보는 기록 페이지에 근거와 함께.</p>{sec}</main></html>""")
        json.dump({"week": wk, "records": len(L), "by_source": {k: len(v) for k, v in by.items()}, "items": [{"key": o["key"], "title": o["title"][:200], "first_seen": o["first_seen"], "page": f"r/{rec_slug(o['key'])}.html", "url": o.get("url", "")} for o in L]},
                  open(os.path.join(dd, f"{wk}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    allw = sorted((f[:-5] for f in os.listdir(dd) if f.endswith(".html") and f != "index.html"), reverse=True)
    rows = "".join(f"<li><a href='{w}.html'>{w}</a> <small>{len(weeks.get(w, [])) or ''}</small></li>" for w in allw)
    open(os.path.join(dd, "index.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><title>주간 발견 소식 — KOREA ARCHIVE</title>
<style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;background:#14161b;color:#e6e4dc}}main{{max-width:860px;margin:auto;padding:16px}}a{{color:#e0b04a}}small{{color:#9b9a93}}</style>
<main><h1>주간 발견 소식</h1><p>주마다 처음 발굴된 기록을 모은 소식(쌓기만 하고 지우지 않음). <a href="../feed.xml">Atom 구독</a> · <a href="../index.html">원장</a></p><ul>{rows}</ul></main></html>""")
    return len(weeks)

def build_activity(recs, size=500):
    """v3.2 IIIF Change Discovery API 1.0(Activity Streams 2.0) — 하베스터가 변경분만 거두게.
    Create = 원장 첫 발견(first_seen)의 매니페스트 · Update = 원 기관 응답 지문 변경(fixity 이력, '첫 지문' 제외).
    원장에서 매번 결정적으로 다시 만든다(원장을 지우지 않으므로 활동도 줄지 않는다). activity/collection.json + page-N.json."""
    ev = []
    for o in recs:
        if o.get("entry_type", "기록") != "기록": continue
        mf = (o.get("iiif") if not o.get("iiif_status") else "") or o.get("iiif_built")
        if not mf: continue
        obj = {"id": mf, "type": "Manifest", "seeAlso": [{"id": f"{PAGES}r/{rec_slug(o['key'])}.json", "type": "Dataset", "format": "application/json", "label": {"ko": ["KOREA ARCHIVE 원장 기록(맥락·증거)"]}}]}
        if o.get("first_seen"): ev.append({"type": "Create", "object": obj, "endTime": o["first_seen"][:19].rstrip("Z") + "Z", "_k": o["key"]})
        for fx in (o.get("fixity") or [])[1:]:
            if fx.get("at") and fx.get("kind") != "첫 지문":
                ev.append({"type": "Update", "object": obj, "endTime": f"{fx['at'][:10]}T00:00:00Z", "summary": f"원 기관 응답 지문 변경({fx.get('kind', '')})", "_k": o["key"]})
    ev.sort(key=lambda e: (e["endTime"], e["_k"], e["type"]))
    for e in ev: e.pop("_k")
    ad = os.path.join(D, "activity"); os.makedirs(ad, exist_ok=True)
    base = PAGES + "activity/"; CTX = "http://iiif.io/api/discovery/1/context.json"
    pages = [ev[i:i + size] for i in range(0, len(ev), size)] or [[]]
    for n, P in enumerate(pages):
        pg = {"@context": CTX, "id": f"{base}page-{n}.json", "type": "OrderedCollectionPage", "startIndex": n * size,
              "partOf": {"id": base + "collection.json", "type": "OrderedCollection"}, "orderedItems": P}
        if n: pg["prev"] = {"id": f"{base}page-{n - 1}.json", "type": "OrderedCollectionPage"}
        if n < len(pages) - 1: pg["next"] = {"id": f"{base}page-{n + 1}.json", "type": "OrderedCollectionPage"}
        json.dump(pg, open(os.path.join(ad, f"page-{n}.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump({"@context": CTX, "id": base + "collection.json", "type": "OrderedCollection", "totalItems": len(ev),
               "summary": "KOREA ARCHIVE 통합검색 발견 원장의 IIIF 매니페스트 생성(원장 첫 발견)·갱신(원 기관 응답 지문 변경) 활동 — IIIF Change Discovery API 1.0",
               "first": {"id": base + "page-0.json", "type": "OrderedCollectionPage"}, "last": {"id": f"{base}page-{len(pages) - 1}.json", "type": "OrderedCollectionPage"}},
              open(os.path.join(ad, "collection.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return len(ev)

def build_catalog(recs, nql):
    import hashlib
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    dist = []
    for f, mt, lbl in DISTS:
        fp = os.path.join(D, f)
        if not os.path.exists(fp): continue
        h = hashlib.sha256(open(fp, "rb").read()).hexdigest()
        dist.append({"@type": "dcat:Distribution", "dct:title": lbl, "dcat:downloadURL": {"@id": PAGES + f}, "dcat:mediaType": mt, "dcat:byteSize": os.path.getsize(fp),
                     "spdx:checksum": {"@type": "spdx:Checksum", "spdx:algorithm": "spdx:checksumAlgorithm_sha256", "spdx:checksumValue": h}})
    srcs = sorted({SRC_NAME.get(o["key"].split(":")[0], o["key"].split(":")[0]) for o in recs if o.get("entry_type", "기록") == "기록"})
    ds = {"@id": PAGES + "catalog.jsonld#dataset", "@type": "dcat:Dataset", "dct:title": "KOREA ARCHIVE 통합검색 — 발견 누적 원장",
          "dct:description": f"사용자들이 KOREA ARCHIVE 통합검색 도구로 국내외 아카이브에서 발굴한 한국 관련 기록 {len(recs)}건의 재기술·계층·IIIF·권리 표시·발견 경로·질의 축적. 원 기관 표기 그대로, 파생 정보는 [파생] 표시, 축적 정보는 지우지 않는다.",
          "dct:modified": now, "dct:publisher": {"@type": "foaf:Agent", "foaf:name": "KOREA ARCHIVE 통합검색"}, "dcat:landingPage": {"@id": PAGES},
          "dcat:keyword": ["한국", "Korea", "아카이브", "기록물", "IIIF", "RiC-O", "한국전쟁", "조선"], "dct:language": ["ko", "en"],
          "dct:source": srcs, "dct:accrualPeriodicity": {"@id": "http://purl.org/cld/freq/daily"},
          "dct:rights": "기록마다 원 기관 권리 표기(rights_view) — 재이용은 원 기관 이용조건을 따른다. 원장 메타데이터 집성은 출처 표기 하에 자유 이용.",
          "dcat:distribution": dist, "ka:quality": nql}
    json.dump({"@context": {"dcat": "http://www.w3.org/ns/dcat#", "dct": "http://purl.org/dc/terms/", "foaf": "http://xmlns.com/foaf/0.1/", "spdx": "http://spdx.org/rdf/terms#",
                            "ka": PAGES + "catalog.jsonld#"}, "@graph": [{"@id": PAGES + "catalog.jsonld", "@type": "dcat:Catalog", "dct:title": "KOREA ARCHIVE 통합검색 데이터 목록", "dcat:dataset": {"@id": ds["@id"]}}, ds]},
              open(os.path.join(D, "catalog.jsonld"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    sd = {"@context": "https://schema.org", "@type": "Dataset", "name": ds["dct:title"], "description": ds["dct:description"], "url": PAGES, "dateModified": now,
          "keywords": ds["dcat:keyword"], "inLanguage": ["ko", "en"], "isAccessibleForFree": True, "creator": {"@type": "Organization", "name": "KOREA ARCHIVE 통합검색"},
          "license": "https://changgi.github.io/korea-archive-mcp/data/catalog.jsonld#rights", "measurementTechnique": "MCP 도구 발굴 + 원 기관 API·IIIF 판독",
          "distribution": [{"@type": "DataDownload", "encodingFormat": d["dcat:mediaType"], "contentUrl": d["dcat:downloadURL"]["@id"], "name": d["dct:title"]} for d in dist]}
    ip = os.path.join(D, "index.html")
    if os.path.exists(ip):
        t = open(ip, encoding="utf-8").read()
        t = re.sub(r'<script type="application/ld\+json" id="ka-dataset">.*?</script>', "", t, flags=re.S)
        js = json.dumps(sd, ensure_ascii=False).replace("</", "<\\/")
        t = t.replace("</title>", f'</title><script type="application/ld+json" id="ka-dataset">{js}</script><link rel="describedby" type="application/ld+json" href="catalog.jsonld">', 1)
        open(ip, "w", encoding="utf-8").write(t)
    return len(dist)

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

NARA_LINK = re.compile(r"catalog\.archives\.gov/id/(\d+)")

def same_targets(o):
    """v2.83 기관이 '같은 기록'이라고 적은 상대 — (종류, 값, 근거). sameAs 필드, 입수처 링크(6·25전쟁 아카이브센터), IA 기술 속 NARA 카탈로그 링크"""
    out = []; sa = (o.get("sameAs") or "").strip()
    m = re.match(r"^(?:koreanwar:)?(\d{4}-[A-Z]{2}-\d{2}-[A-Z]{2}-[A-Z]-\d+)$", sa)
    if m: out.append(("kw", m[1], f"기관 sameAs 표기 '{sa}'"))
    m = re.match(r"^NARA (\S+)$", sa)
    if m: out.append(("nara_local", m[1], f"기관 sameAs 표기 '{sa}'"))
    m = re.match(r"^(?:nara:)?NAID (\d+)$", sa)
    if m: out.append(("naid", m[1], f"기관 sameAs 표기 '{sa}'"))
    m = re.match(r"^ia:(\S+)$", sa)
    if m: out.append(("ia", m[1], f"기관 sameAs 표기 '{sa}'"))
    if not o["key"].startswith("nara:"):
        for k, v in (o.get("meta") or []):
            mm = NARA_LINK.search(str(v)) if k in ("입수처 링크", "source", "description") else None
            if mm: out.append(("naid", mm[1], f"기관 메타 '{k}'의 NARA 카탈로그 링크"))
        mm = NARA_LINK.search(o.get("summary") or "") if o["key"].startswith("ia:") else None
        if mm: out.append(("naid", mm[1], "IA 기술(description)의 NARA 카탈로그 링크"))
    seen = set(); return [t for t in out if not (t[:2] in seen or seen.add(t[:2]))]

TARGET_INST = {"kw": "koreanwar:", "nara_local": "nara:", "naid": "nara:", "ia": "ia:"}  # 상대 기록의 소장처 — IA 식별자가 NARA 로컬 식별자와 같아 자기 자신에 걸리지 않게

def gallery_targets(o):
    """v3.7.4 갤러리 카드의 '원 기록' 표기(NAID·archive.org 식별자) — 카드는 여러 기록을 엮은 이야기 카드라 '같은 기록'이 아니라 '갤러리 재게시(원본 포함)'
    (v3.2.1이 같은 기록으로 이어 날짜 교차가 '불일치'로 드러난 과장 교정)."""
    out = []
    if not o["key"].startswith("gallery:"): return out
    for k, v in (o.get("meta") or []):
        if k != "원 기록": continue
        out += [("naid", n) for n in re.findall(r"NAID (\d+)", str(v))] + [("ia", i) for i in re.findall(r"archive\.org (\S+?)(?=\s|\(|$)", str(v))]
    return out

def target_ids(kind, v):
    return {"kw": {f"koreanwar:{v}".lower(), v.lower()}, "nara_local": {v.lower()}, "naid": {f"naid {v}", f"nara:naid {v}"}, "ia": {f"ia:{v}".lower()}}[kind]

def kw_hier_pass(led, today, budget=10):
    """v2.87 6·25전쟁 아카이브센터 기록 중 기관 계층이 없는 것 — koreanwar_search를 제목으로 불러 **같은 참조코드 카드**의 '계층'(기관 분류 경로)만 쓴다.
    다른 카드·형제 기록의 계층은 쓰지 않는다. 카드가 없으면 kw_hier_tried(7일 뒤 재시도)."""
    used = got = 0
    for o in sorted(led.values(), key=lambda x: x["key"]):
        if used >= budget: break
        if not o["key"].startswith("koreanwar:") or o.get("partOf") or o.get("entry_type", "기록") != "기록": continue
        if o.get("kw_hier_tried", "") > (today - dt.timedelta(days=7)).isoformat(): continue
        ref = o["key"].split(":", 1)[1]; q = re.sub(r"\s*기록영상$", "", o["title"]).split(";")[-1].strip()[:40]
        if not q: continue
        used += 1
        try: t = mcp_call("koreanwar_search", {"query": q, "max_results": 20})
        except Exception as ex: print(f"koreanwar 계층 조회 실패 {ref}: {str(ex)[:60]}"); continue
        o["kw_hier_tried"] = today.isoformat()
        m = re.search(r"- \[" + re.escape(ref) + r"\][^\n]*\n\s+생산:[^\n]*\| 계층: ([^\n]+)", t)
        if m:
            o["partOf"] = "협약 › " + m[1].strip(); o["partOf_src"] = f"koreanwar_search 카드 계층(같은 참조코드 {ref}, 기관 표기 — 도구가 줄인 경우 그대로)"; got += 1
        time.sleep(0.6)
    return used, got

def tna_hier_pass(led, today, budget=10):
    """v3.4 TNA Discovery 기록 중 기관 계층이 없는 것(최상위 컬렉션·시리즈) — records/v1/details의 기관 값으로 계층을 세운다(지어내지 않음).
    · 다른 기록관 소장(heldBy가 Kew가 아님): 'TNA Discovery › 소장 기관'(이 기록이 그 기관 컬렉션의 최상위) — Discovery가 목록만 실은 외부 소장 컬렉션
    · Kew 소장: 'TNA › 부서'(참조번호 첫 마디 — 다른 TNA 기록 계층과 같은 형식). 실패·무값은 tna_hier_tried(7일 뒤 재시도)."""
    used = got = 0
    for o in sorted(led.values(), key=lambda x: x["key"]):
        if used >= budget: break
        if not o["key"].startswith("tna:") or o.get("partOf") or o.get("entry_type", "기록") != "기록": continue
        if o.get("tna_hier_tried", "") > (today - dt.timedelta(days=7)).isoformat(): continue
        m = re.search(r"/details/r/([A-Za-z0-9-]+)", o.get("url") or "")
        if not m: continue
        used += 1; o["tna_hier_tried"] = today.isoformat()
        try: j = get(f"https://discovery.nationalarchives.gov.uk/API/records/v1/details/{m[1]}")
        except Exception as ex: print(f"TNA 계층 조회 실패 {o['key']}: {str(ex)[:60]}"); continue
        held = [h.get("xReferenceName") for h in j.get("heldBy") or [] if h.get("xReferenceName")]
        ref = (j.get("citableReference") or o["key"].split(":", 1)[1]).strip()
        if held and not any("National Archives, Kew" in h for h in held):
            o["partOf"] = f"TNA Discovery › {held[0]}"; o["partOf_src"] = f"TNA Discovery details(heldBy 소장 기관 · parentId {j.get('parentId', '')} · 기술 수준 {j.get('catalogueLevel', '')})"; got += 1
        elif re.match(r"^[A-Z]{1,6}[\s/]", ref):
            o["partOf"] = f"TNA › {re.split(r'[\s/]', ref)[0]}"; o["partOf_src"] = f"TNA Discovery details(참조번호 {ref}의 부서 · parentId {j.get('parentId', '')})"; got += 1
        time.sleep(0.5)
    return used, got

def nlk_hier_pass(led, today, budget=10):
    """v3.4.1 국립중앙도서관 기록 중 기관 계층이 없는 것 — nlk_search를 제목으로 불러 **같은 식별자(viewKey·cno) 줄**의 기관 자료유형([지도자료] 등)으로
    '자료유형 › X'(cross_search nlk 계층과 같은 형식)을 세운다. 날짜가 비었으면 같은 줄의 발행 연도도(기관 값). 다른 줄은 쓰지 않는다. 실패·무일치는 7일 뒤 재시도."""
    used = got = 0
    for o in sorted(led.values(), key=lambda x: x["key"]):
        if used >= budget: break
        if not o["key"].startswith("nlk:") or o.get("partOf") or o.get("entry_type", "기록") != "기록": continue
        if o.get("nlk_hier_tried", "") > (today - dt.timedelta(days=7)).isoformat(): continue
        i = o["key"].split(":", 1)[1]; q = o["title"].strip()[:60]
        used += 1; o["nlk_hier_tried"] = today.isoformat()
        try: t = mcp_call("nlk_search", {"query": q})
        except Exception as ex: print(f"국립중앙도서관 계층 조회 실패 {o['key']}: {str(ex)[:60]}"); continue
        for ln in t.splitlines():
            if re.search(r"(?:viewKey|cno)=" + re.escape(i) + r"(?![\w-])", ln):
                m = re.search(r" \[([^\]]{2,12})\] · ", ln)
                if m:
                    o["partOf"] = f"자료유형 › {m[1]}"; o["partOf_src"] = f"nlk_search 같은 식별자({i}) 줄의 기관 자료유형"; got += 1
                    y = re.search(r"\((\[?\d{4}\]?\d{0,4})\)\s+https?://", ln)
                    if y and not o.get("date"): o["date"] = y[1]; o["date_src"] = f"nlk_search 같은 식별자({i}) 줄의 기관 발행 연도"
                break
        time.sleep(0.6)
    return used, got

def sameas_pass(led, today, budget=10):
    """v2.83 같은 기록 추적 — 기관이 같은 기록이라고 적은 상대가 원장에 없으면 그 기관에서 직접 찾아 원장 기록으로 들인다(발굴).
    정확히 같은 식별자만(NAID·로컬 식별자·참조코드·IA 식별자) — 비슷한 제목은 받지 않는다. 실패는 7일 뒤 재시도, 원래 기록에 sameas_tried."""
    for o in led.values():  # v2.87 v2.83 추적 기록에 보강 완료 표시가 미리 붙어 IIIF 보강을 건너뛰던 결함 — 표시만 걷어 다음 보강에 들게
        if "같은 기록 추적" in (o.get("found_via") or "") and not o.get("enrich_status") and o.get("enriched"): o.pop("enriched", None)
    ids = {}
    for o in led.values():
        for i in _loc_ids(o): ids.setdefault(i, set()).add(o["key"])
    found = lambda kind, v: any(k.startswith(TARGET_INST[kind]) for i in target_ids(kind, v) for k in ids.get(i, ()))
    used = added = 0; now = today.isoformat() + "T00:00:00Z"
    for o in sorted(led.values(), key=lambda x: x["key"]):
        if used >= budget: break
        if o.get("entry_type", "기록") != "기록": continue
        tried = o.get("sameas_tried") or {}
        for kind, v, basis in same_targets(o):
            if used >= budget: break
            if found(kind, v): continue
            tk = f"{kind}:{v}"
            if tried.get(tk, "") > (today - dt.timedelta(days=7)).isoformat(): continue
            used += 1; tried[tk] = today.isoformat(); rec = None
            try:
                if kind == "kw":
                    t = mcp_call("koreanwar_item", {"ref_code": v})
                    if f"[{v}]" in t.split("\n")[0]:
                        f_ = dict(re.findall(r"^· ([^:\n]+): (.+)$", t, re.M)); ti = (re.search(r"^제목: (.+)$", t, re.M) or [None, ""])[1]
                        d_ = (re.match(r"(\d{4}-\d{2}(?:-\d{2})?)", f_.get("생산시기", "")) or [None, ""])[1].replace("-00", "")
                        rec = {"key": f"koreanwar:{v}", "sources": ["koreanwar"], "title": ti, "date": d_, "id": v, "url": f"https://www.koreanwar.or.kr:8443/searchDetail.do?archRfcd={v}",
                               "partOf": "", "meta": [["제목", ti]] + [[k, x] for k, x in f_.items()], "summary": ""}
                        n_ = NARA_LINK.search(f_.get("입수처 링크", ""))
                        if n_: rec["sameAs"] = f"NAID {n_[1]}"
                elif kind in ("nara_local", "naid"):
                    t = mcp_call("nara_search", {"query": "", "naid": int(v), "radius": 0}) if kind == "naid" else mcp_call("nara_search", {"query": v, "max_results": 5})
                    for m in re.finditer(r"\[NAID (\d+)\] (.+?) \| ([^|·\n]*?) (?:·[^|\n]*)?\|(?: ([^|\n]+?) \|)? (https://catalog\.archives\.gov/id/\d+)(?:\n\s+계보: (.+))?", t):
                        if (kind == "naid" and m[1] == v) or (kind == "nara_local" and m[3].strip().lower() == v.lower()):
                            gp = (m[4] or m[6] or "").strip(); ti = m[2].strip(); dm = re.search(r" \((\d{4})(-\d{2}-\d{2})?\)$", ti)
                            if dm: ti = ti[:dm.start()]  # 도구가 제목 끝에 붙인 NARA 생산일 — 연초(01-01)는 연도만 표기된 값이라 연도로
                            nd = (dm[1] + (dm[2] if dm[2] and dm[2] != "-01-01" else "")) if dm else ""
                            rec = {"key": f"nara:NAID {m[1]}", "sources": ["nara"], "title": ti, "date": nd, "id": f"NAID {m[1]}", "url": m[5], "partOf": ("NARA › " + gp) if gp else "",
                                   "meta": [["NAID", m[1]]] + ([["로컬 식별자", m[3].strip()]] if m[3].strip() else []), "summary": ""}
                            if gp: rec["partOf_src"] = "nara_search 계보(기관 API)"
                            break
                elif kind == "ia":
                    j = json.loads(urllib.request.urlopen(urllib.request.Request(f"https://archive.org/metadata/{urllib.parse.quote(v)}", headers={"User-Agent": UA}), timeout=40).read())
                    md = j.get("metadata") or {}
                    if md.get("identifier") == v:
                        vv = lambda x: "; ".join(x) if isinstance(x, list) else str(x or "")
                        rec = {"key": f"ia:{v}", "sources": ["ia"], "title": vv(md.get("title"))[:300], "date": vv(md.get("date"))[:10] if re.match(r"^\d{4}(-\d{2}){0,2}$", vv(md.get("date"))[:10]) else "", "id": v, "url": f"https://archive.org/details/{v}",
                               "partOf": ("IA Collection › " + vv(md.get("collection")).split(";")[0]) if md.get("collection") else "", "summary": re.sub(r"<[^>]+>", " ", vv(md.get("description")))[:1500],
                               "meta": [[k, vv(md[k])[:300]] for k in ("identifier", "collection", "creator", "date", "mediatype", "subject", "title") if md.get(k)]}
            except Exception as ex:
                tried.pop(tk, None); print(f"같은 기록 추적 실패 {tk}: {str(ex)[:60]}"); time.sleep(0.6); continue  # 조회 실패는 다음 날 다시(7일 대기는 '응답은 왔으나 없음'만)
            time.sleep(0.6)
            if not rec or not rec["title"] or rec["key"] in led: continue
            rec.update({"media": "", "first_seen": now, "last_seen": now, "seen": 0, "tools": [{"kw": "koreanwar_item", "ia": "archive.org metadata API"}.get(kind, "nara_search")],
                        "days": {}, "formats": {}, "days_total": 0, "max_cross": 1, "drilled_from": o["key"], "found_via": f"같은 기록 추적(v2.83) — {basis}"})
            rec.setdefault("sameAs", ""); led[rec["key"]] = rec; added += 1
            for i in _loc_ids(rec): ids.setdefault(i, set()).add(rec["key"])
        if tried: o["sameas_tried"] = tried
        if used >= budget: break
    return used, added

def aks_drill(led, today, budget):
    """v2.35 고문서자료관 소장처(컬렉션) 항목 → 안의 실제 문서를 원장 기록으로 발굴. nedb_search(mode='aks')로 분류 → 문서까지 내려가
    문서마다 UCI 고정 링크(link.do?dataUCI=)·소장처 계층·제목 속 연도. 소장처 항목은 지우지 않고 '소장처(컬렉션)'으로 두고 하위 문서 목록을 단다."""
    used = added = 0
    for o in [x for x in led.values() if x["key"].startswith("aks:") and x.get("entry_type") != "결함 출력"]:
        if used >= budget: break
        has_cat = bool(o.get("children")) and all(c.get("cat") for c in o["children"])
        if has_cat or (o.get("drilled", "") >= today.isoformat() and not o.get("children")): continue  # v2.40 분류(cat) 없는 옛 발굴은 한 번 다시
        cid = str(o.get("id") or ""); queue = [cid] if re.match(r"^L\d{6}", cid) else []; docs = []
        while queue and used < budget and len(docs) < 40:
            q = queue.pop(0); used += 1
            try: t = mcp_call("nedb_search", {"mode": "aks", "query": q})
            except Exception: break
            queue += re.findall(r"\[분류 (L\d{6}F[0-9A-Z]*)\]", t)
            for m in re.finditer(r"- \[문서\] (.+)\n\s+원문 고정 링크\(UCI\): (https://archive\.aks\.ac\.kr/link\.do\?dataUCI=\S+)", t): docs.append((m[1].strip(), m[2].strip(), q))
            time.sleep(0.6)
        o["drilled"] = today.isoformat()
        if not docs: continue
        coll = re.sub(r"\s*\([^()]*\)$", "", re.sub(r"^\[고문서 소장처\]\s*", "", o["title"])); o["children"] = [{"title": d, "url": u, "cat": c} for d, u, c in docs]
        for d, u, c in docs:
            k = "aks:" + u.split("dataUCI=")[1]
            if k in led:
                led[k].setdefault("aks_cat", c); continue
            led[k] = {"key": k, "sources": ["aks"], "title": d, "date": "", "id": u.split("dataUCI=")[1], "url": u, "partOf": f"한국고문서자료관 › {o.get('partOf') or ''} › {coll}".replace(" ›  › ", " › "),
                      "media": "", "sameAs": "", "first_seen": today.isoformat() + "T00:00:00Z", "last_seen": today.isoformat() + "T00:00:00Z", "seen": 0, "tools": ["nedb_search"],
                      "days": {}, "formats": {}, "days_total": 0, "max_cross": 1, "drilled_from": o["key"], "found_via": "소장처 하위 문서 발굴(nedb_search mode=aks)", "aks_cat": c}
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

SRC_PARSER_V = "src1"  # v2.52 기관 공개 메타데이터 API 정규형 판 — 아래 SRC_FIX를 고치면 올린다
_nz = lambda v: v not in (None, "", [], {}, 0, False)

def _ia_core(j):
    """IA 메타데이터 API — 기술 메타(변동 관리 항목 제외) + 원본 파일 이름·md5(파생본·변동 시각 제외)."""
    md = {k: v for k, v in (j.get("metadata") or {}).items() if k not in ("backup_location", "updatedate", "updater", "curation", "next", "previous")}
    org = sorted([f.get("name", ""), f.get("md5", "")] for f in (j.get("files") or []) if f.get("source") == "original")
    return {"metadata": md, "originals": org} if md else None

def _tna_core(j):
    """TNA Discovery 상세 API — 빈 값 제외 전 항목(색인용 batchId 제외)."""
    return {k: v for k, v in j.items() if _nz(v) and k != "batchId"} if j.get("id") else None

def _ead_get(url):
    """v2.62 EAD XML(네덜란드 국립문서관 등) 받기 → 핵심 구조 dict. DTD는 받지 않는다(외부 요청 없음)."""
    import xml.etree.ElementTree as ET
    import http.client
    data = None
    for k in range(3):  # 큰 EAD(수 MB)는 응답이 중간에 끊기는 일이 있다(IncompleteRead 실측) — 3회까지 다시 받는다. 끊긴 본문은 쓰지 않는다
        try:
            rr = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"}), timeout=60)  # v2.62.1 압축 전송 — 수십 MB EAD가 비압축으로는 끊김(실측 19·25MB)
            data = rr.read()
            if rr.headers.get("Content-Encoding") == "gzip":
                import gzip as _gz; data = _gz.decompress(data)
            break
        except http.client.IncompleteRead:
            time.sleep(2 * (k + 1))
    if data is None: raise ValueError("EAD 응답 끊김(3회)")
    raw = re.sub(r"<!DOCTYPE[^>]*>", "", data.decode("utf-8", "replace"), count=1)
    root = ET.fromstring(raw); ad = root.find("archdesc")
    if ad is None: return {}
    T = lambda e: re.sub(r"\s+", " ", "".join(e.itertext())).strip() if e is not None else ""
    did = ad.find("did") if ad.find("did") is not None else ET.Element("did")
    out = {k: T(did.find(k)) for k in ("unittitle", "unitdate", "physdesc", "origination", "langmaterial", "unitid")}
    for k in ("bioghist", "custodhist", "accessrestrict", "userestrict", "prefercite", "arrangement"):
        e = ad.find(f".//{k}")
        out[k] = re.sub(r"^(Geschiedenis van de archiefvormer|Geschiedenis van het beheer|Openbaarheidsbeperkingen|Beperkingen aan het gebruik|Aanwijzing voor het citeren)\s*", "", T(e))[:1500] if e is not None else ""
    dsc = ad.find("dsc")
    out["series"] = [T(c.find("did/unittitle"))[:80] for c in (dsc if dsc is not None else []) if c.tag == "c" or re.match(r"c\d\d$", c.tag)][:12]
    out["units"] = len(dsc.findall(".//c")) if dsc is not None else 0
    return out

def _ead_core(j):
    return {k: j.get(k) for k in ("unittitle", "unitdate", "physdesc", "origination", "langmaterial", "unitid", "bioghist", "custodhist", "accessrestrict", "userestrict", "series", "units")} if j.get("unittitle") else None

# v2.52 원 기관 공개 메타데이터 API로 지문 — 매니페스트·심층 판독 경로가 없는 수집처. (URL 정규식, API 주소, 정규형)
SRC_FIX = {"ia": (r"archive\.org/details/([^/?#]+)", lambda m: f"https://archive.org/metadata/{m[1]}", _ia_core),
           "tna": (r"discovery\.nationalarchives\.gov\.uk/details/r/([0-9a-fA-F-]{36}|[A-Z]\d+)", lambda m: f"https://discovery.nationalarchives.gov.uk/API/records/v1/details/{m[1]}", _tna_core),
           "dnz": (r"^dnz:(\d+)$", lambda m: f"https://api.digitalnz.org/v3/records/{m[1]}.json", lambda j: _dnz_core(j)),  # v2.64 원장 key로(기록 URL은 원 기사)
           "nlna": (r"nationaalarchief\.nl/onderzoeken/archief/([0-9][0-9A-Za-z.]*[0-9A-Za-z])", lambda m: f"https://www.nationaalarchief.nl/onderzoeken/archief/{m[1]}/download/xml", _ead_core)}  # v2.62 EAD

def _tna_val(v):
    if isinstance(v, list): return " ; ".join(x for x in (_tna_val(e) for e in v) if x)
    if isinstance(v, dict): return v.get("xReferenceName") or v.get("description") or ""
    return strip(v) if isinstance(v, str) else (str(v) if v else "")

TNA_META = [("citableReference", "참조번호"), ("coveringDates", "생산 기간"), ("heldBy", "소장처"), ("creatorName", "생산자"), ("physicalDescriptionForm", "물리 형태"),
            ("legalStatus", "법적 지위"), ("accessConditions", "이용조건(원문)"), ("formerReferenceDep", "이전 참조번호"), ("language", "언어"), ("note", "주기(원문)")]

def src_enrich(o, j):
    """v2.54 지문용으로 받은 기관 메타데이터 API 응답에서 비어 있는 칸만 채운다(덮어쓰지 않음 · 원문 그대로 · 근거 표시)."""
    src = o["key"].split(":")[0]
    if src == "dnz":  # v2.64 DigitalNZ 기록 API — description→요약, 제공처·범주·날짜·저작권·이용·주제→메타
        r = j.get("record") or {}
        J = lambda v: "; ".join(str(x) for x in v if x) if isinstance(v, list) else str(v or "")
        if r.get("description") and not o.get("summary"): o["summary"] = strip(r["description"])[:600]; o["summary_basis"] = "기관 API(DigitalNZ records · description 원문)"
        if not o.get("meta"):
            md = [[lbl, J(r.get(k))[:200]] for k, lbl in (("display_content_partner", "콘텐츠 제공처"), ("category", "범주"), ("display_date", "날짜"), ("creator", "생산자"), ("publisher", "발행처"),
                                                         ("copyright", "저작권(원문)"), ("usage", "이용 조건(원문)"), ("subject", "주제")) if J(r.get(k))]
            if md: o["meta"] = md; o["meta_basis"] = "기관 API(DigitalNZ records)"
        return
    if src == "nlna":  # v2.62 네덜란드 국립문서관 EAD — 기록의 역사(bioghist)→요약, 기간·분량·생산자·언어·시리즈·이용 제한·인용→메타
        if j.get("bioghist") and not o.get("summary"): o["summary"] = j["bioghist"][:600]; o["summary_basis"] = "기관 EAD(Nationaal Archief · bioghist 원문, 네덜란드어)"
        if not o.get("meta"):
            md = [[lbl, str(j.get(k) or "")[:200]] for k, lbl in (("unitdate", "기간"), ("physdesc", "분량"), ("origination", "생산자"), ("langmaterial", "언어"), ("unitid", "기관 식별자"),
                                                             ("custodhist", "보존 이력"), ("accessrestrict", "이용 제한(원문)"), ("prefercite", "인용 방법(기관)")) if j.get(k)]
            if j.get("series"): md.append(["하위 시리즈(EAD)", "; ".join(j["series"][:8])[:300]])
            if j.get("units"): md.append(["기술 단위 수(EAD)", str(j["units"])])
            if md: o["meta"] = md; o["meta_basis"] = "기관 EAD(Nationaal Archief download/xml)"
        return
    if src == "ia":
        d = (j.get("metadata") or {}).get("description")
        d = strip(" ".join(d) if isinstance(d, list) else d or "")
        if re.fullmatch(r"(?i)no description\.?|n/?a|none", d or ""): d = ""  # 자리표시 문구는 요약 아님
        if d and not o.get("summary"): o["summary"] = d[:600]; o["summary_basis"] = "기관 메타데이터 API(archive.org/metadata · description 원문)"
        if not o.get("meta"):
            m0 = j.get("metadata") or {}; v = lambda k: strip(" ; ".join(m0[k]) if isinstance(m0.get(k), list) else m0.get(k) or "")
            md = [[lbl, v(k)[:160]] for k, lbl in (("creator", "생산자"), ("date", "생산일"), ("publisher", "발행처"), ("mediatype", "매체"), ("language", "언어"), ("imagecount", "면 수")) if v(k)]
            rt = " · ".join(f"{k} {v(k)}" for k in ("licenseurl", "rights", "possible-copyright-status", "access-restricted-item") if v(k))
            if rt: md.append(["이용 제한(원문)", (rt + (f" · collection {v('collection')}" if v("access-restricted-item") == "true" else ""))[:200]])
            if md: o["meta"] = md; o["meta_basis"] = "기관 메타데이터 API(archive.org/metadata)"
    elif src == "tna":
        sc = (j.get("scopeContent") or {}).get("description")
        if sc and not o.get("summary"): o["summary"] = strip(sc)[:600]; o["summary_basis"] = "기관 메타데이터 API(TNA Discovery · scopeContent 원문)"
        if not o.get("meta"):
            md = [[lbl, _tna_val(j.get(k))[:160]] for k, lbl in TNA_META if _tna_val(j.get(k))]
            if md: o["meta"] = md; o["meta_basis"] = "기관 메타데이터 API(TNA Discovery records/v1/details)"

def _dnz_core(j):
    r = j.get("record") or {}
    return {k: r.get(k) for k in ("title", "description", "display_date", "category", "copyright", "usage", "subject", "display_content_partner", "landing_url", "creator", "publisher")} if r.get("id") else None

def src_fix_url(o):
    sf = SRC_FIX.get(o["key"].split(":")[0])
    m = sf and re.search(sf[0], o["key"] if sf[0].startswith("^") else (o.get("url") or ""))  # '^'로 시작하는 규칙은 원장 key에 적용
    return (m and sf[1](m), sf[2]) if m else (None, None)

def fixity_text(o):
    """원 기관 응답(우리 판독기를 거친 정규형) — 심층 판독 도구 응답 또는 IIIF 매니페스트(변동 항목 제외)."""
    src = o["key"].split(":")[0]
    m = o.get("iiif") or ""
    su, core = src_fix_url(o)
    fx = o.get("fixity") or []
    if su and (not fx or fx[-1].get("pv") == SRC_PARSER_V):  # v2.52.1 기관 메타데이터 API 우선(IA IIIF는 빈 응답이 잦음) — 이미 매니페스트로 지문을 뜬 기록은 같은 근거를 유지(근거 전환이 '변경'으로 보이지 않게)
        jj = _ead_get(su) if su.endswith("/download/xml") else get(su); c = core(jj)
        if c: src_enrich(o, jj)
        return json.dumps(c, ensure_ascii=False, sort_keys=True) if c else None
    if m:
        j = get(m)
        if j.get("checkResult") == "NG":  # v2.52 NDL — 매니페스트 주소는 있으나 기관이 공개하지 않음(관내 열람 한정 등). iiif는 지우지 않고 상태만 표시
            o["iiif_status"] = {"state": "기관 응답 비공개(checkResult NG — 기관 내 열람 한정일 수 있음)", "at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")}
            return None
        o.pop("iiif_status", None)
        if not j.get("label") or not (j.get("metadata") or j.get("items") or j.get("sequences")): return None  # 빈·오류 응답은 지문 대상 아님(거짓 '원문 변경' 방지)
        md = [e for e in (j.get("metadata") or []) if not VOLATILE.search(json.dumps(e.get("label"), ensure_ascii=False))]
        core = {"label": j.get("label"), "summary": j.get("summary"), "metadata": md, "rights": j.get("rights"), "requiredStatement": j.get("requiredStatement"),
                "items": len(j.get("items") or (j.get("sequences") or [{}])[0].get("canvases") or [])}
        return json.dumps(core, ensure_ascii=False, sort_keys=True)
    if src == "archives" and "showDetailPopup.do" in (o.get("url") or ""):  # v2.51 국가기록원 — 원장 상세 판독기(archives_fields)의 정규형
        f, titles = archives_fields(o["url"])
        if not f: return None
        return json.dumps({"titles": titles, "fields": f}, ensure_ascii=False, sort_keys=True)
    if src in DEEP:
        tool, af = DEEP[src]; args = af(o)
        if args:
            t = mcp_call(tool, args)
            if src == "nlk":  # v2.72 이 기록 줄만 지문
                sm, md = nlk_own(t, o["id"])
                return json.dumps(md, ensure_ascii=False) if md else None
            if src == "kyudb":  # v2.55 이 책 행만 지문(검색 건수·다른 책 행 변화가 '원문 변경'으로 보이지 않게)
                sm, md = kyu_own(t, o["id"])
                return json.dumps(md, ensure_ascii=False) if md else None
            if re.search(r"파싱 실패|오류\(|조회 실패|시간 초과|브라우저로 열람", t[:300]): return None  # 판독 실패 응답은 지문 대상 아님
            return "\n".join(l for l in t.splitlines() if not VOLATILE.search(l))
    return None

def ndl_pass(led, today, budget=15):
    """v2.78 NDL 서지 보강 — NDL Search OpenSearch(공개 API)를 제목으로 불러 **같은 기록 주소(link) 또는 같은 PID**의 항목만 골라 빈 메타를 채운다.
    하루 상한·요청 간격·429(동시 접속 한도)면 그날 중단(우회 없음). 근거 meta_basis. 반환: (요청 수, 보강 수)."""
    import urllib.error
    used = got = 0
    for o in sorted((o for o in led.values() if o["key"].startswith("ndl:") and o.get("entry_type", "기록") == "기록" and not o.get("meta")),
                    key=lambda o: o.get("ndl_checked", "")):
        if used >= budget or o.get("ndl_checked", "") >= today.isoformat(): break
        t = re.sub(r"\s*\[[^\]]*\].*$|\s+—.*$", "", o.get("title") or "").replace("：", ":").strip()
        t = re.split(r"\s*[:;]\s*", t)[0][:40]
        if not t: continue
        u = "https://ndlsearch.ndl.go.jp/api/opensearch?cnt=20&title=" + urllib.parse.quote(t)
        try:
            xml = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=30).read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429: print("NDL 429(동시 접속 한도) — 오늘 NDL 보강 중단"); break
            used += 1; o["ndl_checked"] = today.isoformat(); continue
        except Exception:
            used += 1; o["ndl_checked"] = today.isoformat(); continue
        used += 1; o["ndl_checked"] = today.isoformat()
        if "<code>429</code>" in xml[:300]: print("NDL 429 — 오늘 NDL 보강 중단"); break
        pid = (re.search(r"/pid/(\d+)", o.get("url") or "") or [None, None])[1]
        for it in re.findall(r"<item>(.*?)</item>", xml, re.S):
            link = (re.search(r"<link>(.*?)</link>", it) or [None, ""])[1].strip()
            if not (link == (o.get("url") or "").strip() or (pid and re.search(rf"(?:/pid/|ndljp/pid/){pid}(?!\d)", it))): continue
            T = lambda tag: "; ".join(dict.fromkeys(html.unescape(re.sub(r"<[^>]+>", "", x)).strip() for x in re.findall(rf"<{tag}[^>]*>(.*?)</{tag}>", it, re.S) if x.strip()))
            md = [[lbl, T(tag)[:200]] for tag, lbl in (("dc:creator", "생산자"), ("dc:publisher", "발행처"), ("dc:date", "발행일"), ("dc:subject", "분류(NDC 등)"), ("category", "자료 형태"), ("dc:extent", "형태 사항")) if T(tag)]
            if md: o["meta"] = md; o["meta_basis"] = "기관 API(NDL Search OpenSearch — 같은 기록 주소/PID 항목)"; got += 1
            break
        time.sleep(1.5)
    return used, got

def fixity_pass(led, today, budget):
    """v2.35 원문 고정성(fixity) 감시 — 기록의 원 기관 응답 지문을 순환 재확인. 바뀌면 지우지 않고 이력에 추가:
    첫 지문 / 판독기 변경 동반(우리 route.js·lib가 바뀜 — 원문 변경 아닐 수 있음) / 원문 변경 의심(판독기 그대로인데 응답이 바뀜)."""
    import hashlib
    pv = parser_version(); used = changed = 0
    cand = [o for o in led.values() if o.get("entry_type", "기록") == "기록" and (o.get("iiif") or o["key"].split(":")[0] in DEEP or "showDetailPopup.do" in (o.get("url") or "") or src_fix_url(o)[0])]
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
        opv = AR_PARSER_V if (o["key"].startswith("archives:") and not o.get("iiif")) else SRC_PARSER_V if (src_fix_url(o)[0] and (not fx or fx[-1].get("pv") == SRC_PARSER_V)) else pv  # 판독기가 원장 스크립트 안에 있는 수집처는 그 판 번호로
        if fx and fx[-1]["h"] == h: continue
        kind = "첫 지문" if not fx else ("판독기 변경 동반" if fx[-1].get("pv") != opv else "원문 변경 의심")
        fx.append({"at": today.isoformat(), "h": h, "pv": opv, "kind": kind}); changed += kind != "첫 지문"
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

_POL = None
def rights_policies():
    """수집처별 권리 정책 원문 — route.js QUICK_PROFILES(4번째 항목)·lib/profile_*.js rights_access를 그대로 읽는다(사본 표 없음 — 프로파일이 원본)."""
    global _POL
    if _POL is not None: return _POL
    _POL = {}
    try:
        t = open(os.path.join(ROOT, "app", "api", "[transport]", "route.js"), encoding="utf-8").read()
        m = re.search(r"const QUICK_PROFILES = (\{.*?\});", t, re.S)
        for k, v in json.loads(m.group(1)).items():
            if isinstance(v, list) and len(v) > 3: _POL[k] = v[3]
    except Exception: pass
    import glob
    for f in glob.glob(os.path.join(ROOT, "lib", "profile_*.js")):
        k = os.path.basename(f)[8:-3]
        m = re.search(r'"rights_access":\s*"((?:[^"\\]|\\.)*)"', open(f, encoding="utf-8").read())
        if m and k not in _POL: _POL[k] = json.loads('"' + m.group(1) + '"')
    return _POL

RIGHTS_KEY = re.compile(r"권리|이용조건|이용 ?제한|이용유형|라이선스|license|저작권|공공누리|KOGL|rights|usage|copyright|열람조건", re.I)

SKIP_META = re.compile(r"URL|url|링크|뷰어|원문$|지문|계보|계층|주의|이미지 총수|archiveit|^collection$|식별자|NAID|ID|번호|권리|이용|접근|라이선스|license|rights|판독 시각|변환|디지털 객체|이미지 크기|Persistent", re.I)

def summary_composed(o):
    """v2.40 요약이 없는 기록 — 원 기관 메타 값만 이어 붙인 합성 요약(문장 생성·추정 없음, '[메타 합성]' 표시). 기관이 쓴 요약(summary)과 분리."""
    if o.get("summary"): return ""
    parts = [f"{k} {str(v).strip()}" for k, v in (o.get("meta") or []) if v and not SKIP_META.search(str(k)) and not str(v).startswith("http") and str(v).strip() not in (o.get("title") or "")]
    return ("[메타 합성] " + " · ".join(parts))[:300] if parts else ""

def rights_view(o):
    """v2.39 권리 표시(판정 아님 — 발굴 우선 원칙: 표시 대상). 근거 순서: 기관 IIIF 매니페스트 → 기록 메타 → 수집처 규칙(NARA RG) → 수집처 정책 원문."""
    und = re.search(r"vocab/UND|undetermined|미정|불명", o.get("rights") or "", re.I)
    if o.get("rights") and not (und and o["key"].startswith("nara:")): return o["rights"], "IIIF 매니페스트(기관 표기)"
    for k, v in (o.get("meta") or []):
        if RIGHTS_KEY.search(str(k)) and v and not str(v).startswith("http"): return f"{k}: {v}"[:220], "기록 메타(원 기관 판독)"
    src = o["key"].split(":")[0]
    if src == "nara":
        m = re.search(r"\bRG\s?(\d{1,3})\b", (o.get("partOf") or "") + " " + " ".join(str(v) for k, v in (o.get("meta") or [])))
        if m:
            if m.group(1) == "242": return "RG 242 노획 외국문서·필름 — 미 정부 직무물 아님(17 U.S.C. §105 비적용), 권리 지위 불명 — 열람·인용만", "규칙(NARA 프로파일 rights_rule · RG)"
            return f"RG {m.group(1)} 미 연방정부 생산 기록 — 17 U.S.C. §105 퍼블릭도메인 추정(초판정 B, judge_rights로 확인)", "규칙(NARA 프로파일 rights_rule · RG)"
    pol = rights_policies().get(src)
    if pol:
        pol = " · ".join(x for x in re.split(r"\s+·\s+|(?<=\.)\s+", pol) if not re.search(r"요청|429|robots|정직 UA|캐시|접근:|WAF|차단", x)) or pol  # 운영 메모(요청 예절·차단)는 권리가 아님
        return pol[:220], "수집처 정책(source_profile 원문)"
    return "", ""

def write_quality(recs):
    """v2.39 데이터 품질 시계열 — 기록 항목별 채움률을 날마다 쌓는다(지우지 않음, 같은 날은 갱신). 떨어지면 수집기·판독기 이상 신호."""
    R = [o for o in recs if o.get("entry_type", "기록") == "기록"]
    F = {"요약": lambda o: o.get("summary"), "요약(메타 합성 포함)": lambda o: o.get("summary") or o.get("summary_composed"), "연대": lambda o: decade(o), "기관 계층": lambda o: o.get("partOf"), "계층(파생 포함)": lambda o: o.get("partOf") or o.get("partOf_derived"),
         "기관 IIIF": lambda o: o.get("iiif") and not o.get("iiif_status"), "IIIF(원 기관 제공)": lambda o: iiif_kind(o).startswith("원 기관 제공"), "IIIF(원 기관 이미지로 구축)": lambda o: iiif_kind(o).startswith("원 기관 이미지"),
         "IIIF(실물 이미지 — 같은 기록 다른 소장처 포함)": lambda o: not iiif_kind(o).startswith("기록 봉투") or bool(o.get("iiif_same")), "IIIF(실물 이미지 — 제공+구축)": lambda o: not iiif_kind(o).startswith("기록 봉투"), "IIIF(브리지 포함)": lambda o: o.get("iiif") or o.get("iiif_built"), "썸네일": lambda o: o.get("thumb_ok"), "권리 표시": lambda o: o.get("rights_view"),
         "메타": lambda o: o.get("meta"), "원문 지문": lambda o: o.get("fixity"), "발견 경로": lambda o: o.get("found_by"), "발견 경로(파생 포함)": lambda o: o.get("found_by") or (o.get("found_by_derived") or {}).get("tools"),
         "관련 기록 연결": lambda o: REL.get(o["key"]), "같은 기록(다른 소장처) 연결": lambda o: any(t == "같은 기록(다른 소장처)" for t, _, _ in REL.get(o["key"], [])),
         "날짜 교차 확인(일치)": lambda o: (o.get("date_cross") or {}).get("verdict") == "일치",
         "기록 봉투 사유 확정": lambda o: (o.get("envelope_basis") or {}).get("type") not in (None, "미구축") if iiif_kind(o).startswith("기록 봉투") else True,  # v3.12 이미지 없는 이유까지 아는 기록(봉투가 아니면 해당 없음=충족)
         "날짜 정규 형식(정규화 포함)": lambda o: bool(re.match(r"^\d{4}(-\d{2}(-\d{2})?)?$|^\d{4}~\d{4}$", str(o.get("date") or ""))) or bool(o.get("date_norm")) if o.get("date") else True,  # v3.20 기관 날짜가 있는 기록 중 정규 형식(원래 또는 date_norm)
         "사건-날짜 대조(일치)": lambda o: (o.get("event_date_check") or {}).get("verdict") == "일치",  # v3.17
         "같은 날·같은 지명 연결": lambda o: any(t == "같은 날(다른 기관)" and "같은 지명" in bs for t, _, bs in REL.get(o["key"], [])),  # v3.13
         "원 소장처 계층(사본)": lambda o: o.get("origin_holder"), "원 기관 IIIF(브라우저 열람)": lambda o: o.get("iiif_origin")}
    day = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    snap = {"records": len(R), **{k: round(100 * sum(1 for o in R if f(o)) / max(1, len(R)), 1) for k, f in F.items()}}
    eb = {}
    for o in R:
        t_ = (o.get("envelope_basis") or {}).get("type")
        if t_: eb[t_] = eb.get(t_, 0) + 1
    snap["기록 봉투 사유(건)"] = dict(sorted(eb.items()))
    ev = {}
    for o in R:
        v_ = (o.get("event_date_check") or {}).get("verdict", "")
        if v_: ev[v_.split(" — ")[0]] = ev.get(v_.split(" — ")[0], 0) + 1
    snap["사건-날짜 대조(건)"] = dict(sorted(ev.items()))  # v3.17  # v3.12 사유 분류 축적(권리·기술·매체·원 기관 이미지 없음·미구축) — 기준 정보의 시계열
    p = os.path.join(D, "quality.json"); Qj = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"note": "기록 항목별 채움률(%) 일별 시계열 — 지우지 않는다", "daily": {}}
    Qj["definitions"] = {"기관 IIIF": "iiif 필드가 있는 기록 — 원 기관 제공과 우리 브리지(원 기관 이미지로 구축)를 함께 센다(v2.75 이전부터의 시계열이라 이름 유지)",
                         "IIIF(원 기관 제공)": "원 기관이 직접 공개한 IIIF 매니페스트", "IIIF(원 기관 이미지로 구축)": "KOREA ARCHIVE 브리지가 원 기관 이미지·메타로 만든 매니페스트",
                         "IIIF(실물 이미지 — 제공+구축)": "위 둘의 합 — 나머지는 이미지 없는 기록 봉투", "IIIF(브리지 포함)": "기록 봉투까지 포함 — 모든 기록이 IIIF로 열림",
                         "관련 기록 연결": "relations.json에서 다른 기록과 하나 이상 이어진 기록(같은 기록·같은 날·같은 계열, v2.82)", "같은 기록(다른 소장처) 연결": "기관 sameAs·식별자 일치로 다른 소장처의 같은 기록과 이어진 기록", "날짜 교차 확인(일치)": "같은 기록의 다른 소장처가 적은 날짜와 이 기록의 날짜가 일치(v2.84 date_cross — 두 기관 이상이 증언)", "기록 봉투 사유 확정": "이미지 없는 기록 봉투 중 사유(권리·기술·매체·원 기관 이미지 없음)가 실측 근거로 확정된 비율 — 봉투가 아닌 기록은 충족으로 센다(v3.12)", "기록 봉투 사유(건)": "envelope_basis 유형별 건수(v3.9.2~)", "날짜 정규 형식(정규화 포함)": "기관 날짜 칸 값이 정규 형식(YYYY·YYYY-MM·YYYY-MM-DD·YYYY~YYYY)이거나 date_norm으로 정규화된 비율 — 날짜 없는 기록은 충족(v3.20). 시대·세기 표기는 날짜가 아니라 연대로", "사건-날짜 대조(일치)": "표제에 알려진 사건(EVENTS)이 있는 기록 중 기록 날짜가 사건 시기 안 — 비율은 전체 기록 기준(v3.17). 사건 이전 날짜는 표기 확인 필요로 따로 센다", "같은 날·같은 지명 연결": "같은 날 다른 기관 기록 중 표제·기관 장소 칸의 지명(지명 사전 PLACES — 다국어 표기 한 표준명)까지 같은 기록이 있는 비율(v3.13) — 같은 사건의 더 강한 단서", "원 소장처 계층(사본)": "사본 기록의 원 소장처·Record Group·식별자(origin_holder, v3.11)", "원 기관 IIIF(브라우저 열람)": "서버 확인 불가 기관의 공식 IIIF 규칙 주소(iiif_origin, v3.9)"}  # v2.75
    Qj["daily"][day] = snap; Qj["daily"] = dict(sorted(Qj["daily"].items())); Qj["latest"] = {"day": day, **snap}
    runs = Qj.setdefault("runs", [])  # v3.8.4 실행마다 측정 축적 — daily[날짜]는 그날 마지막 값이라 같은 날 여러 실행의 중간 측정이 덮어써지던 결함. 바로 앞과 같으면 중복이라 쌓지 않는다
    if not runs or {k: v for k, v in runs[-1].items() if k != "at"} != snap: runs.append({"at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **snap})
    json.dump(Qj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return snap

FACETS = [("주제", re.compile(r"^(주제|주제어|색인어.*|subject|키워드|표제어)$", re.I)), ("장소", re.compile(r"^(연관정보|장소|장소\(기관 전거\)|취급지명|place|지명\(장서각 태깅\))$", re.I)),
          ("인물", re.compile(r"^(인명\(장서각 태깅\)|인물\(기관 전거\))$")), ("기관", re.compile(r"^(관청명\(장서각 태깅\)|단체\(기관 전거\))$")),  # v2.56 기관 개체 태깅
          ("형태", re.compile(r"^(문서유형|기록물형태|매체유형|사료구분|사료유형|기록유형|자료유형|자료 유형|자료 구분|매체 형태|자료 형태|format)$", re.I)), ("재질", re.compile(r"^재질$")),
          ("기술 수준", re.compile(r"^기술 수준$")),  # v2.59 기관의 자료 형태·재질·기술 단계(item·fileUnit·Piece) 분류
          ("죄명", re.compile(r"^죄명$")), ("훈격", re.compile(r"^포상$")), ("신문", re.compile(r"^신문명$")),
          ("생산자", re.compile(r"^(생산처/생산자|생산기관|생산자|제작자|creator|작가)$", re.I)), ("소장처", re.compile(r"^(소장단위\(열람·복제 청구\)|소장처|소장국가|서고정보)$")),
          ("분쟁", re.compile(r"^분쟁$")), ("공개 상태", re.compile(r"^(공개 상태|공개구분|접근 제한\(원문\)|법적 지위|보존기간|열람 및 이용조건)$")),  # v2.99.8 출처(생산자)·소장·분쟁·공개 상태 — 기관 표기 그대로  # v2.99.7 기관의 법적 분류(독립운동 판결문 죄명)·포상 훈격(공훈록)·수록 신문명
          ("분류", re.compile(r"^(분류|사부분류|자료분류|보고서유형분류|주제분류|범주\(Commons\)|분류\(NDC 등\))$")), ("시대", re.compile(r"^(시대|시대분류|국적/시대)$")), ("매체", re.compile(r"^mediatype$", re.I))]

def facet_terms(k, v, fac):
    """(패싯, 용어) 목록. 서울기록원 연관정보는 코드 종류로 패싯을 가른다 — GEOL=장소 · TOPIC=주제 · FUNC=분류(기능)."""
    v = str(v)
    if k == "연관정보":
        cm = {"GEOL": "장소", "TOPIC": "주제", "FUNC": "분류"}
        return [(cm[m[1]], re.sub(r"\s*,\s*[\d~\s]*$", "", m[2]).strip()) for m in re.finditer(r"\[(GEOL|TOPIC|FUNC)-\d+\]\s*(?:\([^)]*\)\s*)?([^\[]+)", v)]
    if v.startswith("http"): return []
    if k.endswith("(기관 전거)"):  # v3.22 국립중앙도서관 전거 줄 '이름=KSH…' — 가운뎃점으로만 가르고(인명 쉼표 보존) 용어는 이름만, 전거 번호는 authority로
        return [(fac, t.split("=")[0].strip()) for t in re.split(r"\s·\s", v) if 1 < len(t.split("=")[0].strip()) <= 120]
    if fac in ("생산자", "소장처", "분쟁"):  # v2.99.8 인명·기관명엔 쉼표가 들어간다('Holzheimer, Claude Rudolph') — 세미콜론으로만 가르고, 끝의 존속기간·(Most Recent) 괄호를 뗀다
        out = []
        for t in re.split(r"[;；]", v):
            t = re.sub(r"\s*\((?:Most Recent|[^()]*\d{4}[^()]*)\)\s*$", "", t.strip()).strip(" .")
            t = re.sub(r"\s*\((?:Most Recent|[^()]*\d{4}[^()]*)\)\s*$", "", t).strip(" .")
            if 1 < len(t) <= 120: out.append((fac, t))
        return out
    if fac == "공개 상태":  # v3.6.3 접근 조건 원문은 쉼표가 든 산문('Many documents have been declassified, but others, …') — 세미콜론·가운뎃점(기관 값 구분)으로만, 60자 넘는 산문 조각은 개념으로 쓰지 않는다
        return [(fac, t.strip()) for t in re.split(r"[;；·]", v) if 1 < len(t.strip()) <= 60]
    if fac == "훈격":  # v2.99.7 '1962 대한민국장' → '대한민국장'(포상 연도는 기록 날짜이지 분류가 아니다)
        t = re.sub(r"^\s*(1[89]|20)\d\d\s*", "", v).strip()
        return [(fac, t)] if 1 < len(t) <= 40 else []
    if fac == "재질" or k == "주제분류":  # v2.59 · v2.61.1 한국사DB 주제분류('정치＞왕실＞국왕＞즉위·책봉')도 계층 그대로 '나무 > 기타' 같은 기관 재질 분류는 계층 그대로 한 용어로(쉼표로만 가른다)
        return [(fac, t.strip()) for t in re.split(r"[,，;]", v) if 1 < len(t.strip()) <= 40]
    return [(fac, t.strip()) for t in re.split(r"[;；,，·]|\s>\s|\s›\s", v) if 1 < len(t.strip()) <= 40]

FACET_SLUG = {"주제": "subject", "장소": "place", "분류": "class", "시대": "period", "매체": "medium", "인물": "person", "기관": "agency", "형태": "form", "재질": "material", "기술 수준": "level", "죄명": "charge", "훈격": "honor", "신문": "newspaper", "생산자": "creator", "소장처": "holder", "분쟁": "conflict", "공개 상태": "access"}

def concept_id(fac, term):
    return f"{PAGES}subjects.jsonld#{FACET_SLUG.get(fac, 'x')}/" + urllib.parse.quote(term, safe="")

def subj_anchor(fac, term):
    """v2.80 주제 색인 항목 앵커 — 기록 페이지에서 subjects.html#<앵커>로 바로 간다(패싯 slug + 용어 지문)."""
    import hashlib
    return f"{FACET_SLUG.get(fac, 'x')}-{hashlib.sha1(term.encode('utf-8')).hexdigest()[:10]}"

NOT_SUBJECT = {"장소": "rico:isAssociatedWithPlace", "생산자": "rico:hasCreator", "소장처": "rico:hasOrHadHolder"}  # v2.99.9 패싯 → RiC-O 속성(주제가 아닌 것)

def rico_concepts(o):
    """v2.99.9 기록의 기관 분류 개념을 RiC-O 속성으로 — 주제·분류는 hasOrHadSubject, 장소·생산자·소장처는 제 속성, 공개 상태는 conditionsOfAccess(문자열).
    v2.99.8까지 소장처·공개 상태가 hasOrHadSubject로 나가 'NARA College Park 영상실이 이 기록의 주제'가 되던 의미 오류(546건)."""
    out = {}
    for f, t in record_concepts(o):
        if f == "공개 상태": out.setdefault("rico:conditionsOfAccess", []).append(t); continue
        out.setdefault(NOT_SUBJECT.get(f, "rico:hasOrHadSubject"), []).append({"@id": concept_id(f, t)})
    for t, i in ((o.get("authority_ids") or {}).get("terms") or {}).items():  # v3.23 기관 전거 → 국립중앙도서관 LOD 리소스(장소는 isAssociatedWithPlace, 그 밖은 hasOrHadSubject)
        pk = "rico:isAssociatedWithPlace" if any(t in str(m[1]) for m in (o.get("meta") or []) if m and len(m) > 1 and m[0] == "장소(기관 전거)") else "rico:hasOrHadSubject"
        out.setdefault(pk, []).append({"@id": LOD_NLK + i})
    for n in o.get("places_std") or []:  # v3.14 표준 지명 개념(places.jsonld) — 기관 표기 장소 개념(subjects.jsonld)과 별개, 둘 다 둔다
        out.setdefault("rico:isAssociatedWithPlace", []).append({"@id": place_id(n)})
    return out

def record_concepts(o):
    """기록 → (패싯, 용어) 목록 — merge_subjects와 같은 규칙(기관 표기 그대로)."""
    out = []
    for k, v in o.get("meta") or []:
        fac = next((f for f, rx in FACETS if rx.search(str(k))), None)
        if fac: out += [x for x in facet_terms(str(k), v, fac) if x not in out]
    return out

def merge_subjects(recs):
    """v2.42 주제 색인 — 기관이 붙인 주제어·색인어·지명·분류·시대·매체를 패싯별 용어 사전으로 축적. 지우지 않음(기록 수는 줄지 않음)."""
    p = os.path.join(D, "subjects.json")
    S = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"facets": {}}
    for o in recs:
        if o.get("entry_type", "기록") != "기록": continue
        for k, v in o.get("meta") or []:
            fac = next((f for f, rx in FACETS if rx.search(str(k))), None)
            if not fac: continue
            for fac2, t in facet_terms(str(k), v, fac):
                e = S["facets"].setdefault(fac2, {}).setdefault(t, {"records": [], "sources": [], "first": o["first_seen"], "last": o["last_seen"], "keys": []})
                if o["key"] not in e["records"]: e["records"].append(o["key"])
                src = o["key"].split(":")[0]
                if src not in e["sources"]: e["sources"].append(src)
                if str(k) not in e["keys"]: e["keys"].append(str(k))
                uci = ((o.get("authority") or {}).get("persons") or {}).get(t) if fac2 == "인물" else None
                if uci: e["uci"] = uci  # v2.56 인물 전거
                e["first"] = min(e["first"], o["first_seen"]); e["last"] = max(e["last"], o["last_seen"])
    live = {}  # v3.6.3 현재 판독 규칙으로 기관 값에서 나오는 (패싯, 용어) — 공개 상태의 옛 쉼표 분할 조각은 지우지 않고 superseded 표시(SKOS·HTML에서만 제외)
    for o in recs:
        if o.get("entry_type", "기록") != "기록": continue
        for k, v in o.get("meta") or []:
            fac = next((f for f, rx in FACETS if rx.search(str(k))), None)
            if fac == "공개 상태": live.update({x: 1 for x in facet_terms(str(k), v, fac)})
    for t, e in (S["facets"].get("공개 상태") or {}).items():
        if ("공개 상태", t) not in live and not e.get("superseded"): e["superseded"] = {"on": dt.date.today().isoformat(), "why": "판독 규칙 교정으로 기관 값에서 더 이상 나오지 않는 조각(접근 조건 산문의 쉼표 분할 결함, v3.6.3) — 기록·출처는 보존"}
        elif ("공개 상태", t) in live and e.get("superseded"): e.pop("superseded")
    S["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    S["totals"] = {f: len(v) for f, v in S["facets"].items()}
    S["note"] = "원 기관 메타의 주제·지명·분류·시대·매체·인물·기관(장서각 태깅)·형태·재질·기술 수준 표기 그대로(번역·정규화 없음). records = 그 용어가 붙은 원장 기록 key. 지우지 않는다"
    json.dump(S, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    # v2.43 SKOS 개념 체계 — 패싯마다 ConceptScheme, 용어마다 Concept(prefLabel 기관 표기·출처 기관·기록 수). RiC-O 기록이 이 개념을 가리킨다
    graph = []
    # v2.57 같은 전거(UCI)를 가진 표기 변이(한글·한자·'조선 영조' 등)는 지우지 않고 서로 잇는다(skos:exactMatch) — 중복 제거가 아니라 연결
    by_uci = {}
    for t, e in (S["facets"].get("인물") or {}).items():
        if e.get("uci"): by_uci.setdefault(e["uci"], []).append(t)
    S["authority_groups"] = {u: ts for u, ts in by_uci.items() if len(ts) > 1}
    json.dump(S, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    for f, terms in S["facets"].items():
        sch = f"{PAGES}subjects.jsonld#{FACET_SLUG.get(f, 'x')}"
        graph.append({"@id": sch, "@type": "skos:ConceptScheme", "skos:prefLabel": {"@value": f"KOREA ARCHIVE 주제 색인 — {f}", "@language": "ko"},
                      "dct:description": "원 기관 메타의 표기를 그대로 모은 개념 체계(번역·정규화 없음)"})
        for t, e in terms.items():
            if e.get("superseded"): continue  # v3.6.3
            graph.append({"@id": concept_id(f, t), "@type": "skos:Concept", "skos:prefLabel": t, "skos:inScheme": {"@id": sch},
                          "dct:source": e["sources"], "skos:note": f"원장 기록 {len(e['records'])}건 · 메타 키 {', '.join(e['keys'])} · 처음 {e['first'][:10]}",
                          **({"skos:notation": e["uci"], "dct:identifier": f"UCI {e['uci']}"} if e.get("uci") else {}),
                          **({"skos:exactMatch": [{"@id": concept_id(f, x)} for x in by_uci.get(e.get("uci"), []) if x != t]} if f == "인물" and len(by_uci.get(e.get("uci"), [])) > 1 else {})})
    json.dump({"@context": {"skos": "http://www.w3.org/2004/02/skos/core#", "dct": "http://purl.org/dc/terms/"}, "@graph": graph},
              open(os.path.join(D, "subjects.jsonld"), "w", encoding="utf-8"), ensure_ascii=False)
    E_ = html.escape; by = {o["key"]: o for o in recs}
    sec = []
    for f, terms in S["facets"].items():
        items = sorted(((t, e) for t, e in terms.items() if not e.get("superseded")), key=lambda kv: (-len(kv[1]["records"]), kv[0]))  # v3.6.3 옛 분할 조각 제외(subjects.json에는 보존)
        li = "".join(f"<details id='{E_(subj_anchor(f, t))}'><summary>{E_(t)} <small>{len(e['records'])}건 · {E_(', '.join(e['sources']))}</small></summary><ul>"
                     + "".join(f"<li><a href='{E_((by.get(k) or {}).get('url') or '#')}'>{E_(((by.get(k) or {}).get('title') or k)[:100])}</a> <a href='r/{rec_slug(k)}.html'>기록</a></li>" for k in e["records"][:30]) + "</ul></details>"
                     for t, e in items)
        sec.append(f"<h2>{E_(f)} <small>{len(terms)}개 용어</small></h2>{li}")
    open(os.path.join(D, "subjects.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>주제 색인 — KOREA ARCHIVE 발견 원장</title><style>body{{font-family:system-ui,'Noto Sans KR',sans-serif;margin:0;background:#14161b;color:#e6e4dc}}main{{max-width:960px;margin:auto;padding:16px}}a{{color:#e0b04a}}details{{margin:3px 0}}small{{color:#9b9a93}}li{{font-size:14px}}</style>
<main><h1>주제 색인</h1><p>원 기관이 기록에 붙인 주제어·색인어·지명·분류·시대·매체를 패싯별로 모았습니다(기관 표기 그대로). 지우지 않고 쌓습니다. <a href="subjects.json">subjects.json</a> · <a href="index.html">원장</a></p>{''.join(sec)}</main></html>""")
    return S["totals"]

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
    prev_snapshot = json.loads(json.dumps(led, ensure_ascii=False))  # v2.70 불삭제 검사 기준(이번 실행 전 원장)
    nkt = rekey_ktv(led)
    if nkt: print(f"KTV key 통일(v2.69) {nkt}건 — 중복은 합산해 하나로, 옛 key는 key_aliases")
    nrk = rekey_collisions(led)
    if nrk: print(f"분류어 key 이동(v2.67) {nrk}건 — 지우지 않고 key_aliases에 옛 key 보존")
    nrc = recover_from_replies(led)
    if nrc: print(f"회신 원문에서 복원(v2.67) {nrc}건")
    nhv = harvest_deep_replies(led)
    if nhv: print(f"심층 검색 회신에서 거둠(v2.68) {nhv}건")
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
    try: npq = merge_queries(state, today, "qp")  # v2.58 자동 점검 질의·회신(별도 축적)
    except Exception as e: npq = {"total": 0, "added": 0}; print(f"점검 질의 축적 실패 {e}")
    for o in led.values(): o["entry_type"] = entry_type(o)
    rl_used, rl_fixed = resolve_links(led, today, int(os.environ.get("RESOLVE_MAX", "20")))
    ad_used, ad_added = aks_drill(led, today, int(os.environ.get("AKS_DRILL_MAX", "30")))
    sa_used, sa_added = sameas_pass(led, today, int(os.environ.get("SAMEAS_MAX", "12")))  # v2.83 같은 기록 추적 발굴
    print(f"같은 기록 추적 {sa_added}건 발굴(요청 {sa_used})")
    kh_used, kh_got = kw_hier_pass(led, today, int(os.environ.get("KW_HIER_MAX", "10")))  # v2.87
    th_used, th_got = tna_hier_pass(led, today, int(os.environ.get("TNA_HIER_MAX", "10")))  # v3.4
    if th_used: print(f"TNA 계층 보강: 조회 {th_used} · 세움 {th_got}")
    nh_used, nh_got = nlk_hier_pass(led, today, int(os.environ.get("NLK_HIER_MAX", "10")))  # v3.4.1
    if nh_used: print(f"국립중앙도서관 계층 보강: 조회 {nh_used} · 세움 {nh_got}")
    print(f"6·25전쟁 아카이브센터 기관 계층 {kh_got}건(요청 {kh_used})")
    print(f"첫 화면 링크 해소 {rl_fixed}/{rl_used} · 고문서 소장처 하위 문서 발굴 {ad_added}건({ad_used}회 호출)")
    budget = int(os.environ.get("ENRICH_MAX", "80"))  # 하루 매니페스트 판독 상한(기관 서버 예의 — 순차·간격)
    for o in sorted(led.values(), key=lambda o: o.get("last_seen", ""), reverse=True):
        n_ = enrich(o, budget); budget -= n_
        if n_: time.sleep(0.6)
    for o in led.values(): o["entry_type"] = entry_type(o)
    for o in led.values(): o["entry_type"] = entry_type(o)
    nbf = backfill_found_by(led); print(f"발견 경로 소급(회신 본문 대조) {nbf}건")
    try: nd_used, nd_got = ndl_pass(led, today, int(os.environ.get("NDL_MAX", "15"))); print(f"NDL 서지 보강 {nd_got}건(요청 {nd_used})")
    except Exception as e: print(f"NDL 서지 보강 실패 {e}")
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
    ngu = loss_guard(led, prev_snapshot, today)
    if ngu: print(f"불삭제 검사(v2.70): 사라질 뻔한 값 {ngu}건 되살림 — docs/data/loss_guard.json")
    nmv = 0  # v3.0.1 제자리로 — AWM 검색 파서가 'Conflict'(분쟁명 Korea, 1950-1953)를 날짜 칸에 넣던 결함. 지우지 않고 메타 '분쟁'으로 옮기고 원값은 date_moved에 남긴다
    for o in led.values():
        dv = o.get("date") or ""
        if o["key"].startswith("awm:") and dv and not re.match(r"^\s*(?:c\.?\s*)?\d", dv):
            if not any(m and m[0] == "분쟁" for m in o.get("meta") or []): o["meta"] = (o.get("meta") or []) + [["분쟁", dv]]
            o.setdefault("date_moved", []).append({"value": dv, "to": "meta:분쟁", "on": today.isoformat(), "why": "검색 파서가 분쟁명(Conflict)을 날짜로 읽던 결함(v3.0.1) — 날짜는 Date made"})
            o["date"] = ""; nmv += 1
    if nmv: print(f"날짜 칸 교정(v3.0.1): AWM 분쟁명 {nmv}건 → 메타 '분쟁'(원값 date_moved 보존)")
    ntn = 0  # v3.5.3 제자리로 — 도구 안내 문구('➤ 다음 단계(안내)'·'공식 검색')가 기관 메타로 쌓인 것: 지우지 않고 tool_notes로 옮긴다(기관 데이터와 구분)
    for o in led.values():
        mv = [m for m in (o.get("meta") or []) if m and (str(m[0]).startswith("➤") or m[0] == "공식 검색")]
        if mv:
            o["meta"] = [m for m in o["meta"] if m not in mv]; o.setdefault("tool_notes", []).extend({"label": m[0], "value": m[1], "moved": today.isoformat(), "why": "도구 안내 응답이 메타로 판독되던 결함(v3.5.3)"} for m in mv); ntn += 1
            if o.get("enrich_status") == "ok" and not o["meta"]: o["enrich_status"] = ""  # 기관 메타 없이 '완료'로 남지 않게 — 다음 보강에 다시 든다
    if ntn: print(f"메타 교정(v3.5.3): 도구 안내 문구 {ntn}건 → tool_notes(원값 보존)")
    recs = sorted(led.values(), key=lambda o: (o["first_seen"], o["key"]))
    # v2.27 계층·IIIF가 없는 기록은 만들어 구축 — 원 기관 정보와 구분되는 필드에(partOf_derived · iiif_built)
    for o in recs:
        o["entry_type"] = entry_type(o)
        sc_ = summary_composed(o)
        if sc_: o["summary_composed"] = sc_
        else: o.pop("summary_composed", None)
        rv_, rb_ = rights_view(o)
        if rv_: o["rights_view"], o["rights_basis"] = rv_, rb_
        if o["entry_type"] == "결함 출력": o["defect_note"] = "옛 파서 오류 출력(한국사DB 메뉴 오인 v2.23 수정 · IA 웹 크롤링 묶음 v2.24 수정) — 기록 아님, 증거로 보존"
        else: o.pop("defect_note", None)
        lq_ = link_quality(o)
        if lq_: o["link_note"] = lq_
        else: o.pop("link_note", None)
        dd_, db_ = date_derived(o)
        if dd_: o["date_derived"], o["date_basis"] = dd_, db_
        else: o.pop("date_derived", None); o.pop("date_basis", None)
        if o["key"].startswith("un:") and not o.get("partOf"):  # v2.66 UN — 기관 MARC의 유형·의제로 계층
            mu = {k: str(v) for k, v in (o.get("meta") or [])}
            if mu.get("유형") or mu.get("의제"):
                o["partOf"] = " › ".join(x for x in ["UN 디지털도서관", mu.get("유형", ""), ("의제 " + mu["의제"].split(" ")[0]) if mu.get("의제") else ""] if x); o["partOf_src"] = "기관 MARC XML(930 유형·991 의제)"
        cm_ = next((str(v) for k, v in (o.get("meta") or []) if k == "범주(Commons)"), "") if o["key"].startswith("commons:") else ""
        if cm_ and not o.get("partOf"): o["partOf"] = "Commons › " + cm_.split("; ")[0][:120]; o["partOf_src"] = "Commons 범주(기관 분류 체계 — 숨김 범주 제외, 첫 범주)"  # v2.65
        if not o.get("partOf"): o["partOf_derived"] = derive_path(o)
        else: o.pop("partOf_derived", None)
        # v2.49 발견 경로 파생 — 질의 지문 축적(v2.28) 이전 기록은 원장이 가진 근거(발견 도구·수집처·최초/최근 발견 시각·발견 일수)로 경로를 세운다.
        #   질의 지문(found_by)과 구분되는 필드. 질의 원문을 지어내지 않는다 — 질의 지문이 생기면 파생은 걷는다(원장 자체는 그대로).
        if not o.get("found_by"):
            o["found_by_derived"] = {"basis": "원장 적재 기록(질의 지문 축적 이전 — 질의 원문은 없음)", "tools": o.get("tools") or [], "sources": o.get("sources") or [],
                                     "first_seen": o.get("first_seen", ""), "last_seen": o.get("last_seen", ""), "days_total": o.get("days_total", 0), "seen": o.get("seen", 0)}
        else: o.pop("found_by_derived", None)
        o["iiif_kind"] = iiif_kind(o)  # v2.75 원 기관 제공 · 원 기관 이미지로 구축 · 기록 봉투 — 우리 브리지를 '기관'으로 부르던 표기 교정
        dn_ = date_norm(o)  # v3.20 비ISO 기관 날짜 정규화(원 표기 보존)
        if dn_: o["date_norm"] = dn_
        else: o.pop("date_norm", None)
        ec_ = event_date_check(o)  # v3.17 사건-날짜 정합(기관 값은 그대로)
        if ec_: o["event_date_check"] = ec_
        else: o.pop("event_date_check", None)
        au_ = {t.split("=")[0].strip(): t.split("=")[1].strip() for k, v in ((m[0], m[1]) for m in (o.get("meta") or []) if m and len(m) > 1 and str(m[0]).endswith("(기관 전거)"))
               for t in re.split(r"\s·\s", str(v)) if "=" in t}  # v3.22 기관 전거(KSH·KAC) — 이름=전거번호
        if au_: o["authority_ids"] = {"scheme": "국립중앙도서관 전거(KSH 주제명표목·KAC 인명/단체)", "terms": au_}
        else: o.pop("authority_ids", None)
        ps_ = sorted(places(o))  # v3.14 표준 지명(지명 사전 — 표제·기관 장소 칸)
        if ps_: o["places_std"] = ps_
        else: o.pop("places_std", None)
        oh_ = origin_holder(o)  # v3.11 사본의 원 소장처 계층
        if oh_: o["origin_holder"] = oh_
        else: o.pop("origin_holder", None)
        og_ = iiif_origin(o)  # v3.9 원 기관 IIIF 규칙 주소(서버 확인 불가 기관) — 수집 경로(iiif)는 바꾸지 않고 따로 기록
        if og_: o["iiif_origin"] = og_
        else: o.pop("iiif_origin", None)
        o["iiif_built"] = "" if (o.get("iiif") and not o.get("iiif_status")) else leaf_manifest(o)  # v2.52 기관 매니페스트가 비공개 응답이면 브리지로 대체(기관 주소는 보존)
    nrel = build_relations(recs)  # v2.82 기록↔기록 맥락 연결(RiC-O·기록 페이지·품질이 함께 씀)
    for o in recs:  # v2.92 같은 기록(다른 소장처) key — 원장 본체에도(도구 응답·외부 소비자가 relations.json 없이 읽게). 매 실행 재계산
        sk_ = [b for t, b, _ in REL.get(o["key"], []) if t == "같은 기록(다른 소장처)"]
        if sk_: o["same_keys"] = sk_
        else: o.pop("same_keys", None)
    by_ = {o["key"]: o for o in recs}; nis = 0
    for o in recs:  # v3.1 실물 이미지가 없는 기록 봉투 ← 같은 기록(다른 소장처)의 실물 이미지 매니페스트(근거·소장처 명시 — 이 기록의 IIIF를 바꾸지 않고 따로)
        sib = [by_[b] for b in o.get("same_keys") or [] if b in by_ and not (by_[b].get("iiif_kind") or "").startswith("기록 봉투")] if (o.get("iiif_kind") or "").startswith("기록 봉투") else []
        mf_ = next((((x.get("iiif") if not x.get("iiif_status") else "") or x.get("iiif_built"), x) for x in sib if (x.get("iiif") if not x.get("iiif_status") else "") or x.get("iiif_built")), None)
        if mf_:
            o["iiif_same"] = {"manifest": mf_[0], "key": mf_[1]["key"], "kind": mf_[1].get("iiif_kind", ""), "basis": f"같은 기록(다른 소장처) — {SRC_NAME.get(mf_[1]['key'].split(':')[0], mf_[1]['key'].split(':')[0])} {mf_[1]['key']}의 실물 이미지(이 기록 소장처의 이미지 아님)"}; nis += 1
        else: o.pop("iiif_same", None)
    if nis: print(f"기록 봉투 {nis}건 ← 같은 기록 다른 소장처의 실물 이미지 연결(iiif_same)")
    fg_ = {}  # v3.18 같은 철(국가기록원 rc_rfile_no = key 'archives:<철번호>-<건>') 연도 동일성 — 철 단위 연도 표기 단서(기관 값은 그대로)
    for o in recs:
        m_ = re.match(r"^archives:(\d{6,})-\d+$", o["key"])
        if m_: fg_.setdefault(m_[1], []).append(o)
    for fno, L_ in fg_.items():
        ys = {str(o.get("date") or "")[:4] for o in L_}
        y0 = next(iter(ys)) if len(ys) == 1 else ""
        sig = [o["key"] for o in L_ if (o.get("event_date_check") or {}).get("verdict", "").startswith(("사건 이전 연도", "사건 이후"))
               or any(y != y0 for y in re.findall(r"(?<!\d)(1[89]\d\d|20[0-2]\d)(?!\d)", str(o.get("title") or "")))]  # 독립된 어긋남 신호가 있을 때만(같은 해 기록을 모은 정상 철에 소음 금지)
        for o in L_:
            if len(L_) >= 3 and y0 and sig:
                o["date_note"] = {"note": f"원장의 같은 철({fno}) {len(L_)}건이 모두 생산연도 {y0} — 건별 생산일이 아니라 철 단위 연도 표기일 수 있음(어긋남 신호: {', '.join(sig[:3])})", "file": fno, "records": len(L_), "year": y0, "signals": sig}
                ec = o.get("event_date_check")
                if ec and ec["verdict"].startswith("사건 이전 연도"): ec["basis"] += f" · 같은 철 {len(L_)}건 모두 {y0}년(철 단위 연도 표기 단서)"
            else: o.pop("date_note", None)
    eb_ = __import__("collections").Counter()
    for o in recs:  # v3.9.2 봉투 사유(iiif_same·iiif_origin 판정 뒤에)
        e_ = envelope_basis(o)
        if e_: o["envelope_basis"] = e_; eb_[e_["type"]] += 1
        else: o.pop("envelope_basis", None)
    print(f"기록 봉투 사유 {dict(eb_)}")
    ndp = date_from_same(recs)  # v2.84 날짜 없는 기록 ← 같은 기록의 다른 소장처 날짜([파생]·근거)
    if ndp: print(f"같은 기록의 다른 소장처 날짜로 연대 파생 {ndp}건")
    relations_page([o for o in recs if o.get("entry_type", "기록") == "기록"])  # v2.86 날짜 파생·교차 확인 뒤에
    with open(lp, "w", encoding="utf-8") as f:
        for o in recs: f.write(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n")
    cols = ["key", "entry_type", "found_by_basis", "summary_composed", "rights_view", "rights_basis", "fixity", "defect_note", "link_note", "sources", "title", "date", "date_derived", "date_basis", "id", "url", "partOf", "partOf_derived", "media", "sameAs", "iiif", "iiif_status", "iiif_built", "iiif_kind", "found_by", "found_by_derived", "first_seen", "last_seen", "seen", "seen_7d", "seen_30d", "days_total", "formats", "tools", "max_cross", "trend", "rank", "score", "summary", "summary_basis", "rights", "attribution", "thumb", "meta", "meta_basis", "authority", "key_aliases", "merge_note", "recovered", "harvested", "meta_restored", "found_via", "drilled_from", "date_cross", "date_moved", "iiif_same", "tool_notes", "same_day"]
    fmtv = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":")) if isinstance(v, list) and v and isinstance(v[0], dict) else " | ".join(f"{a}: {b}" for a, b in v) if isinstance(v, list) and v and isinstance(v[0], list) else (" ".join(f"{k}:{n}" for k, n in sorted(v.items(), key=lambda kv: -kv[1])) if isinstance(v, dict) and all(isinstance(x, (int, float)) for x in v.values()) else json.dumps(v, ensure_ascii=False, separators=(",", ":")) if isinstance(v, dict) else ("+".join(v) if isinstance(v, list) else v))
    with open(os.path.join(D, "discovered.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); w.writerow(cols)
        for o in recs: w.writerow([fmtv(o.get(c, "")) for c in cols])
    pop = sorted((o for o in recs if o.get("entry_type", "기록") == "기록"), key=lambda o: o["rank"])  # v2.34 인기 순위는 기록만
    with open(os.path.join(D, "popular.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f); pc = ["rank", "score", "seen", "seen_7d", "seen_30d", "days_total", "trend", "formats", "sources", "title", "date", "id", "partOf", "partOf_derived", "summary", "url", "iiif", "iiif_built", "first_seen", "last_seen"]; w.writerow(pc)
        for o in pop[:200]: w.writerow([fmtv(o.get(c, "")) for c in pc])
    usage["daily"] = dict(sorted(usage["daily"].items()))  # v2.26 일별 활용 전체 보존(이전 400일 제한 해제)
    json.dump(usage, open(up, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    sets = {}; U_ = {o["key"]: o.get("url") for o in recs if o.get("url")}  # v2.91 RiC-O owl:sameAs에 같은 기록의 다른 소장처 주소
    graph = []
    for o in recs:
        inst = o["key"].split(":")[0]; ser = o.get("partOf") or o.get("partOf_derived") or "(계열 미상)"
        sid = f"set:{inst}:{ser}"; sets.setdefault(sid, {"@id": sid, "@type": "rico:RecordSet", "rico:title": ser, "rico:isOrWasIncludedIn": {"@id": f"inst:{inst}"},
                                                         **({"rico:generalDescription": "KOREA ARCHIVE 파생 계층(유형·제목 주제부·연대 근거) — 원 기관 계층 아님"} if ser.startswith("[파생]") else {})})
        mf = (o.get("iiif") if not o.get("iiif_status") else "") or o.get("iiif_built")
        graph.append({"@id": o.get("url") or f"rec:{o['key']}", "@type": "rico:Record", "rico:title": o["title"], **({"rico:identifier": o["id"]} if o.get("id") else {}),
                      **({"rico:isAssociatedWithDate": o["date"]} if o.get("date") else ({"rico:isAssociatedWithDate": {"@type": "rico:Date", "rico:expressedDate": o["date_derived"], **({"rico:normalizedDateValue": o["date_derived"]} if re.match(r"^\d{4}(-\d{2}){0,2}$", o["date_derived"]) else {}), "rico:certainty": "파생(derived)", "rdfs:comment": f"KOREA ARCHIVE 파생 날짜 — 근거: {o.get('date_basis', '')}"}} if o.get("date_derived") else {})),  # v3.7 파생 날짜도 RiC-O 날짜 개체로(파생임·근거 명시) "rico:isOrWasIncludedIn": {"@id": sid},
                      **rico_concepts(o),
                      "rdfs:seeAlso": {"@id": f"{PAGES}r/{rec_slug(o['key'])}.html"}, **({"owl:sameAs": [o["sameAs"]] * bool(o.get("sameAs")) + [{"@id": U_[b_]} for t_, b_, _ in REL.get(o["key"], []) if t_ == "같은 기록(다른 소장처)" and U_.get(b_)]} if (o.get("sameAs") or any(t_ == "같은 기록(다른 소장처)" for t_, _, _ in REL.get(o["key"], []))) else {}), **({"rico:isRelatedTo": [{"@id": f"{PAGES}r/{rec_slug(b_)}.html", "rdfs:comment": f"{t_} — {bs_}"} for t_, b_, bs_ in REL.get(o["key"], [])[:20]]} if REL.get(o["key"]) else {}), **({"rico:hasOrHadInstantiation": {"@id": mf, "@type": "rico:Instantiation", "rico:title": o["iiif_kind"]}} if mf else {}), **({"rico:scopeAndContent": o["summary"]} if o.get("summary") else {}),
                      "prov:wasGeneratedBy": {"@type": "prov:Activity", "prov:label": "KOREA ARCHIVE 통합검색 발견", "prov:startedAtTime": o["first_seen"], "prov:used": o["sources"], **({"prov:endedAtTime": o["last_seen"]} if o.get("last_seen") else {}), **({"prov:wasAssociatedWith": [f"KOREA ARCHIVE 통합검색/{t}" for t in o["tools"]]} if o.get("tools") else {}),
                                             **({"prov:wasInformedBy": [{"@id": f"https://changgi.github.io/korea-archive-mcp/data/provenance.json#{ak}"} for ak in o["found_by"]]} if o.get("found_by") else {})}})
    json.dump({"@context": {"rico": "https://www.ica.org/standards/RiC/ontology#", "prov": "http://www.w3.org/ns/prov#", "owl": "http://www.w3.org/2002/07/owl#", "rdfs": "http://www.w3.org/2000/01/rdf-schema#"},
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
                + (f"<details><summary>메타정보 {len(o.get('meta') or [])}항목{' · 권리 ' + E_(o['rights_view'][:60]) + ' (' + E_(o.get('rights_basis', '')) + ')' if o.get('rights_view') else ''}</summary><dl>{md}</dl></details>" if md or o.get("rights_view") else "")
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
<p><a class="b0" href="discovered.csv">CSV 내려받기</a><a class="b0" href="discovered.jsonl">JSONL</a><a class="b0" href="discovered.jsonld">RiC-O JSON-LD</a><a class="b0" href="../kv.html?manifest=https://changgi.github.io/korea-archive-mcp/data/collection.json">KV로 최근 300건 연속 보기</a><a class="b0" href="tree.html">계층구조도</a><a class="b0" href="queries/index.json">질의·회신 축적</a><a class="b0" href="classifications.json">분류 사전</a><a class="b0" href="provenance.json">발견 경로(질의↔기록)</a><a class="b0" href="relations.html">기록↔기록 맥락 연결</a><a class="b0" href="q/index.html">질의별 발굴 기록(IIIF)</a><a class="b0" href="quality.json">데이터 품질 추이</a><a class="b0" href="subjects.html">주제 색인</a><a class="b0" href="subjects.jsonld">주제 SKOS</a><a class="b0" href="fixity_changes.json">원문 변경 감시</a><a class="b0" href="feed.xml">새 발견 구독(Atom)</a><a class="b0" href="records.csl.json">인용 CSL-JSON(Zotero)</a><a class="b0" href="records.ris">인용 RIS(EndNote)</a><a class="b0" href="records.bib">인용 BibTeX(LaTeX)</a><a class="b0" href="catalog.jsonld">데이터 목록(DCAT)</a><a class="b0" href="r/index.json">기록별 영구 페이지</a><a class="b0" href="digest/index.html">주간 발견 소식</a><a class="b0" href="sitemap.xml">사이트맵</a><a class="b0" href="records.oai_dc.xml">OAI-PMH Dublin Core(하베스터)</a><a class="b0" href="activity/collection.json">IIIF 변경 발견(Change Discovery)</a><a class="b0" href="../kv.html?manifest=https://changgi.github.io/korea-archive-mcp/data/day/index.json">같은 날 기관별 기록(KV)</a><a class="b0" href="timeline.html">연대 타임라인</a><a class="b0" href="nrich/index.html">연구원 연구DB IIIF 계층</a><a class="b0" href="popular.csv">자주 활용 TOP 200</a><a class="b0" href="stats.json">집계</a></p>
<p style="font-size:13px;color:#9b9a93">주요 내용·메타정보·썸네일은 기관 IIIF·우리 브리지 매니페스트를 하루 한 번 판독해 채웁니다(하루 상한·순차 요청). 썸네일은 재이용 가능 표시가 확인된 것만 싣고, 포로·사망자·묘지·수형자 관련 기록과 허가가 필요한 이미지는 링크만 둡니다. 권리는 원 기관 표기를 따릅니다 — 게재 전 judge_rights로 확인. 모든 변경은 저장소 git 이력(docs/data/)에 남습니다.</p>
<h2>자주 활용되는 기록 TOP 30</h2><p style="font-size:13px">점수 = 최근 30일 발견×2 + 전체 발견 + 발견된 날 수×3 + 교차확인 기관 수 가중. 자동 검사 트래픽 제외.</p><div class="g">{prow}</div>
<h2>일별 활용(최근 14일)</h2><table><tr><th>날짜</th><th>검색 묶음</th><th>발견 기록</th><th>신규 기록</th></tr>{urow}</table><p style="font-size:13px">형식별 누계: {E_(fmtv(usage['formats']))} · <a href="usage.json">usage.json</a></p>
<h2>질의·회신 축적</h2><p style="font-size:13px">모든 도구 호출의 질의와 회신 본문을 원문 그대로(가공·삭제 없이) 영구 보존합니다. 같은 질의·같은 회신은 한 번만 두고 횟수만 셉니다. 회신이 달라지면 새 판으로 남겨 기관 응답 변화의 증거로 씁니다. 고유 질의 {nq['total']}건 · 누적 호출 {nq['calls']}회 · 도구별 {E_(fmtv(nq['by_tool']))} · <a href="queries/index.json">queries/index.json</a> (월별 회신 원문 queries/YYYY-MM.jsonl.gz) · 자동 점검(골든·헬스·원장 보강) 질의·회신은 활용 집계와 분리해 <a href="queries/probe/index.json">queries/probe/</a>에 따로 축적(고유 {npq['total']}건 — 기관 응답 변화·장애의 증거)</p><table><tr><th>최근</th><th>도구</th><th>질의</th><th>횟수</th></tr>{qrow}</table>
<h2>최근 발견 100건</h2><div class="g">{rows}</div></main></html>""")
    build_tree(recs); ncls = merge_classes(recs); nprov, _orph = build_provenance(recs); nfx = write_fixity(recs); nql = write_quality(recs); nsub = merge_subjects(recs); nau = build_authorities(recs); print(f'기관 전거 외부 연결 {nau}건 — authorities.json'); npl = build_places(recs); print(f'지명 사전 {npl}곳 — places.json·places.jsonld'); nmed = build_media(recs); npg = build_record_pages(recs); ndg = build_digest(recs, today); nact = build_activity(recs); print(f"IIIF Change Discovery 활동 {nact}건 — activity/collection.json"); ncat = build_catalog(recs, nql)
    print(f"원장 {len(recs)}건 (신규 {new_recs}, 묶음 {new_batches}) · 맥락 연결 {nrel}")
    print(f"질의 고유 {nq['total']}건(신규 {nq['added']}) · 분류 경로 {ncls}개 · 발견 경로 질의 {nprov}종 · 다매체(피드 {nmed[0]}·인용 {nmed[1]}·연대 {nmed[2]}) · 주제 색인 {nsub} · 품질 권리 {nql['권리 표시']}% 요약 {nql['요약']}% 연대 {nql['연대']}%")

if __name__ == "__main__":
    main()
