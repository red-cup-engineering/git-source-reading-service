import test from 'node:test';
import assert from 'node:assert/strict';
import {gitBlobIdOf, gitTreeIdOf} from '@red-cup-engineering/git-source-reading-service/git-object-id';
import {readEvidenceBoundImmediateTree, readEvidenceBoundPathProof} from '@red-cup-engineering/git-source-reading-service/source-path-proof';

const blob = gitBlobIdOf(Buffer.from('claim: authoritative-source-only\n'));
const other = gitBlobIdOf(Buffer.from('frontmatter: testimony-not-grant\n'));
const child = [{path:'articulating.md',mode:'100644',type:'blob',sha:blob}];
const childSha = gitTreeIdOf(child.map(({path,mode,sha})=>({name:path,mode,sha})));
const vendorSha = 'c'.repeat(40);
const root = [
  {path:'docs',mode:'040000',type:'tree',sha:childSha},
  {path:'claim.md',mode:'100644',type:'blob',sha:other},
  {path:'vendor',mode:'160000',type:'commit',sha:vendorSha},
];
const rootSha = gitTreeIdOf(root.map(({path,mode,sha})=>({name:path,mode,sha})));
const tree = (sha, rows) => ({sha,truncated:false,tree:rows});
const rootTree = tree(rootSha,root), childTree = tree(childSha,child);
const commit = {sha:'f'.repeat(40),tree:{sha:rootSha}};
const read = (path,proof=[rootTree]) => readEvidenceBoundPathProof({commit,path,proof});

test('package exposes the existing Git path proof with an immediate-tree identity check', () => {
  const entries = readEvidenceBoundImmediateTree(rootTree,rootSha);
  assert.equal(entries.get('docs').sha,childSha);
  assert.deepEqual(read(''),{path:'',scope:'observed',entry:{mode:'040000',type:'tree',sha:rootSha}});
});

test('a nested articulated source path resolves to its exact blob, not a claim of truth', () => {
  assert.deepEqual(read('docs/articulating.md',[rootTree,childTree]),{
    path:'docs/articulating.md',scope:'observed',entry:{mode:'100644',type:'blob',sha:blob}
  });
  assert.equal(read('claim.md').entry.sha,other);
});

test('absence requires the full committed immediate parent, never an omitted subtree', () => {
  assert.deepEqual(read('docs/not-present.md',[rootTree,childTree]),{
    path:'docs/not-present.md',scope:'absent',entry:null
  });
  assert.deepEqual(read('no-such-folder/file.md'),{path:'no-such-folder/file.md',scope:'absent',entry:null});
  assert.throws(()=>read('docs/not-present.md',[rootTree]),TypeError);
});

test('a Gitlink is a separate unread repository, never missing source', () => {
  assert.deepEqual(read('vendor/module.md'),{
    path:'vendor/module.md',scope:'unread-gitlink',boundary:'vendor',
    entry:{mode:'160000',type:'commit',sha:vendorSha}
  });
});

test('a file cannot be traversed as a directory', () => {
  assert.deepEqual(read('claim.md/nested'),{
    path:'claim.md/nested',scope:'absent',entry:null,
    obstruction:{path:'claim.md',entry:{mode:'100644',type:'blob',sha:other}}
  });
});

test('tampered, truncated, duplicate, or falsely rooted evidence never proves a path', () => {
  assert.throws(()=>read('claim.md',[{...rootTree,truncated:true}]),TypeError);
  assert.throws(()=>read('claim.md',[{...rootTree,sha:'a'.repeat(40)}]),TypeError);
  assert.throws(()=>read('claim.md',[{...rootTree,tree:[...root,root[0]]}]),TypeError);
  assert.throws(()=>read('claim.md',[rootTree,childTree]),TypeError);
  assert.throws(()=>readEvidenceBoundPathProof({commit:{...commit,tree:{sha:'0'.repeat(40)}},path:'claim.md',proof:[rootTree]}),TypeError);
});

test('noncanonical and ambiguous source paths refuse rather than normalize', () => {
  for(const path of ['../claim.md','docs/../claim.md','docs/./articulating.md','docs//articulating.md',
    '/claim.md','docs/.git/HEAD','docs\\articulating.md','docs\0articulating.md']) {
    assert.throws(()=>read(path),TypeError,path);
  }
});
