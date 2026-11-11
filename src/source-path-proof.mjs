import {gitBlobIdOf,gitCommitIdOf,gitTreeIdOf} from './git-object-id.mjs';

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
/** Bind a pinned commit to its root tree by hashing the raw commit object, so a path proof
 *  starts at the commit a reader selected and takes no tree identity on trust. */
export function readEvidenceBoundCommit({sha,object}={}) {
  if(!/^[a-f0-9]{40}$/u.test(sha??'')||!(object instanceof Uint8Array)||object.length>1024*1024)
    throw new TypeError('pinned commit and its raw object required');
  if(gitCommitIdOf(object)!==sha)throw new TypeError('commit object does not match its pinned identity');
  const tree=/^tree ([a-f0-9]{40})\n/u.exec(Buffer.from(object.subarray(0,46)).toString('latin1'))?.[1];
  if(!tree)throw new TypeError('commit object does not open with its root tree');
  return {sha,tree:{sha:tree}};
}
/** Verify bytes as the regular file at a path of a pinned commit: the commit object, each
 *  immediate tree down the path, the blob, then the bytes. Reads no repository, so bytes
 *  received from a registry archive can be checked where their repository cannot be read. */
export function readEvidenceBoundSourceMember({commit,path,proof,bytes}={}) {
  if(!(bytes instanceof Uint8Array)||typeof path!=='string'||!path)
    throw new TypeError('source member path and bytes required');
  const bound=readEvidenceBoundCommit(commit);
  const reading=readEvidenceBoundPathProof({commit:bound,path,proof});
  if(reading.scope!=='observed'||!['100644','100755'].includes(reading.entry.mode))
    throw new TypeError('path proof does not reach a regular file');
  if(gitBlobIdOf(bytes)!==reading.entry.sha)
    throw new TypeError('bytes are not the blob at that path of the pinned commit');
  return {commit:bound.sha,tree:bound.tree.sha,path,mode:reading.entry.mode,blob:reading.entry.sha};
}
