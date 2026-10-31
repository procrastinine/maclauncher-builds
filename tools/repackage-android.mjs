import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs');
const {validateDeclaration}=require('../lib/declaration.cjs');

const frameworkBuildDirectories=['native/SDL3.framework/Versions/A/Headers','native/SDL3.framework/Versions/A/Resources/CMake'];
export const androidFrameworkBuildInput=name=>frameworkBuildDirectories.some(directory=>name.startsWith(directory+'/'));

/** Omit SDK declarations from an owned runtime staging copy and update its framework signature. */
export function stripAndroidFrameworkBuildInputs(root,{resign=false}={}){
 let removed=false;
 for(const relative of frameworkBuildDirectories){const directory=path.join(root,relative);if(fs.existsSync(directory)){fs.rmSync(directory,{recursive:true});removed=true;}}
 if(removed||resign){
  const framework=path.join(root,'native/SDL3.framework/Versions/A');
  execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',framework],{stdio:['ignore','pipe','pipe']});
  execFileSync('/usr/bin/codesign',['--verify','--strict',framework],{stdio:['ignore','pipe','pipe']});
 }
 return removed;
}

/** Publish a separate runtime copy without build-only source inputs. */
export function repackageAndroid({input,declaration,output}){
 validateDeclaration(declaration);
 if(!['android','android-art','android-aim'].includes(declaration.id)||!path.isAbsolute(input||'')||!path.isAbsolute(output||''))throw Error('Select an Android runtime declaration and absolute input/output directories.');
 if(fs.existsSync(output))throw Error('Choose a new runtime output directory.');
 B.verifyPayload(input,declaration);
 const prefix=declaration.id==='android-aim'?'files/':'',source=prefix+'source.tar.gz';
 if(declaration.sourceRelative!==source&&declaration.sourceRelative!==null)throw Error('The Android input source layout differs from its declaration.');
 const omitted=name=>name===source||androidFrameworkBuildInput(name);
 const retained=declaration.files.filter(file=>!omitted(file.path));
 fs.mkdirSync(output,{recursive:true});
 try{
  for(const file of retained){const destination=path.join(output,file.path);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(input,file.path),destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);}
  stripAndroidFrameworkBuildInputs(output,{resign:declaration.files.some(file=>androidFrameworkBuildInput(file.path))});
  const metadata=path.join(output,declaration.manifestRelative),manifest=JSON.parse(fs.readFileSync(metadata));
  manifest.files=manifest.files.filter(file=>!omitted(prefix+file.path)).map(file=>{
   const {bytes,...content}=B.readRegular(path.join(output,prefix+file.path),B.LIMITS.fileBytes);return {...file,...content};
  });
  fs.writeFileSync(metadata,JSON.stringify(manifest,null,2)+'\n');fs.chmodSync(metadata,0o644);
  const files=retained.map(file=>{const {bytes,...content}=B.readRegular(path.join(output,file.path),B.LIMITS.fileBytes);return {...file,...content};});
  const result={...declaration,sourceRelative:null,manifestSha256:B.digest(fs.readFileSync(metadata)),files};
  delete result.sourceArtifact;
  validateDeclaration(result);B.verifyPayload(output,result);
  return result;
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}

export function main(args){
 const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!['input','declaration','output'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --input, --declaration and --output.');options[key]=path.resolve(args[i+1]);}
 if(!options.declaration)throw Error('An explicit declaration file is required.');
 const selected=JSON.parse(fs.readFileSync(options.declaration));
 const declaration=repackageAndroid({...options,declaration:selected});
 fs.writeFileSync(options.output+'.json',JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
 return {id:declaration.id,version:declaration.version,root:options.output,files:declaration.files.length};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
