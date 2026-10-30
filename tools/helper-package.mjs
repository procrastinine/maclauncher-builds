import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),Native=require('../lib/local-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
const Tools=require('../producers/maclauncher/scripts/native-binary-tools.cjs');
export const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Finish a helper built in payload/, recording its actual files and native CPUs. */
export function helperPackage({id,version,arch,output,minimumMacOS,sourceSha256,record,notices,manifestRelative='helper.json',rosettaFiles=[]}){
 const payload=path.join(output,'payload'),cpus=arch==='universal'?['arm64','x86_64']:[arch==='x64'?'x86_64':arch];
 const inventory=B.fileInventory(payload).map(relative=>{
  const file=path.join(payload,relative),stat=fs.statSync(file),architectures=Tools.macho(file);
  if(architectures){
   if(JSON.stringify([...architectures].sort())!==JSON.stringify(cpus))throw Error('Helper CPU slices differ from '+arch+': '+relative);
   for(const cpu of cpus)if(!B.versionAtLeast(minimumMacOS,Tools.loadCommands(file,cpu).minimumMacOS))throw Error('Helper exceeds declared macOS minimum: '+relative);
  }
  return {path:relative,size:stat.size,sha256:sha(file),mode:stat.mode&0o777,...(architectures?{architectures,...(rosettaFiles.includes(relative)?{executionArchitecture:'x86_64'}:{})}:{})};
 });
 const manifest={schemaVersion:1,id,version,arch,minimumMacOS,architectures:cpus,sourceSha256,...record,files:inventory,notices};
 fs.writeFileSync(path.join(payload,manifestRelative),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
 const stored=B.readRegular(path.join(payload,manifestRelative),B.LIMITS.manifestBytes);
 const files=[...inventory,{path:manifestRelative,size:stored.size,sha256:stored.sha256,mode:stored.mode}];
 const declaration={id,version,arch,minimumMacOS,launcherArchitectures:arch==='universal'||arch==='x64'&&rosettaFiles.length?['arm64','x64']:[arch],sourceRelative:null,sourceSha256,
  directoryRelative:[id,version,arch].join('/'),manifestRelative,manifestSha256:sha(path.join(payload,manifestRelative)),files,notices};
 validateDeclaration(declaration);B.verifyPayload(payload,declaration);
 fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});return {project:id,version,arch,output};
}
