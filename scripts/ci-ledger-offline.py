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
g["main"]()
after = sum(1 for l in open(os.path.join(data, "discovered.jsonl"), encoding="utf-8") if l.strip())
bad = []
if after < before - 5: bad.append(f"원장 항목 감소 {before}→{after}(중복 합산 허용 범위 초과)")
for f in ("sitemap.xml", "catalog.jsonld", os.path.join("r", "index.json"), "loss_guard.json"):
    if not os.path.exists(os.path.join(data, f)): bad.append(f"산출물 없음: {f}")
reg = subprocess.run([sys.executable, os.path.join(tmp, "scripts", "records_register.py"), "--verify"], capture_output=True, text=True)
if reg.returncode not in (0,): bad.append("등록부 검증 실패: " + (reg.stdout + reg.stderr)[-200:])
shutil.rmtree(tmp, ignore_errors=True)
print(f"원장 오프라인 시험: 항목 {before}→{after}" + ("" if not bad else " · " + " · ".join(bad)))
sys.exit(1 if bad else 0)
