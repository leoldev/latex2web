import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { build } from '../src/index.js';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A one-page PDF, so the rasteriser has something it can actually read. */
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 18 Tf 20 60 Td (figure) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`;
import { parseDocument } from '../src/parse.js';
import { buildToc, escapeHtml, renderBlocks, renderFootnotes, renderInline, renderToc } from '../src/render.js';

/**
 * Reads the stylesheet a build emitted for a layout.
 *
 * The name carries a fingerprint of the CSS, so it changes whenever the CSS
 * does; that is the point of it. Tests therefore resolve it by stem rather than
 * by a fixed name, which would fail every time a token changed.
 */
async function readStylesheet(dir, layout) {
  const { readdir } = await import('node:fs/promises');
  const name = (await readdir(dir)).find((f) => f.startsWith(`theme-${layout}.`) && f.endsWith('.css'));
  assert.ok(name, `${layout} stylesheet emitted in ${dir}: ${(await readdir(dir)).join(', ')}`);
  return readFile(path.join(dir, name), 'utf8');
}

async function stylesheetExists(dir, layout) {
  const { readdir } = await import('node:fs/promises');
  try {
    return (await readdir(dir)).some((f) => f.startsWith(`theme-${layout}.`) && f.endsWith('.css'));
  } catch { return false; }
}

const html = (tex, ctx = {}) => renderBlocks(parseDocument(tex).blocks, { parseCell: (t) => parseDocument(t).blocks.flatMap((b) => b.nodes ?? []), ...ctx });
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'latex2web-'));

// ------------------------------------------------------------------ rendering

test('translates LaTeX typographic conventions at render time', () => {
  // backticks cannot live unescaped inside a template literal
  const out = html('a -- b --- c, ``quoted\'\' text.');
  assert.match(out, /a – b — c, “quoted” text\./);
});

test('escapes HTML exactly once', () => {
  const out = html(String.raw`AT\&T and 5\% and \#tag.`);
  assert.match(out, /AT&amp;T/);
  assert.doesNotMatch(out, /&amp;amp;/);
  assert.match(out, /5%/);
  assert.match(out, /#tag/);
});

test('escapes markup in source text', () => {
  const out = html('a < b && c > d');
  assert.match(out, /a &lt; b &amp;&amp; c &gt; d/);
});

test('renders display math through KaTeX', () => {
  const out = html(String.raw`\[ E = mc^2 \]`);
  assert.match(out, /katex/);
  assert.doesNotMatch(out, /katex-error/);
  assert.match(out, /class="math-block"/);
});

test('falls back to marked-up source when math cannot be rendered', () => {
  const out = html(String.raw`\[ E = mc^2 \]`, { katex: null });
  assert.match(out, /math-fallback/);
  assert.match(out, /E = mc\^2/);
});

test('numbers only numbered equations', () => {
  const out = html(String.raw`\begin{equation} a=1 \end{equation} \[ b=2 \]`);
  assert.equal(out.match(/class="eqno"/g).length, 1);
  assert.match(out, /\(1\)/);
});

test('renders a section with its number and an anchor link', () => {
  const out = html(String.raw`\section{Hello World}`);
  assert.match(out, /<h2 id="section-hello-world"><span class="sec-num">1<\/span>/);
  assert.match(out, /<a class="anchor" href="#section-hello-world"/);
});

test('builds a nested table of contents, one entry per section', () => {
  const tree = buildToc(parseDocument(String.raw`
    \section{One}
    \subsection{One A}
    \subsection{One B}
    \section{Two}
  `).blocks);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children[0].title, 'One A');
  assert.equal(tree[1].children.length, 0);

  const toc = renderToc(tree);
  // each subsection appears exactly once, under its own parent
  assert.equal(toc.split('One A').length - 1, 1);
  assert.match(toc, /toc-level-2/);
});

test('renders lists, callouts and code blocks with their hooks', () => {
  const out = html(String.raw`
    \begin{itemize}\item one \end{itemize}
    \begin{theorem}[Name]\label{thm:n}
      \begin{proof}obvious\end{proof}
    \end{theorem}
    \begin{lstlisting}[language=JS]
    const x = 1;
    \end{lstlisting}
  `);
  assert.match(out, /<ul class="itemize">/);
  assert.match(out, /callout-theorem/);
  assert.match(out, /class="callout-note">\(Name\)/);
  assert.match(out, /class="qed">∎/);
  assert.match(out, /class="code-block"/);
  assert.match(out, /class="language-JS"/);
  assert.match(out, /<button class="copy"/);
});

test('renders tables with a header row and a caption', () => {
  const out = html(String.raw`
    \begin{table}[h]
      \begin{tabular}{ll}
        A & 1 \\
        B & 2 \\
      \end{tabular}
      \caption{Caps.}
    \end{table}
  `);
  assert.match(out, /<thead><tr><th>A<\/th><th>1<\/th><\/tr><\/thead>/);
  assert.equal(out.match(/<tr>/g).length, 2);
  assert.match(out, /<figcaption>Caps\.<\/figcaption>/);
});

test('collects footnotes into a notes section', () => {
  const ctx = { parseCell: (t) => [] };
  const body = renderBlocks(parseDocument('Body\\footnote{a note} text.').blocks, ctx);
  const notes = renderFootnotes(ctx);
  assert.match(body, /class="fnref"/);
  assert.match(notes, /class="footnotes"/);
  assert.match(notes, /a note/);
  assert.match(notes, /href="#fnref-1"/);
});

test('marks TikZ as unrendered rather than dropping it', () => {
  const out = html(String.raw`\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}`);
  assert.match(out, /tikz-block/);
  assert.match(out, /source shown, not rendered to SVG/);
});

test('escapeHtml covers the dangerous four', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('renderInline tolerates an empty node list', () => {
  assert.equal(renderInline([]), '');
  assert.equal(renderInline(null), '');
});

// ---------------------------------------------------------------------- build

test('builds a single page with an index and a named copy', async () => {
  const dir = await tmp();
  const src = path.join(dir, 'note.tex');
  await writeFile(src, String.raw`\title{Note}\begin{document}Hello $x$.\end{document}`);
  const out = await build(src, { out: path.join(dir, 'dist'), quiet: true });

  assert.equal(out.pages, 1);
  assert.equal(out.entry, 'index.html');
  assert.match(out.engine, /katex@/);
  const index = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');
  const named = await readFile(path.join(dir, 'dist', 'note.html'), 'utf8');
  assert.equal(index, named);
  assert.match(index, /<title>Note<\/title>/);
  assert.match(index, /katex/);
  assert.doesNotMatch(index, /\{\{(title|content|styles|toc|nav|footer|scripts)\}\}/);
});

test('builds several documents into one site with a landing page', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\title{Alpha}\begin{document}A.\end{document}`);
  await writeFile(path.join(dir, 'b.tex'), String.raw`\title{Beta}\begin{document}B.\end{document}`);

  const out = await build(dir, { out: path.join(dir, 'dist'), quiet: true });
  assert.equal(out.pages, 2);
  for (const f of ['index.html', 'a.html', 'b.html', 'all.html']) {
    await readFile(path.join(dir, 'dist', f)); // throws if missing
  }
  assert.ok(await stylesheetExists(path.join(dir, 'dist'), 'paper'));
  const a = await readFile(path.join(dir, 'dist', 'a.html'), 'utf8');
  assert.match(a, /class="doc-nav"/);
});

test('honours the base path for stylesheets and assets', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}A.\end{document}`);
  await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), base: '/docs', quiet: true });
  const a = await readFile(path.join(dir, 'dist', 'a.html'), 'utf8');
  assert.match(a, /href="\/docs\/theme-paper\.[a-z0-9]+\.css"/);
  assert.match(a, /href="\/docs\/vendor\/katex\/katex\.min\.css"/);
});

test('two layouts can share one output directory', async () => {
  // Each layout writes its own stylesheet: with one shared `theme.css` the last
  // build wins and every page gets the wrong sheet.
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}A.\end{document}`);
  await writeFile(path.join(dir, 'b.tex'), String.raw`\begin{document}B.\end{document}`);
  const site = path.join(dir, 'site');
  await build(src(dir, 'a.tex'), { out: site, theme: 'paper', quiet: true });
  await build(src(dir, 'b.tex'), { out: site, theme: 'docs', quiet: true });

  assert.ok(await stylesheetExists(site, 'paper'), 'the paper stylesheet survives');
  assert.ok(await stylesheetExists(site, 'docs'), 'the docs stylesheet is written too');
  assert.match(await readFile(path.join(site, 'a.html'), 'utf8'), /theme-paper\.[a-z0-9]+\.css/);
  assert.match(await readFile(path.join(site, 'b.html'), 'utf8'), /theme-docs\.[a-z0-9]+\.css/);
});

test('--base is where the shared stylesheet is written', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}A.\end{document}`);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await build('a.tex', { out: 'dist', base: 'site', quiet: true });
    assert.ok(
      await stylesheetExists(path.join(dir, 'site'), 'paper'),
      'the stylesheet belongs with the pages it is shared with, not beside the page'
    );
    assert.ok(!(await stylesheetExists(path.join(dir, 'dist'), 'paper')));
    assert.match(await readFile(path.join(dir, 'dist', 'a.html'), 'utf8'), /href="site\/theme-paper\.[a-z0-9]+\.css"/);
  } finally {
    process.chdir(cwd);
  }
});

test('an absolute --base is an href prefix, not a place to write', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}A.\end{document}`);
  await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), base: '/docs', quiet: true });
  assert.ok(
    await stylesheetExists(path.join(dir, 'dist'), 'paper'),
    'writing to an absolute prefix would escape the output directory'
  );
});

function src(dir, name) {
  return path.join(dir, name);
}

test('single-file mode inlines css, katex and fonts', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}$x$.\end{document}`);
  const out = await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), singleFile: true, quiet: true });
  assert.equal(out.singleFile, true);

  const a = await readFile(path.join(dir, 'dist', 'a.html'), 'utf8');
  assert.match(a, /<style>/);
  assert.match(a, /data:font\/woff2;base64,/);
  assert.doesNotMatch(a, /<link rel="stylesheet"/);
  // no external references left at all
  assert.doesNotMatch(a, /href="(?!#|https?:|mailto:)[^"]*\.css"/);
});

test('plain engine skips KaTeX entirely', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}$x^2$.\end{document}`);
  const out = await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), engine: 'plain', quiet: true });
  assert.equal(out.math, 'fallback');
  const a = await readFile(path.join(dir, 'dist', 'a.html'), 'utf8');
  assert.doesNotMatch(a, /class="katex"/);
});

test('rejects an unknown theme by name', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}A.\end{document}`);
  await assert.rejects(
    build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), theme: 'neon', quiet: true }),
    /unknown theme "neon"/,
  );
});

test('reports a missing input clearly', async () => {
  await assert.rejects(build(path.join(os.tmpdir(), 'definitely-not-here.tex'), { quiet: true }), /input not found/);
});

test('copies referenced images next to the output', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'plot.png'), 'not-really-a-png');
  await writeFile(path.join(dir, 'a.tex'), String.raw`
    \begin{document}
    \begin{figure}\includegraphics{plot.png}\caption{P}\end{figure}
    \end{document}
  `);
  const out = await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), quiet: true });
  assert.equal(out.assets, 1);
  assert.match(await readFile(path.join(dir, 'dist', 'a.html'), 'utf8'), /src="assets\/plot\.png"/);
  await readFile(path.join(dir, 'dist', 'assets', 'plot.png')); // throws if missing
});
test('an image referenced without an extension links to the file on disk', async () => {
  // The href must carry the resolved extension: graphicx finds it, so authors
  // write `{Figures/arch}` while the file on disk is `assets/arch.png`.
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}
\includegraphics{arch}\end{document}`);
  await writeFile(path.join(dir, 'arch.png'), 'x');
  await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), quiet: true });
  const page = await readFile(path.join(dir, 'dist', 'a.html'), 'utf8');
  assert.match(page, /src="assets\/arch\.png"/, 'the href must carry the resolved extension');
  assert.ok(existsSync(path.join(dir, 'dist', 'assets', 'arch.png')));
});

test('a rasterised PDF cannot overwrite a PNG of the same name', async () => {
  // `assets` is keyed by the on-disk name, so a rasterised PDF and a real PNG
  // of the same stem must survive as two separate assets, not one write over
  // the other.
  const dir = await tmp();
  await writeFile(path.join(dir, 'art.pdf'), PDF);
  await writeFile(path.join(dir, 'art.png'), 'not-really-a-png');
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}
\includegraphics{art.pdf}\includegraphics{art.png}\end{document}`);
  const out = await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), quiet: true });
  assert.equal(out.assets, 2, 'both figures must survive as separate assets');
  const page = await readFile(path.join(dir, 'dist', 'a.html'), 'utf8');
  const srcs = [...page.matchAll(/src="assets\/([^"]+)"/g)].map((m) => m[1]);
  assert.equal(srcs.length, 2);
  assert.equal(new Set(srcs).size, 2, `both figures pointed at ${srcs}`);
  for (const name of srcs) await readFile(path.join(dir, 'dist', 'assets', name)); // throws if missing
});

test('emitted asset names are stable between builds', async () => {
  // The rasteriser's cache is keyed by the emitted name, so a name that moved
  // between runs would recompile every figure in the build. A clash is broken
  // with a hash of the source path rather than with a counter.
  const dir = await tmp();
  await writeFile(path.join(dir, 'art.pdf'), PDF);
  await writeFile(path.join(dir, 'art-pdf.png'), 'a png whose name is exactly what the PDF wants');
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}
\includegraphics{art.pdf}\includegraphics{art-pdf.png}\end{document}`);
  const names = async () => {
    const { readdir } = await import('node:fs/promises');
    return (await readdir(path.join(dir, 'dist', 'assets'))).sort();
  };
  await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), quiet: true });
  const first = await names();
  await build(src(dir, 'a.tex'), { out: path.join(dir, 'dist'), quiet: true });
  assert.deepEqual(await names(), first, 'the second build renamed its own cache');
});

test('--base puts the images where the hrefs point', async () => {
  // The href carries the base prefix, so the file must be written under the
  // base too; otherwise every image 404s.
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}
\includegraphics[width=2cm]{x.png}\end{document}`);
  await writeFile(path.join(dir, 'x.png'), 'x');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await build('a.tex', { out: 'dist', base: 'site', quiet: true });
    const page = await readFile(path.join(dir, 'dist', 'a.html'), 'utf8');
    assert.match(page, /src="site\/assets\/x\.png"/);
    assert.ok(
      existsSync(path.join(dir, 'site', 'assets', 'x.png')),
      'the image must be written under the base the href uses'
    );
  } finally {
    process.chdir(cwd);
  }
});

test('a css media query is not split by a later insertion', async () => {
  // Appended figure rules must land outside any open media query; inside one
  // they parse as the wrong selector and take the base sizing rule with them.
  const css = await readFile(path.join(root, 'themes', 'paper.css'), 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const opens = (stripped.match(/{/g) || []).length;
  const closes = (stripped.match(/}/g) || []).length;
  assert.equal(opens, closes, 'unbalanced braces in paper.css');
  assert.doesNotMatch(stripped, /(^|\})\s*[a-z][a-z-]*\s+[a-z-]+\s*\{/, 'no element selector where a class was meant');
});

test('the wide-screen rail is not overridden by the base rules', async () => {
  // At equal specificity source order wins, so the 62rem query that shows the
  // rail must come after the base rule that hides it.
  for (const layout of ['paper', 'notes']) {
    const css = await readFile(path.join(root, 'themes', `${layout}.css`), 'utf8');
    const base = css.indexOf('.toc-rail { display: none; }');
    const query = css.indexOf('@media (min-width: 62rem)');
    assert.ok(base > -1 && query > -1, `${layout}: both rules present`);
    assert.ok(query > base, `${layout}: the query must come after the base rule`);
    // Counted only among the queries that carry the rail. The type scale steps at
    // the same breakpoint in a query of its own, and that is a different concern
    // from the cascade order this test is about.
    const railQueries = (css.match(/@media \(min-width: 62rem\) \{[^{]*(?:\{[^{]*\}[^{]*)*?\.toc-rail/g) || []).length;
    assert.equal(railQueries, 1, `${layout}: exactly one wide-screen query that shows the rail`);
  }
});

test('no layout forbids prose and maths from wrapping', async () => {
  // Neither `.cite` nor `.math-inline` may forbid wrapping: an unbreakable
  // citation or integral pushes the page sideways on a phone.
  for (const layout of ['paper', 'notes', 'docs', 'slides']) {
    const css = await readFile(path.join(root, 'themes', `${layout}.css`), 'utf8');
    for (const sel of ['.cite', '.math-inline']) {
      const block = new RegExp(`^${sel.replace('.', '\\.')} \\{[^}]*\\}`, 'm').exec(css);
      assert.ok(block, `${layout}: ${sel} rule found`);
      assert.doesNotMatch(block[0], /white-space:\s*nowrap/,
        `${layout}: ${sel} must not forbid wrapping`);
    }
  }
});

test('the hoisted hero lifts the install command out of the ledger', async () => {
  // Command, label and list are siblings in reading order; one wrapper holding
  // all three forces two of them into a single grid cell, in the wrong column.
  const dir = await tmp();
  const src = path.join(dir, 'index.tex');
  await writeFile(src, String.raw`\title{Home}\author{leoldev}
\begin{document}
\maketitle

\begin{verbatim}
$ npm install leoldev/latex2web
\end{verbatim}

See some examples here

\begin{description}
  \item[One] First.\end{description}

\section{Body}
Text.
\end{document}`);
  // `build` takes resolved options, not a config file (reading those is the
  // CLI's job), so the keys go straight in. `hero` turns on the hoisted front
  // page.
  await build(src, {
    out: path.join(dir, 'dist'), quiet: true,
    theme: 'landing', hero: 'front-matter', wordmarkHero: true, nav: [], footer: false,
  });
  const html = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');

  // The command is a sibling of the ledger, not a child of it.
  assert.match(html, /<div class="hero">[\s\S]*?<\/figure>\s*<div class="hero-front">/);
  assert.doesNotMatch(html, /<div class="hero-front">[\s\S]*?<\/figure>/,
    'the command must not be inside the ledger wrapper');

  // And the wrapper holds only the label and the list, so they are one flow.
  const front = /<div class="hero-front">([\s\S]*?)<\/div>\s*<\/div>/.exec(html);
  assert.ok(front, 'the ledger wrapper is present');
  assert.match(front[1], /See some examples here/);
  assert.match(front[1], /class="descriptions"/);
  assert.doesNotMatch(front[1], /class="code-block"/);
});

test('the stylesheet name changes when the CSS changes', async () => {
  // The stylesheet name fingerprints the CSS: a fixed name serves the old
  // layout from cache with no error to show for it.
  const dir = await tmp();
  await writeFile(path.join(dir, 'a.tex'), String.raw`\begin{document}A.\end{document}`);
  const one = await build(src(dir, 'a.tex'), { out: path.join(dir, 'd1'), theme: 'paper', quiet: true });
  const two = await build(src(dir, 'a.tex'), { out: path.join(dir, 'd2'), theme: 'paper', quiet: true });
  assert.equal(one.layout, two.layout);
  const nameOf = (html) => /href="([^"]*theme-paper[^"]*)"/.exec(html)[1];
  assert.equal(
    nameOf(await readFile(path.join(dir, 'd1', 'a.html'), 'utf8')),
    nameOf(await readFile(path.join(dir, 'd2', 'a.html'), 'utf8')),
    'the same CSS must produce the same name, or nothing is ever cached'
  );

  // a real change of CSS must produce a different name
  const three = await build(src(dir, 'a.tex'), {
    out: path.join(dir, 'd3'), theme: 'paper', quiet: true,
    tokens: { accent: '#f0f' },
  });
  assert.notEqual(
    nameOf(await readFile(path.join(dir, 'd3', 'a.html'), 'utf8')),
    nameOf(await readFile(path.join(dir, 'd1', 'a.html'), 'utf8')),
    'different CSS must produce a different name'
  );
  assert.ok(three.pages);
});
