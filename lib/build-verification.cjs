// Optional publication evidence. Runtime compatibility does not depend on it.
const SHA=/^[a-f0-9]{64}$/, COMMIT=/^[a-f0-9]{40}$/;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,names)=>plain(value)&&Object.keys(value).every(key=>names.includes(key));
function buildMetadata(value,repository){
 if(value===undefined)return undefined;
 if(!keys(value,['sourceRevision','workflow','runId','runAttempt','toolchain'])||!COMMIT.test(value.sourceRevision||'')||value.workflow!==repository+'/.github/workflows/runtime-build.yml'||
  ['runId','runAttempt'].some(key=>value[key]!==undefined&&!/^[1-9][0-9]{0,19}$/.test(value[key]))||
  value.toolchain!==undefined&&(!keys(value.toolchain,['node','zlib','clang','xcode','macosSDK'])||Object.values(value.toolchain).some(item=>typeof item!=='string'||item.length>1024)))throw Error('Invalid package build evidence.');
 return JSON.parse(JSON.stringify(value));
}
function rebuildMetadata(value,record){
 if(value===undefined)return undefined;
 if(!keys(value,['status','sourceRevision','originalSha256','rebuiltSha256','reportUrl','summary'])||!['match','different'].includes(value.status)||!COMMIT.test(value.sourceRevision||'')||
  !SHA.test(value.originalSha256||'')||!SHA.test(value.rebuiltSha256||'')||value.originalSha256!==record.asset.sha256||
  (value.status==='match')!==(value.originalSha256===value.rebuiltSha256)||record.build&&record.build.sourceRevision!==value.sourceRevision||
  typeof value.reportUrl!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*(?:\/artifacts\/[1-9][0-9]*)?$/.test(value.reportUrl)||
  value.summary!==undefined&&(typeof value.summary!=='string'||value.summary.length>1024))throw Error('Invalid package rebuild evidence.');
 return JSON.parse(JSON.stringify(value));
}
module.exports={buildMetadata,rebuildMetadata};
