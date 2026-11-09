import './producer-environment.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {retryNetworkAsync} from './download.mjs';
import {identity,releaseTag,assetName,validateCatalog} from '../lib/project-identity.mjs';
import {releaseVersion} from '../lib/package-version.mjs';
import {buildIndex} from './package-index.mjs';
const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
const github=async args=>retryNetworkAsync(async()=>(await exec('gh',args,{encoding:'utf8',maxBuffer:Infinity})).stdout);
const job=(text,name)=>(text.split(/\n  (?=[A-Za-z][A-Za-z0-9_-]*:\n)/).find(body=>body.startsWith(name+':\n'))||'');
const permissions=body=>Object.fromEntries([...(body.match(/\n    permissions:\n((?:      [a-z-]+: [a-z]+\n)+)/)?.[1]||'').matchAll(/([a-z-]+): ([a-z]+)/g)].map(match=>[match[1],match[2]]));

/** The token grants each publishing job needs, as GitHub grants declared job permissions. */
export const requiredPermissions=[
 {file:'runtime-build.yml',job:'attest',grants:{actions:'read','id-token':'write',attestations:'write'}},
 {file:'runtime-build.yml',job:'publish',grants:{contents:'write',actions:'read',attestations:'read'}},
 {file:'runtime-build.yml',job:'index',grants:{pages:'write','id-token':'write'}},
 {file:'pages.yml',job:'deploy',grants:{pages:'write','id-token':'write'}}
];

/** Every condition publication needs, checked read-only before any build job starts.
 * Returns the checked facts; throws one error naming every failed condition. */
export async function checkPublication({targets,selection,directory=root,repository,releases=[],runGh=github,index=buildIndex}){
 const problems=[],checked={targets:0,catalogs:0,tags:0},api=async args=>JSON.parse(await runGh(['api',...args])),valid=[];
 // Declarations publication validates: identity, tag, asset name and the declared release version.
 for(const target of targets){
  try{identity({id:target.project,version:target.version,arch:target.arch});releaseTag({id:target.project,version:target.version,arch:target.arch});assetName({id:target.project,version:target.version,arch:target.arch});releaseVersion(target.project,target.version,directory);checked.targets++;valid.push(target);}
  catch(error){problems.push([target.project,target.version,target.arch].join(' ')+': '+error.message);}
 }
 // Catalogs the publisher appends to must parse as catalogs of their project.
 for(const id of new Set(selection.map(row=>row.id))){
  const file=path.join(directory,'catalogs',id+'.json');if(!fs.existsSync(file))continue;
  try{validateCatalog(JSON.parse(fs.readFileSync(file,'utf8')),{project:id,repository,allowEmpty:true});checked.catalogs++;}
  catch(error){problems.push('catalog '+id+': '+error.message);}
 }
 // The package index the Pages job builds must build from the current catalogs.
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'package-index-check-'));
 try{await index({directory,output});if(!fs.existsSync(path.join(output,'index.html'))||!fs.existsSync(path.join(output,'index.json')))problems.push('package index: no index page was generated');}
 catch(error){problems.push('package index: '+error.message);}
 finally{fs.rmSync(output,{recursive:true,force:true});}
 // Tags and release names must still be free.
 let refs=[];
 try{refs=(await api(['--paginate','--slurp','repos/'+repository+'/git/matching-refs/tags/'])).flat().map(row=>row.ref);}
 catch(error){problems.push('tags are not readable: '+error.message);}
 const tags=new Set(refs),names=new Set(releases.map(release=>release.tag_name));
 for(const target of valid){
  const tag=releaseTag({id:target.project,version:target.version,arch:target.arch});
  if(tags.has('refs/tags/'+tag))problems.push('tag '+tag+' already exists');
  else if(names.has(tag))problems.push('release '+tag+' already exists');
  else checked.tags++;
 }
 // Pages must deploy from a workflow, through its environment.
 try{const pages=await api(['repos/'+repository+'/pages']);if(pages.build_type!=='workflow')problems.push('Pages builds from '+(pages.build_type||'an unknown source')+', not from a workflow');}
 catch(error){problems.push('Pages is not readable: '+error.message);}
 try{await api(['repos/'+repository+'/environments/github-pages']);}
 catch(error){problems.push('the github-pages environment is not readable: '+error.message);}
 // Token grants of the publishing jobs.
 for(const {file,job:name,grants} of requiredPermissions){
  const workflow=path.join(directory,'.github/workflows',file);
  if(!fs.existsSync(workflow)){problems.push(file+' is missing');continue;}
  const declared=permissions(job(fs.readFileSync(workflow,'utf8'),name));
  for(const [scope,level] of Object.entries(grants))if(declared[scope]!==level&&!(level==='read'&&declared[scope]==='write'))problems.push(file+' job '+name+' needs '+scope+': '+level);
 }
 if(problems.length)throw Error('Publication cannot complete:\n- '+problems.join('\n- '));
 return checked;
}
