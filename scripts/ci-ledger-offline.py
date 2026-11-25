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
reg = subprocess.run([sys.executable, os.path.join(tmp, "scripts", "records_register.py"), "--verify"], capture_output=True, text=True)
if reg.returncode not in (0,): bad.append("등록부 검증 실패: " + (reg.stdout + reg.stderr)[-200:])
if os.environ.get("KEEP"): print("사본:", tmp)
else: shutil.rmtree(tmp, ignore_errors=True)
print(f"원장 오프라인 시험: 항목 {before}→{after}" + ("" if not bad else " · " + " · ".join(bad)))
sys.exit(1 if bad else 0)
