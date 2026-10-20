import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepositorySourceFiles } from '../src/read-source-files.mjs';

test('unchanged root API reads authored working-copy files without committed-only substitution', async t => {
 const root=await mkdtemp(join(tmpdir(),'primitive-source-root-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 git('init','-q'); git('config','user.name','Source reader'); git('config','user.email','source@example.invalid');
 await writeFile(join(root,'package.json'),'{}\n'); git('add','.'); git('commit','-qm','Original');
 const commit=git('rev-parse','HEAD');
 await mkdir(join(root,'selected')); await writeFile(join(root,'selected/package.json'),'dirty authored source\n');
 const files=await readRepositorySourceFiles({repository:root,filename:'package.json',scope:'selected'});
 assert.deepEqual(files,[{path:'selected/package.json',raw:'dirty authored source\n',source:{kind:'working-copy',repository:root,commit}}]);
 assert.deepEqual(await readRepositorySourceFiles({repository:root,filename:'package.json',scope:'selected',skipDirectories:['selected']}),[]);
 await assert.rejects(readRepositorySourceFiles({repository:root,filename:'package.json',scope:'../outside'}),/repository-relative/);
 await assert.rejects(readRepositorySourceFiles({repository:root,filename:'package.json',maxRepositories:0}),/bounded/);
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
 assert.deepEqual(manifest.dependencies??{},{});
});
