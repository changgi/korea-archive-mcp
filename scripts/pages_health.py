#!/usr/bin/env python3
"""v3.27 운영 Pages 산출물 건강 검사 — 원장이 게시한 기준·연결 산출물이 실제로 열리고(HTTP 200·JSON 파싱) 핵심 수치가 0이 아닌지.
오프라인 시험은 코드가 산출물을 '만드는지'를, 이 검사는 게시된 산출물이 '살아 있는지'를 본다. 실패 목록을 출력하고 종료 코드 1."""
import json, sys, urllib.request
B = "https://changgi.github.io/korea-archive-mcp/data/"
UA = {"User-Agent": "KoreaArchiveMCP/1.0 (+https://github.com/changgi/korea-archive-mcp; pages health)"}
CHECKS = [  # (파일, 검사 — 내용 → 문제 문자열 또는 None)
    ("discovered.jsonl", lambda t: None if t.count("\n") >= 500 else f"원장 줄 수 {t.count(chr(10))} < 500"),
    ("places.json", lambda t: None if sum(1 for e in json.loads(t)["places"].values() if e.get("records")) >= 10 else "기록 있는 지명 < 10"),
    ("persons.json", lambda t: "인물 컬렉션 빈 파일명" if any(str(e.get("collection", "")).endswith("/.json") for e in json.loads(t)["persons"].values()) else (None if any(e.get("records") for e in json.loads(t)["persons"].values()) else "기록 있는 인물 0")),
    ("events.json", lambda t: None if json.loads(t)["events"] else "사건 0"),
    ("authorities.json", lambda t: None if json.loads(t)["authorities"] else "전거 0"),
    ("relations.json", lambda t: None if len(json.loads(t)["edges"]) >= 100 else "관계 간선 < 100"),
    ("quality.json", lambda t: None if json.loads(t)["runs"] else "품질 runs 0"),
    ("place/index.json", lambda t: None if json.loads(t)["items"] else "지명 컬렉션 0"),
    ("day/index.json", lambda t: None if json.loads(t)["items"] else "같은 날 컬렉션 0"),
    ("dict_candidates.json", lambda t: None if "places" in json.loads(t) else "후보 파일 구조 결함"),  # v3.29
    ("coverage.json", lambda t: None if json.loads(t).get("replies", 0) > 0 and json.loads(t).get("by_source") else "조회 범위 등록부 비어 있음"),  # v3.41
    ("coverage.html", lambda t: None if "조회 범위 등록부" in t and "coverage.csv" in t else "등록부 페이지 결함"),  # v3.44
    ("places.jsonld", lambda t: None if len(json.loads(t)["@graph"]) >= 10 else "지명 SKOS 개념 < 10"),
    ("persons.jsonld", lambda t: None if any(x.get("owl:sameAs") for x in json.loads(t)["@graph"]) else "인물 SKOS 국제 전거 0"),
    ("dict.html", lambda t: None if "기준 사전" in t and "흥남" in t else "기준 사전 페이지 내용 결함"),
    ("catalog.jsonld", lambda t: None if "places.json" in t and "authorities.json" in t else "데이터 목록에 기준 사전 미등재"),
]
bad = []
for f, chk in CHECKS:
    try:
        t = urllib.request.urlopen(urllib.request.Request(B + f, headers=UA), timeout=60).read().decode("utf-8", "replace")
        p = chk(t)
        if p: bad.append(f"{f}: {p}")
    except Exception as e:
        bad.append(f"{f}: 열리지 않음({str(e)[:80]})")
print("\n".join(bad) if bad else f"Pages 산출물 {len(CHECKS)}종 정상")
sys.exit(1 if bad else 0)
