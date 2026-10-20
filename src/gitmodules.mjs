/**
 * @packageDocumentation
 *
 * The `.gitmodules` file codec: parse the file into submodule declarations and encode them back,
 * and read the two outputs that report where each submodule is pinned (`git submodule status`
 * lines and `ls-files --stage` / `ls-tree` gitlink rows). Pure; running git is the engine's.
 */

/**
 * @typedef {Readonly<{
 *   name: string,
 *   path: string,
 *   url: string,
 *   branch?: string,
 *   update?: string,
 *   ignore?: string,
 *   custodyRole?: string,
 *   custodyReason?: string,
 * }>} GitmoduleEntry
 */

/**
 * @typedef {Readonly<{
 *   path: string,
 *   commit: string,
 *   status: "pinned" | "uninitialized" | "modified" | "merged",
 *   raw: string,
 * }>} GitSubmoduleStatusEntry
 */

/** True only for a source-local Gitlink location. The working-copy publisher
 * must never follow a malformed .gitmodules location into a sibling ANT,
 * .git control directory, or unrelated operating repository. Documentary
 * parsing normalizes paths; effectful consumers must request raw-path admission. */
export function containedGitmodulePath(path) {
  return typeof path === 'string' && path.length > 0
    && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path)
    && !/[\\\0\r\n]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.'
      && part !== '..' && part.toLowerCase() !== '.git');
}

/**
 * Parse a `.gitmodules` file's text into its submodule entries, sorted by
 * path. By default documentary paths retain the established normalization.
 * Effectful consumers select requireContainedPaths to reject each original
 * path before normalization, including overwritten or incomplete declarations.
 *
 * @param {string} text
 * @param {{ requireContainedPaths?: boolean }} [options]
 * @returns {readonly GitmoduleEntry[]}
 */
export function parseGitmodules(text, { requireContainedPaths = false } = {}) {
  const entries = [];
  let current;
  const flush = () => {
    if (requireContainedPaths && current !== undefined && current.path === undefined)
      throw new TypeError('source-declared Gitlink must be repository-relative and contained');
    if (current?.path !== undefined && current.url !== undefined) {
      entries.push(Object.freeze({
        name: current.name,
        path: current.path,
        url: current.url,
        ...(current.branch === undefined ? {} : { branch: current.branch }),
        ...(current.update === undefined ? {} : { update: current.update }),
        ...(current.ignore === undefined ? {} : { ignore: current.ignore }),
      }));
    }
  };
  for (const raw of text.split(/\r?\n/u)) {
    const section = /^\s*\[submodule\s+"(.+)"\]\s*$/u.exec(raw);
    if (section?.[1] !== undefined) {
      flush();
      current = { name: section[1] };
      continue;
    }
    const field = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/u.exec(raw);
    if (current === undefined || field?.[1] === undefined || field[2] === undefined) continue;
    if (field[1] === "path") {
      if (requireContainedPaths && !containedGitmodulePath(field[2]))
        throw new TypeError('source-declared Gitlink must be repository-relative and contained');
      current.path = normalizePath(field[2]);
    }
    else if (field[1] === "url") current.url = field[2];
    else if (field[1] === "branch") current.branch = field[2];
    else if (field[1] === "update") current.update = field[2];
    else if (field[1] === "ignore") current.ignore = field[2];
  }
  flush();
  return Object.freeze(entries.sort((left, right) => left.path.localeCompare(right.path)));
}

/**
 * Whether a submodule is part of the composition its superproject's commit makes: checked out in a
 * worktree and carried in a release. One marked `update = none` is not (data with its own lifecycle,
 * such as a channel's production state), as `git submodule update` leaves it.
 *
 * @param {GitmoduleEntry} entry
 * @returns {boolean}
 */
export function composed(entry) {
  return entry.update !== "none";
}

/**
 * Encode submodule entries back into `.gitmodules` file text, sorted by
 * path.
 *
 * @param {readonly GitmoduleEntry[]} entries
 * @returns {string}
 */
export function encodeGitmodules(entries) {
  return entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => [
      `[submodule "${entry.name}"]`,
      `\tpath = ${entry.path}`,
      `\turl = ${entry.url}`,
      ...(entry.branch === undefined ? [] : [`\tbranch = ${entry.branch}`]),
      ...(entry.ignore === undefined ? [] : [`\tignore = ${entry.ignore}`]),
      ...(entry.update === undefined ? [] : [`\tupdate = ${entry.update}`]),
    ].join("\n"))
    .join("\n") + (entries.length === 0 ? "" : "\n");
}

/**
 * Parse `git submodule status` output lines into status entries.
 *
 * @param {string} text
 * @returns {readonly GitSubmoduleStatusEntry[]}
 */
export function parseGitSubmoduleStatus(text) {
  return Object.freeze(text.split(/\r?\n/u).flatMap((line) => {
    if (line.trim().length === 0) return [];
    const marker = line[0] ?? " ";
    const parts = line.slice(1).trim().split(/\s+/u);
    const commit = parts[0] ?? "";
    const path = parts[1] ?? "";
    if (commit === "" || path === "") return [];
    return [Object.freeze({
      path: normalizePath(path),
      commit,
      status: marker === "-" ? "uninitialized" : marker === "+" ? "modified" : marker === "U" ? "merged" : "pinned",
      raw: line,
    })];
  }).sort((left, right) => left.path.localeCompare(right.path)));
}

/**
 * Parse the gitlinks (mode 160000) among `git ls-files --stage` entries, NUL-separated as `-z`
 * gives them or one per line, into status entries.
 *
 * @param {string} text
 * @returns {readonly GitSubmoduleStatusEntry[]}
 */
export function parseGitlinks(text) {
  return Object.freeze(text.split(/\0|\r?\n/u).flatMap((line) => {
    const match = /^160000 ([A-Fa-f0-9]{40,64}) \d+\t(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) return [];
    return [Object.freeze({
      path: normalizePath(match[2]),
      commit: match[1],
      status: "pinned",
      raw: line,
    })];
  }).sort((left, right) => left.path.localeCompare(right.path)));
}

/**
 * Compare submodule declarations with gitlinks by path: the declarations no gitlink pins and the
 * gitlinks no declaration names.
 *
 * @param {readonly { path: string }[]} declarations
 * @param {readonly { path: string }[]} gitlinks
 */
export function compareSubmodules(declarations, gitlinks) {
  const declared = new Set(declarations.map((entry) => entry.path));
  const linked = new Set(gitlinks.map((entry) => entry.path));
  return Object.freeze({
    declarationsWithoutGitlink: Object.freeze(declarations.filter((entry) => !linked.has(entry.path))),
    gitlinksWithoutDeclaration: Object.freeze(gitlinks.filter((entry) => !declared.has(entry.path))),
  });
}

function normalizePath(value) {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}
