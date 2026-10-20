import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPinnedSourceReader } from "../src/pinned-source-files.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "git-pinned-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = async (name, files) => {
    const dir = join(root, name); await mkdir(dir);
    git(dir, "init", "-q"); git(dir, "config", "user.name", "Source fixture"); git(dir, "config", "user.email", "source@example.invalid");
    for (const [path, bytes] of Object.entries(files)) {
      const file = join(dir, path); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, bytes);
    }
    git(dir, "add", "."); git(dir, "commit", "-qm", "Pinned source");
    return { dir, commit: git(dir, "rev-parse", "HEAD") };
  };
  const child = await repository("child", { "src/index.mjs": "export const received = 'pinned';\n", "data/unselected": Buffer.alloc(4096, 3), "src/image.bin": Buffer.from([0, 255, 128]) });
  await chmod(join(child.dir, "src/index.mjs"), 0o755);
  git(child.dir, "add", "."); git(child.dir, "commit", "-qm", "Executable source"); child.commit = git(child.dir, "rev-parse", "HEAD");
  const parent = await repository("parent", { "package.json": "{}\n", ".gitmodules": "[submodule \"library\"]\n path = lib/semantic\n url = https://example.invalid/child.git\n[submodule \"unselected\"]\n path = other\n url = https://example.invalid/unselected.git\n" });
  git(parent.dir, "update-index", "--add", "--cacheinfo", "160000," + child.commit + ",lib/semantic");
  git(parent.dir, "update-index", "--add", "--cacheinfo", "160000," + child.commit + ",other");
  git(parent.dir, "commit", "-qm", "Compose exact child"); parent.commit = git(parent.dir, "rev-parse", "HEAD");
  await writeFile(join(child.dir, "src/index.mjs"), "export const received = 'newer';\n");
  git(child.dir, "add", "."); git(child.dir, "commit", "-qm", "Later child branch");
  const resolved = [];
  const reader = (bounds = {}) => createPinnedSourceReader({ scratch: join(root, "objects-" + Math.random()), ...bounds,
    resolveSubmodule: ({ declaration, commit }) => {
      resolved.push({ path: declaration.path, commit }); assert.equal(declaration.path, "lib/semantic"); return child.dir;
    } });
  const selection = { repository: parent.dir, commit: parent.commit,
    selectFile: path => path === "package.json" || path.startsWith("lib/semantic/src/"),
    enterDirectory: path => path === "lib/semantic" };
  return { root, parent, child, reader, selection, resolved };
}

test("selected source carries the exact pinned child, binary bytes and mode without entering unrelated repositories", async t => {
  const f = await fixture(t), rows = await f.reader()(f.selection);
  assert.deepEqual(rows.map(row => row.path), ["lib/semantic/src/image.bin", "lib/semantic/src/index.mjs", "package.json"]);
  assert.equal(rows[1].bytes.toString(), "export const received = 'pinned';\n");
  assert.equal(rows[1].mode, "100755");
  assert.deepEqual([...rows[0].bytes], [0, 255, 128]);
  assert.equal(rows[1].source.commit, f.child.commit);
  assert.deepEqual(f.resolved, [{ path: "lib/semantic", commit: f.child.commit }]);
});

test("a source scope inside a gitlink receives package-relative paths", async t => {
  const f = await fixture(t);
  const rows = await f.reader()({ ...f.selection, scope: "lib/semantic", selectFile: path => path.startsWith("src/"), enterDirectory: () => false });
  assert.deepEqual(rows.map(row => row.path), ["src/image.bin", "src/index.mjs"]);
});

test("each selected repository receives its own environment once across repeated source readings", async t => {
  const f = await fixture(t), asked = [];
  const read = f.reader({ environmentForRepository: async repository => {
    asked.push(repository);
    return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" };
  } });
  const first = await read(f.selection), second = await read(f.selection);
  assert.deepEqual(asked, [f.parent.dir, f.child.dir]);
  assert.deepEqual(second, first);
  assert.equal(first[1].bytes.toString(), "export const received = 'pinned';\n");
});

test("a missing repository environment refuses before acquiring that selected source", async t => {
  const f = await fixture(t), asked = [];
  const read = f.reader({ environmentForRepository: async repository => {
    asked.push(repository);
    if (repository === f.child.dir) throw new Error("child installation unavailable");
    return {};
  } });
  await assert.rejects(read(f.selection), /child installation unavailable/);
  assert.deepEqual(asked, [f.parent.dir, f.child.dir]);
});

test("a required unavailable pinned commit refuses and never selects the child branch", async t => {
  const f = await fixture(t), absent = "a".repeat(40);
  git(f.parent.dir, "update-index", "--cacheinfo", "160000," + absent + ",lib/semantic");
  git(f.parent.dir, "commit", "-qm", "Unavailable child");
  await assert.rejects(f.reader()({ ...f.selection, commit: git(f.parent.dir, "rev-parse", "HEAD") }));
});

test("selected repository and byte populations obey explicit bounds", async t => {
  const f = await fixture(t);
  await assert.rejects(f.reader({ maxRepositories: 1 })(f.selection), /repository.*bound/);
  await assert.rejects(f.reader({ maxBytes: 8 })(f.selection), /byte bound/);
});

test("an undeclared selected gitlink refuses before resolving a repository", async t => {
  const f = await fixture(t);
  await writeFile(join(f.parent.dir, ".gitmodules"), "");
  git(f.parent.dir, "add", ".gitmodules"); git(f.parent.dir, "commit", "-qm", "Missing declaration");
  await assert.rejects(f.reader()({ ...f.selection, commit: git(f.parent.dir, "rev-parse", "HEAD") }), /one declared repository/);
  assert.deepEqual(f.resolved, []);
});

test("source coordinates and selection are admitted before object acquisition", async t => {
  const root = await mkdtemp(join(tmpdir(), "git-pinned-admission-")); t.after(() => rm(root, { recursive: true, force: true }));
  const read = createPinnedSourceReader({ scratch: join(root, "objects") });
  await assert.rejects(read({ repository: "/absent", commit: "main", selectFile: () => true, enterDirectory: () => true }), /exact commit/);
  await assert.rejects(read({ repository: "/absent", commit: "a".repeat(40), scope: "../escape", selectFile: () => true, enterDirectory: () => true }), /within their repository/);
  await assert.rejects(read({ repository: "/absent", commit: "a".repeat(40) }), /explicit file and directory/);
});

test("an overwritten escaping declaration refuses through the original Git path codec", async t => {
  const f = await fixture(t);
  await writeFile(join(f.parent.dir, ".gitmodules"), "[submodule \"library\"]\n path = ../unrelated\n path = lib/semantic\n url = https://example.invalid/child.git\n");
  git(f.parent.dir, "add", ".gitmodules"); git(f.parent.dir, "commit", "-qm", "Invalid original path");
  await assert.rejects(f.reader()({ ...f.selection, commit: git(f.parent.dir, "rev-parse", "HEAD") }), /repository-relative and contained/);
  assert.deepEqual(f.resolved, []);
});

test("strict selected-file receiving preserves regular bytes, executable modes and composed pins", async t => {
  const f = await fixture(t);
  const ordinary = await f.reader()(f.selection);
  const strict = await f.reader({ rejectSelectedNonRegular: true })(f.selection);
  assert.deepEqual(strict, ordinary);
  assert.equal(strict[1].mode, "100755");
  assert.equal(strict[1].source.commit, f.child.commit);
  assert.deepEqual([...strict[0].bytes], [0, 255, 128]);
});

test("strict selection refuses an actual Git symlink without changing default or unselected behavior", async t => {
  const f = await fixture(t);
  await symlink("../../unavailable-source", join(f.parent.dir, "selected-link"));
  git(f.parent.dir, "add", "."); git(f.parent.dir, "commit", "-qm", "Unsupported selected file kind");
  const selection = { repository: f.parent.dir, commit: git(f.parent.dir, "rev-parse", "HEAD"),
    selectFile: path => path === "package.json" || path === "selected-link", enterDirectory: () => false };
  assert.deepEqual((await f.reader()(selection)).map(row => row.path), ["package.json"]);
  await assert.rejects(f.reader({ rejectSelectedNonRegular: true })(selection), /selected-link \(120000 blob\)/u);
  const unselected = await f.reader({ rejectSelectedNonRegular: true })({ ...selection, selectFile: path => path === "package.json" });
  assert.deepEqual(unselected.map(row => row.path), ["package.json"]);
  assert.deepEqual(f.resolved, []);
});

test("native Git tree byte decoding preserves Unicode and refuses a committed invalid UTF-8 pathname", async t => {
  const f = await fixture(t), name = "枝_1.mjs";
  await writeFile(join(f.parent.dir, name), "export const preserved = true;\n");
  git(f.parent.dir, "add", "."); git(f.parent.dir, "commit", "-qm", "Unicode source path");
  const selection = { repository: f.parent.dir, commit: git(f.parent.dir, "rev-parse", "HEAD"),
    selectFile: path => path === name, enterDirectory: () => false };
  const rows = await f.reader({ rejectSelectedNonRegular: true })(selection);
  assert.equal(rows[0].path, name);
  assert.equal(rows[0].source.path, name);
  assert.equal(rows[0].bytes.toString(), "export const preserved = true;\n");
  await writeFile(Buffer.concat([Buffer.from(f.parent.dir + "/"), Buffer.from([0xff]), Buffer.from(".mjs")]), "invalid pathname\n");
  git(f.parent.dir, "add", "."); git(f.parent.dir, "commit", "-qm", "Unrepresentable source path");
  let selected = 0;
  await assert.rejects(f.reader({ rejectSelectedNonRegular: true })({ ...selection,
    commit: git(f.parent.dir, "rev-parse", "HEAD"), selectFile: () => { selected++; return true; } }),
    { code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  assert.equal(selected, 0);
});

test("strict file-kind receiving is an explicit boolean before source acquisition", () => {
  assert.throws(() => createPinnedSourceReader({ scratch: "/unused", rejectSelectedNonRegular: "true" }), /must be boolean/u);
});
