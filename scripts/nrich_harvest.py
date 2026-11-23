#!/usr/bin/env python3
"""국립문화유산연구원 국가유산 지식이음 Open API 정적 색인(v2.15) — 매주 GitHub Actions가 실행.

연구원 Open API(openapi.do?idx=N)는 키워드 검색을 지원하지 않으므로, 공개 데이터셋 전체를 주 1회 공식 API로 받아
docs/data/nrich_db.jsonl(정규화 1줄=1기록)로 만든다. 서버 cross_search(sources='nrich')가 이 색인을 검색한다.
원 기관 요청 = 주 1회·순차·간격(예의), 검색은 정적 파일(빠름·지속가능). 필드 순서는 2026-11-23 실측(md_dataN).

정규화 필드: ds(데이터셋 키)·dn(데이터셋명)·id·t(명칭)·a(한자/영문 등 이칭)·d(연대)·p(소재지·소장처)·x(해설 300자)
            ·m(부가 메타 {이름:값})·k(공공누리 유형)·u(원 기관 상세 URL)
"""
import json, os, re, sys, time, urllib.request, html as _h

API = "http://portal.nrich.go.kr/kor/openapi.do?idx={idx}&firstindex={first}&recordcountperpage={last}"  # 실측: firstindex=시작 행, recordcountperpage=끝 행(포함) — 명세 설명과 다름  # https는 응답 불안정(실측) — 공식 End Point 그대로 http
UA = "KoreaArchiveMCP/1.0 (+https://github.com/changgi/korea-archive-mcp; weekly open-API index)"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
PAGE = int(os.environ.get("NRICH_PAGE", "500"))
MAXREC = int(os.environ.get("NRICH_MAX", "40000"))

def g(f, i):
    return f.get(str(i), "") if f.get(str(i), "") not in ("null", "None") else ""

def clean(s, n=None):
    s = re.sub(r"\s+", " ", _h.unescape(re.sub(r"<[^>]+>", " ", str(s or "")))).strip()
    return s[:n] if n else s

# 데이터셋별 정규화 — (키, 명칭, 계열 이름, 함수). 필드 번호는 실측.
DS = {
    51: ("ksm", "금석문", lambda f: dict(t=g(f, 3), a=g(f, 4), d=" ".join(x for x in (g(f, 6), g(f, 7)) if x), p=g(f, 11), x=g(f, 18),
                                        m={"종류": g(f, 9), "크기": g(f, 10), "서체": g(f, 12), "찬자": g(f, 13), "서자·제액": g(f, 15), "지정": g(f, 17)}, k=g(f, 21), u=g(f, 22))),
    209: ("portrait", "초상화(국가지정)", lambda f: dict(t=g(f, 3), a=g(f, 4), d=g(f, 5), p=g(f, 20), x=g(f, 22),
                                        m={"작가": g(f, 8), "크기": g(f, 13), "지정": g(f, 16), "지정일": g(f, 18), "소장처 영문": g(f, 21), "소장처 링크": g(f, 26)}, k="", u=g(f, 27))),
    52: ("gwaebul", "괘불(국가지정 불화)", lambda f: dict(t=g(f, 3), a=g(f, 4), d=g(f, 6), p=" ".join(x for x in (g(f, 18), g(f, 19)) if x), x=g(f, 21),
                                        m={"화승": g(f, 12), "크기": g(f, 15), "지정": g(f, 10), "지정일": g(f, 17), "화기": clean(g(f, 23), 200)}, k="", u=g(f, 25))),
    205: ("diary", "조선시대 개인일기", lambda f: dict(t=g(f, 3), a=g(f, 4), d=g(f, 7), p=g(f, 19), x=g(f, 17),
                                        m={"저자": g(f, 5), "생몰": g(f, 6), "판종": g(f, 10), "행자수": g(f, 13), "크기": g(f, 16), "수량(책)": g(f, 9), "지정": g(f, 18)}, k=g(f, 25), u=g(f, 26))),
    67: ("mokgan", "목간(가야·전국)", lambda f: dict(t=g(f, 3), a=g(f, 5), d=g(f, 15), p=" ".join(x for x in (g(f, 9), g(f, 7)) if x), x=g(f, 20),
                                        m={"소장처": g(f, 10), "목간 종류": g(f, 12), "제원(cm)": g(f, 14), "출토연도": g(f, 8), "묵서": g(f, 19), "보고서": g(f, 17), "조사기관": g(f, 21)}, k=g(f, 23), u=g(f, 24))),
    10: ("jcbib", "일제강점기 고적조사 문헌목록", lambda f: dict(t=g(f, 3), a=g(f, 4), d=g(f, 11), p="", x=g(f, 14),
                                        m={"저자": g(f, 5), "수록": g(f, 7)}, k=g(f, 17), u=g(f, 18))),
    12: ("jcphoto", "조선고적도보", lambda f: dict(t=g(f, 3), a=g(f, 4), d=g(f, 6), p="", x="",
                                        m={"시대": g(f, 5), "발행": g(f, 7)}, k=g(f, 16), u=g(f, 17))),
    39: ("dict", "한국고고학사전", lambda f: dict(t=g(f, 3), a="", d="", p="", x="", m={"사전": g(f, 8)}, k=g(f, 11), u=g(f, 12))),
    206: ("arch", "한국고고학저널(유적)", lambda f: dict(t=g(f, 3), a="", d=g(f, 5), p=" ".join(x for x in (g(f, 9), g(f, 10)) if x), x=g(f, 16) or clean(g(f, 11), 300),
                                        m={"유적 유형": g(f, 6), "주요 내용": g(f, 15), "조사기관": g(f, 17), "수록": g(f, 20)}, k=g(f, 23), u=g(f, 24))),
    8: ("koguryo", "고구려 유적(북한)", lambda f: dict(t=g(f, 3), a="", d=g(f, 4), p="", x=g(f, 7), m={"조사": " ".join(x for x in (g(f, 5), g(f, 6)) if x)}, k=g(f, 10), u=g(f, 11))),
    7: ("gaesong", "개성 문화유적(북한)", lambda f: dict(t=g(f, 3), a="", d="", p=g(f, 5), x=g(f, 6), m={"지정": g(f, 4)}, k=g(f, 10), u=g(f, 11))),
}

def fetch(idx, first, last):
    req = urllib.request.Request(API.format(idx=idx, first=first, last=last), headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            return urllib.request.urlopen(req, timeout=120).read().decode("utf-8", "replace")
        except Exception as e:
            if attempt == 2: raise
            time.sleep(5 * (attempt + 1))

def main():
    only = set(sys.argv[1:])
    rows, meta = [], {"harvested": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": "국립문화유산연구원 국가유산 지식이음 Open API", "datasets": {}}
    for idx, (key, name, fn) in DS.items():
        if only and key not in only: continue
        first, got = 1, 0
        while got < MAXREC:
            try:
                x = fetch(idx, first, first + PAGE - 1)
            except Exception as e:
                print(f"{key}: 실패 {e}", file=sys.stderr); break
            recs = re.findall(r"<data>(.*?)</data>", x, re.S)
            for d in recs:
                f = {k: v.strip() for k, v in re.findall(r"<md_data(\d+)><!\[CDATA\[(.*?)\]\]></md_data\d+>", d, re.S)}
                r = fn(f)
                if not r.get("t"): continue
                r = {"ds": key, "dn": name, "id": f"{key}:{g(f, 2)}", **{k: (clean(v, 150) if k == "x" else (clean(v, 140) if isinstance(v, str) else v)) for k, v in r.items()}}
                r["m"] = {k: clean(v, 100) for k, v in r["m"].items() if v and clean(v)}
                rows.append({k: v for k, v in r.items() if v})
            got += len(recs)
            if len(recs) < PAGE: break
            first += PAGE; time.sleep(1.0)  # 다음 구간 시작 행
        meta["datasets"][key] = {"name": name, "idx": idx, "count": sum(1 for r in rows if r["ds"] == key)}
        print(f"{key} {name}: {meta['datasets'][key]['count']}건")
        time.sleep(1.0)
    if only and os.path.exists(os.path.join(OUT, "nrich_db.jsonl")):  # 일부만 갱신 시 나머지 보존
        for ln in open(os.path.join(OUT, "nrich_db.jsonl"), encoding="utf-8"):
            o = json.loads(ln)
            if o["ds"] not in only: rows.append(o)
        old = json.load(open(os.path.join(OUT, "nrich_db_meta.json"), encoding="utf-8"))
        for k, v in old.get("datasets", {}).items():
            meta["datasets"].setdefault(k, v)
    if not rows:
        print("수집 0건 — 기존 색인 유지", file=sys.stderr); sys.exit(1)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "nrich_db.jsonl"), "w", encoding="utf-8") as fo:
        for r in sorted(rows, key=lambda r: (r["ds"], r["id"])): fo.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
    meta["total"] = len(rows)
    json.dump(meta, open(os.path.join(OUT, "nrich_db_meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"합계 {len(rows)}건")

if __name__ == "__main__":
    main()
