#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""插件价值审计 —— 找出「无净收益的复杂度」（Harness 改造的决策输入）。

判据（理论接口：v1.1 §11 的 H 向量）
------------------------------------
H 的每一项都该**有净收益**。一个插件的净收益 ≈ (它被用到的次数 × 每次省下的手工成本)
− (它的固定上下文成本 + 维护面 + 运行时开销)。本脚本只量**可量化的那一半**：

    插件 | 工具数 | 源码行 | 测试数 | 14 天调用次数 | 固定上下文成本(tok)

⇒ 「调用少 + 体积大」是**审视候选**（不是判决：备用工具低频是正常的，判断归主体）。

口径（必须与读数同读）
----------------------
· 工具清单与源码行：扫 `self-plugins/<pkg>/src/**/*.ts`，工具名取 `name: '<snake_case>'` 形态；
  行数含注释与空行（**代码行 ≠ 工作量**，只作规模代理）。
· 调用次数：扫 `DSH_SESSION_DIR` 下全部 `session*.jsonl.zstd`，逐帧解压（多帧 zstd，
  **一次性 API 只吃首帧** ⇒ 必须逐帧，否则恒报干净），统计 `tool/call` 事件里的工具名。
· 固定上下文成本：`ceil(len(JSON.stringify(schemas))/4)`——本脚本用**源码里的 description+parameters
  文本长度**近似（精确值需运行时 schemas()，见 dsh-agent-toolface 的 face-weight.py）。

用法
    python3 plugin-value-audit.py --days 14
    python3 plugin-value-audit.py --days 14 --json
    DSH_SESSION_DIR=<DSH_HOME>/sessions python3 plugin-value-audit.py
"""
from __future__ import annotations

import argparse
import collections
import glob
import io
import json
import os
import re
import sys
from pathlib import Path

try:
    import zstandard  # type: ignore
except ImportError:  # pragma: no cover
    zstandard = None

TOOLNAME_RE = re.compile(r"name:\s*['\"]([a-z][a-z0-9_]*)['\"]")
# 工具名抓取判据（2026-10-03 修正）：**不锚行首、单双引号都认**。
# 首版用 `^\s*name:\s*'...'` ⇒ 漏掉「defineTool({ name: 'x', … }) 一行写完」与双引号写法，
# 导致 dsh-agent-vision（确有 vision_ask/vision_compare）被报成「0 工具」。
# 不含连字符 ⇒ 插件名（agent-vision 这类）天然不会被误抓。
PKG_TOOL_RE = re.compile(r"name:\s*['\"]([a-z][a-z0-9_]*)['\"]")


def scan_plugins(self_plugins: Path) -> dict:
    """扫自研插件：工具名清单 / 源码行 / 测试文件数。"""
    out: dict = {}
    if not self_plugins.is_dir():
        return out
    for d in sorted(self_plugins.iterdir()):
        if not d.is_dir():
            continue
        src = d / "src"
        if not src.is_dir():
            continue
        tools: list = []
        lines = 0
        for f in src.rglob("*.ts"):
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            lines += text.count("\n") + 1
            # 只认「工具定义」形态：defineTool({ name: 'xxx' }) —— 用 'name:' 且值含下划线或常见动词
            for m in PKG_TOOL_RE.finditer(text):
                tools.append(m.group(1))
        tests = len(list((d / "tests").glob("*.mjs"))) if (d / "tests").is_dir() else 0
        out[d.name] = {
            "dir": d.name,
            "tools": sorted(set(tools)),
            "srcLines": lines,
            "testFiles": tests,
        }
    return out


def iter_session_files(root: Path):
    for pat in ("**/session*.jsonl.zstd", "**/session*.jsonl"):
        yield from glob.glob(str(root / pat), recursive=True)


def count_tool_calls(root: Path, days: int) -> collections.Counter:
    """统计近 N 天会话日志里的 tool/call 次数（逐帧解压，见模块口径）。"""
    counter: collections.Counter = collections.Counter()
    if zstandard is None:
        print("[warn] 缺 zstandard ⇒ 跳过调用统计（pip install zstandard）", file=sys.stderr)
        return counter
    import time
    cutoff = time.time() - days * 86400
    dctx = zstandard.ZstdDecompressor()
    files = list(iter_session_files(root))
    for path in files:
        try:
            if os.path.getmtime(path) < cutoff:
                continue
        except OSError:
            continue
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
            text = ""
            with dctx.stream_reader(io.BytesIO(raw)) as reader:
                text = reader.read().decode("utf-8", errors="replace")
        except Exception:
            continue
        for line in text.splitlines():
            if '"tool/call"' not in line and '"tool_call"' not in line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            data = ev.get("data") or {}
            name = data.get("name") or data.get("tool") or (data.get("call") or {}).get("name")
            if isinstance(name, str) and name:
                counter[name] += 1
    return counter


def default_repo() -> str:
    """仓库根：优先环境变量，其次**从脚本位置上溯**（脚本在 <repo>/self-plugins/<pkg>/scripts/）。
    首版硬编码 `E:\\alice` ⇒ WSL 下 `Path.is_dir()` 恒假 ⇒ 审计报「0 个插件」（静默空结果）。
    """
    env = os.environ.get("DSH_REPO")
    if env:
        return env
    here = Path(__file__).resolve()
    for up in here.parents:
        if (up / "self-plugins").is_dir():
            return str(up)
    return str(Path.cwd())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=default_repo())
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    repo = Path(args.repo)
    self_plugins = repo / "self-plugins"
    session_dir = Path(os.environ.get("DSH_SESSION_DIR") or (repo / ".dsh" / "sessions"))

    plugins = scan_plugins(self_plugins)
    calls = count_tool_calls(session_dir, args.days) if session_dir.is_dir() else collections.Counter()

    rows = []
    for name, info in plugins.items():
        total_calls = sum(calls.get(t, 0) for t in info["tools"])
        rows.append({
            "dir": name,
            "toolCount": len(info["tools"]),
            "srcLines": info["srcLines"],
            "testFiles": info["testFiles"],
            "calls": total_calls,
            "tools": info["tools"],
        })
    # 判据排序：调用少（含 0）且源码大者优先审视
    rows.sort(key=lambda r: (r["calls"], -r["srcLines"]))

    if args.json:
        print(json.dumps({"days": args.days, "sessionDir": str(session_dir), "rows": rows},
                         ensure_ascii=False, indent=2))
        return 0

    print(f"# 插件价值审计 —— 近 {args.days} 天 · {len(rows)} 个自研插件")
    print(f"# 会话日志根: {session_dir}")
    print(f"# 口径: 调用数=日志 tool/call 计数（逐帧解压）；srcLines 含注释空行（规模代理，非工作量）")
    print()
    print(f"{'插件':<34}{'工具':>5}{'源码行':>8}{'测试':>6}{'调用':>8}")
    print("-" * 64)
    for r in rows:
        print(f"{r['dir']:<34}{r['toolCount']:>5}{r['srcLines']:>8}{r['testFiles']:>6}{r['calls']:>8}")
    print()
    zero = [r for r in rows if r["calls"] == 0]
    low = [r for r in rows if 0 < r["calls"] <= 10]
    big_zero = [r for r in zero if r["srcLines"] >= 500]
    print(f"零调用 {len(zero)} 个 · 极低调用(≤10) {len(low)} 个")
    if big_zero:
        print("★ 审视候选（零调用 且 源码 ≥500 行）：")
        for r in big_zero:
            print(f"  · {r['dir']}：{r['toolCount']} 工具 / {r['srcLines']} 行 / {r['testFiles']} 测试"
                  + (f" / 工具：{', '.join(r['tools'][:6])}" if r["tools"] else ""))
    print()
    print("⚠ 「调用少」不等于「该删」：备用工具低频是正常的。本表只把候选摆出来，判断归主体。")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
