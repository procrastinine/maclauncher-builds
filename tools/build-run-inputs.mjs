import fs from 'node:fs';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord,readProjects} from '../lib/projects.mjs';
import {assetUrl,validateCatalog,projectId} from '../lib/project-identity.mjs';
import {verifyRelease} from './release-package.mjs';
import {retryNetwork} from './download.mjs';
import {buildInput} from './build-input.mjs';
import {verify} from './runtime-package.mjs';
import {parseSelection} from './release-selection.mjs';
import {materializePackageAliases} from './package-layout.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile),json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const reportMap=value=>!value?{}:JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8'));
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort()):item);
/** Materialize only declared direct dependencies from this run or exact verified releases. */
export async function prepareBuildInputs({project,output,directory=root,environment=process.env,runGh,download=buildInput,verifyBundle=verifyRelease,verifyArchive=verify,extract=async(archive,destination)=>{await exec('tar',['-xzf',archive,'-C',destination]);}}={}){
 projectId(project);if(!path.isAbsolute(output||'')||fs.existsSync(output)||/[\r\n]/.test(output))throw Error('Build inputs require a new absolute output directory.');
 const graph=JSON.parse(environment.RELEASE_GRAPH||'{}'),reports=reportMap(environment.BUILD_REPORTS),reuse=JSON.parse(environment.RELEASE_REUSE||'{}'),selection=parseSelection(environment.RELEASE_SELECTION||'[]'),repository=readProjects(directory,{resolvePins:false}).repository;
 const direct=graph[project]||[],deps=[],seen=new Set();if(!Array.isArray(direct))throw Error('Invalid release dependency graph.');
 const visit=id=>{if(seen.has(id))return;seen.add(id);for(const dependency of graph[id]||[])visit(dependency);deps.push(id);};for(const id of direct)visit(id);
 const gh=runGh||(async(args)=>{if(environment.GITHUB_ACTIONS!=='true')throw Error('Build input transport runs only inside GitHub Actions.');return retryNetwork(()=>execFileSync('gh',args,{env:environment,encoding:'utf8',maxBuffer:64*1024**2}));});
 const consumer=resolveProject(project,directory,{resolvePins:false}),consumerVersion=selection.find(row=>row.id===project)?.version,consumerBuild=buildRecord(consumer,consumerVersion),consumerArch=environment.BUILD_ARCH||environment.RUNTIME_ARCH||consumerBuild.architectures[0];
 const choose=records=>records.find(record=>record.arch===consumerArch)||records.find(record=>record.arch==='universal')||records.find(record=>record.arch==='arm64');
 fs.mkdirSync(output,{recursive:true});const result={};
 for(const dep of [...new Set(deps)]){
  projectId(dep);const registration=resolveProject(dep,directory,{resolvePins:false}),selected=selection.find(row=>row.id===dep),work=path.join(output,dep);fs.mkdirSync(work);
  let record,declaration,archive,evidence;
  if(selected){
   const build=buildRecord(registration,selected.version),target=choose(build.architectures.map(arch=>({arch})));if(!target)throw Error('No compatible dependency output: '+dep);
   if(!/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID||'')||!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA||''))throw Error('Current-run inputs need an exact run and source.');
   const bundle=path.join(work,'bundle');fs.mkdirSync(bundle);
   await gh(['run','download',environment.GITHUB_RUN_ID,'--repo',repository,'--name',`runtime-${dep}-${selected.version}-${target.arch}`,'--dir',bundle]);
   ({record,declaration}=await verifyBundle({bundle,project:dep,version:selected.version,arch:target.arch,directory,includeDeclaration:true}));
   if(record.build?.sourceRevision!==environment.GITHUB_SHA||String(record.build?.runId)!==environment.GITHUB_RUN_ID)throw Error('Dependency archive belongs to another run or source: '+dep);
   archive=path.join(bundle,record.asset.filename);
   evidence=record.build||{};
  }else{
   const binding=Array.isArray(reuse)?reuse.find(row=>row.id===dep):reuse[dep];if(!binding?.version||!binding.digest)throw Error('Missing exact planned published input: '+dep);
   const catalog=validateCatalog(json(path.join(directory,'catalogs',dep+'.json')),{project:dep,repository}),compatible=catalog.packages.filter(record=>record.version===binding.version&&record.asset.sha256===binding.digest&&(!binding.arch||record.arch===binding.arch));record=choose(compatible);if(!record)throw Error('Planned published dependency is absent: '+dep);
   if(!runGh&&environment.GITHUB_ACTIONS!=='true')throw Error('Published inputs are fetched only inside GitHub Actions.');
   const release=JSON.parse(await gh(['api','repos/'+repository+'/releases/tags/'+encodeURIComponent(record.tag)]));
   if(release.draft!==false||release.assets?.length!==1||release.assets[0].digest!=='sha256:'+record.asset.sha256)throw Error('Published input release differs from its catalog digest: '+dep);

   archive=await download({url:assetUrl(record,repository),sha256:record.asset.sha256,bytes:record.asset.bytes},path.join(work,'archives'));
   ({declaration}=await verifyArchive({archive,sha256:record.asset.sha256,project:dep,version:record.version,arch:record.arch,includeDeclaration:true}));
   evidence=record.build||{};
  }
  for(const key of ['id','version','arch','manifestRelative','manifestSha256','sourceSha256','minimumMacOS','launcherArchitectures'])if(canonical(declaration[key])!==canonical(record[key]))throw Error('Input sealed inventory differs from recorded package: '+dep+' '+key);
  const definition=reports[dep]?.definitionDigest;if(!/^[a-f0-9]{64}$/.test(definition||'')||declaration.files?.find(file=>file.path==='build-definition.json')?.sha256!==definition)throw Error('Verified dependency definition differs from the plan: '+dep);
  const payload=path.join(work,'payload');fs.mkdirSync(payload);await extract(archive,payload);
  const files=path.join(payload,'files');if(!fs.statSync(files).isDirectory())throw Error('Verified archive has no payload: '+dep);
  const staged=path.join(payload,'payload');fs.renameSync(files,staged);fs.renameSync(path.join(payload,'runtime-package.json'),path.join(payload,'declaration.json'));
  result[dep]={root:staged,declaration,record:{...record,asset:{...record.asset,url:assetUrl(record,repository)}},evidence,archive};
  materializePackageAliases({root:staged,declaration,inputs:result});
 }
 const file=path.join(output,'inputs.json');fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 if(environment.GITHUB_ENV)fs.appendFileSync(environment.GITHUB_ENV,'MACLAUNCHER_BUILD_INPUTS='+file+'\n');return result;
}
export function main(args){if(args.length!==5||args[0]!=='prepare'||args[1]!=='--project'||args[3]!=='--output')throw Error('Use prepare --project id --output /absolute/new-directory.');return prepareBuildInputs({project:args[2],output:args[4]});}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(Object.keys(value)))).catch(error=>{console.error(error);process.exitCode=1;});
