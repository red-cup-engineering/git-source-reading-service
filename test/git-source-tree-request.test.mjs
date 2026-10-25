import assert from 'node:assert/strict';
import test from 'node:test';
import {readGitSourceTreePublicationRequest} from '../src/git-command-codec.mjs';

const request=()=>({sourceRepository:{nameWithOwner:'owner/repository',id:'R_original',visibility:'PRIVATE',account:'operator'},
  paths:['docs/readme.md'],message:'Admit exact source bytes',push:true,
  reviewedSource:{revision:'a'.repeat(40),entries:[{path:'docs/readme.md',absent:true}]},
  outputs:[{path:'docs/readme.md',mode:'100644',bytesBase64:'',sha:'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}]});

test('source-only request preserves and freezes exact owner, lease and regular bytes',()=>{
  const input=request(),decoded=readGitSourceTreePublicationRequest(input);
  assert.deepEqual(decoded.sourceRepository,input.sourceRepository);assert.deepEqual(decoded.outputs,input.outputs);
  assert.equal(decoded.dryRun,false);assert.ok(Object.isFrozen(decoded.outputs[0]));
  input.sourceRepository.id='R_other';input.outputs[0].bytesBase64='YWJj';
  assert.equal(decoded.sourceRepository.id,'R_original');assert.equal(decoded.outputs[0].bytesBase64,'');
});

test('source-only requests refuse missing authority/audience, foreign output and categorical edits',()=>{
  for(const change of [r=>delete r.sourceRepository.account,r=>r.sourceRepository.visibility='latest',r=>r.sourceRepository.id='',
    r=>r.sourceRepository.nameWithOwner='../repo',r=>r.outputs[0].path='foreign',r=>r.outputs[0].mode='100755',
    r=>r.outputs[0].absent=true,r=>r.outputs[0].bytesBase64='AB==',r=>r.outputs[0].sha256='bad',
    r=>r.outputs.push({...r.outputs[0]}),r=>r.reviewedSource.entries=[{path:'docs/readme.md',mode:'120000',type:'blob',sha:'b'.repeat(40)}],
    r=>delete r.reviewedSource,r=>r.push=false]) {
    const input=request();change(input);assert.throws(()=>readGitSourceTreePublicationRequest(input),TypeError);
  }
});

test('source-only requests refuse oversized outputs before allocating decoded bytes',()=>{
  const input=request();input.outputs[0].bytesBase64='A'.repeat(2796208);
  assert.throws(()=>readGitSourceTreePublicationRequest(input),/bounded/u);
});


test('source-only multiline message refuses before a commit can normalize its bytes',()=>{
  const input=request();input.message='Headline\nBody';
  assert.throws(()=>readGitSourceTreePublicationRequest(input),/single-line/u);
});
