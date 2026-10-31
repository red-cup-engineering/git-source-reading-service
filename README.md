# Git source reading

## Pure source identity and tree proofs

`./git-object-id`, `./source-path-proof` and `./source-tree-patch` own the
original SHA-1 Git object identities, complete immediate-tree/path witnesses,
and bounded source-tree transformations previously implemented by Git Services.
Git Services forwards those public entrances to these same functions. This
source move preserves the complete implementations from Git Services commit
`275129f0dc6a6b2a323430bb7357fc1bc1ac2c17`, including exact leaf-removal
preconditions and pruning only touched directories emptied by a transformation.

These functions use native cryptographic hashing and local pure readers. They
do not execute Git, contact a forge, create a candidate, admit Work, or interpret
a complete tree proof as content or capability acceptance. Existing SHA-1-only
proof grammar, path/mode checks, duplicate and overlap refusal, and finite
tree/change bounds remain unchanged. The separately owned pinned-source reader
retains its existing SHA-1/SHA-256 native object-reading contract.

The package remains free of package dependencies. Native history streaming and
source-delivery effects are consumed through Git Engine, whose command plans
and binary output readers come from this service. The original source tests and
the moved proof tests are included in the native package's `receivingTests` so
an installed consumer can qualify the same source, including the authentic
`git filter-repo` prerequisite described below.

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

`readRepositorySourceFiles` receives an explicit repository, literal filename, source scope, excluded directories and repository bound. It reads authored files from materialized repositories or their parent-pinned objects. Native Git must be available on PATH. This source reader does not install or link package dependencies.


## Exact committed source and shared primitive ownership

Code production MUST depend only on Data/Code primitives. Exact source reading
MUST NOT require the Git umbrella's Networking consumers or a workspace install.
This existing service owns the native exact-commit reader and its pure Git command,
object, submodule and source-value codecs. The umbrella forwards its old public
subpaths to these same exports; there is one active implementation and identical
function/schema objects. The existing root `readRepositorySourceFiles` API and
its source bytes remain unchanged.

`./pinned-source-files` exports `createPinnedSourceReader({scratch, environment,
environmentForRepository, resolveSubmodule, rejectSelectedNonRegular=false,
maxRepositories=32, maxPaths=100000, maxBytes=67108864})`. It returns a reader for
`{repository, commit, scope='', selectFile, enterDirectory}`. Selection is explicit;
only exact committed regular/executable bytes and their source coordinates are
returned. Declared composed Gitlinks enter their exact pinned commits through the
caller's resolver; `update=none` and unselected mounts remain outside composition.
The caller owns the absolute source-object directory and repository credentials. This API
grants no access, installation, publication or branch-selection authority.

The directory is reusable across reader construction and process restart. One
native object database is selected by exact repository and object format, with
its owner and physical directory identities received before use. A different
repository never repoints an ordinal database. Retain this directory with the
original source owner; publication/build scratch has a separate terminal
lifetime. Only missing commits and selected blobs are acquired. Transport
credentials enter through the environment provider, never a retained URL.

Presence checks and acquisitions share Git's native `update-ref --stdin`
prepared transaction on an absent private ref. Aborting the transaction or
closing its input releases the lease without publishing a ref. This serializes
independent warm readers before they decide what is missing. Cold initialization
is serialized between factories in the same process; the host retains its
original cross-process publication/acquisition admission. Native object stores
are never reconfigured to accept changed origins, formats, aliases or executable
configuration. Unknown or changed custody preserves the original store.

The exact-commit reader supports full lowercase SHA-1 (40 hexadecimal characters)
and SHA-256 (64 hexadecimal characters) identities. Each source object store
is initialized with native Git's explicit matching `--object-format`, and its
actual storage format is received before fetching. An ambient `GIT_DEFAULT_HASH`
cannot choose another format. Native Git still owns commit/blob verification and
refuses incompatible or unavailable remote objects; this does not translate
identities between formats or permit abbreviated revisions. A reader may receive
separate repositories of either format without sharing their stores.

Strict receivers set `rejectSelectedNonRegular:true`; selected unsupported kinds
refuse instead of silently disappearing. Defaults preserve regular-file-only
behavior. Raw Git tree paths decode with fatal UTF-8 before selection. Finite
repository/path/selected-byte limits and original command/authentication/hook
controls remain unchanged. `./git-command-codec`, `./gitmodules` and
`./source-working-copy-schema` expose the original pure functions and value
contracts, including their existing schema IDs, full-ref grammar and command
plans. They perform no effects themselves. All package dependencies remain empty.

V&V: native local Git tests must receive pinned bytes, executable modes, binary and
Unicode files, exact composed children and dirty-worktree isolation; distinguish
default selection from strict selected-symlink refusal; refuse malformed paths,
invalid UTF-8, missing resolvers and exhausted finite bounds. Existing pure command,
ref-grammar and module-codec controls remain applicable. A native working-copy
fixture receives the unchanged root API. The umbrella's full original suite and
an export-by-export strict identity test qualify forwarding, including schema
identity. Exact published primitive and umbrella APIs are then read back through
the original registry receipt and used by the ordinary Code CLI; source tests
alone do not establish consumer delivery.

**History extraction's actual host prerequisite:** The original native
`test/extraction-mappings.test.mjs` executes `git filter-repo` on a disposable
Git history; a Node/Git runner without that separately installed utility
cannot qualify this test. The original dependency-free source reader itself
does not call filter-repo for ordinary pinned-source reads. The public
repository-owned native receiving workflow pins upstream
[newren/git-filter-repo v2.47.0](https://github.com/newren/git-filter-repo/tree/6f79afc8c90c592a3052e6cc53c2ca8907515bca)
by exact Git source and executable blob before running the *entire* source
suite. No private Git Services CI quota, production history rewrite,
unverified shell installer, or npm dependency on unrelated Git tools is
introduced. Full-suite passing remains separate from publishing a new
registry package or accepting a real user Work request.

The original command codec's `gitExtractionPlan.rewriteMappings` accepts bounded,
explicit file and directory histories and their receiving paths. Unlike a
whole-directory extraction, one evidence file can be retained without carrying
its unrelated siblings into the scientific repository. Run the generated
`git filter-repo` command only in the existing shared scratch-clone procedure;
source repositories remain intact. The native extraction regression checks
history retention, exact bytes and excluded neighboring source. PTGAE and
manoomin Science are the original receiving consumers for this extension.


The pinned-source-files entrance also exports receivePinnedRepositoryCommitSync and readGitBlobObjectsSync for an owner that already holds a repository or its original bare cache. They share the asynchronous reader native fetch plans and binary codec. Commit receiving is blobless; blob reading is local-only by default, with explicit missing-selected-object receiving through the original origin. Both adapters keep finite time, path and byte limits and create no checkout, worktree, branch or copied code tree.
## Reviewed source for exact-path publication

The pure `readGitCommitPathsRequest` decoder accepts an optional
`reviewedSource: {revision, entries}`. `revision` is the original reviewed
non-null lowercase SHA-1 commit identity, never a branch name or latest alias.
Every selected path occurs exactly once, with either its reviewed
`{path, mode, type, sha}` or `{path, absent: true}`. Missing, repeated, foreign,
unsafe or ambiguous entries refuse. A present object needs a non-null SHA-1
identity and one standard matching Git mode/type pair: regular/executable or
symbolic-link blob, tree, or Gitlink commit. Absence carries no object fields.

Reviewed paths are exact repository-relative literal Git paths. Literal quotes
and backslashes in POSIX filenames are preserved, never unquoted, normalized or
converted into separators. Safety checks inspect both slash spellings and refuse
empty/dot/traversal segments, case-insensitive metadata directories, absolute or
drive paths and control bytes. Accepting a path does not assert Windows checkout
portability; a native consumer must still preserve the exact Git identity.
The returned reviewed carrier is copied and frozen, preserving the exact
identities and explicit absence after caller input changes. Existing requests
without this optional field retain their previous normalization and behavior.

This decoder performs no Git observation or effect. The source publisher must
compare these identities with the actual original reviewed revision and current
target, preserve unrelated paths and refuse changed preimages. Parsing alone
does not authorize deletion, source publication or any particular carrier kind.

## Disposable native source construction (version 1)

Requirement: a declared source producer that reads native Git must receive the
original exact commit as a genuine Git root. A directory of copied blobs is not
a working copy; inventing a commit or weakening the producer's committed-source
checks does not satisfy this requirement. This source owner, not a package
publisher, owns transient materialization from its already-acquired objects.

The callable reader additionally provides
`await reader.materialize({repository, commit})`. Version 1 admits only the whole
root containing bounded regular/executable files; Gitlinks, symlinks, special
entries, scoped selection and embedded URL credentials refuse. It reads every
source blob under the existing limits before invoking the existing detached
worktree command plan. This is disposable construction custody under the
caller's existing scratch ownership, not institutional `sourceWorkingCopies`
admission, a branch allocation, or a new credential grant.

The returned frozen handle contains `kind: 'git.pinned-source-worktree'`,
`version: 1`, `repository`, `commit`, `directory`, `entries`, `verify()` and
`dispose()`. Entries retain the original pinned-reader shape
`{path,mode,bytes,source:{repository,commit,path,object}}`. No credential or
repository environment is returned. Verification retains independent digests;
mutating returned evidence cannot authorize altered source. `verify()` checks
the exact root/HEAD, native metadata and every authored byte/executable mode.
Additional untracked generated products are allowed, but their qualification
belongs to Code and the publication owner, not to Git.

Materialization uses an isolated environment without inherited credential,
configuration, Git-routing, hooks or filesystem-monitor settings. Native Git
must use the prefetched objects without lazy fetching. The original bytes-only
reader still does not checkout anything, and its existing behavior is unchanged.

Caller lifecycle: retain the handle through installation, declared production
and authored-source readback. Call `verify()` before Code's result is accepted.
A publisher may subsequently rewrite its carrier manifest; `dispose()` checks
physical/native Git identity rather than immutable authored bytes, so that
intentional packaging metadata does not prevent cleanup. The caller must first
establish that every producer/reader process has quiesced. An uncertain runner
must retain the handle and scratch for reconciliation, not call `dispose()`.
Disposal is single-flight/idempotent and removes only this handle's exact native
worktree. Changed root, Git binding, HEAD or routing refuses cleanup and retains
the affected state. It does not prune another worktree or destroy shared stores.
The outer source owner may remove its disposable scratch only after all handles
are disposed and no workers remain.

Native verification covers exact detached identity and dirty-original isolation,
source-byte drift, mutable evidence, unknown commits, unsupported links/Gitlinks,
redirected scratch/worktree/source, HEAD drift, byte limits, unsupported scope,
untracked generated products, intentional carrier rewrites and duplicate cleanup.
Publication consumers must migrate by selecting this explicit operation only for
supported native generation, and qualify the original produced artifact before
claiming delivered publication capability.

Configuration is an independent precondition, not inferred from byte equality:
store initialization uses an empty Git template. Before materialization, the
existing store's bounded regular local config is parsed without includes and
must contain only this owner's inert bare-store/object-format and exact origin
promisor settings. Includes, filters, worktree config, attributes-file overrides,
filesystem monitors, other routing settings and alternate/graft metadata refuse.
A filter could execute a side effect while returning identical bytes, so later
source hashing cannot substitute for this admission check. Held configuration
and native routing controls are rechecked before verification or disposal.
Verification also compares the native index's complete stage-zero path/mode/blob
inventory to the original commit, because Code's source reader depends on that
index remaining at HEAD. Untracked products remain allowed; a staged deletion
or replacement cannot pass merely because the working file still looks right.


### Source-only regular-file publication request

`readGitSourceTreePublicationRequest` reuses the exact-path/reviewedSource
decoder and additionally admits an explicit original GitHub name, stable node
identity, visibility and authenticated-account expectation, plus one exact
regular100644 output per selected path. Output bytes use canonical base64 and
explicit SHA-1 Gitblob and SHA-256 identities. Selected originals must be
regular100644 blobs or explicit absence. File and aggregate byte/population
limits apply before decoding. The publisher independently proves those byte
identities, original ownership, authority, audience and complete tree effects.
This decoder performs no Git or GitHub effects and grants no permission.

Source-only requests currently require a single-line commit message; native
publication retains its previous message behavior. The ordinary commit-paths
CLI awaits the same public source-only operation and does not discover a checkout
for an explicit sourceRepository request. A planned fresh cut qualifies current
selected preimages before it can report success.

Requirement refinement: the existing decoder and source-only publisher MUST preserve the actual authenticated principal type and identity, including a GitHub App installation and its original bot login. The original provider qualifies installation repository coverage and contents authority; human-only account syntax or viewerPermission is not an installation-authority check. Truthful authenticated-bot Git metadata with actual agent source-record authorship is permitted, without human impersonation or an exact Codex Git-name requirement. Existing finite positive-path, whole-byte, mode, preimage, complete-tree, CAS and replay guarantees remain binding. This is a source requirement, not implementation or admission; the [owning publisher requirement](https://github.com/red-cup-engineering/computer-systems-fabrication-engineering-services-section/blob/dfee760e74d62b30c19bc2ce02c9909a3ed65fce/data/records/service-records/requirements-management-service-records/source-only-git-publication-qualifies-installation-principals.json) retains the exact original source and provider observations.
