import {readEvidenceBoundImmediateTree} from './source-path-proof.mjs';
import {gitTreeIdOf} from './git-object-id.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const types={'040000':'tree','100644':'blob','100755':'blob','120000':'blob','160000':'commit'};
const leaf=value=>value&&types[value.mode]===value.type&&value.type!=='tree'&&oid(value.sha);
const same=(a,b)=>a?.mode===b?.mode&&a?.type===b?.type&&a?.sha===b?.sha;

/** Prove a complete source transformation through immediate trees, never a truncated recursive listing. */
export async function deriveSourceTreePatch({sourceTree,changes,readTree,maxTrees=200}={}) {
  if(!oid(sourceTree)||typeof readTree!=='function'
      ||!Array.isArray(changes)||!changes.length||changes.length>6000
      ||!Number.isSafeInteger(maxTrees)||maxTrees<1||maxTrees>10000)
    throw new TypeError('bounded immutable tree patch required');
  const root=new Map();
  for(const change of changes){
    const removal=Object.hasOwn(change,'remove');
    if(typeof change.path!=='string'||!change.path||/[\0\\]/.test(change.path)
        ||change.path.split('/').some(p=>!p||['.','..','.git'].includes(p.toLowerCase()))
        ||(removal ? !leaf(change.remove)||['mode','type','sha'].some(key=>Object.hasOwn(change,key)) : !leaf(change)))
      throw new TypeError('explicit source leaf replacement or exact removal required');
    let children=root;
    const parts=change.path.split('/');
    for(let i=0;i<parts.length;i++){
      const name=parts[i];let node=children.get(name);
      if(!node){node={children:new Map()};children.set(name,node);}
      if(node.entry||node.remove)throw new TypeError('duplicate or overlapping source changes');
      if(i===parts.length-1){
        if(node.children.size)throw new TypeError('overlapping source changes');
        if(removal)node.remove={...change.remove};
        else node.entry={mode:change.mode,type:change.type,sha:change.sha};
      }else children=node.children;
    }
  }
  const cache=new Map();let unchangedSubtrees=0;
  async function tree(sha){
    if(sha===undefined)return new Map();
    if(cache.has(sha))return cache.get(sha);
    if(cache.size===maxTrees)throw new RangeError('source tree proof exceeds its declared bound');
    const observed=await readTree(sha);
    // Reuse the shared cryptographic path-proof reader for each complete frame.
    readEvidenceBoundImmediateTree(observed,sha);
    const entries=new Map(observed.tree.map(row=>[row.path,{mode:row.mode,type:row.type,sha:row.sha}]));
    cache.set(sha,entries);return entries;
  }
  let changedLeaves=0;
  async function derive(beforeSha,expected,prefix=''){
    const before=await tree(beforeSha),after=new Map(before);
    for(const [name,entry] of before)if(!expected.has(name)&&entry.type==='tree')unchangedSubtrees++;
    for(const [name,change] of expected){
      const a=before.get(name),path=prefix+name;
      if(change.remove){
        if(!same(a,change.remove))throw new Error('source removal precondition differs: '+path);
        after.delete(name);changedLeaves++;
      }else if(change.entry){
        if(a&&(a.mode!==change.entry.mode||a.type!==change.entry.type))throw new Error('source kind or mode changes: '+path);
        if(!same(a,change.entry))changedLeaves++;
        after.set(name,change.entry);
      }else{
        if(a&&a.type!=='tree')throw new Error('source path is obstructed: '+path);
        const child=await derive(a?.sha,change.children,path+'/');
        // Only touched directories emptied by this transformation disappear.
        if(child.size===0)after.delete(name);
        else after.set(name,{mode:'040000',type:'tree',sha:child.sha});
      }
    }
    return {sha:gitTreeIdOf([...after].map(([name,row])=>({name,...row}))),size:after.size};
  }
  const {sha:targetTree}=await derive(sourceTree,root);
  return {kind:'git.source-tree-patch-plan',sourceTree,targetTree,declaredLeaves:changes.length,changedLeaves,
    immediateTrees:cache.size,unchangedSubtrees,completeTransformation:true,
    contentAssessed:false,capabilitiesReceived:false};
}

/** Independently compare the observed target root with the complete derived transformation. */
export async function proveSourceTreePatch(request={}) {
  if(!oid(request.targetTree))throw new TypeError('observed immutable target tree required');
  const plan=await deriveSourceTreePatch(request);
  if(plan.targetTree!==request.targetTree)throw new Error('target tree differs from the complete source transformation');
  return {...plan,kind:'git.source-tree-patch-proof'};
}
