#!/usr/bin/env python3
"""v2.74 원장 병합 오프라인 전 과정 시험 — 네트워크를 막고(모든 외부 호출 실패) 저장소의 docs/data 사본으로 ledger_merge.main()을 끝까지 실행한다.
문법 검사로는 안 잡히는 실행 결함(이름 미정의·줄 끝 주석이 코드를 삼킴 등)을 CI에서 잡는다. 사본에서만 돌고 저장소는 바꾸지 않는다.
검사: 예외 없이 끝남 · 원장 항목 수가 줄지 않음 · 등록부 사슬 정상(--verify) · 기록별 페이지·사이트맵·데이터 목록 생성."""
import json, os, shutil, subprocess, sys, tempfile, urllib.request
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
tmp = tempfile.mkdtemp(prefix="ka-ledger-")
for d in ("scripts", "lib", os.path.join("app", "api", "[transport]")):
    shutil.copytree(os.path.join(ROOT, d), os.path.join(tmp, d), dirs_exist_ok=True)
shutil.copytree(os.path.join(ROOT, "docs"), os.path.join(tmp, "docs"))
data = os.path.join(tmp, "docs", "data")
before = sum(1 for l in open(os.path.join(data, "discovered.jsonl"), encoding="utf-8") if l.strip()) if os.path.exists(os.path.join(data, "discovered.jsonl")) else 0
g = {"__name__": "ci", "__file__": os.path.join(tmp, "scripts", "ledger_merge.py")}
exec(compile(open(g["__file__"], encoding="utf-8").read(), g["__file__"], "exec"), g)
g["get"] = lambda u: {"day": "x", "len": 0, "start": 0, "items": []} if "/api/ledger/" in u else (_ for _ in ()).throw(OSError("offline"))
g["mcp_call"] = lambda t, a: (_ for _ in ()).throw(OSError("offline"))
def _no(*a, **k): raise OSError("offline")
urllib.request.urlopen = _no
# v2.83 같은 기록 추적 — IA 식별자 = NARA 로컬 식별자인 기록이 자기 자신을 '이미 있음'으로 보지 않는지(실측 결함)
_ia = {"key": "ia:111-adc-1", "id": "111-adc-1", "sameAs": "NARA 111-ADC-1", "meta": [["identifier", "111-adc-1"]], "summary": "https://catalog.archives.gov/id/99"}
_t = g["same_targets"](_ia)
assert ("nara_local", "111-ADC-1") in [x[:2] for x in _t] and ("naid", "99") in [x[:2] for x in _t], _t
assert not any(k.startswith(g["TARGET_INST"]["nara_local"]) for k in [_ia["key"]]), "자기 자신 오인"
# v3.8.9 날짜 해석기 회귀 사례(v3.0.1~v3.6.2에서 고친 결함 포함) — 기대값과 다르면 main 전에 실패
_md, _td = g["meta_date"], g["title_date"]
_cases = [(_md("1910-03-15"), "1910-03-15"), (_md("c 23 March 1956")[0], "1956-03-23"), (_md("September 1950-October 1950; 1953")[0], "1950~1953"),
          (_md("癸卯十月二十七日 (1783년 10월 27일 (음))")[0], "1783-10-27"), (_md("기원전 57년 04월 15일")[0], ""), (_md("14세기 중반", era=True)[0], ""),
          (_md("조선 태조 7년(1398)", era=True)[0], "1398"), (_md("1950-09-00 ~ 1950-09-00")[0], "1950-09"), (_md("0000-00-00 ~ 0000-00-00")[0], ""),
          (_md("1950-00-00 ~ 1959-00-00")[0], "1950~1959"),
          (_td("Kapyong, South Korea. June 1952. A view")[0], "1952-06"), (_td("INCHON, KOREA, 1950-09. US TANK")[0], "1950-09"),
          (_td("Report no. 1950-12. x")[0], ""), (_td("Nr. 1939. Hilfe an Korea")[0], ""), (_td("1950년대 판문점 휴전 회담장")[0], ""),
          (_td("USS Begor (APD-127) off Hungnam on 24 December 1950 (80-G-K-11769).jpg")[0], "1950-12-24"),
          (_td("Sept. 4, 1876 - Mar. 6, 1877")[0], "1876~1877"), (_td("서울역 피난열차에 오르는 피란민들 사진(1950.12.24.)")[0], "1950-12-24")]
_bad_dt = [(i, got, want) for i, (got, want) in enumerate(_cases) if (got[0] if isinstance(got, tuple) else got) != want]
assert not _bad_dt, f"날짜 해석기 회귀 {_bad_dt}"
_oh = g["origin_holder"]({"meta": [["소장자(처)", "국립문서기록관리청 (National Archives and Records Administration)"], ["문서번호", "SC354878"], ["계층", "국사편찬위원회 전자사료관 › 사료군 AUS005 Record Group 111: Records of the Office of the Chief Signal Officer, 1860 - 1985 › 사료계열"]]})
assert _oh["local_id"] == "111-SC-354878" and "111-SC-354000 to 111-SC-354999" in _oh["finding_aid"]["label"] and _oh["record_group"].startswith("RG 111"), _oh  # v3.11
assert g["origin_holder"]({"meta": [["소장자(처)", "국사편찬위원회"]]}) is None
_dn = lambda d: (g["date_norm"]({"key": "x:1", "date": d}) or {}).get("value")  # v3.51 기관 날짜 표기 변형 정규화 — 모호한 표기는 정규화하지 않는다(must_not)
assert (_dn("1894 Aug 7"), _dn("1952 Jan 01 - 1952 Dec 31"), _dn("1950 Sep 01 - 1950 Sep 30"), _dn("1894 Jun 01 - 1894 Dec 31"), _dn("197605"), _dn("1763(영조 39)"), _dn("조선, 1789"), _dn("1934 ~")) == \
       ("1894-08-07", "1952", "1950-09", "1894-06-01~1894-12-31", "1976-05", "1763", "1789", "1934"), "date_norm 회귀(v3.51)"
assert not any(_dn(x) for x in ("2019/1962", "11.3.63-3.12.63", "고려시대", "조선, 19세기")), "모호한 날짜 표기가 정규화됨(v3.51 must_not)"
_eb = g["envelope_basis"]; _K = "기록 봉투(이미지 없음 — 기록 정보만 담은 브리지)"  # v3.11.1 기록 단위 봉투 사유
assert _eb({"key": "nlk:CNTS-1", "iiif_kind": _K})["type"] == "기술" and _eb({"key": "nlk:1", "iiif_kind": _K, "meta": [["원문 열람", "소장 정보(원문 열람은 기관 확인)"]]})["type"] == "매체"
assert _eb({"key": "nlk:2", "iiif_kind": _K})["type"] == "미구축" and _eb({"key": "nrich:rep:1", "iiif_kind": _K})["type"] == "매체" and _eb({"key": "nara:1", "iiif_kind": "원 기관 제공 매니페스트"}) is None
_pl = g["places"]  # v3.13 지명 사전 — 다국어 표기 한 표준명, 오탐(어중·일반어) 방지
assert _pl({"title": "EVACUATION OF HUNGNAM, KOREA"}) == {"흥남"} == _pl({"title": "흥남철수작전 당시 흥남항 전경 사진"}) and _pl({"title": "AMPHIBIOUS FORCE LANDING, D-DAY, INCHON"}) == {"인천"}
assert not _pl({"title": "Seoulite 세계대전 원산지 개성적 수원지"}) and _pl({"title": "x", "meta": [["취급지명", "Hungnam[흥남]"]]}) == {"흥남"} and not _pl({"title": "x", "summary": "Hungnam"})
assert _pl({"title": "[국외문화유산] 진주선 — 미국"}) == set() and _pl({"title": "增修崇慶州志 卷一"}) == set() and _pl({"title": "경주지형도(慶州地形圖)"}) == {"경주"}  # v3.15 오탐 규칙
assert _pl({"title": "REFUGEES RESTING NEAR THE 38TH PARALLEL"}) == {"38선"} and _pl({"title": "한국전쟁 초기 진주시의 60퍼센트"}) == {"진주"} and _pl({"title": "한미 협력 강화 방안"}) == set() and _pl({"title": "강화 청련사 — 인천 강화군"}) == {"강화", "인천"}
_ec = g["event_date_check"]  # v3.17 사건-날짜 정합 — 연도가 앞설 때만 모순, 같은 해 직전·연도만 표기는 단정 안 함
assert _ec({"title": "흥남 철수, 한국", "date": "1945"})["verdict"].startswith("사건 이전 연도") and _ec({"title": "EVACUATION OF HUNGNAM, KOREA", "date": "1950-12-24"})["verdict"] == "일치"
assert _ec({"title": "인천상륙작전 전 함포 사격 사진 1", "date": "1950-09-13"})["verdict"].startswith("사건 직전") and _ec({"title": "x ; EVACUATION, HUNGNAM", "date": "1950-01-01T00:00:00Z"})["verdict"] == "일치"
assert _ec({"title": "Hell or high water; MacArthur's landing at Inchon", "date": "1968"})["verdict"].startswith("사건 이후") and _ec({"title": "CHOSIN RESERVOIR AREA", "date": "1950-11-01"}) is None
assert _ec({"title": "한국전쟁, 미 8군", "date": "1945"})["verdict"].startswith("사건 이전 연도") and _ec({"title": "흥남 철수 — Korean War", "date": "1950-12-20"})["event"] == "흥남 철수"  # v3.19 구체 사건 우선
assert _ec({"title": "List: Negotiations re Policy After the Armistice Talks", "date": "1947~1952"})["verdict"] == "일치" and _ec({"title": "韓国併合ニ関スル閣議決定書", "date": "1909"}) is None and _ec({"title": "판문점 휴전회담장", "date": "0000"}) is None
_dn = g["date_norm"]  # v3.20 비ISO 날짜 정규화 — 일/월 모호는 기관 관행 확인된 곳만
assert _dn({"key": "dnz:1", "date": "18/04/2018"})["value"] == "2018-04-18" and _dn({"key": "x:1", "date": "05/04/2018"}) is None and _dn({"key": "x:1", "date": "18/04/2018"})["value"] == "2018-04-18"
assert _dn({"key": "dnz:1", "date": "[1951 or 1952]"})["value"] == "1951~1952" and _dn({"key": "jacar:1", "date": "明治４２年～明治４３年"})["value"] == "1909~1910" and _dn({"key": "x:1", "date": "1950-12"}) is None and _dn({"key": "ia:1", "date": "1950-01-01T00:00:00Z"})["value"] == "1950" and _dn({"key": "indy:1", "date": "19220405"})["value"] == "1922-04-05"
_ft = g["facet_terms"]  # v3.22 기관 전거 줄 — 인명 쉼표 보존·전거 번호는 용어에서 분리
assert _ft("인물(기관 전거)", "MacArthur, Douglas=KAC201619806 · Ridgway, Matthew B.=KAC1", "인물") == [("인물", "MacArthur, Douglas"), ("인물", "Ridgway, Matthew B.")]
assert _pl({"title": "서울 前面을 强化?", "meta": [["장소(기관 전거)", "흥남[興南]=KSH2000026697"]]}) == {"서울", "흥남"}
_pe = g["persons"]  # v3.24 인물 사전
assert _pe({"title": "GEN MATTHEW B RIDGWAY, YONGPYANG"}) == {"리지웨이"} and _pe({"title": "x", "meta": [["인물(기관 전거)", "MacArthur, Douglas=KAC201619806"]]}) == {"맥아더"} and not _pe({"title": "x", "summary": "MacArthur"})
assert _pe({"title": "영조물 관리 대장"}) == set() and _pe({"title": "존숭도감의궤", "authority": {"persons": {"영조": "G002+AKS-KHF_12C601C870FFFFB1694X0"}}}) == {"영조"} and _pe({"title": "英祖實錄"}) == {"영조"}  # v3.30 UCI 연결·일반어 제외
_ap = [{"key": "jsg:A", "authority": {"persons": {"정조": "UCI-X", "영조": "G002+AKS-KHF_12C601C870FFFFB1694X0"}}}, {"key": "jsg:B", "authority": {"persons": {"正祖": "UCI-X"}}}, {"key": "jsg:C", "authority": {"persons": {"홍길동": "UCI-Y"}}}]  # v3.31 전거 자동 인물
assert g["auto_persons"](_ap) == 1 and set(g["AUTO_PERSONS"]) == {"정조"} and _ap[1]["persons_std"] == ["정조"] and "persons_std" not in _ap[2]
g["AUTO_PERSONS"].clear()
_io = g["iiif_origin"]  # v3.9 Gallica 원 기관 IIIF — 디지털 원문 ark만(카탈로그 cb ark 아님), 수집 경로 iiif가 있으면 두지 않음
assert _io({"url": "http://gallica.bnf.fr/ark:/12148/btv1b2700138b"})["manifest"] == "https://gallica.bnf.fr/iiif/ark:/12148/btv1b2700138b/manifest.json"
assert _io({"url": "https://gallica.bnf.fr/ark:/12148/cb384972039"}) is None and _io({"url": "https://gallica.bnf.fr/ark:/12148/bpt6k1", "iiif": "x"}) is None
g["main"]()
after = sum(1 for l in open(os.path.join(data, "discovered.jsonl"), encoding="utf-8") if l.strip())
bad = []
if after < before - 5: bad.append(f"원장 항목 감소 {before}→{after}(중복 합산 허용 범위 초과)")
for f in ("sitemap.xml", "catalog.jsonld", "relations.json", os.path.join("r", "index.json"), "loss_guard.json"):
    if not os.path.exists(os.path.join(data, f)): bad.append(f"산출물 없음: {f}")
try:  # v2.82 맥락 연결 — 관계마다 근거·양끝이 원장에 있는 기록
    rj = json.load(open(os.path.join(data, "relations.json"), encoding="utf-8")); keys = {json.loads(l)["key"] for l in open(os.path.join(data, "discovered.jsonl"), encoding="utf-8") if l.strip()}
    if any(not e.get("basis") or e["from"] not in keys or e["to"] not in keys for e in rj["edges"]): bad.append("맥락 연결 간선에 근거 없음·원장 밖 key")
except Exception as ex: bad.append(f"relations.json 판독 실패 {ex}")
_rd = os.path.join(data, "r"); _h = {f[:-5] for f in os.listdir(_rd) if f.endswith(".html")}; _j = {f[:-5] for f in os.listdir(_rd) if f.endswith(".json") and f != "index.json"}
if _h - _j: bad.append(f"기록 JSON 없음 {len(_h - _j)}건")  # v2.85 기록별 JSON·인용
else:
    _s = json.load(open(os.path.join(_rd, sorted(_j)[0] + ".json"), encoding="utf-8"))
    if not (_s.get("cite", {}).get("ko") and _s.get("page") and "related" in _s): bad.append("기록 JSON에 인용·페이지·관계 없음")
try:  # v2.99.9 RiC-O 의미 검사 — 주제가 아닌 패싯(생산자·소장처·공개 상태)이 hasOrHadSubject로 나가지 않는지(v2.99.8 결함 546건 재발 방지)
    _g = json.load(open(os.path.join(data, "discovered.jsonld"), encoding="utf-8"))["@graph"]
    _bad = sum(1 for x in _g for c in (x.get("rico:hasOrHadSubject") or []) if any(f"#{sl}/" in str(c.get("@id", "")) for sl in ("creator", "holder", "access", "place")))
    if _bad: bad.append(f"RiC-O 주제 속성에 생산자·소장처·공개 상태·장소 개념 {_bad}건(제 속성으로 — rico_concepts)")
except Exception as ex: bad.append(f"discovered.jsonld 판독 실패 {ex}")
try:  # v3.0.1 날짜 칸 의미 검사 — 날짜에 숫자가 없는 값(분쟁명 'Korea, 1950-1953' 등)이 AWM에서 다시 들어오지 않는지 · 파생 날짜엔 근거
    import re as _re
    _L = [json.loads(l) for l in open(os.path.join(data, "discovered.jsonl"), encoding="utf-8") if l.strip()]
    _nd = [o["key"] for o in _L if o["key"].startswith("awm:") and o.get("date") and not _re.match(r"^\s*(?:c\.?\s*)?\d", o["date"])]
    if _nd: bad.append(f"AWM 날짜 칸에 분쟁명 등 비날짜 {len(_nd)}건(v3.0.1 — Date made만)")
    _ks = {o["key"] for o in _L}  # v3.1 같은 기록 실물 이미지 — 상대가 원장에 있고 근거가 있어야
    _is = [o["key"] for o in _L if o.get("iiif_same") and (o["iiif_same"].get("key") not in _ks or not o["iiif_same"].get("basis") or not o["iiif_same"].get("manifest"))]
    if _is: bad.append(f"iiif_same 상대·근거 없음 {len(_is)}건")
    _go = [o["key"] for o in _L if o["key"].startswith("gallica:") and "/ark:/12148/cb" not in str(o.get("url")) and not (o.get("iiif") or o.get("iiif_origin"))]  # v3.9
    if _go: bad.append(f"Gallica 디지털 원문인데 원 기관 IIIF 주소 없음 {len(_go)}건")
    _gb = [o["key"] for o in _L if o.get("iiif_origin") and not (o.get("iiif_built") or o.get("iiif"))]
    if _gb: bad.append(f"iiif_origin 기록의 봉투 매니페스트 소실 {len(_gb)}건(지우지 않는다)")
    _P = json.load(open(os.path.join(data, "places.json"), encoding="utf-8"))["places"]  # v3.14 지명 사전 — 기록의 표준 지명이 사전에, 사전 기록이 원장에
    _pm = [o["key"] for o in _L for n in o.get("places_std") or [] if o["key"] not in (_P.get(n) or {}).get("records", [])]
    if _pm: bad.append(f"지명 사전에 없는 기록 지명 {len(_pm)}건")
    _pg = [k for e in _P.values() for k in e["records"] if k not in _ks]
    if _pg: bad.append(f"지명 사전의 원장 밖 기록 {len(_pg)}건")
    for _n, _e in _P.items():  # v3.16 지명별 IIIF 컬렉션 — 기록 있는 지명마다 파일, 항목 수 = 매니페스트 있는 기록 수
        if _e.get("collection"):
            _cf = os.path.join(data, "place", _e["collection"].rsplit("/", 1)[1])
            _c = json.load(open(_cf, encoding="utf-8")) if os.path.exists(_cf) else None
            if not _c or not _c.get("items") or len(_c["items"]) > len(_e["records"]): bad.append(f"지명 컬렉션 결함 {_n}")
    if not os.path.exists(os.path.join(data, "place", "index.json")): bad.append("지명 컬렉션 색인 없음")
    if "흥남" not in json.dumps(_P["흥남"]["labels"], ensure_ascii=False) or "Hungnam" not in _P["흥남"]["labels"] or any("(?" in x for e in _P.values() for x in e["labels"]): bad.append("지명 표기 변이 결함")
    _dn = [o["key"] for o in _L if o.get("date_note") and str(o.get("date") or "")[:4] != o["date_note"]["year"]]  # v3.18 철 단위 연도 단서 정합
    if _dn: bad.append(f"date_note 연도 불일치 {len(_dn)}건")
    _A = json.load(open(os.path.join(data, "authorities.json"), encoding="utf-8"))["authorities"]  # v3.23 기관 전거 — 기록의 전거 번호가 모두 authorities.json에
    _am = [i for o in _L for i in ((o.get("authority_ids") or {}).get("terms") or {}).values() if i not in _A or not _A[i]["uri"].startswith("http://lod.nl.go.kr/resource/")]
    if _am: bad.append(f"authorities.json에 없는 전거 {len(_am)}건")
    _PS = json.load(open(os.path.join(data, "persons.json"), encoding="utf-8"))["persons"]  # v3.24
    _pp = [o["key"] for o in _L for n in o.get("persons_std") or [] if o["key"] not in (_PS.get(n) or {}).get("records", [])]
    _ps = [n for n, e in _PS.items() if e.get("collection") and (e["collection"].endswith("/.json") or not os.path.exists(os.path.join(data, "person", e["collection"].rsplit("/", 1)[1])))]  # v3.30.1 빈 슬러그·파일 없음
    if _ps: bad.append(f"인물 컬렉션 파일명 결함 {_ps}")
    if _pp: bad.append(f"인물 사전에 없는 기록 인물 {len(_pp)}건")
    _dh = open(os.path.join(data, "dict.html"), encoding="utf-8").read() if os.path.exists(os.path.join(data, "dict.html")) else ""  # v3.25 기준 사전 페이지
    if not _dh or "흥남" not in _dh or "맥아더" not in _dh or "흥남 철수" not in _dh: bad.append("기준 사전 페이지 결함")
    _C = json.load(open(os.path.join(data, "dict_candidates.json"), encoding="utf-8"))["places"]  # v3.28 기준 사전 후보 — 사전에 있는 값·국가명은 후보 아님
    _cb = [v for v, e in _C.items() if not e.get("adopted") and ("(국명)" in v or v in ("흥남", "HUNGNAM", "SEOUL") or len(e["records"]) < 2)]
    if _cb: bad.append(f"기준 사전 후보 결함 {_cb[:5]}")
    _eb = [o["key"] for o in _L if str(o.get("iiif_kind", "")).startswith("기록 봉투") and not (o.get("envelope_basis") or {}).get("why")]  # v3.9.2
    if _eb: bad.append(f"사유 없는 기록 봉투 {len(_eb)}건")
    _ex = [o["key"] for o in _L if o.get("envelope_basis") and not str(o.get("iiif_kind", "")).startswith("기록 봉투")]
    if _ex: bad.append(f"봉투가 아닌데 봉투 사유 {len(_ex)}건")
    _tg = [o["key"] for o in _L if any(m and (str(m[0]).startswith("➤") or m[0] == "공식 검색") for m in o.get("meta") or [])]  # v3.5.3 도구 안내 문구가 기관 메타로
    if _tg: bad.append(f"메타에 도구 안내 문구 {len(_tg)}건(tool_notes로 — v3.5.3)")
    _nb = [o["key"] for o in _L if o.get("date_derived") and not o.get("date_basis")]
    if _nb: bad.append(f"근거 없는 파생 날짜 {len(_nb)}건")
except Exception as ex: bad.append(f"날짜 검사 실패 {ex}")
try:  # v3.2 IIIF Change Discovery — 컬렉션·페이지 구조, 시간 순, 기록마다 Create
    _ac = json.load(open(os.path.join(data, "activity", "collection.json"), encoding="utf-8"))
    _ev = []
    _pg = _ac["first"]["id"].rsplit("/", 1)[1]
    while _pg:
        _p = json.load(open(os.path.join(data, "activity", _pg), encoding="utf-8")); _ev += _p["orderedItems"]; _pg = (_p.get("next") or {}).get("id", "").rsplit("/", 1)[-1] or None
    if _ac.get("type") != "OrderedCollection" or len(_ev) != _ac.get("totalItems"): bad.append("Change Discovery 총계·페이지 불일치")
    if any(_ev[i]["endTime"] > _ev[i + 1]["endTime"] for i in range(len(_ev) - 1)): bad.append("Change Discovery 시간 순 아님")
    if sum(e["type"] == "Create" for e in _ev) < 0.9 * sum(1 for o in _L if o.get("entry_type", "기록") == "기록"): bad.append("Change Discovery Create 누락")
except Exception as ex: bad.append(f"Change Discovery 판독 실패 {ex}")
try:  # v3.6 같은 날 IIIF 컬렉션 — 색인과 파일 일치, 묶음마다 매니페스트 2개 이상
    _di = json.load(open(os.path.join(data, "day", "index.json"), encoding="utf-8"))
    for _x in _di["items"]:
        _c = json.load(open(os.path.join(data, "day", _x["id"].rsplit("/", 1)[1]), encoding="utf-8"))
        if _c.get("type") != "Collection" or len(_c.get("items") or []) < 2: bad.append(f"같은 날 컬렉션 결함 {_x['id']}"); break
except Exception as ex: bad.append(f"같은 날 컬렉션 판독 실패 {ex}")
try:  # v3.7.1 인용 형식 — 파생 날짜를 쓴 항목엔 '파생' 표시(인용자가 기관 날짜로 오인하지 않게)
    _nd = sum(1 for o in _L if not o.get("date") and o.get("date_derived") and o.get("entry_type", "기록") == "기록")
    _cs = json.load(open(os.path.join(data, "records.csl.json"), encoding="utf-8"))
    if _nd and sum("파생(원 기관" in x.get("note", "") for x in _cs) < _nd * 0.95: bad.append("CSL에 파생 날짜 표시 누락")
except Exception as ex: bad.append(f"인용 형식 검사 실패 {ex}")
try:  # v3.7.5 같은 기록 간선의 NARA 상대가 낱장(item)인지 — 파일·시리즈면 '원본이 속한 NARA 단위(포함)'이어야
    _LK = {o["key"]: o for o in _L}
    _lv = lambda k: next((str(m[1]).lower() for m in (_LK.get(k, {}).get("meta") or []) if m and m[0] == "기술 수준"), "item")
    _over = [e for e in rj["edges"] if e["type"].startswith("같은 기록") and (lambda a, b: (b.startswith("nara:") and not a.startswith("nara:") and _lv(b) in ("fileunit", "series", "collection", "recordgroup")))(e["from"], e["to"])]
    if _over: bad.append(f"같은 기록 간선이 NARA 파일·시리즈를 가리킴 {len(_over)}건(v3.7.5)")
except Exception as ex: bad.append(f"같은 기록 단위 검사 실패 {ex}")
reg = subprocess.run([sys.executable, os.path.join(tmp, "scripts", "records_register.py"), "--verify"], capture_output=True, text=True)
if reg.returncode not in (0,): bad.append("등록부 검증 실패: " + (reg.stdout + reg.stderr)[-200:])
if os.environ.get("KEEP"): print("사본:", tmp)
else: shutil.rmtree(tmp, ignore_errors=True)
print(f"원장 오프라인 시험: 항목 {before}→{after}" + ("" if not bad else " · " + " · ".join(bad)))
sys.exit(1 if bad else 0)
