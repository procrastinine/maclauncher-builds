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
export function sourceRevision(record,repository=root){
 return record.revision??gitlink(record.gitlink,repository);
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
/** The Builds checkout path that a gitlink source record names. */
export function sourceCheckout(record){
 return record.gitlink;
}
