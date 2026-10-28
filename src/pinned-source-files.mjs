import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, lstat, realpath, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, posix, dirname, resolve } from "node:path";
import { readTreeEntries, takeBatchRecord, readIndexEntries, gitWorktreePlan } from "./git-command-codec.mjs";
import { composed, containedGitmodulePath, parseGitmodules } from "./gitmodules.mjs";

const oid = value => typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
const sourcePath = value => {
  if (value !== "" && !containedGitmodulePath(value))
    throw new TypeError("pinned source paths must stay within their repository");
  return value;
};

/**
 * Read selected regular files from exact commits, entering only selected, composed gitlinks.
 * The caller owns one disposable scratch directory and resolves declared child repositories.
 * Git owns object acquisition and decoding; no checkout, branch selection, lifecycle or hook runs.
 * A reader shares fetched object stores between packages of the same landing.
 * environmentForRepository can supply credentials for each selected repository;
 * those values stay with that repository's object store, including lazy reads.
 */
export function createPinnedSourceReader({ scratch, environment = {}, environmentForRepository, resolveSubmodule, rejectSelectedNonRegular = false,
  maxRepositories = 32, maxPaths = 100_000, maxBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof scratch !== "string" || !isAbsolute(scratch)) throw new TypeError("an absolute disposable source directory is required");
  if (environmentForRepository !== undefined && typeof environmentForRepository !== "function")
    throw new TypeError("a repository environment provider must be callable");
  if (typeof rejectSelectedNonRegular !== "boolean") throw new TypeError("strict selected-file receiving must be boolean");
  if (!Number.isSafeInteger(maxRepositories) || maxRepositories < 1 || maxRepositories > 4096
    || !Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > 1_000_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024)
    throw new TypeError("finite pinned source repository, path and byte bounds are required");
  const stores = new Map(), commits = new Map(), transfers = new Map();
  const repositoryEnvironments = new Map();
  // Metadata commands answer at once; a fetch and the batch reads move content (a blobless store fetches each
  // selected blob as it is read), bounded by maxBytes, so their time is the transfer's, not a metadata answer's.
  const transfer = Math.max(120_000, Math.ceil(maxBytes / (256 * 1024)) * 1000);
  const run = (args, { gitDir, input, timeout = 30_000, isolated = false, localOnly = false } = {}) => new Promise((resolve, reject) => {
    const child = execFile("git", [
      "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never",
      // a disposable store is never repacked or maintained: each lazy fetch would otherwise start a background gc
      "-c", "gc.auto=0", "-c", "maintenance.auto=false",
      ...(localOnly ? ["-c", "remote.origin.promisor=false"] : []),
      ...(gitDir ? ["--git-dir", gitDir] : []), ...args,
    ], { encoding: "buffer", timeout, maxBuffer: maxBytes + 16 * 1024 * 1024,
      env: isolated ? {
        ...Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ", "SystemRoot", "WINDIR"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "",
        GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_LFS_SKIP_SMUDGE: "1",
      } : { ...process.env, ...environment, ...repositoryEnvironments.get(gitDir), GIT_TERMINAL_PROMPT: "0", ...(localOnly ? { GIT_NO_LAZY_FETCH: "1" } : {}) } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
  const transferFor = (gitDir, operation) => {
    const pending = (transfers.get(gitDir) ?? Promise.resolve()).then(operation);
    transfers.set(gitDir, pending);
    // A failed store stays failed; no replacement allocation hides its outcome.
    pending.catch(() => {});
    return pending;
  };
  const storeFor = (repository, commit) => {
    if (typeof repository !== "string" || !repository || repository.startsWith("-") || /[\r\n\0]/u.test(repository) || !oid(commit))
      throw new TypeError("a repository and exact commit are required");
    // Revisions share the repository's native object database. A new commit
    // does not allocate another copy of all unchanged objects.
    const key = repository + "\0" + commit.length;
    if (!stores.has(key)) {
      if (stores.size >= maxRepositories) throw new RangeError("pinned source repository bound exceeded");
      const gitDir = join(scratch, String(stores.size) + ".git");
      stores.set(key, (async () => {
        const supplied = await environmentForRepository?.(repository);
        if (supplied !== undefined && (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)))
          throw new TypeError("a repository environment provider must return an environment object");
        repositoryEnvironments.set(gitDir, { ...supplied });
        await mkdir(scratch, { recursive: true });
        const objectFormat = commit.length === 40 ? "sha1" : "sha256";
        await run(["init", "--bare", "--quiet", "--template=", "--object-format=" + objectFormat, gitDir]);
        const storedFormat = (await run(["rev-parse", "--show-object-format=storage"], { gitDir })).toString("utf8").trim();
        if (storedFormat !== objectFormat) throw new Error("pinned source storage format differs from its exact object identity");
        for (const args of pinnedStoreConfiguration(repository)) await run(args, { gitDir });
        return gitDir;
      })());
    }
    const selected = key + "\0" + commit;
    if (!commits.has(selected)) commits.set(selected, (async () => {
      const gitDir = await stores.get(key);
      await transferFor(gitDir, async () => {
        const held = selectedObjectMetadata([commit], await run(["cat-file", "--batch-check"], { gitDir, input: commit + "\n", localOnly: true }), "commit");
        if (held.missing.length) await run(pinnedCommitFetchArguments(commit), { gitDir, timeout: transfer });
        await run(["cat-file", "-e", commit + "^{commit}"], { gitDir, localOnly: true });
      });
      return gitDir;
    })());
    return commits.get(selected);
  };
  const reader = async function readPinnedSourceFiles({ repository, commit, scope = "", selectFile, enterDirectory } = {}) {
    scope = sourcePath(scope);
    if (typeof selectFile !== "function" || typeof enterDirectory !== "function")
      throw new TypeError("explicit file and directory selections are required");
    const files = new Map();
    let visited = 0, bytes = 0;
    const inside = location => scope === "" || location === scope || location.startsWith(scope + "/");
    const relative = location => scope === "" ? location : location.slice(scope.length + 1);
    async function visit(source, at, mount) {
      if (++visited > maxRepositories) throw new RangeError("pinned source repository traversal bound exceeded");
      const gitDir = await storeFor(source, at);
      const entries = readTreeEntries(await run(["ls-tree", "-r", "-z", "--full-tree", at], { gitDir }), maxPaths);
      const selected = entries.filter(entry => {
        const location = sourcePath(posix.join(mount, sourcePath(entry.path)));
        const gitlink = entry.type === "commit" && entry.mode === "160000";
        if (gitlink || (!rejectSelectedNonRegular && entry.type !== "blob")) return false;
        if (!inside(location) || !selectFile(relative(location))) return false;
        const regular = entry.type === "blob" && ["100644", "100755"].includes(entry.mode);
        if (rejectSelectedNonRegular && !regular)
          throw new TypeError("selected pinned source is not a supported regular file: " + location + " (" + entry.mode + " " + entry.type + ")");
        return regular;
      });
      if (selected.length) {
        const objects = [...new Set(selected.map(entry => entry.object))], input = objects.join("\n") + "\n";
        // A blobless store fetches each missing blob in its own round trip as cat-file reads it, so a package of
        // thousands of files never finished; the selected blobs are fetched first in one request, as git's own
        // lazy fetch would fetch one (fetch --stdin of their ids, no negotiation), and then read locally.
        const metadata = await transferFor(gitDir, async () => {
          let received = selectedObjectMetadata(objects, await run(["cat-file", "--batch-check"], { gitDir, input, localOnly: true }), "blob");
          if (received.missing.length) {
            await run(selectedBlobFetchArguments, { gitDir, input: received.missing.join("\n") + "\n", timeout: transfer });
            received = selectedObjectMetadata(objects, await run(["cat-file", "--batch-check"], { gitDir, input, localOnly: true }), "blob");
          }
          return received;
        });
        if (metadata.missing.length) throw new Error("pinned source blob is unavailable");
        const sizes = metadata.sizes;
        for (const entry of selected) {
          if (!sizes.has(entry.object)) throw new Error("pinned source blob size was not received");
          bytes += sizes.get(entry.object);
          if (bytes > maxBytes) throw new RangeError("pinned source byte bound exceeded");
        }
        const bodies = selectedBlobBodies(objects, await run(["cat-file", "--batch"], { gitDir, input, timeout: transfer }), sizes);
        for (const entry of selected) {
          const path = relative(posix.join(mount, entry.path));
          if (files.has(path)) throw new Error("pinned source path has more than one owner: " + path);
          files.set(path, { path, mode: entry.mode, bytes: bodies.get(entry.object),
            source: { repository: source, commit: at, path: entry.path, object: entry.object } });
        }
      }
      const links = entries.filter(entry => {
        if (entry.type !== "commit") return false;
        const location = posix.join(mount, sourcePath(entry.path));
        return location === scope || scope.startsWith(location + "/")
          || (inside(location) && enterDirectory(relative(location)));
      });
      if (!links.length) return;
      const declarations = parseGitmodules((await run(["show", at + ":.gitmodules"], { gitDir })).toString("utf8"), { requireContainedPaths: true });
      for (const link of links) {
        const matches = declarations.filter(entry => entry.path === link.path);
        if (matches.length !== 1) throw new Error("selected gitlink requires one declared repository: " + link.path);
        const declaration = matches[0];
        if (!composed(declaration)) continue;
        if (typeof resolveSubmodule !== "function") throw new TypeError("selected gitlinks require the caller's repository resolver");
        const child = await resolveSubmodule({ repository: source, declaration, commit: link.object, path: posix.join(mount, link.path) });
        await visit(child, link.object, posix.join(mount, link.path));
      }
    }
    await visit(repository, commit, "");
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  };
  /** Version 1: disposable, complete, regular root source at a genuine held commit.
   * This is construction custody, not institutional source-working-copy admission.
   * Call dispose only after all source/build readers and writers have quiesced.
   */
  reader.materialize = async ({ repository, commit, ...unsupported } = {}) => {
    if (Object.keys(unsupported).length) throw new TypeError("pinned worktree accepts repository and exact commit only");
    // Returned native metadata must not contain an embedded transport credential.
    if (typeof repository === "string" && /^[a-z][a-z0-9+.-]*:\/\//iu.test(repository)) {
      const url = new URL(repository);
      if (url.password || url.username && url.protocol !== "ssh:" || url.search || url.hash)
        throw new TypeError("pinned worktree repository must not contain credentials or parameters");
    }
    // Check the existing parent before creating scratch; a symlinked parent must
    // not receive even an incidental directory creation outside caller custody.
    const parent = dirname(scratch);
    if (resolve(scratch) !== scratch || await realpath(parent) !== parent || !(await lstat(parent)).isDirectory())
      throw new TypeError("pinned worktree scratch parent must be an existing unredirected directory");
    await mkdir(scratch, { recursive: true });
    const scratchStat = await lstat(scratch);
    if (!scratchStat.isDirectory() || await realpath(scratch) !== scratch)
      throw new TypeError("pinned worktree scratch must be an unredirected directory");
    const gitDir = await storeFor(repository, commit);
    // A cleared process environment is insufficient: checkout also consumes the
    // retained store's local configuration. Admit only this owner's inert store
    // controls, without following includes or accepting template-installed filters.
    const configPath = join(gitDir, "config"), configStat = await lstat(configPath);
    if (!configStat.isFile() || configStat.size > 131072 || await realpath(configPath) !== configPath)
      throw new TypeError("pinned worktree requires bounded regular native configuration");
    const admittedConfig = await readFile(configPath);
    const configuration = await run(["config", "--file", configPath, "--no-includes", "--null", "--list"], { isolated: true });
    if (!(await readFile(configPath)).equals(admittedConfig)) throw new TypeError("pinned worktree configuration changed during admission");
    const seen = new Set();
    for (const row of configuration.toString("utf8").split("\0").filter(Boolean)) {
      const at = row.indexOf("\n"), key = row.slice(0, at), value = row.slice(at + 1);
      const allowed = key === "core.repositoryformatversion" && ["0", "1"].includes(value)
        || key === "core.filemode" && ["true", "false"].includes(value)
        || key === "core.bare" && value === "true"
        || key === "extensions.objectformat" && value === (commit.length === 40 ? "sha1" : "sha256")
        || key === "remote.origin.url" && value === repository
        || key === "remote.origin.promisor" && value === "true"
        || key === "remote.origin.partialclonefilter" && value === "blob:none";
      if (at < 0 || !allowed || seen.has(key)) throw new TypeError("pinned worktree native configuration is not admitted");
      seen.add(key);
    }
    if (!["core.repositoryformatversion", "core.bare", "remote.origin.url", "remote.origin.promisor", "remote.origin.partialclonefilter"].every(key => seen.has(key)))
      throw new TypeError("pinned worktree native configuration is incomplete");
    const absent = async path => {
      try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      throw new TypeError("pinned worktree has unsupported native routing metadata");
    };
    for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates", "info/grafts", "config.worktree"])
      await absent(join(gitDir, name));
    const all = readTreeEntries(await run(["ls-tree", "-r", "-z", "--full-tree", commit], { gitDir }), maxPaths);
    if (all.some(entry => entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)))
      throw new TypeError("pinned worktree version 1 requires a complete regular root without Gitlinks");
    for (const entry of all) {
      sourcePath(entry.path);
      if (entry.path.split("/").some(part => part.toLowerCase() === ".git")) throw new TypeError("pinned worktree source collides with Git metadata");
    }
    const entries = await reader({ repository, commit, selectFile: () => true, enterDirectory: () => false });
    const holder = await mkdtemp(join(scratch, "worktree-")), directory = join(holder, "source");
    const identity = stat => `${stat.dev}:${stat.ino}`;
    const holderIdentity = identity(await lstat(holder)), storeIdentity = identity(await lstat(gitDir));
    const config = admittedConfig;
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    const expected = entries.map(entry => ({ path: entry.path, mode: entry.mode, sha256: hash(entry.bytes) }));
    let rootIdentity, pointer, metadata, metadataIdentity, metadataControls, disposed = false, disposing, materializationStarted = false, materializationFinished = false;
    async function controls() {
      if (disposed) throw new TypeError("pinned worktree has been disposed");
      for (const [path, expected] of [[scratch, identity(scratchStat)], [holder, holderIdentity], [gitDir, storeIdentity], ...(rootIdentity ? [[directory, rootIdentity]] : [])]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || await realpath(path) !== path || identity(stat) !== expected)
          throw new TypeError("pinned worktree physical custody changed");
      }
      const configPath = join(gitDir, "config"), stat = await lstat(configPath);
      if (!stat.isFile() || await realpath(configPath) !== configPath || !(await readFile(configPath)).equals(config))
        throw new TypeError("pinned worktree source routing changed");
      for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates", "info/grafts", "config.worktree"])
        await absent(join(gitDir, name));
      if (metadataControls) {
        await absent(join(metadata, "config.worktree"));
        const stat = await lstat(metadata);
        if (!stat.isDirectory() || await realpath(metadata) !== metadata || identity(stat) !== metadataIdentity)
          throw new TypeError("pinned worktree native metadata custody changed");
        for (const [name, bytes] of metadataControls) {
          const file = join(metadata, name), stat = await lstat(file);
          if (!stat.isFile() || await realpath(file) !== file || !(await readFile(file)).equals(bytes))
            throw new TypeError("pinned worktree native identity changed");
        }
      }
      if (pointer) {
        const file = join(directory, ".git"), stat = await lstat(file);
        if (!stat.isFile() || await realpath(file) !== file || !(await readFile(file)).equals(pointer))
          throw new TypeError("pinned worktree metadata binding changed");
      }
    }
    const native = args => run(["-c", "core.fsmonitor=false", ...args], { gitDir, isolated: true });
    const verify = async () => {
      await controls();
      // Explicit --git-dir would otherwise observe the bare store rather than its worktree.
      const observed = async args => (await run(["-c", "core.fsmonitor=false", "-C", directory, ...args], { gitDir: metadata, isolated: true })).toString("utf8").trim();
      if (await observed(["rev-parse", "HEAD^{commit}"]) !== commit || await observed(["rev-parse", "--show-toplevel"]) !== directory)
        throw new TypeError("pinned worktree source identity changed");
      const indexPath = join(metadata, "index"), indexStat = await lstat(indexPath);
      if (!indexStat.isFile() || await realpath(indexPath) !== indexPath)
        throw new TypeError("pinned worktree index is not a regular native file");
      const index = readIndexEntries(await observed(["ls-files", "--stage", "-z"]));
      const sourceIndex = all.map(entry => ({ path: entry.path, mode: entry.mode, object: entry.object, stage: 0 }));
      if (JSON.stringify(index) !== JSON.stringify(sourceIndex)) throw new TypeError("pinned worktree index differs from its exact source commit");
      for (const entry of expected) {
        let file = directory;
        for (const part of entry.path.split("/")) {
          file = join(file, part);
          if ((await lstat(file)).isSymbolicLink()) throw new TypeError("pinned worktree source became redirected");
        }
        const stat = await lstat(file);
        if (!stat.isFile() || Boolean(stat.mode & 0o111) !== (entry.mode === "100755") || hash(await readFile(file)) !== entry.sha256)
          throw new TypeError("pinned worktree authored source changed: " + entry.path);
      }
      return { kind: "git.pinned-source-worktree-verification", version: 1, repository, commit, files: expected.length };
    };
    const dispose = async () => {
      if (disposed) return;
      if (disposing) return disposing;
      disposing = (async () => {
      await controls();
      await native(gitWorktreePlan.remove(directory).arguments);
      // Native command failure throws; never remove a possibly still-registered copy.
      await rm(holder, { recursive: true });
      disposed = true;
      })();
      return disposing;
    };
    try {
      await controls();
      materializationStarted = true;
      await native(gitWorktreePlan.add(directory, commit).arguments);
      materializationFinished = true;
      rootIdentity = identity(await lstat(directory));
      pointer = await readFile(join(directory, ".git"));
      if (!pointer.toString("utf8").startsWith("gitdir: ")) throw new TypeError("native Git did not create a linked worktree");
      metadata = pointer.toString("utf8").trim().slice("gitdir: ".length);
      metadataIdentity = identity(await lstat(metadata));
      metadataControls = await Promise.all(["HEAD", "commondir", "gitdir"].map(async name => [name, await readFile(join(metadata, name))]));
      await verify();
    } catch (error) {
      if (materializationStarted && !materializationFinished) {
        // A failed native checkout may have registered a partial worktree. Never
        // erase it by filesystem guesswork or claim the child was quiescent.
        error.retainedWorktree = directory;
        throw error;
      }
      // Construction has no producer child; only our completed Git calls ran.
      // Preserve uncertain/changed ownership rather than recursively deleting it.
      try {
        await controls();
        if (rootIdentity) await native(gitWorktreePlan.remove(directory).arguments);
        await rm(holder, { recursive: true });
      } catch { error.retainedWorktree = directory; }
      throw error;
    }
    return Object.freeze({ kind: "git.pinned-source-worktree", version: 1, repository, commit, directory,
      entries, verify, dispose });
  };
  return reader;

}

function selectedObjectMetadata(objects, output, expectedType) {
  const rows = output.toString("utf8").trimEnd().split("\n"), sizes = new Map(), missing = [];
  if (rows.length !== objects.length) throw new Error("selected object metadata count differs");
  for (let index = 0; index < rows.length; index++) {
    const [object, type, size] = rows[index].split(" ");
    if (object !== objects[index]) throw new Error("selected object metadata identity differs");
    if (type === "missing") { missing.push(object); continue; }
    if (type !== expectedType || !/^\d+$/u.test(size ?? "") || !Number.isSafeInteger(Number(size)))
      throw new Error("selected native object has the wrong type or size");
    sizes.set(object, Number(size));
  }
  return { sizes, missing };
}

// These native argument plans are shared by the disposable async reader and
// the existing-repository sync adapter. Neither selects a branch or checkout.
const selectedBlobFetchArguments = Object.freeze(["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--recurse-submodules=no", "--filter=blob:none", "--stdin", "origin"]);
const pinnedCommitFetchArguments = commit => ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--no-recurse-submodules", "--depth=1", "--filter=blob:none", "origin", commit];
const pinnedStoreConfiguration = repository => [
  ["config", "remote.origin.url", repository],
  ["config", "remote.origin.promisor", "true"],
  ["config", "remote.origin.partialclonefilter", "blob:none"],
];
function selectedBlobBodies(objects, buffer, sizes) {
  let remaining = buffer;
  const bodies = new Map();
  for (const object of objects) {
    const record = takeBatchRecord(remaining);
    if (!record || record.object !== object || record.type !== "blob" || record.body?.length !== sizes.get(object))
      throw new Error("pinned source blob differs from its requested object");
    bodies.set(object, record.body); remaining = record.rest;
  }
  if (remaining.length) throw new Error("pinned source returned unrequested blob records");
  return bodies;
}
function nativeGit(directory, { environment = {}, maxBytes = 64 * 1024 * 1024, timeoutMs = 120000 } = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new TypeError("an explicit existing Git directory is required");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new TypeError("finite native Git byte and time bounds are required");
  return (args, { input, transfer = false } = {}) => execFileSync("git", [
    "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never",
    "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", directory, ...args,
  ], { input, encoding:null, timeout:transfer ? timeoutMs : Math.min(timeoutMs,30000),
    maxBuffer:maxBytes+16*1024*1024, stdio:["pipe","pipe","pipe"],
    env:{...process.env,...environment,GIT_TERMINAL_PROMPT:"0",GIT_NO_LAZY_FETCH:"1"} });
}
/** Receive only a pinned commit's metadata into the caller's original bare cache.
 * Reuses the async factory's native configuration/fetch plan; creates no checkout. */
export function receivePinnedRepositoryCommitSync({ directory, repository, commit, create = false, ...options } = {}) {
  if (typeof repository !== "string" || !repository || repository.startsWith("-") || /[\r\n\0]/u.test(repository) || !oid(commit) || typeof create !== "boolean")
    throw new TypeError("an explicit repository and exact commit are required");
  const run = nativeGit(directory, options), format = commit.length === 40 ? "sha1" : "sha256";
  if (!existsSync(directory)) {
    if (!create) throw new Error("pinned repository object store is absent");
    mkdirSync(directory,{recursive:true,mode:0o700});
    run(["init","--bare","--quiet","--object-format="+format]);
  }
  if (run(["rev-parse","--is-bare-repository"]).toString().trim() !== "true")
    throw new Error("pinned commit cache must be its original bare repository");
  if (run(["rev-parse","--show-object-format=storage"]).toString().trim() !== format)
    throw new Error("pinned source storage format differs from its exact object identity");
  let origin;
  try { origin = run(["remote","get-url","origin"]).toString().trim(); } catch {}
  if (origin && origin !== repository) throw new Error("pinned source repository identity changed");
  try { run(["cat-file","-e",commit+"^{commit}"]); return {directory,repository,commit,fetched:false}; } catch {}
  for (const args of pinnedStoreConfiguration(repository)) run(args);
  run(pinnedCommitFetchArguments(commit),{transfer:true});
  run(["cat-file","-e",commit+"^{commit}"]);
  return {directory,repository,commit,fetched:true};
}
/** Read exact selected binary blobs from an existing repository. The default
 * is strictly local. Explicit receiving hydrates only missing selected OIDs
 * through its original promisor origin; no store, worktree or branch is made. */
export function readGitBlobObjectsSync({ directory, objects, receiveMissing = false, maxPaths = 100000, ...options } = {}) {
  if (!Array.isArray(objects) || !Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > 1000000 || objects.length > maxPaths || !objects.every(oid) || typeof receiveMissing !== "boolean")
    throw new TypeError("finite exact selected blob objects are required");
  const unique = [...new Set(objects)];
  if (!unique.length) return new Map();
  const run = nativeGit(directory,options), input = unique.join("\n")+"\n";
  const parse = output => {
    const rows=output.toString("utf8").trimEnd().split("\n"), sizes=new Map(), missing=[];
    if(rows.length!==unique.length)throw new Error("selected blob metadata count differs");
    for(let i=0;i<rows.length;i++){
      const [object,type,size]=rows[i].split(" ");
      if(object!==unique[i])throw new Error("selected blob metadata identity differs");
      if(type==="missing"){missing.push(object);continue}
      if(type!=="blob"||!/^\d+$/u.test(size??"")||!Number.isSafeInteger(Number(size)))throw new Error("selected object is not a native blob");
      sizes.set(object,Number(size));
    }
    return {sizes,missing};
  };
  let checked, missing=[];
  try { checked=parse(run(["cat-file","--batch-check"],{input})); missing=checked.missing; }
  catch(error){
    if(!receiveMissing || !/could not fetch [0-9a-f]+ from promisor remote/u.test(String(error.stderr??"")))throw error;
    // Some Git versions make batch-check stop at the first absent promised
    // object. Only that failure admits bounded per-OID presence checks.
    for(const object of unique)try{run(["cat-file","-e",object])}catch(e){
      if(e.status===1&&!String(e.stderr??"").trim() || String(e.stderr??"").includes("could not fetch "+object+" from promisor remote"))missing.push(object);
      else throw e;
    }
  }
  if(missing.length){
    if(!receiveMissing)throw new Error("selected source blob objects are unavailable locally");
    run(selectedBlobFetchArguments,{input:missing.join("\n")+"\n",transfer:true});
    checked=parse(run(["cat-file","--batch-check"],{input}));
  }
  if(!checked || checked.missing.length)throw new Error("selected source blobs remain unavailable");
  const total=[...checked.sizes.values()].reduce((n,size)=>n+size,0);
  if(!Number.isSafeInteger(total)||total>(options.maxBytes??64*1024*1024))throw new RangeError("selected source byte bound exceeded");
  return selectedBlobBodies(unique,run(["cat-file","--batch"],{input,transfer:true}),checked.sizes);
}
