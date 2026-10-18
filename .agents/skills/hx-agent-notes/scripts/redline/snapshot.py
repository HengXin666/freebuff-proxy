"""Read exact Git trees, the index, or the working directory without changing checkout."""
import json
import re
import subprocess
from pathlib import Path, PurePosixPath

EXTENSIONS = {'.cpp', '.cc', '.cxx', '.h', '.hpp', '.ts', '.tsx', '.js', '.mjs', '.go', '.py', '.rs'}
NOTE_ROOT = '.agents/notes/'
CONFIG = '.agents/notes.config.json'


def git(repo, *args, input=None):
    result = subprocess.run(['git', '-C', str(repo), *args], input=input, capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors='replace').strip())
    return result.stdout


def canonical(path):
    return (isinstance(path, str) and bool(path) and not path.startswith(('/', '-'))
            and '\\' not in path and not any(c in path for c in '*?{}[]\n\r\t`#')
            and all(p not in ('', '.', '..') for p in path.split('/')))


class Snapshot:
    def __init__(self, repo, revision=None, index=False):
        self.repo, self.revision, self.index = repo, revision, index
        if revision:
            entries = git(repo, 'ls-tree', '-rz', '--full-tree', revision).split(b'\0')
            self.modes = {p.decode(): meta.split()[0].decode() for entry in entries if entry
                          for meta, p in [entry.split(b'\t', 1)]}
        else:
            entries = git(repo, 'ls-files', '--stage', '-z').split(b'\0')
            self.modes = {}
            for entry in filter(None, entries):
                meta, p = entry.split(b'\t', 1)
                mode, _, stage = meta.split()
                if stage != b'0':
                    raise ValueError('请先解决合并冲突, 再检查决策记录')
                self.modes[p.decode()] = mode.decode()
            if not index:
                for p in git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0'):
                    if p:
                        self.modes[p.decode()] = '100644'
                self.modes = {p: m for p, m in self.modes.items() if (repo / p).exists() or (repo / p).is_symlink()}
        self.cache = {}

    def read(self, path):
        if path not in self.modes:
            return None
        if path not in self.cache:
            if self.modes[path] not in ('100644', '100755'):
                raise ValueError(f'{path}: 只允许普通文件')
            if self.revision or self.index:
                spec = f'{self.revision}:{path}' if self.revision else f':{path}'
                data = git(self.repo, 'show', spec)
            else:
                target = self.repo / path
                if target.is_symlink() or not target.resolve().is_relative_to(self.repo):
                    raise ValueError(f'{path}: 路径为符号链接或位于仓库外')
                data = target.read_bytes()
            self.cache[path] = data.decode('utf-8')
        return self.cache[path]

    def config(self):
        text = self.read(CONFIG)
        if text is None:
            raise ValueError(f'缺少 {CONFIG}; 请先运行 scripts/setup/install.py')
        data = json.loads(text)
        if set(data) != {'version', 'guarded'} or data['version'] != 2:
            raise ValueError('须使用 v2 配置, 且只能包含 version 和 guarded; 请显式迁移旧配置')
        roots = data['guarded']
        if not isinstance(roots, list) or not roots or len(set(roots)) != len(roots):
            raise ValueError('guarded 必须是非空列表, 只含不重复的精确仓库路径')
        if not all(canonical(p) for p in roots):
            raise ValueError('guarded 只接受精确文件或目录路径, 不允许 glob 或末尾斜杠')
        return data


def guarded(path, config):
    return PurePosixPath(path).suffix in EXTENSIONS and any(path == p or path.startswith(p + '/') for p in config['guarded'])


def protected_resource(path, config):
    """Keep review coverage for guarded resources outside the AST language set."""
    return (path != CONFIG and not path.startswith(NOTE_ROOT)
            and PurePosixPath(path).suffix not in EXTENSIONS
            and any(path == p or path.startswith(p + '/') for p in config['guarded']))


def legacy_match(path, pattern):
    """Mirror the v1 glob contract: only globstar crosses directory boundaries."""
    tokens = {'**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]'}
    parts = re.split(r'(\*\*/|\*\*|\*|\?)', pattern.replace('\\', '/'))
    return re.fullmatch(''.join(tokens.get(p, re.escape(p)) for p in parts), path) is not None


def comparison_config(before, current, changed):
    """
    Preserve legacy coverage during an explicit v2 configuration migration
    .agents/notes/implemented/process/2026-10-08-agent-notes-v2-migration-boundaries.md
    """
    if CONFIG not in before.modes:
        return current, False
    try:
        return before.config(), False
    except ValueError:
        data = json.loads(before.read(CONFIG))
        if CONFIG not in changed or 'version' in data or data.get('root') != '.agents/notes':
            raise
        coverage = data.get('coverage', {})
        patterns = coverage.get('guarded', []) if coverage.get('enabled', True) else []
        if not isinstance(patterns, list) or not all(isinstance(p, str) for p in patterns):
            raise ValueError('无法还原旧版 guarded 保护策略')
        paths = [p for p in before.modes if p != CONFIG and not p.startswith(NOTE_ROOT) and
                 any(legacy_match(p, pattern) for pattern in patterns)]
        return dict(version=2, guarded=paths), True


def changed_paths(before, after):
    args = ['diff', '--no-renames', '--name-only', '-z']
    if after.index:
        args += ['--cached', before.revision]
    else:
        args += [before.revision]
        if after.revision:
            args += [after.revision]
    paths = {p.decode() for p in git(after.repo, *args).split(b'\0') if p}
    if not after.index and not after.revision:
        paths.update(p.decode() for p in git(after.repo, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0') if p)
    return paths
