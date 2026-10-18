#!/usr/bin/env -S uv run
"""Inventory active decisions or retire explicitly selected notes after inbound references are repaired."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'redline'))
from graph import Graph, NOTE
from snapshot import Snapshot, git


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--delete', action='append', default=[], help='Exact active note path; repeatable')
    parser.add_argument('--apply', action='store_true', help='Delete the selected notes; default is a read-only plan')
    args = parser.parse_args()
    repo = Path(git(args.repo, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    snapshot = Snapshot(repo)
    graph = Graph(snapshot, snapshot.config())
    selected = set(args.delete)
    if not selected:
        print(json.dumps(dict(notes=[dict(path=n.path, decision=n.identity, code=n.code) for n in graph.notes.values()],
                              issues=graph.issues), ensure_ascii=False, indent=2))
        return 1 if graph.issues else 0
    if any(not NOTE.fullmatch(path) or path not in snapshot.modes for path in selected):
        raise ValueError('Only existing exact active note paths can be retired')
    inbound = []
    for path in snapshot.modes:
        if path in selected or not path.endswith(('.md', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.ts', '.tsx', '.js', '.mjs', '.go', '.py', '.rs')):
            continue
        text = snapshot.read(path)
        for target in selected:
            # Basenames also catch relative markdown links to the selected record
            if Path(target).name in text:
                inbound.append(dict(source=path, target=target))
    print(json.dumps(dict(delete=sorted(selected), inbound=inbound, apply=args.apply), ensure_ascii=False, indent=2))
    if inbound:
        print('Repair inbound references before deletion', file=sys.stderr)
        return 1
    if args.apply:
        for path in selected:
            target = repo / path
            if target.is_symlink() or not target.resolve().is_relative_to(repo):
                raise ValueError('Refusing symlink or out-of-repository deletion')
            target.unlink()
        print('Deleted; now run the diff gate to validate both sides of the retirement')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as exc:
        sys.exit(str(exc))
