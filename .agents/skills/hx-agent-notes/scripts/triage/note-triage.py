#!/usr/bin/env -S uv run
"""note-triage.py — 用 jev 概率模型给「这次改动该不该配 note」做一次**辅助**判断。

**它不是门禁。** 门禁是 verify-coverage.ts 的纯路径匹配 (改了 guarded 路径就要 note),
零歧义、可复现。本脚本只在写 note 之前给一个提示, 人(或 agent)自己决定要不要听。

为什么需要它: 纯路径门禁**宁可信其有**  prettier 重排版、改注释、重命名这些也落在
src/** 里, 会被要求配 note。本脚本的价值是在另一端往回收。

判据 (按"宁可信其无"= **倾向不要求 note**, 所以抬高"需要"的阈值):
    P >= 0.90  -> 建议配 note
    P <  0.90  -> 不要求 (灰区也放过)

阈值 0.90 来自 8 个真实案例的标定: 真改动 0.94/0.97, 非改动 0.08~0.15,
灰区 改默认值 0.88 / 改文案 0.56。取 0.90 时要求 2 个真改动、零漏判。
**取 0.95 会漏掉真改动** (实测 0.94 那个), 那已越过"信其无"变成"信其错"。

依赖定位 (无任何自动探测  见下文说明):
    1. 命令行 --client-dir / --accounts
    2. 环境变量 HX_JEV_CLIENT_DIR / HX_JEV_ACCOUNTS  (可 export, 也可写 .agents/env/.env)

用法:
    cp .agents/env/.env.example .agents/env/.env   # 首次: 填上本机路径
    uv run python note-triage.py --diff            # 读当前 git diff
    uv run python note-triage.py --state "<改动描述>"
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# 三种问法。**换 key 无效** (实测 8 个 key 标准差 0.005), 但换问法给出独立信号:
# 同一改动 direct 0.94 / strict 0.72 / reader 0.50  它们问的不是同一件事。
QUESTIONS = {
    "direct": "这个改动是否改变了代码行为、或引入了新的约束/默认值/契约/取舍?",
    "strict": "这个改动是否让某条已有约束失效、或新增了一条别人必须遵守的约束?",
    "reader": "半年后的读者看这段代码时, 是否会问: 为什么不用更简单的做法?",
}

THRESHOLD = 0.90

ENV_CLIENT_DIR = "HX_JEV_CLIENT_DIR"
ENV_ACCOUNTS = "HX_JEV_ACCOUNTS"
CLIENT_NAME = "typesafe_client.py"
ACCOUNTS_NAME = "accounts_1000.json"


# ── 依赖定位: 只认显式配置, 不做任何自动探测 ──────────────────────────
#
# 为什么删掉自动探测 (2026-09-25 实测): 探测的本质是**猜**, 而且失效时是**静默的** 
# 你只会看到一行"跳过", 分不清是"这台机器没配"还是"猜错了布局"。
# 它此前能命中纯属布局巧合, 本身不值得依赖, 却让"没配"看起来像"配了但坏了"。


def _script_root() -> Path:
    """Agent Notes
    .agents/notes/implemented/process/2026-10-08-repository-agent-notes-v2-adoption.md
    """
    return Path(__file__).resolve().parent


def _env_file() -> Path | None:
    """定位 ".agents/env/.env" (本机专属, 被 .agents/.gitignore 屏蔽)。

    模板是 ".agents/env/.env.example" (入库)。这个分工是有意的:
    依赖位置是**每台机器各不相同**的本地事实, 不该随仓库版本化。
    """
    here = _script_root()
    for _ in range(8):
        cand = here / ".agents" / "env" / ".env"
        if cand.is_file():
            return cand
        if (here / ".git").exists():
            break
        here = here.parent
    return None


def load_env_file() -> dict[str, str]:
    """读 .env (极简 KEY=VALUE, 不引额外依赖)。空值视为未设置。"""
    values: dict[str, str] = {}
    path = _env_file()
    if path is None:
        return values
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip(chr(34)).strip(chr(39))
            if key and val:
                values[key] = val
    except OSError:
        return {}
    return values


_ENV_FILE = load_env_file()


def env_get(key: str) -> str | None:
    """取配置: 进程环境变量优先, 其次 .agents/env/.env。"""
    return os.environ.get(key) or _ENV_FILE.get(key)


def find_client_dir(explicit: str | None = None) -> Path | None:
    """含 typesafe_client.py 的目录。只从显式配置取, 不猜。

    **显式参数优先于 .env/env**: 传了 --client-dir 就只看它, 不再回落到环境变量 
    否则"想临时指向别处"这个动作会静默失效 (实测踩过: 传了 --client-dir /nonexistent,
    仍被 .env 里的有效路径接管, 于是本该跳过却照常判断)。
    """
    cands = [explicit] if explicit is not None else [env_get(ENV_CLIENT_DIR)]
    for cand in cands:
        if not cand:
            continue
        p = Path(cand).expanduser()
        try:
            if (p / CLIENT_NAME).is_file():
                return p.resolve()
        except OSError:
            continue
    return None


def find_accounts(explicit: str | None = None, client_dir: Path | None = None) -> Path | None:
    """accounts json。同样: 显式参数优先, 不给才回落。"""
    cands = [explicit] if explicit is not None else [env_get(ENV_ACCOUNTS)]
    for cand in cands:
        if not cand:
            continue
        p = Path(cand).expanduser()
        try:
            if p.is_file():
                return p.resolve()
        except OSError:
            continue
    if client_dir is not None:
        p = client_dir / ACCOUNTS_NAME
        try:
            if p.is_file():
                return p.resolve()
        except OSError:
            pass
    return None


def load_key(explicit: str | None, accounts: Path | None) -> str | None:
    if explicit:
        return explicit
    if accounts is None:
        return None
    try:
        rows = json.loads(accounts.read_text(encoding="utf-8"))
    except Exception:
        return None
    for row in rows:
        if row.get("usable") and row.get("api_key"):
            return str(row["api_key"])
    return None


def diff_state(base: str, max_lines: int = 120) -> str:
    """把 diff 压成可判读的改动描述。

    **只给 --stat 是不够的** (实测): 模型的判断高度依赖"改了什么"的实质内容。
    同一个改动, 描述里带上"修复设置改了不生效"时 P=0.95, 去掉后掉到 0.87。
    """
    try:
        names = subprocess.run(
            ["git", "diff", "--name-only", base], capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        body = subprocess.run(
            ["git", "diff", "-U2", base], capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception:
        return ""
    if not names:
        return ""
    keep = []
    for line in body.split(chr(10)):
        if line.startswith(("diff --git", "+++", "---", "@@")) or line[:1] in ("+", "-"):
            keep.append(line)
        if len(keep) >= max_lines:
            break
    return "改动文件:" + chr(10) + names + chr(10) + chr(10) + "改动内容:" + chr(10) + chr(10).join(keep)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", help="改动描述 (人写的自然语言)")
    ap.add_argument("--diff", action="store_true", help="用 git diff 生成 state")
    ap.add_argument("--base", default="HEAD", help="--diff 的比较基准")
    ap.add_argument("--key", help="显式指定 API key")
    ap.add_argument("--client-dir", help="typesafe_client.py 所在目录 (或设 " + ENV_CLIENT_DIR + ")")
    ap.add_argument("--accounts", help="accounts json 路径 (或设 " + ENV_ACCOUNTS + ")")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--agg", choices=["any", "vote"], default="any",
                    help="any=任一问过阈值就建议; vote=>=2 问才建议 (会漏真改动)")
    a = ap.parse_args()

    state = a.state or ""
    if a.diff:
        state = (state + chr(10) + diff_state(a.base)).strip()
    if not state:
        print("需要 --state 或 --diff", file=sys.stderr)
        return 2

    client_dir = find_client_dir(a.client_dir)
    accounts = find_accounts(a.accounts, client_dir)
    key = load_key(a.key, accounts)

    if client_dir is None or key is None:
        # 缺依赖时不阻塞: 这是辅助, 不是门禁
        missing = []
        if client_dir is None:
            missing.append("客户端目录(" + CLIENT_NAME + ")")
        if key is None:
            missing.append("可用 key(" + ACCOUNTS_NAME + ")")
        print("note-triage: 缺 " + "、".join(missing) + ", 跳过 (辅助工具, 不阻塞)")
        print("  配置方式: cp .agents/env/.env.example .agents/env/.env 后填上本机路径,")
        print("            或用 --client-dir / --accounts, 或 export " + ENV_CLIENT_DIR)
        return 0

    sys.path.insert(0, str(client_dir))
    try:
        from typesafe_client import TypeSafe  # type: ignore

        ts = TypeSafe(key)
        probs = {}
        for name, q in QUESTIONS.items():
            prob, _ = ts.yes_no(state, q)
            probs[name] = prob
    except Exception as error:  # 网络/额度问题同样不阻塞
        print("note-triage: 调用失败, 跳过 (" + str(error)[:60] + ")")
        return 0

    hits = sum(1 for p in probs.values() if p >= THRESHOLD)
    need = hits >= 2 if a.agg == "vote" else hits >= 1
    verdict = "建议配 note" if need else "不要求 note"
    top = max(probs.values())

    if a.json:
        print(json.dumps({"probabilities": probs, "threshold": THRESHOLD,
                          "aggregate": a.agg, "hits": hits, "verdict": verdict},
                         ensure_ascii=False, indent=1))
    else:
        print("  ".join(k + "=" + format(v, ".2f") for k, v in probs.items()))
        print("  过阈值 " + str(hits) + "/3  (聚合=" + a.agg + ", 阈值 " + str(THRESHOLD) + ")  -> " + verdict)
        if not need and top > 0.5:
            print("  注意: 有问法落在灰区但没到阈值。按宁可信其无放过; 拿不准就交人。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
