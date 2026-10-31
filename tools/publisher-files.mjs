import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {resolveProject} from '../lib/projects.mjs';
import {releaseRecord} from '../lib/project-identity.mjs';
import {publicDeclaration,verify} from './runtime-package.mjs';
const require=createRequire(import.meta.url),A=require('../lib/archive.cjs');
const root=path.resolve(import.meta.dirname,'..'),SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value,(_,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry);
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>names.includes(key));
const text=value=>typeof value==='string'&&value.length>0&&value.length<4096;
const fail=message=>{throw Error('Supplied publisher files: '+message);};
function read(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>2*A.LIMITS.metadataBytes)fail('select a bounded regular JSON descriptor.');return JSON.parse(fs.readFileSync(file,'utf8'));}
function tuple(file){return {path:file.path,size:file.size,mode:file.mode,sha256:file.sha256};}
function packageFacts(record){const {tag,source,asset,...fields}=record;const {url,...archive}=asset;return {...fields,asset:archive};}
function fileInventory(files){
 if(!Array.isArray(files)||!files.length||files.length>A.LIMITS.entries)fail('an exact supplied-file inventory is required.');
 const names=new Set();
 for(const file of files){if(!keys(file,['path','size','mode','sha256'])||A.safeFile(file.path)!==file.path||names.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0||![0o640,0o644,0o755].includes(file.mode)||!SHA.test(file.sha256||''))fail('invalid or duplicate supplied-file inventory entry.');names.add(file.path);}
 return files;
}
function prefix(value){if(!text(value)||!value.endsWith('/')||A.safeFile(value.slice(0,-1))!==value.slice(0,-1))fail('an exact contained file prefix is required.');return value;}

/** Registered source metadata is the authority; a prebuilt label alone grants nothing. */
export function readPublisherInput({project,directory=root}){
 const registration=resolveProject(typeof project==='string'?project:project?.id,directory,{resolvePins:false}),reference=registration.producer.publisherFiles;
 if(reference===undefined)return undefined;
 if(registration.producer.kind!=='prebuilt'||!keys(reference,['file','sha256'])||!SHA.test(reference.sha256||'')||!reference.file?.endsWith('.json')||A.safeFile(reference.file)!==reference.file)fail('publisher inputs require a registered prebuilt producer and exact descriptor hash.');
 const file=path.join(directory,reference.file),resolved=fs.realpathSync(file),base=fs.realpathSync(directory);
 if(!resolved.startsWith(base+path.sep)||fs.lstatSync(file).isSymbolicLink())fail('the publisher descriptor must belong to the public source tree.');
 const bytes=fs.readFileSync(file);if(bytes.length>A.LIMITS.metadataBytes||hash(bytes)!==reference.sha256)fail('registered publisher descriptor checksum changed.');
 const descriptor=read(file);
 if(!keys(descriptor,['schemaVersion','kind','id','publisherVersion','origin','input','output','files','signature'])||descriptor.schemaVersion!==1||descriptor.kind!=='registered-supplied-publisher-input'||descriptor.id!==registration.id||descriptor.publisherVersion!==registration.producer.version||!text(descriptor.origin)||
  !keys(descriptor.input,['format','record','archive','archivePrefix'])||descriptor.input.format!=='runtime-package-v2'||!keys(descriptor.input.record,['id','version','arch'])||descriptor.input.record.id!==registration.id||!['arm64','x64','universal'].includes(descriptor.input.record.arch)||!text(descriptor.input.record.version)||
  !keys(descriptor.input.archive,['filename','sha256','bytes','url'])||!SHA.test(descriptor.input.archive.sha256||'')||!Number.isSafeInteger(descriptor.input.archive.bytes)||descriptor.input.archive.bytes<1||descriptor.input.archive.bytes>A.LIMITS.archiveBytes||
  descriptor.input.archive.filename!==`${registration.id}-${descriptor.input.record.version}-${descriptor.input.record.arch}.tar.gz`||!/^https:\/\//.test(descriptor.input.archive.url||'')||!keys(descriptor.output,['payloadPrefix'])||
  !keys(descriptor.signature,['kind','developerId','teamIdentifier','publisherAuthenticated'])||!text(descriptor.signature.kind)||descriptor.signature.publisherAuthenticated!==false||![null,'string'].includes(descriptor.signature.developerId===null?null:typeof descriptor.signature.developerId)||![null,'string'].includes(descriptor.signature.teamIdentifier===null?null:typeof descriptor.signature.teamIdentifier))fail('invalid registered supplied publisher input.');
 prefix(descriptor.input.archivePrefix);prefix(descriptor.output.payloadPrefix);fileInventory(descriptor.files);
 if(!descriptor.input.archivePrefix.startsWith('files/')||descriptor.files.some(file=>!file.path.startsWith(descriptor.output.payloadPrefix)))fail('the supplied inventory must cover the exact declared subtree.');
 const url=new URL(descriptor.input.archive.url);if(url.username||url.password||url.hash)fail('publisher input locations cannot carry credentials.');
 return {project:registration,reference:{...reference},descriptor};
}

function packageIdentity(record,declaration,input,repository){
 releaseRecord(record,{project:input.project.id,repository});publicDeclaration(declaration);
 if(record.id!==input.descriptor.id||record.arch!==input.descriptor.input.record.arch||![input.descriptor.publisherVersion,input.descriptor.input.record.version].includes(record.version)||
  declaration.id!==record.id||declaration.version!==record.version||declaration.arch!==record.arch||declaration.manifestRelative!==record.manifestRelative||declaration.manifestSha256!==record.manifestSha256||declaration.sourceSha256!==record.sourceSha256||
  declaration.minimumMacOS!==record.minimumMacOS||stable(declaration.launcherArchitectures)!==stable(record.launcherArchitectures)||record.build!==undefined)fail('the supplied package identity differs from its registered baseline.');
}
function compareSupplied(declaration,input){
 const baseline=new Map(input.descriptor.files.map(file=>[file.path,file])),found=new Set(),extra=[];
 for(const file of declaration.files){
  const original=baseline.get(file.path);
  if(original){if(stable(tuple(file))!==stable(original))fail('supplied bytes or modes changed: '+file.path);found.add(file.path);}
  else {if(file.path.startsWith(input.descriptor.output.payloadPrefix))fail('an extra supplied application file was added: '+file.path);extra.push(file);}
 }
 if(found.size!==baseline.size)fail('the package omits supplied application files.');
 return extra;
}
function validateMetadata(declaration,extra,rows){
 if(!Array.isArray(rows)||rows.length!==extra.length)fail('every additional metadata file needs its bounded original bytes.');
 const map=new Map(),notices=new Set(declaration.notices.map(notice=>notice.path));let total=0;
 for(const row of rows){if(!keys(row,['path','base64'])||!text(row.path)||typeof row.base64!=='string'||row.base64.length>Math.ceil(A.LIMITS.metadataBytes*4/3)||map.has(row.path))fail('invalid bounded metadata contents.');const bytes=Buffer.from(row.base64,'base64');if(bytes.toString('base64')!==row.base64||(total+=bytes.length)>A.LIMITS.metadataBytes)fail('metadata content exceeds its bounds.');map.set(row.path,bytes);}
 for(const file of extra){
  const json=file.path===declaration.manifestRelative||file.path===declaration.sourceRelative;
  if(![0o640,0o644].includes(file.mode)||file.architectures||file.format||file.executionArchitecture||file.optionalLoad||!json&&!notices.has(file.path)||json&&!file.path.endsWith('.json')||/\.(?:mjs|cjs|js|py|sh|rb|jar|wasm|so|dylib|exe|dll|bat|cmd|zip|gz|tar|xz|zst|7z)$/i.test(file.path))fail('extra production code is not supplied metadata: '+file.path);
  const bytes=map.get(file.path);if(!bytes||bytes.length!==file.size||hash(bytes)!==file.sha256)fail('additional metadata differs from its declared bytes: '+file.path);
  let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('additional metadata must be UTF-8 text.');}
  if(content.includes('\0')||content.startsWith('#!'))fail('additional metadata cannot be binary or executable script content.');
  if(json){let value;try{value=JSON.parse(content);}catch{fail('consumed metadata must be valid JSON.');}if(!value||typeof value!=='object'||Array.isArray(value))fail('consumed metadata must be a JSON object.');}
 }
}
function recordResult(record,input){return {kind:'supplied-publisher',repository:input.project.releaseRepository,id:record.id,version:record.version,arch:record.arch,filename:record.asset.filename,sha256:record.asset.sha256,input:input.reference,publisherVersion:input.descriptor.publisherVersion,publisherAuthenticated:false,files:input.descriptor.files.length,recordPath:'publisher-records/'+record.asset.sha256+'.json'};}
function validateEquality(entry,{record,repository,input}){
 if(!keys(entry,['schemaVersion','kind','record','input','declaration','metadata'])||entry.schemaVersion!==1||entry.kind!=='supplied-publisher-files'||stable(entry.input)!==stable(input.reference)||stable(packageFacts(entry.record))!==stable(packageFacts(record)))fail('the equality record belongs to different package bytes or baseline.');
 packageIdentity(record,entry.declaration,input,repository);const extra=compareSupplied(entry.declaration,input);validateMetadata(entry.declaration,extra,entry.metadata);return recordResult(record,input);
}

/** Equality records describe byte comparisons, not cryptographic publisher authentication. */
export function verifyPublisherRecord({record,repository,directory=root}){
 const input=readPublisherInput({project:record.id,directory});if(!input)return undefined;
 if(!SHA.test(record?.asset?.sha256||''))fail('an exact package digest is required.');
 const file=path.join(directory,'publisher-records',record.asset.sha256+'.json');if(!fs.existsSync(file))return undefined;
 return validateEquality(read(file),{record,repository,input});
}
async function outputContents({record,archive,input,repository}){
 const checked=await verify({archive,sha256:record.asset.sha256,project:record.id,version:record.version,arch:record.arch,includeDeclaration:true,includeMetadata:true});
 if(fs.statSync(archive).size!==record.asset.bytes)fail('output archive size differs from the package record.');
 packageIdentity(record,checked.declaration,input,repository);const extra=compareSupplied(checked.declaration,input);
 const metadata=extra.map(file=>{const bytes=checked.metadata[file.path];if(!bytes)fail('extra production file is not consumed metadata: '+file.path);return {path:file.path,base64:bytes.toString('base64')};});
 validateMetadata(checked.declaration,extra,metadata);return {declaration:checked.declaration,metadata};
}
async function verifyInputArchive(archive,input){
 const {descriptor}=input,pin=descriptor.input;
 if(fs.lstatSync(archive).size!==pin.archive.bytes)fail('supplied input archive size changed.');
 const checked=await verify({archive,sha256:pin.archive.sha256,project:pin.record.id,version:pin.record.version,arch:pin.record.arch,includeDeclaration:true});
 const selected=checked.declaration.files.filter(file=>('files/'+file.path).startsWith(pin.archivePrefix)).map(file=>({...tuple(file),path:descriptor.output.payloadPrefix+('files/'+file.path).slice(pin.archivePrefix.length)}));
 const expected=new Map(descriptor.files.map(file=>[file.path,file]));
 if(selected.length!==expected.size||selected.some(file=>stable(file)!==stable(expected.get(file.path))))fail('the supplied input archive differs from its complete registered subtree.');
}

/** Recheck actual archive bytes against the public baseline and equality declaration. */
export async function verifyPublisherArchive({record,archive,inputArchive,directory=root}){
 const input=readPublisherInput({project:record.id,directory});if(!input)fail('the project has no registered publisher input.');
 const repository=input.project.releaseRepository,evidence=verifyPublisherRecord({record,repository,directory});if(!evidence)fail('import an actual supplied-file equality record before publication.');
 if(inputArchive)await verifyInputArchive(inputArchive,input);
 const actual=await outputContents({record,archive,input,repository}),entry=read(path.join(directory,evidence.recordPath));
 if(stable(actual.declaration)!==stable(entry.declaration)||stable(actual.metadata)!==stable(entry.metadata))fail('actual output metadata differs from the equality record.');
 return evidence;
}

/** Source tags pin the packaging descriptor and producer mapping, without a signing claim. */
export function assertPublisherSource({record,directory=root,sourceRevision}){
 if(!COMMIT.test(sourceRevision||''))fail('publication requires an exact packaging source commit.');
 const input=readPublisherInput({project:record.id,directory});if(!input)fail('the project has no registered publisher input.');
 const show=file=>{try{return execFileSync('git',['-C',directory,'show',sourceRevision+':'+file],{stdio:['ignore','pipe','pipe']});}catch{fail('the packaging source commit does not contain the declared publisher inputs.');}};
 if(hash(show(input.reference.file))!==input.reference.sha256)fail('the packaging source commit has another publisher descriptor.');
 const manifest=JSON.parse(show('projects.json')),projects=manifest.schemaVersion===2?Object.values(manifest.registries).flatMap(file=>JSON.parse(show(file))):manifest.projects;
 const project=projects?.find(project=>project.id===record.id);
 if(project?.producer?.kind!=='prebuilt'||project.producer.version!==input.descriptor.publisherVersion||stable(project.producer.architectures)!==stable(input.project.producer.architectures)||stable(project.producer.publisherFiles)!==stable(input.reference))fail('the packaging source commit has another registered publisher mapping.');
 return sourceRevision;
}

export async function recordPublisherFiles({project,inputArchive,archive,record,directory=root,outputDir=path.join(directory,'publisher-records')}){
 const input=readPublisherInput({project,directory});if(!input)fail('register the public supplied publisher input first.');
 const repository=input.project.releaseRepository;await verifyInputArchive(inputArchive,input);
 const actual=await outputContents({record,archive,input,repository}),entry={schemaVersion:1,kind:'supplied-publisher-files',record,input:input.reference,...actual};
 validateEquality(entry,{record,repository,input});
 const destination=path.join(outputDir,record.asset.sha256+'.json'),bytes=JSON.stringify(entry,null,2)+'\n';
 if(fs.existsSync(destination)){if(stable(read(destination))!==stable(entry))fail('an existing equality record cannot be replaced.');return {file:destination,...recordResult(record,input)};}
 fs.mkdirSync(outputDir,{recursive:true});fs.writeFileSync(destination,bytes,{flag:'wx'});return {file:destination,...recordResult(record,input)};
}
export async function main([command,...args],directory=root){
 if(!['record','verify'].includes(command))fail('use record or verify with explicit archives and package record.');
 const options={};for(let index=0;index<args.length;index+=2){const key=args[index]?.slice(2);if(!args[index]?.startsWith('--')||!['project','input-archive','archive','record','output-dir'].includes(key)||!args[index+1]||Object.hasOwn(options,key))fail('use unique --project, --input-archive, --archive, --record and optional --output-dir values.');options[key]=args[index+1];}
 if(!options.project||!options.archive||!options.record||command==='record'&&!options['input-archive']||command==='verify'&&options['output-dir'])fail('record needs both actual archives; verify needs its archive and record without an output directory.');
 const selected=read(options.record),wrapped=command==='verify'&&selected.kind==='supplied-publisher-files',record=wrapped?selected.record:selected;
 if(record?.id!==options.project)fail('the package record belongs to another registered project.');
 if(wrapped){const input=readPublisherInput({project:options.project,directory});if(!input)fail('the project has no registered publisher input.');validateEquality(selected,{record,repository:input.project.releaseRepository,input});}
 if(command==='verify')return verifyPublisherArchive({record,archive:options.archive,...(options['input-archive']?{inputArchive:options['input-archive']}:{}),directory});
 return recordPublisherFiles({project:options.project,inputArchive:options['input-archive'],archive:options.archive,record,directory,...(options['output-dir']?{outputDir:options['output-dir']}:{})});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
