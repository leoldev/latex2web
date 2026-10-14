/**
 * Build orchestration: `.tex` in, static site out.
 */

import fs from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createParseState, flattenBlocks, parseDocument, parseInlineText, resolveAll, stripTexComments } from './parse.js';
import { fitEquationsScript } from './fit-equations.js';
import {
  buildToc, escapeHtml, katexAssets, projectRoot, renderBlocks,
  renderFootnotes, renderInline, renderToc, wordmarkSvg,
} from './render.js';
import { DEFAULTS, resolveAppearance } from './config.js';
import { rasteriseGraphic, resolveGraphic } from './figures.js';
import { loadLayouts } from './themes.js';
import { deepMerge } from './tokens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

/** KaTeX at build time, or null when it is not installed. */
function katexModule() {
  try {
    return nodeRequire('katex');
  } catch {
    return null;
  }
}

/**
 * Builds a site.
 *
 * `options` may be a full resolved config (see `loadConfig`) or a partial set of
 * overrides, which is why defaults are merged in here as well: the library API
 * should not require the caller to know the default set.
 */
export async function build(input, options = {}) {
  if (!input) throw new Error('no input given');
  const opts = absolutise(deepMerge(DEFAULTS, coerceTokens(options)));
  const warnings = [];

  // a relative `out` is resolved against the config file's directory, so a
  // config in a parent directory still puts output where the user expects
  const outDir = path.resolve(process.cwd(), opts.out);
  const requested = Array.isArray(input) ? input : [input];
  const log = (msg) => { if (!opts.quiet) console.log(msg); };

  /*
   * Before anything is read, if asked.
   *
   * The cache is keyed by output name and nothing else, so a drawing whose source
   * changes while its name does not keeps the picture it had. That is what the
   * flag is for, and it runs first so a build with `--clear-cache` cannot read a
   * single stale entry before overwriting it.
   */
  if (opts.clearCache) {
    const { clearFigureCache } = await import('./figures.js');
    const n = await clearFigureCache(outDir);
    log(`  figure cache cleared (${n} file${n === 1 ? '' : 's'})`);
  }

  const inputs = (await Promise.all(requested.map(collectInputs))).flat();
  if (!inputs.length) throw new Error(`no .tex files found in ${requested.join(', ')}`);

  // ---- page model
  //
  // `\input`/`\include` are resolved here rather than in the parser, because
  // only the builder knows where files live. Labels from an included file land
  // in the same scope as the parent, so `\ref` works across the split; the
  // include stack is what stops `a.tex` including itself.
  const pages = [];
  const renderedFigures = new Map(); // basename -> absolute path of a compiled drawing

  /**
   * Label scope is per *document*, not per build: `\input` continues the parent
   * document, but two unrelated `.tex` files built in one invocation must not
   * see each other's labels. Sharing one state across inputs let a `\label`
   * in a second file silently retarget the first file's `\ref`.
   */
  /** Raw text of an included file, for reading definitions out of a preamble. */
  let readTextWarned = false;
  /**
   * A file's text, with its comments gone.
   *
   * LaTeX removes a comment as it reads the line, before anything looks at the
   * file, so this is done here rather than at the points that happen to need it.
   * The shared beamer header in the showcase keeps three lines of commented-out
   * code inside `\openingframe`, and those lines were still in the body when the
   * macro was expanded: `\hyphenchar\font=-1` came back as the literal text
   * `0.65=-1`, centred, on the title slide. `\%` is a percent and is left alone.
   */
  const readText = (target) => {
    try {
      const file = locate(target);
      return file ? stripTexComments(readFileSync(file, 'utf8')) : null;
    } catch (err) {
      // a diagnostic, once: without it the preamble's definitions are simply
      // invisible and the reason is not obvious
      if (!readTextWarned) {
        readTextWarned = true;
        process.stderr.write(`\u03bbtex2web: could not read included file "${target}": ${err.message}\n`);
      }
      return null;
    }
  };

  const makeResolver = (state) => {
    const includeCache = new Map();
    const resolver = (stack) => (target) => {
      const file = locate(target);
      if (!file) return null;
      if (stack.includes(file)) {
        throw new Error(`include cycle: ${cycle([...stack, file])}`);
      }
      if (stack.length > maxDepth) {
        throw new Error(`\\input nested deeper than ${maxDepth} at ${target}`);
      }
      const cached = includeCache.get(file);
      const doc = cached ?? parseDocument(stripTexComments(readFileSync(file, 'utf8')), resolver([...stack, file]), state, readText);
      includeCache.set(file, doc);
      return { blocks: doc.blocks, meta: doc.meta, stem: path.basename(file, '.tex'), file };
    };
    return resolver;
  };

  /** Applies LaTeX's rule: an `\input` target without `.tex` gains one. */
  const locate = (target) => {
    for (const dir of includeDirs) {
      const base = path.resolve(dir, target);
      for (const candidate of [base, `${base}.tex`, path.join(base, 'index.tex')]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
    }
    return null;
  };

  const cycle = (list) => {
    const first = list.indexOf(list.at(-1));
    return list.slice(first).map((f) => path.relative(path.dirname(inputs[0]), f) || path.basename(f)).join(' -> ');
  };

  const includeDirs = [path.dirname(inputs[0]), ...(opts.includeDir ?? []).map((d) => path.resolve(d))];
  const maxDepth = opts.maxIncludeDepth ?? 16;

  for (const file of inputs) {
    const state = createParseState();
    // Sibling-deck cross-references (`\dlcref`): display strings supplied by
    // the `xrefs` config map (ref key -> text). Absent means unknown, and an
    // unresolved `\dlcref` then prints nothing rather than inventing a title.
    if (opts.xrefs) state.xrefs = opts.xrefs;
    const doc = parseDocument(stripTexComments(readFileSync(file, 'utf8')), makeResolver(state)([file]), state, readText);
    doc.blocks = flattenBlocks(doc.blocks);
    for (const w of doc.warnings ?? []) warnings.push(`${path.basename(file)}: ${w}`);
    pages.push({ file, doc, outName: pageName(file) });
  }

  // ---- drawings
  //
  // If a real TeX engine is available, TikZ and friends are compiled and the
  // page shows a picture. Otherwise the block stays source, which the renderer
  // already labels honestly. Delegation is opt-in and failure is never fatal.
  if (opts.figures?.delegate) {
    const { renderDrawings, figureCacheDir } = await import('./figures.js');
    const result = await renderDrawings(pages, { opts, outDir, log });
    warnings.push(...result.warnings);
    if (result.rendered) log(`  ${result.rendered} drawing${result.rendered > 1 ? 's' : ''} rendered via ${result.capability.engine}`);
    const figDir = figureCacheDir(outDir);
    if (result.rendered && existsSync(figDir)) {
      for (const name of await fs.readdir(figDir)) {
        if (name.endsWith('.png') || name.endsWith('.svg')) renderedFigures.set(name, path.join(figDir, name));
      }
    }
  }

  // ---- shared assets (images live next to their source file)
  //
  // Two things happen here that a naive copy gets wrong. `\includegraphics` is
  // usually written without an extension, because LaTeX searches for one, so
  // the name is resolved the way graphicx would resolve it. And a vector figure
  // is rasterised: a `.pdf` inside an `<img>` shows nothing, so shipping one
  // unchanged produces a blank space where the diagram should be.
  const assets = new Map(); // emitted basename -> absolute source path
  const missing = new Set(); // referenced but not on disk
  // The name as written in the source is not always the name of the file that
  // ends up on disk: `{Figures/arch}` resolves to `arch.png`, and a vector
  // figure becomes `arch.png` too. Every such rewrite is recorded so the
  // reference and the file agree.
  const emitted = new Map(); // name as written -> emitted basename
  const dpi = Number(opts.figures?.dpi) || 200;

  /*
   * Reserves an output name, and returns one that is free.
   *
   * `assets` is keyed by the name the file will have on disk, so two sources that
   * arrive at the same key overwrite each other and the first figure silently
   * becomes the second. The obvious case is a directory holding both `art.pdf` and
   * `art.png`: the PDF is rasterised to a PNG, the PNG is copied, and both want
   * `art.png`. Whichever was written last won, and both figures in the output then
   * pointed at that one.
   *
   * The first claimant keeps the name, because that is the one a reader would
   * predict. A later claimant with a different source takes a name derived from
   * its own path instead of dropping the file: a hash, so it does not depend on
   * what else happened to be in the directory, which matters because the same name
   * is the cache key for the rasteriser and a cache that moved between runs would
   * recompile every figure in the build.
   */
  const claimed = new Map(); // emitted basename -> source it belongs to
  const claim = (wanted, abs) => {
    const prior = claimed.get(wanted);
    if (prior === undefined || prior === abs) {
      claimed.set(wanted, abs);
      return wanted;
    }
    const ext = path.extname(wanted);
    const stem = ext ? wanted.slice(0, -ext.length) : wanted;
    const unique = `${stem}-${createHash('sha1').update(abs).digest('hex').slice(0, 8)}${ext}`;
    claimed.set(unique, abs);
    return unique;
  };

  for (const page of pages) {
    const fromDir = path.dirname(page.file);
    for (const { name, opts: imageOpts } of collectImages(page.doc.blocks)) {
      if (renderedFigures.has(name)) {
        assets.set(name, renderedFigures.get(name));
        emitted.set(name, name);
        continue;
      }
      const abs = resolveGraphic(name, fromDir);
      if (!abs) { missing.add(name); continue; }

      const ext = path.extname(abs).toLowerCase();
      const stem = path.basename(abs, path.extname(abs));
      if (ext === '.pdf' || ext === '.eps') {
        /*
         * The name carries the extension it was made from, so a rasterised
         * `art.pdf` cannot land on the `art.png` sitting beside it. Everything
         * copied keeps its own extension, so this is the one case where the
         * output name is not simply the source's -- which is the point: the file
         * on disk is not the file that was written.
         */
        const png = `${stem}-${ext.slice(1)}.png`;
        const outName = claim(png, abs);
        // cached by name so a rebuild reuses it
        const cache = path.join(outDir, '.figures', outName);
        let ok = existsSync(cache);
        if (!ok) {
          await fs.mkdir(path.dirname(cache), { recursive: true });
          ok = await rasteriseGraphic(abs, cache, { dpi, trim: imageOpts?.trim || null });
          if (!ok) await fs.rm(cache, { force: true });
        }
        if (ok) {
          assets.set(outName, cache);
          emitted.set(name, outName);
          continue;
        }
        // no rasteriser: copy the original rather than lose the figure, and say
        // plainly that it will not display
        process.stderr.write(
          `λtex2web: ${path.basename(abs)} is vector artwork and no rasteriser is available; `
          + 'it is copied but browsers cannot display it\n'
        );
      }
      const outName = claim(path.basename(abs), abs);
      assets.set(outName, abs);
      emitted.set(name, outName);
    }
  }

  // point every reference at the emitted name
  if (emitted.size) {
    for (const page of pages) renameImages(page.doc.blocks, emitted);
  }
  // a referenced-but-absent image is a diagnostic, not progress chatter, so
  // `--quiet` does not suppress it
  if (opts.assets?.missing !== 'ignore') {
    for (const name of missing) {
      process.stderr.write(`λtex2web: image not found: ${name}\n`);
    }
  }

  const katex = opts.engine === 'katex' ? katexAssets() : null;

  // ---- appearance: layout CSS + palette tokens + the user's own CSS
  const layouts = await loadLayouts();
  const appearance = await resolveAppearance(opts, layouts);
  warnings.push(...appearance.warnings);

  // ---- write vendor + theme assets
  //
  // `emit: 'html-only'` writes just the .html files, for the case where the
  // page links to assets that already live elsewhere (via `--base`). Without
  // it a one-page build drops a theme.css and a vendor tree next to the HTML
  // that does not reference them.
  const htmlOnly = opts.emit === 'html-only';
  await fs.mkdir(outDir, { recursive: true });
  // With `--base`, the stylesheet, the font tree and the images are shared with
  // the pages already in that directory, so they are written there rather than
  // beside this page. That is what lets one directory hold a landing page and
  // papers in different layouts, each with its own stylesheet. Writing images
  // beside the page while linking to them under the base would leave every href
  // pointing at nothing, so all three follow the same directory.
  //
  // Only a relative base names a directory to write to. An absolute path or a
  // URL is a prefix for the hrefs and nothing more — writing to `/docs` or to
  // a CDN path would be wrong, so those keep the files beside the page.
  const localBase = !!opts.base
    && !path.isAbsolute(opts.base)
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(opts.base);
  const sharedDir = localBase ? path.resolve(opts.base) : outDir;
  if (!htmlOnly && sharedDir !== outDir) await fs.mkdir(sharedDir, { recursive: true });

  const assetDir = path.join(sharedDir, opts.assets?.dir ?? 'assets');
  if (!htmlOnly) await fs.mkdir(assetDir, { recursive: true });

  if (htmlOnly) {
    // nothing shared is written
  } else if (opts.singleFile) {
    // everything ends up inlined into each page; nothing else is written
  } else {
    await fs.writeFile(path.join(sharedDir, stylesheetName(appearance.layoutName, appearance.css)), appearance.css);
    if (katex) {
      const kdir = path.join(sharedDir, 'vendor', 'katex');
      await fs.mkdir(path.join(kdir, 'fonts'), { recursive: true });
      await fs.copyFile(katex.css, path.join(kdir, 'katex.min.css'));
      for (const font of await fs.readdir(katex.fonts)) {
        await fs.copyFile(path.join(katex.fonts, font), path.join(kdir, 'fonts', font));
      }
    }
    if (opts.assets?.copy !== false) {
      for (const [name, abs] of assets) {
        await fs.copyFile(abs, path.join(assetDir, name));
      }
    }
  }

  // ---- render pages
  const shell = await resolveTemplate(opts);
  const many = pages.length > 1;
  const styles = await renderStyles({
    themeCss: appearance.css, katex, outDir,
    base: opts.base, singleFile: opts.singleFile, layout: appearance.layoutName,
  });
  let firstHtml = null;

  for (const [i, page] of pages.entries()) {
    // every include is in place by now, so a cross-file \ref can resolve
    resolveAll(page.doc.blocks, page.doc.labels, page.doc.bibliography);
    await runHook(opts, 'afterParse', { page, labels: page.doc.labels });

    const ctx = {
      meta: page.doc.meta,
      // The `\thanks` an author attached to their name. The title block turns
      // these into the first footnotes of the document.
      authorNotes: page.doc.authorNotes,
      katex: opts.engine === 'katex' ? katexModule() : null,
      macros: page.doc.macros,
      parseCell: parseInlineText,
      // `emitted` holds the rewrite from the name as written to the name on disk, so
      // `{Figures/arch}` links to `assets/arch.png` and not `assets/arch`.
      assetUrl: (image) => joinUrl(
        opts.base,
        opts.assets?.dir ?? 'assets',
        emitted.get(image) ?? path.basename(image),
      ),
      missingImages: opts.assets?.missing === 'ignore' ? new Set() : missing,
      transforms: opts.transforms ?? [],
      wordmarkHero: opts.wordmarkHero === true,
    };
    // A date the document does not carry.
    //
    // Not every paper carries a `\date`, and a config may supply one: a paper with
    // no date on its title page reads as a conversion that dropped something
    // rather than a paper that never had it.
    if (!page.doc.meta.date && opts.date) page.doc.meta.date = String(opts.date);

    // Notes go inside the references section when the document has one, so the end
    // of the page is a single numbered list under a single heading. `renderBlocks`
    // has already emitted the references as an ordinary block, so the section it
    // closed last is the one they belong to.
    const rendered = renderBlocks(page.doc.blocks, ctx);
    const { body: withoutReferences, references } = takeLastReferencesSection(rendered);
    let body = references
      ? withoutReferences + renderFootnotes(ctx, references)
      : rendered + renderFootnotes(ctx);
    body = await applyTransforms(body, ctx, page);
    await runHook(opts, 'afterRender', { page, ctx, body });

    const toc = opts.toc?.enabled === false ? '' : renderToc(buildToc(page.doc.blocks, opts.toc?.maxLevel ?? 3), opts.toc);
    const title = opts.title || page.doc.meta.title || path.basename(page.file, '.tex');

    // The document's header, lifted out of the article.
    //
    // It is the page's subject -- the name, or the paper's title and byline --
    // and it wants the full width of the page, above everything, with nothing
    // beside it. Nested inside the article it sits in the text column, and a
    // contents rail alongside it competes with the one thing on the page a
    // reader is certainly looking at. So it becomes a row of its own and the
    // rail starts below it.
    // Only when a layout asks for it.
    //
    // Hoisting the header out of the article is right for a front page, where the
    // title is the page and the contents must start below it. It is wrong for
    // everything else: on a paper the title belongs at the top of the reading
    // column, immediately above the prose, and the moment the header becomes a
    // grid item of its own the auto-placement puts it in the next free cell --
    // which on Ricci Flow was the bottom of the page, under the contents.
    const hoists = opts.hero === 'front-matter';
    const header = hoists ? /^\s*(<header class="doc-header">[\s\S]*?<\/header>)/.exec(body) : null;
    let hero = header ? header[1] : '';
    if (header) body = body.slice(header[0].length);

    // Everything before the first heading is the page's front matter, and on a
    // front page it belongs with the title.
    //
    // The three example cards on the landing page sit between `\maketitle` and
    // the first `\section`. Left there they were below the fold of the hero while
    // the contents rail was beside them, so the reader met a table of contents
    // before they met the examples the page exists to show. `hero: 'front-matter'`
    // lifts all of it into the hero, and the rail starts at the first section --
    // which is where a contents belongs: level with the thing it lists.
    if (hoists && hero) {
      const firstSection = body.indexOf('<section');
      if (firstSection > 0) {
        const front = body.slice(0, firstSection).trim();
        body = body.slice(firstSection);
        if (front) hero = heroShell(hero, front);
      }
    }

    const html = await fillShell(shell, {
      opts,
      pages,
      index: i,
      title,
      description: firstSentence(page.doc),
      styles,
      hero,
      body: `<article class="doc">${body}</article>`,
      toc,
      theme: appearance.layoutName,
      // The *resolved* palette, not the request.
      //
      // A palette may be given as a name or as a `{light, dark}` pair, and the
      // request is interpolated straight into a class attribute. The pair form --
      // which is what the showcase uses for every page, so that light and dark are
      // genuinely different schemes rather than one pinned twice -- stringified to
      // `object Object`, and every page on the site shipped
      // `class="theme-landing palette-[object Object]"`. The name-only path still
      // worked, which is why the suite never caught it: `test/config.test.js` only
      // ever asserts a single named palette.
      //
      // The resolved name is `"Warm Paper/Catppuccin Frappe"` for a pair, which is
      // not a usable class either: a space is not legal in a class attribute's value
      // without escaping, so the two would have to be escaped to match at all.
      // No stylesheet in `themes/` selects on `.palette-*` -- they are all token
      // driven -- so this is a debugging handle rather than a hook, and a slug that
      // can actually be typed into devtools is worth more than a faithful echo of
      // an internal label.
      palette: paletteClass(appearance.palette),
    });

    // each document keeps its own filename; index.html always mirrors the first
    await fs.writeFile(path.join(outDir, `${page.outName}.html`), html);
    if (i === 0) {
      firstHtml = html;
      await fs.writeFile(path.join(outDir, 'index.html'), html);
    }
    log(`  ${path.relative(process.cwd(), path.join(outDir, `${page.outName}.html`))}  (${(html.length / 1024).toFixed(1)} kB)`);
  }

  // ---- landing page when several documents were built together
  if (many) {
    const listing = pages
      .map((p) => `<li><a href="${escapeHtml(`${p.outName}.html`)}">${escapeHtml(p.doc.meta.title || p.outName)}</a></li>`)
      .join('\n');
    const index = await fillShell(shell, {
      opts,
      pages,
      index: 0,
      title: 'Documents',
      description: 'All documents',
      styles,
      theme: appearance.layoutName,
      body: `<article class="doc"><h1>Documents</h1><ul class="itemize index-list">${listing}</ul></article>`,
      toc: '',
      nav: '',
      footer: '',
      scripts: '',
    });
    await fs.writeFile(path.join(outDir, 'all.html'), index);
  }

  await runHook(opts, 'afterBuild', { out: outDir, pages, appearance });

  return {
    out: outDir,
    entry: 'index.html',
    first: firstHtml,
    pages: pages.length,
    layout: appearance.layoutName,
    // The palette that was asked for, as a name.
    //
    // This echoed the raw config value, so `build(x, { palette: { light: ..., dark:
    // ... } })` returned an object where a caller had every reason to expect a
    // string. The resolved label is on `paletteClass` as a slug and in the page's
    // body class; here the requested name is echoed, because a caller reading
    // `result.palette` is checking what they passed in got used.
    palette: typeof opts.palette === 'string' ? opts.palette : paletteClass(appearance.palette),
    paletteClass: paletteClass(appearance.palette),
    theme: opts.theme, // kept for compatibility with older callers
    engine: katex ? `katex@${katex.version}` : 'none',
    math: katex ? 'rendered' : 'fallback',
    assets: assets.size,
    missingImages: missing.size,
    singleFile: !!opts.singleFile,
    warnings,
  };
}

// --------------------------------------------------------------- extensions

/**
 * Wraps a front page's hoisted front matter in its hero.
 *
 * The front matter is two things that sit in different places: an install command,
 * which belongs under the sentence in the left column, and a label plus the list
 * it introduces, which belongs at the top of the right column. They are siblings
 * in the document because the source writes them in reading order, so the split
 * is made here rather than left to the stylesheet.
 *
 * Left whole in one wrapper, they can only ever share a cell. Putting the wrapper
 * in the second column anchored the ledger under the sentence, and putting it in
 * the first put the command at the top of the page. Each time one of the two was
 * correct only by accident of which column the wrapper fell in.
 */
function heroShell(header, front) {
  const open = front.match(/^(?:<figure class="code-block">[\s\S]*?<\/figure>\s*)+/);
  if (!open) return `<div class="hero">${header}<div class="hero-front">${front}</div></div>`;
  const command = open[0];
  const rest = front.slice(command.length).trim();
  return rest
    ? `<div class="hero">${header}${command}<div class="hero-front">${rest}</div></div>`
    : `<div class="hero">${header}${command}</div>`;
}

/**
 * Resolves config paths against the config file's directory, so a config in a
 * parent directory still finds the template and stylesheets that ship with it.
 *
 * `out` is deliberately excluded: where output lands is a property of the
 * invocation, not of the config, so `out: 'dist'` means `./dist` from wherever
 * you ran the command.
 */
function absolutise(opts) {
  const base = opts.__root || process.cwd();
  const one = (v) => (typeof v === 'string' && !path.isAbsolute(v) ? path.resolve(base, v) : v);
  const many = (v) => (Array.isArray(v) ? v.map(one) : one(v));

  const out = { ...opts };
  if (out.template) out.template = one(out.template);
  if (out.css) out.css = Array.isArray(out.css) ? out.css.map((c) => (typeof c === 'string' ? one(c) : (isObj(c) && c.path ? { ...c, path: one(c.path) } : c))) : one(out.css);
  if (out.includeDir) out.includeDir = many(out.includeDir);
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object';

/** `--tokens '{"accent":"#e11"}'` arrives as a string; make it an object. */
function coerceTokens(options) {
  if (typeof options?.tokens !== 'string') return options ?? {};
  try {
    return { ...options, tokens: JSON.parse(options.tokens) };
  } catch (err) {
    throw new Error(`--tokens must be JSON: ${err.message}`);
  }
}

/** The built-in shell, or the user's own file/function. */
async function resolveTemplate(opts) {
  if (typeof opts.template === 'function') return opts.template;
  if (typeof opts.template === 'string') {
    const file = path.resolve(opts.template);
    if (!existsSync(file)) throw new Error(`template not found: ${opts.template}`);
    return await fs.readFile(file, 'utf8');
  }
  return await fs.readFile(path.join(projectRoot, 'templates', 'base.html'), 'utf8');
}

/** Fills a shell's placeholders. A function template receives the same data. */
async function fillShell(shell, data) {
  const {
    opts, pages, index, title, description, styles, body, toc, theme, palette,
  } = data;
  const extraHead = typeof opts.head === 'function' ? await opts.head(data) : (opts.head || '');
  const extraScripts = typeof opts.scripts === 'function' ? await opts.scripts(data) : (opts.scripts || '');
  const nav = data.nav !== undefined
    ? data.nav
    : (Array.isArray(opts.nav) && opts.nav.length
      ? renderSiteNav(opts.nav, opts.github, opts.home || './')
      : (pages.length > 1 ? renderPageNav(pages, index) : ''));
  // The footer is the masthead's furniture in a second place, built from the same
  // `nav` so a link is added once and cannot disagree with the bar. `footer: false`
  // gets the single line of small print back, which is all a lone converted
  // document wants.
  // A colophon is a note about the document, so it goes at the end of the article
  // and at its measure; the site footer is the last thing on the page, so it goes
  // in the shell beside the rail and spans it. The template decides which by where
  // each is placed, so both are produced here and one of them is a colophon.
  const wantFooter = opts.footer !== false && data.footer === undefined;
  const footer = data.footer !== undefined
    ? data.footer
    : (wantFooter ? renderFooter({ meta: {} }, opts, opts.nav || null) : '');
  const colophon = data.colophon !== undefined
    ? data.colophon
    : (wantFooter ? '' : renderColophon({ meta: {} }));

  const tocHtml = toc || '';
  /**
   * The "scroll down" cue on a landing page.
   *
   * A link, not a button, so it works with no script: the `hidden` attribute is
   * the only thing script does, and it is removed once the reader is past the
   * hero. A cue that is still on screen after it has been obeyed is furniture,
   * and on a page shorter than the display there is nowhere to scroll to at all,
   * so the layout hides it there.
   */
  const cueTarget = opts.scrollCue === true ? '#main' : opts.scrollCue;
  const scrollCue = cueTarget
    ? `\n  <a class="scroll-cue" href="${escapeHtml(String(cueTarget))}"`
      + ` data-hide-past>Scroll down</a>`
    : '';

  /**
   * A note about the document itself, above its content.
   *
   * Not metadata and not an abstract: a statement by whoever published the page
   * about what was done to the source. A converted deck that has had diagrams
   * dropped, or a paper with an editorial change, has to say so at the top rather
   * than leaving a reader to work it out by noticing what is missing.
   *
   * Plain text, or a small amount of markup, rendered as a note and labelled for
   * assistive tech as a note -- it is not part of the document's own prose, and a
   * reader who cannot see the rule above it should still be told.
   */
  const notice = opts.notice
    ? `<aside class="doc-notice" role="note">`
      + `<span class="doc-notice-label">Note</span>`
      + `<p>${escapeHtml(String(opts.notice))}</p></aside>`
    : '';

  const values = {
    lang: opts.lang || 'en',
    notice,
    // The document's own header, hoisted above the shell's grid. Empty when the
    // document has none.
    hero: data.hero || '',
    // Where the wordmark goes. Not the asset prefix: `base` is where the CSS
    // and figures live, which on a landing page built into a subdirectory is
    // not where the reader's home page is. Default is the current directory,
    // which is the root of a site and the containing folder of a single page.
    home: opts.home || './',
    // Spelled out because the wordmark is an SVG now, and an SVG carries no text
    // for a screen reader to read.
    wordmarkName: opts.wordmark || 'λtex2web',
    // Only ever 'on' or 'off'. 'auto' is deliberately not a third state that
    // means "on unless someone set a preference": the theme has to be able to
    // answer "is this document animated" with one attribute lookup.
    motion: opts.motion === 'on' ? 'on' : 'off',
    title: escapeHtml(title),
    description: escapeHtml(description),
    theme,
    palette,
    nav,
    footer,
    colophon,
    styles,
    content: body,
    // The same contents is rendered twice on purpose: once as the sticky rail
    // for wide screens and once inside a disclosure for narrow ones. CSS picks
    // which is displayed, so resizing can never leave the reader with neither.
    tocRail: tocHtml ? `\n    <div class="toc-rail">${tocHtml}</div>` : '',
    tocSheet: tocHtml
      ? `\n    <details class="toc-sheet">\n`
        + `      <summary><span class="sheet-name">Contents</span>`
        + `<span class="now" aria-live="polite"></span></summary>\n`
        + `      ${tocHtml}\n    </details>`
      : '',
    toc: tocHtml,
    scripts: clientScript() + cueScript() + fitEquationsScript() + extraScripts,
    head: extraHead,
    scrollCue,
  };

  if (typeof shell === 'function') return shell(values);
  return Object.entries(values).reduce(
    (html, [key, value]) => html.replaceAll(`{{${key}}}`, value ?? ''),
    shell,
  );
}

/** Lets a config rewrite rendered markup after the fact. */
async function applyTransforms(body, ctx, page) {
  let out = body;
  for (const transform of ctx.transforms ?? []) {
    if (typeof transform?.render !== 'function') continue;
    if (typeof transform.match === 'function' && !transform.match(page)) continue;
    out = (await transform.render(out, { ...ctx, page })) ?? out;
  }
  return out;
}

async function runHook(opts, name, payload) {
  const fn = opts.hooks?.[name];
  if (typeof fn !== 'function') return;
  await fn(payload);
}

// ------------------------------------------------------------------ helpers

async function collectInputs(input) {
  const abs = path.resolve(input);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new Error(`input not found: ${input}`);
  if (stat.isFile()) return abs.endsWith('.tex') ? [abs] : [abs];

  const entries = await fs.readdir(abs, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.tex'))
    .map((e) => path.join(abs, e.name))
    .sort();
  return files;
}

function pageName(file) {
  return path.basename(file, '.tex').replace(/[^\w.-]+/g, '-').toLowerCase() || 'index';
}

function joinUrl(base, ...parts) {
  return [base.replace(/\/+$/, ''), ...parts].filter(Boolean).join('/');
}

/** Every referenced image, with the options it was included under. */
/** Every image node at any depth. A link's label can hold one. */
function collectImageNodes(nodes, into) {
  for (const n of nodes || []) {
    if (n.type === 'image') into.push({ name: n.src, opts: n.srcOpts });
    if (n.nodes) collectImageNodes(n.nodes, into);
  }
  return into;
}

function renameImageNodes(nodes, mapping) {
  for (const n of nodes || []) {
    if (n.type === 'image' && mapping.has(n.src)) n.src = mapping.get(n.src);
    if (n.nodes) renameImageNodes(n.nodes, mapping);
  }
}

function collectImages(blocks, into = []) {
  for (const b of blocks || []) {
    // a multi-picture float keeps the first in `image` as well as the full list
    if (b.images?.length) for (const img of b.images) into.push({ name: img.name, opts: img.opts });
    else if (b.image) into.push({ name: b.image, opts: b.imageOpts });
    // `\includegraphics` written in prose rather than in a float. The walk goes
    // all the way down the node tree: an image inside a `minipage` column of a
    // figure is nested several levels in, and only looking at the top level left
    // those uncollected -- so they were never copied and never given the
    // extension LaTeX would have found for them.
    if (b.nodes) collectImageNodes(b.nodes, into);
    if (b.columns) for (const col of b.columns) collectImages(col, into);
    if (b.blocks) collectImages(b.blocks, into);
    if (b.items) for (const it of b.items) collectImages(it.blocks, into);
  }
  return into;
}

/** Rewrites references after a figure was rasterised under a new name. */
function renameImages(blocks, mapping) {
  for (const b of blocks || []) {
    if (b.images) for (const img of b.images) if (mapping.has(img.name)) img.name = mapping.get(img.name);
    if (b.image && mapping.has(b.image)) b.image = mapping.get(b.image);
    if (b.nodes) renameImageNodes(b.nodes, mapping);
    if (b.columns) for (const col of b.columns) renameImages(col, mapping);
    if (b.blocks) renameImages(b.blocks, mapping);
    if (b.items) for (const it of b.items) renameImages(it.blocks, mapping);
  }
}

/**
 * Splits a trailing references section off the end of rendered HTML.
 *
 * The references are emitted by `renderBlocks` as an ordinary block, so by the time
 * the footnotes are rendered they are already in the string, sitting where a
 * bibliography belongs. Taking them back out is what lets `renderFootnotes` put the
 * notes inside them; when there is no such section, `references` is empty and the
 * body is handed back untouched.
 *
 * `lastIndexOf` rather than `indexOf`: a document can carry two -- an inline
 * `thebibliography` and a `.bib` file beside it, say -- and it is the one at the end
 * that the notes belong to.
 */
function takeLastReferencesSection(body) {
  const start = body.lastIndexOf('<section class="references"');
  if (start < 0) return { body, references: '' };
  const close = body.indexOf('</section>', start);
  if (close < 0) return { body, references: '' };
  const end = close + '</section>'.length;
  return { body: body.slice(0, start) + body.slice(end), references: body.slice(start, end) };
}

/**
 * The resolved palette name as a class-name fragment.
 *
 * A `{light, dark}` pair resolves to `"Warm Paper/Catppuccin Frappe"`, which is a
 * label for a human and not a token: the slash and the space have to go. Nothing
 * in `themes/` selects on it -- every theme reads its colours from custom
 * properties -- so it exists to be typed into devtools and to be asserted on.
 */
function paletteClass(name) {
  return String(name || 'none')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function firstSentence(doc) {
  const find = (blocks) => {
    for (const b of blocks || []) {
      if (b.type === 'para') return b.nodes.map((n) => n.value || '').join('');
      if (b.blocks) { const f = find(b.blocks); if (f) return f; }
    }
    return '';
  };
  const text = find(doc.blocks).replace(/\s+/g, ' ').trim();
  if (!text) return doc.meta.title || '';
  const cut = text.search(/[.!?](\s|$)/);
  return cut > 40 ? `${text.slice(0, cut + 1)}` : text.slice(0, 180);
}

/**
/**
 * The masthead navigation.
 *
 * `nav` is a list, and an item with `items` is a dropdown. Dropdowns are
 * `<details>` rather than a hover menu on purpose: a hover menu is unusable with
 * a keyboard and unreachable on a touch screen, and this page is meant to work
 * with JavaScript switched off. `details` gives open/closed state, focus
 * handling and the disclosure role from the platform, with no script at all.
 *
 * With no `nav` the documents of a multi-page build are linked instead, which is
 * what a single converted document wants.
 */
function renderSiteNav(items, github, home = './') {
  // The GitHub mark, from GitHub's own icon, on its 24-unit grid.
  //
  // One unbroken string. A path written as a list of pieces joined with spaces
  // gets a space where two numbers ran together -- `.72 1.21.72` becomes
  // `.72 1.21 .72` -- which splits a coordinate in half and drops a quadrant of
  // the mark while still looking plausible at 19px. Do not reflow this.
  const GITHUB_MARK =
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';

  const githubMark = (repo) => `<a class="icon-link" href="https://github.com/${escapeHtml(repo)}"`
    + ` title="GitHub" rel="noopener" aria-label="GitHub">`
    + '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">'
    + `<path fill="currentColor" d="${GITHUB_MARK}"/></svg></a>`;

  // A `--base` prefix on a page-relative href.
  //
  // The wordmark links to `../` on a page in `site/`, so a link written as
  // `#section-using-it` needs the same treatment or it points at an anchor on the
  // wrong page. `base` is the shared asset prefix, which on this showcase is
  // `site/` -- not the front page. So a bare `#...` href is left alone and the
  // caller spells the page out; here that means the front page is reached by its
  // own name.
  // `home` prefixes a link to a place on the *front page*.
  //
  // The masthead is the same on every page and the pages are not all at the same
  // depth: the front page is at the root and the papers are one directory down. A
  // menu entry written as `#section-using-it` -- "the Using it section" -- is an
  // anchor on whatever page you are already on, which on a paper is an anchor that
  // does not exist. Written as `home + href` it is the same destination from
  // either depth, so the config does not have to know where it is being rendered.
  const atHome = (href) => {
    const h = href || '#';
    return h.startsWith('#') ? `${home}${h}` : h;
  };
  const parts = items.map((item) => {
    if (!item.items?.length) {
      return `<a class="doc-link" href="${escapeHtml(atHome(item.href))}">${escapeHtml(item.label)}</a>`;
    }
    // Three words a row, and nothing else.
    //
    // The menu used to carry a second line per item -- a note describing what the
    // page is -- which made each option two lines tall and turned a three-item
    // menu into a paragraph. A masthead menu is a list of places; the reader
    // picks one and finds out what it is. The note stays, as the link's own
    // accessible name, where it describes the link rather than competing with it.
    const links = item.items.map((sub) => {
      const name = sub.note || sub.label;
      return `<a class="drop-link" href="${escapeHtml(sub.href || '#')}" title="${escapeHtml(name)}">`
        + `<span class="drop-label">${escapeHtml(sub.label)}</span></a>`;
    }).join('\n          ');
    // A `div`, not a `<details>`.
    //
    // `<details>` hides everything that is not its `<summary>` using
    // `content-visibility` on a pseudo-element of the *element itself*, so no
    // rule on the child can bring it back -- `:hover` on the menu did nothing and
    // the menu only ever appeared on a click, which is the opposite of what a
    // masthead menu is for. A plain container with a button opens on hover and on
    // focus, and the button is still a button for anyone using a keyboard.
    return `<div class="drop">\n          <button type="button" class="doc-link drop-toggle"`
      + ` aria-expanded="false">${escapeHtml(item.label)}</button>\n`
      + `          <div class="drop-menu">\n          ${links}\n          </div>\n        </div>`;
  });
  if (github) parts.push(githubMark(github));

  return `<nav class="doc-nav" aria-label="Site">\n      ${parts.join('\n      ')}\n    </nav>`;
}

function renderPageNav(pages, current) {
  const links = pages
    .map((p, i) => {
      const href = i === 0 ? 'index.html' : `${p.outName}.html`;
      const label = p.doc.meta.title || p.outName;
      return `<a class="doc-link${i === current ? ' is-current' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    })
    .join('\n      ');
  return `<nav class="doc-nav" aria-label="Documents">\n      ${links}\n    </nav>`;
}

/** The single line of small print, for a document that is all it wants. */
function renderColophon(doc) {
  const cls = doc.meta?.documentclass;
  const bits = [];
  if (doc.meta?.title) bits.push(escapeHtml(doc.meta.title));
  if (cls) bits.push(`<code>${escapeHtml(cls)}</code>`);
  bits.push('built with latex2web');
  return `      <p class="colophon">${bits.join(' <span class="sep">&middot;</span> ')}</p>`;
}

/**
 * The footer: the mark, one line about what this is, and where there is to go.
 *
 * A lone converted document wants the colophon instead -- title, class, and
 * "built with latex2web" -- so both are configurable. `footer: false` restores
 * the colophon on its own.
 *
 * The columns come from the same `nav` array the masthead is built from, so the
 * two cannot disagree about where the Examples are and a link is added once.
 */
function renderFooter(doc, opts = {}, nav = null) {
  const meta = doc.meta || {};
  const wordmark = opts.wordmark || 'λtex2web';

  // The masthead nests options one level deep (`{label, items}`); a footer wants
  // them flat, so a group becomes a column and a bare link joins "Pages".
  const columns = [];
  const flat = [];
  for (const entry of nav || []) {
    if (Array.isArray(entry.items) && entry.items.length) {
      columns.push({
        heading: entry.label,
        links: entry.items.map((i) => ({ label: i.label, href: i.href })),
      });
    } else if (entry.label && entry.href) {
      flat.push({ label: entry.label, href: entry.href });
    }
  }
  if (flat.length) columns.unshift({ heading: opts.footerPagesLabel || 'Pages', links: flat });
  // The repository is a place to go, not just a mark in the bar, and the footer is
  // where a reader looks for it once they have finished the page.
  if (opts.github) {
    columns.push({
      heading: 'Source',
      links: [{ label: 'On GitHub', href: `https://github.com/${opts.github}` }],
    });
  }

  const rendered = columns
    .map((col) => '        <div class="footer-col">\n'
      + `          <h2 class="footer-head">${escapeHtml(col.heading)}</h2>\n`
      + '          <ul class="footer-links">\n'
      + col.links.map((l) => `            <li><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></li>`).join('\n')
      + '\n          </ul>\n        </div>')
    .join('\n');

  const tagline = opts.footerTagline
    || 'One command turns a LaTeX source into a folder of static files. '
      + 'Nothing to install, nothing to serve, nothing to run in a browser.';
  const cls = meta.documentclass;
  const bits = [];
  if (meta.title) bits.push(escapeHtml(meta.title));
  if (cls) bits.push(`<code>${escapeHtml(cls)}</code>`);
  bits.push('built with latex2web');

  const colophon = bits.join(' <span class="sep">&middot;</span> ');

  return '      <footer class="site-footer">\n'
    + '        <div class="footer-lead">\n'
    + `          <a class="footer-mark" href="${escapeHtml(opts.home || './')}" aria-label="${escapeHtml(wordmark)}">`
    + `${wordmarkSvg(wordmark, 'footer-mark-svg')}</a>\n`
    + `          <p class="footer-tagline">${escapeHtml(tagline)}</p>\n`
    + '        </div>\n'
    + (rendered ? '        <nav class="footer-cols" aria-label="Footer">\n' + rendered + '\n        </nav>\n' : '')
    + `        <p class="footer-fine">${colophon}</p>\n`
    + '      </footer>';
}

/**
 * One stylesheet per layout, so layouts can coexist in one directory.
 *
 * The name carries a fingerprint of the CSS. A stable name plus no cache
 * headers means a browser keeps reusing the stylesheet it already has, so an
 * updated page is served with the old layout and looks like the change was
 * never made. Changing the name when the bytes change is the only fix that does
 * not depend on how the files are hosted.
 */
export function stylesheetName(layout, css = '') {
  const safe = String(layout || 'inline')
    .replace(/\.css$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'inline';
  if (!css) return `theme-${safe}.css`;
  const { createHash } = globalThis.__l2wHash || {};
  const tag = fingerprint(css);
  return tag ? `theme-${safe}.${tag}.css` : `theme-${safe}.css`;
}

/** A short, stable digest of the stylesheet's bytes. */
function fingerprint(css) {
  // a tiny FNV-1a: this only has to change when the CSS does, not be secure
  let h = 0x811c9dc5;
  for (let i = 0; i < css.length; i++) {
    h ^= css.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).slice(0, 8);
}

async function renderStyles({ themeCss, katex, outDir, base, singleFile, layout }) {
  const parts = [];
  if (singleFile) {
    parts.push(`<style>\n${themeCss}\n</style>`);
    if (katex) {
      const css = await fs.readFile(katex.css, 'utf8');
      const inlined = await inlineFonts(css, katex.fonts);
      parts.push(`<style>\n${inlined}\n</style>`);
    }
  } else {
    parts.push(`<link rel="stylesheet" href="${joinUrl(base, stylesheetName(layout, themeCss))}">`);
    if (katex) parts.push(`<link rel="stylesheet" href="${joinUrl(base, 'vendor/katex/katex.min.css')}">`);
  }
  return parts.join('\n    ');
}

/** Rewrites KaTeX's font URLs to data URIs so a page stands alone. */
async function inlineFonts(css, fontDir) {
  const cache = new Map();
  const refs = [...css.matchAll(/url\((fonts\/[^)]+)\)/g)];
  for (const [, ref] of refs) {
    const file = path.join(fontDir, path.basename(ref));
    if (cache.has(file) || !existsSync(file)) continue;
    const buf = await fs.readFile(file);
    cache.set(file, `data:font/woff2;base64,${buf.toString('base64')}`);
  }
  return css.replace(/url\((fonts\/[^)]+)\)/g, (_, ref) => {
    const mime = ref.endsWith('.woff') ? 'font/woff' : 'font/woff2';
    const data = cache.get(path.join(fontDir, path.basename(ref)));
    return data ? `url(data:${mime};base64,${data.slice(data.indexOf(',') + 1)})` : `url(${ref})`;
  });
}

/**
 * The only JavaScript the package emits, and it is all progressive
 * enhancement: the page reads correctly with this blocked.
 */
/**
 * Hides the scroll cue once the reader is past the hero.
 *
 * The one thing here that cannot be done in CSS: "past the hero" is a position,
 * not a width. Kept separate and tiny, and the cue is a plain link without it.
 */
function cueScript() {
  return `
<script>
(() => {
  const cue = document.querySelector('[data-hide-past]');
  if (!cue) return;
  const mark = () => {
    // the hero's own bottom edge, so the cue leaves when the hero does
    const hero = document.querySelector('.doc-header');
    const past = hero ? hero.getBoundingClientRect().bottom < 0 : scrollY > 80;
    cue.hidden = past;
  };
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; mark(); });
  }, { passive: true });
  addEventListener('resize', mark, { passive: true });
  mark();
})();
</script>`;
}

function clientScript() {
  return `<script>
(() => {
  const root = document.documentElement;

  // The palette is the author's decision, so there is deliberately no toggle in
  // the chrome. An explicit override still works, through localStorage or a
  // data-theme attribute on <html>, and is applied before first paint.
  try {
    root.dataset.theme = localStorage.getItem('l2w-theme') || 'auto';
  } catch {}

  window.addEventListener('DOMContentLoaded', () => {
    // The masthead menus.
    //
    // Hover and focus already open them, in CSS, with no script at all. This is
    // only the third way in: a tap. On a touch screen there is no hover, so the
    // button toggles the menu itself and takes the focus with it, which means the
    // next tab lands inside the open menu rather than past it.
    document.querySelectorAll('.drop').forEach((drop) => {
      const toggle = drop.querySelector('.drop-toggle');
      if (!toggle) return;
      toggle.addEventListener('click', () => {
        const open = drop.dataset.open === 'true';
        document.querySelectorAll('.drop[data-open="true"]').forEach((d) => {
          d.dataset.open = 'false';
          d.querySelector('.drop-toggle')?.setAttribute('aria-expanded', 'false');
        });
        drop.dataset.open = open ? 'false' : 'true';
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('.drop')) return;
      document.querySelectorAll('.drop[data-open="true"]').forEach((d) => {
        d.dataset.open = 'false';
        d.querySelector('.drop-toggle')?.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.drop[data-open="true"]').forEach((d) => {
        d.dataset.open = 'false';
        d.querySelector('.drop-toggle')?.setAttribute('aria-expanded', 'false');
      });
    });

    document.querySelectorAll('.copy').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const code = btn.closest('.code-block')?.querySelector('code');
        if (!code) return;
        // The state is a data attribute and nothing else; the words live in the
        // accessible name, where a reader who cannot see the button wants them.
        // Writing to textContent instead would destroy the two-squares glyph on
        // the first click. The picture is the stylesheet's business.
        btn.dataset.state = 'ok';
        btn.setAttribute('aria-label', 'Copied');
        try { await navigator.clipboard.writeText(code.innerText); }
        catch {
          btn.dataset.state = 'bad';
          btn.setAttribute('aria-label', 'Copy failed');
        }
        setTimeout(() => {
          delete btn.dataset.state;
          btn.setAttribute('aria-label', 'Copy code');
        }, 1600);
      });
    });

    // Highlight the section you are in.
    //
    // Not "the heading is on screen": a heading is visible for a moment and then
    // the reader is a screenful into its prose, with nothing highlighted at all.
    // What a contents should say is which section you are *in*, so the marker
    // moves when the next heading passes the reading line and stays put until
    // then.
    const links = [...document.querySelectorAll('.toc-rail .toc a[href^="#"]')];
    const targets = links
      .map((a) => ({ a, el: document.getElementById(decodeURIComponent(a.hash.slice(1))) }))
      .filter((t) => t.el);
    if (targets.length) {
      const setActive = (id) => {
        for (const { a } of targets) {
          const on = a.hash === '#' + id;
          a.classList.toggle('is-active', on);
          if (on) a.setAttribute('aria-current', 'true');
          else a.removeAttribute('aria-current');
          const twin = document.querySelector('.toc-sheet .toc a[href="' + a.hash + '"]');
          if (twin) twin.classList.toggle('is-active', on);
        }
      };
      let current = targets[0].el.id;
      // On a narrow screen the contents is a sticky strip, and the strip is the
      // only place the reader is told which section they are in -- the rail that
      // normally carries that is hidden at that width. So the strip's label is
      // driven from the same reading line as the rail, not from a tap: it is
      // navigation the reader did not have to ask for.
      const now = document.querySelector('.toc-sheet .now');
      const setNow = (id) => {
        if (!now) return;
        const link = targets.find((t) => t.el.id === id)?.a;
        // The number and the name are two elements, and textContent glues them
        // together: the strip read "1Using it". The number comes off a copy of
        // the link rather than being stripped off the string, because a section
        // called "Part 1" would otherwise lose a 1 that was part of its name.
        const bare = link ? link.cloneNode(true) : null;
        if (bare) for (const n of bare.querySelectorAll('.toc-num')) n.remove();
        const label = bare ? bare.textContent.trim() : '';
        const num = link ? (link.querySelector('.toc-num')?.textContent.trim() || '') : '';
        const text = num && label ? num + ' ' + label : (label || num);
        if (now.textContent === text) return;
        now.textContent = text;
        const sheet = now.closest('.toc-sheet');
        if (sheet) {
          sheet.setAttribute('aria-label',
            text ? 'Contents — now reading ' + text : 'Contents');
        }
      };
      const update = () => {
        // The reading line: a little above the top of the viewport. Measured
        // from the viewport rather than from the document so it does not depend
        // on which ancestor happens to be the offset parent.
        const line = innerHeight * 0.28;
        let found = null;
        for (const { el } of targets) {
          if (el.getBoundingClientRect().top <= line) found = el.id;
          else break;
        }
        // Above the first heading there is the title and the abstract: the
        // first section is what a reader is about to read, not the last.
        if (found === null) found = targets[0].el.id;
        if (found !== current) current = found;
        setActive(current);
        setNow(current);
      };
      let queued = false;
      const onScroll = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; update(); });
      };
      addEventListener('scroll', onScroll, { passive: true });
      addEventListener('resize', onScroll, { passive: true });
      // once now, and again once the document has settled: at DOMContentLoaded
      // the headings have no positions yet, which briefly highlighted the last
      // section instead of the first
      update();
      requestAnimationFrame(update);
      addEventListener('load', update, { once: true });
    }
  });
})();
</script>`;
}