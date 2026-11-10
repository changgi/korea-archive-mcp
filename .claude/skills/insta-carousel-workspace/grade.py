#!/usr/bin/env python3
"""프로그램 채점: 각 run의 outputs를 assertion별로 검사해 grading.json 생성.
사용: python grade.py <iteration-dir>
"""
import glob
import json
import os
import re
import sys

from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def collect(outdir):
    pngs = [p for p in glob.glob(os.path.join(outdir, "**", "*.png"), recursive=True)]
    htmls = [p for p in glob.glob(os.path.join(outdir, "**", "*.html"), recursive=True)]
    texts = [p for p in glob.glob(os.path.join(outdir, "**", "*.txt"), recursive=True)] + \
            [p for p in glob.glob(os.path.join(outdir, "**", "*.md"), recursive=True)]
    html_src = ""
    for h in htmls:
        try:
            html_src += open(h, encoding="utf-8", errors="replace").read()
        except OSError:
            pass
    text_src = ""
    for t in texts:
        try:
            text_src += open(t, encoding="utf-8", errors="replace").read()
        except OSError:
            pass
    return pngs, html_src, text_src


def grade_run(eval_name, outdir):
    pngs, html, text = collect(outdir)
    sizes = []
    for p in pngs:
        try:
            sizes.append(Image.open(p).size)
        except OSError:
            sizes.append((0, 0))
    n = len(pngs)
    ok_1080 = n > 0 and all(s == (1080, 1080) for s in sizes)
    size_detail = ", ".join(f"{w}x{h}" for w, h in sizes[:12])
    both = html + "\n" + text

    res = []

    def add(txt, passed, ev):
        res.append({"text": txt, "passed": bool(passed), "evidence": ev})

    add("PNG 파일이 6~10장 생성되었다", 6 <= n <= 10, f"PNG {n}장")
    add("모든 PNG가 정확히 1080x1080 픽셀이다", ok_1080, f"크기: {size_detail or '없음'}")

    if eval_name.startswith("eval-0"):
        tags = len(re.findall(r"#\S+", text))
        add("캡션 텍스트 파일이 존재하고 해시태그(#)가 10개 이상 포함되어 있다",
            bool(text.strip()) and tags >= 10, f"텍스트파일 {bool(text.strip())}, 해시태그 {tags}개")
        add("HTML 소스에 페이지 번호(n / N 형식) 마크업이 있다",
            bool(re.search(r"\d+\s*/\s*\d+", html)), "정규식 '\\d+ / \\d+' 매칭")
        add("핵심 정보('볕뜰로스터스', '24시간')가 카드 HTML에 반영되어 있다",
            ("볕뜰" in html) and ("24시간" in html), f"볕뜰:{'볕뜰' in html}, 24시간:{'24시간' in html}")
    else:
        data_uris = html.count("data:image")
        add("제공된 실제 사진이 임베드되었다 (HTML에 data:image base64 URI 3개 이상)",
            data_uris >= 3, f"data:image {data_uris}개")
        add("핵심 수치('40분', '30%')가 카드 HTML 또는 캡션에 반영되어 있다",
            ("40분" in both) and ("30%" in both), f"40분:{'40분' in both}, 30%:{'30%' in both}")
        add("캡션 파일이 존재하고 팔로우 유도(CTA) 문구가 카드 또는 캡션에 있다",
            bool(text.strip()) and ("팔로우" in both), f"텍스트파일 {bool(text.strip())}, '팔로우' 포함 {'팔로우' in both}")
    return res


def main():
    it_dir = sys.argv[1]
    for eval_dir in sorted(glob.glob(os.path.join(it_dir, "eval-*"))):
        eval_name = os.path.basename(eval_dir)
        for cfg in ("with_skill", "without_skill", "old_skill"):
            outdir = os.path.join(eval_dir, cfg, "outputs")
            if not os.path.isdir(outdir):
                continue
            grading = {"expectations": grade_run(eval_name, outdir)}
            gp = os.path.join(eval_dir, cfg, "grading.json")
            json.dump(grading, open(gp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
            passed = sum(1 for e in grading["expectations"] if e["passed"])
            print(f"{eval_name}/{cfg}: {passed}/{len(grading['expectations'])} 통과")


if __name__ == "__main__":
    main()
