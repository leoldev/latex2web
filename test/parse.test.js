import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDocument } from '../src/parse.js';

const types = (blocks) => blocks.map((b) => b.type);
const find = (blocks, type) => blocks.filter((b) => b.type === type);
const text = (nodes) => nodes.map((n) => n.value ?? '').join('');

test('picks up title, author and documentclass from the preamble', () => {
  const doc = parseDocument(String.raw`
    \documentclass[11pt]{article}
    \title{A Title}
    \author{An Author}
    \begin{document}
    Hello.
    \end{document}
  `);
  assert.equal(doc.meta.title, 'A Title');
  assert.equal(doc.meta.author, 'An Author');
  assert.equal(doc.meta.documentclass, 'article');
});

test('numbers sections hierarchically and resets deeper levels', () => {
  const doc = parseDocument(String.raw`
    \section{One}
    \subsection{One A}
    \subsection{One B}
    \section{Two}
    \subsection{Two A}
  `);
  const sections = find(doc.blocks, 'section');
  assert.deepEqual(sections.map((s) => s.number), ['1', '1.1', '1.2', '2', '2.1']);
  assert.deepEqual(sections.map((s) => s.title), ['One', 'One A', 'One B', 'Two', 'Two A']);
});

test('binds each label to its own heading, never a later one', () => {
  const doc = parseDocument(String.raw`
    \section{Alpha}\label{sec:alpha}
    \section{Beta}
    \section{Gamma}\label{sec:gamma}
  `);
  assert.equal(doc.labels.get('sec:alpha').id, 'section-alpha');
  assert.equal(doc.labels.get('sec:alpha').number, '1');
  assert.equal(doc.labels.get('sec:gamma').id, 'section-gamma');
  assert.equal(doc.labels.get('sec:gamma').number, '3');
});

test('an unlabelled heading does not swallow the next label', () => {
  const doc = parseDocument(String.raw`
    \section{Beta}
    \section{Gamma}\label{sec:gamma}
  `);
  // Beta must still be a real section, i.e. the scan did not jump the heading
  assert.deepEqual(find(doc.blocks, 'section').map((s) => s.title), ['Beta', 'Gamma']);
  assert.equal(doc.labels.get('sec:gamma').number, '2');
});

test('resolves \\ref and \\eqref into typed links', () => {
  const doc = parseDocument(String.raw`
    \section{Alpha}\label{sec:alpha}
    \begin{equation}\label{eq:a}
      x = y
    \end{equation}
    See \S\ref{sec:alpha} and \eqref{eq:a}.
  `);
  const para = find(doc.blocks, 'para').at(-1);
  const links = para.nodes.filter((n) => n.type === 'link');
  assert.deepEqual(links.map((l) => l.nodes[0].value), ['1', '(1)']);
  assert.deepEqual(links.map((l) => l.href), ['#section-alpha', '#eq-1']);
  assert.ok(links.every((l) => !l.broken));
});

test('flags a reference to a label that does not exist', () => {
  const doc = parseDocument(String.raw`Broken \ref{sec:nope}.`);
  const link = find(doc.blocks, 'para')[0].nodes.find((n) => n.type === 'link');
  assert.equal(link.broken, true);
});

test('keeps a display equation in the block stream, not the paragraph', () => {
  const doc = parseDocument(String.raw`
    Running text with a formula $a^2 + b^2 = c^2$ inside it.
    \begin{equation}
      E = mc^2
    \end{equation}
    Trailing text.
  `);
  assert.deepEqual(types(doc.blocks), ['para', 'math', 'para']);
  assert.equal(doc.blocks[1].tex, 'E = mc^2');
  assert.equal(doc.blocks[1].numbered, true);
});

test('distinguishes inline from display math', () => {
  const doc = parseDocument(String.raw`Inline $x$ then display \[y = 1\]`);
  // `\[` ends the paragraph, so display maths is its own block
  assert.deepEqual(types(doc.blocks), ['para', 'math']);
  assert.deepEqual(doc.blocks[0].nodes.filter((n) => n.type === 'math').map((m) => m.display), [false]);
  assert.equal(doc.blocks[1].display, true);
});

test('counts equations across a nested environment', () => {
  const doc = parseDocument(String.raw`
    \begin{equation}\label{eq:one}
      a = 1
    \end{equation}
    \begin{theorem}
      \begin{proof}
        \begin{equation}\label{eq:two}
          b = 2
        \end{equation}
      \end{proof}
    \end{theorem}
  `);
  assert.equal(doc.labels.get('eq:one').number, 1);
  assert.equal(doc.labels.get('eq:two').number, 2);
});

test('a theorem does not claim the label of the equation inside it', () => {
  const doc = parseDocument(String.raw`
    \begin{theorem}[Convergence]\label{thm:c}
      \begin{align}
        x &= 1 \\
        y &= 2 \label{eq:u}
      \end{align}
    \end{theorem}
  `);
  assert.equal(doc.labels.get('thm:c').kind, 'theorem');
  assert.equal(doc.labels.get('eq:u').kind, 'equation');
});

test('parses itemize, enumerate and description lists', () => {
  const doc = parseDocument(String.raw`
    \begin{itemize}
      \item first
      \item second
    \end{itemize}
    \begin{enumerate}
      \item one
    \end{enumerate}
    \begin{description}
      \item[$\rho$] the ratio
    \end{description}
  `);
  const [itemize, enumerate, description] = doc.blocks;
  assert.equal(itemize.items.length, 2);
  assert.equal(enumerate.kind, 'enumerate');
  assert.equal(description.kind, 'description');
  // a math-bearing description label must survive as inline content
  assert.equal(description.items[0].label[0].type, 'math');
});

test('reads verbatim, listings and their language option', () => {
  const doc = parseDocument(String.raw`
    \begin{verbatim}
    plain  text
    \end{verbatim}
    \begin{lstlisting}[language=Python]
    x = 1
    \end{lstlisting}
  `);
  assert.equal(doc.blocks[0].type, 'code');
  assert.match(doc.blocks[0].tex, /plain {2}text/);
  assert.equal(doc.blocks[1].lang, 'Python');
});

test('a code block does not open or close on the blank line LaTeX writes', () => {
  // LaTeX puts the verbatim body on the line after \begin, and the renderer
  // writes it straight after `<pre><code>`. An unstripped newline is a real
  // empty line at the top of the code.
  const doc = parseDocument([
    '\\begin{verbatim}',
    'first',
    'second',
    '\\end{verbatim}',
  ].join('\n'));
  assert.equal(doc.blocks[0].tex, 'first\nsecond');
});

test('code keeps the indentation and the blank lines the author wrote', () => {
  // Only the one newline at each end goes. A blunt `trim()` would eat the
  // indent of the first and last lines and the deliberate blank line inside
  // a listing.
  const doc = parseDocument([
    '\\begin{verbatim}',
    '    def f():',
    '        return 1',
    '',
    '    # trailing note',
    '\\end{verbatim}',
  ].join('\n'));
  assert.equal(doc.blocks[0].tex, '    def f():\n        return 1\n\n    # trailing note');
});

test('a listing whose whole body is one line survives the edge trim', () => {
  const doc = parseDocument([
    '\\begin{lstlisting}[language=Python]',
    'x = 1',
    '\\end{lstlisting}',
  ].join('\n'));
  assert.equal(doc.blocks[0].tex, 'x = 1');
});

test('a code block indented in the source keeps every space it was written with', () => {
  // `trimVerbatimEdges` matches the newline and the whitespace around it only
  // to test that the line is empty; it never strips the indent of a line that
  // has content, and that indent is the author's.
  const doc = parseDocument([
    '\\begin{verbatim}',
    'Sequential(',
    '  (0): Conv1d(1, 64)',
    ')',
    '',
    'nb_parameters 54081',
    '\\end{verbatim}',
  ].join('\n'));
  assert.equal(doc.blocks[0].tex, 'Sequential(\n  (0): Conv1d(1, 64)\n)\n\nnb_parameters 54081');
});

test('builds a table with a header row and cells', () => {
  const doc = parseDocument(String.raw`
    \begin{table}[h]
      \begin{tabular}{lcc}
        \hline
        Method & Count & $c$ \\
        \hline
        Classical & 12 & 2.7 \\
        \hline
      \end{tabular}
      \caption{Iteration counts.}
      \label{tab:t}
    \end{table}
  `);
  const [table] = doc.blocks;
  assert.equal(table.type, 'table');
  // cells are objects so that \multicolumn can carry a colspan
  assert.deepEqual(table.rows[0].map((c) => c.text), ['Method', 'Count', '$c$']);
  assert.equal(table.rows.length, 2);
  assert.equal(doc.labels.get('tab:t').kind, 'table');
});

test('reads figures with an image and a caption', () => {
  const doc = parseDocument(String.raw`
    \begin{figure}
      \includegraphics[width=0.5\linewidth]{plot.png}
      \caption{A plot.}
    \end{figure}
  `);
  const [figure] = doc.blocks;
  assert.equal(figure.type, 'figure');
  assert.equal(figure.image, 'plot.png');
  assert.ok(figure.caption.length);
});

test('applies inline emphasis and escapes special characters', () => {
  const doc = parseDocument(String.raw`\textbf{bold} and \emph{italic} and 100\% \& \#1.`);
  const kinds = find(doc.blocks, 'para')[0].nodes.map((n) => n.type);
  assert.deepEqual(kinds, ['strong', 'text', 'em', 'text']);
  assert.match(text(find(doc.blocks, 'para')[0].nodes), /100% & #1\./);
});

test('turns urls and hrefs into external links', () => {
  const doc = parseDocument(String.raw`\url{https://example.com} and \href{https://x.test}{label}`);
  const links = find(doc.blocks, 'para')[0].nodes.filter((n) => n.type === 'link');
  assert.equal(links[0].href, 'https://example.com');
  assert.equal(links[1].nodes[0].value, 'label');
  assert.ok(links.every((l) => l.external));
});

test('degrades unknown input quietly instead of throwing', () => {
  const doc = parseDocument(String.raw`\unknownmacro{x} \begin{weirdenv}stuff\end{weirdenv}`);
  assert.ok(doc.blocks.length >= 1);
});

test('an empty document produces no blocks and no crash', () => {
  assert.deepEqual(parseDocument('').blocks, []);
  assert.deepEqual(parseDocument(String.raw`\begin{document}\end{document}`).blocks, []);
});
test('theorem-like environments share one counter and are referenced by name', () => {
  const doc = parseDocument(String.raw`
    \begin{theorem}[First]\label{thm:one}Body.\end{theorem}
    \begin{lemma}\label{lem:two}Body.\end{lemma}
    By \ref{thm:one} and \ref{lem:two}.
  `);
  assert.equal(doc.labels.get('thm:one').number, 1);
  assert.equal(doc.labels.get('lem:two').number, 2);
  const links = find(doc.blocks, 'para')[0].nodes.filter((n) => n.type === 'link');
  assert.deepEqual(links.map((l) => l.nodes[0].value), ['1', '2']);
});

test('\\ref yields the number alone, so \\S\\ref reads correctly', () => {
  const doc = parseDocument(String.raw`
    \section{Intro}\label{sec:i}
    See \S\ref{sec:i}.
  `);
  const nodes = find(doc.blocks, 'para')[0].nodes;
  const link = nodes.find((n) => n.type === 'link');
  const sectionSign = nodes[nodes.indexOf(link) - 1];
  assert.equal(sectionSign.value, '§');
  assert.equal(link.nodes[0].value, '1');
});
