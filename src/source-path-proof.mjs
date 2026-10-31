import {gitTreeIdOf} from './git-object-id.mjs';

const types={'040000':'tree','100644':'blob','100755':'blob','120000':'blob','160000':'commit'};
/** Validate an immediate tree against its native Git identity. */
export function readEvidenceBoundImmediateTree(node,expected=node?.sha) {
  if(!/^[a-f0-9]{40}$/.test(expected??'')||node?.sha!==expected||node.truncated!==false
      ||!Array.isArray(node.tree)||node.tree.length>100000)
    throw new TypeError('path proof has an incomplete or unbound immediate tree');
  const entries=new Map();
  for(const row of node.tree){
    if(typeof row.path!=='string'||!row.path||row.path.includes('/')||entries.has(row.path)||types[row.mode]!==row.type)
      throw new TypeError('invalid immediate path-proof entry');
    entries.set(row.path,row);
  }
  if(gitTreeIdOf(node.tree.map(row=>({name:row.path,mode:row.mode,sha:row.sha})))!==expected)
    throw new TypeError('immediate tree does not match its observed identity');
  return entries;
}
/** Verify a selected location through complete immediate trees, starting at its commit root. */
export function readEvidenceBoundPathProof({commit,path,proof}={}) {
  if(!/^[a-f0-9]{40}$/u.test(commit?.sha??'')||!/^[a-f0-9]{40}$/u.test(commit?.tree?.sha??'')||
    typeof path!=='string'||(path&&path.split('/').some(p=>!p||['.','..','.git'].includes(p)))||
    /[\0\\]/u.test(path)||!Array.isArray(proof))throw new TypeError('immutable path proof required');
  const parts=path?path.split('/'):[],root=commit.tree.sha;
  let expected=root;
  for(let index=0;index<Math.max(parts.length,1);index++){
    const node=proof[index];
    const entries=readEvidenceBoundImmediateTree(node,expected);
    const finish=reading=>{
      if(proof.length!==index+1)throw new TypeError('path proof has unconsumed trees');
      return {path,...reading};
    };
    if(!parts.length)return finish({scope:'observed',entry:{mode:'040000',type:'tree',sha:root}});
    const row=entries.get(parts[index]);
    if(!row)return finish({scope:'absent',entry:null});
    const entry={mode:row.mode,type:row.type,sha:row.sha};
    if(index===parts.length-1)return finish({scope:'observed',entry});
    if(row.type==='commit')return finish({scope:'unread-gitlink',boundary:parts.slice(0,index+1).join('/'),entry});
    if(row.type!=='tree')return finish({scope:'absent',entry:null,
      obstruction:{path:parts.slice(0,index+1).join('/'),entry}});
    expected=row.sha;
  }
  throw new TypeError('path proof did not terminate');
}
