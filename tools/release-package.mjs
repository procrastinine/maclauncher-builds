import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {pack,verify,catalog,publicDeclaration} from './runtime-package.mjs';
import {resolveProject,readProjects} from '../lib/projects.mjs';
import {releaseVersion,buildReleaseVersion} from '../lib/package-version.mjs';
import {sourceDateEpoch,buildToolchain} from '../lib/reproducible-build.mjs';
import {assetName,releaseTag,releaseRecord,validateCatalog,identity} from '../lib/project-identity.mjs';
const require=createRequire(import.meta.url),A=require('../lib/archive.cjs'),B=require('../lib/bundled-native.cjs');
import {managerDeclaration} from './manager-declaration.mjs';
const root=path.resolve(import.meta.dirname,'..');
const json=value=>JSON.stringify(value,null,2)+'\n';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const read=file=>JSON.parse(fs.readFileSync(file));
function regular(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Error('Release assets must be regular files.');return s;}
function copy(input,output){regular(input);fs.copyFileSync(input,output,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);}
function sourceRecord(d,repo){if(!d.sourceArtifact)return undefined;const source=d.sourceArtifact,filename=path.posix.basename(source.directoryRelative);return {filename,url:'https://github.com/'+repo+'/releases/download/'+encodeURIComponent(releaseTag(d))+'/'+filename,sha256:source.sha256,bytes:source.bytes};}
export function recordFromDeclaration(d,asset,sourceAsset,source,catalogRecord={}){
 // Catalog metadata is validated by releaseRecord before this reconstruction.
 // Sealed declaration and archive facts always replace catalog payload fields.
 const {tag,asset:catalogAsset,source:catalogSource,sourceAsset:catalogSourceAsset,dependencies:catalogDependencies,launcherContract,...metadata}=catalogRecord;
 return {...metadata,schemaVersion:2,id:d.id,version:d.version,arch:d.arch,launcherArchitectures:d.launcherArchitectures,minimumMacOS:d.minimumMacOS,manifestRelative:d.manifestRelative,manifestSha256:d.manifestSha256,sourceSha256:d.sourceSha256,updatePolicy:'manual',asset,...(d.aliases||d.dependencies?.length?{launcherContract:2}:launcherContract===undefined?{}:{launcherContract}),...(d.dependencies?.length?{dependencies:d.dependencies}:{}),...(sourceAsset?{sourceAsset}:{}),...(source?{source}:{})};
}
async function asset(directory,name,role){const file=path.join(directory,name);return {filename:name,role,sha256:await A.checksum(file),bytes:regular(file).size};}
function write(file,value){fs.writeFileSync(file,json(value),{flag:'wx'});}
function loadPrevious(project,directory){const file=path.join(directory,'catalogs',project+'.json');return fs.existsSync(file)?read(file):undefined;}
/** Prepare one release from sealed files or an already packed archive. No build or network call occurs. */
export async function prepareRelease({project,input,declaration,archive,record,source,sourceRevision,output,directory=root}){
 const registration=resolveProject(project,directory,{resolvePins:false}),repo=registration.releaseRepository;
 const legacySourceAsset=record?.sourceAsset;
 const sourcePointer=record?.source||(sourceRevision?{repository:repo,revision:sourceRevision}:registration.producer.source);
 if(!output)throw Error('Choose a release output directory.');
 if(fs.existsSync(output)){
  if(!archive||!record)throw Error('Choose a new release output directory.');
  const existing=await verifyRelease({bundle:output,directory});
  releaseRecord(record,{project,repository:repo});
  if(stable(catalog([record],{project,repository:repo,directory}).packages[0])!==stable(catalog([existing.record],{project,repository:repo,directory}).packages[0])||regular(archive).size!==record.asset.bytes||await A.checksum(archive)!==record.asset.sha256)throw Error('Existing release output differs from the selected record.');
  return {...existing.release,existing:true};
 }
 if(archive?(!record||input||declaration):(!input||record))throw Error('Select sealed --input and --declaration, or existing --archive and --record.');
 if(!archive){declaration??=await managerDeclaration({project,input,source});declaration=publicDeclaration(declaration);if(declaration.id!==project)throw Error('Declaration belongs to another project.');}
 else releaseRecord(record,{project,repository:repo});
 const selected=archive?record:declaration;
 buildReleaseVersion(project,selected.version,directory);
 const previous=loadPrevious(project,directory);
 const parent=path.dirname(path.resolve(output));fs.mkdirSync(parent,{recursive:true});
 const staging=fs.mkdtempSync(path.join(parent,'.release-'));
 try{
  const name=assetName(selected),archivePath=path.join(staging,name);
  if(archive){copy(archive,archivePath);const checked=await verify({archive:archivePath,sha256:record.asset.sha256,project,version:record.version,arch:record.arch,includeDeclaration:true});declaration=checked.declaration;
   const expected=recordFromDeclaration(declaration,{filename:name,sha256:record.asset.sha256,bytes:regular(archivePath).size},undefined,undefined,record);
   if(stable({...record,tag:undefined,sourceAsset:undefined,source:undefined,asset:{...record.asset,url:undefined}})!==stable(expected))throw Error('Release record differs from the sealed runtime archive.');
   record=expected;write(archivePath+'.json',record);
  }else record=await pack({project,input,declaration,output:archivePath,sourceDateEpoch:sourceRevision?sourceDateEpoch(directory,sourceRevision):0,directory});
  if(!archive&&sourceRevision){
   record.build={sourceRevision,workflow:repo+'/.github/workflows/runtime-build.yml',toolchain:buildToolchain(),
    ...(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY===repo?{runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT}:{})};
  }
  if(sourcePointer)record.source=sourcePointer;
  if(legacySourceAsset)record.sourceAsset=legacySourceAsset;
  fs.writeFileSync(archivePath+'.json',json(record));
  const next=catalog([record],{project,repository:repo,previous,directory});
  write(path.join(staging,project+'.json'),next);
  if(declaration.sourceArtifact&&source){
   const expected=declaration.sourceArtifact;
   if(regular(source).size!==expected.bytes||await A.checksum(source)!==expected.sha256)throw Error('Corresponding-source archive differs from its sealed identity.');
   const sourceName=path.posix.basename(expected.directoryRelative);copy(source,path.join(staging,sourceName));
  }else if(source)throw Error('The declaration already includes its corresponding sources.');
  const checked=await verifyRelease({bundle:staging,directory});fs.renameSync(staging,path.resolve(output));return checked.release;
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
 const snapshot=validateCatalog(read(path.join(bundle,record.id+'.json')),{project:record.id,repository:repo}),next=catalog([record],{project:record.id,repository:repo,directory});
 if(stable(snapshot.packages.find(p=>p.version===record.version&&p.arch===record.arch))!==stable(next.packages[0]))throw Error('Release catalog does not contain the selected package.');
 const required=checked.declaration.sourceArtifact,sourceName=required&&path.posix.basename(required.directoryRelative),source=sourceName&&path.join(bundle,sourceName),hasSource=Boolean(source&&fs.existsSync(source));
 if(record.sourceAsset&&stable(record.sourceAsset)!==stable(sourceRecord(checked.declaration,repo)))throw Error('Release source asset differs from the sealed source identity.');
 if(hasSource&&(regular(source).size!==required.bytes||await A.checksum(source)!==required.sha256))throw Error('Release asset checksum or size changed.');
 const names=[name,name+'.json',record.id+'.json',...(hasSource?[sourceName]:[])];if(fs.readdirSync(bundle).some(name=>!names.includes(name)))throw Error('Release directory contains undeclared files.');
 const assets=[await asset(bundle,name,'runtime'),await asset(bundle,name+'.json','record'),await asset(bundle,record.id+'.json','catalog'),...(hasSource?[await asset(bundle,sourceName,'source')]:[])];
 return {release:{schemaVersion:1,repository:repo,id:record.id,version:record.version,arch:record.arch,tag:releaseTag(record),assets},record,catalog:snapshot,...(includeDeclaration?{declaration:checked.declaration}:{}),...(includeMetadata?{metadata:checked.metadata}:{})};
}

function options(args){const result={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!args[i+1]||Object.hasOwn(result,key))throw Error('Use unique --option value pairs.');result[key]=args[i+1];}return result;}
export async function main([command,...args],directory=root){
 const o=options(args),allowed={prepare:['project','input','declaration','archive','record','source','source-revision','output'],verify:['bundle','project','version','arch']}[command];
 if(!allowed||Object.keys(o).some(k=>!allowed.includes(k)))throw Error('Use prepare or verify with explicit options.');
 if(command==='prepare'){
  if(!o.project||!o.output)throw Error('prepare requires --project and --output.');
  if(o.declaration){let d=read(o.declaration);if(Array.isArray(d)){d=d.filter(item=>item.id===o.project);if(d.length!==1)throw Error('Declaration must select exactly one project.');d=d[0];}o.declaration=d;}
  if(o.record)o.record=read(o.record);const {'source-revision':sourceRevision,...selected}=o;return prepareRelease({...selected,sourceRevision,directory});
 }
 if(command==='verify')return verifyRelease({...o,directory});

}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
