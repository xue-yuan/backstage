"""Check static/locales/{en,zh-Hant}.json against the code that uses them.

    uv run --no-project tools/check_i18n.py

The front end, the server and the Mac app share the two files. It checks that every key the code
uses exists, that both files have the same keys and placeholders, that counted texts are used with
the counted call, and that no key is left unused. Exits with status 1 if anything is wrong.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
problems: list[str] = []


def report(msg: str) -> None:
    problems.append(msg)


def placeholders(value) -> set[str]:
    texts = value.values() if isinstance(value, dict) else [value]
    return {p for t in texts for p in re.findall(r"\{(\w+)\}", t)}


def compare_tables(part: str, en: dict, zh: dict) -> None:
    for key in en.keys() - zh.keys():
        report(f"{part}: {key} has no Chinese text")
    for key in zh.keys() - en.keys():
        report(f"{part}: {key} has no English text")
    for key in en.keys() & zh.keys():
        e, z = en[key], zh[key]
        if isinstance(e, dict) and set(e) - {"one", "other"} or isinstance(e, dict) and "other" not in e:
            report(f"{part}: {key} must have the forms one and other")
        if placeholders(z) - placeholders(e):
            report(f"{part}: {key} uses placeholders the English text does not have: {sorted(placeholders(z) - placeholders(e))}")
        other = e["other"] if isinstance(e, dict) else e
        if placeholders(other) - placeholders(z):
            report(f"{part}: {key} misses placeholders in Chinese: {sorted(placeholders(other) - placeholders(z))}")


LOCALES = ROOT / "static/locales"
EN = json.loads((LOCALES / "en.json").read_text(encoding="utf-8"))
ZH = json.loads((LOCALES / "zh-Hant.json").read_text(encoding="utf-8"))


# ---------- front end ----------


def js_strings(src: str) -> list[tuple[int, int, str]]:
    """(start, end, value) of every string literal, including those inside ${} of template literals."""
    out: list[tuple[int, int, str]] = []
    _scan(src, 0, out, nested=False)
    return out


def _scan(src: str, i: int, out: list, nested: bool) -> int:
    n, prev, depth = len(src), "", 0
    while i < n:
        c = src[i]
        if c in " \t\r\n":
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            i = src.find("*/", i) + 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            if nested and depth == 0:
                return i
            depth -= 1
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            out.append((i, j + 1, _decode(src[i + 1 : j])))
            i, prev = j + 1, "str"
            continue
        if c == "`":
            j, interp = i + 1, False
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src.startswith("${", j):
                    interp = True
                    j = _scan(src, j + 2, out, nested=True) + 1
                    continue
                if src[j] == "`":
                    break
                j += 1
            if not interp:
                out.append((i, j + 1, _decode(src[i + 1 : j])))
            i, prev = j + 1, "str"
            continue
        if c == "/" and (prev in set("(,=:[!&|?{};+-*%<>~^") or prev in ("return", "typeof", "")):
            j, in_class = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            i = j + 1
            while i < n and src[i].isalpha():
                i += 1
            prev = "regex"
            continue
        m = re.match(r"[A-Za-z_$][\w$]*", src[i : i + 64])
        if m:
            prev = m.group(0)
            i += len(prev)
            continue
        prev, i = c, i + 1
    return i


def _decode(raw: str) -> str:
    return re.sub(r"\\(u[0-9a-fA-F]{4}|.)", lambda m: chr(int(m.group(1)[1:], 16)) if m.group(1).startswith("u") else {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), raw)


def check_js() -> set[str]:
    """Report bad key uses in the front end; return every string literal in it."""
    js = ROOT / "static/js"
    en = EN
    literals: set[str] = set()
    for path in sorted(js.rglob("*.js")):
        if "locales" in path.parts:
            continue
        src = path.read_text()
        strings = js_strings(src)
        literals |= {v for _, _, v in strings}
        starts = {s: (e, v) for s, e, v in strings}
        rel = path.relative_to(ROOT)
        for m in re.finditer(r"(?<![\w$.])(_n|_|q|qe)\(", src):
            name = m.group(1)
            if name in ("q", "qe") and path.name != "guide.js":
                continue
            args, i, depth, cur = [], m.end(), 0, m.end()
            while i < len(src):  # top-level arguments of the call
                if i in starts:
                    i = starts[i][0]
                    continue
                ch = src[i]
                if ch in "([{":
                    depth += 1
                elif ch in ")]}":
                    if depth == 0:
                        args.append(src[cur:i].strip())
                        break
                    depth -= 1
                elif ch == "," and depth == 0:
                    args.append(src[cur:i].strip())
                    cur = i + 1
                i += 1
            pos = 1 if name == "_n" else 0
            if len(args) <= pos:
                continue
            arg_start = src.find(args[pos], m.end()) if args[pos] else -1
            if arg_start not in starts or starts[arg_start][0] - arg_start != len(args[pos]):
                continue  # not a literal key (a variable, or a comment that looks like a call)
            key = starts[arg_start][1]
            line = src.count("\n", 0, m.start()) + 1
            if key not in en:
                report(f"front end: {rel}:{line} uses unknown key {key!r}")
            elif name == "_n" and not isinstance(en[key], dict):
                report(f"front end: {rel}:{line} counts {key}, which has no one/other forms")
    return literals


# ---------- server ----------


def check_py() -> set[str]:
    """Report bad key uses in the server; return the keys it uses."""
    pkg = ROOT / "serato_crates"
    en = EN
    used: set[str] = set()
    for path in [ROOT / "app.py", *sorted(pkg.glob("*.py"))]:
        for node in ast.walk(ast.parse(path.read_text())):
            if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) in ("tr", "trn")):
                continue
            pos = 1 if node.func.id == "trn" else 0
            if len(node.args) <= pos or not (isinstance(node.args[pos], ast.Constant) and isinstance(node.args[pos].value, str)):
                continue
            key = node.args[pos].value
            used.add(key)
            where = f"{path.relative_to(ROOT)}:{node.lineno}"
            if key not in en:
                report(f"server: {where} uses unknown key {key!r}")
            elif node.func.id == "trn" and not isinstance(en[key], dict):
                report(f"server: {where} counts {key}, which has no one/other forms")
    return used


# ---------- Mac app ----------


def check_rs() -> set[str]:
    """Report bad key uses in the Mac app; return the keys it uses."""
    main = (ROOT / "src-tauri/src/main.rs").read_text()
    used = set(re.findall(r'"([a-z]+\.[A-Za-z0-9]+)"', main))
    for key in sorted(used - EN.keys()):
        if re.search(rf'\btr?\(\s*"{re.escape(key)}"', main) or re.search(rf'\(\s*"\w+",\s*"{re.escape(key)}"\s*\)', main):
            report(f"Mac app: main.rs uses unknown key {key!r}")
    return used & EN.keys()


def main() -> int:
    compare_tables("locales", EN, ZH)
    used = check_js() | check_py() | check_rs()
    for key in sorted(EN.keys() - used):
        report(f"locales: {key} is not used")
    for p in problems:
        print(p)
    print(f"{len(problems)} problem(s)" if problems else "Translations are consistent.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
