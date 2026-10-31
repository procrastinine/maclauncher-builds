import fs from 'node:fs';import path from 'node:path';import{resolveProject,buildRecord}from'../lib/projects.mjs';import{build}from'../producers/included-helpers/gamemaker-opengl-helper/build.mjs';import{helperPackage}from'./helper-package.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
export function buildOpenGL({project:id,arch,work,output}){
 const project=resolveProject(id,root,{resolvePins:false}),registered=buildRecord(project);
 fs.mkdirSync(work,{recursive:true});const result=build({version:'software-gl-v3-universal',output:path.join(work,'compiled')}),profile=JSON.parse(fs.readFileSync(path.join(root,'producers/included-helpers/profiles/gamemaker-opengl-helper.json'))),payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 for(const name of ['software-opengl.dylib','helper.json','license.txt']){fs.copyFileSync(path.join(result.output,name),path.join(payload,name));fs.chmodSync(path.join(payload,name),name.endsWith('.dylib')?0o755:0o644);}
 return helperPackage({id,version:registered.version,arch,output,minimumMacOS:result.minimumMacOS,sourceSha256:result.sourceSha256,manifestRelative:'manifest.json',record:{...profile.managedManifest,executableRelative:profile.executableRelative,source:profile.source},notices:profile.notices});
}
recipeMain(import.meta,buildOpenGL);
