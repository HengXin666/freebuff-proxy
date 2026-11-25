#!/usr/bin/env python3
# hx-governance: managed v1 (由 HX-Workflows 仓库治理生成, 删掉这一行后不再自动覆盖)
"""提交规范检查, CI 与本地 commit-msg 钩子共用同一份脚本, 只依赖 Python 标准库.

用法:
  python3 .github/scripts/commit_lint.py ci                # GitHub Actions 里运行
  python3 .github/scripts/commit_lint.py hook <消息文件>    # commit-msg 钩子
  python3 .github/scripts/commit_lint.py check "<标题>"     # 手动检查一行

规则写在 .github/commit-convention.yml.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_PATH = ".github/commit-convention.yml"
COMMENT_MARKER = "<!-- hx-governance:commit-lint -->"
ZERO_SHA = "0" * 40

CONVENTIONAL = re.compile(
    r"^(?P<type>[A-Za-z]+)(?:\((?P<scope>[^()\s][^()]*)\))?(?P<breaking>!)?: (?P<subject>\S.*)$"
)
BRACKET = re.compile(
    r"^\[(?P<type>[A-Za-z]+)(?:\((?P<scope>[^()\s][^()]*)\))?\](?P<breaking>!)?(?:: ?| )(?P<subject>\S.*)$"
)
# Looser shapes, only used to recognise a style while sampling history and to rescue a title.
LOOSE_CONVENTIONAL = re.compile(r"^(?P<type>[A-Za-z]+)(?:\((?P<scope>[^()]*)\))?!?\s*[:：]\s*(?P<subject>.*)$")
LOOSE_BRACKET = re.compile(r"^[\[【](?P<type>[A-Za-z]+)(?:\((?P<scope>[^()]*)\))?[\]】]!?\s*[:：]?\s*(?P<subject>.*)$")
IGNORED = re.compile(
    r"^(Merge (pull request|branch|remote-tracking branch|tag|commit|.+ into )|Revert \"|Initial commit$|"
    r"(fixup|squash|amend)! )"
)

KNOWN_TYPES = {
    "feat", "feature", "fix", "bugfix", "hotfix", "docs", "doc", "style", "refactor", "perf",
    "test", "tests", "build", "ci", "chore", "revert", "release", "deps", "wip",
}
SYNONYMS = {
    "feature": "feat", "add": "feat", "bugfix": "fix", "hotfix": "fix", "bug": "fix", "doc": "docs",
    "tests": "test", "deps": "build", "release": "chore", "wip": "chore", "update": "chore",
}
KEYWORDS = (
    ("fix", ("fix", "bug", "修复", "修正", "解决", "错误", "崩溃", "hotfix")),
    ("docs", ("doc", "readme", "文档", "注释", "说明")),
    ("perf", ("perf", "性能", "提速", "加速")),
    ("refactor", ("refactor", "重构", "整理", "拆分")),
    ("test", ("test", "测试", "用例")),
    ("ci", ("ci", "workflow", "action", "流水线", "工作流")),
    ("build", ("build", "deps", "依赖", "构建", "升级")),
    ("feat", ("feat", "add", "support", "新增", "添加", "支持", "实现", "增加")),
)
STYLE_EXAMPLE = {
    "conventional": "type(scope): 描述, 例如 `fix(login): 修复登录按钮无响应`",
    "bracket": "[type]: 描述 (冒号可省), 例如 `[fix]: 修复登录按钮无响应`",
}


@dataclass
class Convention:
    style: str = "conventional"
    types: tuple[str, ...] = ("feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert")
    max_header_length: int = 72
    baseline: str = ""
    pr_commits: str = "warn"
    skip_bot_commits: bool = True


@dataclass
class StyleStats:
    total: int = 0
    conventional: int = 0
    bracket: int = 0
    other: int = 0
    ignored: int = 0
    dominant: str = "none"
    samples: dict[str, list[str]] = field(default_factory=dict)


def parse_convention(text: str) -> Convention:
    data: dict[str, object] = {}
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if not line.strip() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            data[key.strip()] = [_unquote(part) for part in value[1:-1].split(",") if part.strip()]
        else:
            data[key.strip()] = _unquote(value)
    convention = Convention()
    style = str(data.get("style") or convention.style)
    if style not in STYLE_EXAMPLE:
        raise ValueError(f"style 只能是 conventional 或 bracket, 现在是 {style}")
    types = data.get("types")
    length = str(data.get("max_header_length") or convention.max_header_length)
    if not length.isdecimal():
        raise ValueError("max_header_length 必须是正整数")
    pr_commits = str(data.get("pr_commits") or convention.pr_commits)
    if pr_commits not in {"warn", "error", "off"}:
        raise ValueError("pr_commits 只能是 warn / error / off")
    return Convention(
        style=style,
        types=tuple(types) if isinstance(types, list) and types else convention.types,
        max_header_length=int(length),
        baseline=str(data.get("baseline") or ""),
        pr_commits=pr_commits,
        skip_bot_commits=str(data.get("skip_bot_commits", "true")).lower() != "false",
    )


def _unquote(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    return text


def header_of(message: str) -> str:
    for line in message.splitlines():
        if line.startswith("#"):
            continue
        if line.strip():
            return line.rstrip()
    return ""


def is_ignored(header: str) -> bool:
    return bool(IGNORED.match(header))


def classify(header: str) -> str:
    """Return conventional / bracket / other / ignored for one commit headline."""
    if not header or is_ignored(header):
        return "ignored"
    loose = LOOSE_BRACKET.match(header)
    if loose and loose.group("type").lower() in KNOWN_TYPES and loose.group("subject").strip():
        return "bracket"
    loose = LOOSE_CONVENTIONAL.match(header)
    if loose and loose.group("type").lower() in KNOWN_TYPES and loose.group("subject").strip():
        return "conventional"
    return "other"


def detect_style(headers: list[str], min_share: float = 0.3, min_count: int = 1) -> StyleStats:
    stats = StyleStats(samples={"conventional": [], "bracket": [], "other": []})
    for header in headers:
        kind = classify(header)
        if kind == "ignored":
            stats.ignored += 1
            continue
        stats.total += 1
        setattr(stats, kind, getattr(stats, kind) + 1)
        if len(stats.samples[kind]) < 3:
            stats.samples[kind].append(header)
    best = max(("conventional", "bracket"), key=lambda name: (getattr(stats, name), name == "conventional"))
    count = getattr(stats, best)
    if stats.total and count >= min_count and count >= stats.total * min_share:
        stats.dominant = best
    return stats


def validate(header: str, convention: Convention) -> list[str]:
    if not header.strip():
        return ["提交信息为空"]
    if is_ignored(header):
        return []
    pattern = CONVENTIONAL if convention.style == "conventional" else BRACKET
    match = pattern.match(header)
    errors: list[str] = []
    if match is None:
        errors.append(f"格式应为 {STYLE_EXAMPLE[convention.style]}")
    elif match.group("type") not in convention.types:
        errors.append(f"类型 `{match.group('type')}` 不在允许列表里: {', '.join(convention.types)}")
    if len(header) > convention.max_header_length:
        errors.append(f"标题行 {len(header)} 个字符, 超过 {convention.max_header_length}")
    return errors


def _type_for(word: str, convention: Convention) -> str | None:
    lowered = word.lower()
    if lowered in convention.types:
        return lowered
    mapped = SYNONYMS.get(lowered)
    if mapped in convention.types:
        return mapped
    return None


def _guess_type(text: str, convention: Convention) -> str:
    lowered = text.lower()
    for name, words in KEYWORDS:
        if name in convention.types and any(word in lowered for word in words):
            return name
    return "chore" if "chore" in convention.types else convention.types[0]


def format_header(kind: str, scope: str, subject: str, convention: Convention) -> str:
    scope_text = f"({scope})" if scope else ""
    if convention.style == "bracket":
        prefix = f"[{kind}{scope_text}]: "
    else:
        prefix = f"{kind}{scope_text}: "
    room = max(convention.max_header_length - len(prefix), 8)
    return prefix + subject[:room].rstrip()


def suggest(title: str, convention: Convention, branch: str = "") -> str:
    """Rewrite a title into the configured style, keeping its words."""
    text = " ".join(title.split())
    kind: str | None = None
    scope = ""
    subject = text
    for pattern in (BRACKET, CONVENTIONAL, LOOSE_BRACKET, LOOSE_CONVENTIONAL):
        match = pattern.match(text)
        if match is None:
            continue
        mapped = _type_for(match.group("type"), convention)
        if mapped is None and match.group("type").lower() not in KNOWN_TYPES:
            continue
        kind = mapped
        scope = (match.group("scope") or "").strip()
        subject = match.group("subject").strip()
        break
    if kind is None:
        head = branch.split("/", 1)[0] if "/" in branch else ""
        kind = _type_for(head, convention) or _guess_type(subject + " " + branch, convention)
    subject = subject.rstrip("。.") or "补充描述"
    return format_header(kind, scope, subject, convention)


# ---------------------------------------------------------------- git and GitHub helpers


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def _exists(sha: str) -> bool:
    if not sha or sha == ZERO_SHA:
        return False
    return subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True, check=False).returncode == 0


@dataclass
class Commit:
    sha: str
    author: str
    email: str
    header: str


def list_commits(include: str, exclude: list[str], limit: int = 500) -> list[Commit]:
    args = ["log", f"--max-count={limit}", "--format=%H%x1f%an%x1f%ae%x1f%B%x1e", include]
    args += [f"^{sha}" for sha in exclude if _exists(sha)]
    found: list[Commit] = []
    for record in _git(*args).split("\x1e"):
        parts = record.strip("\n").split("\x1f")
        if len(parts) != 4:
            continue
        found.append(Commit(parts[0], parts[1], parts[2], header_of(parts[3])))
    return found


def is_bot(commit: Commit) -> bool:
    return commit.author.endswith("[bot]") or "[bot]@" in commit.email


def _api(method: str, path: str, body: dict | None = None) -> object:
    token = os.environ.get("GITHUB_TOKEN", "")
    base = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(base + path, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def sync_title_comment(repo: str, number: int, title: str, errors: list[str], suggestion: str) -> str:
    """Post, refresh or delete the single bot comment that proposes a valid PR title."""
    try:
        comments = _api("GET", f"/repos/{repo}/issues/{number}/comments?per_page=100") or []
        mine = [item for item in comments if COMMENT_MARKER in str(item.get("body") or "")]
        if not errors:
            for item in mine:
                _api("DELETE", f"/repos/{repo}/issues/comments/{item['id']}")
            return ""
        body = "\n".join(
            [
                COMMENT_MARKER,
                "### PR 标题不符合提交规范",
                "",
                f"当前标题: `{title}`",
                "",
                *[f"- {error}" for error in errors],
                "",
                "建议改成:",
                "",
                "```text",
                suggestion,
                "```",
                "",
                "合并方式是 squash, PR 标题会成为默认分支上的提交信息. 改好标题后检查会自动重跑, 这条评论会被删掉.",
            ]
        )
        if mine:
            _api("PATCH", f"/repos/{repo}/issues/comments/{mine[0]['id']}", {"body": body})
        else:
            _api("POST", f"/repos/{repo}/issues/{number}/comments", {"body": body})
        return ""
    except (urllib.error.URLError, OSError, KeyError, ValueError) as error:
        return f"无法写入建议标题评论 (来自 fork 的 PR 只有只读令牌): {error}"


def _summary(lines: list[str]) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    text = "\n".join(lines) + "\n"
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text)
    print(text)


def _commit_rows(commits: list[Commit], convention: Convention) -> tuple[list[str], int]:
    rows: list[str] = []
    bad = 0
    for commit in commits:
        if convention.skip_bot_commits and is_bot(commit):
            continue
        errors = validate(commit.header, convention)
        if errors:
            bad += 1
            safe = commit.header.replace("|", "\\|")
            rows.append(f"| `{commit.sha[:8]}` | {safe} | {'; '.join(errors)} |")
    return rows, bad


def run_ci(convention: Convention) -> int:
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    event = json.loads(Path(event_path).read_text(encoding="utf-8")) if event_path else {}
    lines = [f"## 提交规范检查 ({convention.style})", ""]
    failed = False
    if event_name in {"pull_request", "pull_request_target"}:
        pull = event.get("pull_request") or {}
        title = str(pull.get("title") or "")
        errors = validate(title, convention)
        suggestion = suggest(title, convention, str((pull.get("head") or {}).get("ref") or "")) if errors else ""
        if errors:
            failed = True
            lines += [f"❌ PR 标题 `{title}` 不符合规范:", *[f"- {error}" for error in errors], "", f"建议: `{suggestion}`", ""]
        else:
            lines += [f"✅ PR 标题 `{title}` 符合规范. squash 合并后它就是提交信息.", ""]
        repo = os.environ.get("GITHUB_REPOSITORY", "")
        number = int(pull.get("number") or 0)
        if repo and number:
            warning = sync_title_comment(repo, number, title, errors, suggestion)
            if warning:
                lines += [f"⚠️ {warning}", ""]
        if convention.pr_commits != "off":
            base = str((pull.get("base") or {}).get("sha") or "")
            head = str((pull.get("head") or {}).get("sha") or "HEAD")
            rows, bad = _commit_rows(list_commits(head, [base, convention.baseline]), convention)
            if bad:
                level = "❌" if convention.pr_commits == "error" else "⚠️"
                lines += [
                    f"{level} PR 里有 {bad} 个提交不符合规范. squash 合并只保留 PR 标题, 这些提交不会进入默认分支.",
                    "",
                    "| 提交 | 标题 | 问题 |",
                    "| --- | --- | --- |",
                    *rows,
                    "",
                ]
                failed = failed or convention.pr_commits == "error"
    elif event_name == "push":
        before = str(event.get("before") or "")
        after = str(event.get("after") or "HEAD")
        if convention.baseline and not _exists(convention.baseline):
            lines += [f"⚠️ 基线提交 `{convention.baseline[:8]}` 不在历史里, 只检查这次推送的提交.", ""]
        commits = list_commits(after, [before, convention.baseline])
        rows, bad = _commit_rows(commits, convention)
        if bad:
            failed = True
            lines += [
                f"❌ 这次推送有 {bad} 个提交不符合规范. 推送已经发生, 这里只能报告:",
                "",
                "| 提交 | 标题 | 问题 |",
                "| --- | --- | --- |",
                *rows,
                "",
            ]
        else:
            lines += [f"✅ 检查了基线之后的 {len(commits)} 个提交, 全部符合规范.", ""]
    else:
        lines += [f"事件 {event_name or '未知'} 不需要检查.", ""]
    _summary(lines)
    return 1 if failed else 0


def run_hook(message_file: str, convention: Convention) -> int:
    message = Path(message_file).read_text(encoding="utf-8", errors="replace")
    header = header_of(message)
    errors = validate(header, convention)
    if not errors:
        return 0
    print("提交信息不符合规范:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    print(f"建议: {suggest(header, convention)}", file=sys.stderr)
    print("确实要跳过时用 git commit --no-verify.", file=sys.stderr)
    return 1


def _load(root: Path) -> Convention:
    path = root / CONFIG_PATH
    if not path.exists():
        return Convention()
    return parse_convention(path.read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in {"ci", "hook", "check"}:
        print(__doc__)
        return 2
    try:
        root = Path(_git("rev-parse", "--show-toplevel").strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        root = Path.cwd()
    convention = _load(root)
    if argv[0] == "ci":
        return run_ci(convention)
    if len(argv) < 2:
        print(__doc__)
        return 2
    if argv[0] == "hook":
        return run_hook(argv[1], convention)
    errors = validate(argv[1], convention)
    for error in errors:
        print(f"- {error}")
    if errors:
        print(f"建议: {suggest(argv[1], convention)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
