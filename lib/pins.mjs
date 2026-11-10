import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
/** The commit a Builds Gitlink path records. */
export const gitlink=(directory,repository=root)=>execFileSync('git',['-C',repository,'rev-parse','HEAD:'+directory],{encoding:'utf8'}).trim();
/** A source record pins its source in one of two ways: `revision`, the exact
 * 40-character commit, or `gitlink`, the path of the submodule whose recorded
 * commit is the pin. It names exactly one of them. */
export function sourceRecordProblem(record){
 if(!record||typeof record!=='object'||Array.isArray(record))return 'A source record is an object.';
 if(Object.hasOwn(record,'commit'))return 'A source record names its exact commit as revision.';
 const kinds=['revision','gitlink'].filter(key=>Object.hasOwn(record,key));
 if(kinds.length!==1)return 'A source record names exactly one of revision or gitlink.';
 if(kinds[0]==='revision'&&(typeof record.revision!=='string'||!/^[a-f0-9]{40}$/.test(record.revision)))return 'A source record revision is an exact 40-character commit.';
 if(kinds[0]==='gitlink'&&(typeof record.gitlink!=='string'||!record.gitlink))return 'A source record gitlink is a submodule path.';
 return null;
}
/** The exact revision of a source record. This is the one reader of its pin; the
 * build-input resolver validated the record, so reading does not check it again. */
export function sourceRevision(record,repository=root,gitlinks){
 return record.revision??gitlinks?.get(record.gitlink)??gitlink(record.gitlink,repository);
}
/** Every Gitlink path a repository's HEAD records, with its commit, from one tree listing; a caller
 * resolving many records passes it to sourceRevision. */
export function gitlinkRevisions(repository=root){
 const revisions=new Map();
 for(const entry of execFileSync('git',['-C',repository,'ls-tree','-r','-z','--full-tree','HEAD'],{encoding:'utf8',maxBuffer:1<<28}).split('\0'))
  if(entry.startsWith('160000 commit ')){const tab=entry.indexOf('\t');revisions.set(entry.slice(tab+1),entry.slice(14,tab));}
 return revisions;
}
/** The provenance a payload records for a source: the record with its exact
 * revision, naming a gitlink record's checkout as path. */
export function sourceProvenance(record,repository=root){
 const revision=sourceRevision(record,repository);
 return Object.fromEntries([...Object.entries(record).map(([key,value])=>[key==='gitlink'?'path':key,value]),['revision',revision]]);
}
/** A source record that names an archive digest, {repository, revision, archive: {sha256}}, is a
 * source archive input: its GitHub repository's archive of that exact revision. The resolver lists
 * it in the build definition, the input step fetches it before compilation and the recipe reads the
 * fetched bytes through buildInput. */
export function sourceArchive(record){
 return {url:record.repository.replace(/\.git$/,'')+'/archive/'+record.revision+'.tar.gz',sha256:record.archive.sha256};
}
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),https=value=>typeof value==='string'&&/^https:\/\/[^\s]+$/.test(value),size=value=>Number.isSafeInteger(value)&&value>0?value:undefined;
/** The archive an archive record names, or undefined. Its forms: a source archive record (above);
 * {url, sha256} with bytes or size, and with offset for that byte range of url; {url, sha512} when the
 * publisher states only that digest; a shared dependency record {repository, revision or gitlink,
 * sha256} without url, whose archive is the repository's archive of that revision (a gitlink's revision
 * comes from the gitlinks map, path to commit); {archiveUrl, archiveSha256} with archiveBytes, where
 * {revision} in archiveUrl stands for the record's revision; and a GitHub release asset {repository,
 * version, asset, sha256}. The resolver lists the archive records a build's archive pins select, the
 * input step fetches each once before compilation, and a recipe reads the fetched bytes through buildInput. */
export function archiveInput(record,gitlinks){
 if(!record||typeof record!=='object'||Array.isArray(record))return undefined;
 if(typeof record.revision==='string'&&digest(record.archive?.sha256))return sourceArchive(record);
 if(https(record.url)&&record.sha256===undefined&&/^[a-f0-9]{128}$/.test(record.sha512||'')&&record.offset===undefined){const bytes=size(record.bytes??record.size);return {url:record.url,sha512:record.sha512,...(bytes?{bytes}:{})};}
 if(https(record.url)&&digest(record.sha256)){
  const bytes=size(record.bytes??record.size);
  if(record.offset===undefined)return {url:record.url,sha256:record.sha256,...(bytes?{bytes}:{})};
  if(Number.isSafeInteger(record.offset)&&record.offset>=0&&bytes)return {url:record.url,sha256:record.sha256,bytes,headers:{Range:'bytes='+record.offset+'-'+(record.offset+bytes-1)}};
  return undefined;
 }
 const revision=typeof record.revision==='string'?record.revision:typeof record.gitlink==='string'?gitlinks?.get(record.gitlink):undefined;
 if(https(record.repository)&&/^[a-f0-9]{40}$/.test(revision||'')&&digest(record.sha256)&&record.url===undefined&&record.path===undefined){const bytes=size(record.bytes);return {url:record.repository.replace(/\.git$/,'')+'/archive/'+revision+'.tar.gz',sha256:record.sha256,...(bytes?{bytes}:{})};}
 if(https(record.archiveUrl)&&digest(record.archiveSha256)){const bytes=size(record.archiveBytes),url=typeof record.revision==='string'?record.archiveUrl.replaceAll('{revision}',record.revision):record.archiveUrl;return url.includes('{')?undefined:{url,sha256:record.archiveSha256,...(bytes?{bytes}:{})};}
 if(/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(record.repository||'')&&typeof record.version==='string'&&typeof record.asset==='string'&&!record.asset.includes('/')&&digest(record.sha256))
  return {url:record.repository+'/releases/download/'+record.version+'/'+record.asset,sha256:record.sha256};
 return undefined;
}
/** The Builds checkout path that a gitlink source record names. */
export function sourceCheckout(record){
 return record.gitlink;
}
