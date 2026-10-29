import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url),B=require('../../lib/bundled-native.cjs');
const Native=require('../maclauncher/scripts/native-binary-tools.cjs');
const {validateDeclaration}=require('../../lib/declaration.cjs');
const root=path.dirname(fileURLToPath(import.meta.url));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const run=(command,args)=>execFileSync(command,args,{stdio:'pipe',timeout:60000});

/** Repackage exact supplied production files. Original inputs are never changed. */
export function prepare({id,input,output}){
 if(!/^[a-z0-9-]+$/.test(id||''))throw Error('Select a registered helper profile id.');
 const profile=JSON.parse(fs.readFileSync(path.join(root,'profiles',id+'.json')));
 if(profile.id!==id||!path.isAbsolute(input||'')||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select a helper profile, absolute input and new output directory.');
 input=fs.realpathSync(input);output=path.resolve(output);
 if(output===input||output.startsWith(input+path.sep)||input.startsWith(output+path.sep))throw Error('Helper output must be separate from its input.');
 const names=new Set();
 for(const file of profile.inputs){
  B.relativeFile(file.path);B.relativeFile(file.output);
  if(names.has(file.output)||!['file'].includes(file.kind))throw Error('Invalid helper source inventory.');
  names.add(file.output);
  const source=path.join(input,file.path),stored=B.readRegular(source,B.LIMITS.fileBytes);
  if(stored.sha256!==file.sha256||stored.size!==file.size)throw Error('Helper input differs from its pinned production file: '+file.path);
 }
 fs.mkdirSync(output,{recursive:true});
 try{
  for(const file of profile.inputs){
   const target=path.join(output,file.output);fs.mkdirSync(path.dirname(target),{recursive:true});
   fs.copyFileSync(path.join(input,file.path),target,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,file.mode);
   if(file.architectures){
    const actual=Native.macho(target);
    if(!actual||JSON.stringify([...actual].sort())!==JSON.stringify([...file.architectures].sort()))throw Error('Helper Mach-O CPU slices differ from its profile.');
    for(const arch of actual){
     const commands=Native.loadCommands(target,arch);
     if(!B.versionAtLeast(profile.minimumMacOS,commands.minimumMacOS))throw Error('Helper exceeds its declared macOS floor.');
     const ids=Native.libraryIds(target,arch);
     for(const link of Native.links(target,arch).filter(link=>!ids.includes(link))){
      const resolved=Native.resolveLink(link,target,target,commands.rpaths,arch);
      if(resolved&&!resolved.startsWith(fs.realpathSync(output)+path.sep))throw Error('Helper has an external native dependency.');
     }
    }
    try{run('/usr/bin/codesign',['--verify','--strict',target]);}
    catch{run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',target]);run('/usr/bin/codesign',['--verify','--strict',target]);}
   }
  }
  const files=profile.inputs.map(input=>{
   const stored=B.readRegular(path.join(output,input.output),B.LIMITS.fileBytes);
   return {path:input.output,size:stored.size,mode:stored.mode,sha256:stored.sha256,...(input.architectures?{architectures:input.architectures}:{})};
  });
  const manifest={schemaVersion:1,id:profile.id,...(profile.managedManifest || {}),version:profile.version,arch:profile.arch,minimumMacOS:profile.minimumMacOS,
   ...(profile.executableRelative?{executableRelative:profile.executableRelative}:{}),files,notices:profile.notices,source:profile.source};
  const manifestBytes=json(manifest);fs.writeFileSync(path.join(output,'manifest.json'),manifestBytes,{flag:'wx',mode:0o644});
  files.push({path:'manifest.json',size:manifestBytes.length,mode:0o644,sha256:hash(manifestBytes)});
  const declaration={id:profile.id,version:profile.version,arch:profile.arch,launcherArchitectures:profile.launcherArchitectures,
   minimumMacOS:profile.minimumMacOS,sourceRelative:null,sourceSha256:hash(json(profile)),directoryRelative:[id,profile.version,profile.arch].join('/'),
   manifestRelative:'manifest.json',manifestSha256:hash(manifestBytes),files,notices:profile.notices,redistribution:'bundle'};
  validateDeclaration(declaration);B.verifyPayload(output,declaration);
  return declaration;
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}

export function main(args){
 const o={};for(let n=0;n<args.length;n+=2){const key=args[n]?.slice(2);if(!args[n]?.startsWith('--')||!['id','input','output'].includes(key)||!args[n+1]||Object.hasOwn(o,key))throw Error('Use --id, --input and --output.');o[key]=key==='id'?args[n+1]:path.resolve(args[n+1]);}
 const declaration=prepare(o);fs.writeFileSync(o.output+'.json',json(declaration),{flag:'wx'});return {id:declaration.id,version:declaration.version,files:declaration.files.length,output:o.output};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
