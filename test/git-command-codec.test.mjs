import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gitExtractionPlan, gitCommitPathsPlan, gitEstablishmentPlan, gitHistoryPlan, gitRepositoryObservationPlan, gitRestorePlan, gitSubmodulePlan, gitWorktreePlan, readBatchBlobs, readCommits, readCount, readFieldRecords, readGitBranchIntegrationRequest, readGitCommitPathsRequest, readIndexEntries, readIndexedPaths, readLfsPointer, readNameStatus, readPathCommits, readPorcelainStatus, readRawChange, readReferences, readRepositoryRestoreRequest, readTreeEntries, takeBatchRecord } from "../src/git-command-codec.mjs";

test("raw Git tree bytes decode fatally without changing existing string readings", () => {
  const text = "100644 blob " + "a".repeat(40) + "\t枝_1.mjs\0";
  assert.deepEqual(readTreeEntries(Buffer.from(text)), readTreeEntries(text));
  const invalid = Buffer.concat([Buffer.from("100644 blob " + "a".repeat(40) + "\t"), Buffer.from([0xff]), Buffer.from("\0")]);
  assert.throws(() => readTreeEntries(invalid), { code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
});

test("porcelain status entries read as { status, path }, a rename also naming its source", () => {
  assert.deepEqual(readPorcelainStatus(""), []);
  assert.deepEqual(readPorcelainStatus(" M a b.txt\0?? new/\0R  moved.txt\0was.txt\0D  gone\0"), [
    { status: " M", path: "a b.txt" },
    { status: "??", path: "new/" },
    { status: "R ", path: "moved.txt", source: "was.txt" },
    { status: "D ", path: "gone" },
  ]);
  assert.throws(() => readPorcelainStatus("MM\0"), /malformed porcelain/u);
});

test("the worktree plan's status reads back what Git reports for a rename, an edit and a new file", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "git-command-codec-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...arguments_) => spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "house@example.invalid");
  git("config", "user.name", "House");
  writeFileSync(path.join(root, "kept.txt"), "kept\n");
  writeFileSync(path.join(root, "was.txt"), "a file long enough that Git sees its move as a rename\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("mv", "was.txt", "moved.txt");
  writeFileSync(path.join(root, "kept.txt"), "edited\n");
  writeFileSync(path.join(root, "new file.txt"), "new\n");
  const step = gitWorktreePlan.status();
  const result = spawnSync(step.command, step.arguments, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readPorcelainStatus(result.stdout), [
    { status: " M", path: "kept.txt" },
    { status: "R ", path: "moved.txt", source: "was.txt" },
    { status: "??", path: "new file.txt" },
  ]);
});

test("name-status rows read as { status, path } and an unpaired field is refused", () => {
  assert.deepEqual(readNameStatus("A\0new.txt\0M\0kept.txt\0"), [{ status: "A", path: "new.txt" }, { status: "M", path: "kept.txt" }]);
  assert.throws(() => readNameStatus("A\0"), /incomplete name-status/u);
});

test("every push the plans make refuses a gitlink whose submodule commit is on no remote", () => {
  for (const step of [gitWorktreePlan.pushMain(), gitWorktreePlan.pushBranch("duty/a"), gitCommitPathsPlan.pushCommitMain("a".repeat(40), "b".repeat(40))]) {
    assert.equal(step.arguments[0], "push");
    assert.ok(step.arguments.includes("--recurse-submodules=check"), step.arguments.join(" "));
  }
});

test("only a work branch is ever unpublished", () => {
  assert.deepEqual(gitWorktreePlan.unpublishBranch("duty/a").arguments, ["push", "origin", "--delete", "refs/heads/duty/a"]);
  assert.throws(() => gitWorktreePlan.unpublishBranch("main"), /work branch/u);
});

test("branch integration selects a contribution source, with a required reviewed head for origin", () => {
  const head = "a".repeat(40), sourceBase = "b".repeat(40);
  assert.deepEqual(readGitBranchIntegrationRequest({ sourceBase, branch: " duty/x-1 ", message: " Join " }), { sourceBase, branch: "duty/x-1", message: "Join" });
  assert.deepEqual(readGitBranchIntegrationRequest({ sourceBase, branch: "duty/x-1", message: "Join", expectedBranchHead: head }), { sourceBase, branch: "duty/x-1", message: "Join", expectedBranchHead: head });
  assert.deepEqual(readGitBranchIntegrationRequest({ sourceBase, branch: "team-lead/x", source: "origin", message: "Join", expectedBranchHead: head }), { sourceBase, branch: "team-lead/x", source: "origin", message: "Join", expectedBranchHead: head });
  assert.throws(() => readGitBranchIntegrationRequest({ sourceBase, branch: "main", message: "Join" }), /contribution branch/u);
  assert.throws(() => readGitBranchIntegrationRequest({ sourceBase, branch: "fix/x", source: "origin", message: "Join" }), /requires expectedBranchHead/u);
  assert.throws(() => readGitBranchIntegrationRequest({ sourceBase, branch: "duty/x-1", message: "Join", expectedBranchHead: "HEAD" }), /object id/u);
  assert.throws(() => readGitBranchIntegrationRequest({ branch: "duty/x-1", message: "Join" }), /requires the original sourceBase object id/u);
  assert.throws(() => readGitBranchIntegrationRequest({ sourceBase: "HEAD", branch: "duty/x-1", message: "Join" }), /requires the original sourceBase object id/u);
});

test("a commit request names literal file paths inside the repository, never its metadata", () => {
  assert.deepEqual(readGitCommitPathsRequest({ paths: ["b.txt", ":(literal)a.txt", "b.txt"], message: " Edit " }), { paths: [":(literal)a.txt", "b.txt"], message: "Edit", push: false, dryRun: false });
  assert.equal(readGitCommitPathsRequest({ paths: ["a.txt"], message: "Edit", dryRun: true }).dryRun, true);
  for (const paths of [[".git/config"], ["nested/.git/HEAD"], ["../outside.txt"], ["/absolute.txt"], ["./a.txt"], ["."]]) {
    assert.throws(() => readGitCommitPathsRequest({ paths, message: "Edit" }), /literal repository-relative/u, paths[0]);
  }
  assert.throws(() => readGitCommitPathsRequest({ paths: ["a.txt"], message: "Edit", dryRun: "yes" }), /dryRun must be boolean/u);
});

test("reviewed source retains every selected Git identity and explicit absence without mutable intake aliases", () => {
  const entries = [
    { path: "tree", mode: "040000", type: "tree", sha: "a".repeat(40) },
    { path: "file", mode: "100644", type: "blob", sha: "b".repeat(40) },
    { path: "executable", mode: "100755", type: "blob", sha: "c".repeat(40) },
    { path: "link", mode: "120000", type: "blob", sha: "d".repeat(40) },
    { path: "child", mode: "160000", type: "commit", sha: "e".repeat(40) },
    { path: "枝/new [file].mjs", absent: true },
  ];
  const reviewedSource = { revision: "f".repeat(40), entries };
  const result = readGitCommitPathsRequest({ paths: entries.map(({ path }) => path), message: "Receive selected source", reviewedSource });
  assert.deepEqual(result.reviewedSource, reviewedSource);
  assert.deepEqual(result.paths, entries.map(({ path }) => path).sort());
  assert.ok(Object.isFrozen(result.reviewedSource));
  assert.ok(Object.isFrozen(result.reviewedSource.entries));
  assert.ok(result.reviewedSource.entries.every(Object.isFrozen));
  entries[0].sha = "1".repeat(40);
  entries.push({ path: "foreign", absent: true });
  reviewedSource.revision = "2".repeat(40);
  assert.equal(result.reviewedSource.revision, "f".repeat(40));
  assert.equal(result.reviewedSource.entries.length, 6);
  assert.equal(result.reviewedSource.entries[0].sha, "a".repeat(40));
});

test("reviewed source refuses missing, duplicate and foreign path evidence instead of weakening the selected scope", () => {
  const revision = "a".repeat(40), a = { path: "a", absent: true }, b = { path: "b", absent: true };
  for (const reviewedSource of [null, {}, { revision }, { revision, entries: [] },
    { revision, entries: [a] }, { revision, entries: [a, a] },
    { revision, entries: [a, { path: "foreign", absent: true }] },
    { revision, entries: [a, b, b] }, { revision, entries: [a, null] },
    { revision, entries: new Array(2) }, { revision, entries: [a, b], extra: true }]) {
    assert.throws(() => readGitCommitPathsRequest({ paths: ["a", "b"], message: "Receive", reviewedSource }), TypeError);
  }
  assert.throws(() => readGitCommitPathsRequest({ paths: ["a", "a"], message: "Receive", reviewedSource: { revision, entries: [a] } }), /one exact entry/u);
  // Existing callers still deduplicate paths and omit the optional carrier.
  assert.deepEqual(readGitCommitPathsRequest({ paths: ["a", "a"], message: " Receive " }), {
    paths: ["a"], message: "Receive", push: false, dryRun: false,
  });
});

test("reviewed source requires non-null immutable SHA-1 identities and matching Git mode/type pairs", () => {
  const admit = (entry, revision = "a".repeat(40)) => readGitCommitPathsRequest({
    paths: ["a"], message: "Receive", reviewedSource: { revision, entries: [entry] },
  });
  const file = { path: "a", mode: "100644", type: "blob", sha: "b".repeat(40) };
  for (const revision of ["HEAD", "a".repeat(39), "a".repeat(64), "A".repeat(40), "0".repeat(40), null, 1]) {
    assert.throws(() => admit(file, revision), /immutable revision/u);
  }
  for (const entry of [
    { ...file, sha: null }, { ...file, sha: "0".repeat(40) }, { ...file, sha: "b".repeat(64) },
    { ...file, sha: "HEAD:a" }, { ...file, mode: 100644 }, { ...file, mode: "100600" },
    { ...file, mode: "100644", type: "commit" }, { ...file, mode: "160000", type: "blob" },
    { ...file, mode: "040000", type: "blob" }, { ...file, extra: true },
    { path: "a", mode: "100644", type: "blob" },
  ]) assert.throws(() => admit(entry), /matching Git mode\/type/u);
  for (const entry of [{ path: "a", absent: false }, { path: "a", absent: null },
    { path: "a", absent: true, sha: null }, { ...file, absent: true }, { path: "a" }]) {
    assert.throws(() => admit(entry), TypeError);
  }
});

test("reviewed source paths are canonical literal Git paths with no hidden traversal or metadata", () => {
  for (const path of ["/absolute", "./a", "../a", "a/../b", "a/./b", "a//b", "a/", ".git", "nested/.GIT/config",
    "\\absolute", "a\\..\\b", "a\\.\\b", "a\\.GIT\\config", "a\\\\b", "a\\", "a/C:outside", "C:/outside", "a\rfile", "a\nfile", "a\tfile", "a\u0000file", "a\u001bfile", "a\u007ffile"]) {
    assert.throws(() => readGitCommitPathsRequest({ paths: [path], message: "Receive",
      reviewedSource: { revision: "a".repeat(40), entries: [{ path, absent: true }] } }), TypeError, path);
  }
  const path = ":(glob)* [literal].mjs";
  assert.equal(readGitCommitPathsRequest({ paths: [path], message: "Receive",
    reviewedSource: { revision: "a".repeat(40), entries: [{ path, absent: true }] } }).reviewedSource.entries[0].path, path);
});

test("reviewed source preserves literal quote and backslash filename bytes", () => {
  const path = String.raw`notes/"First Steps \360\237\220\276 I'm Here.md"`;
  const reviewedSource = {revision: "a".repeat(40), entries: [
    {path, mode: "100644", type: "blob", sha: "b".repeat(40)},
    {path: String.raw`notes/a\b`, absent: true}
  ]};
  const result = readGitCommitPathsRequest({paths: reviewedSource.entries.map(row => row.path),
    message: "Receive exact names", push: true, reviewedSource});
  assert.deepEqual(result.reviewedSource, reviewedSource);
  assert.deepEqual(result.paths, reviewedSource.entries.map(row => row.path).sort());
  assert.notEqual(result.paths[0], result.paths[0].replaceAll("\\", "/"));
});

test("a message claiming a decommission is admitted only when a committed path names the target", () => {
  assert.throws(() => readGitCommitPathsRequest({ paths: ["a.txt"], message: "land FAE-decommission fixes" }), /decommissioning 'FAE'/u);
  assert.throws(() => readGitCommitPathsRequest({ paths: ["a.txt"], message: "Decommission the koios-news reader" }), /decommissioning 'koios-news'/u);
  assert.equal(readGitCommitPathsRequest({ paths: ["lib/koios-news/reader.mjs"], message: "Decommission the koios-news reader" }).paths.length, 1);
  assert.equal(readGitCommitPathsRequest({ paths: ["lib/fae/index.mjs"], message: "Finish FAE-decommissioning" }).paths.length, 1);
});

test("the index reading keeps the paths cat-file found, row for row", () => {
  const oid = "a".repeat(40);
  assert.deepEqual(readIndexedPaths(["kept", "absent", "also"], `${oid} blob 4\n:0:absent missing\n${oid} blob 9\n`), ["kept", "also"]);
  assert.deepEqual(readIndexedPaths(["kept"], ""), []);
  assert.deepEqual(gitCommitPathsPlan.indexedPaths(["a b", "c"]).input, ":0:a b\n:0:c\n");
});

test("path lists travel on stdin as literal NUL-separated pathspecs, never as arguments", () => {
  const paths = ["one.txt", ":(glob)*", "a b"];
  for (const step of [
    gitCommitPathsPlan.addPaths(paths, "/tmp/index"),
    gitCommitPathsPlan.addPaths(paths, "/tmp/index", { force: true }),
    gitCommitPathsPlan.removePaths(paths),
    gitCommitPathsPlan.resetPaths("a".repeat(40), paths),
    gitCommitPathsPlan.checkoutPaths("a".repeat(40), paths),
  ]) {
    assert.deepEqual(step.arguments.slice(-2), ["--pathspec-from-file=-", "--pathspec-file-nul"], step.arguments.join(" "));
    assert.ok(paths.every((file) => !step.arguments.includes(file)), step.arguments.join(" "));
    assert.equal(step.input, "one.txt\0:(glob)*\0a b\0");
    assert.equal(step.environment.GIT_LITERAL_PATHSPECS, "1");
  }
  assert.ok(gitCommitPathsPlan.addPaths(paths, "/tmp/index", { force: true }).arguments.includes("-f"));
  assert.ok(!gitCommitPathsPlan.addPaths(paths, "/tmp/index").arguments.includes("-f"));
});

test("a cat-file batch record is taken whole or not at all, so a stream can wait for the rest", () => {
  const oid = "b".repeat(40);
  const bytes = new TextEncoder().encode(`${oid} blob 3\nhé\nHEAD:gone missing\n`);
  for (let cut = 0; cut < 52; cut += 1) assert.equal(takeBatchRecord(bytes.subarray(0, cut)), undefined, `cut ${cut}`);
  const first = takeBatchRecord(bytes);
  assert.equal(first.object, oid);
  assert.equal(first.type, "blob");
  assert.equal(new TextDecoder().decode(first.body), "hé");
  const second = takeBatchRecord(first.rest);
  assert.deepEqual([second.object, second.type, second.body, second.rest.length], ["HEAD:gone", undefined, undefined, 0]);
  assert.throws(() => takeBatchRecord(new TextEncoder().encode("not a header\n")), /malformed cat-file header/u);
  assert.throws(() => takeBatchRecord(new TextEncoder().encode(`${oid} blob 1\nab`)), /without its newline/u);
});

test("batch blobs read git's own output as text in request order, a missing object undefined", () => {
  const root = mkdtempSync(path.join(tmpdir(), "git-codec-batch-"));
  try {
    const git = (arguments_, input) => {
      const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8", input });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    git(["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(root, "ü.json"), "{\"name\": \"Ünïcødé\"}\n");
    writeFileSync(path.join(root, "plain.txt"), "plain\n");
    git(["add", "."]);
    git(["-c", "user.email=a@b.invalid", "-c", "user.name=a", "commit", "-q", "-m", "fixture"]);
    const objects = ["HEAD:ü.json", "HEAD:absent.txt", "HEAD:plain.txt"];
    const plan = gitHistoryPlan.blobs(objects);
    assert.deepEqual(readBatchBlobs(objects, git(plan.arguments, plan.input)), ["{\"name\": \"Ünïcødé\"}\n", undefined, "plain\n"]);
    assert.throws(() => readBatchBlobs([...objects, "HEAD:more"], git(plan.arguments, plan.input)), /ended before HEAD:more/u);
    assert.throws(() => gitHistoryPlan.blobs(["HEAD:a\nHEAD:b"]), /single lines/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw log changes read as the blob before and after, a deletion's after being the null id", () => {
  const [before, after, none] = ["c".repeat(40), "d".repeat(40), "0".repeat(40)];
  assert.deepEqual(readRawChange(`:100644 100644 ${before} ${after} M\tdir/a b.md`), { before, after, status: "M", path: "dir/a b.md" });
  assert.deepEqual(readRawChange(`:100644 000000 ${before} ${none} D\tgone.md`), { before, after: none, status: "D", path: "gone.md" });
  assert.equal(readRawChange("@commit 2026-09-28T00:00:00Z"), undefined);
  assert.throws(() => readRawChange(":100644 100644 abc def M\tshort.md"), /malformed raw change/u);
  assert.deepEqual(gitHistoryPlan.revisions({ pathspecs: ["*.md"], exclude: [after] }).arguments.slice(3, 6), ["--all", `^${after}`, "--format=@%H %cI"]);
});

test("history observations read NUL-field records, tree entries and counts, and refuse option-like revisions", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  assert.deepEqual(readCommits(`${a}\0${b} ${b}\0Ann\0ann@x\0t1\0Cy\0cy@x\0t2\0subject\u001e\n${b}\0\0Ann\0ann@x\0t0\0Cy\0cy@x\0t0\0root\u001e\n`), [
    { id: a, parents: [b, b], author: { name: "Ann", email: "ann@x", at: "t1" }, committer: { name: "Cy", email: "cy@x", at: "t2" }, subject: "subject" },
    { id: b, parents: [], author: { name: "Ann", email: "ann@x", at: "t0" }, committer: { name: "Cy", email: "cy@x", at: "t0" }, subject: "root" },
  ]);
  assert.deepEqual(readPathCommits(""), []);
  assert.deepEqual(readPathCommits(`${a}\0t1\0t2\u001e\n`), [{ id: a, authoredAt: "t1", committedAt: "t2" }]);
  assert.deepEqual(readReferences(`refs/tags/v1\0v1\0tag\0${a}\u001e\n`), [{ ref: "refs/tags/v1", name: "v1", type: "tag", object: a }]);
  assert.throws(() => readFieldRecords(`${a}\0t1\u001e`, 3), /malformed NUL-separated/u);
  assert.deepEqual(readTreeEntries(`100644 blob ${a}      12\ta b.txt\u0000160000 commit ${b}       -\tvendor\0`), [
    { path: "a b.txt", mode: "100644", type: "blob", object: a, bytes: 12 },
    { path: "vendor", mode: "160000", type: "commit", object: b, bytes: null },
  ]);
  assert.throws(() => readTreeEntries(`100644 blob ${a} 1\tone\u0000100644 blob ${a} 1\ttwo\0`, 1), RangeError);
  assert.deepEqual(readTreeEntries(`100644 blob ${a}\tdocs/x.md\0`), [{ path: "docs/x.md", mode: "100644", type: "blob", object: a, bytes: null }]);
  assert.throws(() => readTreeEntries("garbage\0"), /malformed tree entry/u);
  assert.deepEqual(readIndexEntries(`100644 ${a} 0\ta b.txt\u0000160000 ${b} 0\tvendor\0`), [
    { path: "a b.txt", mode: "100644", object: a, stage: 0 },
    { path: "vendor", mode: "160000", object: b, stage: 0 },
  ]);
  assert.throws(() => readIndexEntries("garbage\0"), /malformed index entry/u);
  assert.equal(readCount("12\n"), 12);
  assert.throws(() => readCount(""), /commit count/u);
  assert.deepEqual(gitRepositoryObservationPlan.commitCount(["HEAD"], ["refs/tags/v1"]).arguments, ["rev-list", "--count", "HEAD", "--not", "refs/tags/v1", "--"]);
  assert.deepEqual(gitRepositoryObservationPlan.pathCommits("HEAD", "docs/a.md", 5).environment, { GIT_LITERAL_PATHSPECS: "1" });
  assert.throws(() => gitRepositoryObservationPlan.commits("--all", 5), /revision/u);
  assert.throws(() => gitRepositoryObservationPlan.commits("HEAD", 0), /maximumCommits/u);
  assert.throws(() => gitRepositoryObservationPlan.pathCommits("HEAD", "../escape", 5), /one repository-relative path/u);
});

test("a submodule registration adds a literal path in place and detaches the child at a revision", () => {
  assert.deepEqual(gitSubmodulePlan.add("https://example.invalid/child.git", "vendor/child").arguments, ["submodule", "add", "--force", "--", "https://example.invalid/child.git", "vendor/child"]);
  assert.deepEqual(gitSubmodulePlan.detach("0123456789012345678901234567890123456789").arguments, ["checkout", "--detach", "0123456789012345678901234567890123456789"]);
  assert.throws(() => gitSubmodulePlan.add("https://example.invalid/child.git", "../escape"), /repository-relative directory/u);
  assert.throws(() => gitSubmodulePlan.add("", "vendor/child"), /url/u);
  assert.throws(() => gitSubmodulePlan.detach("--orphan"), /revision/u);
  assert.deepEqual(gitRepositoryObservationPlan.gitmodules().ok, [0, 128]);
});

test("a restore request names what to restore, never how, and its plans keep each file literal", () => {
  const request = readRepositoryRestoreRequest({ type: "RepositoryRestoreObservationRequest", remoteUrl: "git@example.invalid:r.git", ref: "main", requiredPaths: ["b.md", "a/c.json"] });
  assert.deepEqual(request.requiredPaths, ["a/c.json", "b.md"]);
  assert.throws(() => readRepositoryRestoreRequest({ ...request, requiredPaths: ["../secret"] }), /parent segment/u);
  assert.throws(() => readRepositoryRestoreRequest({ ...request, requiredPaths: ["docs/*.md"] }), /literal/u);
  assert.throws(() => readRepositoryRestoreRequest({ ...request, requiredPaths: ["a.md", "a.md"] }), /distinct/u);
  assert.throws(() => readRepositoryRestoreRequest({ ...request, gitArguments: ["--upload-pack=x"] }), /may not select gitArguments/u);
  assert.throws(() => readRepositoryRestoreRequest({ ...request, remoteUrl: "--upload-pack=x" }), /remote url/u);
  assert.throws(() => readRepositoryRestoreRequest({ ...request, ref: "-x" }), /revision/u);
  assert.equal(gitRestorePlan.sparse(request.requiredPaths).input, "/a/c.json\n/b.md\n");
  assert.deepEqual(gitRestorePlan.checkout("a".repeat(40)).environment, { GIT_LFS_SKIP_SMUDGE: "1" });
  assert.deepEqual(gitRestorePlan.object("HEAD", "a/c.json").arguments, ["rev-parse", "--verify", "HEAD:a/c.json"]);
  assert.deepEqual(gitRestorePlan.pullLfs(["a.bin", "b.bin"]).arguments, ["lfs", "pull", "--include=a.bin,b.bin", "--exclude="]);
  assert.throws(() => gitRestorePlan.pullLfs(["a,b.bin"]), /commas/u);
  assert.throws(() => gitRestorePlan.initialize("--template=x"), /relative directory/u);
});

test("an LFS pointer reads as the object id and size it names; other bytes read as null", () => {
  const oid = "0".repeat(63) + "f";
  const pointer = new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 2048\n`);
  assert.deepEqual(readLfsPointer(pointer), { oid: `sha256:${oid}`, size: "2048" });
  assert.equal(readLfsPointer(new TextEncoder().encode("plain text\n")), null);
  assert.equal(readLfsPointer(new Uint8Array(1025)), null);
});

test("gitEstablishmentPlan initializes on main, reads hooks from a literal directory, and commits a message from stdin", () => {
  assert.deepEqual(gitEstablishmentPlan.init().arguments, ["init", "--quiet", "--initial-branch=main"]);
  assert.deepEqual(gitEstablishmentPlan.hooksPath(".githooks").arguments, ["config", "core.hooksPath", ".githooks"]);
  assert.throws(() => gitEstablishmentPlan.hooksPath("../hooks"), /hooks path/u);
  assert.deepEqual(gitEstablishmentPlan.stageAll().arguments, ["add", "--all"]);
  const commit = gitEstablishmentPlan.commit("Start the repository\n");
  assert.deepEqual([commit.arguments, commit.input], [["commit", "--quiet", "--file=-"], "Start the repository\n"]);
  assert.throws(() => gitEstablishmentPlan.commit(" "), /message/u);
});



test("standalone extraction plans pin history reads and change only a temporary clone", () => {
  const commit = "a".repeat(40);
  assert.deepEqual(gitExtractionPlan.filesAt(commit, "services/package").arguments, ["ls-tree", "-r", "--name-only", "-z", commit, "--", "services/package"]);
  assert.deepEqual(gitExtractionPlan.namesAt(commit, "services/package/package.json").arguments, ["log", "--follow", "--name-only", "--format=", "-z", commit, "--", "services/package/package.json"]);
  assert.deepEqual(gitExtractionPlan.historyNamesAt(commit, ["old-package", "services/package"]).arguments, ["log", "--name-only", "--no-renames", "--format=", "-z", commit, "--", "old-package", "services/package"]);
  assert.deepEqual(gitExtractionPlan.historyNamesAt(commit, ["services/package"]).environment, { GIT_LITERAL_PATHSPECS: "1" });
  assert.throws(() => gitExtractionPlan.historyNamesAt(commit, []), /1 to 64/);
  assert.throws(() => gitExtractionPlan.historyNamesAt(commit, Array(65).fill("path")), /1 to 64/);
  assert.deepEqual(gitExtractionPlan.selectRevision(commit).arguments, ["update-ref", "refs/heads/main", commit]);
  assert.deepEqual(gitExtractionPlan.attachMain().arguments, ["symbolic-ref", "HEAD", "refs/heads/main"]);
});

test("standalone target plans require readable complete refs and absent-main compare-and-swap", () => {
  const url = "/tmp/synthetic-target.git";
  assert.deepEqual(gitExtractionPlan.remoteRefs(url).arguments, ["ls-remote", "--refs", "--", url]);
  assert.deepEqual(gitExtractionPlan.remoteRefs(url).ok, [0]);
  assert.deepEqual(gitExtractionPlan.pushEmptyMain(url).arguments, ["push", "--quiet", "--recurse-submodules=check", "--force-with-lease=refs/heads/main:", url, "HEAD:refs/heads/main"]);
  assert.deepEqual(gitExtractionPlan.pushEmptyMain(url).ok, [0]);
  assert.throws(() => gitExtractionPlan.remoteRefs("--bad"), /remote url/);
  assert.throws(() => gitExtractionPlan.filesAt("a".repeat(40), "../escape"), /relative/);
});

test("source-copy requests name only a canonical repository, full ref and exact commit", async () => {
  const { readGitSourceWorkingCopyRequest: read } = await import("../src/git-command-codec.mjs");
  const request = { sourceRepository: "https://github.com/fixture/source.git", ref: "refs/heads/main", commit: "a".repeat(40) };
  assert.deepEqual(read(request), request);
  for (const key of ["destination", "workspaceRoot", "credentialService", "custody", "evidence"]) assert.throws(() => read({ ...request, [key]: "untrusted" }), /only sourceRepository/);
  for (const sourceRepository of ["git@github.com:fixture/source.git", "https://token@github.com/fixture/source.git", "https://github.com/fixture/source.git?token=unsafe", "file:///tmp/../other", "ext::helper", "https://github.com/fixture/source.git#ref"]) assert.throws(() => read({ ...request, sourceRepository }));
  for (const ref of ["main", "refs/heads/../escape", "refs/heads/a:else", "refs/heads/a\\b", "refs/heads/a.lock", "refs/heads/a@{b", "refs/heads/a\nb", "refs/heads/a//b"]) assert.throws(() => read({ ...request, ref }));
  assert.throws(() => read({ ...request, commit: "HEAD" }), /full commit/);
});

test("source-copy plans isolate configuration and never recurse or check out during clone", async () => {
  const { gitSourceWorkingCopyPlan: plan } = await import("../src/git-command-codec.mjs");
  const request = { sourceRepository: "https://github.com/fixture/source.git", ref: "refs/heads/main", commit: "a".repeat(40) };
  const clone = plan.clone(request, "/admitted/copy");
  assert.equal(clone.command, "git");
  for (const flag of ["--no-checkout", "--no-local", "--no-recurse-submodules", "--template="]) assert.ok(clone.arguments.includes(flag));
  assert.ok(clone.arguments.includes("core.hooksPath=/dev/null")); assert.ok(clone.arguments.includes("core.fsmonitor=false"));
  assert.equal(clone.environment.GIT_CONFIG_GLOBAL, "/dev/null"); assert.equal(clone.environment.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(clone.environment.GIT_CONFIG_COUNT, "0"); assert.equal(clone.environment.GIT_CONFIG_PARAMETERS, ""); assert.equal(clone.environment.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(clone.environment.GIT_TERMINAL_PROMPT, "0");
  assert.deepEqual(plan.fetch(request).arguments.slice(-6), ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", request.commit]);
  assert.deepEqual(plan.checkout(request).arguments.slice(-4), ["checkout", "--detach", "--force", request.commit]);
  assert.ok(plan.configuration("/admitted/copy/.git/config").arguments.includes("--no-includes"));
  assert.throws(() => plan.clone(request, "../escape"));
});

test('exact source plans preserve the actual carrier branch spelling without broadening retirement',async()=>{
 const {gitSourceWorkingCopyPlan:source,SOURCE_WORK_BRANCH,WORK_BRANCH}=await import('../src/git-command-codec.mjs');
 const commit='a'.repeat(40),branch='claude-code/agency-original';
 assert.equal(SOURCE_WORK_BRANCH.test(branch),true);assert.equal(WORK_BRANCH.test(branch),false);
 assert.deepEqual(source.worktreeBranch(branch,commit).arguments.slice(-3),['-B',branch,commit]);
 assert.deepEqual(source.recordSourceBase(branch,commit).arguments.slice(-2),[`branch.${branch}.sourceBase`,commit]);
 for(const unsafe of ['claude-code/../other','claude-code/task.lock','claude-code/task.','--config/foreign']){
  assert.throws(()=>source.worktreeBranch(unsafe,commit));assert.throws(()=>source.recordSourceBase(unsafe,commit));
 }
 assert.throws(()=>source.worktreeAdd('/tmp/task','main'));
});

test("recovery bundle plans name only the carrier file and refuse option-shaped or multi-line paths", async () => {
  const { gitRecoveryBundlePlan: plan } = await import("../src/git-command-codec.mjs");
  assert.deepEqual(plan.create("/carriers/repo.bundle").arguments, ["bundle", "create", "/carriers/repo.bundle", "--all"]);
  assert.deepEqual(plan.verify("/carriers/repo.bundle").arguments, ["bundle", "verify", "/carriers/repo.bundle"]);
  assert.deepEqual(plan.clone("/carriers/repo.bundle").arguments, ["clone", "--quiet", "--no-checkout", "--", "/carriers/repo.bundle", "repository"]);
  assert.deepEqual(plan.hasCommit("a".repeat(40)).arguments, ["cat-file", "-e", `${"a".repeat(40)}^{commit}`]);
  for (const unsafe of ["", "-u", "--upload-pack=x", "a\nb", "a\0b"]) assert.throws(() => plan.create(unsafe), /recovery carrier path/u);
  assert.throws(() => plan.clone("/carriers/repo.bundle", "../escape"), /one repository-relative path/u);
});
