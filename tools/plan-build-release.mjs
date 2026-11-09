import './producer-environment.mjs';
import {retryNetwork} from './download.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {readProjects} from '../lib/projects.mjs';
import {parseSelection,registerSelection} from './release-selection.mjs';
import {buildPlan} from './build-runtime.mjs';
import {requireGithubBuild} from './build-coverage.mjs';
import {createRecipeBuildReporter,canonicalReport} from './recipe-build-report.mjs';
import {resolveBuildInputs} from './resolve-build-inputs.mjs';
import {checkPublication} from './publication-preflight.mjs';
const root=path.resolve(import.meta.dirname,'..');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));

export async function resolveReleaseSelection({selection,directory=root,releases=[]}){
 const registry=readProjects(directory,{resolvePins:false}),describe=createRecipeBuildReporter({directory});
 const latest=new Map();
 const published=async id=>{
  if(latest.has(id))return latest.get(id);
  const file=path.join(directory,'catalogs',id+'.json'),records=fs.existsSync(file)?json(file).packages:[];
  // Reuse the newest version only when the exact catalog archive of each architecture is public.
  const version=records[0]?.version,digests={};let result=version?{version,digests}:null;
  for(const record of records.filter(record=>record.version===version)){
   try{requireGithubBuild({record,repository:registry.repository,directory});}catch{result=null;break;}
   const release=releases.find(release=>release.tag_name===record.tag&&!release.draft);
   if(release?.assets?.length!==1||release.assets[0].digest!=='sha256:'+record.asset.sha256){result=null;break;}
   digests[record.arch]=record.asset.sha256;
  }
  latest.set(id,result);return result;
 };
 const listed=new Map(),file=path.join(directory,'releases.txt');
 if(fs.existsSync(file))for(const {id,version} of parseSelection(fs.readFileSync(file,'utf8')))listed.set(id,[...(listed.get(id)||[]),version]);
 return resolveBuildInputs({selection:parseSelection(selection),describe,published,listed});
}

export async function planBuildRelease({selection,directory=root,releases=[],publish=true}){
 const resolved=await resolveReleaseSelection({selection,directory,releases});
 // A build-only run may rebuild a published name; publishing requires a new one.
 const registration=registerSelection({selection:resolved.orderedSelection,directory,releases:publish?releases:[]});
 const all=registration.selection.flatMap(({id,version})=>buildPlan({project:id,version,arch:'all',directory}).include);
 const depth=new Map(resolved.levels.flatMap((ids,level)=>ids.map(id=>[id,level])));
 // Levels are data: one entry per dependency depth that has builds, in build order.
 const levels=[...new Set(all.map(row=>depth.get(row.project)))].sort((a,b)=>a-b).map((level,index)=>({index,include:all.filter(row=>depth.get(row.project)===level)}));
 return {selection:registration.selection,reports:resolved.reports,graph:resolved.dependencyGraph,reuse:resolved.reuseBindings,levels};
}
const listReleases=repository=>JSON.parse(retryNetwork(()=>execFileSync('gh',['api','--paginate','--slurp','repos/'+repository+'/releases?per_page=100'],{maxBuffer:Infinity,encoding:'utf8'}))).flat();
export async function main(args,{directory=root,env=process.env,releasesOf=listReleases,check=checkPublication}={}){
 if(args.length!==2||args[0]!=='--output'||!path.isAbsolute(args[1]))throw Error('Use --output /absolute/plan-directory.');
 const repository=readProjects(directory,{resolvePins:false}).repository;
 if(env.GITHUB_ACTIONS!=='true')throw Error('Release planning with GitHub metadata runs inside Build and release.');
 const releases=releasesOf(repository).filter(release=>!release.draft);
 const publish=env.RELEASE_PUBLISH!=='false',plan=await planBuildRelease({selection:env.RELEASES,directory,releases,publish});
 // Publication is proven before any build starts; a build-only run needs none of it.
 if(publish)await check({targets:plan.levels.flatMap(level=>level.include),selection:plan.selection,directory,repository,releases});
 fs.mkdirSync(args[1],{recursive:true});
 const requested=new Set(parseSelection(env.RELEASES).map(row=>row.id)),rebuilt=plan.selection.filter(row=>!requested.has(row.id));
 if(env.GITHUB_STEP_SUMMARY&&rebuilt.length)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,rebuilt.map(({id,version})=>id+' -> '+version+' (unpublished input)').join('\n\n')+'\n');
 fs.writeFileSync(path.join(args[1],'reports.json'),canonicalReport(plan.reports));
 const output={selection:JSON.stringify(plan.selection),graph:JSON.stringify(plan.graph),reuse:JSON.stringify(plan.reuse),levels:JSON.stringify(plan.levels),targets:JSON.stringify({include:plan.levels.flatMap(level=>level.include)}),empty:String(!plan.levels.length)};
 if(env.GITHUB_OUTPUT)fs.appendFileSync(env.GITHUB_OUTPUT,Object.entries(output).map(([key,value])=>key+'='+value+'\n').join(''));
 return output;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(()=>{}).catch(error=>{console.error(error);process.exitCode=1;});
