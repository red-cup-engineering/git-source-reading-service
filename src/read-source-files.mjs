/**
 * Read authored files across a workspace's composed Git repositories.
 * Materialized repositories supply current working files. Unmaterialized
 * submodules supply the exact objects their parent pins; missing source is a
 * refusal, never a generated substitute. Paths stay relative to the workspace.
 */
import { execFile } from "node:child_process";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
};
const relativePath = value => {
  if (typeof value !== "string" || path.isAbsolute(value) || value.includes("\\") || value.split("/").some(part => part === ".." || part === "."))
    throw new TypeError("workspace source scope must be a repository-relative path");
  return value.replace(/\/$/u, "");
};
const entriesOf = output => output.split("\0").filter(Boolean).map(row => {
  const split = row.indexOf("\t");
  const match = /^(\d+) (blob|tree|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/u.exec(row.slice(0, split));
  if (split < 0 || !match) throw new Error("unreadable workspace Git tree entry");
  return { mode: match[1], type: match[2], object: match[3], path: row.slice(split + 1) };
});

export async function readRepositorySourceFiles({ repository, filename, scope = "", skipDirectories = [], maxRepositories = 512 }) {
  if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(filename))
    throw new TypeError("one literal source filename is required");
  if (!Array.isArray(skipDirectories) || skipDirectories.some(value => typeof value !== "string" || !value || value.includes("/")))
    throw new TypeError("excluded source directory names are required");
  if (!Number.isSafeInteger(maxRepositories) || maxRepositories < 1 || maxRepositories > 4096)
    throw new TypeError("a bounded workspace repository population is required");
  const root = path.resolve(repository), selected = relativePath(scope), skip = new Set(skipDirectories);
  const run = async (args, cwd) => (await execute("git", ["--no-replace-objects", ...args], { cwd, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" })).stdout;
  if ((await run(["rev-parse", "--show-toplevel"], root)).trim() !== root) throw new Error("workspace source root is not its Git repository root");
  const rootGitDir = (await run(["rev-parse", "--absolute-git-dir"], root)).trim();
  const records = new Map();
  let visited = 0;
  const inScope = location => selected === "" || location === selected || location.startsWith(selected + "/");
  const canContain = location => inScope(location) || selected.startsWith(location + "/");
  const excluded = location => location.split("/").some(part => skip.has(part));
  const text = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  async function visit({ mount, gitDir, revision, materialized }) {
    if (++visited > maxRepositories) throw new RangeError("workspace source repository population exceeds its declared bound");
    const cwd = path.join(root, mount), localGit = args => run(["-C", cwd, ...args], root);
    const objectGit = args => run(["--git-dir", gitDir, ...args], root);
    if (materialized) {
      if ((await localGit(["rev-parse", "--show-toplevel"])).trim() !== cwd) throw new Error("mounted source differs from its repository: " + mount);
      revision = (await localGit(["rev-parse", "HEAD"])).trim();
    }
    const localScope = selected && !inScope(mount) ? path.posix.relative(mount, selected) : "";
    // A deep pathspec cannot cross a gitlink. Keep its first tree component
    // so any intervening repository boundary is observed and followed.
    const treeScope = localScope.split("/")[0];
    const tree = entriesOf(await objectGit(["ls-tree", "-rz", "--full-tree", revision, ...(treeScope ? ["--", treeScope] : [])]));
    const source = { kind: materialized ? "working-copy" : "pinned-commit", repository: cwd, commit: revision };
    const publish = (local, raw) => {
      const location = path.posix.join(mount, local);
      if (!inScope(location) || excluded(location)) return;
      if (records.has(location)) throw new Error("workspace source has more than one owner: " + location);
      records.set(location, { path: location, raw, source });
    };
    if (materialized) {
      const prefix = localScope ? localScope + "/" : "";
      const paths = (await localGit(["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", prefix + filename, ":(glob)" + prefix + "**/" + filename])).split("\0").filter(Boolean);
      for (const local of paths) {
        const location = path.posix.join(mount, local);
        if (!inScope(location) || excluded(location)) continue;
        const file = path.join(cwd, local);
        try {
          if (!(await lstat(file)).isFile()) throw new Error("authored workspace source is not a regular file: " + location);
          if (!within(root, await realpath(file))) throw new Error("authored workspace source escapes its workspace: " + location);
          publish(local, text(await readFile(file)));
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    } else {
      for (const entry of tree) {
        if (entry.type !== "blob" || path.posix.basename(entry.path) !== filename) continue;
        const location = path.posix.join(mount, entry.path);
        if (!inScope(location) || excluded(location)) continue;
        if (!["100644", "100755"].includes(entry.mode)) throw new Error("pinned workspace source is not a regular file: " + location);
        publish(entry.path, await objectGit(["show", revision + ":" + entry.path]));
      }
    }
    const links = tree.filter(entry => entry.type === "commit" && canContain(path.posix.join(mount, entry.path)) && !excluded(path.posix.join(mount, entry.path)));
    if (!links.length) return;
    // Git parses its own configuration syntax, including quoted subsections.
    const declarationsByName = new Map();
    const configuration = await objectGit(["config", "--blob", revision + ":.gitmodules", "--null", "--list"]);
    for (const field of configuration.split("\0").filter(Boolean)) {
      const boundary = field.indexOf("\n");
      if (boundary < 0) throw new Error("unreadable Git submodule configuration field");
      const match = /^submodule\.(.+)\.(path|url|update)$/u.exec(field.slice(0, boundary));
      if (!match) continue;
      const entry = declarationsByName.get(match[1]) ?? { name: match[1] };
      entry[match[2]] = field.slice(boundary + 1);
      declarationsByName.set(match[1], entry);
    }
    const declarations = new Map([...declarationsByName.values()].filter(entry => entry.path && entry.url).map(entry => [entry.path, entry]));
    for (const link of links) {
      const declaration = declarations.get(link.path);
      if (!declaration) throw new Error("workspace source gitlink lacks its declaration: " + path.posix.join(mount, link.path));
      if (declaration.update === "none") continue;
      relativePath(declaration.path);
      relativePath(declaration.name);
      const childMount = path.posix.join(mount, link.path), childRoot = path.join(root, childMount);
      if (!within(root, childRoot)) throw new Error("workspace source mount escapes its root");
      let childMaterialized = false, childGitDir = path.join(gitDir, "modules", declaration.name);
      if (!within(path.join(gitDir, "modules"), childGitDir)) throw new Error("workspace source metadata escapes its owner");
      try {
        await lstat(path.join(childRoot, ".git"));
        if ((await run(["rev-parse", "--show-toplevel"], childRoot)).trim() !== childRoot) throw new Error("workspace source mount is not its declared repository");
        childGitDir = (await run(["rev-parse", "--absolute-git-dir"], childRoot)).trim();
        childMaterialized = true;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await visit({ mount: childMount, gitDir: childGitDir, revision: link.object, materialized: childMaterialized });
    }
  }
  await visit({ mount: "", gitDir: rootGitDir, materialized: true });
  return [...records.values()].sort((a, b) => a.path.localeCompare(b.path));
}
