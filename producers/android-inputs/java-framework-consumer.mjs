import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const metadata=input=>JSON.parse(fs.readFileSync(path.join(input,'input.json')));
function copy(input,manifest,name,destination){
 const record=manifest.files.find(file=>file.path===name),bytes=fs.readFileSync(path.join(input,name));
 if(!record||record.size!==bytes.length||digest(bytes)!==record.sha256)throw Error('Framework Java product differs from its verified input: '+name);
 fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes,{mode:record.mode});
}
/** Restore original supplemental module products into this invocation's owned build tree. */
export function stageJavaFrameworkModules({input,build}){
 const manifest=metadata(input),archives=[],notices=[];
 for(const name of manifest.modules){
  if(path.basename(name)!==name||!name.endsWith('.jar'))throw Error('The Java framework module name is invalid.');
  const module=name.slice(0,-4),directory=path.join(build,'framework-modules',module),archive=path.join(directory,name),notice=path.join(directory,'notices');fs.rmSync(directory,{recursive:true,force:true});copy(input,manifest,'modules/'+name,archive);
  for(const file of manifest.files.filter(file=>file.path.startsWith('notices/'+module+'/')))copy(input,manifest,file.path,path.join(notice,file.path.slice(('notices/'+module+'/').length)));
  archives.push(archive);notices.push({name:module,path:notice});
 }
 return {archives,notices};
}
/** Native compilation consumes the same classes, complete framework and JNI declarations. */
export function stageJavaFramework({input,build,output,graphicsRegistrations}){
 const manifest=metadata(input);
 if(!graphicsRegistrations||digest(fs.readFileSync(graphicsRegistrations))!==manifest.graphicsRegistrationsSha256)throw Error('The Java framework graphics declarations differ from the native source profile.');
 for(const name of ['framework-tool','classes','framework-declarations','jni','host-callbacks.h','host-callbacks.c'])fs.rmSync(path.join(build,name),{recursive:true,force:true});
 fs.rmSync(path.join(output,'android-root/system/usr/hyphen-data'),{recursive:true,force:true});
 for(const file of manifest.files){
  if(file.path.startsWith('build/'))copy(input,manifest,file.path,path.join(build,file.path.slice(6)));
  else if(file.path.startsWith('products/'))copy(input,manifest,file.path,path.join(output,file.path.slice(9)));
 }
 return {frameworkTool:path.join(build,'framework-tool'),hostClasses:path.join(build,'classes')};
}
