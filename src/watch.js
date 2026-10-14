/**
 * Watch mode: rebuild when a source file changes.
 *
 * Deliberately dependency-free and deliberately simple — it tracks the set of
 * `.tex` files that actually took part in the build (the entry points plus
 * whatever they `\input`), rather than watching whole directory trees, so an
 * unrelated `.tex` file cannot trigger a rebuild.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEBOUNCE_MS = 80;

/** Every `.tex` reachable from `entries` by following `\input`/`\include`. */
export async function collectSources(entries, includeDirs = []) {
  const seen = new Map(); // path -> mtimeMs

  const locate = (target, fromDir) => {
    for (const dir of [fromDir, ...includeDirs]) {
      const base = path.resolve(dir, target);
      for (const candidate of [base, `${base}.tex`, path.join(base, 'index.tex')]) {
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* keep looking */ }
      }
    }
    return null;
  };

  const visit = async (file) => {
    if (seen.has(file)) return;
    let src;
    try {
      src = await fsp.readFile(file, 'utf8');
    } catch {
      return;
    }
    seen.set(file, statMtime(file));
    const re = /\\(?:input|include)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const target = m[1].trim();
      if (!target || target.includes('\\')) continue; // skip \jobname-style macros
      const found = locate(target, path.dirname(file));
      if (found) await visit(found);
    }
  };

  for (const entry of entries) await visit(path.resolve(entry));
  return seen;
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Runs `rebuild()` on start and again whenever any tracked source changes.
 * Returns a function that stops watching.
 */
export async function watch(inputs, options, rebuild) {
  const entries = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean);
  if (!entries.length) throw new Error('watch: nothing to watch');

  const includeDirs = (options.includeDir ?? []).map((d) => path.resolve(d));

  const watchDirs = new Set();
  for (const file of (await collectSources(entries, includeDirs)).keys()) {
    watchDirs.add(path.dirname(file));
  }
  // watch the entry directories too, so a newly added \include is noticed
  for (const entry of entries) watchDirs.add(path.resolve(path.dirname(entry)));

  const watchers = [];
  for (const dir of watchDirs) {
    try {
      watchers.push(fs.watch(dir, { persistent: true }, () => schedule()));
    } catch (err) {
      process.stderr.write(`latex2web: cannot watch ${dir}: ${err.message}\n`);
    }
  }

  let timer = null;
  let building = false;
  let pending = false;
  let stopped = false;
  let snapshot = await collectSources(entries, includeDirs);

  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  };

  const run = async () => {
    if (building) { pending = true; return; }
    building = true;
    try {
      const next = await collectSources(entries, includeDirs);
      const touched = [...next]
        .filter(([file, mtime]) => !snapshot.has(file) || snapshot.get(file) !== mtime)
        .map(([file]) => file);
      const added = [...next.keys()].filter((f) => !snapshot.has(f));
      const removed = [...snapshot.keys()].filter((f) => !next.has(f));
      if (!touched.length && !added.length && !removed.length) return;
      snapshot = next;

      // pick up any directory created by a move or a fresh \input
      for (const file of next.keys()) {
        const dir = path.dirname(file);
        if (watchDirs.has(dir)) continue;
        watchDirs.add(dir);
        try {
          watchers.push(fs.watch(dir, { persistent: true }, () => schedule()));
        } catch { /* ignore */ }
      }

      process.stdout.write(`${stamp()} changed ${describe(touched, added, removed)}\n`);
      await rebuild();
    } catch (err) {
      // a broken build must not kill the watcher
      process.stderr.write(`${stamp()} build failed: ${err.message}\n`);
    } finally {
      building = false;
      if (pending) { pending = false; schedule(); }
    }
  };

  await rebuild();

  process.stdout.write(
    `latex2web: watching ${snapshot.size} file${snapshot.size === 1 ? '' : 's'} in ` +
    `${watchDirs.size} director${watchDirs.size === 1 ? 'y' : 'ies'} — ctrl-c to stop\n`,
  );

  return function stop() {
    stopped = true;
    clearTimeout(timer);
    for (const w of watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
  };
}

const describe = (touched, added, removed) => {
  const bits = touched.map((f) => short(f));
  if (added.length) bits.push(...added.map((f) => `+${short(f)}`));
  if (removed.length) bits.push(...removed.map((f) => `-${short(f)}`));
  const shown = bits.slice(0, 3);
  return shown.join(' ')
    + (bits.length > shown.length ? ` +${bits.length - shown.length} more` : '');
};

const short = (file) => {
  const rel = path.relative(process.cwd(), file);
  // keep the line readable when the project lives far from the cwd
  return rel && !rel.startsWith('..') ? rel : path.basename(file);
};

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}