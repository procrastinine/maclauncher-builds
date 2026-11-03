import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {readProjects,resolveProject,buildRecord} from '../lib/projects.mjs';
import {ownedPackageSource} from '../lib/source-ownership.mjs';
import {parseSelection,registerSelection} from './release-selection.mjs';
import {buildPlan} from './build-runtime.mjs';
import {requireGithubBuild} from './build-coverage.mjs';
import {createRecipeBuildReporter,canonicalReport} from './recipe-build-report.mjs';
import {resolveBuildInputs} from './resolve-build-inputs.mjs';
const root=path.resolve(import.meta.dirname,'..');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));

/** Suggestions follow the product's version line; explicit names remain untouched. */
export function automaticInputName({current,publishedNames,owned,profiles=[],upstreamVersion}){
 if(owned){
  const plain=publishedNames.filter(version=>/^\d+\.\d+\.\d+(?:-|$)/.test(version)&&!version.includes('MCL')),latest=plain[0]||current,profile=profiles.find(profile=>profile.version===latest);
  const base=/^(\d+)\.(\d+)\.(\d+)/.exec(profile?.semanticVersion||latest);
  if(!base)throw Error('The owned product needs its published semantic version.');
  let patch=Number(base[3])+(plain.length?1:0),name;do{name=base[1]+'.'+base[2]+'.'+patch++;}while(publishedNames.includes(name));return name;
 }
 const highest=Math.max(0,...publishedNames.map(version=>Number(/(?:^|-)MCLv([1-9]\d*)/.exec(version)?.[1]||0)));
 const prefix=current.split(/-?MCLv[1-9]\d*/)[0];
 // Old snapshot labels do not invent an upstream version or retain commit hashes.
 const upstream=upstreamVersion!==undefined?upstreamVersion:/^\d+(?:\.\d+){1,3}(?:-?(?:git|dev|devel|alpha\d*|beta\d*|rc\d*))?$/.test(prefix)?prefix:'';
 return (upstream?upstream+'-':'')+'MCLv'+(highest+1);
}

export async function resolveReleaseSelection({selection,directory=root,releases=[]}){
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
  const project=resolveProject(id,directory,{resolvePins:false}),names=[];
  for(const folder of ['catalogs','catalogs/superseded']){const file=path.join(directory,folder,id+'.json');if(fs.existsSync(file))names.push(...json(file).packages.map(record=>record.version));}
  for(const release of releases){const tag=typeof release==='string'?release:release.tag_name;if(!release.draft&&tag?.startsWith(id+'/v'))names.push(tag.slice(id.length+2).split('/')[0]);}
  const current=buildRecord(project).version,owned=ownedPackageSource(project,registry.repository,directory);
  return automaticInputName({current,publishedNames:names,owned,profiles:project.packageProfiles,upstreamVersion:project.producer.upstreamVersion});
 };
 return resolveBuildInputs({selection:parseSelection(selection),describe,published,nextName});
}

export async function planBuildRelease({selection,directory=root,releases=[]}){
 const resolved=await resolveReleaseSelection({selection,directory,releases});
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
 const plan=await planBuildRelease({selection:env.RELEASES,directory,releases});
 fs.mkdirSync(args[1],{recursive:true});
 const requested=new Set(parseSelection(env.RELEASES).map(row=>row.id)),rebuilt=plan.selection.filter(row=>!requested.has(row.id));
 if(env.GITHUB_STEP_SUMMARY&&rebuilt.length)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,rebuilt.map(({id,version})=>id+' -> '+version+' (rebuilt input)').join('\n\n')+'\n');
 fs.writeFileSync(path.join(args[1],'reports.json'),canonicalReport(plan.reports));
 const output={selection:JSON.stringify(plan.selection),graph:JSON.stringify(plan.graph),reuse:JSON.stringify(plan.reuse),empty:String(!plan.independent.include.length&&plan.matrices.every(matrix=>!matrix.include.length)),matrixIndependent:JSON.stringify(plan.independent),emptyIndependent:String(!plan.independent.include.length)};
 for(let level=0;level<4;level++){output['matrix'+level]=JSON.stringify(plan.matrices[level]);output['empty'+level]=String(!plan.matrices[level].include.length);}
 if(env.GITHUB_OUTPUT)fs.appendFileSync(env.GITHUB_OUTPUT,Object.entries(output).map(([key,value])=>key+'='+value+'\n').join(''));
 return output;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(()=>{}).catch(error=>{console.error(error);process.exitCode=1;});
