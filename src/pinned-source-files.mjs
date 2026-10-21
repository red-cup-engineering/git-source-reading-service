import { execFile } from "node:child_process";
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
        await run(["config", "remote.origin.url", repository], { gitDir });
        await run(["config", "remote.origin.promisor", "true"], { gitDir });
        await run(["config", "remote.origin.partialclonefilter", "blob:none"], { gitDir });
        await run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance",
          "--no-recurse-submodules", "--depth=1", "--filter=blob:none", "origin", commit], { gitDir, timeout: transfer });
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
        await run(["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
          "--recurse-submodules=no", "--filter=blob:none", "--stdin", "origin"], { gitDir, input, timeout: transfer });
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
        let remaining = await run(["cat-file", "--batch"], { gitDir, input, timeout: transfer });
        const bodies = new Map();
        for (const object of objects) {
          const record = takeBatchRecord(remaining);
          if (!record || record.object !== object || record.type !== "blob" || record.body?.length !== sizes.get(object))
            throw new Error("pinned source blob differs from its requested object");
          bodies.set(object, record.body); remaining = record.rest;
        }
        if (remaining.length) throw new Error("pinned source returned unrequested blob records");
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
