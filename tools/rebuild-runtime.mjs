import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {Transform} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {identity,releaseTag,releaseRecord,validateCatalog} from '../lib/project-identity.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {verify} from './runtime-package.mjs';
import {declaredBuilds} from './build-runtime.mjs';
import {buildToolchain} from '../lib/reproducible-build.mjs';
const require=createRequire(import.meta.url), A=require('../lib/archive.cjs');
const root=path.resolve(import.meta.dirname,'..');
const json=value=>JSON.stringify(value,null,2)+'\n';
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort()):item);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','inherit'],...options});

/** Read regular members without extracting files or running package contents. */
async function members(archive){
 const input=fs.createReadStream(archive), expanded=zlib.createGunzip(), expandedHash=crypto.createHash('sha256');let expandedBytes=0;
 const stream=new Transform({transform(chunk,encoding,done){expandedHash.update(chunk);expandedBytes+=chunk.length;done(null,chunk);}});
 input.on('error',error=>stream.destroy(error));expanded.on('error',error=>stream.destroy(error));input.pipe(expanded).pipe(stream);
 const reader=new A.ArchiveReader(stream), entries=new Map();
 try{
  while(true){
   const header=await reader.read(512);
   if(header.every(byte=>byte===0)){if(!(await reader.read(512)).every(byte=>byte===0))throw Error('Invalid archive terminator.');await reader.end();break;}
   const item=A.parseHeader(header);
   if(entries.has(item.name)||entries.size>=A.LIMITS.entries)throw Error('Duplicate or excessive archive members.');
   const digest=crypto.createHash('sha256'),chunks=[],capture=/\.json$/.test(item.name)&&item.size<=A.LIMITS.metadataBytes;
   let remaining=item.size;
   while(remaining){const chunk=await reader.read(Math.min(remaining,65536));remaining-=chunk.length;digest.update(chunk);if(capture)chunks.push(chunk);}
   const value={size:item.size,mode:item.mode,sha256:digest.digest('hex'),headerSha256:hash(header)};
   if(capture){try{value.json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{/* A .json suffix alone does not establish structured contents. */}}
   entries.set(item.name,value);
   if(item.size%512&&(await reader.read(512-item.size%512)).some(byte=>byte!==0))throw Error('Invalid archive padding.');
  }
 }finally{input.destroy();expanded.destroy();stream.destroy();}
 return {entries,expandedSha256:expandedHash.digest('hex'),expandedBytes};
}

function jsonDifferences(original,rebuilt,pointer='',result=[]){
 if(stable(original)===stable(rebuilt))return result;
 if(result.length>=256)return result;
 if(original&&rebuilt&&typeof original==='object'&&typeof rebuilt==='object'&&!Array.isArray(original)&&!Array.isArray(rebuilt)){
  for(const key of [...new Set([...Object.keys(original),...Object.keys(rebuilt)])].sort())jsonDifferences(original[key],rebuilt[key],pointer+'/'+key.replaceAll('~','~0').replaceAll('/','~1'),result);
 }else result.push({pointer:pointer||'/',originalPresent:original!==undefined,rebuiltPresent:rebuilt!==undefined,original:original===undefined?null:original,rebuilt:rebuilt===undefined?null:rebuilt});
 return result;
}
const facts=entry=>entry&&{sha256:entry.sha256,size:entry.size,mode:entry.mode};
function differenceReason(name,fields){
 if(fields?.length)return 'Structured metadata differs at the listed JSON pointers.';
 if(name==='runtime-package.json')return 'The checksum-bound package inventory differs.';
 return 'File bytes differ. The cause is not established by a checksum comparison; recorded toolchain differences are listed separately.';
}

/** Equality is always the hash of complete archive bytes, including metadata. */
export async function compareArchives({original,rebuilt,context={}}){
 for(const file of [original,rebuilt]){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>A.LIMITS.archiveBytes)throw Error('Select regular runtime archives within the package size limit.');}
 const originalSha256=await A.checksum(original),rebuiltSha256=await A.checksum(rebuilt);
 const originalTar=await members(original),rebuiltTar=await members(rebuilt),left=originalTar.entries,right=rebuiltTar.entries,files=[],headers=[];
 for(const name of [...new Set([...left.keys(),...right.keys()])].sort()){
  const a=left.get(name),b=right.get(name);
  if(!a||!b){files.push({path:name,kind:a?'removed':'added',original:facts(a),rebuilt:facts(b),reason:a?'The rebuild omits this archive member.':'The rebuild adds this archive member.'});continue;}
  if(a.sha256!==b.sha256||a.size!==b.size||a.mode!==b.mode){
   const fields=a.json!==undefined&&b.json!==undefined?jsonDifferences(a.json,b.json):undefined;
   files.push({path:name,kind:'changed',original:facts(a),rebuilt:facts(b),...(fields?.length?{jsonDifferences:fields,jsonDifferenceLimit:256}:{}),reason:a.sha256===b.sha256?'File permissions differ; content bytes agree.':differenceReason(name,fields)});
  }
  if(a.headerSha256!==b.headerSha256)headers.push(name);
 }
 const match=originalSha256===rebuiltSha256;
 const toolchainDifferences=context.originalToolchain&&context.rebuiltToolchain?jsonDifferences(context.originalToolchain,context.rebuiltToolchain):[];
 const orderMatches=stable([...left.keys()])===stable([...right.keys()]);
 return {schemaVersion:1,status:match?'match':'different',originalSha256,rebuiltSha256,
  summary:match?'Complete archive bytes match.':files.length?`${files.length} archive members differ.`:'File contents and permissions match; archive headers, member order or compression differ.',
  ...context,toolchainDifferences,archiveMetadata:{memberOrderMatches:orderMatches,differentHeaders:headers,originalTar:{sha256:originalTar.expandedSha256,bytes:originalTar.expandedBytes},rebuiltTar:{sha256:rebuiltTar.expandedSha256,bytes:rebuiltTar.expandedBytes},compressionOnly:!match&&originalTar.expandedSha256===rebuiltTar.expandedSha256},files,
  trust:'GitHub provenance binds archive bytes to a workflow and source commit. It does not prove source safety or byte reproducibility. A differing rebuild requires review; an SDK difference alone does not establish that a binary difference is harmless.'};
}

export function comparisonMarkdown(report){
 const escape=value=>String(value).replaceAll('|','\\|').replaceAll('\n',' ');
 const lines=['# Rebuild comparison','',report.summary,'',`Original SHA-256: \`${report.originalSha256}\``,`Rebuild SHA-256: \`${report.rebuiltSha256}\``];
 if(report.sourceRevision)lines.push(`Recipe commit: \`${report.sourceRevision}\``);
 if(report.repository)lines.push(`Recipe: https://github.com/${report.repository}/tree/${report.sourceRevision}`);
 if(report.attestationVerified)lines.push('Original archive provenance: verified against Runtime build, the exact source commit and a GitHub-hosted runner.');
 if(report.toolchainDifferences.length)lines.push('','Toolchain differences:','',...report.toolchainDifferences.map(row=>`- ${escape(row.pointer)}: ${escape(JSON.stringify(row.original))} → ${escape(JSON.stringify(row.rebuilt))}`));
 if(report.files.length){lines.push('','| File | Difference | Explanation |','| --- | --- | --- |');for(const file of report.files)lines.push(`| ${escape(file.path)} | ${file.kind} | ${escape(file.reason)} |`);lines.push('','Exact SHA-256 values, permissions and JSON pointers are in comparison.json.');}
 if(report.archiveMetadata.differentHeaders.length)lines.push('',`${report.archiveMetadata.differentHeaders.length} tar headers differ; their member names are in comparison.json.`);
 if(!report.archiveMetadata.memberOrderMatches)lines.push('','Archive member order differs.');
 if(report.archiveMetadata.compressionOnly)lines.push('','Decompressed tar members, order and headers agree. Gzip encoding differs.');
 lines.push('',report.trust,'');return lines.join('\n');
}
function writeReport(output,report){fs.writeFileSync(path.join(output,'comparison.json'),json(report),{flag:'wx'});fs.writeFileSync(path.join(output,'comparison.md'),comparisonMarkdown(report),{flag:'wx'});}

function selectedRecord({project,version,arch,bundle,directory=root}){
 identity({id:project,version,arch});
 const registration=resolveProject(project,directory,{resolvePins:false}),repository=registration.releaseRepository;
 let record;
 if(bundle){record=JSON.parse(fs.readFileSync(path.join(bundle,`${project}-${version}-${arch}.tar.gz.json`)));releaseRecord(record,{project,repository});}
 else {const catalog=validateCatalog(JSON.parse(fs.readFileSync(path.join(directory,'catalogs',project+'.json'))),{project,repository});record=catalog.packages.find(row=>row.version===version&&row.arch===arch);}
 if(!record||record.id!==project||record.version!==version||record.arch!==arch)throw Error('The selected exact package is absent from the catalog or bundle.');
 return {repository,record};
}
function tagRevision(repository,tag){
 let ref=JSON.parse(run('gh',['api',`repos/${repository}/git/ref/tags/${tag}`])).object;
 for(let count=0;ref?.type==='tag'&&count<10;count++)ref=JSON.parse(run('gh',['api',`repos/${repository}/git/tags/${ref.sha}`])).object;
 if(ref?.type!=='commit'||!/^[a-f0-9]{40}$/.test(ref.sha||''))throw Error('The release tag does not identify a source commit.');
 return ref.sha;
}
// Historical runner declarations contain flat maps of string literals. Parse
// only that data; planning never evaluates source from another commit.
function stringMap(text){
 const result={},pattern=/\s*(?:'([^'\\\r\n]+)'|"([^"\\\r\n]+)"|([A-Za-z_]\w*))\s*:\s*(?:'([^'\\\r\n]*)'|"([^"\\\r\n]*)")\s*/y;let at=0;
 while(at<text.length){
  pattern.lastIndex=at;const match=pattern.exec(text);if(!match)throw Error('The historical runner declaration needs manual reproduction.');
  const key=match[1]||match[2]||match[3];if(Object.hasOwn(result,key))throw Error('Duplicate historical runner field.');result[key]=match[4]??match[5];at=pattern.lastIndex;
  if(at<text.length){if(text[at++]!==',')throw Error('The historical runner declaration needs manual reproduction.');if(!text.slice(at).trim())break;}
 }
 return result;
}
export function historicalRunner(source,arch,buildRunner){
 const declaration=/export const RUNNERS\s*=\s*Object\.freeze\(\s*\{([^{}]*)\}\s*\)\s*;/.exec(source);
 if(!declaration)throw Error('This historical recipe has no data-only hosted runner declaration.');
 const runner=buildRunner||stringMap(declaration[1])[arch];
 if(!/^(?:macos-(?:latest|[0-9]+)(?:-intel|-large|-xlarge)?|xcode-[0-9]+)$/.test(runner||''))throw Error('Select a supported GitHub-hosted Mac runner.');
 const selected=new RegExp("['\"]"+runner+"['\"]\\s*:\\s*Object\\.freeze\\(\\s*\\{([^{}]*)\\}\\s*\\)").exec(source);
 if(!selected)return {runner,toolchainDeclared:false};
 const toolchain=stringMap(selected[1]);
 if(Object.keys(toolchain).sort().join(',')!=='developerDirectory,sdkVersion,xcodeVersion'||!/^\d+(?:\.\d+)*$/.test(toolchain.xcodeVersion)||!/^\d+(?:\.\d+)*$/.test(toolchain.sdkVersion)||!/^\/Applications\/Xcode[_0-9.]+\.app\/Contents\/Developer$/.test(toolchain.developerDirectory))throw Error('The historical toolchain declaration needs manual reproduction.');
 return {runner,toolchainDeclared:true,...toolchain};
}

export function rebuildPlan(options){
 const {repository,record}=selectedRecord(options),tag=releaseTag(record);
 if(options.sourceRevision&&!/^[a-f0-9]{40}$/.test(options.sourceRevision))throw Error('Select an exact 40-character source revision.');
 // Unpublished Actions bundles require the source digest supplied by their build run.
 const sourceRevision=options.bundle?options.sourceRevision||record.build?.sourceRevision:tagRevision(repository,tag);
 if(!sourceRevision)throw Error('An unpublished build bundle requires --source-revision from its successful build run.');
 if(options.sourceRevision&&sourceRevision!==options.sourceRevision||record.build?.sourceRevision&&sourceRevision!==record.build.sourceRevision)throw Error('The release tag differs from the recorded recipe commit.');
 let build;
 try{const rows=declaredBuilds(file=>run('git',['-C',options.directory||root,'show',sourceRevision+':'+file]));build=rows.get(record.id+'@'+record.version);}catch(error){throw Error('The recipe commit must be available locally; fetch that exact commit before planning.',{cause:error});}
 if(!build?.architectures.includes(record.arch))throw Error('This historical package has no registered build command for its recorded version and CPU. Its source tag remains available for manual reproduction.');
 const recipe=run('git',['-C',options.directory||root,'show',sourceRevision+':tools/build-runtime.mjs']);
 return {repository,record,tag,sourceRevision,build,...historicalRunner(recipe,record.arch,build.runners?.[record.arch])};
}

/** Historical recipes without an explicit Rust toolchain use the runner default. */
export function rustSetupCommands(build,toolchain){
 const selection=toolchain?['--toolchain',toolchain]:[];
 return [...(toolchain?[['toolchain','install',toolchain,'--profile','minimal']]:[]),
  ...(build.rustComponents?.length?[['component','add',...selection,...build.rustComponents]]:[]),
  ...(build.rustTargets?.length?[['target','add',...selection,...build.rustTargets]]:[])];
}

export async function rebuild(options){
 const plan=rebuildPlan(options),output=path.resolve(options.output||'');
 if(!options.output||!path.isAbsolute(options.output)||fs.existsSync(output))throw Error('Choose a new absolute --output directory.');
 if(process.platform!=='darwin')throw Error('Runtime rebuilding requires macOS. Archive comparison is available on other systems.');
 fs.mkdirSync(output,{recursive:true});
 const originalDir=path.join(output,'original');fs.mkdirSync(originalDir);
 const original=path.join(originalDir,plan.record.asset.filename);
 try{
  if(options.bundle)fs.copyFileSync(path.join(options.bundle,plan.record.asset.filename),original,fs.constants.COPYFILE_EXCL);
  else run('gh',['release','download',plan.tag,'--repo',plan.repository,'--pattern',plan.record.asset.filename,'--dir',originalDir]);
  await verify({archive:original,sha256:plan.record.asset.sha256,project:plan.record.id,version:plan.record.version,arch:plan.record.arch});
  const attestation=run('gh',['attestation','verify',original,'--repo',plan.repository,'--signer-workflow',plan.repository+'/.github/workflows/runtime-build.yml','--source-digest',plan.sourceRevision,'--deny-self-hosted-runners','--format','json']);
  fs.writeFileSync(path.join(output,'attestation.json'),attestation,{flag:'wx'});
  const checkout=path.join(output,'checkout');
  run('git',['clone','--no-checkout','--filter=blob:none','--no-tags','--depth','1','--','https://github.com/'+plan.repository+'.git',checkout]);
  run('git',['-C',checkout,'fetch','--no-tags','--depth','1','origin',plan.sourceRevision]);
  run('git',['-C',checkout,'checkout','--detach',plan.sourceRevision]);
  const env={...process.env,HOMEBREW_NO_AUTO_UPDATE:'1',HOMEBREW_NO_INSTALL_CLEANUP:'1'};
  if(options.requireToolchain==='true'&&plan.toolchainDeclared)env.DEVELOPER_DIR=plan.developerDirectory;
  const observed=buildToolchain(env);
  if(options.requireToolchain==='true'&&plan.toolchainDeclared&&(observed.macosSDK!==plan.sdkVersion||!observed.xcode?.startsWith('Xcode '+plan.xcodeVersion+'\n')))throw Error('The selected Xcode/SDK differs from the recipe runner declaration.');
  if(options.installTools==='true'){
   if(plan.build.tools?.length)run('brew',['install',...plan.build.tools],{env,stdio:'inherit'});
   if(plan.build.rustComponents?.length||plan.build.rustTargets?.length){
    const {RUST_TOOLCHAIN}=await import(pathToFileURL(path.join(checkout,'tools/rust-build.mjs')));
    if(RUST_TOOLCHAIN){env.RUNTIME_RUST_TOOLCHAIN=RUST_TOOLCHAIN;env.RUSTUP_TOOLCHAIN=RUST_TOOLCHAIN;}
    for(const args of rustSetupCommands(plan.build,RUST_TOOLCHAIN))run('rustup',args,{env,stdio:'inherit'});
   }
  }
  const node=(args)=>run(process.execPath,args,{cwd:checkout,env,stdio:'inherit'});
  node(['tools/init-runtime-sources.mjs','--project',plan.record.id,'--version',plan.record.version]);
  node(['tools/build-runtime.mjs','--project',plan.record.id,'--version',plan.record.version,'--arch',plan.record.arch,'--output',path.join(output,'build'),'--work',path.join(output,'work')]);
  node(['tools/release-runtime.mjs','prepare','--project',plan.record.id,'--input',path.join(output,'build/payload'),'--declaration',path.join(output,'build/declaration.json'),'--source-revision',plan.sourceRevision,'--output',path.join(output,'release')]);
  node(['tools/release-runtime.mjs','verify','--bundle',path.join(output,'release'),'--project',plan.record.id,'--version',plan.record.version,'--arch',plan.record.arch]);
  const report=await compareArchives({original,rebuilt:path.join(output,'release',plan.record.asset.filename),context:{repository:plan.repository,project:plan.record.id,version:plan.record.version,arch:plan.record.arch,sourceRevision:plan.sourceRevision,attestationVerified:true,originalToolchainRecorded:Boolean(plan.record.build?.toolchain),toolchainDeclared:plan.toolchainDeclared,...(plan.record.build?.toolchain?{originalToolchain:plan.record.build.toolchain}:{}),rebuiltToolchain:observed}});
  writeReport(output,report);return report;
 }catch(error){fs.writeFileSync(path.join(output,'failure.json'),json({status:'error',sourceRevision:plan.sourceRevision,message:error.message}));throw error;}
}

function argumentsFor(args){const values={};for(let n=0;n<args.length;n+=2){const key=args[n]?.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());if(!args[n]?.startsWith('--')||!args[n+1]||Object.hasOwn(values,key))throw Error('Expected distinct --option value pairs.');values[key]=args[n+1];}return values;}
export async function main(args){
 const command=args[0]&&!args[0].startsWith('--')?args.shift():'rebuild',options=argumentsFor(args);
 const allowed=command==='compare'?['original','rebuilt','output']:['project','version','arch','output','bundle','sourceRevision','installTools','requireToolchain'];
 if(!['plan','rebuild','compare'].includes(command)||Object.keys(options).some(key=>!allowed.includes(key)))throw Error('Use plan, rebuild or compare with documented options.');
 for(const flag of ['installTools','requireToolchain'])if(options[flag]!==undefined&&!['true','false'].includes(options[flag]))throw Error('--'+flag+' takes true or false.');
 if(command==='plan'){
  const plan=rebuildPlan(options);
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`runner=${plan.runner}\ndeveloper_directory=${plan.developerDirectory||''}\nxcode_version=${plan.xcodeVersion||''}\nsdk_version=${plan.sdkVersion||''}\nsource_revision=${plan.sourceRevision}\n`);
  return plan;
 }
 if(command==='compare'){
  if(!options.output||!path.isAbsolute(options.output)||fs.existsSync(options.output))throw Error('Choose a new absolute --output directory.');
  const report=await compareArchives(options);fs.mkdirSync(options.output,{recursive:true});writeReport(options.output,report);return report;
 }
 return rebuild(options);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).then(value=>console.log(json(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
