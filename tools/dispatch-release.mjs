import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {retryNetwork,retryNetworkAsync} from './download.mjs';
import {pathToFileURL} from 'node:url';
import {readProjects} from '../lib/projects.mjs';
import {parseSelection,registerSelection} from './release-selection.mjs';
import {resolveReleaseSelection} from './plan-build-release.mjs';
const root=path.resolve(import.meta.dirname,'..');
const pairs=selection=>selection.map(({id,version})=>id+'='+version).join(',');
function exactSelection(value){
 const selection=parseSelection(value);
 for(const {id,version}of selection){
  if(typeof version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version))throw Error('Dispatch requires an exact project=version pair: '+id);
 }
 return selection;
}
/** Weak components of rebuilt packages only. Shared published inputs are read-only. */
export function releaseComponents({selection,graph}){
 selection=exactSelection(selection);
 const byId=new Map(),parent=selection.map((_,index)=>index);
 const find=index=>parent[index]===index?index:(parent[index]=find(parent[index]));
 for(const [index,row]of selection.entries()){if(byId.has(row.id))parent[index]=byId.get(row.id);else byId.set(row.id,index);}
 for(const {id}of selection){
  const inputs=graph[id]||[];if(!Array.isArray(inputs))throw Error('Invalid release dependency graph: '+id);
  for(const input of inputs){if(!byId.has(input))continue;const a=find(byId.get(id)),b=find(byId.get(input));parent[Math.max(a,b)]=Math.min(a,b);}
 }
 const groups=new Map();for(const [index,row]of selection.entries()){const key=find(index);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 return [...groups.values()];
}
/** Start long-running core components before the remaining selection. */
export function orderReleaseComponents({components}){
 const priority=rows=>rows.some(row=>row.id==='reshade')?0:rows.some(row=>row.id==='android')?1:rows.some(row=>row.id==='mpv')?2:3;
 return [...components].sort((a,b)=>priority(a)-priority(b));
}
/** Same resolver and immutable registration checks as the build workflow, with no source writes. */
export async function planReleaseDispatch({selection,directory=root,releases=[],resolve=resolveReleaseSelection}={}){
 // Reject overlapping user pairs before recipe discovery or any dispatch.
 const requested=parseSelection(selection);
 const resolved=await resolve({selection:requested,directory,releases});
 const registration=registerSelection({selection:resolved.orderedSelection,directory,releases,dryRun:true});
 const components=orderReleaseComponents({components:releaseComponents({selection:registration.selection,graph:resolved.dependencyGraph})});
 return {repository:readProjects(directory,{resolvePins:false}).repository,workflow:'runtime-build.yml',ref:'main',selection:registration.selection,graph:resolved.dependencyGraph,
  components:components.map(selection=>({selection,releases:pairs(selection),targets:registration.include.filter(row=>selection.some(pair=>pair.id===row.project&&pair.version===row.version))}))};
}
/** One ordinary dispatch per component; all validation precedes the first remote write. */
export async function dispatchReleaseComponents(plan,{runGh=(args)=>execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}),wait=sleep}={}){
 if(plan.workflow!=='runtime-build.yml'||plan.ref!=='main'||!/^[-\w.]+\/[-\w.]+$/.test(plan.repository||''))throw Error('Use the ordinary main Build and release workflow.');
 const components=plan.components.map(component=>exactSelection(component.selection));
 if(!components.length)throw Error('No release components to dispatch.');
 exactSelection(components.flat());
 const expected=orderReleaseComponents({components:releaseComponents({selection:plan.selection,graph:plan.graph})});
 if(JSON.stringify(components)!==JSON.stringify(expected))throw Error('Dispatch components differ from the resolved graph.');
 const dispatched=[];
 for(const selection of components){
  const releases=pairs(selection);let response;
  try{response=await retryNetworkAsync(()=>runGh(['workflow','run','runtime-build.yml','--repo',plan.repository,'--ref','main','--raw-field','releases='+releases]),{wait});}
  catch(error){error.message+='; components already dispatched: '+JSON.stringify(dispatched);throw error;}
  dispatched.push(releases);
  if(process.env.GITHUB_STEP_SUMMARY){const component=plan.components[dispatched.length-1],url=String(response||'').match(/https:\/\/github\.com\/[^\s]+\/actions\/runs\/\d+/)?.[0];
   fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'\nComponent '+dispatched.length+': '+releases+(url?' — '+url:'')+'\n'+(component.targets||[]).map(row=>'- '+[row.project,row.version,row.arch].join(' ')).join('\n')+'\n');
  }
  if(response)console.log(String(response).trim());
 }
 return {dispatched};
}
export async function main([operation,...args],{directory=root,runGh}={}){
 if(!['plan','dispatch'].includes(operation))throw Error('Use plan or dispatch --file releases.txt (or --releases project=version).');
 const options={};for(let i=0;i<args.length;i+=2){if(!['--file','--releases','--output'].includes(args[i])||!args[i+1]||Object.hasOwn(options,args[i]))throw Error('Use --file or --releases, with optional --output.');options[args[i]]=args[i+1];}
 if(Boolean(options['--file'])===Boolean(options['--releases']))throw Error('Choose exactly one of --file or --releases.');
 let selection=options['--file']?fs.readFileSync(options['--file'],'utf8'):options['--releases'];
 let releases=[];
 if(operation==='dispatch'){
  const repository=readProjects(directory,{resolvePins:false}).repository;
  const text=await retryNetworkAsync(()=>(runGh?runGh(['api','--paginate','--slurp','repos/'+repository+'/releases?per_page=100']):execFileSync('gh',['api','--paginate','--slurp','repos/'+repository+'/releases?per_page=100'],{encoding:'utf8',maxBuffer:32<<20})));
  releases=JSON.parse(text).flat();
 }
 if(operation==='dispatch'){
  const skipped=[],selected=parseSelection(selection).filter(row=>{const published=releases.some(release=>!release.draft&&release.tag_name?.startsWith(row.id+'/v'+row.version+'/'));if(published)skipped.push(row);return !published;});
  for(const row of skipped){const notice=row.id+'='+row.version+' skipped: release already exists';console.log('::notice::'+notice);if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'- '+notice+'\n');}
  if(!selected.length)return {dispatched:[],skipped};selection=selected;
 }
 const plan=await planReleaseDispatch({selection,directory,releases});
 if(options['--output'])fs.writeFileSync(options['--output'],JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
 if(operation==='dispatch')return {...plan,...await dispatchReleaseComponents(plan,{runGh})};
 return plan;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
