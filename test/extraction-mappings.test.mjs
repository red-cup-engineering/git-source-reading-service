import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gitExtractionPlan} from '../src/git-command-codec.mjs';
const git=(cwd,args)=>execFileSync('git',['-c','user.name=Extraction assay','-c','user.email=assay@example.invalid','-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
test('extract exact evidence-file history without its unrelated former siblings',t=>{
 const root=mkdtempSync(join(tmpdir(),'git-path-extraction-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'source'),target=join(root,'child');mkdirSync(join(source,'old'),{recursive:true});git(source,['init','-q','--initial-branch=main']);
 writeFileSync(join(source,'old/evidence.json'),'first\n');writeFileSync(join(source,'old/unrelated.txt'),'retained in original\n');git(source,['add','.']);git(source,['commit','-qm','Original evidence']);
 writeFileSync(join(source,'old/evidence.json'),'second\n');git(source,['add','old/evidence.json']);git(source,['commit','-qm','Correct evidence']);
 git(root,gitExtractionPlan.cloneShared(source,target).arguments);
 git(target,gitExtractionPlan.rewriteMappings([{from:'old/evidence.json',to:'data/records/evidence.json',kind:'file'}]).arguments);
 assert.equal(readFileSync(join(target,'data/records/evidence.json'),'utf8'),'second\n');assert.equal(existsSync(join(target,'old/unrelated.txt')),false);
 assert.equal(git(target,['rev-list','--count','HEAD']).trim(),'2');assert.equal(readFileSync(join(source,'old/unrelated.txt'),'utf8'),'retained in original\n');
});
test('directory extraction preserves the established root-flattening convention',()=>{
 assert.deepEqual(gitExtractionPlan.rewriteMappings([{from:'subject'}]).arguments,['filter-repo','--force','--quiet','--path','subject/','--path-rename','subject/:']);
});
test('invalid, duplicate and escaping mappings refuse before producing a Git command',()=>{
 for(const mappings of [[],[{from:'../outside'}],[{from:'a',kind:'file'}],[{from:'a'},{from:'a'}],[{from:'a',to:'../escape'}]])assert.throws(()=>gitExtractionPlan.rewriteMappings(mappings));
});
