"""Exercise advisory collection against the strict scanner and unavailable tools."""
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from test_gate import GitFixture, source

SKILL = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILL / 'scripts/github'))
from collect import collect


class Collection(GitFixture):
    def run_collection(self, base, head):
        output = self.repo / 'collected.json'
        result = subprocess.run([sys.executable, str(SKILL / 'scripts/github/collect.py'),
                                 '--skill', str(SKILL), '--repo', str(self.repo), '--base', base,
                                 '--head', head, '--output', str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(output.read_text())

    def test_clean_scan_and_findings_both_exit_zero(self):
        base = self.git('rev-parse', 'HEAD')
        self.assertTrue(self.run_collection(base, base)['ok'])
        self.write('src/a.py', source(value=2))
        self.commit()
        head = self.git('rev-parse', 'HEAD')
        result = self.run_collection(base, head)
        self.assertFalse(result['ok'])
        self.assertEqual(result['head'], head)
        self.assertIn('code-only-diff', {issue['rule'] for issue in result['issues']})

    def test_invalid_base_preserves_gate_diagnostic(self):
        head = self.git('rev-parse', 'HEAD')
        self.assertEqual(self.run_collection('missing-ref', head)['issues'][0]['rule'], 'gate-error')

    def test_missing_endpoint_cannot_become_an_empty_diff(self):
        head = self.git('rev-parse', 'HEAD')
        result = self.run_collection('', head)
        self.assertFalse(result['ok'])
        self.assertEqual(result['issues'][0]['rule'], 'scanner-error')

    def test_missing_uv_replaces_stale_artifact(self):
        output = self.repo / 'collected.json'
        output.write_text('{"ok": true}\n')
        with patch('collect.subprocess.run', side_effect=FileNotFoundError('uv unavailable')):
            data = collect(SKILL, output, 'a' * 40, ['--all'])
        self.assertFalse(data['ok'])
        self.assertEqual(json.loads(output.read_text())['issues'][0]['rule'], 'scanner-error')
