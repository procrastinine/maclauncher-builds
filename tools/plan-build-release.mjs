import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {readProjects,resolveProject,buildRecord} from '../lib/projects.mjs';
import {ownedPackageSource,plainSemanticVersion} from '../lib/source-ownership.mjs';
import {nextPackageVersion} from '../lib/package-version.mjs';
import {parseSelection,registerSelection} from './release-selection.mjs';
import {buildPlan} from './build-runtime.mjs';
import {requireGithubBuild} from './build-coverage.mjs';
import {createRecipeBuildReporter,canonicalReport} from './recipe-build-report.mjs';
import {resolveBuildInputs} from './resolve-build-inputs.mjs';
const root=path.resolve(import.meta.dirname,'..');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));

export async function planBuildRelease({selection,directory=root,releases=[]}){
 const registry=readProjects(directory,{resolvePins:false}),describe=createRecipeBuildReporter({directory});
 const latest=new Map();
 const published=async id=>{
  if(latest.has(id))return latest.get(id);
  const file=path.join(directory,'catalogs',id+'.json');let result=null;
  for(const record of fs.existsSync(file)?json(file).packages:[]){
   // An unsigned newest release needs a rebuild; older signed releases cannot substitute for it.
   try{requireGithubBuild({record,repository:registry.repository,directory});}catch{break;}
   const declarationFile=path.join(directory,'catalogs/declarations',id,record.version,record.arch+'.json');
   const declaration=fs.existsSync(declarationFile)?json(declarationFile):null;
   result={version:record.version,digest:record.asset.sha256,arch:record.arch,
    definitionDigest:declaration?.files?.find(file=>file.path==='build-definition.json')?.sha256};break;
  }
  latest.set(id,result);return result;
 };
 const nextName=async id=>{
  const project=resolveProject(id,directory,{resolvePins:false}),current=buildRecord(project).version;
  const versions=(project.packageProfiles||[]).map(profile=>profile.version);
  for(const folder of ['catalogs','catalogs/superseded']){const file=path.join(directory,folder,id+'.json');if(fs.existsSync(file))versions.push(...json(file).packages.map(record=>record.version));}
  const packageVersions=[...versions];
  for(const entry of project.producer.entries||[])if(entry.endsWith('.json')&&fs.existsSync(path.join(directory,entry)))versions.push(...fs.readFileSync(path.join(directory,entry),'utf8').matchAll(/"version"\s*:\s*"([^"]+)"/g).map(match=>match[1]));
  if(ownedPackageSource(project,registry.repository,directory)){
   const profile=project.packageProfiles.find(profile=>profile.version===current),candidates=[profile?.semanticVersion,current,...packageVersions].filter(value=>typeof value==='string').flatMap(value=>/^(\d+\.\d+\.\d+)(?:-|$)/.exec(value)?.[1]||[]).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})),base=candidates[0]||'0.0.0';
   if(plainSemanticVersion(base))return nextPackageVersion(base,packageVersions,{sourceRepository:registry.repository,releaseRepository:registry.repository});
  }
  const match=/MCLv([1-9]\d*)/.exec(current);
  if(match){const prefix=current.slice(0,match.index),suffix=current.slice(match.index+match[0].length),numbers=versions.flatMap(version=>version.startsWith(prefix+'MCLv')&&version.endsWith(suffix)?[Number(/^([1-9]\d*)/.exec(version.slice(prefix.length+4))?.[1]||0)]:[]);return prefix+'MCLv'+(Math.max(Number(match[1]),...numbers)+1)+suffix;}
  return nextPackageVersion(current,versions);
 };
 const resolved=await resolveBuildInputs({selection:parseSelection(selection),describe,published,nextName});
 const registration=registerSelection({selection:resolved.orderedSelection,directory,releases});
 const all=registration.selection.flatMap(({id,version})=>buildPlan({project:id,version,arch:'all',directory,tags:()=>[]}).include);
 const depth=new Map(resolved.levels.flatMap((ids,level)=>ids.map(id=>[id,level])));
 if(all.some(row=>depth.get(row.project)>3))throw Error('The build dependency chain exceeds the four configured build phases.');
 const required=new Set(Object.values(resolved.dependencyGraph).flat()),independent=all.filter(row=>depth.get(row.project)===0&&!required.has(row.project));
 return {selection:registration.selection,reports:resolved.reports,graph:resolved.dependencyGraph,reuse:resolved.reuseBindings,independent:{include:independent},
  matrices:Array.from({length:4},(_,level)=>({include:all.filter(row=>depth.get(row.project)===level&&(level!==0||required.has(row.project)))}))};
}
export async function main(args,{directory=root,env=process.env}={}){
 if(args.length!==2||args[0]!=='--output'||!path.isAbsolute(args[1]))throw Error('Use --output /absolute/plan-directory.');
 const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_ACTIONS!=='true')throw Error('Release planning with GitHub metadata runs inside Build and release.');
 const releases=JSON.parse(execFileSync('gh',['api','--paginate','--slurp','repos/'+repository+'/releases?per_page=100'],{encoding:'utf8'})).flat().filter(release=>!release.draft);
 const plan=await planBuildRelease({selection:env.RELEASES,directory,releases});fs.mkdirSync(args[1],{recursive:true});
 fs.writeFileSync(path.join(args[1],'reports.json'),canonicalReport(plan.reports));
 const output={selection:JSON.stringify(plan.selection),graph:JSON.stringify(plan.graph),reuse:JSON.stringify(plan.reuse),empty:String(!plan.independent.include.length&&plan.matrices.every(matrix=>!matrix.include.length)),matrixIndependent:JSON.stringify(plan.independent),emptyIndependent:String(!plan.independent.include.length)};
 for(let level=0;level<4;level++){output['matrix'+level]=JSON.stringify(plan.matrices[level]);output['empty'+level]=String(!plan.matrices[level].include.length);}
 if(env.GITHUB_OUTPUT)fs.appendFileSync(env.GITHUB_OUTPUT,Object.entries(output).map(([key,value])=>key+'='+value+'\n').join(''));
 return output;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(()=>{}).catch(error=>{console.error(error);process.exitCode=1;});
