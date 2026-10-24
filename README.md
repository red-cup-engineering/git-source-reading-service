# Git source reading

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
The caller owns absolute disposable scratch and repository credentials. This API
grants no access, installation, publication or branch-selection authority.

The exact-commit reader supports full lowercase SHA-1 (40 hexadecimal characters)
and SHA-256 (64 hexadecimal characters) identities. Each disposable object store
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
