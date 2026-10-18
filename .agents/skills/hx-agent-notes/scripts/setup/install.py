#!/usr/bin/env -S uv run
"""Install a local redline entry, exact source policy, instructions and optional GitHub workflows."""
import argparse
import ast
import json
import shutil
import subprocess
from pathlib import Path

SKILL = Path(__file__).resolve().parents[2]
REL = '.agents/skills/hx-agent-notes'
BEGIN, END = '<!-- agent-notes:start -->', '<!-- agent-notes:end -->'


def write_once(path, content):
    if path.exists():
        if path.read_text() != content:
            raise ValueError(f'{path} already exists with different content; review and migrate it explicitly')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def write_wrapper(path, content):
    """Permit decision comments while rejecting executable wrapper changes."""
    if path.exists() and path.read_text() != content:
        if ast.dump(ast.parse(path.read_text())) != ast.dump(ast.parse(content)):
            raise ValueError(f'{path} has executable changes; review its migration explicitly')
        return
    write_once(path, content)


def install(args):
    """
    Install project entries that delegate to the vendored strict gate
    .agents/notes/implemented/process/2026-10-08-agent-notes-v2-migration-boundaries.md
    .agents/notes/implemented/process/2026-10-07-agent-notes-ast-redline.md
    """
    root = subprocess.check_output(['git', '-C', str(args.repo), 'rev-parse', '--show-toplevel'], text=True)
    repo = Path(root.strip()).resolve()
    import sys
    sys.path.insert(0, str(SKILL / 'scripts/redline'))
    from snapshot import canonical
    if not all(canonical(p) for p in args.guarded + [args.redline_dir]):
        raise ValueError('Use exact repository-relative files or directories, without globs or trailing slashes')
    if any(p != args.redline_dir and not ((repo / p).is_dir() or (repo / p).is_file()) for p in args.guarded):
        raise ValueError('Every guarded file or directory must already exist')
    target = repo / REL
    if target.resolve() != SKILL:
        if target.exists():
            for source in SKILL.rglob('*'):
                rel = source.relative_to(SKILL)
                if any(p in ('__pycache__', '.git', '.venv') for p in rel.parts) or not source.is_file():
                    continue
                installed = target / rel
                if not installed.is_file() or installed.read_bytes() != source.read_bytes():
                    raise ValueError(f'{installed} differs; review the vendored skill update before installing')
        else:
            shutil.copytree(SKILL, target, ignore=shutil.ignore_patterns('__pycache__', '.git', '.venv'))
    config = json.dumps(dict(version=2, guarded=sorted(set(args.guarded))), indent=2) + '\n'
    write_once(repo / '.agents/notes.config.json', config)
    entry = args.redline_dir + '/agent_notes.py'
    wrapper = '''#!/usr/bin/env -S uv run
"""Project Agent Notes redline entry; implementation lives in the vendored skill."""
import os
import subprocess
import sys
from pathlib import Path

repo = Path(subprocess.check_output(['git', '-C', str(Path(__file__).parent), 'rev-parse', '--show-toplevel'], text=True).strip())
gate = repo / '.agents/skills/hx-agent-notes/scripts/redline'
os.execvp('uv', ['uv', 'run', '--with-requirements', str(gate / 'requirements.txt'), 'python', str(gate / 'verify.py'), '--repo', str(repo), *sys.argv[1:]])
'''
    write_wrapper(repo / entry, wrapper)
    snippet = (SKILL / 'assets/AGENTS.snippet.md').read_text().replace('scripts/redlines/agent_notes.py', entry)
    agents = repo / 'AGENTS.md'
    content = agents.read_text() if agents.exists() else ''
    if (BEGIN in content) != (END in content):
        raise ValueError('Incomplete agent-notes marker block in AGENTS.md')
    if BEGIN in content:
        start, end = content.index(BEGIN), content.index(END) + len(END)
        content = content[:start] + BEGIN + '\n' + snippet.rstrip() + '\n' + END + content[end:]
    else:
        content = content.rstrip() + '\n\n' + BEGIN + '\n' + snippet.rstrip() + '\n' + END + '\n'
    agents.write_text(content.lstrip())
    write_once(repo / '.agents/notes/AGENTS.md', (SKILL / 'assets/notes-contract.md').read_text())
    package = repo / 'package.json'
    if package.exists():
        data = json.loads(package.read_text())
        scripts = data.setdefault('scripts', {})
        for key, flags in [('verify-notes', '--diff'), ('verify-notes:all', '--all'), ('verify-notes:staged', '--staged')]:
            desired = f'uv run {entry} {flags}'
            if key in scripts and scripts[key] != desired:
                raise ValueError(f'Existing npm script {key} differs; migrate it explicitly to {desired}')
            scripts[key] = desired
        package.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    if args.github:
        for source, name in [('github-actions.yml', 'agent-notes.yml'), ('github-full.yml', 'agent-notes-full.yml'),
                             ('github-report.yml', 'agent-notes-report.yml')]:
            workflow = (SKILL / 'assets/ci' / source).read_text()
            if source == 'github-full.yml':
                workflow = workflow.replace('branches: [main]', 'branches: ' + json.dumps([args.main_branch]))
            write_once(repo / '.github/workflows' / name, workflow)
    print(f'Installed {entry}; run uv run {entry} --all')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--guarded', action='append', required=True, help='Exact protected file or directory, repeatable')
    parser.add_argument('--redline-dir', default='scripts/redlines')
    parser.add_argument('--github', action='store_true')
    parser.add_argument('--main-branch', default='main', help='Default branch for the full-scan push trigger')
    args = parser.parse_args()
    try:
        install(args)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(2, str(exc) + '\n')


if __name__ == '__main__':
    main()
