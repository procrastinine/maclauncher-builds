import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {build} from '../producers/android-launcher/build.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/android-launcher');
export async function buildAndroidLauncher({project:id,arch,output,work}){
 const project=resolveProject(id,root,{resolvePins:false}),profile=JSON.parse(fs.readFileSync(path.join(root,'producers/included-helpers/profiles/android-launcher.json'))),input=JSON.parse(fs.readFileSync(path.join(base,'build-inputs.json')));
 fs.mkdirSync(work,{recursive:true});const cache=path.join(work,'archives');
 try {
  // Android's android-host.jar classes and android-framework.jar are this build stage's products, unchanged.
  const framework=preparedBuildInput('android-java-framework');if(!framework)throw Error('The Android launcher build needs the android-java-framework input.');
  const classpath=[path.join(framework.root,'build/classes'),path.join(framework.root,'products/android-framework.jar')];
  let jdk;
  if(process.platform==='linux'){
   const pin=input.jdk?.['linux-'+process.arch];if(!pin)throw Error('No JDK input is declared for this Linux host.');
   const archive=await buildInput(pin,cache),directory=path.join(work,'jdk');fs.mkdirSync(directory);
   execFileSync('/usr/bin/tar',['-xzf',archive,'-C',directory],{maxBuffer:Infinity});fs.unlinkSync(archive);
   const homes=fs.readdirSync(directory).map(name=>path.join(directory,name)).filter(home=>fs.existsSync(path.join(home,'bin/javac')));
   if(homes.length!==1)throw Error('The pinned JDK must contain one Java compiler.');jdk=homes[0];
  }else jdk=process.env.JAVA_HOME||execFileSync('/usr/libexec/java_home',['-v','21'],{maxBuffer:Infinity,encoding:'utf8'}).trim();
  const built=path.join(work,'compiled');build({jdk,classpath,output:built});
  const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
  for(const entry of profile.inputs){
   const generated=path.join(built,entry.path);
   if(entry.path.endsWith('.jar')&&!fs.existsSync(generated))throw Error('The source build did not produce '+entry.path);
   const file=fs.existsSync(generated)?generated:path.join(base,'supplied',entry.path);
   if(!fs.existsSync(generated)&&sha(file)!==entry.sha256)throw Error('Supplied integration file differs: '+entry.path);
   const target=path.join(payload,entry.output);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);fs.chmodSync(target,entry.mode);
  }
  return helperPackage({id:project.id,version:project.build.version,arch,output,minimumMacOS:profile.minimumMacOS,sourceSha256:sha(path.join(base,'source.json')),manifestRelative:'manifest.json',record:{source:profile.source}});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,buildAndroidLauncher);
