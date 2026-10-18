"""Exercise both graph directions through deletion, rename and exact source anchors."""
from test_gate import GitFixture, NOTE, OTHER, note, source


class Links(GitFixture):
    def test_guarded_non_ast_resources_request_review_instead_of_disappearing(self):
        self.write('settings.json', '{"value": 1}\n')
        self.write('.agents/notes.config.json', '{"version": 2, "guarded": ["src", "settings.json"]}\n')
        self.commit()
        self.write('settings.json', '{"value": 2}\n')
        issue = next(i for i in self.run_gate()[1]['issues'] if i['rule'] == 'resource-review')
        self.assertEqual(issue['path'], 'settings.json')
        self.assertEqual(issue['severity'], 'review')

    def test_legacy_globs_preserve_root_and_globstar_directory_boundaries(self):
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'redline'))
        from snapshot import legacy_match
        self.assertTrue(legacy_match('config.py', '*.py'))
        self.assertFalse(legacy_match('src/config.py', '*.py'))
        self.assertTrue(legacy_match('src/nested/config.py', 'src/**'))
        self.assertTrue(legacy_match('src/config.py', 'src/**/*.py'))

    def test_markdown_examples_are_not_links_but_prose_links_remain_checked(self):
        examples = '\n`[Example](absent.md)`\n```md\n[Example](absent.md)\n```\n[External](hxid:example)\n'
        self.write(NOTE, note() + examples)
        self.assertNotIn('note-link', self.rules())
        self.write(NOTE, note() + examples + '[Actual link](absent.md "title")\n')
        self.assertIn('note-link', self.rules())

    def test_removing_the_code_backlink_is_detected_at_the_note_entry(self):
        self.write('src/a.py', 'def f():\n    return 1\n')
        code, result = self.run_gate()
        self.assertNotEqual(code, 0)
        issue = next(issue for issue in result['issues'] if issue['rule'] == 'anchor-cardinality')
        self.assertEqual(issue['path'], NOTE)
        self.assertEqual(issue['line'], 9)
        self.assertEqual(issue['related'], ['src/a.py'])

    def test_note_cannot_claim_a_different_representative_file(self):
        self.write('src/b.py', 'def b():\n    return 1\n')
        self.write(NOTE, note('src/b.py'))
        self.assertTrue({'reverse-edge', 'anchor-cardinality'} <= self.rules())

    def test_note_rename_requires_repairing_the_source_backlink(self):
        self.git('mv', NOTE, OTHER)
        self.assertIn('note-path', self.rules())
        self.write('src/a.py', source(OTHER))
        self.assertEqual(self.run_gate()[0], 0)

    def test_deleted_pair_cannot_leave_an_inbound_note_link(self):
        self.write('lib/b.py', source(OTHER))
        self.write('.agents/notes.config.json', '{"version": 2, "guarded": ["src", "lib"]}\n')
        self.write(OTHER, note('lib/b.py', 'other') + '\n[Related](2026-10-07-example.md)\n')
        self.commit()
        (self.repo / NOTE).unlink()
        (self.repo / 'src/a.py').unlink()
        self.assertIn('note-link', self.rules())

    def test_renamed_code_diagnostic_points_at_exact_note_line(self):
        self.git('mv', 'src/a.py', 'src/renamed.py')
        issue = next(issue for issue in self.run_gate()[1]['issues'] if issue['rule'] == 'code-path')
        self.assertEqual(issue['line'], 9)
        self.assertEqual(issue['related'], ['src/a.py'])

    def test_duplicate_sibling_backlinks_do_not_satisfy_the_relation(self):
        self.write('src/b.py', source().replace('def f', 'def b'))
        self.assertTrue({'reverse-edge', 'anchor-cardinality'} <= self.rules())

    def test_full_scan_finds_unlinked_committed_code(self):
        (self.repo / NOTE).unlink()
        self.write('src/a.py', 'def f():\n    return 1\n')
        self.commit()
        self.assertEqual(self.run_gate()[0], 0)
        code, result = self.run_gate('--all')
        self.assertNotEqual(code, 0)
        issue = next(issue for issue in result['issues'] if issue['rule'] == 'unowned-directory')
        self.assertEqual(issue['path'], 'src/a.py')
        self.assertEqual(issue['severity'], 'review')

    def test_full_scan_does_not_inherit_a_parent_directory_decision(self):
        self.write('src/nested/b.py', 'def b():\n    return 1\n')
        self.commit()
        self.assertEqual(self.run_gate()[0], 0)
        self.assertIn('unowned-directory', self.rules('--all'))

    def test_deletion_report_preserves_the_actual_base_commit(self):
        base = self.git('rev-parse', 'HEAD')
        (self.repo / 'src/a.py').unlink()
        self.commit()
        result = self.run_gate('--base', base, '--head', 'HEAD')[1]
        self.assertEqual(result['base_commit'], base)
        self.assertEqual(result['deleted'], ['src/a.py'])

    def test_exact_root_source_can_be_guarded(self):
        self.write('config.py', source())
        self.write(NOTE, note('config.py'))
        self.write('src/a.py', 'def f():\n    return 1\n')
        self.write('.agents/notes.config.json', '{"version": 2, "guarded": ["config.py"]}\n')
        self.commit()
        self.assertEqual(self.run_gate('--all')[0], 0)

    def test_explicit_config_migration_reports_review_not_tool_failure(self):
        self.write('.agents/notes.config.json', '{"root": ".agents/notes", "coverage": {"guarded": ["src/**"]}}\n')
        self.commit()
        self.write('.agents/notes.config.json', '{"version": 2, "guarded": ["src"]}\n')
        code, result = self.run_gate('--all')
        self.assertEqual(code, 1)
        self.assertIn('migration-review', {issue['rule'] for issue in result['issues']})
        self.assertNotIn('gate-error', {issue['rule'] for issue in result['issues']})
