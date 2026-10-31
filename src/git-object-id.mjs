/** Git object identity, computed without a git process. */
import { createHash } from "node:crypto";

/** The git blob id of some bytes: the address git gives the same content in any repository. */
export const gitBlobIdOf = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** Native SHA-1 Git tree identity for immediate entries, independent of input order. */
export function gitTreeIdOf(entries) {
  if (!Array.isArray(entries)) throw new TypeError('Git tree entries must be an array');
  const names = new Set();
  const rows = entries.map(({name, mode, sha}) => {
    if (typeof name !== 'string' || !name || /[\0/]/u.test(name) || ['.', '..'].includes(name)
        || names.has(name) || !['040000', '100644', '100755', '120000', '160000'].includes(mode)
        || !/^[0-9a-f]{40}$/u.test(sha ?? '')) throw new TypeError('invalid immediate Git tree entry');
    names.add(name);
    const encoded = Buffer.from(name, 'utf8');
    if (encoded.toString('utf8') !== name) throw new TypeError('Git tree name is not UTF-8');
    return {key:Buffer.concat([encoded, mode === '040000' ? Buffer.from('/') : Buffer.alloc(0)]),
      bytes:Buffer.concat([Buffer.from(`${mode === '040000' ? '40000' : mode} ${name}\0`), Buffer.from(sha, 'hex')])};
  });
  const bytes = Buffer.concat(rows.sort((a,b) => Buffer.compare(a.key,b.key)).map(row => row.bytes));
  return createHash('sha1').update(`tree ${bytes.length}\0`).update(bytes).digest('hex');
}
