import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPPORTED, highlight, isSupported, normalizeLang } from '../src/highlight.js';

const has = (out, kind) => out.includes(`class="tok tok-${kind}"`);

// ------------------------------------------------------------------ contract

test('SUPPORTED lists every promised language in lowercase', () => {
  assert.deepEqual(SUPPORTED, [
    'javascript', 'js', 'ts', 'typescript',
    'python', 'py',
    'bash', 'sh', 'shell',
    'json',
    'c', 'cpp', 'rust', 'go', 'java',
    'sql', 'html', 'css',
  ]);
  assert.ok(SUPPORTED.every((l) => l === l.toLowerCase()));
});

test('normalizeLang folds case, trims and resolves aliases', () => {
  assert.equal(normalizeLang('Python'), 'python');
  assert.equal(normalizeLang('JS'), 'javascript');
  assert.equal(normalizeLang('py'), 'python');
  assert.equal(normalizeLang('sh'), 'bash');
  assert.equal(normalizeLang('shell'), 'bash');
  assert.equal(normalizeLang('TS'), 'typescript');
  assert.equal(normalizeLang('C++'), 'cpp');
  assert.equal(normalizeLang('  sql  '), 'sql');
});

test('normalizeLang rejects empty, unknown and non-string input', () => {
  assert.equal(normalizeLang(''), '');
  assert.equal(normalizeLang('   '), '');
  assert.equal(normalizeLang('brainfuck'), '');
  assert.equal(normalizeLang(null), '');
  assert.equal(normalizeLang(undefined), '');
  assert.equal(normalizeLang(42), '');
});

test('isSupported accepts aliases and rejects the rest', () => {
  assert.equal(isSupported('py'), true);
  assert.equal(isSupported('JavaScript'), true);
  assert.equal(isSupported('brainfuck'), false);
  assert.equal(isSupported(''), false);
});

// ------------------------------------------------------------------ escaping

test('escapes markup, ampersands and quotes without raw passthrough', () => {
  const out = highlight('<script>alert("x") & go</script>', 'python');
  assert.doesNotMatch(out, /<script>/);
  // Spans split the text, so strip them before checking contiguity.
  const stripped = out.replace(/<\/?span[^>]*>/g, '');
  assert.equal(stripped, '&lt;script&gt;alert(&quot;x&quot;) &amp; go&lt;/script&gt;');
});

test('an unknown language returns escaped plain text with no spans', () => {
  const out = highlight('a < b && "c"', 'klingon');
  assert.equal(out, 'a &lt; b &amp;&amp; &quot;c&quot;');
  assert.doesNotMatch(out, /tok-/);
});

test('empty and nullish input yields an empty string', () => {
  assert.equal(highlight('', 'python'), '');
  assert.equal(highlight(null, 'python'), '');
  assert.equal(highlight(undefined, 'javascript'), '');
});

test('no raw <script> ever appears, whatever the language', () => {
  const evil = '<script>alert(1)</script>';
  for (const lang of SUPPORTED) {
    const out = highlight(evil, lang);
    assert.doesNotMatch(out, /<script>/, `leaked for ${lang}`);
    const stripped = out.replace(/<\/?span[^>]*>/g, '');
    assert.equal(stripped, '&lt;script&gt;alert(1)&lt;/script&gt;', `bad escape for ${lang}`);
  }
});

// ------------------------------------------------------------------ families

test('c-like code marks comments, strings, numbers and keywords', () => {
  const out = highlight('// hello\nconst x = "hi" + 42;', 'javascript');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'number'));
  assert.ok(has(out, 'keyword'));
});

test('c-like block comments and calls highlight correctly', () => {
  const out = highlight('/* multi\nline */\nfoo(1);', 'c');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'function'));
  assert.ok(has(out, 'punct'));
});

test('rust and go share the c-like scanner', () => {
  assert.ok(has(highlight('fn main() { // run\n}', 'rust'), 'keyword'));
  assert.ok(has(highlight('func f() { // run\n}', 'go'), 'keyword'));
  assert.ok(has(highlight('class A { // c\n}', 'java'), 'keyword'));
});

test('python marks comments, strings, numbers and keywords', () => {
  const out = highlight('# hello\ndef f(x):\n    return "hi" + 42', 'python');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'number'));
  assert.ok(has(out, 'keyword'));
  assert.ok(has(out, 'function'));
});

test('shell marks comments, strings and variables', () => {
  const out = highlight('# hello\necho "hi $USER" ${HOME}', 'bash');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'variable'));
  assert.ok(has(highlight('x=42', 'sh'), 'number'));
});

test('json marks strings, numbers and literals', () => {
  const out = highlight('{"a": 1, "b": true}', 'json');
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'number'));
  assert.ok(has(out, 'keyword'));
});

test('sql folds keyword case and marks comments, strings, numbers', () => {
  const out = highlight('select * from t where id = 1; -- done', 'sql');
  assert.ok(has(out, 'keyword'));
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'number'));
  assert.ok(has(highlight("'it''s'", 'sql'), 'string'));
});

test('html marks tags, attrs, strings and comments', () => {
  const out = highlight('<div class="a">hi</div><!-- c -->', 'html');
  assert.ok(has(out, 'tag'));
  assert.ok(has(out, 'attr'));
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'comment'));
});

test('css marks attrs, numbers and comments', () => {
  const out = highlight('.a {\n  color: red;\n  margin: 12px; /* c */\n}', 'css');
  assert.ok(has(out, 'attr'));
  assert.ok(has(out, 'number'));
  assert.ok(has(out, 'comment'));
});

// ------------------------------------------------------------------ snippets

test('a multi-line python snippet highlights end to end', () => {
  const src = [
    '# fibonacci',
    'def fib(n):',
    '    """Return the nth number."""',
    "    if n < 2:  # base case",
    '        return n',
    '    return fib(n - 1) + fib(n - 2)',
  ].join('\n');
  const out = highlight(src, 'Python');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'keyword'));
  assert.ok(has(out, 'number'));
  assert.ok(has(out, 'function'));
  assert.doesNotMatch(out, /&(?!amp|lt|gt|quot);/);
});

test('a multi-line javascript snippet highlights end to end', () => {
  const src = [
    '// total the cart',
    'export function total(items) {',
    '  const sum = items.reduce((a, b) => a + b.price, 0);',
    '  return `total: ${sum}`;',
    '}',
  ].join('\n');
  const out = highlight(src, 'JS');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'keyword'));
  assert.ok(has(out, 'function'));
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'number'));
  assert.ok(has(out, 'operator'));
});

test('a multi-line shell snippet highlights end to end', () => {
  const src = [
    '#!/bin/sh',
    '# deploy the site',
    'if [ -z "$1" ]; then',
    '  echo "usage: $0 dir"',
    '  exit 1',
    'fi',
    'out=${HOME}/site',
  ].join('\n');
  const out = highlight(src, 'bash');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'keyword'));
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'variable'));
});

test('a multi-line sql snippet highlights end to end', () => {
  const src = [
    '-- top spenders',
    'SELECT name, SUM(amount) AS total',
    "FROM orders WHERE status = 'paid'",
    'GROUP BY name ORDER BY total DESC LIMIT 10;',
  ].join('\n');
  const out = highlight(src, 'SQL');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'keyword'));
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'number'));
});

test('a multi-line html snippet highlights end to end', () => {
  const src = [
    '<!-- card -->',
    '<article class="card" id="main">',
    '  <h1 data-x="1">Title &amp; more</h1>',
    '</article>',
  ].join('\n');
  const out = highlight(src, 'html');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'tag'));
  assert.ok(has(out, 'attr'));
  assert.ok(has(out, 'string'));
  assert.doesNotMatch(out, /<article/);
});

test('a multi-line css snippet highlights end to end', () => {
  const src = [
    '/* theme */',
    '@media screen {',
    '  .card { color: #fff; margin: 1.5rem; }',
    '}',
  ].join('\n');
  const out = highlight(src, 'css');
  assert.ok(has(out, 'comment'));
  assert.ok(has(out, 'keyword'));
  assert.ok(has(out, 'attr'));
  assert.ok(has(out, 'number'));
});

test('a multi-line json snippet highlights end to end', () => {
  const src = [
    '{',
    '  "name": "latex2web",',
    '  "private": false,',
    '  "stars": 1024,',
    '  "nick": null',
    '}',
  ].join('\n');
  const out = highlight(src, 'json');
  assert.ok(has(out, 'string'));
  assert.ok(has(out, 'number'));
  assert.ok(has(out, 'keyword'));
});

// ------------------------------------------------------------------ robustness

test('unterminated strings and comments do not throw', () => {
  const nasties = [
    '"never closed',
    "'also open",
    '`template to nowhere',
    '/* comment with no end',
    '<!-- html comment with no end',
    '<div class="open',
    'query "half a string -- and comment',
    'SELECT "open identifier',
  ];
  for (const lang of SUPPORTED) {
    for (const src of nasties) {
      assert.doesNotThrow(() => highlight(src, lang), `${lang}: ${src}`);
    }
  }
});

test('weird input never throws and stays escaped', () => {
  const weird = [
    '\\\\\\',
    '/* /* /*',
    '""""',
    "'''",
    '\u0000\u0001\ud83d\ude00 caf\u00e9 \u4e2d\u6587',
    'x'.repeat(20000),
    '<>&"\'`',
    '\n\n\n',
    '${} $() ` `` \'\' "" // ## --',
    '\u0301\u0302 e\u0301',
  ];
  for (const lang of [...SUPPORTED, '', 'nope', null]) {
    for (const src of weird) {
      const out = highlight(src, lang);
      assert.equal(typeof out, 'string', `${lang}: ${JSON.stringify(src.slice(0, 20))}`);
      if (src.includes('<script>')) assert.doesNotMatch(out, /<script>/);
    }
  }
  // Tokenisers may split punctuation into spans, so strip our own spans and
  // check that no raw markup survives.
  const pyStripped = highlight('<>&"', 'python').replace(/<\/?span[^>]*>/g, '');
  assert.equal(pyStripped, '&lt;&gt;&amp;&quot;');
  const cssStripped = highlight('<>&"', 'css').replace(/<\/?span[^>]*>/g, '');
  assert.equal(cssStripped, '&lt;&gt;&amp;&quot;');
});
