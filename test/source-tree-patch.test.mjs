import test from 'node:test';
import assert from 'node:assert/strict';
import {gitTreeIdOf,gitBlobIdOf} from '../src/git-object-id.mjs';
import {deriveSourceTreePatch,proveSourceTreePatch} from '../src/source-tree-patch.mjs';
const blob=text=>({mode:'100644',type:'blob',sha:gitBlobIdOf(Buffer.from(text))});
const old=blob('old'),fresh=blob('new'),keep=blob('keep');
function fixture(){
  const frames=new Map();
  const tree=entries=>{const sha=gitTreeIdOf(entries.map(([name,row])=>({name,...row})));frames.set(sha,{sha,truncated:false,tree:entries.map(([path,row])=>({path,...row}))});return {mode:'040000',type:'tree',sha};};
  const nested=tree([['old',old]]),root=tree([['nested',nested],['keep',keep]]);
  return {frames,tree,sourceTree:root.sha,readTree:async sha=>frames.get(sha)};
}
test('exact removal prunes emptied touched directories and proves the whole root',async()=>{
  const f=fixture(),targetTree=f.tree([['keep',keep]]).sha;
  const result=await proveSourceTreePatch({...f,targetTree,changes:[{path:'nested/old',remove:old}]});
  assert.equal(result.changedLeaves,1);assert.equal(result.capabilitiesReceived,false);
  await assert.rejects(proveSourceTreePatch({...f,targetTree:f.sourceTree,changes:[{path:'nested/old',remove:old}]}),/differs/);
});
test('mixed replacement and removal preserve siblings and are order independent',async()=>{
  const f=fixture(),changes=[{path:'nested/old',remove:old},{path:'nested/new',...fresh}];
  const expected=f.tree([['nested',f.tree([['new',fresh]])],['keep',keep]]).sha;
  for(const rows of [changes,[...changes].reverse()])assert.equal((await deriveSourceTreePatch({...f,changes:rows})).targetTree,expected);
});
test('absent, stale, changed-mode and tree removals refuse',async()=>{
  const f=fixture();
  for(const change of [{path:'absent',remove:old},{path:'missing/old',remove:old},{path:'nested/old',remove:fresh},{path:'nested/old',remove:{...old,mode:'100755'}},{path:'nested',remove:{mode:'040000',type:'tree',sha:f.sourceTree}}])await assert.rejects(deriveSourceTreePatch({...f,changes:[change]}));
});
test('ambiguous, duplicate, overlapping and obstructed requests refuse',async()=>{
  const f=fixture(),remove={path:'nested/old',remove:old};
  for(const changes of [[{...remove,...old}],[remove,remove],[remove,{path:'nested',...fresh}],[{path:'keep/old',remove:old}],[{path:'../old',remove:old}]])await assert.rejects(deriveSourceTreePatch({...f,changes}));
});
test('root may become empty; untouched empty directories remain',async()=>{
  const f=fixture(),empty=f.tree([]),root=f.tree([['empty',empty],['old',old]]);
  assert.equal((await deriveSourceTreePatch({...f,sourceTree:root.sha,changes:[{path:'old',remove:old}]})).targetTree,f.tree([['empty',empty]]).sha);
  const only=f.tree([['old',old]]);
  assert.equal((await deriveSourceTreePatch({...f,sourceTree:only.sha,changes:[{path:'old',remove:old}]})).targetTree,empty.sha);
});
test('incomplete or forged tree evidence refuses before a proof',async()=>{
  const f=fixture();
  await assert.rejects(deriveSourceTreePatch({...f,changes:[{path:'nested/old',remove:old}],readTree:async sha=>({...f.frames.get(sha),truncated:true})}),/incomplete/);
  await assert.rejects(deriveSourceTreePatch({...f,changes:[{path:'nested/old',remove:old}],readTree:async sha=>({...f.frames.get(sha),tree:[]})}),/identity/);
});
