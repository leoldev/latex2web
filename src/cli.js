#!/usr/bin/env node
/**
 * latex2web — turn LaTeX into a polished static site.
 *
 *   latex2web input.tex [output-dir] [config-file]
 *
 * Every flag may also be set in a config file. Flags win.
 */

import { readFileSync } from 'node:fs';

import { build } from './index.js';
import { loadConfig, checkConfigKeys } from './config.js';
import { parseArgs } from './args.js';
import { layoutNames, layoutSummary } from './themes.js';
import { PALETTE_NAMES } from './palettes.js';

/*
 * The version is read from the manifest rather than written out here.
 *
 * It was a constant beside this line and package.json said something else, so
 * `latex2web --version` and the published package reported different releases --
 * which is the one thing a version is for. npm always ships package.json, so
 * this resolves in an install from the registry and from a GitHub shorthand
 * alike.
 */
const { version: VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const HELP = `λtex2web ${VERSION} — turn LaTeX into a polished static site

Usage
  λtex2web <input.tex|input-dir> [output-dir] [config-file]

  The output directory and config file are optional positionals. A config file
  is also found automatically by walking up from the working directory.

Options
  -o, --out <dir>          output directory (default: dist)
  -t, --theme <name>       layout: ${layoutNames().join(' | ')}   (default: paper)
  -p, --palette <name>     colour palette: ${PALETTE_NAMES.join(', ')}
      --tokens <json>      token overrides, e.g. '{"accent":"#e11"}'
      --css <path>         extra stylesheet, appended after the layout (repeatable)
      --template <path>    replace the HTML shell entirely
      --engine <name>      katex | plain                          (default: katex)
  -F, --single-file        inline CSS, KaTeX and fonts into one portable .html
      --title <text>       override the document title
      --base <path>        URL prefix for links, e.g. /docs
  -I, --include-dir <dir>  extra search path for \\input/\\include (repeatable)
      --figure-engine <e>   tectonic | latexmk | pdflatex | auto
  -w, --watch              rebuild whenever a source file changes
      --clear-cache        delete the compiled-figure cache before building
  -q, --quiet              suppress progress, not diagnostics
  -v, --version            print the version
  -h, --help               print this message

Config file
  ${'latex2web.config.js'}, latex2web.config.json or .latex2webrc in the working
  directory or any parent. It may export an object or a function, and may set
  \`extends\` to a preset path or package. Precedence: defaults < file < flags.

Layouts
${layoutSummary().map((l) => `  ${l}`).join('\n')}
`;

function fail(message, code) {
  process.stderr.write(`λtex2web: ${message}\n`);
  return code;
}

async function main() {
  let cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(HELP);
    return fail(err.message, 2);
  }

  if (cli.help) { process.stdout.write(HELP); return 0; }
  if (cli.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (!cli.input) {
    process.stderr.write(HELP);
    return fail('no input given', 2);
  }

  let config;
  try {
    config = await loadConfig({ configPath: cli.config, cli });
  } catch (err) {
    return fail(err.message, 2);
  }

  for (const key of checkConfigKeys(config)) {
    process.stderr.write(`λtex2web: warning: unrecognised config key "${key}"\n`);
  }

  const inputs = cli.inputs?.length ? cli.inputs : [cli.input];
  const rebuild = async () => {
    const result = await build(inputs, config);
    // Warnings are diagnostics, not progress: they print even under `-q`
    // so a quiet build never hides a failure the reader should act on.
    {
      for (const line of result.warnings || [])
        process.stderr.write(`λtex2web: warning: ${line}\n`);
      console.log(`  -> ${result.out}`);
      console.log(
        `  ${result.layout} layout · ${result.palette} palette · math ${result.math} (${result.engine}) · `
          + `${result.pages} page${result.pages > 1 ? 's' : ''}`
          + `${result.assets ? ` · ${result.assets} asset${result.assets > 1 ? 's' : ''}` : ''}`
          + `${result.singleFile ? ' · single file' : ''}`
      );
    }
    return result;
  };

  try {
    if (config.watch) {
      const { watch } = await import('./watch.js');
      if (!config.quiet) console.log(`λtex2web  ${inputs.join(' ')}${config.__configFile ? ` (${short(config.__configFile)})` : ''}`);
      let announced = false;
      await watch(inputs, config, async () => {
        const result = await rebuild();
        if (!announced) {
          announced = true;
          console.log(`  open: file://${result.out}/${result.entry}`);
        }
      });
      return 0;
    }

    if (!config.quiet) {
      console.log(`λtex2web  ${inputs.join(' ')}${config.__configFile ? ` (${short(config.__configFile)})` : ''}`);
    }
    const result = await rebuild();
    if (!config.quiet) console.log(`  open: file://${result.out}/${result.entry}`);
  } catch (err) {
    return fail(err.message, 1);
  }
  return 0;
}

const short = (file) => file.replace(process.cwd() + '/', '');

main().then((code) => { process.exitCode = code; });
