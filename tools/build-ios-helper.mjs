import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..'),o={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]?.slice(2);if(!['project','arch','output','work'].includes(key)||!process.argv[i+1]||Object.hasOwn(o,key))throw Error('Use --project, --arch, --output and --work.');o[key]=process.argv[i+1];}
if(o.project!=='ios-playtools-paths'||o.arch!=='arm64'||!path.isAbsolute(o.output||'')||fs.existsSync(o.output)||!path.isAbsolute(o.work||'')||fs.existsSync(o.work))throw Error('Select ios-playtools-paths, arm64 and new absolute output and work directories.');
const project=resolveProject(o.project,root,{resolvePins:false}),source=path.join(root,project.producer.sourceDirectory,'src/modules/ios/native'),payload=path.join(o.output,'payload');
fs.mkdirSync(payload,{recursive:true});fs.mkdirSync(o.work,{recursive:true});
try {
 execFileSync(process.execPath,[path.join(source,'build.mjs'),payload],{stdio:'inherit',env:{...process.env,CLANG_MODULE_CACHE_PATH:path.join(o.work,'clang-modules'),SWIFT_MODULECACHE_PATH:path.join(o.work,'swift-modules')},timeout:120000});
 fs.copyFileSync(path.join(root,'producers/maclauncher/LICENSE'),path.join(payload,'license.txt'));
 const library=path.join(payload,'libplaytools-paths.dylib');
 console.log(JSON.stringify(helperPackage({id:o.project,version:project.build.version,arch:o.arch,output:o.output,minimumMacOS:'12.0',sourceSha256:sha(path.join(source,'playtools-paths.swift')),
  record:{binarySha256:sha(library),scope:'private-playtools-file-url-and-vendor-identifier',build:{signing:'ad-hoc',installName:'@rpath/libplaytools-paths.dylib'}},notices:[{name:'MacLauncher PlayTools storage adapter',license:'MIT',path:'license.txt'}]})));
}catch(error){fs.rmSync(o.output,{recursive:true,force:true});throw error;}finally{fs.rmSync(o.work,{recursive:true,force:true});}
