/**
 * Command-line parsing.
 *
 * Kept apart from `cli.js` so it can be tested without running a build, and so
 * the positional-versus-flag precedence rule lives in exactly one place:
 *
 *   latex2web <input> [output] [config]
 *
 * A flag always wins over the positional in the same slot, because the flag is
 * the more explicit statement of intent.
 */

/** Flags that take a value, mapped to their config key. */
export const VALUED_FLAGS = {
  '-o': 'out', '--out': 'out',
  '-t': 'theme', '--theme': 'theme',
  '-p': 'palette', '--palette': 'palette',
  '--tokens': 'tokens',
  '--css': 'css',
  '--template': 'template',
  '--engine': 'engine',
  '--emit': 'emit',
  '--figure-engine': 'figureEngine',
  '--title': 'title',
  '--base': 'base',
  '-I': 'includeDir', '--include-dir': 'includeDir',
  '-c': 'config', '--config': 'config',
};

/** Flags that are switches. */
export const BOOLEAN_FLAGS = {
  '-F': 'singleFile', '--single-file': 'singleFile',
  '-w': 'watch', '--watch': 'watch',
  '-q': 'quiet', '--quiet': 'quiet',
  '--clear-cache': 'clearCache',
};

/** Which positional argument feeds which config key. */
export const POSITIONAL_KEYS = { 1: 'out', 2: 'config' };

export function parseArgs(argv) {
  const cli = { positional: [], explicit: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '-v' || arg === '--version') return { version: true };

    if (BOOLEAN_FLAGS[arg]) {
      cli[BOOLEAN_FLAGS[arg]] = true;
      if (!cli.explicit.includes(BOOLEAN_FLAGS[arg]))
        cli.explicit.push(BOOLEAN_FLAGS[arg]);
      continue;
    }

    // --key=value
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUED_FLAGS[name]) {
      const raw = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (raw === undefined) throw new Error(`${name} needs a value`);
      append(cli, VALUED_FLAGS[name], raw);
      continue;
    }

    if (arg.startsWith('-') && arg !== '-')
      throw new Error(`unknown option "${arg}" (try --help)`);
    cli.positional.push(arg);
  }

  cli.input = cli.positional[0];
  cli.inputs = assignPositionals(cli);
  return cli;
}

/**
 * Decides what the positionals mean.
 *
 * `latex2web a.tex out/` is the documented form. But `latex2web *.tex` is such
 * a natural thing to type that it should keep working, so when every
 * positional is a `.tex` file they are all inputs. Anything mixed is read as
 * `[input] [output] [config]`.
 */
function assignPositionals(cli) {
  const pos = cli.positional;
  const allTex = pos.length > 1 && pos.every((p) => /\.tex$/i.test(p));

  if (allTex) {
    return pos;
  }
  for (const [slot, key] of Object.entries(POSITIONAL_KEYS)) {
    const value = pos[Number(slot)];
    if (value !== undefined && !cli.explicit.includes(key)) cli[key] = value;
  }
  return [cli.input];
}

/** Repeatable flags accumulate; everything else overwrites. */
function append(cli, key, raw) {
  const repeatable = key === 'css' || key === 'includeDir';
  if (repeatable && Array.isArray(cli[key])) cli[key].push(raw);
  else cli[key] = repeatable ? [raw] : raw;
  if (!cli.explicit.includes(key)) cli.explicit.push(key);
}
