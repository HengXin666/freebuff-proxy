#!/usr/bin/env python3
"""把我们的请求 dump 与官方抓包做逐字段 diff（离线，零额度消耗）。

用法：
  python3 tools/diff-request.py <我们的 dump 目录> [抓包 jsonl]

对比维度：
  - chat 头部：缺失 / 多余 / 取值不同
  - 请求体顶层字段
  - codebuff_metadata 键集合
  - tools 名字集合
  - system 首 120 字符
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DUMP = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/dumpB')
CAP = Path(sys.argv[2]) if len(sys.argv) > 2 else (
    ROOT / 'docs/reverse/captures/2026-10-03-official-client.jsonl'
)

# 官方 chat 里属于传输层、由 HTTP 栈自动加的头，对比时忽略
IGNORE = {'host', 'content-length', 'connection', 'accept-encoding'}


def load_official_chat():
    for raw in open(CAP, encoding='utf-8'):
        try:
            r = json.loads(raw)
        except Exception:
            continue
        if '/api/v1/chat/completions' not in r.get('path', ''):
            continue
        b = r.get('req_body')
        if not b:
            continue
        try:
            j = json.loads(b)
        except Exception:
            continue
        if len(j.get('tools') or []) > 1:   # worker 层
            return r, j
    return None, None


def main():
    off_req, off_body = load_official_chat()
    if not off_body:
        print('官方 worker 层样本未找到'); return 1

    mine_file = sorted(DUMP.glob('*chat*.json'))
    if not mine_file:
        print('我们的 chat dump 未找到:', DUMP); return 1
    mine = json.loads(mine_file[-1].read_text(encoding='utf-8'))
    my_headers = {k.lower(): v for k, v in mine.get('headers', {}).items()}
    try:
        my_body = json.loads(mine.get('bodyUtf8') or '{}')
    except Exception:
        my_body = {}

    off_headers = {k.lower(): v for k, v in off_req['req_headers'].items()}

    print('=' * 60)
    print('HEADERS')
    print('=' * 60)
    for k in sorted(set(off_headers) | set(my_headers)):
        if k in IGNORE:
            continue
        o, m = off_headers.get(k), my_headers.get(k)
        if o is not None and m is None:
            print(f'  ❌ 缺失: {k} = {str(o)[:70]}')
        elif o is None and m is not None:
            print(f'  ⚠️ 多余: {k} = {str(m)[:70]}')
        elif o != m:
            print(f'  🔶 不同: {k}\n       官方: {str(o)[:90]}\n       我们: {str(m)[:90]}')

    print()
    print('=' * 60)
    print('BODY 顶层字段')
    print('=' * 60)
    ok, mk = set(off_body), set(my_body)
    for k in sorted(ok - mk):
        print(f'  ❌ 缺失: {k} = {str(off_body[k])[:70]}')
    for k in sorted(mk - ok):
        print(f'  ⚠️ 多余: {k} = {str(my_body[k])[:70]}')
    print('  一致:', sorted(ok & mk))

    print()
    print('=' * 60)
    print('codebuff_metadata')
    print('=' * 60)
    om, mm = off_body.get('codebuff_metadata') or {}, my_body.get('codebuff_metadata') or {}
    for k in sorted(set(om) - set(mm)):
        print(f'  ❌ 缺失: {k} = {str(om[k])[:70]}')
    for k in sorted(set(mm) - set(om)):
        print(f'  ⚠️ 多余: {k} = {str(mm[k])[:70]}')
    print('  一致:', sorted(set(om) & set(mm)))

    print()
    print('=' * 60)
    print('tools')
    print('=' * 60)
    ot = [(t.get('function') or {}).get('name') for t in (off_body.get('tools') or [])]
    mt = [(t.get('function') or {}).get('name') for t in (my_body.get('tools') or [])]
    print(f'  官方 {len(ot)} 个: {", ".join(str(x) for x in ot[:40])}')
    print(f'  我们 {len(mt)} 个: {", ".join(str(x) for x in mt[:40])}')
    print('  官方独有:', sorted(set(ot) - set(mt)))
    print('  我们独有:', sorted(set(mt) - set(ot)))

    print()
    print('=' * 60)
    print('system')
    print('=' * 60)
    osys = (off_body.get('messages') or [{}])[0].get('content') or ''
    mysys = (my_body.get('messages') or [{}])[0].get('content') or ''
    print(f'  官方 len={len(osys)}: {osys[:110]}')
    print(f'  我们 len={len(mysys)}: {mysys[:110]}')
    print('  首句一致:', osys[:60] == mysys[:60])
    return 0


if __name__ == '__main__':
    sys.exit(main())
