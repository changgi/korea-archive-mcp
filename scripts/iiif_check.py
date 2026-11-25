#!/usr/bin/env python3
"""IIIF 구조 검증(v2.45) — Presentation API 3 핵심 규칙을 의존성 없이 검사한다.

대상: docs/ 아래 IIIF JSON 전부(갤러리 매니페스트·연구원 계층·기관 계층·질의별 기록물·원장 컬렉션)
      + --remote N: 컬렉션들이 가리키는 우리 브리지 매니페스트(/iiif/…)를 N개 표본으로 받아 검사.
검사(오류): @context(presentation/3) · id(http URI) · type · label 언어 맵 · Collection.items(id·type)
           · Manifest.items → Canvas(id·type·이미지면 height/width) → AnnotationPage → Annotation(painting·body id/type·target)
           · metadata/summary/requiredStatement 언어 맵 형태 · rights는 단일 URI
검사(경고): 컬렉션 항목 label 없음 · 빈 items
종료 코드 1 = 오류 있음. 표준 라이브러리만. 사용: python3 scripts/iiif_check.py [--remote 20]
"""
import glob, json, os, random, re, sys, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")
URI = re.compile(r"^https?://\S+$")
UA = "KoreaArchiveMCP/2.45 (+https://github.com/changgi/korea-archive-mcp; iiif structure check)"
errs, warns = [], []


def langmap(v):
    return isinstance(v, dict) and v and all(isinstance(k, str) and isinstance(x, list) and all(isinstance(s, str) for s in x) for k, x in v.items())


def check(j, where):
    e = lambda m: errs.append(f"{where}: {m}")
    w = lambda m: warns.append(f"{where}: {m}")
    ctx = j.get("@context")
    if "iiif.io/api/presentation/3" not in json.dumps(ctx or ""): e("@context에 presentation/3 없음")
    if not isinstance(j.get("id"), str) or not URI.match(j["id"]): e(f"id가 http URI 아님: {str(j.get('id'))[:60]}")
    t = j.get("type")
    if t not in ("Collection", "Manifest"): e(f"type={t}")
    if not langmap(j.get("label")): e("label이 언어 맵 아님")
    for f in ("summary",):
        if f in j and not langmap(j[f]): e(f"{f}가 언어 맵 아님")
    for i, m in enumerate(j.get("metadata") or []):
        if not (langmap(m.get("label")) and langmap(m.get("value"))): e(f"metadata[{i}] label/value 언어 맵 아님"); break
    rs = j.get("requiredStatement")
    if rs is not None and not (langmap(rs.get("label")) and langmap(rs.get("value"))): e("requiredStatement 형태 오류")
    if "rights" in j and not (isinstance(j["rights"], str) and URI.match(j["rights"])): e(f"rights는 단일 URI여야 함: {str(j['rights'])[:60]}")
    for th in j.get("thumbnail") or []:
        if not (isinstance(th, dict) and th.get("id") and th.get("type")): e("thumbnail 항목에 id/type 없음"); break
    items = j.get("items")
    if not isinstance(items, list): e("items가 배열 아님"); return
    if not items: w("items 비어 있음")
    if t == "Collection":
        for k, it in enumerate(items):
            if not (isinstance(it, dict) and isinstance(it.get("id"), str) and URI.match(it["id"]) and it.get("type") in ("Collection", "Manifest")):
                e(f"items[{k}] id/type 오류"); break
            if not langmap(it.get("label")): w(f"items[{k}] label 없음"); break
    elif t == "Manifest":
        for k, cv in enumerate(items):
            if not (isinstance(cv, dict) and cv.get("type") == "Canvas" and isinstance(cv.get("id"), str)): e(f"Canvas[{k}] type/id 오류"); break
            for ap in cv.get("items") or []:
                if ap.get("type") != "AnnotationPage" or not ap.get("id"): e(f"Canvas[{k}] AnnotationPage 오류"); break
                for an in ap.get("items") or []:
                    b = an.get("body") or {}
                    b = b[0] if isinstance(b, list) and b else b
                    if an.get("type") != "Annotation" or an.get("motivation") != "painting": e(f"Canvas[{k}] Annotation type/motivation 오류"); break
                    if not (isinstance(b, dict) and b.get("id") and b.get("type")): e(f"Canvas[{k}] body id/type 없음"); break
                    tgt = an.get("target"); tgt = tgt if isinstance(tgt, str) else (tgt or {}).get("id", "") if isinstance(tgt, dict) else ""
                    if not str(tgt).split("#")[0] == cv["id"]: e(f"Canvas[{k}] target이 캔버스를 가리키지 않음"); break
                    if b.get("type") == "Image" and not (isinstance(cv.get("height"), int) and isinstance(cv.get("width"), int)): e(f"Canvas[{k}] 이미지인데 height/width 없음"); break


def main():
    remote = 0
    if "--remote" in sys.argv:
        remote = int(sys.argv[sys.argv.index("--remote") + 1])
    n = 0; refs = set()
    for f in sorted(glob.glob(os.path.join(ROOT, "**", "*.json"), recursive=True)):
        try: j = json.load(open(f, encoding="utf-8"))
        except Exception: continue
        if not (isinstance(j, dict) and "iiif.io/api/presentation" in json.dumps(j.get("@context") or "")): continue
        n += 1; check(j, os.path.relpath(f, ROOT))
        if j.get("type") == "Collection":
            for it in j.get("items") or []:
                if isinstance(it, dict) and it.get("type") == "Manifest" and "korea-archive-mcp.vercel.app/iiif/" in str(it.get("id")): refs.add(it["id"])
    print(f"정적 IIIF {n}개 검사")
    if remote and refs:
        random.seed(len(refs))  # 같은 원장이면 같은 표본(재현)
        sample = random.sample(sorted(refs), min(remote, len(refs))); ok = 0
        for u in sample:
            try:
                j = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40).read().decode("utf-8"))
                check(j, "브리지 " + u.split("/iiif/")[1][:60]); ok += 1
            except Exception as ex:
                warns.append(f"브리지 {u[:80]}: 받기 실패 {type(ex).__name__}")
        print(f"브리지 매니페스트 표본 {ok}/{len(sample)} 검사 (전체 참조 {len(refs)})")
    for x in warns[:15]: print("⚠️", x)
    if len(warns) > 15: print(f"⚠️ … 외 {len(warns) - 15}건")
    for x in errs[:40]: print("❌", x)
    print(f"오류 {len(errs)} · 경고 {len(warns)}")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
