/**
 * Figure delegation.
 *
 * TikZ, pgfplots and friends are real programs; reproducing them in the
 * browser is not this project's job. So when a real TeX engine is available we
 * hand the picture to it and use the result, and when one is not we fall back
 * to showing the source with an explicit note. The page never pretends.
 *
 * Nothing here is required. With no engine on the machine the build takes the
 * fallback above and carries on, and `figures: { delegate: false }` in a config
 * file turns the whole mechanism off for a build that must not shell out.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expandMacros } from './macros.js';

const run = promisify(execFile);

/** LaTeX engines we can drive, in order of preference. */
const ENGINES = [
  {
    cmd: 'tectonic',
    args: (file, outDir) => [
      '-X', 'compile', file, '--outfmt', 'pdf', '--outdir', outDir, '--keep-logs'
    ]
  },
  {
    cmd: 'latexmk',
    args: (file, outDir) => [
      '-pdf', '-interaction=nonstopmode', '-halt-on-error', `-outdir=${outDir}`, file
    ]
  },
  {
    cmd: 'pdflatex',
    args: (file, outDir) => [
      '-interaction=nonstopmode', '-halt-on-error', `-output-directory=${outDir}`, file
    ]
  },
];

/** Rasterisers, in order of preference. `pdftoppm` gives exact control. */
const RASTERISERS = [
  {
    cmd: 'pdftoppm',
    args: (pdf, png, dpi) => [
      '-png', '-r', String(dpi), '-singlefile', pdf, png.replace(/\.png$/, '')
    ]
  },
  {
    cmd: 'sips',
    args: (pdf, png) => ['-s', 'format', 'png', '-Z', '1600', pdf, '--out', png]
  },
];

/**
 * Vector output, when asked for.
 *
 * `pdftocairo -svg` outlines the text, so a small diagram can come out two
 * orders of magnitude larger than its PNG. Opt-in for that reason; PNG is
 * the default.
 */
const SVG_CONVERTERS = [
  // pdftocairo writes exactly the filename it is given, extension included
  { cmd: 'pdftocairo', args: (pdf, svg) => ['-svg', pdf, svg] },
];

/*
 * A drawing is compiled on its own, so this preamble supplies everything a
 * document would normally get from its class and packages (dvipsnames via
 * xcolor, the `graphs` library for `/tikz/value`, beamer-only macros reduced
 * to "always visible" below). The library list is deliberately broad: a
 * missing library is a hard error on the whole picture, an unused one a few
 * kilobytes.
 */
const PREAMBLE = `\\documentclass[border=6pt]{standalone}
% No tikz class option here: it loads xcolor before the dvipsnames colour
% names can be requested, and asking for them afterwards is an option clash.
% Papers use names like darkred freely.
\\usepackage[dvipsnames,svgnames]{xcolor}
\\usepackage{tikz}
\\usepackage{amsmath,amssymb}
\\usetikzlibrary{arrows.meta,arrows,positioning,calc,decorations.pathreplacing,decorations.markings,decorations.text,backgrounds,fit,shapes.geometric,shapes.arrows,shapes.multipart,shapes.callouts,shapes.symbols,patterns,plotmarks,angles,quotes,3d,graphs,matrix,chains,automata,topaths,through,petri,er,mindmap,calendar,spy,backgrounds}
\\usepackage{pgfplots}
\\pgfplotsset{compat=1.18}
\\definecolor{figurebg}{RGB}{255,255,255}
\\pagecolor{figurebg}
`;

/**
 * Beamer-only drawing macros, reduced to "always visible".
 *
 * A static image has no overlays to step through, so `\uncover<2>{x}` means
 * "show x". Emitted only when the drawing uses one: `\mode` is a TeX
 * primitive (redefining it breaks package loading far from the cause), and
 * `\alt` is ambiguous (`\alt<2>{a}{b}` takes two groups,
 * `\alt<presentation>{a}` one), so the shims stay out of drawings that need
 * none of them.
 */
const OVERLAY_SHIMS = `\\makeatletter
\\long\\def\\uncover{\\@ifnextchar<{\\u@i}{\\u@c}}
\\long\\def\\u@i<#1>#2{#2}
\\long\\def\\u@c#1{#1}
\\long\\def\\only{\\@ifnextchar<{\\u@i}{\\u@c}}
\\long\\def\\visible{\\@ifnextchar<{\\u@i}{\\u@c}}
\\long\\def\\actionenv{\\@ifnextchar<{\\u@i}{\\u@c}}
\\long\\def\\invisible{\\@ifnextchar<{\\u@i}{\\u@c}}
\\long\\def\\onlyenv{\\@ifnextchar<{\\u@i}{\\u@c}}
% \\mode<presentation>{...} and \\alt<presentation>{a}{b} are beamer overlays too
\\long\\def\\mode{\\@ifnextchar<{\\u@two}{\\u@one}}
\\long\\def\\u@two<#1>#2{#2}
\\long\\def\\u@one#1{#1}
\\long\\def\\alt{\\@ifnextchar<{\\u@alt}{\\u@althree}}
\\long\\def\\u@alt<#1>#2#3{#3}
\\long\\def\\u@althree#1#2#3{#2}
\\makeatother

`;

/** True when the body still contains an overlay specification. */
const USES_OVERLAY = /\\(?:uncover|onslide|only|visible|actionenv|onlyenv|invisible)\b/;

let capability;

/** Which engine and rasteriser exist, cached after the first probe. */
export async function detect({ engine = 'auto', raster = 'auto' } = {}) {
  if (capability) return capability;

  let chosen = null;
  if (engine !== 'auto') {
    const forced = ENGINES.find((e) => e.cmd === engine);
    chosen = forced && (await exists_(forced.cmd)) ? forced : null;
    if (engine !== 'auto' && !chosen) {
      capability = { engine: null, raster: null, reason: `${engine} was requested but is not installed` };
      return capability;
    }
  } else {
    for (const candidate of ENGINES) {
      if (await exists_(candidate.cmd)) { chosen = candidate; break; }
    }
  }

  let rasteriser = null;
  if (raster !== 'auto') {
    const forced = RASTERISERS.find((r) => r.cmd === raster);
    rasteriser = forced && (await exists_(forced.cmd)) ? forced : null;
  } else {
    for (const candidate of RASTERISERS) {
      if (await exists_(candidate.cmd)) { rasteriser = candidate; break; }
    }
  }

  capability = {
    engine: chosen?.cmd ?? null,
    raster: rasteriser?.cmd ?? null,
    reason: !chosen ? 'no LaTeX engine found (tectonic, latexmk or pdflatex)'
      : !rasteriser ? 'no PDF rasteriser found (pdftoppm or sips)' : null,
  };
  return capability;
}

const exists_ = async (cmd) => {
  try {
    const { stdout } = await run('command', ['-v', cmd], { shell: '/bin/bash' });
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
};

/**
 * Lifts drawings out of inline positions.
 *
 * A picture is a block. Beamer writes one inside a paragraph — `\makebox` around
 * a `tikzpicture` is the usual shape — so it is reached as an inline node.
 * Delegating it in place would emit a `<figure>` nested in a `<p>`, which is
 * not valid HTML and renders badly. Promoting it to a sibling of the paragraph
 * is both valid and what the author meant.
 */
function hoistFromNodes(nodes) {
  const lifted = [];
  const rest = [];
  for (const node of nodes || []) {
    if (node.type === 'tikz') {
      lifted.push(node);
      continue;
    }
    if (node.nodes) {
      const inner = hoistFromNodes(node.nodes);
      node.nodes = inner.rest;
      lifted.push(...inner.lifted);
    }
    // A group parsed as blocks (an overlay wrapping a picture) keeps its
    // drawings here; hoist them with everything else.
    if (node.blocks) {
      const before = lifted.length;
      node.blocks = hoistDrawings(node.blocks);
      lifted.push(...node.blocks.filter((b) => b.type === 'tikz'));
      void before;
    }
    rest.push(node);
  }
  return { rest, lifted };
}

function hoistDrawings(blocks) {
  const out = [];
  for (const block of blocks || []) {
    // Test `nodes.length`, not `nodes`: a frame section carries a `nodes`
    // array for its title that is empty (and therefore truthy) when the frame
    // is untitled. An empty array must fall through to `block.blocks`, where
    // the frame's body is.
    if (block.nodes && block.nodes.length) {
      const { rest, lifted } = hoistFromNodes(block.nodes);
      block.nodes = rest;
      out.push(block, ...lifted);
      continue;
    }
    if (block.blocks) block.blocks = hoistDrawings(block.blocks);
    if (block.items) {
      for (const item of block.items)
        if (item.blocks) item.blocks = hoistDrawings(item.blocks);
    }
    out.push(block);
  }
  return out;
}

/**
 * Walks a block tree yielding every drawing, with the figure that should carry
 * it when there is one.
 *
 * A `tikzpicture` inside `\begin{figure}` is the normal case, and its caption
 * lives on that enclosing figure. Turning the inner block into a figure of its
 * own would nest a figure inside a figure and drop the caption, so the image
 * is attached to the parent instead.
 */
function* drawings(blocks, parent = null) {
  for (const block of blocks || []) {
    if (block.type === 'tikz') {
      // a figure with no image yet is the natural home for this drawing: it
      // already carries the caption, the label and the id
      yield { block, host: parent?.type === 'figure' && !parent.image ? parent : null };
      continue;
    }
    const here = block.type === 'figure' ? block : parent;
    if (block.blocks) yield* drawings(block.blocks, here);
    if (block.items) for (const item of block.items) yield* drawings(item.blocks, here);
    // A picture can also be reached through inline content
    // (`\makebox` around a `tikzpicture` puts one inside a paragraph's nodes).
    // Such a drawing is a leaf (`{ type: 'tikz', tex }`) with no `blocks`,
    // so it is matched here rather than by recursing into `node.blocks`.
    if (block.nodes) {
      for (const node of block.nodes) {
        if (node.type === 'tikz') { yield { block: node, host: here }; continue; }
        yield* drawings(node.blocks || [], here);
      }
    }
  }
}

/**
 * Compiles the drawings in a page and rewrites each block into a figure that
 * points at the rendered image.
 *
 * @returns {{rendered:number, failed:number, warnings:string[]}}
 */
export async function renderDrawings(pages, { opts, outDir, log = () => {} }) {
  const cap = await detect({ engine: opts.figures?.engine, raster: undefined });
  const warnings = [];
  if (!cap.engine || !cap.raster) {
    warnings.push(`${cap.reason}; drawings are shown as source`);
    return { rendered: 0, failed: 0, warnings, capability: cap };
  }

  const cacheDir = path.join(outDir, '.figures');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2w-fig-'));
  const dpi = Number(opts.figures?.dpi) || 200;
  const timeout = Number(opts.figures?.timeout) || 30000;

  let rendered = 0;
  let failed = 0;

  for (const page of pages) {
    page.doc.blocks = hoistDrawings(page.doc.blocks);
    let index = 0;
    for (const { block, host } of drawings(page.doc.blocks)) {
      index += 1;
      // Asymptote needs a tool we do not ship a path for; leave it as source.
      if (block.dialect === 'Asymptote') { failed += 1; continue; }

      const stem = `fig-${page.outName}-${index}`;
      // PNG by default; `figures.format: 'svg'` asks for vector output
      const wantSvg = String(opts.figures?.format || 'png').toLowerCase() === 'svg';
      const ext = wantSvg ? '.svg' : '.png';
      const png = path.join(cacheDir, `${stem}${ext}`);

      // Whether or not this one is compiled now, the block becomes a figure:
      // the rewrite covers cached pictures too, not just fresh ones.
      if (!existsSync(png)) {
        const texFile = path.join(tmpDir, `${stem}.tex`);
        // The drawing is written in the document's own dialect: its macros, its
        // TikZ styles and its colour definitions all travel with it, or a node
        // written `[value]` and a colour written `darkred` mean nothing to the
        // compiler.
        await fs.writeFile(texFile, standaloneFor(block, {
          tikzStyles: page.doc.tikzStyles || [],
          colors: page.doc.colors || [],
          macros: page.doc.macros,
        }));
        try {
          const { engine, raster } = cap;
          await run(
            engine, ENGINES.find((e) => e.cmd === engine).args(texFile, tmpDir),
            { timeout });
          const pdf = path.join(tmpDir, `${stem}.pdf`);
          if (!existsSync(pdf)) throw new Error('the engine produced no PDF');
          await fs.mkdir(cacheDir, { recursive: true });
          if (wantSvg) {
            let conv = null;
            for (const c of SVG_CONVERTERS)
              if (await exists_(c.cmd)) { conv = c; break; }
            if (!conv)
              throw new Error('figures.format is svg but pdftocairo is not installed');
            await run(conv.cmd, conv.args(pdf, png), { timeout });
          } else {
            await run(
              raster, RASTERISERS.find((r) => r.cmd === raster).args(pdf, png, dpi),
              { timeout });
          }
          if (!existsSync(png)) throw new Error('no image was produced');
        } catch (err) {
          failed += 1;
          const what = block.target
            ? `\\ref{${block.target}}`
            : `drawing ${index} of ${page.outName}`;
          // The engine's own complaint, not its last line of chatter: the
          // runner's summary says nothing about which drawing failed, while
          // the first `!` line of the kept `.log` names package, key and line.
          const logFile = path.join(tmpDir, `${stem}.log`);
          let why = '';
          try {
            if (existsSync(logFile)) {
              const lines = (await fs.readFile(logFile, 'utf8')).split('\n');
              const at = lines.findIndex((l) => /^! /.test(l)
                || /Error:/.test(l) || /Runaway argument/.test(l));
              why = (at >= 0 ? lines[at] : lines.find((l) => l.trim())).trim();
            }
          } catch { /* the log is a courtesy, not a requirement */ }
          if (!why) {
            const out = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
            why = out.split('\n').filter(Boolean).slice(-1)[0] || 'unknown error';
          }
          warnings.push(`could not render ${what}: ${why}`);
          // Keep the file that would not compile: the generated standalone
          // document is the only artefact that locates the failing brace.
          try {
            await fs.mkdir(cacheDir, { recursive: true });
            await fs.copyFile(texFile, path.join(cacheDir, `${stem}.failed.tex`));
          } catch { /* best effort */ }
          continue;
        }
        log(`  rendered ${stem}${ext}`);
      }

      // The rewrite, for a freshly compiled picture and a cached one alike.
      if (host) {
        // the enclosing figure keeps its caption, label and id
        host.image = `${stem}${ext}`;
        host.imageOpts = { width: opts.figures?.width || '100%' };
        host.rendered = true;
        host.blocks = [];
      } else {
        block.type = 'figure';
        block.image = `${stem}${ext}`;
        block.imageOpts = { width: opts.figures?.width || '100%' };
        block.rendered = true;
        block.blocks = [];
      }
      rendered += 1;
    }
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
  return { rendered, failed, warnings, capability: cap };
}

/**
 * Flattens beamer overlay specifications so a figure draws in its final state.
 *
 * `\uncover<2,5->{...}` and friends only mean anything on a slide. A static
 * image cannot step through overlays, so the specification is dropped and the
 * content kept — the composed figure, which is what a reader wants to see.
 */
export function flattenOverlays(tex) {
  // `\mode<presentation>{...}` and `\alt<presentation>{a}{b}` are overlays
  // too. They are stripped from the body rather than redefined in the
  // preamble: `\mode` is a TeX primitive and `\alt` takes a varying number of
  // groups, so a fixed redefinition breaks on one shape or the other.
  let out = String(tex)
    .replace(/\\(?:uncover|only|visible|actionenv|invisible|onlyenv|alert)\s*(?:<[^>]*>)?\s*\{/g, '{')
    .replace(/\\(?:mode|onslide)\s*<[^>]*>\s*\{/g, '{')
    .replace(/\\(?:onslide<[^>]*>\s*)?(\[[^\]]*\])?\s*\\(?:uncover|only)\s*<[^>]*>/g, '');
  // `\alt<spec>{a}{b}` keeps the first alternative: it is what a reader sees
  // before the click. `\alt<spec>{a}` keeps its only one.
  let guard = 0;
  for (;;) {
    if (guard++ > 64) break;
    const at = out.search(/\\alt\s*<[^>]*>/);
    if (at < 0) break;
    const body = readGroups(out, at + out.slice(at).match(/\\alt\s*<[^>]*>/)[0].length);
    if (!body) { out = out.slice(0, at) + out.slice(at + 1); continue; }
    out = out.slice(0, at) + (body.first ?? '') + out.slice(body.next);
  }
  return out;
}

/** The one or two braced groups after `from`, without their braces. */
function readGroups(src, from) {
  const groups = [];
  let i = from;
  while (groups.length < 2) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') break;
    let d = 0;
    const start = i;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '{') d++;
      else if (src[i] === '}') { d--; if (!d) { i++; break; } }
      i++;
    }
    groups.push(src.slice(start + 1, i - 1));
  }
  return { first: groups[0], next: i };
}

/**
 * Builds a compilable document around a drawing.
 *
 * The parser keeps only the body of the environment, so the picture wrapper is
 * put back here. Options captured from the original `\begin{tikzpicture}[...]`
 * are reapplied, and a bare `axis` is treated as a pgfplots picture, which is
 * what it always is in practice.
 */
/** The overlay macros, if this drawing still has an overlay in it. */
function shimsFor(body) {
  return USES_OVERLAY.test(String(body)) ? OVERLAY_SHIMS : '';
}

export function standaloneFor(
  block, { tikzStyles = '', colors = [], macros = null } = {}) {
  const options = block.options ? `[${block.options}]` : '';
  // A drawing is written in the document's own notation, so its macros have to
  // travel with it: `\transpose` inside a node is meaningless to the compiler
  // without the definition that Fleuret's header supplies.
  const body = flattenOverlays(macros ? expandMacros(block.tex, macros) : block.tex);

  if (block.dialect === 'tikzcd') {
    return `${PREAMBLE}\\begin{document}\n\\begin{tikzcd}${options}\n${body}\n\\end{tikzcd}\n\\end{document}\n`;
  }

  // The parser always strips the environment's own `\begin{...}`, so the
  // wrapper goes back on here. Scanning the whole body for `\begin{tikz...}`
  // is not enough to decide that: a picture nested inside a node carries one
  // too, and mistaking it for the outer wrapper leaves the drawing with no
  // picture to live in. Only what comes first counts.
  const lead = /^\\begin\{([a-zA-Z*]+)\}/.exec(block.tex.trimStart());
  if (lead && lead[1] !== 'axis') {
    return `${PREAMBLE}${shimsFor(body)}\\begin{document}\n${body}\n\\end{document}\n`;
  }

  // Only pgfplots data justifies an `axis` wrapper. Wrapping a plain `\draw`
  // body in one produces an empty plot with default 0-1 axes, which looks
  // like a broken figure rather than a missing one.
  const plotsData = /\\(?:addplot3?|addplot table|addplot coordinates)\b/.test(body);
  const inner = plotsData && !lead ? `\n\\begin{axis}\n${body}\n\\end{axis}\n` : `\n${body}\n`;

  // Styles the document defined are part of the drawing: a node written
  // `[value]` means nothing without the `value/.style` a shared header
  // declared. Each `\tikzset` is reproduced as its own call, verbatim --
  // pgfkeys reads comma-separated lists, so merging them lets a block ending
  // without a comma swallow the next key as its own value.
  //
  // The closing brace shares the last line with the body, and a trailing
  // comment in the body is dropped: a `%` before the brace would comment the
  // brace out and leave an orphan that fails the whole document.
  const blocks = (Array.isArray(tikzStyles) ? tikzStyles : [tikzStyles])
    .filter(Boolean);
  const wanted = usesPics(body);
  const styles = [
    ...(Array.isArray(colors) ? colors : [colors]).filter(Boolean).map((c) => `${c}\n`),
    ...blocks.map((b) => `\\tikzset{${forDialect(String(b), wanted)}}\n`),
  ].join('');
  return `${PREAMBLE}${shimsFor(body)}${styles}\\begin{document}\n`
    + `\\begin{tikzpicture}${options}${inner}\\end{tikzpicture}\n\\end{document}\n`;
}

/** True when the drawing places a `\pic`. */
function usesPics(body) {
  return /\\pic\s*\{/.test(String(body));
}

/**
 * The style declarations this drawing can use.
 *
 * Everything the document declared is carried across -- but entries only a
 * `\pic` could reach (notably `args=` declarations, which pgfkeys parses
 * through a path that chokes without a `\pic` in the drawing) are dropped
 * when there is no `\pic`. The rule is drawn at brace depth zero, so an entry
 * with braces in its value stays whole rather than being cut in half.
 */
function forDialect(body, wanted) {
  // Whole comment lines go, and trailing comments are cut: any surviving `%`
  // would comment out the brace that closes the `\tikzset`.
  const trimmed = String(body)
    .split('\n')
    .map((line) => (/^\s*%/.test(line) ? '' : line.replace(/(?<!\\)%.*$/, '')))
    // A blank line is a `\par` to TeX, and pgfkeys collects its key list where
    // no paragraph is allowed -- so blank lines go entirely.
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
  if (wanted) return trimmed;
  // Split on the comma at depth zero, then trim each slice: one-key-per-line
  // lists separated by `,\n\n` arrive with a blank head on every slice after
  // the first, which no line filter upstream can see.
  const kept = splitKeys(trimmed)
    .map((k) => k.trim())
    .filter((k) => k !== '' && !/^pics\//.test(k) && !/\.style\s+args\s*=/.test(k));
  return kept.join(',\n');
}

/** A `{...}` key list, split on the commas at brace depth zero. */
function splitKeys(body) {
  const out = [];
  let d = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') d++;
    else if (c === '}') d--;
    else if (c === ',' && d === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out;
}

/** The cache directory a build created, so the caller can copy from it. */
export function figureCacheDir(outDir) {
  return path.join(outDir, '.figures');
}

/**
 * Deletes the compiled-figure cache for an output directory.
 *
 * Worth having as a flag because the cache is keyed by name and nothing else: two
 * drawings that want the same output name share a file, and a figure whose source
 * changes underneath an unchanged name keeps its old picture until the directory
 * is removed. There is no timestamp in the key to notice that, so `--clear-cache`
 * is the escape hatch rather than a repair that happens on its own.
 *
 * Only this project's own cache. The engine's package bundle is a separate,
 * much larger directory outside the output tree and it belongs to the engine;
 * deleting it would cost the user a re-download nobody asked for.
 *
 * @returns {Promise<number>} how many files were removed
 */
export async function clearFigureCache(outDir) {
  const dir = figureCacheDir(outDir);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    await fs.rm(full, { recursive: true, force: true });
    n += 1;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return n;
}

// --------------------------------------------------- rasterising real artwork

/** Extensions graphicx would try, in the order it tries them. */
export const GRAPHIC_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps'];

/**
 * Finds the file `\includegraphics` meant.
 *
 * Authors write `{Figures/architecture}` and let LaTeX find the extension, so
 * a name without one is normal rather than broken. Resolution happens against
 * the document's own directory, in graphicx's order.
 */
export function resolveGraphic(name, fromDir) {
  if (path.isAbsolute(name)) return existsSync(name) ? name : null;
  const direct = path.resolve(fromDir, name);
  if (existsSync(direct) && statSafe(direct)) return direct;
  // an explicit extension that does not exist is a genuine miss
  if (path.extname(name)) return null;
  for (const ext of GRAPHIC_EXTENSIONS) {
    const candidate = direct + ext;
    if (existsSync(candidate) && statSafe(candidate)) return candidate;
  }
  return null;
}

function statSafe(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Pixel size of an image, via the one rasteriser that is certainly present. */
async function pixelSize(file) {
  try {
    const { stdout } = await run(
      'sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    const w = /pixelWidth:\s*(\d+)/.exec(stdout);
    const h = /pixelHeight:\s*(\d+)/.exec(stdout);
    if (w && h) return { w: Number(w[1]), h: Number(h[1]) };
  } catch { /* fall through */ }
  return null;
}

/**
 * Turns a vector figure into a PNG a browser can show.
 *
 * A `.pdf` in an `<img>` renders as nothing at all, and papers from Illustrator
 * or Inkscape ship exactly that. So the artwork is rasterised at build time,
 * which is also the only way to honour `trim`: the four numbers are in `bp`, so
 * the page's own size has to be measured before the crop rectangle can be
 * computed.
 *
 * @returns {Promise<boolean>} whether a PNG was produced
 */
export async function rasteriseGraphic(
  source, outPng, { dpi = 200, trim = null, timeout = 30000 } = {}) {
  const cap = await detect();
  if (!cap.raster || !GRAPHIC_EXTENSIONS.includes(path.extname(source).toLowerCase()))
    return false;
  const base = outPng.replace(/\.png$/, '');

  const args = (pdf, target, crop) => {
    const raster = RASTERISERS.find((r) => r.cmd === cap.raster);
    if (raster.cmd === 'sips') return raster.args(pdf, target);
    const full = ['-png', '-r', String(dpi), '-singlefile'];
    if (crop)
      full.push(
        '-x', String(crop.x), '-y', String(crop.y), '-W', String(crop.w),
        '-H', String(crop.h));
    return [...full, pdf, target.replace(/\.png$/, '')];
  };

  try {
    if (!trim) {
      await run(cap.raster, args(source, outPng, null), { timeout });
      return existsSync(outPng);
    }

    // measure the page untrimmed, then crop by the same tool in one more pass
    const probe = `${base}.probe.png`;
    await run(cap.raster, args(source, probe, null), { timeout });
    const size = await pixelSize(probe);
    if (!size) {
      await fs.copyFile(probe, outPng);
      await fs.rm(probe, { force: true });
      return true;
    }
    const perBp = dpi / 72;
    const pageW = size.w / perBp;
    const pageH = size.h / perBp;
    const [left, bottom, right, top] = trim;
    const crop = {
      x: Math.round(left * perBp),
      y: Math.round(top * perBp),
      w: Math.round((pageW - left - right) * perBp),
      h: Math.round((pageH - bottom - top) * perBp),
    };
    await fs.rm(probe, { force: true });
    if (crop.w < 1 || crop.h < 1) {
      await run(cap.raster, args(source, outPng, null), { timeout });
      return existsSync(outPng);
    }
    await run(cap.raster, args(source, outPng, crop), { timeout });
    return existsSync(outPng);
  } catch {
    return false;
  }
}

export const hash = (text) =>
  createHash('sha256').update(text).digest('hex').slice(0, 12);
