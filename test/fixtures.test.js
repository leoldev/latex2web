import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { build } from '../src/index.js';
import { createParseState, parseDocument, parseInlineText } from '../src/parse.js';
import { renderBlocks } from '../src/render.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'l2w-fx-'));

// NB: inside String.raw a backslash is literal, so these templates use single
// backslashes throughout — `\\input` there would be two, which is not LaTeX.
const html = (tex, ctx = {}) =>
  renderBlocks(parseDocument(tex).blocks, { parseCell: parseInlineText, assetUrl: (i) => `assets/${i}`, ...ctx });

// A leading boundary matters: `style="..."` otherwise matches inside
// `font-style="italic"`, which the SVG wordmark introduced.
const attr = (out, name) => new RegExp(`(?<![-\\w])${name}="([^"]*)"`).exec(out)?.[1];

// ------------------------------------------------------------------ \verb

test('\\verb takes its content literally, whatever the delimiter', () => {
  const out = html(String.raw`Use \verb|\input{foo}| and \verb*!% \begin{itemize}! and \verb+#+ here.`);
  assert.match(out, /<code>\\input\{foo\}<\/code>/);
  assert.match(out, /<code>% \\begin\{itemize\}<\/code>/);
  assert.match(out, /<code>#<\/code>/);
});

test('\\verb content is escaped, never interpreted as markup', () => {
  const out = html(String.raw`\verb|<script>alert("x")</script>|`);
  assert.match(out, /&lt;script&gt;/);
  assert.doesNotMatch(out, /<script>/);
});

test('\\verb cannot smuggle an \\input into the document', async () => {
  // Includes inside \verb are literal text: `\verb|\input{secret}|` is never
  // resolved as a real include.
  const root = await tmp();
  await writeFile(path.join(root, 'secret.tex'), '\\section{Leaked}\\label{s:leak}');
  await writeFile(path.join(root, 'main.tex'),
    '\\begin{document}\nLiterally \\verb|\\input{secret}| and nothing else.\n\\end{document}');

  await build(path.join(root, 'main.tex'), { out: path.join(root, 'dist'), quiet: true });
  const page = await readFile(path.join(root, 'dist', 'main.html'), 'utf8');
  assert.doesNotMatch(page, /Leaked/, 'an included file must not be pulled in through \\verb');
  assert.doesNotMatch(page, /was not resolved/);
  assert.match(page, /<code>\\input\{secret\}<\/code>/);
});

test('an unterminated \\verb degrades instead of throwing', () => {
  assert.ok(html(String.raw`Broken \verb|never closed`).length > 0);
});

// ---------------------------------------------------------------- longtable

test('longtable renders its rows instead of vanishing', () => {
  const out = html(String.raw`
    \begin{longtable}{ll}
      \hline
      A & 1 \\
      \hline
      B & 2 \\
      \hline
    \end{longtable}
  `);
  assert.match(out, /<table>/);
  // the first row is promoted to the header, so the body carries two cells
  assert.equal((out.match(/<td>/g) || []).length, 2);
  assert.equal((out.match(/<th>/g) || []).length, 2);
  assert.match(out, /A/);
  assert.match(out, /B/);
});

test('longtable repeat and rule commands are dropped', () => {
  const out = html(String.raw`
    \begin{longtable}{lc}
      \toprule
      Key & Value \\
      \midrule
      \endhead
      alpha & 1 \\
      \bottomrule
      \endfoot
    \end{longtable}
  `);
  const text = out.replace(/<[^>]+>/g, ' ');
  assert.match(text, /Key/);
  assert.match(text, /alpha/);
  assert.doesNotMatch(text, /toprule|midrule|endhead|bottomrule|endfoot/);
});

test('booktabs and multicolumn still render', () => {
  const out = html(String.raw`
    \begin{tabular}{ll}\toprule
    A & B \\ \midrule
    \multicolumn{2}{c}{span} \\ \bottomrule
    \end{tabular}
  `);
  assert.match(out, /colspan="2"/);
  assert.match(out, />span</);
  assert.doesNotMatch(out, /toprule|multicolumn/);
});

// ------------------------------------------------------------------- images

test('includegraphics sizing is honoured', () => {
  const cases = [
    [String.raw`width=0.5\linewidth`, 'width:50%'],
    [String.raw`width=\textwidth`, 'width:100%'],
    [String.raw`width=2in`, 'width:2in'],
    [String.raw`height=3cm`, 'height:3cm'],
    // `scale` multiplies the natural size; it is not a percentage of the column.
    // It is applied *and* published: the stylesheet divides its height limit by
    // the published value, so the limit bounds what the reader sees.
    [String.raw`scale=0.8`, 'zoom:0.8;--fig-zoom:0.8'],
  ];
  for (const [option, expected] of cases) {
    const out = html(String.raw`\begin{figure}\includegraphics[${option}]{x.png}\end{figure}`);
    assert.equal(attr(out, 'style'), expected, `${option} should size the image`);
  }
});

test('PDF-only graphics options are ignored rather than guessed at', () => {
  const out = html(String.raw`\begin{figure}\includegraphics[trim=0 0 0 0,clip,width=0.4\linewidth]{x.png}\end{figure}`);
  assert.equal(attr(out, 'style'), 'width:40%');
  assert.doesNotMatch(out, /trim|clip/);
});

test('an image with no options carries no style attribute', () => {
  const out = html(String.raw`\begin{figure}\includegraphics{x.png}\end{figure}`);
  assert.match(out, /<img src="assets\/x\.png"/);
  assert.equal(attr(out, 'style'), undefined);
});

test('a missing image is reported in the page, not as a broken <img>', async () => {
  const root = await tmp();
  await writeFile(path.join(root, 'main.tex'),
    '\\begin{document}\n\\begin{figure}\\includegraphics{gone.png}\\caption{Lost.}\\end{figure}\n\\end{document}');

  await build(path.join(root, 'main.tex'), { out: path.join(root, 'dist'), quiet: true });
  const page = await readFile(path.join(root, 'dist', 'main.html'), 'utf8');
  assert.doesNotMatch(page, /<img[^>]*gone\.png/, 'must not emit an <img> pointing at nothing');
  assert.match(page, /class="missing-asset"/);
  assert.match(page, /gone\.png/);
  assert.match(page, /image not found/);
});

test('a missing image is also reported on stderr', async () => {
  const root = await tmp();
  await writeFile(path.join(root, 'main.tex'),
    '\\begin{document}\n\\begin{figure}\\includegraphics{gone.png}\\end{figure}\n\\end{document}');
  const written = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  try {
    await build(path.join(root, 'main.tex'), { out: path.join(root, 'dist'), quiet: true });
  } finally {
    process.stderr.write = real;
  }
  assert.match(written.join(''), /image not found: gone\.png/);
});

test('a present image is copied and referenced at its requested size', async () => {
  const root = await tmp();
  await writeFile(path.join(root, 'plot.png'), 'x');
  await writeFile(path.join(root, 'main.tex'),
    '\\begin{document}\n\\begin{figure}\\includegraphics[width=0.5\\linewidth]{plot.png}\\caption{P}\\end{figure}\n\\end{document}');

  const result = await build(path.join(root, 'main.tex'), { out: path.join(root, 'dist'), quiet: true });
  assert.equal(result.assets, 1);
  const page = await readFile(path.join(root, 'dist', 'main.html'), 'utf8');
  assert.match(page, /src="assets\/plot\.png"/);
  assert.equal(attr(page, 'style'), 'width:50%');
});

test('an image reached by a longer path keeps its basename', async () => {
  const root = await tmp();
  await writeFile(path.join(root, 'fig.png'), 'x');
  await writeFile(path.join(root, 'main.tex'),
    '\\begin{document}\n\\begin{figure}\\includegraphics{figures/../fig.png}\\end{figure}\n\\end{document}');

  await build(path.join(root, 'main.tex'), { out: path.join(root, 'dist'), quiet: true });
  assert.match(await readFile(path.join(root, 'dist', 'main.html'), 'utf8'), /src="assets\/fig\.png"/);
});

// ------------------------------------------------------- chemistry & figures

test('mhchem is rendered when the document uses it', () => {
  for (const tex of [String.raw`$\ce{2H2 + O2 -> 2H2O}$`, String.raw`$\pu{123 kJ}$`]) {
    const out = html(tex);
    assert.match(out, /class="katex"/, tex);
    assert.doesNotMatch(out, /katex-error/, tex);
  }
});

test('mhchem is not needed, and not loaded, for ordinary math', () => {
  const out = html(String.raw`$x^2 + y^2 = z^2$`);
  assert.match(out, /class="katex"/);
  assert.doesNotMatch(out, /katex-error/);
});

test('Asymptote gets the same honest treatment as TikZ', () => {
  const out = html(String.raw`\begin{asy}\draw((0,0)--(2,2));\end{asy}`);
  assert.match(out, /tikz-block/);
  assert.match(out, /Asymptote/);
  assert.match(out, /not rendered to SVG/);
  // the source is shown, escaped, inside a <pre>
  assert.match(out, /<pre class="tikz-src">\\draw\(\(0,0\)/);
});

test('TikZ still reports itself as TikZ', () => {
  const out = html(String.raw`\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}`);
  assert.match(out, /TikZ drawing/);
});

test('siunitx formats a quantity with its unit', () => {
  const out = html(String.raw`Speed is \SI{9.81}{m/s^2} here.`);
  assert.match(out, /class="katex"/);
  assert.doesNotMatch(out, /\\SI|9\.81m/);
});

test('an unknown package macro is not silently rendered as prose', () => {
  // chemfig needs a real LaTeX run; the honest outcome is a visible marker
  const out = html(String.raw`\chemfig{H-C(-[2]H)(-[6]H)-C(=O)-[::60]O-H}`);
  const text = out.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, /chemfig\{/); // the macro name itself is consumed
});

// ------------------------------------------------- unterminated environments

test('an unterminated environment is reported, not silently swallowed', () => {
  const doc = parseDocument('\\begin{lstlisting}[language=Python]\nx = 1\n\\section{After}');
  assert.equal(doc.warnings.length, 1);
  assert.match(doc.warnings[0], /unterminated \\begin\{lstlisting\}/);
});

test('a terminated environment produces no warning', () => {
  const doc = parseDocument('\\begin{lstlisting}\nx = 1\n\\end{lstlisting}\n\\section{After}');
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(doc.blocks.map((b) => b.type), ['code', 'section']);
});

test('a build surfaces parser warnings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'l2w-warn-'));
  await writeFile(path.join(root, 'main.tex'), '\\begin{lstlisting}\nx = 1\n\\section{After}');
  const result = await build(path.join(root, 'main.tex'), { out: path.join(root, 'dist'), quiet: true });
  assert.ok(result.warnings.some((w) => /unterminated/.test(w)));
});

// --------------------------------------------------- maths in plain contexts

test('latexToPlain renders symbols a navigation list can show', async () => {
  const { latexToPlain } = await import('../src/parse.js');
  assert.equal(latexToPlain('\\alpha_i'), 'αᵢ');
  assert.equal(latexToPlain('\\rho'), 'ρ');
  assert.equal(latexToPlain('x^2 + y^2'), 'x² + y²');
  assert.equal(latexToPlain('\\sqrt{2}'), '√2');
  assert.equal(latexToPlain('\\frac{a}{b}'), 'a/b');
  assert.equal(latexToPlain('e^{i\\pi} + 1 = 0'), 'eⁱπ + 1 = 0');
  assert.doesNotMatch(latexToPlain('\\alpha_i'), /\\/);
});

test('a section title containing maths gets a readable label', () => {
  const doc = parseDocument('\\section{The condition on the $\\alpha_i$}');
  assert.equal(doc.blocks[0].title, 'The condition on the αᵢ');
  assert.equal(doc.blocks[0].id, 'section-the-condition-on-the-alpha-i');
});

// --------------------------------------------------------- figure delegation

test('a drawing is compiled when a TeX engine is available', async (t) => {
  const { detect } = await import('../src/figures.js');
  const cap = await detect({ engine: 'auto' });
  if (!cap.engine || !cap.raster) {
    t.skip(`no TeX engine on this machine (${cap.reason})`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'l2w-fig-'));
  await writeFile(path.join(root, 'm.tex'),
    '\\begin{document}\n\\begin{figure}\n\\begin{tikzpicture}\n'
    + '\\draw[thick,->] (0,0) -- (2,1) node[right] {$x$};\n\\end{tikzpicture}\n'
    + '\\caption{A vector.}\n\\end{figure}\n\\end{document}');

  const result = await build(path.join(root, 'm.tex'), {
    out: path.join(root, 'dist'),
    quiet: true,
    figures: { delegate: true, engine: 'auto' },
  });
  assert.equal(result.warnings.length, 0, 'delegation should not warn when it succeeds');
  const page = await readFile(path.join(root, 'dist', 'm.html'), 'utf8');
  assert.match(page, /<img[^>]*src="assets\/fig-m-1\.png"/, 'the picture should be an image');
  assert.doesNotMatch(page, /tikz-block/, 'the source block should be gone');
  await readFile(path.join(root, 'dist', 'assets', 'fig-m-1.png')); // must exist
});

test('--clear-cache removes the figure cache before building', async () => {
  // The cache is keyed by output name, so a drawing whose source changes under
  // an unchanged name keeps its old picture. The flag is the escape hatch, and
  // it runs before anything reads the cache.
  const root = await mkdtemp(path.join(os.tmpdir(), 'l2w-clear-'));
  await writeFile(path.join(root, 'm.tex'),
    '\\begin{document}\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}\\end{document}');
  const out = path.join(root, 'dist');
  await build(path.join(root, 'm.tex'), { out, quiet: true });

  const cache = path.join(out, '.figures');
  const before = existsSync(cache) ? (await readdir(cache)).length : 0;
  assert.ok(before > 0, 'the first build should have populated the cache');

  await build(path.join(root, 'm.tex'), { out, quiet: true, clearCache: true });
  assert.ok(existsSync(cache), 'the build should repopulate the cache it cleared');

  // A stale file that no build would ever write must not survive.
  await writeFile(path.join(cache, 'stale-not-a-figure.png'), 'x');
  await build(path.join(root, 'm.tex'), { out, quiet: true, clearCache: true });
  assert.ok(!existsSync(path.join(cache, 'stale-not-a-figure.png')), 'the stale entry survived -- clear-cache ran too late');
});

test('--clear-cache is safe when there is no cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'l2w-nocache-'));
  await writeFile(path.join(root, 'm.tex'), '\\begin{document}Hello\\end{document}');
  const out = await build(path.join(root, 'm.tex'), { out: path.join(root, 'dist'), quiet: true, clearCache: true });
  assert.equal(out.pages, 1, 'clearing an absent cache should not fail the build');
});

test('delegation off leaves the drawing as clearly-labelled source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'l2w-nosvg-'));
  await writeFile(path.join(root, 'm.tex'),
    '\\begin{document}\n\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n\\end{document}');
  await build(path.join(root, 'm.tex'), {
    out: path.join(root, 'dist'),
    quiet: true,
    figures: { delegate: false },
  });
  const page = await readFile(path.join(root, 'dist', 'm.html'), 'utf8');
  assert.match(page, /tikz-block/);
  assert.match(page, /source shown, not rendered to SVG/);
  assert.doesNotMatch(page, /<img/);
});

test('`figures: false` opts out without discarding the rest of the object', async () => {
  // `figures: false` flips only `delegate`; a dpi or timeout set alongside it
  // survives.
  const { loadConfig } = await import('../src/config.js');
  const cfg = await loadConfig({ cwd: process.cwd() });
  assert.equal(cfg.figures.delegate, true, 'delegation should be on by default');
  const off = await loadConfig({ cwd: process.cwd(), cli: { figures: { dpi: 300, delegate: false } } });
  assert.equal(off.figures.delegate, false);
  assert.equal(off.figures.dpi, 300, 'opting out must not reset the sibling settings');
});

test('a drawing body is re-wrapped so it compiles', async () => {
  const { standaloneFor } = await import('../src/figures.js');
  const out = standaloneFor({ tex: '\\draw (0,0) -- (1,1);', options: 'scale=0.9', dialect: 'TikZ' });
  assert.match(out, /\\begin\{tikzpicture\}\[scale=0\.9\]/, 'options must be reapplied');
  assert.match(out, /\\draw \(0,0\) -- \(1,1\);/);
  assert.match(out, /\\end\{document\}/);
});

test('a tikzpicture options argument is not left in the body', () => {
  // tikzpicture options belong to the wrapper, never the body: `[scale=0.9]` at
  // the top of a body is a TeX error.
  const doc = parseDocument('\\begin{tikzpicture}[scale=0.9]\n\\draw (0,0)--(1,1);\n\\end{tikzpicture}');
  const block = doc.blocks.find((b) => b.type === 'tikz');
  assert.equal(block.options, 'scale=0.9');
  assert.ok(!block.tex.startsWith('['), 'the options must not remain in the body');
});

// ----------------------------------------------- shapes met in real input
// Found by running the converter over a real document (Fleuret's
// attention.tex) rather than by writing a fixture first.

test('a starred environment is closed by its own starred end tag', () => {
  // The starred end tag closes its own environment, or the rest of the file is
  // swallowed as its body.
  const doc = parseDocument(
    '\\begin{align*} a &= b \\\\ c &= d \\end{align*}\n\nAfter the environment.\n'
  );
  assert.deepEqual(doc.warnings, [], 'no unterminated-environment warning');
  assert.ok(
    doc.blocks.some((b) => b.type === 'math'),
    'the align* body should be a maths block'
  );
  const text = JSON.stringify(doc.blocks);
  assert.match(text, /After the environment/, 'content after the env must survive');
});

test('a drawing written inside a paragraph is found', () => {
  // A drawing inside a paragraph is still found: the inline scanner must reach
  // the backslash of `\begin`, or the picture is skipped entirely.
  const doc = parseDocument(
    '\\makebox[\\textwidth][c]{\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}}\n'
  );
  const found = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'tikz') found.push(n);
      walk(n.blocks);
      walk(n.nodes);
    }
  };
  walk(doc.blocks);
  assert.equal(found.length, 1, 'the picture inside \\makebox must be found');
});

test('a picture nested in a node does not suppress the outer wrapper', async () => {
  // A picture nested in a node still needs the outer wrapper: without it the
  // drawing compiles with no picture around it, a TeX error at the first
  // `\node`.
  const { standaloneFor } = await import('../src/figures.js');
  const body = '\\node (V) at (0,0) { \\begin{tikzpicture}\\draw (0,0) rectangle (1,1);\\end{tikzpicture} };';
  const out = standaloneFor({ tex: body, options: '', dialect: 'TikZ' });
  const pictures = out.match(/\\begin\{tikzpicture\}/g) || [];
  assert.equal(pictures.length, 2, 'outer picture plus the nested one');
  assert.ok(
    out.indexOf('\\begin{tikzpicture}') < out.indexOf('\\node'),
    'the outer picture must open before the first command'
  );
});

test('a plain draw body is not wrapped in an axis', async () => {
  // A plain `\draw` body compiles unwrapped: an axis with no plot data is an
  // empty figure with default 0-1 axes.
  const { standaloneFor } = await import('../src/figures.js');
  const out = standaloneFor({ tex: '\\draw (0,0) -- (1,1);', options: '', dialect: 'TikZ' });
  assert.doesNotMatch(out, /\\begin\{axis\}/, 'no axis without plot data');
});

test('plot data still gets an axis', async () => {
  const { standaloneFor } = await import('../src/figures.js');
  const out = standaloneFor({ tex: '\\addplot coordinates {(0,1) (1,2)};', options: '', dialect: 'TikZ' });
  assert.match(out, /\\begin\{axis\}/);
});

test('beamer overlays are flattened to their visible content', async () => {
  // A static image has no overlays to step through, so the composition is drawn.
  const { flattenOverlays, standaloneFor } = await import('../src/figures.js');
  assert.equal(flattenOverlays('\\uncover<2,4,6->{\\draw (0,0)--(1,1);}'), '{\\draw (0,0)--(1,1);}');
  assert.equal(flattenOverlays('\\only<1|2>{\\node (a) at (0,0) {};}'), '{\\node (a) at (0,0) {};}');
  // The preamble carries definitions only for forms the rewrite misses: a body
  // whose overlays were all stripped carries none.
  const flat = standaloneFor({ tex: '\\uncover<2>{x}', options: '', dialect: 'TikZ' });
  assert.doesNotMatch(flat, /def\\uncover/, 'nothing left to define once the body is flattened');

  // `\visible<2>` with no group is not a form the rewrite claims to handle.
  const missed = standaloneFor({ tex: '\\visible<2>x', options: '', dialect: 'TikZ' });
  assert.match(missed, /def\\uncover/, 'so a missed form still gets the definitions');
});

test('a delegated drawing keeps the caption of the figure around it', async () => {
  // Replacing the inner tikz block with an image must not nest a figure in a
  // figure: caption and label stay on the outer figure.
  const { renderDrawings } = await import('../src/figures.js');
  const pages = [{
    outName: 'doc',
    doc: {
      blocks: [
        {
          type: 'figure',
          blocks: [{ type: 'tikz', tex: '\\draw (0,0)--(1,1);', options: '', dialect: 'TikZ' }],
          label: 'fig:x',
        },
      ],
    },
  }];
  const nodePath = await import('node:path');
  const nodeOs = await import('node:os');
  try {
    await renderDrawings(pages, {
      opts: { figures: { delegate: true, dpi: 50, width: '100%' } },
      outDir: nodePath.join(nodeOs.tmpdir(), 'l2w-nocache-' + Date.now()),
    });
  } catch {
    // an engine may be absent; the structural assertion below is what matters
  }
  const fig = pages[0].doc.blocks[0];
  assert.equal(fig.type, 'figure', 'the outer figure stays a figure');
  assert.equal(fig.label, 'fig:x', 'label survives');
  assert.ok(fig.blocks.length === 0, 'the inner drawing is replaced by the image');
});

// --------------------------------------------- shapes met in real papers
// Found by converting Attention Is All You Need (arXiv:1706.03762, multi-file
// with a NIPS style file) and Perelman's Ricci flow paper (arXiv:math/0211159).

test('a macro definition is not content', async () => {
  // Macro definitions are not content: papers keep macros in a header pulled in
  // with \input, and a definition body must never print into the page.
  const src = [
    '\\def\\decktitle{Attention Mechanisms}',
    '\\newcommand{\\scalelines}[6]{%',
    '  \\draw[line width=0.75pt,yshift=3pt] (#1, #2) -- (11.6, #2);',
    '}',
    '',
    'Real prose.',
  ].join('\n');
  const text = JSON.stringify(parseDocument(src).blocks);
  assert.doesNotMatch(text, /draw\[/, 'a definition body must not be printed');
  assert.doesNotMatch(text, /yshift/, 'nor its options');
  assert.doesNotMatch(text, /Mechanisms\}?/, 'and not the tail of a braced argument');
  assert.match(text, /Real prose/);
});

test('an unknown macro does not eat the following word', () => {
  // An unknown macro is skipped without moving the cursor: the word after it
  // must survive intact.
  const text = JSON.stringify(parseDocument('Before \\foo after.').blocks);
  assert.match(text, /after/, 'the word after an unknown macro must survive');
});

test('includegraphics is resolved the way graphicx resolves it', async () => {
  // graphicx finds the extension, so authors write `{Figures/architecture}` and
  // a name without one resolves instead of reporting a missing image.
  const { resolveGraphic } = await import('../src/figures.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'l2w-graphic-'));
  await writeFile(path.join(dir, 'arch.png'), 'x');
  await writeFile(path.join(dir, 'vector.pdf'), 'x');
  assert.equal(resolveGraphic('arch', dir), path.join(dir, 'arch.png'));
  assert.equal(resolveGraphic('arch.png', dir), path.join(dir, 'arch.png'));
  assert.equal(resolveGraphic('vector', dir), path.join(dir, 'vector.pdf'));
  assert.equal(resolveGraphic('nope', dir), null);
});

test('a float can hold more than one picture', () => {
  // A float holds every picture: a two-column `figure*` stacks two images and
  // both survive.
  const doc = parseDocument(
    '\\begin{figure*}'
    + '{A}{\\includegraphics[width=\\textwidth, trim=0 0 0 36, clip]{one.pdf}}'
    + '{\\includegraphics[width=\\textwidth, trim=0 0 0 37, clip]{two.pdf}}'
    + '\\caption{Two}\\label{fig:two}\\end{figure*}'
  );
  const fig = doc.blocks.find((b) => b.type === 'figure');
  assert.equal(fig.images.length, 2, 'both pictures are kept');
  assert.equal(fig.images[0].name, 'one.pdf');
  assert.deepEqual(fig.images[0].opts.trim, [0, 0, 0, 36], 'trim is in left/bottom/right/top order');
  assert.equal(fig.images[1].opts.clip, true);
});

test('includegraphics in prose is kept as a picture', () => {
  // `\includegraphics` in prose is kept as a picture even where no float case
  // matches, e.g. inside a `minipage`.
  const doc = parseDocument('Text \\includegraphics[width=3cm]{a/b.png} more.');
  const nodes = doc.blocks[0].nodes;
  const img = nodes.find((n) => n.type === 'image');
  assert.ok(img, 'the picture must survive');
  assert.equal(img.src, 'a/b.png');
});

test('math environments KaTeX lacks are mapped, not dropped', () => {
  // Maths environments KaTeX lacks are mapped to ones it has
  // (multline to gather); the equation must not reach KaTeX verbatim.
  for (const [env, expected] of [['multline', 'gather'], ['flalign', 'align'], ['eqnarray', 'align']]) {
    const doc = parseDocument(`\\begin{${env}} a=b \\\\ c=d \\end{${env}}`);
    const m = doc.blocks.find((b) => b.type === 'math');
    assert.ok(m, `${env} should produce a maths block`);
    assert.ok(m.tex.includes(`\\begin{${expected}}`), `${env} maps to ${expected}, got ${m.tex}`);
  }
  // alignat keeps its column count, which is part of its syntax
  const at = parseDocument('\\begin{alignat}{2} a &= b & c &= d \\end{alignat}')
    .blocks.find((b) => b.type === 'math');
  assert.match(at.tex, /\\begin\{alignat\}\{2\}/);
});

test('an alignment whose last row omits the terminator still renders', () => {
  // LaTeX allows the final alignment row to omit `\\`; KaTeX rejects the whole
  // environment without it, so a terminator is added to the last row.
  const doc = parseDocument(
    '\\begin{align*}\nA_i & = x \\\\\nY_i & = V A_i,\n\\end{align*}'
  );
  const m = doc.blocks.find((b) => b.type === 'math');
  assert.ok(m.tex.includes('A_i, ' + '\\\\'), 'a terminator is added to the last row');
});

test('a beamer frame is a structural unit', () => {
  // Each beamer frame is a structural unit with its own anchor: 31 frames must
  // not collapse into one wall of text.
  const doc = parseDocument([
    '\\begin{frame}{Attention}',
    'Given a query $Q$ and a key $K$.',
    '\\end{frame}',
    '',
    '\\begin{frame}[fragile]{}{}',
    'No title here, but a container is still right.',
    '\\end{frame}',
  ].join('\n'));
  const frames = doc.blocks.filter((b) => b.type === 'section' && b.kind === 'frame');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].title, 'Attention', 'the mandatory argument is the title');
  assert.ok(frames[0].blocks.length, 'and the body is kept');
  assert.ok(frames[1].untitled, 'an empty title stays untitled rather than blank');
  assert.ok(frames[1].id, 'but it still gets an anchor');
});

test('a frametitle is read too', () => {
  const doc = parseDocument('\\begin{frame}\\frametitle{Values}\\end{frame}');
  assert.equal(doc.blocks[0].title, 'Values');
});

// ------------------------------- shapes invisible in the HTML, obvious on
// screen

test('a heading owns the blocks that follow it', async () => {
  // A heading owns the blocks that follow it: the paragraph renders inside the
  // section that introduced it, closed before the next one opens.
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument('\\section{One}\n\nFirst.\n\n\\section{Two}\n\nSecond.');
  const html = renderBlocks(doc.blocks);
  assert.match(html, /<section[^>]*>[\s\S]*First\.[\s\S]*<\/section>/,
    'the paragraph belongs to the section that introduced it');
  assert.equal((html.match(/<section/g) || []).length, 2);
  // each section closes before the next one opens, so neither text leaks across
  assert.equal((html.match(/<\/section>/g) || []).length, 2);
  assert.ok(html.indexOf('First.') < html.indexOf('</section>'));
  assert.ok(html.indexOf('Second.') > html.indexOf('</section>'));
});

test('maketitle renders the title', () => {
  // `\maketitle` survives parsing, so a document renders its title.
  const doc = parseDocument('\\title{A Paper}\n\\author{Someone}\n\n\\maketitle\n\nBody.');
  assert.ok(doc.blocks.some((b) => b.type === 'maketitle'), 'the command survives');
  assert.equal(doc.meta.title, 'A Paper');
});

test('texorpdfstring renders its first argument', async () => {
  // hyperref's two-argument idiom renders its first argument only; printing
  // both branches doubles the title.
  const doc = parseDocument('\\title{\\texorpdfstring{$\\lambda$tex2web}{lambda2web}}');
  assert.equal(doc.meta.title.replace(/\$\\lambda\$/, 'λ'), 'λtex2web');
});

test('a colour command does not print its colour', () => {
  // A colour command prints no colour: its argument is consumed, never typeset.
  const text = JSON.stringify(parseDocument('\\color{red}\n\\large Real text.').blocks);
  assert.doesNotMatch(text, /red/);
  assert.match(text, /Real text/);
});

test('a percent comment is not content', () => {
  // A percent comment is not content: commented-out material, marker and all,
  // is dropped.
  const text = JSON.stringify(parseDocument('Kept.\n% \\footnote{dropped}').blocks);
  assert.doesNotMatch(text, /footnote|%/);
  assert.match(text, /Kept/);
});

test('a percent inside code and \\\\verb is left alone', () => {
  const doc = parseDocument('\\begin{verbatim}\n100% sure % kept\n\\end{verbatim}');
  assert.match(doc.blocks.find((b) => b.type === 'code').tex, /100% sure % kept/);
});

test('the contents stops before paragraph headings', async () => {
  // The contents stops before paragraph headings: sixty entries is a list of
  // the document, not a way into it.
  const { buildToc } = await import('../src/render.js');
  const doc = parseDocument(
    '\\section{A}\n\\subsection{A1}\n\\subsubsection{A1a}\n\\paragraph{A1a i}\nText.'
  );
  const flatten = (nodes) => nodes.flatMap((n) => [n.title, ...flatten(n.children)]);
  assert.deepEqual(flatten(buildToc(doc.blocks)), ['A', 'A1', 'A1a']);
});

// --------------------------------------------- the paper's own notation (viii)
test('a macro defined in the preamble is expanded in maths', async () => {
  // Preamble definitions are recorded for maths: a paper's own notation
  // expands, and never reaches KaTeX as literal characters.
  const st = createParseState();
  parseDocument(
    '\\newcommand{\\dmodel}{d_{\\text{model}}}\n\\begin{document}\nWith $\\dmodel=512$.\n\\end{document}',
    null, st
  );
  assert.ok(st.macros.has('dmodel'), 'the definition is recorded');
  const { expandMacros } = await import('../src/macros.js');
  assert.equal(expandMacros('\\dmodel = 512', st.macros), 'd_{\\text{model}} = 512');
});

test('a parameterised macro takes its arguments', async () => {
  const { readDefinition, expandMacros } = await import('../src/macros.js');
  const macros = new Map();
  for (const src of [
    '\\newcommand{\\mbf}[1]{\\mathbf{#1}}',
    '\\newcommand\\concat[3]{\\left[#1 \\parallel_#3 #2\\right]}',
    '\\def\\twice#1{#1#1}',
  ]) {
    const cmd = src.slice(1).match(/^[a-zA-Z]+/)[0];
    const d = readDefinition(src, 1 + cmd.length, cmd);
    macros.set(d.name, { params: d.params, body: d.body });
  }
  assert.equal(expandMacros('\\mbf{Q}', macros), '\\mathbf{Q}');
  assert.equal(expandMacros('\\concat{a}{b}{c}', macros), '\\left[a \\parallel_c b\\right]');
  assert.equal(expandMacros('\\twice{x}', macros), 'xx');
});

test('DeclareMathOperator and the starred forms are read', async () => {
  const { readDefinition } = await import('../src/macros.js');
  const cmd = '\\DeclareMathOperator';
  const plain = readDefinition(`${cmd}{\\Rank}{rank}`, cmd.length, 'DeclareMathOperator');
  assert.equal(plain.name, 'Rank');
  assert.equal(plain.body, '\\operatorname{rank}');
  // the star sits between the command word and the name, so the reader has to
  // start at the command word for it to be visible
  const star = readDefinition(`${cmd}*{\\argmax}{arg\\,max}`, cmd.length, 'DeclareMathOperator');
  assert.equal(star.name, 'argmax');
  assert.equal(star.body, '\\operatorname*{arg\\,max}');
});

test('a macro that expands to itself terminates', async () => {
  const { expandMacros } = await import('../src/macros.js');
  const macros = new Map([['loop', { params: 0, body: 'x + \\loop' }]]);
  assert.ok(expandMacros('\\loop', macros).length < 200, 'expansion is depth-limited');
});

test('an unknown macro is left exactly as written', async () => {
  const { expandMacros } = await import('../src/macros.js');
  assert.equal(expandMacros('\\notdefined x', new Map()), '\\notdefined x');
});

test('a citation is a link to a reference entry', async () => {
  // A citation is a link and the document gains a reference list, so every
  // marker on the page is followable.
  const { resolveAll } = await import('../src/parse.js');
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`Recurrent \citep{hochreiter1997} and \citep{gruEval14}.`);
  resolveAll(doc.blocks, doc.labels);
  const html = renderBlocks(doc.blocks);
  assert.match(html, /class="citeref"/, 'the marker is a citation');
  assert.match(html, /href="#ref-hochreiter1997"/);
  assert.match(html, /class="references"/, 'a reference list is appended');
  assert.match(html, /id="ref-grueval14"/, 'the anchor is slugified');
});

test('a citation inside a table cell is not left empty', async () => {
  // Cells keep their source and are parsed at render time, after references
  // resolve, so a citation in a cell must still link rather than render empty.
  const { resolveAll } = await import('../src/parse.js');
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`\begin{tabular}{ll}\na & \citep{key} \\\end{tabular}`);
  resolveAll(doc.blocks, doc.labels);
  const html = renderBlocks(doc.blocks, { parseCell: (t) => [{ type: 'text', value: t }] });
  assert.doesNotMatch(html, /class="cite"><\/span>/, 'no empty marker is left');
  assert.match(html, /href="#ref-key"/, 'and it links like any other citation');
});

test('the reference list says why it is only keys', async () => {
  const { resolveAll } = await import('../src/parse.js');
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`Something \cite{a}.`);
  resolveAll(doc.blocks, doc.labels);
  const html = renderBlocks(doc.blocks);
  assert.match(html, /class="ref-note"/);
  assert.match(html, /BibTeX/, 'it explains that no bibliography was available');
  assert.match(html, /misattribute/, 'and why nothing is invented');
});

test('a multi-key citation separates its markers, and only between them', async () => {
  // The separator goes between markers only: the source's own full stop must
  // not read as "[a], [b], ."
  const { resolveAll } = await import('../src/parse.js');
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`See \citep{a,b,c}.`);
  resolveAll(doc.blocks, doc.labels);
  const html = renderBlocks(doc.blocks);
  assert.ok(html.includes('>[a]</a>, <a'), 'markers are separated by a comma');
  assert.ok(!html.includes('[c]</a>, '), 'and there is none after the last marker');
});

// ------------------------------------- drawings compiled in the document's dialect
// A picture is compiled on its own, so anything it was written against has to
// travel with it. Every one of these came from Fleuret's lecture.

test('a macro whose body holds an environment is spliced in', () => {
  // A macro holding an environment splices its picture in: the definition is
  // parsed, not thrown away with its drawing.
  const st = createParseState();
  const doc = parseDocument(String.raw`
\newcommand{\figattention}{\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}}
\begin{document}\figattention\end{document}`, null, st);
  let tikz = 0;
  const walk = (ns) => { for (const n of ns || []) { if (n.type === 'tikz') tikz++; walk(n.blocks); walk(n.nodes); } };
  walk(doc.blocks);
  assert.equal(tikz, 1, 'the picture is parsed as a picture');
});

test('tikzset styles are carried into the standalone document', async () => {
  // tikzset styles travel with the picture: a node option means nothing without
  // the style the document declared in its header.
  const { readColorDefinition, collectDefinitions } = await import('../src/macros.js');
  const styles = [];
  collectDefinitions(String.raw`\tikzset{ value/.style={draw=black, fill=white} }`, new Map(), styles);
  assert.equal(styles.length, 1);
  assert.match(styles[0], /value\/\.style/);

  const { standaloneFor } = await import('../src/figures.js');
  const out = standaloneFor({ tex: '\\node[value] at (0,0) {$x$};', options: '', dialect: 'TikZ' }, { tikzStyles: styles });
  assert.match(out, /\\tikzset\{value\/\.style=/);
  // A comment-only style block compiles to an empty key list, and the closing
  // brace stays on the same line as the body: past a `%` it would be an orphan
  // with nothing to close, since `%` eats the newline.
  const commented = standaloneFor({ tex: '\\draw (0,0)--(1,1);', options: '', dialect: 'TikZ' },
    { tikzStyles: ['%% all commented out'] });
  assert.match(commented, /\\tikzset\{\}\n/, 'a comment-only block compiles to an empty key list');
  assert.doesNotMatch(commented, /%\n\}/, 'and never orphans a closing brace');
  for (const line of commented.split('\n')) {
    const open = (line.match(/\{/g) || []).length;
    const close = (line.match(/\}/g) || []).length;
    assert.ok(open >= close, `no line closes more braces than it opens: ${line}`);
  }
});

test('colour definitions are carried into the standalone document', async () => {
  // Colour definitions travel with the picture: drawings use colours xcolor
  // does not know, e.g. `\definecolor{darkred}{rgb}{0.75,0.0,0.0}`.
  const { collectDefinitions } = await import('../src/macros.js');
  const colors = [];
  collectDefinitions(String.raw`\definecolor{darkred}{rgb}{0.75,0.0,0.0}`, new Map(), [], colors);
  assert.deepEqual(colors, [String.raw`\definecolor{darkred}{rgb}{0.75,0.0,0.0}`]);

  const { standaloneFor } = await import('../src/figures.js');
  const out = standaloneFor({ tex: '\\draw[darkred] (0,0)--(1,1);', options: '', dialect: 'TikZ' }, { colors });
  assert.match(out, /\\definecolor\{darkred\}/);
  // the preamble must give xcolor the dvipsnames, without an option clash
  assert.match(out, /\\usepackage\[dvipsnames,svgnames\]\{xcolor\}/);
  assert.doesNotMatch(out, /\\documentclass\[tikz/);
});

test('a drawing is written in the document own macros', async () => {
  // A drawing compiles in the document's own macros: names it uses must be
  // defined in the standalone, e.g. `\transpose`.
  const { standaloneFor } = await import('../src/figures.js');
  const macros = new Map([['transpose', { params: 0, body: '^{\\top}' }]]);
  const out = standaloneFor({ tex: '\\node at (0,0) {$A\\transpose$};', options: '', dialect: 'TikZ' }, { macros });
  assert.match(out, /\^\{\\top\}/);
  assert.doesNotMatch(out, /\\transpose/);
});

test('beamer overlay commands are neutralised for a static picture', async () => {
  // `\mode<beamer>` is stripped from the body, never redefined in the preamble:
  // `\mode` is a TeX primitive.
  const { flattenOverlays, standaloneFor } = await import('../src/figures.js');
  assert.equal(flattenOverlays('\\uncover<2,5>{\\draw (0,0);}'), '{\\draw (0,0);}');
  // `\alt` is ambiguous and a fixed-arity definition runs away on the count it
  // did not expect, so both forms are stripped from the body and the preamble
  // carries nothing unneeded.
  assert.equal(flattenOverlays('\\mode<beamer>{\\draw (0,0)--(1,1);}'), '{\\draw (0,0)--(1,1);}');
  assert.equal(flattenOverlays('\\alt<presentation>{a}{b}'), 'a');
  assert.equal(flattenOverlays('\\alt<presentation>{a}'), 'a');

  const out = standaloneFor({ tex: '\\mode<beamer>{\\draw (0,0)--(1,1);}', options: '', dialect: 'TikZ' });
  assert.doesNotMatch(out, /def\\mode/, 'and the primitive is not redefined');
  assert.doesNotMatch(out, /def\\uncover/, 'nor anything else, when nothing needs it');

  // A form the rewrite misses still gets the definitions.
  const missed = standaloneFor({ tex: '\\visible<2>x', options: '', dialect: 'TikZ' });
  assert.match(missed, /def\\uncover/, 'a drawing with a missed overlay is still handled');
});

test("a beamer frame's optional argument is not content", () => {
  // beamer's shape is `\begin{frame}[<spec>]{<title>}`: the optional argument
  // comes after the environment name and is never content.
  const fragile = parseDocument(String.raw`\begin{frame}[fragile]{Attention}
Body.\end{frame}`).blocks[0];
  assert.equal(fragile.title, 'Attention');
  assert.doesNotMatch(JSON.stringify(fragile.blocks), /fragile/);

  const untitled = parseDocument(String.raw`\begin{frame}[fragile]{}{}
Body.\end{frame}`).blocks[0];
  assert.ok(untitled.untitled);
  assert.doesNotMatch(JSON.stringify(untitled.blocks), /fragile/);

  const subtitle = parseDocument(String.raw`\begin{frame}[c]{Title}{Sub}
Body.\end{frame}`).blocks[0];
  assert.equal(subtitle.title, 'Title');
  assert.doesNotMatch(JSON.stringify(subtitle.blocks), /Sub/);
});

// ------------------------------------------------------------- bibliographies
// A paper is only half converted without its references.

test('an inline thebibliography gives citations real numbers', async () => {
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}See \citep{second} and \citep{first}.
\begin{thebibliography}{9}
\bibitem{first} A. First. A first paper. Venue, 2020.
\bibitem{second} B. Second. A second paper. Venue, 2021.
\end{thebibliography}
\end{document}`);
  const html = renderBlocks(doc.blocks);
  // numbered in the order the bibliography lists them, not citation order
  assert.match(html, /href="#ref-second">\[2\]</);
  assert.match(html, /href="#ref-first">\[1\]</);
  assert.match(html, /A first paper/);
  assert.doesNotMatch(html, /ref-note/, 'a real bibliography needs no apology');
});

test('a .bib database beside the source is read', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const fssync = await import('node:fs');
  const p = await import('node:path');
  const dir = await fsp.mkdtemp(p.join(os.tmpdir(), 'l2w-bib-'));
  await fsp.writeFile(p.join(dir, 'refs.bib'),
    '@inproceedings{key1,\n  author = {A. Author and B. Other},\n  title = {A title},\n  booktitle = {NeurIPS},\n  year = {2017}\n}');
  const read = (t) => {
    const c = p.join(dir, t);
    return fssync.existsSync(c) ? fssync.readFileSync(c, 'utf8') : null;
  };
  const st = createParseState();
  const doc = parseDocument(
    String.raw`\begin{document}See \citep{key1}.\bibliography{refs}\end{document}`,
    null, st, read);
  assert.equal(doc.bibliography?.length, 1, 'the database is found and parsed');
  assert.equal(doc.bibliography[0].key, 'key1');
});

test('a hand-written References section is read', async () => {
  // Perelman writes his references as paragraphs each opening with [Label]
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}As shown in [B-Em] and [A].
\section*{References}
\ \ \ \ [A] M.T.Anderson. Scalar curvature and geometrization. MSRI, 1997.
\par
[B-Em] D.Bakry, M.Emery. Diffusions hypercontractives. Springer, 1985.
\end{document}`);
  const html = renderBlocks(doc.blocks);
  assert.match(html, /Diffusions hypercontractives/, 'the entries are kept');
  assert.match(html, /class="ref-num"/, 'and numbered');
});

test('an unresolved citation says so rather than inventing a number', async () => {
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`\begin{document}See \citep{nokey}.\end{document}`);
  const html = renderBlocks(doc.blocks);
  assert.match(html, /\[nokey\]</, 'the key is shown');
  assert.doesNotMatch(html, /ref-num/, 'no number was invented');
});

// ------------------------------------------------------------- admonitions

test('a warning is a banner and not a numbered theorem', async () => {
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}
\begin{theorem}[Main] First.\end{theorem}
\begin{warning} Attribution is required.\end{warning}
\begin{tip} Try \texttt{--base}.\end{tip}
\begin{theorem} Second.\end{theorem}
\end{document}`);
  const html = renderBlocks(doc.blocks);
  assert.match(html, /callout-tone-warn/);
  assert.match(html, /callout-tone-tip/);
  assert.match(html, /callout-kind">Warning/, 'it is titled, not numbered');
  // the shared amsthm counter must not have been spent on the warning, so the
  // theorems after it keep their own numbering
  const kinds = [...html.matchAll(/class="callout-kind">([^<]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(kinds, ['Theorem', 'Warning', 'Tip', 'Theorem']);
  assert.match(html, /id="theorem-1"/, 'the first theorem is theorem-1');
  assert.match(html, /id="theorem-2"/, 'and the next is theorem-2, not theorem-3');
});

test('a warning can carry its own title', async () => {
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}\begin{warning}[Attribution] Cite the paper.\end{warning}\end{document}`);
  assert.match(renderBlocks(doc.blocks), /callout-kind">Attribution/);
});

test('a tooltip carries its hint to a focusable element', async () => {
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}A \tooltip{five display levels}{multi-head} setup.\end{document}`);
  const html = renderBlocks(doc.blocks);
  // not an <a href>: an anchor with no href is not focusable, so the hint would
  // be unreachable from a keyboard
  assert.match(html, /<span class="tooltip" tabindex="0"/);
  assert.match(html, /title="five display levels"/);
  assert.match(html, />multi-head</);
});

// ------------------------------------------------------------ plain citations

test('a citation typed as text is linked when it names a real entry', async () => {
  // Perelman never calls \cite; his citations are typed
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}As shown in [B-Em] and [Cao-C].
\section*{References}
\ \ \  [B-Em] D.Bakry, M.Emery. Diffusions hypercontractives. Springer, 1985.
\ \ \  [Cao-C] H.-D. Cao, B.Chow. Recent developments. AMS, 1999.
\end{document}`);
  const html = renderBlocks(doc.blocks);
  assert.match(html, /href="#ref-b-em"/);
  assert.match(html, /href="#ref-cao-c"/);
  assert.match(html, /Diffusions hypercontractives/);
});

test('bracketed text that is not a reference is left alone', async () => {
  // [H 4] is a reference to Hamilton's numbered part, and [0,T) is a time
  // interval. Linking either sends the reader somewhere they did not ask for.
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}See [H 4] and the interval [0,T).
\section*{References}
\ \ \  [H] R. Hamilton. Ricci flow. Springer, 1982.
\end{document}`);
  const html = renderBlocks(doc.blocks);
  assert.match(html, /\[H 4\]/, 'the part reference is untouched');
  assert.match(html, /\[0,T\)/, 'the interval is untouched');
  assert.doesNotMatch(html, /href="#ref-h-4"/);
});

// ----------------------------------------------------------------- link kinds

test('a link to another page of the same site is not external', async () => {
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}\href{site/other.html}{Another page} and
\href{https://arxiv.org/abs/1706.03762}{arXiv}.\end{document}`);
  const html = renderBlocks(doc.blocks);
  assert.doesNotMatch(html, /href="site\/other\.html" target="_blank"/,
    'a relative link must not open a new tab');
  assert.match(html, /href="https:\/\/arxiv\.org\/abs\/1706\.03762" target="_blank"/,
    'a link off the site must');
});

// ------------------------------------------------------------------- \thanks

test('an author block is read as authors, notes and marks', async () => {
  // The NIPS classes put `\thanks` inside `\author` and separate authors with
  // `\And`: the block reads as authors, notes and marks, not one run-on string.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, '..', 'showcase', 'papers', 'attention-2017', 'ms.tex'), 'utf8');
  const doc = parseDocument(src);
  const { authors, notes } = doc.meta.authors;

  assert.equal(authors.length, 8, 'eight authors, not twenty-two lines');
  assert.equal(authors[0].name, 'Ashish Vaswani');
  assert.deepEqual(authors[0].detail, ['Google Brain', 'avaswani@google.com']);
  assert.ok(!authors[0].name.includes('Equal contribution'),
    'the note text is not left sitting in the name');

  // LaTeX prints footnotes 1, 2, 3 as *, dagger, double dagger.
  assert.deepEqual(notes.length, 3);
  assert.match(notes[0], /^Equal contribution\./);
  assert.equal(notes[1], 'Work performed while at Google Brain.');
  assert.equal(notes[2], 'Work performed while at Google Research.');
  assert.deepEqual(authors.map((a) => a.marks.map((m) => m.symbol).join('')),
    ['*', '*', '*', '*', '*', '*\u2020', '*', '*\u2021']);

  const { renderBlocks } = await import('../src/render.js');
  const html = renderBlocks(doc.blocks, { meta: doc.meta });
  assert.match(html, /class="author-name"/);
  // The mark links to the note; the note text travels neither in a tooltip
  // wider than the page nor in the byline itself.
  assert.match(html, /class="author-mark"><a href="#author-note-1"/,
    'the mark links to the note');
  assert.match(html, /id="author-note-1"[^>]*>.*Equal contribution/s,
    'and the note is printed once, below the byline');
  assert.doesNotMatch(html, /title="Equal contribution/, 'not in a tooltip');
  assert.doesNotMatch(html, /doc-author">[^<]*Equal contribution/,
    'and no note text runs on inside the byline');
});

test('a centred block in red is the author\'s emphasis, not a banner', async () => {
  // A centred paragraph set in red is the author's emphasis, rendered as-is:
  // no banner, and no heading the author did not write.
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}
\begin{center}\color{red}\large Redistribution requires attribution.\end{center}
\maketitle
\end{document}`);
  const html = renderBlocks(doc.blocks);
  assert.match(html, /class="centered"/);
  assert.doesNotMatch(html, /callout/, 'no banner');
  assert.doesNotMatch(html, />Notice</, 'and no heading the author did not write');
  assert.match(html, /Redistribution requires attribution\./);
});
// ----------------------------------------------------------- the \root cause

test('a layout keeps its own metrics', async () => {
  // Metrics come from one resolved token set, so a layout wanting its own
  // measure declares it there; docs does not inherit the paper measure.
  const { loadLayouts } = await import('../src/themes.js');
  const layouts = await loadLayouts();
  assert.notEqual(layouts.docs.tokens.measure, layouts.paper.tokens.measure,
    'docs does not inherit the paper measure');
  assert.equal(layouts.docs.tokens.rail, '0rem', 'a landing page has no rail');
  // The measure and the type scale are fixed values stepped at breakpoints,
  // not fluid `clamp()`s: a fluid measure re-wraps every paragraph for the
  // whole of a window drag.
  assert.doesNotMatch(layouts.paper.tokens.measure, /clamp\(|vw/,
    'the measure is a fixed value, stepped at breakpoints in the stylesheet');
  for (const key of ['step--1', 'step-0', 'step-1', 'step-2', 'step-3', 'step-4']) {
    assert.doesNotMatch(layouts.paper.tokens[key], /clamp\(|vw/,
      `${key} is a fixed value, stepped at breakpoints in the stylesheet`);
  }
  assert.match(layouts.paper.tokens.bleed, /clamp\(0rem/,
    'the figure bleed still starts at zero');
});

// ------------------------------------------------- maths idioms and the reader

test('a word in roman type inside maths is one word', async () => {
  // `\mbox{Ric}` is one word in roman type. It is rewritten to `\text` so KaTeX
  // does not set it as separate italic variables.
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`\begin{document}$|\mbox{Ric}|^2$\end{document}`);
  assert.match(renderBlocks(doc.blocks, { katex: null }), /\\text\{Ric\}/);
});

test('an accent inside a roman word is set as an accent, not a floating mark', async () => {
  // Accents in roman words are emitted as accent commands plus text runs:
  // KaTeX has no `\ddot` in text mode, and a precomposed mark draws floating
  // above the letter.
  const { renderBlocks } = await import('../src/render.js');
  for (const [tex, expected] of [
    [String.raw`\mbox{K\"{a}hler}`, String.raw`\text{K}\ddot{a}\text{hler}`],
    [String.raw`\mbox{K\"ahler}`, String.raw`\text{K}\ddot{a}\text{hler}`],
    [String.raw`\"a`, String.raw`\ddot{a}`],
    [String.raw`\'e`, String.raw`\acute{e}`],
  ]) {
    const doc = parseDocument(`\\begin{document}$${tex}$\\end{document}`);
    assert.match(renderBlocks(doc.blocks, { katex: null }),
      new RegExp(expected.replace(/[\\{}]/g, '\\$&')), tex);
  }
});

test('an accent letter that is also a real macro is left alone', async () => {
  // `\v` and `\t` are real macros (vector, tie), not accent letters: treating
  // them as accents deletes the mark they carry.
  const { renderBlocks } = await import('../src/render.js');
  for (const tex of [String.raw`\v{x}`, String.raw`\vec{x}`, String.raw`\frac{d}{dt}`]) {
    const doc = parseDocument(`\\begin{document}$${tex}$\\end{document}`);
    assert.match(renderBlocks(doc.blocks, { katex: null }),
      new RegExp(tex.replace(/[\\{}]/g, '\\$&')), tex);
  }
  // and the letter forms that really are accents still work
  const c = parseDocument(String.raw`\begin{document}$\c{c}ooper\end{document}`);
  assert.match(renderBlocks(c.blocks, { katex: null }), /çooper/);
});

test('a bracketed group that is not a reference does not duplicate its sentence', async () => {
  // A bracketed group that is not a reference renders once, as written: the
  // sentence before it must not be duplicated into the match.
  const { renderBlocks } = await import('../src/render.js');
  const doc = parseDocument(String.raw`
\begin{document}As shown in [H 4] the flow converges.
\section*{References}
\ \ \  [H] R. Hamilton. Ricci flow. Springer, 1982.
\end{document}`);
  const html = renderBlocks(doc.blocks);
  assert.equal(html.split('As shown in').length - 1, 1, 'the sentence appears once');
  assert.match(html, /\[H 4\]/, 'and the reference is left as the author wrote it');
});
