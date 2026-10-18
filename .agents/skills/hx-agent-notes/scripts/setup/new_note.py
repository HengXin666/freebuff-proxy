#!/usr/bin/env -S uv run
"""Create a decision skeleton with exact representative code paths."""
import argparse
import datetime
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'redline'))
from snapshot import EXTENSIONS, canonical, git


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lifecycle', choices=['proposed', 'implemented', 'rejected'])
    parser.add_argument('kind', choices=['architecture', 'feature', 'bug-fix', 'simplification', 'process', 'testing'])
    parser.add_argument('slug')
    parser.add_argument('--code', action='append', required=True)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--title')
    parser.add_argument('--date', default=datetime.date.today().isoformat())
    args = parser.parse_args()
    repo = Path(git(args.repo, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    if not re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*', args.slug):
        parser.error('slug must use lowercase words joined by hyphens')
    datetime.date.fromisoformat(args.date)
    if not all(canonical(p) and Path(p).suffix in EXTENSIONS and (repo / p).is_file() for p in args.code):
        parser.error('--code must name existing exact repository-relative source files')
    if len({str(Path(p).parent) for p in args.code}) != len(args.code):
        parser.error('Choose one representative file per direct parent directory')
    path = repo / '.agents/notes' / args.lifecycle / args.kind / f'{args.date}-{args.slug}.md'
    if path.exists():
        parser.error('Note already exists; update its facts in place')
    template = (Path(__file__).resolve().parents[2] / 'templates' / f'{args.lifecycle}.md').read_text()
    content = template.replace('<title>', args.title or args.slug).replace('<decision-id>', args.slug)
    content = content.replace('- `<code-path>`', '\n'.join(f'- `{p}`' for p in args.code))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    print(path.relative_to(repo))
    print('Fill the rationale and add one AST-valid function anchor in each representative file')


if __name__ == '__main__':
    main()
