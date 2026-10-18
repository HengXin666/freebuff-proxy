"""Exercise real parsers for all supported languages and invalid reference locations."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'redline'))
from anchors import scan

NOTE = '.agents/notes/' + 'implemented/architecture/2026-10-07-example.md'
BLOCK = '/**\n * ' + NOTE + '\n */\n'


class Anchors(unittest.TestCase):
    def test_languages(self):
        examples = {
            'a.cpp': BLOCK + 'int f() { return 1; }',
            'a.ts': BLOCK + 'export async function f(): Promise<number> { return 1; }',
            'a.tsx': BLOCK + 'export const F = () => <div />;',
            'a.js': BLOCK + 'export default function f() { return 1; }',
            'a.mjs': BLOCK + 'export const f = () => 1;',
            'a.go': 'package main\n' + BLOCK + 'func f() int { return 1 }',
            'a.py': '# A constraint\n# ' + NOTE + '\n@decorator\ndef f():\n    return 1\n',
            'a.rs': BLOCK + '#[inline]\npub fn f() -> i32 { 1 }',
        }
        for path, source in examples.items():
            with self.subTest(path=path):
                sites, errors = scan(path, source)
                self.assertEqual(errors, [])
                self.assertEqual(len(sites), 1)

    def test_python_docstring(self):
        source = 'async def f():\n    """Constraint\n    ' + NOTE + '\n    """\n    pass\n'
        self.assertEqual(scan('a.py', source)[1], [])

    def test_methods_and_templates(self):
        for path, source in [('a.cpp', BLOCK + 'template<typename T> T f(T a) { return a; }'),
                             ('a.ts', 'class A {\n' + BLOCK + 'f() {}\n}'),
                             ('a.go', 'package main\ntype A struct{}\n' + BLOCK + 'func (a A) f() {}')]:
            with self.subTest(path=path):
                self.assertEqual(scan(path, source)[1], [])

    def test_bad_positions(self):
        sources = [
            BLOCK + '\nfunction f() {}',
            '// ' + NOTE + '\nfunction f() {}',
            '/** ' + NOTE + ' */\nfunction f() {}',
            BLOCK + 'class A { f() {} }',
            'function f() {\n' + BLOCK + 'return 1;\n}',
            'const x = "' + NOTE + '";\nfunction f() {}',
        ]
        for source in sources:
            with self.subTest(source=source):
                self.assertIn('anchor-position', [e[0] for e in scan('a.ts', source)[1]])

    def test_python_not_a_docstring(self):
        for statement in ['x = 1\n    """', 'f"""']:
            source = 'def f():\n    ' + statement + NOTE + '\n    """\n    pass\n'
            self.assertIn('anchor-position', [e[0] for e in scan('a.py', source)[1]])

    def test_parse_error_fails_closed(self):
        self.assertIn('ast-parse', [e[0] for e in scan('a.ts', BLOCK + 'function ( {')[1]])

    def test_administrative_docs_are_not_decisions(self):
        path = '.agents/notes/' + 'AGENTS.md'
        self.assertEqual(scan('a.py', f'path = "{path}"')[0], [])

    def test_repo_relative_paths_only(self):
        sites, _ = scan('a.ts', BLOCK.replace(NOTE, '../../' + NOTE) + 'function f() {}')
        self.assertEqual(sites[0][0], '../../' + NOTE)

    def test_declarative_code_uses_real_ast_nodes(self):
        examples = [('a.ts', BLOCK + 'export const config = { port: 80 };'),
                    ('a.ts', BLOCK + 'export interface Config { port: number }'),
                    ('a.ts', BLOCK + 'export type Config = { port: number };'),
                    ('a.ts', BLOCK + 'export { f } from "./module";'),
                    ('a.ts', BLOCK + 'export default defineConfig({ port: 80 });'),
                    ('a.py', '# Constraint\n# ' + NOTE + '\nPORT = 80\n')]
        for path, source in examples:
            with self.subTest(path=path):
                self.assertEqual(scan(path, source)[1], [])

    def test_declaration_comments_cannot_float_across_blank_lines(self):
        self.assertIn('anchor-position', [e[0] for e in scan('a.ts', BLOCK + '\nexport const config = {};')[1]])


if __name__ == '__main__':
    unittest.main()
