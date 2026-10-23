import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Use the selected Android source project's complete ART producer. */
export async function buildAndroidArt({source,inputs,check=false}){
 source=fs.realpathSync(source);
 const {buildArtRuntime}=await import(pathToFileURL(path.join(source,'tools/build-art.mjs')));
 if(typeof buildArtRuntime!=='function')throw Error('ART source does not provide its runtime producer.');
 return buildArtRuntime({inputs,check});
}

export async function main(args){
 const options={};for(let n=0;n<args.length;n++){
  if(args[n]==='--check'){if(options.check)throw Error('Duplicate --check.');options.check=true;continue;}
  const key=args[n]?.slice(2);
  if(!args[n]?.startsWith('--')||!['source','inputs'].includes(key)||!args[n+1]||Object.hasOwn(options,key))throw Error('Use --source with --check or --inputs.');
  options[key]=args[++n];
 }
 if(!path.isAbsolute(options.source||'')||(!options.check&&!path.isAbsolute(options.inputs||''))||options.check&&options.inputs)throw Error('ART builds require an absolute source and either --check or an absolute inputs path.');
 return buildAndroidArt(options);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
 main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
