import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack,verify,publicDeclaration} from './runtime-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {releaseVersion,buildReleaseVersion} from '../lib/package-version.mjs';
import {buildToolchain} from '../lib/reproducible-build.mjs';
import {assetName,releaseTag,releaseRecord,identity} from '../lib/project-identity.mjs';
const require=createRequire(import.meta.url),A=require('../lib/archive.cjs');
const root=path.resolve(import.meta.dirname,'..');
const json=value=>JSON.stringify(value,null,2)+'\n';
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const read=file=>JSON.parse(fs.readFileSync(file));
function regular(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Error('Release assets must be regular files.');return s;}
export function recordFromDeclaration(d,asset,sourceAsset,source,catalogRecord={}){
 // Catalog metadata is validated by releaseRecord before this reconstruction.
 // Sealed declaration and archive facts always replace catalog payload fields.
 const {tag,asset:catalogAsset,source:catalogSource,sourceAsset:catalogSourceAsset,dependencies:catalogDependencies,launcherContract,...metadata}=catalogRecord;
 return {...metadata,schemaVersion:2,id:d.id,version:d.version,arch:d.arch,launcherArchitectures:d.launcherArchitectures,minimumMacOS:d.minimumMacOS,manifestRelative:d.manifestRelative,manifestSha256:d.manifestSha256,sourceSha256:d.sourceSha256,updatePolicy:'manual',asset,...(launcherContract===undefined?{}:{launcherContract}),...(d.dependencies?.length?{dependencies:d.dependencies}:{}),...(sourceAsset?{sourceAsset}:{}),...(source?{source}:{})};
}
async function asset(directory,name,role){const file=path.join(directory,name);return {filename:name,role,sha256:await A.checksum(file),bytes:regular(file).size};}
/** Package a new sealed build. Publication state is not a build input. */
export async function prepareRelease({project,input,declaration,sourceRevision,output,reports,directory=root}){
 const registration=resolveProject(project,directory,{resolvePins:false}),repo=registration.releaseRepository;
 if(!input||!declaration||!output||fs.existsSync(output))throw Error('Preparation needs sealed input, a declaration and a new output directory.');
 declaration=publicDeclaration(declaration);if(declaration.id!==project)throw Error('Declaration belongs to another project.');
 buildReleaseVersion(project,declaration.version,directory);
 const parent=path.dirname(path.resolve(output));fs.mkdirSync(parent,{recursive:true});const staging=fs.mkdtempSync(path.join(parent,'.release-'));
 try{
  const archive=path.join(staging,assetName(declaration)),record=await pack({project,input,declaration,output:archive,directory});
  if(sourceRevision)record.build={sourceRevision,workflow:repo+'/.github/workflows/runtime-build.yml',toolchain:buildToolchain(),...(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY===repo?{runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT}:{})};
  const source=sourceRevision?{repository:repo,revision:sourceRevision}:registration.producer.source;if(source)record.source=source;
  if(reports)for(const name of ['build-definition.json','build-inputs.json']){const file=path.join(reports,name);regular(file);fs.copyFileSync(file,path.join(staging,name),fs.constants.COPYFILE_EXCL);}
  fs.writeFileSync(archive+'.json',json(record));fs.renameSync(staging,path.resolve(output));return {schemaVersion:1,repository:repo,id:record.id,version:record.version,arch:record.arch,tag:releaseTag(record),assets:[await asset(output,path.basename(archive),'runtime'),await asset(output,path.basename(archive)+'.json','record')]};
 }finally{fs.rmSync(staging,{recursive:true,force:true});}
}

/** Verify downloaded release assets without executing runtime contents. */
export async function verifyRelease({bundle,project,version,arch,includeDeclaration=false,includeMetadata=false,directory=root}){
 const sidecars=fs.readdirSync(bundle).filter(name=>name.endsWith('.tar.gz.json'));if(sidecars.length!==1)throw Error('Select a directory containing exactly one runtime archive and its package record.');
 const record=read(path.join(bundle,sidecars[0]));identity(record);const registration=resolveProject(record.id,directory,{resolvePins:false}),repo=registration.releaseRepository;releaseRecord(record,{project:record.id,repository:repo});
 if(project&&record.id!==project||version&&record.version!==version||arch&&record.arch!==arch)throw Error('Release metadata differs from the selected project, version or architecture.');
 releaseVersion(record.id,record.version,directory);
 const name=assetName(record);if(sidecars[0]!==name+'.json')throw Error('Release asset belongs to a different project or version.');
 const runtime=path.join(bundle,name);if(regular(runtime).size!==record.asset.bytes)throw Error('Release asset checksum or size changed.');
 const checked=await verify({archive:runtime,sha256:record.asset.sha256,project:record.id,version:record.version,arch:record.arch,includeDeclaration:true,includeMetadata});
 const expected=recordFromDeclaration(checked.declaration,{filename:name,sha256:record.asset.sha256,bytes:record.asset.bytes},record.sourceAsset,record.source,record);
 if(stable(record)!==stable(expected))throw Error('Release record differs from the sealed runtime archive.');
 const assets=[await asset(bundle,name,'runtime'),await asset(bundle,name+'.json','record')];
 return {definitionDigest:fs.existsSync(path.join(bundle,'build-definition.json'))?await A.checksum(path.join(bundle,'build-definition.json')):undefined,release:{schemaVersion:1,repository:repo,id:record.id,version:record.version,arch:record.arch,tag:releaseTag(record),assets},record,...(includeDeclaration?{declaration:checked.declaration}:{}),...(includeMetadata?{metadata:checked.metadata}:{})};
}

function options(args){const result={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!args[i+1]||Object.hasOwn(result,key))throw Error('Use unique --option value pairs.');result[key]=args[i+1];}return result;}
export async function main([command,...args],directory=root){
 const o=options(args),allowed={prepare:['project','input','declaration','source-revision','output','reports'],verify:['bundle','project','version','arch']}[command];
 if(!allowed||Object.keys(o).some(k=>!allowed.includes(k)))throw Error('Use prepare or verify with explicit options.');
 if(command==='prepare'){
  if(!o.project||!o.output)throw Error('prepare requires --project and --output.');
  if(o.declaration){let d=read(o.declaration);if(Array.isArray(d)){d=d.filter(item=>item.id===o.project);if(d.length!==1)throw Error('Declaration must select exactly one project.');d=d[0];}o.declaration=d;}
  const {'source-revision':sourceRevision,...selected}=o;return prepareRelease({...selected,sourceRevision,directory});
 }
 if(command==='verify')return verifyRelease({...o,directory});

}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
