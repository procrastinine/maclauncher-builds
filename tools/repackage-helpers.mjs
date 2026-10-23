import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs');
const {validateDeclaration}=require('../lib/declaration.cjs');
const helpers=new Set(['android-apk-metadata','android-privacy','catsystem2-kif-crypto','ios-playtools-paths','mkxpz-config-helper']);

/** Keep executable helpers, consumed identity metadata and license notices. */
export function repackageHelper({input,declaration,output,version=declaration?.version+'-content1'}){
 validateDeclaration(declaration);
 if(!helpers.has(declaration.id)||!path.isAbsolute(input||'')||!path.isAbsolute(output||'')||!version||/[\\/]/.test(version))throw Error('Select a helper declaration, version and absolute input/output directories.');
 if(output===input||output.startsWith(input+path.sep)||fs.existsSync(output))throw Error('Choose a new helper output directory outside its input.');
 B.verifyPayload(input,declaration);
 const retained=declaration.files.filter(file=>file.architectures||file.path===declaration.manifestRelative||declaration.notices.some(notice=>notice.path===file.path)||/^licenses\//.test(file.path)||/^NOTICE(?:\.|$)/i.test(file.path));
 fs.mkdirSync(output,{recursive:true});
 try{
  for(const file of retained){const dest=path.join(output,file.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(input,file.path),dest,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(dest,file.mode);}
  const metadata=path.join(output,declaration.manifestRelative),manifest=JSON.parse(fs.readFileSync(metadata));
  manifest.version=version;
  if(Object.hasOwn(manifest,'sourceRelative'))manifest.sourceRelative=null;
  if(Array.isArray(manifest.files))manifest.files=manifest.files.filter(file=>retained.some(item=>item.path===file.path));
  delete manifest.sources;
  fs.writeFileSync(metadata,JSON.stringify(manifest,null,2)+'\n');fs.chmodSync(metadata,0o644);
  const files=retained.map(file=>{const {bytes,...content}=B.readRegular(path.join(output,file.path),B.LIMITS.fileBytes);return {...file,...content};});
  const result={...declaration,version,directoryRelative:[declaration.id,version,declaration.arch].join('/'),sourceRelative:null,manifestSha256:B.digest(fs.readFileSync(metadata)),files};
  delete result.sourceArtifact;
  validateDeclaration(result);B.verifyPayload(output,result);
  return result;
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}

export function main(args){
 const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['input','declaration','output','version'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --input, --declaration, --output and optional --version.');options[key]=key==='version'?args[i+1]:path.resolve(args[i+1]);}
 if(!options.declaration)throw Error('An explicit helper declaration is required.');
 const result=repackageHelper({...options,declaration:JSON.parse(fs.readFileSync(options.declaration))});
 fs.writeFileSync(options.output+'.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 return {id:result.id,version:result.version,root:options.output,files:result.files.length};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
