import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBlobIdOf, gitCommitIdOf, gitTreeIdOf } from "@red-cup-engineering/git-source-reading-service/git-object-id";
import { readEvidenceBoundCommit, readEvidenceBoundSourceMember } from "@red-cup-engineering/git-source-reading-service/source-path-proof";
import { readSourcePathProofSync } from "@red-cup-engineering/git-source-reading-service/pinned-source-files";

const bytes = Buffer.from("claim: authoritative-source-only\n");
const blob = gitBlobIdOf(bytes);
const child = [{ path: "claim.md", mode: "100644", type: "blob", sha: blob }];
const childSha = gitTreeIdOf(child.map(({ path, mode, sha }) => ({ name: path, mode, sha })));
const root = [{ path: "docs", mode: "040000", type: "tree", sha: childSha }];
const rootSha = gitTreeIdOf(root.map(({ path, mode, sha }) => ({ name: path, mode, sha })));
const proof = [{ sha: rootSha, truncated: false, tree: root }, { sha: childSha, truncated: false, tree: child }];
const person = "Source fixture <source@example.invalid> 0 +0000";
const object = Buffer.from(`tree ${rootSha}\nauthor ${person}\ncommitter ${person}\n\nPinned source\n`);
const commit = { sha: gitCommitIdOf(object), object };
const member = (changes = {}) => readEvidenceBoundSourceMember({ commit, path: "docs/claim.md", proof, bytes, ...changes });

test("bytes are bound to a pinned commit through its object, its trees and the blob", () => {
  assert.deepEqual(readEvidenceBoundCommit(commit), { sha: commit.sha, tree: { sha: rootSha } });
  assert.deepEqual(member(), { commit: commit.sha, tree: rootSha, path: "docs/claim.md", mode: "100644", blob });
});

test("a commit object that is not the pinned commit proves nothing", () => {
  const moved = Buffer.from(object.toString().replace("Pinned source", "Another source"));
  assert.throws(() => member({ commit: { sha: commit.sha, object: moved } }), /pinned identity/u);
  assert.throws(() => member({ commit: { sha: "f".repeat(40), object } }), /pinned identity/u);
  assert.throws(() => member({ commit: { sha: commit.sha, object: object.toString("base64") } }), TypeError);
  const treeless = Buffer.from(`author ${person}\n\nNo tree\n`);
  assert.throws(() => readEvidenceBoundCommit({ sha: gitCommitIdOf(treeless), object: treeless }), /root tree/u);
});

test("a commit bound to another tree cannot borrow this path proof", () => {
  const elsewhere = Buffer.from(object.toString().replace(rootSha, childSha));
  assert.throws(() => member({ commit: { sha: gitCommitIdOf(elsewhere), object: elsewhere } }), TypeError);
});

test("changed bytes, an absent path and a path that is not a regular file all refuse", () => {
  assert.throws(() => member({ bytes: Buffer.from("claim: edited\n") }), /not the blob/u);
  assert.throws(() => member({ path: "docs/absent.md" }), /regular file/u);
  assert.throws(() => member({ path: "docs", proof: [proof[0]] }), /regular file/u);
  assert.throws(() => member({ bytes: "claim: authoritative-source-only\n" }), TypeError);
});

const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "git-source-member-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, "init", "-q", "--object-format=sha1");
  git(directory, "config", "user.name", "Source fixture"); git(directory, "config", "user.email", "source@example.invalid");
  await mkdir(join(directory, "data/records"), { recursive: true });
  await writeFile(join(directory, "data/records/schema.json"), '{"title":"pinned"}\n');
  await writeFile(join(directory, "data/private.md"), "never selected\n");
  await writeFile(join(directory, "run.sh"), "#!/bin/sh\n"); await chmod(join(directory, "run.sh"), 0o755);
  await symlink("run.sh", join(directory, "link"));
  git(directory, "add", "."); git(directory, "commit", "-qm", "Pinned source\n\nWith a body.");
  return { directory, commit: git(directory, "rev-parse", "HEAD") };
}

test("evidence read from native Git verifies after travelling as JSON, without the repository", async t => {
  const { directory, commit: pinned } = await repository(t);
  const evidence = readSourcePathProofSync({ directory, commit: pinned, path: "data/records/schema.json" });
  assert.equal(gitCommitIdOf(evidence.commit.object), pinned);
  assert.equal(evidence.proof.length, 3);
  const carried = JSON.parse(JSON.stringify({ ...evidence, commit: { sha: pinned, object: evidence.commit.object.toString("base64") } }));
  await rm(directory, { recursive: true, force: true });
  const received = { ...carried, commit: { sha: carried.commit.sha, object: Buffer.from(carried.commit.object, "base64") } };
  const published = Buffer.from('{"title":"pinned"}\n');
  assert.deepEqual(readEvidenceBoundSourceMember({ ...received, bytes: published }), {
    commit: pinned, tree: evidence.proof[0].sha, path: "data/records/schema.json", mode: "100644", blob: gitBlobIdOf(published),
  });
  assert.throws(() => readEvidenceBoundSourceMember({ ...received, bytes: Buffer.from('{"title":"other"}\n') }), /not the blob/u);
  assert.throws(() => readEvidenceBoundSourceMember({ ...received, commit: { ...received.commit, sha: "0".repeat(40) }, bytes: published }), /pinned identity/u);
});

test("the evidence stops where native Git stops, and only a regular file is a source member", async t => {
  const { directory, commit: pinned } = await repository(t);
  const read = path => readSourcePathProofSync({ directory, commit: pinned, path });
  assert.equal(readEvidenceBoundSourceMember({ ...read("run.sh"), bytes: Buffer.from("#!/bin/sh\n") }).mode, "100755");
  assert.equal(read("absent/schema.json").proof.length, 1);
  assert.equal(read("run.sh/nested").proof.length, 1);
  assert.throws(() => readEvidenceBoundSourceMember({ ...read("data/absent.json"), bytes: Buffer.alloc(0) }), /regular file/u);
  assert.throws(() => readEvidenceBoundSourceMember({ ...read("link"), bytes: Buffer.from("run.sh") }), /regular file/u);
  assert.throws(() => readEvidenceBoundSourceMember({ ...read("data"), bytes: Buffer.alloc(0) }), /regular file/u);
  for (const path of ["", "../schema.json", "data//schema.json", "data/.git/HEAD", "data\\schema.json"])
    assert.throws(() => read(path), TypeError, path);
  assert.throws(() => readSourcePathProofSync({ directory, commit: "main", path: "run.sh" }), TypeError);
  assert.throws(() => readSourcePathProofSync({ directory, commit: "f".repeat(40), path: "run.sh" }));
});
