/**
 * Pure request, command-plan, and output codecs for the code-development engine's Git effects:
 * repository observation, exact-path commits, branch integration, linked worktrees, repository
 * establishment, submodule registration, and bounded restore. This module never opens a repository and never runs Git; the
 * owning system engine supplies those effects.
 */

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function literalPath(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && !value.startsWith("/")
    && !value.startsWith("./")
    && !/[\0\n\t]/u.test(value)
    && !value.split(/[\\/]/u).some((segment) => segment === ".." || segment === ".git");
}

const DECOMMISSION_COMPOUND = /\b([A-Za-z][\w]*(?:-[A-Za-z][\w]*)*)-decommission(?:ed|ing)?\b/giu;
const DECOMMISSION_PHRASE = /(?<!-)\bdecommission(?:ed|ing)?\s+(?:the\s+|an?\s+)?["'`]?([A-Za-z][\w./-]*)/giu;

/** The targets a message claims to decommission ("X-decommission", "decommission the X") that no
 *  committed path names. A claim in prose is not evidence the target was touched: founder ruling
 *  2026-09-11, after a commit titled as an FAE decommission touched no FAE path and the package
 *  survived for weeks behind sessions trusting the claim. */
function unbackedDecommissionClaims(message, paths) {
  const named = paths.join("\n").toLowerCase();
  const targets = new Set([...message.matchAll(DECOMMISSION_COMPOUND), ...message.matchAll(DECOMMISSION_PHRASE)].map((match) => match[1]));
  return [...targets].filter((target) => !named.includes(target.toLowerCase()));
}

const REVIEWED_OID = /^(?!0{40}$)[0-9a-f]{40}$/u;
const REVIEWED_TYPES = Object.freeze({ "040000": "tree", "100644": "blob", "100755": "blob", "120000": "blob", "160000": "commit" });
const reviewedPath = (value) => typeof value === "string" && value.length > 0
  && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
const exactFields = (value, keys) => record(value) !== undefined && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

/** Reviewed identities are data, not permission or an observation of the current source. */
function readReviewedSource(value, paths, originalPaths) {
  if (!exactFields(value, ["revision", "entries"]) || typeof value.revision !== "string" || !REVIEWED_OID.test(value.revision)
    || !Array.isArray(value.entries) || value.entries.length !== paths.length
    || originalPaths.length !== paths.length || !paths.every(reviewedPath)) {
    throw new TypeError("git-commit-paths reviewedSource requires an immutable revision and one exact entry per selected safe path");
  }
  const selected = new Set(paths), seen = new Set();
  const entries = [];
  for (const entry of value.entries) {
    if (!record(entry) || !reviewedPath(entry.path) || !selected.has(entry.path) || seen.has(entry.path)) {
      throw new TypeError("git-commit-paths reviewedSource entries must name each selected path exactly once");
    }
    seen.add(entry.path);
    if (Object.hasOwn(entry, "absent")) {
      if (!exactFields(entry, ["path", "absent"]) || entry.absent !== true) {
        throw new TypeError("git-commit-paths reviewedSource absence must be explicit absent:true without an object identity");
      }
      entries.push(Object.freeze({ path: entry.path, absent: true }));
    } else {
      if (!exactFields(entry, ["path", "mode", "type", "sha"]) || typeof entry.mode !== "string"
        || !Object.hasOwn(REVIEWED_TYPES, entry.mode) || REVIEWED_TYPES[entry.mode] !== entry.type
        || typeof entry.sha !== "string" || !REVIEWED_OID.test(entry.sha)) {
        throw new TypeError("git-commit-paths reviewedSource entry requires a matching Git mode/type and non-null immutable object id");
      }
      entries.push(Object.freeze({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha }));
    }
  }
  return Object.freeze({ revision: value.revision, entries: Object.freeze(entries) });
}

/** Admit and normalize the public git-commit-paths request. */
export function readGitCommitPathsRequest(input) {
  const value = record(input);
  const paths = Array.isArray(value?.paths) ? [...new Set(value.paths)].sort() : [];
  const message = typeof value?.message === "string" ? value.message.trim() : "";
  if (paths.length === 0 || !paths.every(literalPath)) throw new TypeError("git-commit-paths requires literal repository-relative file paths");
  if (message.length === 0) throw new TypeError("git-commit-paths requires a non-empty message");
  const unbacked = unbackedDecommissionClaims(message, paths);
  if (unbacked.length > 0) throw new TypeError(`git-commit-paths message claims decommissioning ${unbacked.map((target) => `'${target}'`).join(", ")} but no committed path names it`);
  for (const flag of ["push", "dryRun"]) if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw new TypeError(`git-commit-paths ${flag} must be boolean when supplied`);
  const reviewedSource = value.reviewedSource === undefined ? undefined : readReviewedSource(value.reviewedSource, paths, value.paths);
  return Object.freeze({ paths: Object.freeze(paths), message, push: value.push === true, dryRun: value.dryRun === true,
    ...(reviewedSource === undefined ? {} : { reviewedSource }) });
}

/** Branches managed by the worktree owner, whose retirement may delete a remote ref.
 * Integration accepts contributions independently of this lifecycle naming convention. */
export const WORK_BRANCH = /^(?:codex|duty|transaction)\/[A-Za-z0-9_.-]+$/u;

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** Admit the named branch trace that is to be joined into origin/main and, when it names an
 *  `expectedBranchHead`, the one commit the branch must stand at to be joined: the commit a
 *  receiver accepted, never whatever the branch holds by the time it is joined. */
export function readGitBranchIntegrationRequest(input) {
  const value = record(input);
  const branch = typeof value?.branch === "string" ? value.branch.trim() : "";
  const message = typeof value?.message === "string" ? value.message.trim() : "";
  const expected = value?.expectedBranchHead;
  const sourceBase = value?.sourceBase;
  if (typeof sourceBase !== "string" || !OID.test(sourceBase)) throw new TypeError("git branch integration requires the original sourceBase object id for the entire intended delivery");
  if (branch.length === 0 || branch === "main" || branch.includes("\0")) throw new TypeError("git branch integration requires a contribution branch other than main");
  if (value.source !== undefined && value.source !== "local" && value.source !== "origin") throw new TypeError("git branch integration source must be local or origin");
  if (value.source === "origin" && expected === undefined) throw new TypeError("origin branch integration requires expectedBranchHead");
  if (message.length === 0) throw new TypeError("git branch integration requires a non-empty message");
  if (expected !== undefined && (typeof expected !== "string" || !OID.test(expected))) throw new TypeError("git branch integration expectedBranchHead must be an object id");
  return Object.freeze({ branch, message, sourceBase, ...(value.source === undefined ? {} : { source: value.source }), ...(expected === undefined ? {} : { expectedBranchHead: expected }) });
}

/** A declarative Git process request for the code-development engine. */
export function gitCommand(arguments_, { input = null, environment = Object.freeze({}), ok = [0] } = {}) {
  if (!Array.isArray(arguments_) || !arguments_.every((entry) => typeof entry === "string")) throw new TypeError("Git arguments must be strings");
  return Object.freeze({
    command: "git",
    arguments: Object.freeze([...arguments_]),
    environment: Object.freeze({ ...environment }),
    input,
    ok: Object.freeze([...ok]),
  });
}

export function splitNullOutput(output) {
  return Object.freeze(output.split("\0").filter(Boolean));
}

export function readOid(output) {
  const oid = output.trim().split(/\s+/u)[0] ?? "";
  if (!OID.test(oid)) throw new Error(`Git did not return an object id: ${output.trim()}`);
  return oid;
}

/** Read which of `paths` the index holds, from `cat-file --batch-check` over `indexedPaths(paths)`. */
export function readIndexedPaths(paths, output) {
  const rows = output.split("\n");
  return Object.freeze(paths.filter((_, index) => rows[index] !== undefined && rows[index] !== "" && !rows[index].endsWith(" missing")));
}

const headerDecoder = new TextDecoder();

/**
 * Take one `git cat-file --batch` record off the front of `bytes`: the object as git names it,
 * its type, its body, and the bytes after it. An object the repository lacks has no type or body.
 * Undefined while the record is still incomplete, so a streaming reader waits for more bytes; a
 * header git would never write throws.
 */
export function takeBatchRecord(bytes) {
  const newline = bytes.indexOf(10);
  if (newline === -1) return undefined;
  const header = headerDecoder.decode(bytes.subarray(0, newline));
  if (header.endsWith(" missing")) {
    return Object.freeze({ object: header.slice(0, -" missing".length), type: undefined, body: undefined, rest: bytes.subarray(newline + 1) });
  }
  const [object, type, size, extra] = header.split(" ");
  const length = Number(size);
  if (extra !== undefined || !OID.test(object ?? "") || !type || !/^\d+$/u.test(size ?? "") || !Number.isSafeInteger(length)) {
    throw new Error(`Git returned a malformed cat-file header: ${header.slice(0, 200)}`);
  }
  const end = newline + 1 + length;
  if (bytes.length < end + 1) return undefined;
  if (bytes[end] !== 10) throw new Error(`Git returned a cat-file body without its newline for ${object}`);
  return Object.freeze({ object, type, body: bytes.subarray(newline + 1, end), rest: bytes.subarray(end + 1) });
}

/**
 * Read the whole output of `gitHistoryPlan.blobs(objects)` as each object's text in request order, undefined for
 * one the repository lacks. For UTF-8 text: the runner hands output back as a string, so it is
 * re-encoded to count bodies in bytes.
 */
export function readBatchBlobs(objects, output) {
  let bytes = typeof output === "string" ? new TextEncoder().encode(output) : output;
  const bodies = [];
  for (const object of objects) {
    const record = takeBatchRecord(bytes);
    if (record === undefined) throw new Error(`Git cat-file output ended before ${object}`);
    if (OID.test(object) && record.object !== object) throw new Error(`Git cat-file returned a different object than ${object}`);
    if (record.type !== undefined && record.type !== "blob") throw new Error(`Git cat-file returned a non-blob for ${object}`);
    bodies.push(record.body === undefined ? undefined : headerDecoder.decode(record.body));
    bytes = record.rest;
  }
  if (bytes.length > 0) throw new Error("Git cat-file returned more records than were requested");
  return Object.freeze(bodies);
}

/** Read one `git log --raw --no-abbrev --no-renames` change line as { before, after, status, path }
 *  (a deletion's `after` is the null id); undefined for any other line of the log. */
export function readRawChange(line) {
  if (!line.startsWith(":")) return undefined;
  const tab = line.indexOf("\t");
  const [, , before, after, status] = line.slice(1, tab).split(" ");
  if (tab === -1 || !OID.test(before ?? "") || !OID.test(after ?? "") || !status) throw new Error(`Git returned a malformed raw change: ${line.slice(0, 200)}`);
  return Object.freeze({ before, after, status, path: line.slice(tab + 1) });
}

const objectList = (objects) => {
  if (objects.some((object) => typeof object !== "string" || object.length === 0 || /[\n\r]/u.test(object))) {
    throw new TypeError("Git object names read in a batch must be non-empty single lines");
  }
  return objects.map((object) => `${object}\n`).join("");
};

// Path lists travel on stdin, never as arguments, so no commit is sized by the OS argument limit.
const PATHS_FROM_STDIN = Object.freeze(["--pathspec-from-file=-", "--pathspec-file-nul"]);
const pathList = (paths) => `${paths.join("\0")}\0`;
const LITERAL = Object.freeze({ GIT_LITERAL_PATHSPECS: "1" });
const ANY_STATUS = Object.freeze(Array.from({ length: 256 }, (_, status) => status));

export const gitCommitPathsPlan = Object.freeze({
  root: () => gitCommand(["rev-parse", "--show-toplevel"]),
  gitDirectory: () => gitCommand(["rev-parse", "--path-format=absolute", "--git-dir"]),
  // A plumbing commit skips what porcelain `git commit` honours, so the engine reads it first:
  // signing, the hooks directory (core.hooksPath included), and unmerged entries.
  commitSigning: () => gitCommand(["config", "--bool", "commit.gpgSign"], { ok: [0, 1] }),
  hooksDirectory: () => gitCommand(["rev-parse", "--path-format=absolute", "--git-path", "hooks"]),
  unmergedPaths: () => gitCommand(["ls-files", "-u", "-z"]),
  runHook: (name) => gitCommand(["hook", "run", "--ignore-missing", name], { ok: ANY_STATUS }),
  indexedPaths: (paths) => gitCommand(["cat-file", "--batch-check"], { input: paths.map((file) => `:0:${file}\n`).join("") }),
  head: () => gitCommand(["rev-parse", "HEAD"]),
  commitMessage: (commit) => gitCommand(["show", "-s", "--format=%B", commit]),
  branch: () => gitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"]),
  // An owner read must not inherit pruning, child traversal or graph writes
  // from a developer's ambient configuration. Child custody is admitted apart.
  fetchMain: () => gitCommand(["-c", "fetch.writeCommitGraph=false", "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", "origin", "+refs/heads/main:refs/remotes/origin/main"]),
  remoteMain: () => gitCommand(["rev-parse", "refs/remotes/origin/main"]),
  branchHead: (branch) => gitCommand(["rev-parse", `refs/heads/${branch}`]),
  checkBranchRef: (branch) => gitCommand(["check-ref-format", `refs/heads/${branch}`], { ok: [0, 1] }),
  originBranchHead: (branch) => gitCommand(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { ok: [0, 2] }),
  fetchCommit: (commit) => gitCommand(["-c", "fetch.writeCommitGraph=false", "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", "origin", commit]),
  mergeBase: (left, right) => gitCommand(["merge-base", left, right]),
  changedPaths: (before, after) => gitCommand(["diff", "--name-only", "-z", "--no-renames", before, after]),
  deletedPaths: (before, after) => gitCommand(["diff", "--name-only", "--diff-filter=D", "-z", "--no-renames", before, after]),
  removePaths: (paths) => gitCommand(["rm", "-q", "--cached", "--ignore-unmatch", ...PATHS_FROM_STDIN], { input: pathList(paths), environment: LITERAL }),
  localPaths: (head) => gitCommand(["diff", "--name-only", "-z", "--no-renames", head]),
  showFile: (commit, file) => gitCommand(["show", `${commit}:${file}`]),
  // The merge printed, never written over `current`: a conflict must not leave markers in a file another writer is using.
  mergeFile: (current, base, other) => gitCommand(["merge-file", "-p", current, base, other], { ok: Array.from({ length: 128 }, (_, status) => status) }),
  // The same merge printed with every conflict resolved to the current side, leaving the file alone.
  mergeFileFavoringCurrent: (current, base, other) => gitCommand(["merge-file", "-p", "--ours", current, base, other]),
  readTree: (head, index) => gitCommand(["read-tree", head], { environment: { GIT_INDEX_FILE: index } }),
  // Forcing admits an ignored path the shared index already tracks, never an untracked ignored one.
  addPaths: (paths, index, { force = false } = {}) => gitCommand(["add", "-A", ...(force ? ["-f"] : []), ...PATHS_FROM_STDIN], { input: pathList(paths), environment: { GIT_INDEX_FILE: index, ...LITERAL } }),
  // Content the worktree does not hold (a cut of a shared file) enters a temporary index as a blob.
  hashBlob: (file, content) => gitCommand(["hash-object", "-w", "--stdin", `--path=${file}`], { input: content }),
  stageBlob: (file, blob, index) => gitCommand(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { environment: { GIT_INDEX_FILE: index } }),
  writeTree: (index) => gitCommand(["write-tree"], { environment: { GIT_INDEX_FILE: index } }),
  treeChangedPaths: (parent, tree) => gitCommand(["diff-tree", "--no-commit-id", "-r", "--name-only", "-z", parent, tree]),
  commitTree: (tree, parents, message) => gitCommand(["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message]),
  updateHead: (candidate, expected) => gitCommand(["update-ref", "HEAD", candidate, expected], { ok: [0, 1, 128] }),
  resetPaths: (commit, paths) => gitCommand(["reset", "-q", commit, ...PATHS_FROM_STDIN], { input: pathList(paths), environment: LITERAL }),
  mergeTree: (left, right) => gitCommand(["merge-tree", "--write-tree", left, right], { ok: [0, 1] }),
  mergeTreeNamed: (left, right) => gitCommand(["merge-tree", "--write-tree", "--name-only", left, right], { ok: [0, 1] }),
  branchChangedPaths: (base, branch) => gitCommand(["diff", "--name-status", "-z", "--no-renames", `${base}...${branch}`]),
  changedPathStatuses: (before, after) => gitCommand(["diff", "--name-status", "-z", "--no-renames", before, after]),
  pathStatus: (file) => gitCommand(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", file], { environment: LITERAL }),
  checkoutPaths: (commit, paths) => gitCommand(["checkout", commit, ...PATHS_FROM_STDIN], { input: pathList(paths), environment: LITERAL }),
  // Every push refuses to publish a gitlink whose submodule commit no remote holds yet.
  pushMain: () => gitCommand(["push", "--recurse-submodules=check", "origin", "HEAD:refs/heads/main"], { ok: [0, 1, 128] }),
  pushCommitMain: (candidate, expected) => gitCommand(["push", "--recurse-submodules=check", `--force-with-lease=refs/heads/main:${expected}`, "origin", `${candidate}:refs/heads/main`], { ok: [0, 1, 128] }),
  remoteHead: () => gitCommand(["ls-remote", "--heads", "origin", "refs/heads/main"]),
});

/**
 * Repository history read as a stream: every added, modified or deleted blob a pathspec names
 * across refs (`exclude` tips skip history an earlier pass read), the ref tips a later pass
 * excludes, one long-lived `cat-file --batch` fed object names line by line, and one batch read
 * of named objects whose output `readBatchBlobs` decodes.
 */
export const gitHistoryPlan = Object.freeze({
  revisions: ({ pathspecs = ["*.md"], refs = ["--all"], exclude = [] } = {}) => gitCommand(["-c", "core.quotepath=off", "log", ...refs, ...exclude.map((tip) => `^${tip}`),
    "--format=@%H %cI", "--raw", "--no-renames", "--no-abbrev", "--", ...pathspecs]),
  refTips: () => gitCommand(["for-each-ref", "--format=%(objectname)"]),
  blobStream: () => gitCommand(["cat-file", "--batch"]),
  blobs: (objects) => gitCommand(["cat-file", "--batch"], { input: objectList(objects) }),
  localObjects: () => gitCommand(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]),
  // Same multi-object acquisition as Git's promisor reader. Never move a ref,
  // traverse submodules, fetch a history, or interpret caller-supplied refs.
  prefetchBlobs: (objects) => {
    if (!Array.isArray(objects) || !objects.length || objects.length > 4096 || objects.some(object => !OID.test(object)))
      throw new TypeError("one to 4096 exact Git object IDs required for blob acquisition");
    return gitCommand(["-c", "protocol.file.allow=never", "-c", "core.hooksPath=/dev/null", "-c", "fetch.negotiationAlgorithm=noop",
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--recurse-submodules=no", "--filter=blob:none", "origin", "--stdin"],
    { input: objectList([...new Set(objects)]) });
  },
});

/** Linked worktrees: one checkout per unit of work, outside the shared checkout, sharing its objects. */
export const gitWorktreePlan = Object.freeze({
  fetchMain: gitCommitPathsPlan.fetchMain,
  add: (workspace, commit) => gitCommand(["worktree", "add", "--detach", workspace, commit]),
  remove: (workspace) => gitCommand(["worktree", "remove", "--force", workspace], { ok: [0, 128] }),
  prune: () => gitCommand(["worktree", "prune"]),
  deleteBranch: (branch) => gitCommand(["branch", "-D", branch], { ok: [0, 1] }),
  branchHead: (branch) => gitCommand(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { ok: [0, 1] }),
  // Custody of the producer's original source survives closing and resuming its worktree.
  recordSourceBase: (branch, commit) => gitCommand(["config", "--local", `branch.${branch}.sourceBase`, readOid(commit)]),
  sourceBase: (branch) => gitCommand(["config", "--local", "--get", `branch.${branch}.sourceBase`], { ok: [0, 1] }),
  resetBranch: (branch, commit) => gitCommand(["checkout", "-B", branch, commit, "-f"]),
  clean: () => gitCommand(["clean", "-fdx", "-e", "node_modules", "-e", "**/node_modules"]),
  // File modes are ignored throughout: pnpm's bin linking marks scripts executable in a worktree,
  // which is not the worker's change.
  status: () => gitCommand(["-c", "core.fileMode=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  addAll: () => gitCommand(["-c", "core.fileMode=false", "add", "-A"]),
  // A worktree composes other repositories at its submodules. Their own changes are committed in
  // them; the superproject stages its own paths apart from their gitlinks, and the gitlinks last.
  addOwn: (submodules) => gitCommand(["-c", "core.fileMode=false", "add", "-A", "--", ".", ...submodules.map((submodule) => `:(exclude,literal)${submodule}`)]),
  addSubmodules: (submodules) => gitCommand(["add", "--", ...submodules.map((submodule) => `:(literal)${submodule}`)]),
  staged: () => gitCommand(["diff", "--cached", "--quiet"], { ok: [0, 1] }),
  updateSubmodules: (submodules) => gitCommand(["submodule", "update", "--init", "--force", "--", ...submodules]),
  gitlink: (commit, submodule) => gitCommand(["rev-parse", "--verify", "--quiet", `${commit}:${submodule}`], { ok: [0, 1, 128] }),
  isAncestor: (ancestor, descendant) => gitCommand(["merge-base", "--is-ancestor", ancestor, descendant], { ok: [0, 1, 128] }),
  resetKeep: (commit) => gitCommand(["reset", "--keep", commit]),
  pushCommit: (commit, branch) => gitCommand(["push", "--force", "origin", `${commit}:refs/heads/${branch}`]),
  commit: (paragraphs) => gitCommand(["commit", ...paragraphs.flatMap((paragraph) => ["-m", paragraph])]),
  head: gitCommitPathsPlan.head,
  changes: (base, branch) => gitCommitPathsPlan.branchChangedPaths(base, branch),
  rebase: (onto) => gitCommand(["rebase", onto], { ok: [0, 1, 128] }),
  rebaseAbort: () => gitCommand(["rebase", "--abort"], { ok: [0, 1, 128] }),
  // A conflicted task is replayed as one squashed change onto main, its conflicts left as markers
  // in the worktree for the worker to resolve; the worker's message travels with it.
  messages: (base, head) => gitCommand(["log", "--reverse", "--format=%B", `${base}..${head}`]),
  squashMerge: (commit) => gitCommand(["merge", "--squash", "--no-commit", commit], { ok: [0, 1] }),
  unmergedPaths: () => gitCommand(["diff", "--name-only", "--diff-filter=U", "-z"]),
  pushMain: gitCommitPathsPlan.pushMain,
  pushBranch: (branch) => gitCommand(["push", "--recurse-submodules=check", "--force", "origin", `HEAD:refs/heads/${branch}`]),
  // Deleting a published branch once main holds its commits; a branch already gone is no failure.
  // Only a work branch is ever deleted.
  unpublishBranch: (branch) => {
    if (!WORK_BRANCH.test(branch)) throw new TypeError("only a codex/, duty/ or transaction/ work branch is unpublished");
    return gitCommand(["push", "origin", "--delete", `refs/heads/${branch}`], { ok: [0, 1] });
  },
  trackedFiles: (directory) => gitCommand(["ls-files", "-z", "--", directory], { environment: LITERAL }),
  gitDirectory: gitCommitPathsPlan.gitDirectory,
  commonDirectory: () => gitCommand(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
});

const UNTRACKED_FILES = new Set(["no", "normal", "all"]);

function revision(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-") || /[\r\n\0]/u.test(value)) {
    throw new TypeError("a Git revision must be a non-empty string without line breaks or NUL that does not begin with -");
  }
  return value;
}

function commitBound(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new TypeError("maximumCommits must be an integer from 1 through 100000");
  return value;
}

// Observations whose fields may hold any text travel as NUL-separated fields closed by RS.
const COMMIT_FIELDS = "%H%x00%P%x00%aN%x00%aE%x00%aI%x00%cN%x00%cE%x00%cI%x00%s%x1e";
const PATH_COMMIT_FIELDS = "%H%x00%aI%x00%cI%x1e";
const REFERENCE_FIELDS = "%(refname)%00%(refname:short)%00%(objecttype)%00%(objectname)%1e";

/** Observing one repository without changing it: its root, branch, HEAD, porcelain status,
 *  unstaged diff summaries, and bounded history: a revision's commits and tree, one path's
 *  commits, its refs, which annotated tags a commit reaches, and commit counts; where its
 *  large-file objects go; and its submodules. A detached or
 *  unborn HEAD is a reading, not a failure. Status names untracked files as git's
 *  `--untracked-files` does: `no`, `normal` (the default), or `all`. */
export const gitRepositoryObservationPlan = Object.freeze({
  root: gitCommitPathsPlan.root,
  branch: () => gitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: [0, 1, 128] }),
  head: () => gitCommand(["rev-parse", "--verify", "--quiet", "HEAD"], { ok: [0, 1, 128] }),
  status: ({ untracked = "normal" } = {}) => {
    if (!UNTRACKED_FILES.has(untracked)) throw new TypeError("git status untracked must be no, normal, or all");
    return gitCommand(["status", "--porcelain=v1", "-z", `--untracked-files=${untracked}`]);
  },
  diffStat: () => gitCommand(["diff", "--stat"]),
  nameStatus: () => gitCommand(["diff", "--name-status", "-z", "--no-renames"]),
  commit: (ref) => gitCommand(["rev-parse", "--verify", `${revision(ref)}^{commit}`]),
  commits: (ref, maximumCommits) => gitCommand(["log", "--topo-order", `--max-count=${commitBound(maximumCommits)}`, `--format=${COMMIT_FIELDS}`, revision(ref), "--"]),
  tree: (ref) => gitCommand(["ls-tree", "-r", "-l", "-z", revision(ref)]),
  pathCommits: (ref, file, maximumCommits) => {
    if (!literalPath(file)) throw new TypeError("a path history names one repository-relative path");
    return gitCommand(["log", `--max-count=${commitBound(maximumCommits)}`, `--format=${PATH_COMMIT_FIELDS}`, revision(ref), "--", file], { environment: LITERAL });
  },
  references: (namespace = "refs") => gitCommand(["for-each-ref", `--format=${REFERENCE_FIELDS}`, revision(namespace)]),
  // Annotated tags peeled to their commits, in the order named, and the tags a commit reaches.
  peeledCommits: (refs) => gitCommand(["rev-parse", ...refs.map((ref) => `${revision(ref)}^{commit}`)]),
  reachedTags: (commit) => gitCommand(["for-each-ref", `--merged=${revision(commit)}`, `--format=${REFERENCE_FIELDS}`, "refs/tags"]),
  commitCount: (include, exclude = []) => gitCommand(["rev-list", "--count", ...include.map(revision), ...(exclude.length === 0 ? [] : ["--not", ...exclude.map(revision)]), "--"]),
  // Where large-file objects go: the repository's git directory, the configuration naming an LFS
  // endpoint or transfer agent (unset is exit 1), its remotes, and the endpoint git-lfs itself
  // resolves, which is absent when git-lfs is not installed.
  gitDirectory: () => gitCommand(["rev-parse", "--absolute-git-dir"], { ok: [0, 128] }),
  configValue: (key) => gitCommand(["config", "--get", key], { ok: [0, 1] }),
  configValues: (pattern) => gitCommand(["config", "--get-regexp", pattern], { ok: [0, 1] }),
  remotes: () => gitCommand(["remote"]),
  remoteUrl: (name) => gitCommand(["remote", "get-url", name]),
  lfsEnvironment: () => gitCommand(["lfs", "env"], { ok: ANY_STATUS }),
  // Submodules as the index records them: the `.gitmodules` it holds (none is exit 128), the staged
  // entries whose gitlinks pin each submodule's commit, and the superproject whose index holds this
  // worktree as a gitlink, empty for none.
  gitmodules: () => gitCommand(["cat-file", "blob", ":.gitmodules"], { ok: [0, 128] }),
  stage: () => gitCommand(["ls-files", "--stage", "-z"]),
  superproject: () => gitCommand(["rev-parse", "--show-superproject-working-tree"]),
});

/** Registering an existing clean repository as a submodule of the worktree holding it: `submodule
 *  add` of a path that already holds a repository records it in place, never cloning, and the
 *  child is then detached at the commit its gitlink pins. */
/** A new repository: initialized on `main`, its hooks read from a versioned directory, and its
 *  written files made its first commit. */
export const gitEstablishmentPlan = Object.freeze({
  init: () => gitCommand(["init", "--quiet", "--initial-branch=main"]),
  hooksPath: (directory) => {
    if (!literalPath(directory)) throw new TypeError("a hooks path names one repository-relative directory");
    return gitCommand(["config", "core.hooksPath", directory]);
  },
  stageAll: () => gitCommand(["add", "--all"]),
  commit: (message) => {
    if (typeof message !== "string" || message.trim().length === 0) throw new TypeError("a first commit needs a message");
    return gitCommand(["commit", "--quiet", "--file=-"], { input: message });
  },
});

export const gitSubmodulePlan = Object.freeze({
  add: (url, directory, name) => {
    if (typeof url !== "string" || url.length === 0 || /[\0\n]/u.test(url)) throw new TypeError("a submodule url must be a non-empty single-line string");
    if (!literalPath(directory)) throw new TypeError("a submodule path names one repository-relative directory");
    if (name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new TypeError("a submodule name is one plain segment");
    return gitCommand(["submodule", "add", "--force", ...(name ? ["--name", name] : []), "--", url, directory]);
  },
  /** Move a submodule's repository out of its working tree into the superproject's `modules/`. */
  absorb: (directory) => gitCommand(["submodule", "absorbgitdirs", "--", literal(directory)]),
  detach: (commit) => gitCommand(["checkout", "--detach", revision(commit)]),
});

function literal(directory) {
  if (!literalPath(directory)) throw new TypeError("a path names one repository-relative directory");
  return directory;
}

/** Extracting one directory of a repository into a repository of its own, with the history of every
 *  path the directory has had. The rewrite runs in a shared clone, never in the source repository. */
export const gitExtractionPlan = Object.freeze({
  /** Materialize only the selected path history before a shared clone loses
   * the source's promisor-remote boundary. Never census the whole object store. */
  missingHistoryObjects: (commit, directories) => {
    if (!Array.isArray(directories) || directories.length === 0) throw new TypeError("history materialization requires selected directories");
    return gitCommand(["rev-list", "--objects", "--quiet", "--missing=print", revision(commit), "--", ...directories.map(literal)]);
  },
  fetchHistoryObjects: (objects) => {
    if (!Array.isArray(objects) || objects.length === 0) throw new TypeError("history materialization requires missing object identities");
    return gitCommand(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--stdin", "origin"], { input: objects.map(readOid).join("\n") + "\n" });
  },
  /** Recovery reads one immutable historical cut even when the current parent has retired it. */
  filesAt: (commit, directory) => gitCommand(["ls-tree", "-r", "--name-only", "-z", revision(commit), "--", literal(directory)]),
  namesAt: (commit, file) => gitCommand(["log", "--follow", "--name-only", "--format=", "-z", revision(commit), "--", literal(file)]),
  historyNamesAt: (commit, directories) => {
    if (!Array.isArray(directories) || directories.length === 0 || directories.length > 64) throw new TypeError("standalone history names 1 to 64 directories");
    return gitCommand(["log", "--name-only", "--no-renames", "--format=", "-z", revision(commit), "--", ...directories.map(literal)], { environment: LITERAL });
  },
  // Select scratch refs without materializing the whole source worktree.
  // filter-repo resets only the retained tree after rewriting the history.
  selectRevision: (commit) => gitCommand(["update-ref", "refs/heads/main", revision(commit)]),
  attachMain: () => gitCommand(["symbolic-ref", "HEAD", "refs/heads/main"]),
  remoteRefs: (url) => gitCommand(["ls-remote", "--refs", "--", remoteUrl(url)]),
  // The empty expected value refuses a concurrent main creation; never overwrite target history.
  pushEmptyMain: (url) => gitCommand(["push", "--quiet", "--recurse-submodules=check", "--force-with-lease=refs/heads/main:", remoteUrl(url), "HEAD:refs/heads/main"]),
  /** Every path `file` has had, newest first, following renames. */
  names: (file) => gitCommand(["log", "--follow", "--name-only", "--format=", "-z", "--", literal(file)]),
  ignored: (directory) => gitCommand(["status", "--ignored", "--untracked-files=normal", "--porcelain=v1", "-z", "--", literal(directory)]),
  cloneShared: (source, target) => gitCommand(["clone", "--quiet", "--shared", "--no-checkout", "--single-branch", "--no-tags", "--", source, target]),
  /** Keep only `directories` (every name one directory has had), each rewritten to the root. */
  rewriteTo: (directories) => {
    if (!Array.isArray(directories) || directories.length === 0) throw new TypeError("at least one directory is kept");
    return gitCommand(["filter-repo", "--force", "--quiet",
      ...directories.flatMap((directory) => ["--path", `${literal(directory)}/`]),
      ...directories.flatMap((directory) => ["--path-rename", `${directory}/:`])]);
  },
  tree: (commit, directory) => gitCommand(["rev-parse", "--verify", "--quiet", directory ? `${revision(commit)}:${literal(directory)}` : `${revision(commit)}^{tree}`], { ok: [0, 1, 128] }),
  /** Retain selected files without admitting their former parent directories. */
  rewriteMappings: (mappings) => {
    if (!Array.isArray(mappings) || mappings.length === 0 || mappings.length > 64) throw new TypeError("extraction requires 1 to 64 explicit path mappings");
    const sources = new Set();
    const paths = mappings.map(({ from, to = "", kind = "directory" } = {}) => {
      literal(from);
      if (to !== "") literal(to);
      if (!["file", "directory"].includes(kind) || (kind === "file" && !to)) throw new TypeError("file extraction requires a receiving file path");
      if (sources.has(from)) throw new TypeError("duplicate extraction source path");
      sources.add(from);
      const suffix = kind === "directory" ? "/" : "";
      return { from: from + suffix, to: to + (to && kind === "directory" ? "/" : "") };
    });
    return gitCommand(["filter-repo", "--force", "--quiet",
      ...paths.flatMap(({ from }) => ["--path", from]),
      ...paths.flatMap(({ from, to }) => ["--path-rename", `${from}:${to}`])]);
  },
  head: () => gitCommand(["rev-parse", "--verify", "HEAD"]),
  checkout: (branch) => gitCommand(["checkout", "--quiet", revision(branch)]),
  /** The commits since `base` that touched `directory`, as patches relative to it. */
  patchesSince: (base, directory) => gitCommand(["format-patch", "--stdout", "--binary", `--relative=${literal(directory)}`, `${revision(base)}..HEAD`, "--", directory]),
  applyPatches: (patches) => gitCommand(["am", "--quiet", "--keep-cr", "--committer-date-is-author-date"], { input: patches }),
  pushMain: (url) => gitCommand(["push", "--quiet", remoteUrl(url), "HEAD:refs/heads/main"]),
  /** Make the directory a repository at `commit` in place: its index is read from the commit and its
   *  files are left as they are, so whatever another writer has not committed stays a change. */
  init: () => gitCommand(["init", "--quiet", "--initial-branch=main"]),
  addOrigin: (url) => gitCommand(["remote", "add", "origin", remoteUrl(url)]),
  fetchMain: () => gitCommand(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "origin", "main"]),
  adopt: (commit) => gitCommand(["reset", "--quiet", revision(commit)], { ok: [0, 1] }),
  track: () => gitCommand(["branch", "--quiet", "--set-upstream-to=origin/main", "main"]),
  untrack: (directory) => gitCommand(["rm", "-r", "--cached", "--quiet", "--", literal(directory)]),
});

function recoveryCarrierPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-") || /[\r\n\0]/u.test(value)) {
    throw new TypeError("a recovery carrier path must be a non-empty single-line path that does not begin with -");
  }
  return value;
}

/** Create and assay a self-contained Git bundle recovery carrier without consulting a remote. */
export const gitRecoveryBundlePlan = Object.freeze({
  create: (file) => gitCommand(["bundle", "create", recoveryCarrierPath(file), "--all"]),
  verify: (file) => gitCommand(["bundle", "verify", recoveryCarrierPath(file)]),
  clone: (file, directory = "repository") => {
    if (!literalPath(directory)) throw new TypeError("a recovery assay directory is one repository-relative path");
    return gitCommand(["clone", "--quiet", "--no-checkout", "--", recoveryCarrierPath(file), directory]);
  },
  hasCommit: (commit) => gitCommand(["cat-file", "-e", `${revision(commit)}^{commit}`]),
});

const RESTORE_REQUEST = "RepositoryRestoreObservationRequest";
const RESTORE_REQUEST_REFUSED = Object.freeze(["argv", "command", "environment", "effects", "mutation", "gitArguments"]);

function remoteUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-") || /[\r\n\0]/u.test(value)) {
    throw new TypeError("a Git remote url must be a non-empty single-line string that does not begin with -");
  }
  return value;
}

function restoredFile(value) {
  if (!literalPath(value) || value.endsWith("/") || /[\r*?[\]\\]/u.test(value) || value.split("/").some((segment) => segment === "" || segment === ".")) {
    throw new TypeError("a restored path names one literal repository-relative file, with no empty, dot or parent segment");
  }
  return value;
}

/** Admit a `RepositoryRestoreObservationRequest`: the remote and ref to fetch and 1 to 64 distinct literal
 *  files to materialize, sorted. The caller names what to restore, never how: a request that
 *  supplies arguments, commands, environment or effects is refused. */
export function readRepositoryRestoreRequest(input) {
  const value = record(input);
  if (value?.type !== RESTORE_REQUEST) throw new TypeError(`a restore request's type must be ${RESTORE_REQUEST}`);
  for (const key of RESTORE_REQUEST_REFUSED) if (Object.hasOwn(value, key)) throw new TypeError(`a restore request may not select ${key}`);
  const paths = Array.isArray(value.requiredPaths) ? value.requiredPaths : [];
  if (paths.length === 0 || paths.length > 64) throw new TypeError("a restore request names 1 to 64 required paths");
  const requiredPaths = [...new Set(paths.map(restoredFile))].sort();
  if (requiredPaths.length !== paths.length) throw new TypeError("a restore request's required paths must be distinct");
  return Object.freeze({ type: RESTORE_REQUEST, remoteUrl: remoteUrl(value.remoteUrl), ref: revision(value.ref), requiredPaths: Object.freeze(requiredPaths) });
}

/** Materializing selected tracked files of one remote ref in a fresh repository, never touching the
 *  repository they came from: `origin` is a promisor fetched at depth one with no trees, so objects
 *  arrive only as the selected files need them; the projection is a no-cone sparse checkout of
 *  exactly those files, detached, large-file pointers left unsmudged; each file is read as the
 *  object its commit names and as the object its worktree bytes hash to; and the selected
 *  large-file objects are pulled, their names joined by commas as git-lfs takes them. */
export const gitRestorePlan = Object.freeze({
  initialize: (directory) => {
    if (!literalPath(directory) || directory.startsWith("-")) throw new TypeError("a restore repository is one relative directory");
    return gitCommand(["init", "--quiet", directory]);
  },
  addOrigin: (url) => gitCommand(["remote", "add", "origin", remoteUrl(url)]),
  promisor: () => gitCommand(["config", "remote.origin.promisor", "true"]),
  treelessFilter: () => gitCommand(["config", "remote.origin.partialclonefilter", "tree:0"]),
  fetch: (ref) => gitCommand(["fetch", "--quiet", "--depth=1", "--filter=tree:0", "origin", revision(ref)]),
  fetched: () => gitRepositoryObservationPlan.commit("FETCH_HEAD"),
  sparse: (files) => gitCommand(["sparse-checkout", "set", "--no-cone", "--stdin"], { input: files.map((file) => `/${restoredFile(file)}\n`).join("") }),
  checkout: (commit) => gitCommand(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", revision(commit)], { environment: { GIT_LFS_SKIP_SMUDGE: "1" } }),
  object: (commit, file) => gitCommand(["rev-parse", "--verify", `${revision(commit)}:${restoredFile(file)}`]),
  worktreeObject: (file) => gitCommand(["hash-object", "--", restoredFile(file)]),
  pullLfs: (files) => {
    if (files.length === 0 || files.some((file) => restoredFile(file).includes(","))) throw new TypeError("a large-file pull names one or more files without commas");
    return gitCommand(["lfs", "pull", `--include=${files.join(",")}`, "--exclude="]);
  },
});

const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n?$/u;

/** Read a file's bytes as a Git LFS pointer (at most 1024 bytes): the `sha256:` oid of the object it
 *  stands for and that object's size as its decimal digits, or null when the bytes are no pointer. */
export function readLfsPointer(bytes) {
  if (bytes.length > 1024) return null;
  const match = LFS_POINTER.exec(headerDecoder.decode(bytes));
  return match === null ? null : Object.freeze({ oid: `sha256:${match[1]}`, size: match[2] });
}

/** Read the endpoint `git lfs env` resolves, or "" when it names none. */
export function readLfsEndpoint(output) {
  return (/^Endpoint=(.*)$/mu.exec(output)?.[1] ?? "").trim();
}

/** Read the distinct transfer-agent names of `config --get-regexp ^lfs\.customtransfer\.` rows: each
 *  key's subsection, which may itself hold dots, between the prefix and the variable name. */
export function readLfsCustomTransferAgents(output) {
  const prefix = "lfs.customtransfer.";
  const keys = output.split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.split(" ")[0]);
  return Object.freeze([...new Set(keys.filter((key) => key.lastIndexOf(".") > prefix.length).map((key) => key.slice(prefix.length, key.lastIndexOf("."))))]);
}

/** Read RS-closed records of `width` NUL-separated fields. */
export function readFieldRecords(output, width) {
  const records = output.split("\u001e").map((entry) => entry.replace(/^\n/u, "")).filter(Boolean).map((entry) => entry.split("\0"));
  if (records.some((fields) => fields.length !== width)) throw new Error("Git returned a malformed NUL-separated record");
  return Object.freeze(records.map((fields) => Object.freeze(fields)));
}

/** Read `log --format` commits of `gitRepositoryObservationPlan.commits`. */
export function readCommits(output) {
  return Object.freeze(readFieldRecords(output, 9).map(([id, parents, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, subject]) => Object.freeze({
    id,
    parents: Object.freeze(parents === "" ? [] : parents.split(" ")),
    author: Object.freeze({ name: authorName, email: authorEmail, at: authoredAt }),
    committer: Object.freeze({ name: committerName, email: committerEmail, at: committedAt }),
    subject,
  })));
}

/** Read `log --format` commits of `gitRepositoryObservationPlan.pathCommits`. */
export function readPathCommits(output) {
  return Object.freeze(readFieldRecords(output, 3).map(([id, authoredAt, committedAt]) => Object.freeze({ id, authoredAt, committedAt })));
}

/** Read `for-each-ref` rows as { ref, name, type, object }: the full ref, its short name, and the
 *  type and id of the object it names. */
export function readReferences(output) {
  return Object.freeze(readFieldRecords(output, 4).map(([ref, name, type, object]) => Object.freeze({ ref, name, type, object })));
}

/** Read `ls-tree -r -z` entries as { path, mode, type, object, bytes }, refusing a tree of more
 *  than `maximumPaths` entries. `bytes` is null for a gitlink, and for every entry when the
 *  listing ran without `-l`, which spares git inflating each blob to size it. */
export function readTreeEntries(output, maximumPaths = 1_000_000) {
  if (!Number.isInteger(maximumPaths) || maximumPaths < 1 || maximumPaths > 1_000_000) throw new TypeError("maximumPaths must be an integer from 1 through 1000000");
  if (output instanceof Uint8Array) output = new TextDecoder("utf-8", { fatal: true }).decode(output);
  const rows = splitNullOutput(output);
  if (rows.length > maximumPaths) throw new RangeError(`Git tree has ${rows.length} paths, exceeding maximumPaths ${maximumPaths}`);
  return Object.freeze(rows.map((row) => {
    const groups = /^(?<mode>\d+) (?<type>\S+) (?<object>[0-9a-f]+)(?: +(?<bytes>-|\d+))?\t(?<path>[\s\S]+)$/u.exec(row)?.groups;
    if (!groups) throw new Error("Git returned a malformed tree entry");
    return Object.freeze({ path: groups.path, mode: groups.mode, type: groups.type, object: groups.object, bytes: groups.bytes === undefined || groups.bytes === "-" ? null : Number(groups.bytes) });
  }));
}

/** Read `ls-files --stage -z` entries as { path, mode, object, stage }: what the index holds,
 *  with a stage above 0 for each side of an unmerged path. */
export function readIndexEntries(output) {
  return Object.freeze(splitNullOutput(output).map((row) => {
    const groups = /^(?<mode>\d+) (?<object>[0-9a-f]+) (?<stage>[0-3])\t(?<path>[\s\S]+)$/u.exec(row)?.groups;
    if (!groups) throw new Error("Git returned a malformed index entry");
    return Object.freeze({ path: groups.path, mode: groups.mode, object: groups.object, stage: Number(groups.stage) });
  }));
}

/** Read one `rev-list --count`. */
export function readCount(output) {
  const value = output.trim();
  if (!/^\d+$/u.test(value)) throw new Error("Git did not return a commit count");
  return Number(value);
}

/** Read `git diff --name-status -z` rows as { status, path }. */
export function readNameStatus(output) {
  const fields = splitNullOutput(output);
  if (fields.length % 2 !== 0) throw new Error("Git returned an incomplete name-status row");
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) changes.push(Object.freeze({ status: fields[index], path: fields[index + 1] }));
  return Object.freeze(changes);
}

/** Read `git status --porcelain=v1 -z` entries as { status, path }, a rename or copy also naming
 *  its `source`. */
export function readPorcelainStatus(output) {
  const fields = output.split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === "") continue;
    if (field.length < 4 || field[2] !== " ") throw new Error("Git returned a malformed porcelain status entry");
    const status = field.slice(0, 2);
    const renamed = status[0] === "R" || status[0] === "C";
    entries.push(Object.freeze({ status, path: field.slice(3), ...(renamed ? { source: fields[++index] } : {}) }));
  }
  return Object.freeze(entries);
}

/** Read one exact source branch/tag reference without normalizing its spelling. */
export function readGitSourceReference(ref) {
  if (typeof ref !== "string" || ref.length > 1024 || !/^refs\/(heads|tags)\/[^/]/u.test(ref)
    || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(ref) || ref.includes("..") || ref.includes("@{") || ref.includes("//")
    || ref.endsWith("/") || ref.endsWith(".") || ref.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) throw new TypeError("source working copy: exact full branch or tag ref required");
  return ref;
}

/** An acquisition request names source, never a destination, credential or grant. */
export function readGitSourceWorkingCopyRequest(input) {
  const value = record(input);
  if (value === undefined || Object.keys(value).some(key => !["sourceRepository", "ref", "commit"].includes(key))) throw new TypeError("source working copy: only sourceRepository, ref and commit are request fields");
  const { sourceRepository, ref, commit } = value;
  if (typeof sourceRepository !== "string" || sourceRepository.length > 2048 || /[\u0000-\u0020\u007f]/u.test(sourceRepository)) throw new TypeError("source working copy: exact source repository URL required");
  let url;
  try { url = new URL(sourceRepository); } catch { throw new TypeError("source working copy: canonical HTTPS, SSH or file source URL required"); }
  if (!["https:", "ssh:", "file:"].includes(url.protocol) || url.password || url.search || url.hash || url.protocol === "https:" && url.username || url.href !== sourceRepository) throw new TypeError("source working copy: repository URL cannot carry credentials, parameters or ambiguous spelling");
  readGitSourceReference(ref);
  if (typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new TypeError("source working copy: full commit identity required");
  return Object.freeze({ sourceRepository, ref, commit });
}

// Acquisition reads no global/system Git configuration and never runs source hooks, filters or
// package scripts. Authentication is supplied by the already-bound credential-service port.
const SOURCE_GIT_ENVIRONMENT = Object.freeze({ GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "", GIT_TERMINAL_PROMPT: "0" });
const sourceGit = args => gitCommand(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { environment: SOURCE_GIT_ENVIRONMENT });
export const SOURCE_WORK_BRANCH = /^[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
export const gitSourceWorkingCopyPlan = Object.freeze({
  clone: (request, destination) => {
    const value = readGitSourceWorkingCopyRequest(request);
    if (typeof destination !== "string" || !destination.startsWith("/") || /[\u0000\r\n]/u.test(destination)) throw new TypeError("source working copy: bound absolute destination required");
    return sourceGit(["clone", "--depth=1", "--no-checkout", "--no-tags", "--no-local", "--no-recurse-submodules", "--template=", "--single-branch", "--branch", value.ref.replace(/^refs\/(heads|tags)\//u, ""), "--", value.sourceRepository, destination]);
  },
  // Custody binds the original named ref and commit. Clone validates that ref
  // at its owner; fetch the selected commit, including a retained older pin.
  fetch: request => sourceGit(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", readGitSourceWorkingCopyRequest(request).commit]),
  tree: request => sourceGit(["ls-tree", "-r", "-z", "-l", "--full-tree", readGitSourceWorkingCopyRequest(request).commit]),
  blob: oid => sourceGit(["cat-file", "blob", readOid(oid)]),
  worktreeAdd: (workspace, commit) => sourceGit(["worktree", "add", "--detach", workspace, readOid(commit)]),
  worktreeBranch: (branch, commit) => { if (!SOURCE_WORK_BRANCH.test(branch) || branch.includes("..") || branch.endsWith(".") || branch.endsWith(".lock")) throw new TypeError("source working tree requires an existing scoped task-branch name"); return sourceGit(["checkout", "-B", branch, readOid(commit)]); },
  recordSourceBase: (branch, commit) => { if (!SOURCE_WORK_BRANCH.test(branch) || branch.includes("..") || branch.endsWith(".") || branch.endsWith(".lock")) throw new TypeError("source working tree requires an existing scoped task-branch name"); return sourceGit(["config", "--local", `branch.${branch}.sourceBase`, readOid(commit)]); },
  fetchedCommit: () => sourceGit(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]),
  checkout: request => sourceGit(["checkout", "--detach", "--force", readGitSourceWorkingCopyRequest(request).commit]),
  origin: () => sourceGit(["remote", "get-url", "origin"]),
  head: () => sourceGit(["rev-parse", "--verify", "HEAD^{commit}"]),
  commonDirectory: () => sourceGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  topLevel: () => sourceGit(["rev-parse", "--show-toplevel"]),
  configuration: file => {
    if (typeof file !== "string" || !file.startsWith("/") || /[\u0000\r\n]/u.test(file)) throw new TypeError("source working copy: absolute configuration path required");
    return sourceGit(["config", "--file", file, "--no-includes", "--null", "--list"]);
  },
  status: () => sourceGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]),
});

export { gitSourceWorkingCopyRequestSchema, gitSourceCustodySchema, gitSourceWorkingCopyBindingSchema, gitSourceClosureSchema, gitSourceResultSchema } from "./source-working-copy-schema.mjs";
