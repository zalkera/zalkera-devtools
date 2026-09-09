#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doc/MANUAL.md 를 고객 배포용 PDF 로 굽는다.

    python3 scripts/manual-pdf.py [출력경로]

pandoc 을 쓰지 않는다 — 이 기계에 없다. 한글 PDF 는 /home/jonghwa/tools/ko_pdf.py 하나가 정본이다.

주의 둘(둘 다 밟아 본 자리):
  - **나눔고딕에 없는 글자는 네모(□)로 나간다.** 원문자·경고표·화살표가 그렇다 — CIRCLED 로 바꾼다.
  - **문단은 빈 줄까지 이어 붙인 뒤 정리한다.** 줄 단위로 처리하면 줄바꿈에 걸친 **강조**가 안 벗겨진다.
"""
import sys, re
sys.path.insert(0, "/home/jonghwa/tools")
from ko_pdf import Doc, REG as REG_PATH

import os
SRC = os.path.join(os.path.dirname(__file__), "..", "doc", "MANUAL.md")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/home/jonghwa/projects/zalkera/잘커라-확장-매뉴얼.pdf"

# 나눔고딕에 **글리프가 없는 글자**를 있는 것으로 바꾼다. 안 바꾸면 gid 0(.notdef)이 실려
# 고객 PDF 에 □ 로 나간다 — 화면에서는 멀쩡해 보이므로 눈으로는 안 잡힌다.
# 새 글자를 매뉴얼에 쓰기 전에 `Font(REG).gid(ch)` 로 물어라. 아래 CHECK 가 어차피 막는다.
CIRCLED = {"①":"1","②":"2","③":"3","④":"4","⑤":"5","⑥":"6","⑦":"7","⑧":"8","⑨":"9","⑩":"10",
           "⑪":"11","⑫":"12","«":"<","»":">","⚠":"[주의]","→":"->","←":"<-",
           "▾":"▼","✅":"[정상]","🔴":"[중요]"}

def glyphs(t):
    for a, b in CIRCLED.items():
        t = t.replace(a, b)
    return t


def assert_renderable(text):
    """치환 뒤에도 폰트에 없는 글자가 남아 있으면 **굽지 않고 죽는다**.

    ⚠ 이것은 문서 교열이 아니라 **산출물이 깨지는가**다. gid 0 은 고객이 받는 PDF 에 □ 로
      찍히고, 굽는 사람 화면에는 아무 표시도 안 난다 — 실제로 ✅·🔴 둘이 그렇게 나가고 있었다.
    """
    from ko_pdf import Font, BOLD
    missing = {}
    for f in (Font(REG_PATH), Font(BOLD)):
        for ch in set(text):
            if ch in "\n\r\t" or f.gid(ch):
                continue
            missing.setdefault(ch, text.count(ch))
    if missing:
        print("✗ 폰트에 없는 글자 %d 종 — 이대로 구우면 고객 PDF 에 □ 로 나갑니다." % len(missing))
        for ch, n in sorted(missing.items()):
            print("   %r U+%04X — 본문 %d회. scripts/manual-pdf.py 의 CIRCLED 에 바꿀 글자를 적으십시오." % (ch, ord(ch), n))
        sys.exit(1)

def clean(t):
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"`([^`]+)`", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    return glyphs(t).strip()

_source = open(SRC, encoding="utf-8").read()
assert_renderable(glyphs(_source))
lines = _source.split("\n")
d = Doc()
d.header_band("잘커라 확장 사용 매뉴얼", "Zalkera VS Code Extension", "소스를 받아 고치고, 미리 보고, 올립니다")
d.gap(18)

i, in_code, code, table = 0, False, [], []

def flush_table():
    global table
    if not table:
        return
    head, rows = table[0], table[1:]
    for r in rows:
        if len(r) >= 2:
            d.bullet(r[0] + "  →  " + "  ·  ".join(x for x in r[1:] if x))
    table = []

while i < len(lines):
    ln = lines[i]
    if ln.strip().startswith("```"):
        if in_code:
            d.box([(c, False) for c in code], bg=(0.96, 0.97, 0.98), size=9.5)
            d.gap(6); code = []
        in_code = not in_code
        i += 1; continue
    if in_code:
        code.append(glyphs(ln.rstrip())); i += 1; continue

    if ln.startswith("|"):
        cells = [clean(c) for c in ln.strip().strip("|").split("|")]
        if not all(set(c) <= set("-: ") for c in cells):
            table.append(cells)
        i += 1; continue
    flush_table()

    s = ln.strip()
    if not s:
        i += 1; continue
    if s.startswith("# "):
        i += 1; continue                      # 표지는 header_band 가 대신한다
    if s.startswith("## "):
        d.gap(8); d.h2(clean(s[3:])); i += 1; continue
    if s.startswith("### "):
        d.gap(4); d.para(clean(s[4:]), size=12.5, rgb=(0.11, 0.24, 0.45)); i += 1; continue
    if s.startswith("#### "):
        d.para(clean(s[5:]), size=11.5, rgb=(0.11, 0.24, 0.45)); i += 1; continue
    if s.startswith("> "):
        # ⚠ **이어 붙인 뒤에 clean 한다.** 줄마다 clean 하면 줄을 넘는 `**굵게**` 가 한쪽 `**` 만
        #   들고 있어 정규식이 안 물고, 그 별 두 개가 **고객 PDF 에 그대로 인쇄된다**(실측).
        buf = []
        while i < len(lines) and lines[i].strip().startswith(">"):
            buf.append(lines[i].strip().lstrip("> ").strip()); i += 1
        d.box([(clean(" ".join(x for x in buf if x)), False)], bg=(0.99, 0.96, 0.90))
        d.gap(6); continue
    if s.startswith("- ") or s.startswith("* "):
        d.bullet(clean(s[2:])); i += 1; continue
    if s == "---":
        d.gap(6); d.hr(); d.gap(6); i += 1; continue
    # 한 줄은 반드시 먹는다 — 첫 줄을 조건에 걸면 buf 가 비고 i 가 안 늘어 무한 루프다.
    buf = [lines[i].strip()]; i += 1
    while i < len(lines) and lines[i].strip() and not re.match(r"^(#|>|- |\* |\||```|---$)", lines[i].strip()):
        buf.append(lines[i].strip()); i += 1
    d.para(clean(" ".join(buf)))

flush_table()
d.render(OUT)
print("   생성:", OUT)
