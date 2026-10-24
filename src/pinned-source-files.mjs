import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { readTreeEntries, takeBatchRecord } from "./git-command-codec.mjs";
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
  const stores = new Map();
  const repositoryEnvironments = new Map();
  // Metadata commands answer at once; a fetch and the batch reads move content (a blobless store fetches each
  // selected blob as it is read), bounded by maxBytes, so their time is the transfer's, not a metadata answer's.
  const transfer = Math.max(120_000, Math.ceil(maxBytes / (256 * 1024)) * 1000);
  const run = (args, { gitDir, input, timeout = 30_000 } = {}) => new Promise((resolve, reject) => {
    const child = execFile("git", [
      "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never",
      // a disposable store is never repacked or maintained: each lazy fetch would otherwise start a background gc
      "-c", "gc.auto=0", "-c", "maintenance.auto=false",
      ...(gitDir ? ["--git-dir", gitDir] : []), ...args,
    ], { encoding: "buffer", timeout, maxBuffer: maxBytes + 16 * 1024 * 1024,
      env: { ...process.env, ...environment, ...repositoryEnvironments.get(gitDir), GIT_TERMINAL_PROMPT: "0" } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
  const storeFor = (repository, commit) => {
    if (typeof repository !== "string" || !repository || repository.startsWith("-") || /[\r\n\0]/u.test(repository) || !oid(commit))
      throw new TypeError("a repository and exact commit are required");
    const key = repository + "\0" + commit;
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
        await run(["init", "--bare", "--quiet", "--object-format=" + objectFormat, gitDir]);
        const storedFormat = (await run(["rev-parse", "--show-object-format=storage"], { gitDir })).toString("utf8").trim();
        if (storedFormat !== objectFormat) throw new Error("pinned source storage format differs from its exact object identity");
        for (const args of pinnedStoreConfiguration(repository)) await run(args, { gitDir });
        await run(pinnedCommitFetchArguments(commit), { gitDir, timeout: transfer });
        await run(["cat-file", "-e", commit + "^{commit}"], { gitDir });
        return gitDir;
      })());
    }
    return stores.get(key);
  };
  return async function readPinnedSourceFiles({ repository, commit, scope = "", selectFile, enterDirectory } = {}) {
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
        await run(selectedBlobFetchArguments, { gitDir, input, timeout: transfer });
        const sizes = new Map((await run(["cat-file", "--batch-check"], { gitDir, input, timeout: transfer })).toString("utf8").trimEnd().split("\n").map(row => {
          const [object, type, size] = row.split(" ");
          if (!oid(object) || type !== "blob" || !/^\d+$/u.test(size ?? "") || !Number.isSafeInteger(Number(size)))
            throw new Error("pinned source blob is unavailable");
          return [object, Number(size)];
        }));
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
