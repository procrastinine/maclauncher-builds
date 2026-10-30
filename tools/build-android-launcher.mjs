import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {build} from '../producers/android-launcher/build.mjs';
const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/android-launcher'),o={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]?.slice(2);if(!['project','arch','output','work'].includes(key)||!process.argv[i+1]||Object.hasOwn(o,key))throw Error('Use --project, --arch, --output and --work.');o[key]=process.argv[i+1];}
if(o.project!=='android-launcher'||o.arch!=='universal'||!path.isAbsolute(o.output||'')||fs.existsSync(o.output)||!path.isAbsolute(o.work||'')||fs.existsSync(o.work))throw Error('Select android-launcher, universal data and new absolute output and work directories.');
const project=resolveProject(o.project,root,{resolvePins:false}),profile=JSON.parse(fs.readFileSync(path.join(root,'producers/included-helpers/profiles/android-launcher.json'))),input=JSON.parse(fs.readFileSync(path.join(base,'build-inputs.json')));
fs.mkdirSync(o.work,{recursive:true});
try {
 const archive=await buildInput(input.androidAPI),names=execFileSync('/usr/bin/tar',['-tzf',archive],{encoding:'utf8',maxBuffer:8<<20}).trim().split('\n'),selected=[];
 for(const name of ['android-host.jar','android-framework.jar']){
  const matches=names.filter(entry=>entry.endsWith('/'+name)||entry===name);if(matches.length!==1||matches[0].split('/').includes('..')||path.isAbsolute(matches[0]))throw Error('Android API archive has an ambiguous or unsafe '+name);selected.push(matches[0]);
 }
 const extracted=path.join(o.work,'api');fs.mkdirSync(extracted);
 execFileSync('/usr/bin/tar',['-xzf',archive,'-C',extracted,...selected]);
 const api=path.join(o.work,'classpath');fs.mkdirSync(api);for(const name of selected)fs.copyFileSync(path.join(extracted,name),path.join(api,path.basename(name)));
 const jdk=process.env.JAVA_HOME||execFileSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).trim();
 const built=path.join(o.work,'compiled');build({jdk,runtime:api,output:built});
 const payload=path.join(o.output,'payload');fs.mkdirSync(payload,{recursive:true});
 for(const entry of profile.inputs){
  const generated=path.join(built,entry.path),file=fs.existsSync(generated)?generated:path.join(base,'supplied',entry.path);
  if(!fs.existsSync(generated)&&sha(file)!==entry.sha256)throw Error('Supplied integration file differs: '+entry.path);
  const target=path.join(payload,entry.output);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);fs.chmodSync(target,entry.mode);
 }
 console.log(JSON.stringify(helperPackage({id:project.id,version:project.build.version,arch:o.arch,output:o.output,minimumMacOS:profile.minimumMacOS,sourceSha256:sha(path.join(base,'source.json')),manifestRelative:'manifest.json',record:{source:profile.source},notices:profile.notices})));
}catch(error){fs.rmSync(o.output,{recursive:true,force:true});throw error;}finally{fs.rmSync(o.work,{recursive:true,force:true});}
