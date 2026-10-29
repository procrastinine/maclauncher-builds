import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),Native=require('../../maclauncher/scripts/native-binary-tools.cjs');
const root=path.dirname(fileURLToPath(import.meta.url)),pins=JSON.parse(fs.readFileSync(path.join(root,'sources.json')));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const runners=['2026.0.0.23','2024.13.1.242','2.3.7.476','1.4.9999','2.2.5.378'];
const vendor='d63b5d5152d427b333b64883c26edc6701214d0a5ad027fa6f09e579fa31c1b0';
export function source(version=pins[0].version){
 const pin=pins.find(pin=>pin.version===version);if(!pin)throw Error('Select a listed software OpenGL source profile.');
 const file=path.join(root,pin.sourceFile),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||digest(fs.readFileSync(file))!==pin.sourceSha256)throw Error('Software OpenGL source differs from its profile.');
 return {pin,file};
}
export function build({version=pins[0].version,output}){
 const {pin,file}=source(version);
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Choose a new absolute build output directory.');
 output=path.join(fs.realpathSync(path.dirname(path.resolve(output))),path.basename(output));
 if(output===root||output.startsWith(root+path.sep)||root.startsWith(output+path.sep))throw Error('Build output must be separate from source.');
 const args=['-dynamiclib','-arch','arm64','-arch','x86_64','-mmacosx-version-min=13.0','-Wno-deprecated-declarations',
  ...(version==='software-gl-v1-universal'?[]:['-install_name','@rpath/software-opengl.dylib']),'-framework','AppKit'];
 const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 fs.mkdirSync(output);
 try{
  const dylibPath=path.join(output,'software-opengl.dylib');
  run('/usr/bin/clang',[...args,file,'-o',dylibPath]);
  run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',dylibPath]);
  run('/usr/bin/codesign',['--verify','--strict',dylibPath]);
  const architectures=Native.macho(dylibPath);
  if(!architectures||!['arm64','x86_64'].every(arch=>architectures.includes(arch)))throw Error('Software OpenGL output lacks its universal CPU slices.');
  for(const arch of architectures){
   if(Native.loadCommands(dylibPath,arch).minimumMacOS!=='13.0')throw Error('Software OpenGL output has a different macOS floor.');
   const ids=Native.libraryIds(dylibPath,arch);
   if(Native.links(dylibPath,arch).some(link=>!ids.includes(link)&&!link.startsWith('/usr/lib/')&&!link.startsWith('/System/Library/')))throw Error('Software OpenGL output has an external dependency.');
  }
  source(version);
  const record={version,sourceSha256:pin.sourceSha256,binarySha256:digest(fs.readFileSync(dylibPath)),architecture:'universal',
   minimumMacOS:'13.0',architectures:['arm64','x86_64'],supportedRunnerVersions:runners,testedVendorSha256:vendor,
   legacyLogicalRunnerVersions:pin.legacyLogicalRunnerVersions,compilerArgs:args};
  fs.writeFileSync(path.join(output,'helper.json'),JSON.stringify(record,null,2)+'\n');
  fs.copyFileSync(path.join(root,'LICENSE'),path.join(output,'license.txt'));
  return {...record,dylibPath,output};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
export function main(args){const o={};for(let n=0;n<args.length;n+=2){const key=args[n]?.slice(2);if(!args[n]?.startsWith('--')||!['version','output'].includes(key)||!args[n+1]||Object.hasOwn(o,key))throw Error('Use --version and --output.');o[key]=args[n+1];}return build(o);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
