/** Plain Git source-value contracts. These values witness source; they grant no custody or office. */
const text = { type: "string", minLength: 1 };
const selection = {
  sourceRepository: { type: "string", format: "uri", pattern: "^(https|ssh|file)://", maxLength: 2048 },
  ref: { type: "string", pattern: "^refs/(heads|tags)/[^/]", maxLength: 1024, allOf: [
    { not: { pattern: "[\\u0000-\\u0020\\u007f~^:?*\\[\\\\]" } }, { not: { pattern: "\\.\\.|@\\{|//" } },
    { not: { pattern: "/\\." } }, { not: { pattern: "\\.lock(/|$)" } }, { not: { pattern: "[/.]$" } },
  ] },
  commit: { type: "string", pattern: "^([a-f0-9]{40}|[a-f0-9]{64})$" },
};
const entryIdentity = { type: "object", required: ["device", "inode"], additionalProperties: false, properties: { device: text, inode: text } };
export const gitSourceWorkingCopyRequestSchema = { type: "object", required: Object.keys(selection), additionalProperties: false, properties: selection };
export const gitSourceCustodySchema = {
  type: "object", required: ["id", "revision", "evidence", ...Object.keys(selection), "workspaceRoot"], additionalProperties: false,
  properties: { id: text, revision: text, evidence: { type: "array", minItems: 1, items: text }, ...selection, workspaceRoot: text, credentialService: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]*$" } },
};
export const gitSourceWorkingCopyBindingSchema = {
  type: "object", required: ["kind", "id", ...Object.keys(selection), "repository", "commonDirectory", "copyIdentity", "custody"], additionalProperties: false,
  properties: {
    kind: { const: "metroplat.git.source-working-copy" }, id: text, exactIdentity: text, ...selection, repository: text, commonDirectory: text,
    copyIdentity: { type: "object", required: ["repository", "commonDirectory"], additionalProperties: false, properties: { repository: entryIdentity, commonDirectory: entryIdentity } },
    custody: gitSourceCustodySchema,
  },
};
export const gitSourceClosureSchema = {
  $id: "metroplat/git/source-closure", type: "object", required: ["kind", "id", "exactIdentity", "copy", "composed"], additionalProperties: false,
  properties: {
    kind: { const: "metroplat.git.source-closure" }, id: text, exactIdentity: text, copy: gitSourceWorkingCopyBindingSchema,
    composed: { type: "array", maxItems: 128, items: { type: "object", required: ["path", "source"], additionalProperties: false, properties: { path: text, source: { $ref: "metroplat/git/source-closure" } } } },
  },
};

/** Host-produced source trace, not a worker's claim of acceptance or a new source permission. */
export const gitSourceResultSchema = {
  $id: "metroplat/git/source-result", type: "object", required: ["kind", "id", "exactIdentity", "sourceBinding", "phase", "entries"], additionalProperties: false,
  properties: {
    kind: { const: "metroplat.git.source-result" }, id: text, exactIdentity: text, sourceBinding: text, phase: { enum: ["prepared", "named", "unresolved"] },
    entries: { type: "array", maxItems: 128, items: {
      type: "object", required: ["path", "sourceRepository", "sourceBase", "commit", "branch", "state"], additionalProperties: false,
      properties: {
        path: { type: "string" }, sourceRepository: text, sourceBase: selection.commit, commit: selection.commit, branch: text,
        state: { enum: ["unchanged", "pending", "named"] },
        candidate: { type: "object", required: ["name", "commit", "ref", "repository", "pullRequest"], additionalProperties: false,
          properties: { name: text, commit: selection.commit, ref: text, repository: text, pullRequest: { type: "string", format: "uri" } } },
      },
    } },
  },
};
