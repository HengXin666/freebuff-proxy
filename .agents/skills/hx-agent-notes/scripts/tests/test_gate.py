"""Test observable gate behavior using isolated Git repositories and real snapshots."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'redline'))
from graph import parse_note

GATE = Path(__file__).resolve().parents[1] / 'redline/verify.py'
NOTE = '.agents/notes/' + 'implemented/architecture/2026-10-07-example.md'
OTHER = '.agents/notes/' + 'implemented/architecture/2026-10-07-other.md'


def note(code='src/a.py', identity='example'):
    return f'''# Agent Note: Example

Status: implemented

Decision-ID: {identity}

## Code

- `{code}`

## Problem

Keep a durable boundary

## Decision

Keep functions deterministic

## Alternatives considered

- Do nothing / reuse existing: avoids maintenance, but leaves the boundary implicit

## Consequences

Maintain the relation alongside code
'''


def source(target=NOTE, value=1):
    return f'def f():\n    """Constraint\n    {target}\n    """\n    return {value}\n'


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='notes-gate-')
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        self.write('.agents/notes.config.json', json.dumps(dict(version=2, guarded=['src'])))
        self.write(NOTE, note())
        self.write('src/a.py', source())
        self.commit()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.STDOUT).decode().strip()

    def write(self, path, text):
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')

    def run_gate(self, *args):
        report = self.repo / 'result.json'
        process = subprocess.run([sys.executable, str(GATE), '--repo', str(self.repo), '--json', str(report), *args], capture_output=True, text=True)
        self.assertTrue(report.exists(), process.stdout + process.stderr)
        result = json.loads(report.read_text())
        return process.returncode, result

    def rules(self, *args):
        return {i['rule'] for i in self.run_gate(*args)[1]['issues']}


class Gate(GitFixture):
    def test_clean_and_both_changed(self):
        """
        Verify exact graph and diff-pairing behavior
        .agents/notes/implemented/process/2026-10-07-agent-notes-ast-redline.md
        """
        self.assertEqual(self.run_gate('--all')[0], 0)
        self.write(NOTE, note().replace('deterministic', 'deterministic and bounded'))
        self.write('src/a.py', source(value=2))
        self.assertEqual(self.run_gate()[0], 0)

    def test_unrelated_note_does_not_cover_code(self):
        self.write('lib/b.py', source(OTHER))
        self.write(OTHER, note('lib/b.py', 'other'))
        self.commit()
        self.write('src/a.py', source(value=2))
        self.write(OTHER, note('lib/b.py', 'other') + '\nExtra rationale\n')
        self.assertIn('code-only-diff', self.rules())

    def test_each_one_sided_change_requests_review(self):
        self.write('src/a.py', source(value=2))
        self.assertIn('code-only-diff', self.rules())
        self.write('src/a.py', source())
        self.write(NOTE, note() + '\nMore rationale\n')
        self.assertIn('note-only-diff', self.rules())

    def test_sibling_file_counts_for_directory(self):
        self.write('src/b.py', 'def b():\n    return 1\n')
        self.assertIn('code-only-diff', self.rules())
        self.write(NOTE, note() + '\nSibling behavior is bounded\n')
        self.assertEqual(self.run_gate()[0], 0)

    def test_deleted_pair_and_dangling_anchor(self):
        (self.repo / NOTE).unlink()
        self.assertIn('note-path', self.rules())
        self.assertIn('note-only-diff', self.rules())
        (self.repo / 'src/a.py').unlink()
        self.assertEqual(self.run_gate()[0], 0)

    def test_rename_requires_repair(self):
        self.git('mv', 'src/a.py', 'src/b.py')
        self.assertIn('code-path', self.rules())
        self.write(NOTE, note('src/b.py'))
        self.assertEqual(self.run_gate()[0], 0)

    def test_staged_uses_index_contents(self):
        self.write('src/a.py', source(value=2))
        self.git('add', 'src/a.py')
        self.write(NOTE, note() + '\nUnstaged note edit\n')
        self.assertIn('code-only-diff', self.rules('--staged'))
        self.git('add', NOTE)
        self.assertEqual(self.run_gate('--staged')[0], 0)
        self.write('src/a.py', 'broken ( {')
        self.assertEqual(self.run_gate('--staged')[0], 0)
        self.assertIn('ast-parse', self.rules())

    def test_duplicate_directory_and_glob_rejected(self):
        for code in ['src/{a,b}.py', 'src/*.py', '../src/a.py', 'src/a.py`\n- `src/b.py']:
            with self.subTest(code=code), self.assertRaises(ValueError):
                parse_note(NOTE, note(code))

    def test_duplicate_anchor_and_identity(self):
        self.write('src/a.py', source() + '\n' + source().replace('def f', 'def g'))
        self.assertIn('anchor-cardinality', self.rules())
        self.write(OTHER, note())
        self.assertIn('duplicate-decision', self.rules())

    def test_diff_does_not_report_unrelated_existing_defect(self):
        self.write('src/bad.py', 'def invalid(:\n')
        self.commit()
        self.assertEqual(self.run_gate()[0], 0)
        self.assertIn('ast-parse', self.rules('--all'))

    def test_bad_base_is_error(self):
        self.assertEqual(self.run_gate('--base', 'nonexistent-ref')[0], 2)

    def test_committed_head_ignores_worktree(self):
        base = self.git('rev-parse', 'HEAD')
        self.write('src/a.py', source(value=2))
        self.commit()
        self.write(NOTE, note() + '\nWorktree-only repair\n')
        self.assertIn('code-only-diff', self.rules('--base', base, '--head', 'HEAD'))

    def test_policy_cannot_hide_code(self):
        self.write('.agents/notes.config.json', json.dumps(dict(version=2, guarded=['lib'])))
        self.write('src/a.py', source(value=2))
        self.assertTrue({'code-only-diff', 'policy-review'} <= self.rules())

    def test_no_exemption_escape(self):
        self.write('src/a.py', source(value=2))
        self.write('.agents/notes/' + 'NOTE-EXEMPT.md', 'note-exempt: formatting only\n')
        self.assertTrue({'code-only-diff', 'note-format'} <= self.rules())

    def test_symlink_fails_closed(self):
        (self.repo / 'src/a.py').unlink()
        (self.repo / 'src/a.py').symlink_to('/etc/hostname')
        self.assertIn('source-read', self.rules())

    def test_unowned_new_code(self):
        self.write('src/new/a.py', 'def new():\n    return 1\n')
        self.assertIn('unowned-code', self.rules())

    def test_reverse_edge_and_deleted_note_link(self):
        self.write('src/other.py', source())
        self.assertIn('reverse-edge', self.rules())
        (self.repo / 'src/other.py').unlink()
        self.write(NOTE, note() + '\n[Missing](2026-10-07-absent.md)\n')
        self.assertIn('note-link', self.rules())

    def test_each_directory_pairs_independently(self):
        self.write('lib/b.py', source())
        self.write('.agents/notes.config.json', json.dumps(dict(version=2, guarded=['src', 'lib'])))
        self.write(NOTE, note('src/a.py`\n- `lib/b.py'))
        self.commit()
        self.write('src/a.py', source(value=2))
        self.write(NOTE, note('src/a.py`\n- `lib/b.py') + '\nShared decision changed\n')
        self.assertIn('note-only-diff', self.rules())
        self.write('lib/b.py', source(value=2))
        self.assertEqual(self.run_gate()[0], 0)

    def test_orphan_branch_uses_empty_tree(self):
        self.git('checkout', '--orphan', 'new-root')
        self.assertEqual(self.run_gate('--all')[0], 0)

    def test_unborn_repository(self):
        fresh = self.repo / 'fresh'
        fresh.mkdir()
        self.git('init', '-q', str(fresh))
        self.repo = fresh
        self.write('.agents/notes.config.json', json.dumps(dict(version=2, guarded=['src'])))
        self.write(NOTE, note())
        self.write('src/a.py', source())
        self.assertEqual(self.run_gate('--all')[0], 0)


if __name__ == '__main__':
    unittest.main()
