import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assetName} from '../lib/project-identity.mjs';
import {prepareRelease,stageRelease,verifyRemoteRelease,publishRelease,applyRelease} from './release-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');

/** Release packed package directories in order, stopping before the next package on any failure. */
export async function releaseBatch({packages,target,output,directory=root,runGh,verifyGithubBuild}){
 if(!/^[a-f0-9]{40}$/.test(target||''))throw Error('Batch release requires an exact source commit through --target.');
 if(!output||!Array.isArray(packages)||!packages.length||packages.some(p=>typeof p!=='string'||!p))throw Error('Batch release requires --output and one or more --package directories.');
 const destination=path.resolve(output),inputs=packages.map(p=>path.resolve(p));
 if(inputs.some(input=>destination===input||destination.startsWith(input+path.sep)||input.startsWith(destination+path.sep)))throw Error('Keep batch output separate from the staged package directories.');
 const results=[];
 for(const input of inputs){
  try{
   const sidecars=fs.readdirSync(input).filter(name=>name.endsWith('.tar.gz.json'));
   if(sidecars.length!==1)throw Error('Select a staged directory containing exactly one runtime archive and its package record.');
   const record=JSON.parse(fs.readFileSync(path.join(input,sidecars[0]))),name=assetName(record);
   if(sidecars[0]!==name+'.json')throw Error('Release asset belongs to a different project or version.');
   const bundle=path.join(destination,record.id,record.version,record.arch);
   await prepareRelease({project:record.id,archive:path.join(input,name),record,output:bundle,directory});
   const selected={bundle,directory,runGh,verifyGithubBuild};
   await stageRelease({...selected,target});
   await verifyRemoteRelease(selected);
   const publication=await publishRelease(selected);
   const applied=await applyRelease(selected);
   results.push({projectId:record.id,version:record.version,arch:record.arch,tag:publication.tag,bundle,catalog:applied.catalog,published:Boolean(publication.published)});
  }catch(error){
   throw Error('Release batch stopped at '+input+': '+error.message,{cause:error});
  }
 }
 return results;
}

export async function main(args,{directory=root,runGh,verifyGithubBuild}={}){
 const options={packages:[]};
 for(let i=0;i<args.length;i+=2){
  const key=args[i],value=args[i+1];
  if(!['--package','--target','--output'].includes(key)||!value||value.startsWith('--'))throw Error('Use --target <commit> --output <directory> --package <staged-directory> [--package <staged-directory> ...].');
  if(key==='--package')options.packages.push(value);
  else{
   const name=key.slice(2);if(Object.hasOwn(options,name))throw Error('Use --target and --output only once.');
   options[name]=value;
  }
 }
 return releaseBatch({...options,directory,runGh,verifyGithubBuild});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
