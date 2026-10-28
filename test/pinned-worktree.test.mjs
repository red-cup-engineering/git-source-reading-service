import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,rename,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPinnedSourceReader} from '../src/pinned-source-files.mjs';
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'native-pinned-worktree-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repository=join(root,'original');await mkdir(repository);git(repository,'init','-q');git(repository,'config','user.name','Fixture');git(repository,'config','user.email','fixture@example.invalid');
 await writeFile(join(repository,'package.json'),'{}\n');await writeFile(join(repository,'source.mjs'),'export const a = 1;\n');git(repository,'add','.');git(repository,'commit','-qm','Original');
 const commit=git(repository,'rev-parse','HEAD'),scratch=join(root,'scratch');
 const reader=createPinnedSourceReader({scratch});return {root,repository,commit,scratch,reader};
}
test('genuine detached root retains exact source, independent of dirty original, and disposes once',async t=>{
 const f=await fixture(t);await writeFile(join(f.repository,'source.mjs'),'dirty original');
 const held=await f.reader.materialize({repository:f.repository,commit:f.commit});
 assert.equal(git(held.directory,'rev-parse','HEAD'),f.commit);assert.equal(git(held.directory,'rev-parse','--show-toplevel'),held.directory);
 assert.equal((await held.verify()).files,2);assert.equal(await readFile(join(held.directory,'source.mjs'),'utf8'),'export const a = 1;\n');
 await writeFile(join(held.directory,'generated.mjs'),'generated');await held.verify();
 // Packaging may intentionally rewrite metadata after qualification; disposal checks physical and Git identity, not authored bytes.
 await writeFile(join(held.directory,'package.json'),'{"version":"1.0.0"}\n');
 await Promise.all([held.dispose(),held.dispose()]);await assert.rejects(readFile(join(held.directory,'source.mjs')),{code:'ENOENT'});
 assert.equal(await readFile(join(f.repository,'source.mjs'),'utf8'),'dirty original');await assert.rejects(held.verify(),/disposed/);
});
test('native materialization remains usable under a group-writable host umask',async t=>{
 const f=await fixture(t),previous=process.umask(0o002);t.after(()=>process.umask(previous));
 const held=await f.reader.materialize({repository:f.repository,commit:f.commit});
 assert.equal((await held.verify()).files,2);assert.equal(git(held.directory,'rev-parse','HEAD'),f.commit);
 await held.dispose();
});
test('mutating returned evidence cannot authorize changed source',async t=>{
 const f=await fixture(t),held=await f.reader.materialize({repository:f.repository,commit:f.commit});
 await writeFile(join(held.directory,'source.mjs'),'wrong');held.entries.find(x=>x.path==='source.mjs').bytes=Buffer.from('wrong');
 await assert.rejects(held.verify(),/authored source changed/);await held.dispose();
});
test('wrong commit refuses without a materialized copy',async t=>{
 const f=await fixture(t);await assert.rejects(f.reader.materialize({repository:f.repository,commit:'f'.repeat(40)}));
 assert(!(await readdir(f.scratch)).some(x=>x.startsWith('worktree-')));
});
test('committed symlink and Gitlink are outside version one',async t=>{
 for(const kind of ['symlink','gitlink']){const f=await fixture(t);
 if(kind==='symlink'){await symlink('source.mjs',join(f.repository,'link'));git(f.repository,'add','link');}
 else git(f.repository,'update-index','--add','--cacheinfo','160000,'+f.commit+',child');
 git(f.repository,'commit','-qm','Unsupported');await assert.rejects(f.reader.materialize({repository:f.repository,commit:git(f.repository,'rev-parse','HEAD')}),/complete regular root/);
 }
});
test('redirected scratch refuses before acquisition',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'elsewhere'));await symlink(join(f.root,'elsewhere'),f.scratch);
 await assert.rejects(f.reader.materialize({repository:f.repository,commit:f.commit}),/unredirected/);assert.deepEqual(await readdir(join(f.root,'elsewhere')),[]);
});
test('redirected source refuses verification and preserves foreign destination',async t=>{
 const f=await fixture(t),held=await f.reader.materialize({repository:f.repository,commit:f.commit});
 await rename(held.directory,held.directory+'-retained');await mkdir(join(f.root,'foreign'));await writeFile(join(f.root,'foreign','safe'),'retain');await symlink(join(f.root,'foreign'),held.directory);
 await assert.rejects(held.verify(),/custody changed/);await assert.rejects(held.dispose(),/custody changed/);assert.equal(await readFile(join(f.root,'foreign','safe'),'utf8'),'retain');
});
test('HEAD drift refuses verification and effectful disposal',async t=>{
 const f=await fixture(t),held=await f.reader.materialize({repository:f.repository,commit:f.commit});
 git(held.directory,'symbolic-ref','HEAD','refs/heads/other');await assert.rejects(held.verify(),/native identity changed/);await assert.rejects(held.dispose(),/native identity changed/);
 assert.equal(await readFile(join(held.directory,'package.json'),'utf8'),'{}\n');
});
test('path redirection refuses authored receiving',async t=>{
 const f=await fixture(t),held=await f.reader.materialize({repository:f.repository,commit:f.commit});await rm(join(held.directory,'source.mjs'));await symlink(join(f.repository,'source.mjs'),join(held.directory,'source.mjs'));
 await assert.rejects(held.verify(),/redirected/);await held.dispose();
});
test('source bounds and unsupported scope refuse',async t=>{
 const f=await fixture(t);await assert.rejects(createPinnedSourceReader({scratch:join(f.root,'small'),maxBytes:1}).materialize({repository:f.repository,commit:f.commit}),/byte bound/);
 await assert.rejects(f.reader.materialize({repository:f.repository,commit:f.commit,scope:'src'}),/repository and exact commit only/);
});
test('returned source credentials do not exist and native materialization drops acquisition-only environment',async t=>{
 const f=await fixture(t),bin=join(f.root,'bin');await mkdir(bin);
 const nativeGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
 const log=join(f.root,'worktree-environment'),traceLog=join(f.root,'git-trace-context');
 await writeFile(join(bin,'git'),`#!/bin/sh\nprintf '%s\\n' "\${TRACEPARENT-absent}" >> '${traceLog}'\ncase " $* " in *" worktree "*) printf '%s' "\${ACQUISITION_ONLY_SENTINEL-absent}" >> '${log}';; esac\nexec '${nativeGit}' "$@"\n`,{mode:0o755});
 const old=process.env.PATH;process.env.PATH=bin+':'+old;t.after(()=>{process.env.PATH=old;});
 const traceparent='00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
 const reader=createPinnedSourceReader({scratch:f.scratch,environmentForRepository:()=>({ACQUISITION_ONLY_SENTINEL:'private-acquisition-context',TRACEPARENT:traceparent})});
 const held=await reader.materialize({repository:f.repository,commit:f.commit});await held.dispose();
 assert.equal(await readFile(log,'utf8'),'absentabsent');assert.deepEqual(Object.keys(held).sort(),['commit','directory','dispose','entries','kind','repository','verify','version']);
 const traces=(await readFile(traceLog,'utf8')).trim().split('\n');assert.ok(traces.length>10);assert.ok(traces.every(value=>value===traceparent),'every native Git command keeps the selected source trace, including isolated reads');
});
test('redirected scratch parent creates nothing outside custody',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'outside'));await symlink(join(f.root,'outside'),join(f.root,'redirect'));
 const reader=createPinnedSourceReader({scratch:join(f.root,'redirect','scratch')});
 await assert.rejects(reader.materialize({repository:f.repository,commit:f.commit}),/unredirected/);assert.deepEqual(await readdir(join(f.root,'outside')),[]);
});
test('template-supplied smudge filter never executes even when it preserves source bytes',async t=>{
 const f=await fixture(t);await writeFile(join(f.repository,'.gitattributes'),'source.mjs filter=review\n');git(f.repository,'add','.');git(f.repository,'commit','-qm','Source attributes');
 const template=join(f.root,'template'),marker=join(f.root,'filter-executed');await mkdir(template);
 await writeFile(join(template,'config'),'[filter "review"]\n smudge = "touch '+marker+'; cat"\n');
 const reader=createPinnedSourceReader({scratch:f.scratch,environment:{GIT_TEMPLATE_DIR:template}}),held=await reader.materialize({repository:f.repository,commit:git(f.repository,'rev-parse','HEAD')});
 await held.verify();await assert.rejects(readFile(marker),{code:'ENOENT'});await held.dispose();
});
test('reused store with executable or redirected local configuration refuses before checkout',async t=>{
 for(const [key,value] of [['filter.review.smudge','touch marker; cat'],['include.path','/outside/config'],['includeIf.gitdir:/.path','/outside/config'],['extensions.worktreeConfig','true'],['core.attributesFile','/outside/attributes'],['core.worktree','/outside'],['core.fsmonitor','/outside/monitor']]){
  const f=await fixture(t);await f.reader({repository:f.repository,commit:f.commit,selectFile:()=>true,enterDirectory:()=>false});
  const stores=(await readdir(f.scratch)).filter(name=>name.endsWith('.git'));assert.equal(stores.length,1);
  git(join(f.scratch,stores[0]),'config',key,value);
  await assert.rejects(f.reader.materialize({repository:f.repository,commit:f.commit}),/configuration is not admitted/);
  assert(!(await readdir(f.scratch)).some(x=>x.startsWith('worktree-')));
 }
});
test('native index drift refuses even with identical authored working files',async t=>{
 const f=await fixture(t),held=await f.reader.materialize({repository:f.repository,commit:f.commit});
 git(held.directory,'update-index','--force-remove','source.mjs');await assert.rejects(held.verify(),/index differs/);
 await held.dispose();
});
