import './producer-environment.mjs';
import {addLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {helperPackage,sha} from './helper-package.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Compile the PlayTools path helper into the package payload directory. */
export function compile({project:id,output,work}){
 const project=resolveProject(id,root,{resolvePins:false}),source=path.join(root,project.producer.sourceDirectory,'src/modules/ios/native'),payload=path.join(output,'payload');
 fs.mkdirSync(payload,{recursive:true});fs.mkdirSync(work,{recursive:true});
 try {
  execFileSync(process.execPath,[path.join(source,'build.mjs'),payload],{maxBuffer:Infinity,stdio:'inherit',env:{...process.env,CLANG_MODULE_CACHE_PATH:path.join(work,'clang-modules'),SWIFT_MODULECACHE_PATH:path.join(work,'swift-modules')},timeout:120000});
  return {project,source,payload};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});fs.rmSync(work,{recursive:true,force:true});throw error;}
}
/** Add the notices and describe the compiled helper. */
export function assemble({project:id,arch,output,work,compiled:{project,source,payload}}){
 try {
  addLicenses(payload,'MacLauncher',root);
  const library=path.join(payload,'libplaytools-paths.dylib');
  return helperPackage({id,version:project.build.version,arch,output,minimumMacOS:'12.0',sourceSha256:sha(path.join(source,'playtools-paths.swift')),record:{binarySha256:sha(library),scope:'private-playtools-file-url-and-vendor-identifier',build:{signing:'ad-hoc',installName:'@rpath/libplaytools-paths.dylib'}}});
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}finally{fs.rmSync(work,{recursive:true,force:true});}
}
recipeMain(import.meta,{compile,assemble});
