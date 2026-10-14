import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { build } from '../src/index.js';
import { collectSources, watch } from '../src/watch.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'l2w-inc-'));

/** Lays out a small project and returns its root. */
async function project(files) {
  const root = await tmp();
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

const build1 = (root, file, opts = {}) =>
  build(path.join(root, file), { out: path.join(root, 'dist'), quiet: true, ...opts });

/** Builds and returns the generated HTML for one source file. */
async function render(root, file, opts) {
  await build1(root, file, opts);
  return readFile(path.join(root, 'dist', path.basename(file, '.tex') + '.html'), 'utf8');
}

// ------------------------------------------------------------- \input support

test('resolves \\input with and without the .tex suffix', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\input{one}\n\\input{two.tex}\n\\end{document}',
    'one.tex': 'First.',
    'two.tex': 'Second.',
  });
  const html = await render(root, 'main.tex');
  assert.match(html, /First\./);
  assert.match(html, /Second\./);
  assert.doesNotMatch(html, /was not resolved/);
});

test('resolves \\include from a subdirectory', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\include{sections/method}\n\\end{document}',
    'sections/method.tex': 'Body text.',
  });
  assert.match(await render(root, 'main.tex'), /Body text\./);
});

test('resolves a directory include to its index.tex', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\include{part}\n\\end{document}',
    'part/index.tex': 'From the directory.',
  });
  assert.match(await render(root, 'main.tex'), /From the directory\./);
});

test('an \\include inside a paragraph still starts a block', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\nSome running text \\include{more} and more text.\n\\end{document}',
    'more.tex': 'INTERLEAVED',
  });
  const html = await render(root, 'main.tex');
  assert.match(html, /INTERLEAVED/);
  assert.match(html, /Some running text/);
});

test('section numbering continues across files instead of restarting', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\input{a}\n\\input{b}\n\\input{c}\n\\end{document}',
    'a.tex': '\\section{First}\\label{s:a}',
    'b.tex': '\\section{Second}\\label{s:b}\n\\subsection{Deep}',
    'c.tex': '\\section{Third}\\label{s:c}',
  });
  const html = await render(root, 'main.tex');
  const numbers = [...html.matchAll(/<span class="sec-num">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(numbers, ['1', '2', '2.1', '3']);
});

test('a \\ref crosses the file boundary in both directions', async () => {
  const root = await project({
    'main.tex': [
      '\\begin{document}',
      '\\input{a}',
      '\\section{Third}\\label{s:c}Body.',
      'See \\ref{s:a} and \\eqref{eq:one}.',
      '\\end{document}',
    ].join('\n'),
    'a.tex': [
      '\\section{First}\\label{s:a}',
      '\\begin{equation}\\label{eq:one} x = 1 \\end{equation}',
      'Defined here, referenced later: \\ref{s:c}.',
    ].join('\n'),
  });
  const html = await render(root, 'main.tex');
  assert.doesNotMatch(html, /link-broken/);
  // the parent references a label defined in the child, and the child the parent
  assert.match(html, /href="#section-first">1</);
  assert.match(html, /href="#eq-1">\(1\)</);
  assert.match(html, /href="#section-third">2</);
});

test('equation numbering continues across files', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\input{a}\n\\input{b}\n\\end{document}',
    'a.tex': '\\begin{equation}\\label{e:1} a \\end{equation}',
    'b.tex': '\\begin{equation}\\label{e:2} b \\end{equation}',
  });
  const html = await render(root, 'main.tex');
  assert.match(html, /id="eq-1"/);
  assert.match(html, /id="eq-2"/);
  assert.match(html, /\(2\)/);
});

test('an included file may supply the document title', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\input{meta}\nBody.\n\\end{document}',
    'meta.tex': '\\title{Borrowed Title}',
  });
  assert.match(await render(root, 'main.tex'), /<title>Borrowed Title<\/title>/);
});

test('a missing include is reported in the page, not swallowed', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\input{absent}\nBody.\n\\end{document}',
  });
  const html = await render(root, 'main.tex');
  assert.match(html, /was not resolved/);
  assert.match(html, /absent/);
  assert.match(html, /Body\./); // the rest of the document still builds
});

test('an include cycle fails loudly and names the loop', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\input{a}\n\\end{document}',
    'a.tex': '\\input{b}',
    'b.tex': '\\input{a}',
  });
  await assert.rejects(build1(root, 'main.tex'), /include cycle: a\.tex -> b\.tex -> a\.tex/);
});

test('a self-including file is caught', async () => {
  const root = await project({ 'main.tex': '\\begin{document}\n\\input{main}\n\\end{document}' });
  await assert.rejects(build1(root, 'main.tex'), /include cycle/);
});

test('include depth is bounded', async () => {
  const files = { 'main.tex': '\\begin{document}\n\\input{g1}\n\\end{document}' };
  for (let i = 1; i <= 12; i++) {
    const body = i === 12 ? 'bottom' : `\\input{g${i + 1}}`;
    files[`g${i}.tex`] = `\\begin{document}\n${body}\n\\end{document}`;
  }
  const root = await project(files);
  await assert.rejects(build1(root, 'main.tex', { maxIncludeDepth: 4 }), /nested deeper than 4/);
  assert.match(await render(root, 'main.tex'), /bottom/); // 13 levels is within the default budget
});

test('an include found only via --include-dir is resolved', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\input{shared}\n\\end{document}',
    'library/shared.tex': 'From the library.',
  });
  assert.match(await render(root, 'main.tex'), /was not resolved/); // without the search path
  assert.match(
    await render(root, 'main.tex', { includeDir: [path.join(root, 'library')] }),
    /From the library\./,
  );
});

test('a file included twice is parsed once', async () => {
  const root = await project({
    'main.tex': '\\begin{document}\n\\input{shared}\n\\input{shared}\n\\end{document}',
    'shared.tex': '\\section{Shared}\\label{s:shared}',
  });
  const html = await render(root, 'main.tex');
  assert.equal(html.split('<h2 ').length - 1, 2); // one heading, two copies of the body
});

// -------------------------------------------------------------------- watch

test('collectSources follows includes recursively', async () => {
  const root = await project({
    'main.tex': '\\input{a}\n\\include{b}',
    'a.tex': '\\input{deep/nested}',
    'deep/nested.tex': 'leaf',
    'b.tex': 'b',
    'unrelated.tex': 'never referenced',
  });
  const sources = await collectSources([path.join(root, 'main.tex')]);
  const rel = [...sources.keys()].map((f) => path.relative(root, f)).sort();
  assert.deepEqual(rel, ['a.tex', 'b.tex', 'deep/nested.tex', 'main.tex']);
});

test('watch rebuilds on change, ignores strangers, and survives errors', async (t) => {
  const root = await project({ 'main.tex': '\\begin{document}\n\\section{One}\\label{s:one}\nOriginal.\n\\end{document}' });
  const out = path.join(root, 'dist');
  const entry = path.join(root, 'main.tex');
  const page = path.join(out, 'main.html');

  // Count *completed* builds: build() writes its files before it resolves, so
  // this counter is safe to read the output file right after.
  let completed = 0;
  const failures = [];
  const stop = await watch(entry, {}, async () => {
    try {
      await build(entry, { out, quiet: true });
      completed++;
    } catch (err) {
      failures.push(err.message);
      throw err;
    }
  });
  t.after(() => stop());

  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (predicate, ms = 8000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (predicate()) return true;
      await settle();
    }
    return predicate();
  };

  assert.equal(completed, 1, 'builds once on start');

  await writeFile(entry, '\\begin{document}\n\\section{One}\\label{s:one}\nEdited body.\n\\end{document}');
  assert.ok(await waitFor(() => completed >= 2), 'rebuilds after an edit');
  assert.match(await readFile(page, 'utf8'), /Edited body\./);

  const before = completed;
  await writeFile(path.join(root, 'stranger.tex'), '\\section{noise}');
  await settle(800);
  assert.equal(completed, before, 'an unrelated file does not trigger a rebuild');

  // introduce a genuine cycle, then remove it again
  await writeFile(path.join(root, 'loop.tex'), '\\input{main}');
  await writeFile(entry, '\\begin{document}\n\\input{loop}\n\\end{document}');
  assert.ok(await waitFor(() => failures.length > 0), 'a broken build is reported');
  assert.match(failures.at(-1), /include cycle/);

  const afterFailure = completed;
  await writeFile(entry, '\\begin{document}\n\\section{One}\\label{s:one}\nRecovered.\n\\end{document}');
  assert.ok(await waitFor(() => completed > afterFailure), 'recovers after the error is fixed');
  assert.match(await readFile(page, 'utf8'), /Recovered\./);
});