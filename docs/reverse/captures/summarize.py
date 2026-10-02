#!/usr/bin/env python3
"""从归档的抓包 JSONL 生成可读摘要，便于持续复盘。

用法：
  python3 docs/reverse/captures/summarize.py [输入.jsonl] [输出.md]

输出：按请求顺序的关键信息（方法/路径/状态/头部/体结构），
并对 chat/completions 做深度解析（tools / metadata / messages）。
"""
import json
import sys
from pathlib import Path

SRC = sys.argv[1] if len(sys.argv) > 1 else (
    Path(__file__).parent / '2026-10-03-official-client.jsonl'
)
DST = sys.argv[2] if len(sys.argv) > 2 else (
    Path(__file__).parent / 'CAPTURE-SUMMARY.md'
)

CHAT = '/api/v1/chat/completions'


def brief(v, n=90):
    s = str(v)
    return s[:n] + ('…' if len(s) > n else '')


def main():
    lines = []
    n_chat = 0
    for i, raw in enumerate(open(SRC, encoding='utf-8')):
        try:
            r = json.loads(raw)
        except Exception:
            continue
        path = r.get('path', '')
        method = r.get('method', '')
        status = r.get('status')
        body = r.get('req_body') or ''

        if CHAT in path and body:
            n_chat += 1
            try:
                j = json.loads(body)
            except Exception:
                continue
            tools = [(t.get('function') or {}).get('name')
                     for t in (j.get('tools') or [])]
            meta = j.get('codebuff_metadata') or {}
            lines.append(f'\n### [{i}] {method} {path} → {status}  ({len(body)} B)')
            lines.append(f'- **layer**: {"manager(decide)" if tools == ["decide"] else "worker(37 tools)"}')
            lines.append(f'- model: `{brief(j.get("model"), 50)}`')
            lines.append(f'- stream: `{j.get("stream")}` | tool_choice: `{json.dumps(j.get("tool_choice"))}`')
            lines.append(f'- provider: `{json.dumps(j.get("provider"), ensure_ascii=False)}`')
            lines.append(f'- tools ({len(tools)}): {", ".join(str(t) for t in tools[:40])}')
            lines.append('- metadata 键: ' + ', '.join(sorted(meta.keys())))
            if 'freebuff_reasoning_effort' in meta:
                lines.append(f'- **reasoning_effort**: `{meta["freebuff_reasoning_effort"]}`')
            msgs = j.get('messages') or []
            lines.append(f'- messages ({len(msgs)}): ' + ', '.join(
                f'{m.get("role")}' for m in msgs[:30]))
            if msgs and msgs[0].get('role') == 'system':
                s0 = msgs[0].get('content') or ''
                lines.append(f'- system 首 120 字符: `{brief(s0, 120)}`')
        else:
            lines.append(f'- [{i}] {method} {path} → {status}'
                         + (f'  (body {len(body)} B)' if body else ''))

    out = [
        '# 抓包摘要（自动生成，勿手改）',
        '',
        f'源: `{Path(SRC).name}`  ',
        f'chat/completions 样本数: **{n_chat}**',
        '',
        '## 全部请求（按序）',
        '',
    ] + lines
    Path(DST).write_text('\n'.join(out) + '\n', encoding='utf-8')
    print(f'wrote {DST} ({len(out)} lines), chat samples={n_chat}')


if __name__ == '__main__':
    main()
