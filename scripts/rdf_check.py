#!/usr/bin/env python3
"""연결 데이터 검증(v2.44) — 공개 JSON-LD를 표준 RDF 파서(rdflib)로 읽고 SPARQL로 무결성 확인.

- docs/data/discovered.jsonld(RiC-O)·subjects.jsonld(SKOS)가 파싱되는가
- 기록이 가리키는 주제·장소 개념이 subjects.jsonld에 실제로 있는가(끊긴 링크 0)
- 모든 skos:Concept가 skos:inScheme·skos:prefLabel을 갖는가
종료 코드 1 = 실패(ledger 워크플로가 auto-health 이슈). 사용: pip install rdflib && python3 scripts/rdf_check.py
"""
import os, sys
import rdflib

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
g = rdflib.Graph()
bad = []
for f in ("subjects.jsonld", "places.jsonld", "persons.jsonld", "discovered.jsonld"):  # v3.31.1 지명·인물 사전(v3.14·v3.24) 개념도 — 빠져 있어 그 링크가 '끊긴 링크'로 세어지던 결함
    p = os.path.join(D, f)
    if not os.path.exists(p):
        print(f"(없음) {f}"); continue
    n0 = len(g)
    try:
        g.parse(p, format="json-ld")
    except Exception as e:
        bad.append(f"{f} 파싱 실패: {type(e).__name__}: {str(e)[:120]}"); continue
    print(f"{f}: 트리플 {len(g) - n0}")
P = """PREFIX rico:<https://www.ica.org/standards/RiC/ontology#> PREFIX skos:<http://www.w3.org/2004/02/skos/core#>"""
broken = list(g.query(P + """ SELECT ?r ?c WHERE { { ?r rico:hasOrHadSubject ?c } UNION { ?r rico:isAssociatedWithPlace ?c } FILTER NOT EXISTS { ?c a skos:Concept }
  FILTER(!STRSTARTS(STR(?c), "http://lod.nl.go.kr/resource/")) }"""))  # v3.31.1 국립중앙도서관 LOD 전거(v3.23)는 외부 정식 식별자 — 이 그래프 밖이 정상(authorities.json이 검증)
if broken: bad.append(f"끊긴 주제·장소 링크 {len(broken)}건 — 예: {broken[0][1]}")
ext = len(list(g.query(P + """ SELECT ?r ?c WHERE { { ?r rico:hasOrHadSubject ?c } UNION { ?r rico:isAssociatedWithPlace ?c } FILTER(STRSTARTS(STR(?c), "http://lod.nl.go.kr/resource/")) }""")))
nolab = list(g.query(P + """ SELECT ?c WHERE { ?c a skos:Concept . FILTER NOT EXISTS { ?c skos:prefLabel ?l } }"""))
nosch = list(g.query(P + """ SELECT ?c WHERE { ?c a skos:Concept . FILTER NOT EXISTS { ?c skos:inScheme ?s } }"""))
if nolab: bad.append(f"prefLabel 없는 개념 {len(nolab)}")
if nosch: bad.append(f"inScheme 없는 개념 {len(nosch)}")
recs = len(list(g.query(P + " SELECT ?r WHERE { ?r a rico:Record }")))
links = len(list(g.query(P + " SELECT ?r ?c WHERE { { ?r rico:hasOrHadSubject ?c } UNION { ?r rico:isAssociatedWithPlace ?c } }")))
conc = len(list(g.query(P + " SELECT ?c WHERE { ?c a skos:Concept }")))
print(f"rico:Record {recs} · skos:Concept {conc} · 주제·장소 링크 {links}(외부 LOD 전거 {ext}) · 끊긴 링크 {len(broken)}")
top = list(g.query(P + """ SELECT ?l (COUNT(?r) AS ?n) WHERE { ?r rico:isAssociatedWithPlace ?c . ?c skos:prefLabel ?l } GROUP BY ?l ORDER BY DESC(?n) LIMIT 3"""))
print("장소 상위(SPARQL):", ", ".join(f"{r[0]} {r[1]}" for r in top))
for b in bad: print("❌", b)
sys.exit(1 if bad else 0)
