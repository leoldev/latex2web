/**
 * Bibliographies.
 *
 * Three shapes turn up in real sources, and a paper is only half converted
 * without its references:
 *
 * - `\begin{thebibliography}{99}\bibitem{key} Author. Title. Venue (2020).`
 *   The standard LaTeX form, which is also what a `.bbl` file contains.
 * - `\bibliography{refs}` plus a `refs.bib` on disk. The source names the
 *   database; the entries live beside it. This is what an arXiv submission
 *   ships when it has not been through BibTeX.
 * - A hand-written `\section*{References}` whose paragraphs each begin with a
 *   bracketed label, as Perelman's does: `[B-Em] D.Bakry, M.Emery ...`
 *
 * All three end up as the same list, so `\cite` can resolve to a number and a
 * link in every case.
 */

/** `\begin{thebibliography}{...} ... \end{thebibliography}` → entries. */
export function parseThebibliography(tex) {
  const entries = [];
  const open = /\\begin\s*\{\s*thebibliography\s*\}\s*\{[^}]*\}/.exec(tex);
  if (!open) return entries;

  // step past the widest-label argument, which is not content
  let i = open.index + open[0].length;
  while (i < tex.length && /\s/.test(tex[i])) i++;
  if (tex[i] === '{') i = skipGroup(tex, i);

  const body = tex.slice(i, tex.indexOf('\\end{thebibliography}', i) === -1
    ? tex.length
    : tex.indexOf('\\end{thebibliography}', i));

  // each entry runs from its \bibitem to the next
  const items = [...body.matchAll(/\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)];
  items.forEach((m, n) => {
    const from = m.index + m[0].length;
    const to = items[n + 1]?.index ?? body.length;
    const text = body.slice(from, to).trim();
    entries.push({ key: m[1].trim(), tex: text, kind: 'list' });
  });
  return entries;
}

function skipGroup(s, i) {
  if (s[i] !== '{') return i;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return j + 1;
  }
  return i;
}

/**
 * A `\section*{References}` written by hand.
 *
 * Perelman's is a run of paragraphs each opening with `[A]`, `[B-Em]`,
 * `[Cao-C]`. The label is the key, so a citation written `[B-Em]` in the prose
 * resolves the same way `\cite{B-Em}` would.
 */
const isReferencesHeading = (title) =>
  /^(references|bibliography|works cited|literature cited)$/i.test((title || '').trim());

/**
 * Takes `[Label] rest` as a new entry, or folds the line into the last.
 *
 * Perelman's references arrive as one paragraph with the entries on separate
 * lines, so the text is split before anything is matched -- treating the whole
 * paragraph as one entry collapses all forty of them into the first.
 *
 * The brackets are required. An entry that began with any word would swallow
 * the prose of a references section written without labels, which is a much
 * worse failure than missing an entry.
 */
function takeEntry(entries, text) {
  for (const line of text.split(/\n|\\par\b/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^\[([^\]]{1,32})\]\s*(\S[\s\S]*)$/.exec(line);
    if (m) entries.push({ key: m[1].trim(), tex: m[2].trim(), kind: 'list' });
    else if (entries.length) entries[entries.length - 1].tex += ` ${line}`;
  }
}

/**
 * The reference list a paper wrote as prose, lifted out of the flow and out of
 * the way.
 *
 * A paper with a real `thebibliography` has it removed from the source before the
 * body is read, and put back as a list at the end -- so the entries appear once. A
 * paper that instead writes its references as `[A] Author. Title. Journal...`
 * under a `\section*{References}`, separated by `\par`, has no environment to
 * remove: the references are ordinary paragraphs, and they were being *read* into
 * a list and then left where they were. Perelman's paper came out with all
 * twenty-seven works twice -- once as a single 1453px paragraph under the author's
 * own heading, and again as the list we had built from reading that paragraph.
 *
 * So the paragraphs that were read are removed, exactly as the environment is. The
 * author's heading is left alone and the list is rendered under it, which is where
 * the paper had it.
 */
export function liftAdhocReferences(blocks) {
  const entries = [];
  const lifted = [];

  const visit = (list) => {
    // A references section does not own the paragraphs after it: they stay
    // siblings, because a heading followed by `\par`-separated text is not a
    // block structure a section can adopt. So the run continues over siblings.
    let inReferences = false;
    for (const block of list || []) {
      if (block.type === 'section') {
        inReferences = isReferencesHeading(block.title);
        if (block.blocks) visit(block.blocks);
        continue;
      }
      if (!inReferences) continue;
      if (block.type === 'para') {
        const before = entries.length;
        takeEntry(entries, (block.nodes || []).map((n) => n.value ?? '').join(''));
        // only a paragraph that yielded an entry is removed. A paragraph of prose
        // under the heading that happened not to parse as a reference stays put.
        if (entries.length > before) lifted.push({ list, block });
      }
      if (block.blocks) visit(block.blocks);
    }
  };
  visit(blocks);
  for (const { list, block } of lifted) {
    const at = list.indexOf(block);
    if (at >= 0) list.splice(at, 1);
  }
  return entries;
}

/**
 * A BibTeX database, read far enough to format an entry.
 *
 * Deliberately not a full BibTeX parser: fields are read as balanced groups,
 * which is what a `.bib` file actually contains, and the common field names are
 * formatted. LaTeX is not run to do this, because running it is not available
 * here and half-parsing it silently would be worse than not claiming it.
 */
export function parseBibFile(text) {
  const entries = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const type = m[1].toLowerCase();
    const key = m[2].trim();
    // The body is the group that opens right after the entry type -- not
    // whatever follows the comma, which is the first field.
    const open = m.index + 1 + m[1].length;
    const end = matchingBrace(text, open);
    if (end < 0) continue;
    const body = text.slice(open + 1, end);
    const fields = {};
    const fre = /(\w+)\s*=\s*(?:\{\{?([\s\S]*?)\}?\}?|(\S+?))\s*,?\s*(?=\n\s*\w+\s*=|\s*$)/g;
    let f;
    while ((f = fre.exec(body)) !== null) {
      const name = f[1].toLowerCase();
      if (!['author', 'title', 'journal', 'booktitle', 'year', 'month', 'volume',
        'number', 'pages', 'publisher', 'address', 'editor', 'note', 'school',
        'institution', 'howpublished', 'doi', 'url'].includes(name)) continue;
      fields[name] = (f[2] ?? f[3] ?? '').replace(/\s+/g, ' ').trim();
    }
    // `kind` says what the list is, which decides what the reference list becomes.
  //
  // A `thebibliography` is the paper's own finished list: it holds exactly the
  // works the paper cites, already in the order the style chose, and its numbers
  // are the numbers the paper prints. A `.bib` is a database -- one course
  // repository's file holds nine hundred entries for every lecture in the series
  // -- so the paper's references are the entries it cites, in the order it first
  // cites them.
  entries.push({ key, fields, type, kind: 'database' });
    re.lastIndex = end;
  }
  return entries;
}

function matchingBrace(s, open) {
  if (s[open] !== '{') return -1;
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return j;
  }
  return -1;
}

/** Formats a BibTeX entry as the reference line a reader expects. */
export function formatEntry(entry) {
  if (entry.tex) return entry.tex; // \bibitem: the source already wrote it
  const f = entry.fields || {};
  const authors = (f.author || f.editor || '')
    .split(/\s+and\s+/i).filter(Boolean)
    .map((a) => a.trim().replace(/\s+/g, ' '))
    .join(', ');
  const parts = [];
  if (authors) parts.push(authors + '.');
  if (f.title) parts.push(`${stripBraces(f.title)}.`);
  if (f.journal) parts.push(`${stripBraces(f.journal)}`);
  else if (f.booktitle) parts.push(`In ${stripBraces(f.booktitle)}`);
  else if (f.school) parts.push(`PhD thesis, ${stripBraces(f.school)}`);
  else if (f.institution) parts.push(stripBraces(f.institution));
  if (f.volume) parts.push(String(f.volume));
  if (f.number) parts.push(`(${f.number})`);
  if (f.pages) parts.push(String(f.pages).replace(/--/g, '–'));
  if (f.year) parts.push(String(f.year));
  if (f.publisher || f.address) parts.push([f.publisher, f.address].filter(Boolean).join(', '));
  if (f.doi) parts.push(`doi:${f.doi}`);
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function stripBraces(s) {
  return String(s).replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}
