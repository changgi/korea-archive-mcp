#!/usr/bin/env python3
"""일일 기록물 등록부(v2.31) — 발견 원장 산출물을 그날의 현용기록물로 등록하고 해시 사슬로 잇는다.

docs/data/의 산출물(원장·질의·분류·발견 경로·IIIF·피드·인용·타임라인·연구원 색인…)마다 SHA-256·바이트를 적은
등록부 docs/data/records/YYYY-MM-DD.json을 만든다. 등록부는 직전 등록부 파일의 SHA-256(prev)을 담아
하나라도 바뀌거나 빠지면 사슬이 끊긴다(증거성). 등록부는 지우지 않는다. 산출물이 직전과 완전히 같으면
새 등록부를 만들지 않는다(중복만 생략).

  python3 scripts/records_register.py            # 사슬 검증 → 등록(변경 있을 때)
  python3 scripts/records_register.py --verify   # 사슬·최신 등록부 대비 현재 파일 검증만
종료 코드: 사슬 끊김 2. 표준 라이브러리만.
"""
import datetime as dt, hashlib, json, os, sys

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
R = os.path.join(D, "records")
SKIP_DIRS = {"records", "__pycache__"}
SKIP_FILES = {"_state.json", "SHA256SUMS"}  # 작업 상태(처리 위치)·파생 목록은 기록물 아님


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()


def files():
    out = {}
    for root, dirs, fs in os.walk(D):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for f in sorted(fs):
            if f in SKIP_FILES: continue
            p = os.path.join(root, f); rel = os.path.relpath(p, D).replace(os.sep, "/")
            out[rel] = {"sha256": sha(p), "bytes": os.path.getsize(p)}
    return out


def registers():
    order = lambda f: (f[:10], int(f[11:-5]) if f[10:11] == "-" else 1)  # 2026-11-23.json → 2026-11-23-2.json 순(같은 날 재등록 판 번호)
    return sorted((f for f in os.listdir(R) if f.endswith(".json") and f != "index.json"), key=order) if os.path.isdir(R) else []


def verify(check_current=False):
    regs = registers(); bad = []; prev = None
    for f in regs:
        try: r = json.load(open(os.path.join(R, f), encoding="utf-8"))
        except Exception as e: bad.append(f"{f}: 등록부를 읽을 수 없음({type(e).__name__}) — 변경·손상 의심"); prev = f; continue
        want = r.get("prev") or {}
        if prev and want.get("sha256") != sha(os.path.join(R, prev)): bad.append(f"{f}: 직전 등록부 {prev} 해시 불일치(변경·대체 의심)")
        if prev and want.get("register") != prev: bad.append(f"{f}: 직전 등록부 이름 불일치({want.get('register')} ≠ {prev}) — 등록부 누락 의심")
        prev = f
    if check_current and regs:
        try: last = json.load(open(os.path.join(R, regs[-1]), encoding="utf-8"))["files"]
        except Exception: return regs, bad + [f"최신 등록부 {regs[-1]}를 읽을 수 없음"]
        cur = files()
        gone = [k for k in last if k not in cur]
        if gone: bad.append(f"최신 등록부 이후 사라진 산출물 {len(gone)}개: {', '.join(gone[:5])} — 축적 정보는 지우지 않는다")
    return regs, bad


def main():
    regs, bad = verify()
    if bad:
        print("❌ 등록부 사슬 끊김:", *bad, sep="\n  ", file=sys.stderr); sys.exit(2)
    if "--verify" in sys.argv:
        regs, bad = verify(check_current=True)
        for b in bad: print("⚠️", b)
        print(f"✅ 등록부 {len(regs)}개 사슬 정상"); sys.exit(2 if bad else 0)
    cur = files()
    last = json.load(open(os.path.join(R, regs[-1]), encoding="utf-8")) if regs else None
    if last and last["files"] == cur:
        print("산출물이 직전 등록부와 동일 — 새 등록 생략(중복)"); return
    now = dt.datetime.now(dt.timezone.utc); day = now.strftime("%Y-%m-%d")
    name = f"{day}.json"; n = 1
    while name in regs: n += 1; name = f"{day}-{n}.json"  # 같은 날 재실행 — 덮어쓰지 않고 판 번호
    st = json.load(open(os.path.join(D, "stats.json"), encoding="utf-8")) if os.path.exists(os.path.join(D, "stats.json")) else {}
    pick = lambda f, k: (json.load(open(os.path.join(D, f), encoding="utf-8")).get(k) if os.path.exists(os.path.join(D, f)) else None)
    changed = {k: ("신규" if not last or k not in last["files"] else "변경") for k, v in cur.items() if not last or last["files"].get(k) != v}
    reg = {
        "register": "KOREA ARCHIVE 통합검색 — 발견 원장 일일 기록물 등록부",
        "id": name[:-5], "created": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "producer": "GitHub Actions ledger 워크플로", "commit": os.environ.get("GITHUB_SHA", ""), "run": os.environ.get("GITHUB_RUN_ID", ""),
        "counts": {"records": st.get("records"), "new_records": st.get("new_records"), "queries": pick("queries/index.json", "total"),
                   "classifications": pick("classifications.json", "total"), "provenance_queries": pick("provenance.json", "queries")},
        "prev": {"register": regs[-1], "sha256": sha(os.path.join(R, regs[-1]))} if regs else None,
        "changed": changed, "files": cur,
        "note": "files = docs/data 산출물 SHA-256·바이트(작업 상태 _state.json 제외). prev = 직전 등록부 파일 해시(사슬). 검증: python3 scripts/records_register.py --verify · sha256sum -c SHA256SUMS",
    }
    os.makedirs(R, exist_ok=True)
    json.dump(reg, open(os.path.join(R, name), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    idx = [{"register": f, "sha256": sha(os.path.join(R, f))} for f in registers()]
    json.dump({"chain": idx, "head": idx[-1]}, open(os.path.join(R, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    with open(os.path.join(D, "SHA256SUMS"), "w", encoding="utf-8") as f:
        for k, v in cur.items(): f.write(f"{v['sha256']}  {k}\n")
    print(f"등록 {name}: 산출물 {len(cur)}개 · 신규·변경 {len(changed)}개 · 사슬 길이 {len(idx)}")


if __name__ == "__main__":
    main()
