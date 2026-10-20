import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseGitmodules, encodeGitmodules, parseGitSubmoduleStatus, parseGitlinks, compareSubmodules } from "../src/gitmodules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "fixtures/sample.gitmodules");
// This fixture is three entries copied verbatim from the real root
// /home/emsenn/info/.gitmodules (turntide-islands, obsmetrological-services-section,
// red-cup-engineering), not synthesized data.
const fixtureText = readFileSync(fixturePath, "utf8");

test("parseGitmodules reads the real fixture's three entries, sorted by path", () => {
  const entries = parseGitmodules(fixtureText);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.path), [...entries.map((entry) => entry.path)].sort());
  const redCup = entries.find((entry) => entry.name.endsWith("red-cup-engineering"));
  assert.ok(redCup);
  assert.equal(redCup.url, "https://github.com/emsenn/red-cup-engineering.git");
  assert.equal(redCup.branch, undefined);
});

test("encodeGitmodules(parseGitmodules(text)) round-trips the real fixture byte-for-byte", () => {
  const entries = parseGitmodules(fixtureText);
  const reencoded = encodeGitmodules(entries);
  assert.equal(reencoded, fixtureText);
});

test("parseGitmodules keeps an optional branch field, and encode round-trips it", () => {
  const withBranch = '[submodule "example"]\n\tpath = vendor/example\n\turl = https://example.test/example.git\n\tbranch = release\n';
  const entries = parseGitmodules(withBranch);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].branch, "release");
  assert.equal(encodeGitmodules(entries), withBranch);
});

test("parseGitmodules normalizes backslashes and a leading ./ in path", () => {
  const text = '[submodule "weird"]\n\tpath = .\\vendor\\weird\n\turl = https://example.test/weird.git\n';
  const entries = parseGitmodules(text);
  assert.equal(entries[0].path, "vendor/weird");
});

test("effectful parsing admits original paths before documentary normalization", () => {
  const options = { requireContainedPaths: true };
  const declaration = (path) => `[submodule "child"]\npath = ${path}\nurl = ./child.git\n`;
  for (const path of ['child', 'services/nested child'])
    assert.equal(parseGitmodules(declaration(path), options)[0].path, path);
  for (const path of ['', './child', '.\\child', '../child', 'child/../other',
    '/tmp/child', 'C:/child', 'child//nested', 'child/.git/config', 'child\\nested']) {
    assert.throws(() => parseGitmodules(declaration(path), options),
      /repository-relative and contained/, JSON.stringify(path));
  }
  assert.throws(() => parseGitmodules('[submodule "child"]\nurl = ./child.git\n', options),
    /repository-relative and contained/, 'a declaration cannot omit its path');
  assert.throws(() => parseGitmodules('[submodule "child"]\npath = ./child\n', options),
    /repository-relative and contained/, 'a missing URL cannot hide a malformed path');
  assert.throws(() => parseGitmodules('[submodule "child"]\npath = ./child\npath = child\nurl = ./child.git\n', options),
    /repository-relative and contained/, 'a later path cannot erase malformed source evidence');
  assert.deepEqual(parseGitmodules('', options), []);
  assert.deepEqual(parseGitmodules('[submodule "child"]\nurl = ./child.git\n'), [],
    'documentary parsing still omits incomplete entries');
});

test("parseGitSubmoduleStatus reads status markers", () => {
  const status = " deadbeefdeadbeefdeadbeefdeadbeefdeadbeef vendor/pinned (heads/main)\n" +
    "-cafebabecafebabecafebabecafebabecafebabe vendor/uninitialized\n" +
    "+1234567890abcdef1234567890abcdef12345678 vendor/modified\n" +
    "U0000000000000000000000000000000000000000 vendor/merged\n";
  const entries = parseGitSubmoduleStatus(status);
  assert.equal(entries.length, 4);
  const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry.status]));
  assert.equal(byPath["vendor/pinned"], "pinned");
  assert.equal(byPath["vendor/uninitialized"], "uninitialized");
  assert.equal(byPath["vendor/modified"], "modified");
  assert.equal(byPath["vendor/merged"], "merged");
});

test("parseGitlinks reads raw 160000 gitlink lines", () => {
  const text = "160000 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 0\tvendor/pinned\n" +
    "100644 1234567890abcdef1234567890abcdef12345678 0\tREADME.md\n";
  const entries = parseGitlinks(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "vendor/pinned");
  assert.equal(entries[0].commit, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(entries[0].status, "pinned");
});

test("parseGitlinks reads NUL-separated ls-files --stage -z entries, keeping a path's spaces", () => {
  const text = "100644 1234567890abcdef1234567890abcdef12345678 0\tREADME.md\u0000160000 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 0\tvendor/with space \u0000";
  assert.deepEqual(parseGitlinks(text).map((entry) => entry.path), ["vendor/with space "]);
});

test("compareSubmodules names the declarations no gitlink pins and the gitlinks no declaration names", () => {
  const declarations = parseGitmodules("[submodule \"declared\"]\n\tpath = declared\n\turl = ./declared\n[submodule \"pinned\"]\n\tpath = pinned\n\turl = ./pinned\n");
  const gitlinks = parseGitlinks("160000 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 0\tpinned\u0000160000 0123456789012345678901234567890123456789 0\torphan\u0000");
  const { declarationsWithoutGitlink, gitlinksWithoutDeclaration } = compareSubmodules(declarations, gitlinks);
  assert.deepEqual(declarationsWithoutGitlink.map((entry) => entry.path), ["declared"]);
  assert.deepEqual(gitlinksWithoutDeclaration.map((entry) => entry.path), ["orphan"]);
});
