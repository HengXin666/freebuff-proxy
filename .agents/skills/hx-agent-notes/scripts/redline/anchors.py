"""Locate note references with Tree-sitter and bind them to declaration headers."""
import importlib
import re
from functools import lru_cache
from pathlib import PurePosixPath

from tree_sitter import Language, Parser

LANGUAGES = {'.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
             '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript',
             '.go': 'go', '.py': 'python', '.rs': 'rust'}
FUNCTIONS = {'function_definition', 'function_declaration', 'generator_function_declaration',
             'function_expression', 'generator_function', 'arrow_function', 'method_definition',
             'method_declaration', 'function_item', 'closure_expression', 'func_literal', 'lambda_expression'}
WRAPPERS = {'export_statement', 'decorated_definition', 'lexical_declaration', 'variable_declaration',
            'variable_declarator', 'expression_statement', 'assignment_expression', 'assignment',
            'template_declaration', 'attribute_declaration', 'let_declaration', 'const_item', 'static_item'}
BINDINGS = {'export_statement', 'lexical_declaration', 'variable_declaration', 'interface_declaration',
            'type_alias_declaration', 'enum_declaration', 'ambient_declaration', 'function_signature',
            'method_signature', 'abstract_method_signature', 'assignment'}
REF = re.compile(r'[^\s`\x22\x27<>()[\]]*\.agents/notes/[^\s`\x22\x27<>()[\]]+\.md')


@lru_cache(None)
def parser_for(language):
    module = importlib.import_module('tree_sitter_' + ('typescript' if language in ('typescript', 'tsx') else language))
    factory = getattr(module, 'language_' + language) if language in ('typescript', 'tsx') else module.language
    return Parser(Language(factory()))


def walk(node):
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.children))


def declaration(node):
    while node.parent and node.parent.type in WRAPPERS:
        parent = node.parent
        if sum(n.type in FUNCTIONS for n in walk(parent)) != sum(n.type in FUNCTIONS for n in walk(node)):
            break
        node = parent
    return node


def block_before(node, data, python):
    previous = node.prev_named_sibling
    # Rust attributes belong to the declaration header
    while previous and previous.type == 'attribute_item':
        node, previous = previous, previous.prev_named_sibling
    if previous is None or 'comment' not in previous.type:
        return None
    if data[previous.end_byte:node.start_byte].strip():
        return None
    if node.start_point.row - previous.end_point.row != 1:
        return None
    if python:
        last = previous
        while previous.prev_named_sibling and previous.prev_named_sibling.type == 'comment':
            prior = previous.prev_named_sibling
            if previous.start_point.row - prior.end_point.row != 1:
                break
            previous = prior
        if last.end_point.row == previous.start_point.row:
            return None
        return previous.start_byte, last.end_byte
    text = data[previous.start_byte:previous.end_byte]
    if text.startswith(b'/*') and b'\n' in text:
        return previous.start_byte, previous.end_byte
    return None


def docstring(node, data):
    body = node.child_by_field_name('body')
    if not body or not body.named_children:
        return None
    first = body.named_children[0]
    if first.type != 'expression_statement' or len(first.named_children) != 1:
        return None
    string = first.named_children[0]
    if string.type != 'string' or any(n.type == 'interpolation' for n in walk(string)):
        return None
    text = data[string.start_byte:string.end_byte].lower()
    if b'\n' in text and re.match(br'(?:r|u)?(?:\x22{3}|\x27{3})', text):
        return string.start_byte, string.end_byte
    return None


def scan(path, text):
    data = text.encode()
    tree = parser_for(LANGUAGES[PurePosixPath(path).suffix]).parse(data)
    errors, sites = [], []
    if tree.root_node.has_error:
        bad = next((n for n in walk(tree.root_node) if n.type == 'ERROR' or n.is_missing), tree.root_node)
        errors.append(('ast-parse', bad.start_point.row + 1, 'AST 解析失败, 无法校验声明锚点, 不回落到正则匹配'))
    spans = set()
    python = path.endswith('.py')
    for node in walk(tree.root_node):
        if node.type not in FUNCTIONS and node.type not in BINDINGS:
            continue
        if node.type in BINDINGS and any(n.type in FUNCTIONS for n in walk(node)):
            continue
        span = block_before(declaration(node), data, python)
        if span:
            spans.add(span)
        if python and node.type in FUNCTIONS:
            span = docstring(node, data)
            if span:
                spans.add(span)
    for match in REF.finditer(text):
        if PurePosixPath(match.group()).name in {'AGENTS.md', 'README.md'}:
            continue
        start = len(text[:match.start()].encode())
        end = start + len(match.group().encode())
        line = text.count('\n', 0, match.start()) + 1
        if not any(a <= start and end <= b for a, b in spans):
            errors.append(('anchor-position', line, '请将决策记录的仓库相对路径放入紧邻函数或声明节点的多行注释'))
        sites.append((match.group(), line))
    return sites, errors
