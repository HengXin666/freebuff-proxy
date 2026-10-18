"""Check installation, scaffold validation, retirement and initial-push base resolution."""
import json
import os
import subprocess
import sys
from pathlib import Path

from test_gate import GitFixture, NOTE

SCRIPTS = Path(__file__).resolve().parents[1]


class Setup(GitFixture):
    def command(self, script, *args, env=None):
        return subprocess.run([sys.executable, str(SCRIPTS / script), '--repo', str(self.repo), *args],
                              capture_output=True, text=True, env=env)

    def test_install_rerun_and_conflict(self):
        args = ['--guarded', 'src', '--redline-dir', 'quality/redlines', '--github', '--main-branch', 'trunk']
        config = self.repo / '.agents/notes.config.json'
        config.write_text(json.dumps(dict(version=2, guarded=['src']), indent=2) + '\n')
        self.write('package.json', '{}\n')
        first = self.command('setup/install.py', *args)
        self.assertEqual(first.returncode, 0, first.stderr)
        files = [p for p in self.repo.rglob('*') if p.is_file() and '.git' not in p.parts]
        before = {p: p.read_bytes() for p in files}
        second = self.command('setup/install.py', *args)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(before, {p: p.read_bytes() for p in files})
        self.assertIn('uv run quality/redlines/agent_notes.py', (self.repo / 'AGENTS.md').read_text())
        package = json.loads((self.repo / 'package.json').read_text())
        self.assertEqual(package['scripts']['verify-notes'], 'uv run quality/redlines/agent_notes.py --diff')
        self.assertTrue((self.repo / 'quality/redlines/agent_notes.py').read_text().startswith('#!/usr/bin/env -S uv run'))
        self.assertIn('branches: ["trunk"]', (self.repo / '.github/workflows/agent-notes-full.yml').read_text())
        self.assertIn('workflow_run:', (self.repo / '.github/workflows/agent-notes-report.yml').read_text())
        self.commit()
        wrapper = subprocess.run(['uv', 'run', str(self.repo / 'quality/redlines/agent_notes.py'), '--all'],
                                 capture_output=True, text=True)
        self.assertEqual(wrapper.returncode, 0, wrapper.stdout + wrapper.stderr)
        config.write_text('{"version": 1}\n')
        self.assertNotEqual(self.command('setup/install.py', *args).returncode, 0)

    def test_new_note_needs_rationale(self):
        result = self.command('setup/new_note.py', 'proposed', 'process', 'new-example', '--code', 'src/a.py', '--date', '2026-10-07')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('note-format', self.rules())

    def test_generated_guarded_entry_allows_comments_but_rejects_code_drift(self):
        args = ['--guarded', 'src', '--guarded', 'quality/redlines', '--redline-dir', 'quality/redlines']
        self.write('.agents/notes.config.json', json.dumps(dict(version=2, guarded=['quality/redlines', 'src']), indent=2) + '\n')
        first = self.command('setup/install.py', *args)
        self.assertEqual(first.returncode, 0, first.stderr)
        entry = self.repo / 'quality/redlines/agent_notes.py'
        text = entry.read_text().replace('repo = ', '# Decision constraint\n# ' + NOTE + '\nrepo = ', 1)
        entry.write_text(text)
        self.assertEqual(self.command('setup/install.py', *args).returncode, 0)
        self.assertEqual(entry.read_text(), text)
        entry.write_text(text.replace("os.execvp('uv'", "os.execvp('false'", 1))
        self.assertNotEqual(self.command('setup/install.py', *args).returncode, 0)

    def test_retirement_refuses_inbound_then_deletes(self):
        result = self.command('setup/maintain.py', '--delete', NOTE, '--apply')
        self.assertEqual(result.returncode, 1)
        self.assertTrue((self.repo / NOTE).exists())
        self.write('src/a.py', 'def f():\n    return 1\n')
        preview = self.command('setup/maintain.py', '--delete', NOTE)
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertTrue((self.repo / NOTE).exists())
        result = self.command('setup/maintain.py', '--delete', NOTE, '--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.repo / NOTE).exists())
        self.assertEqual(self.run_gate()[0], 0)

    def test_initial_push_base_is_not_head(self):
        head = self.git('rev-parse', 'HEAD')
        event, output = self.repo / 'event.json', self.repo / 'github-output'
        event.write_text(json.dumps(dict(before='0' * 40, after=head)))
        env = dict(os.environ, GITHUB_EVENT_PATH=str(event), GITHUB_OUTPUT=str(output))
        result = subprocess.run([sys.executable, str(SCRIPTS / 'github/base.py')], cwd=self.repo, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        values = dict(line.split('=', 1) for line in output.read_text().splitlines())
        self.assertEqual(values['head'], head)
        self.assertNotEqual(values['base'], head)
        self.assertEqual(self.git('ls-tree', values['base']), '')


if __name__ == '__main__':
    import unittest
    unittest.main()
