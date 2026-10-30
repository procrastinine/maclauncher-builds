import fs from 'node:fs';import path from 'node:path';import{pathToFileURL}from'node:url';
import{resolveProject,buildRecord}from'../lib/projects.mjs';import{build}from'../producers/included-helpers/gamemaker-opengl-helper/build.mjs';import{helperPackage}from'./helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..');
export function buildOpenGL({project:id,arch,work,output}){
 const project=resolveProject(id,root,{resolvePins:false}),registered=buildRecord(project);
 if(id!=='gamemaker-opengl-helper'||arch!=='universal'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select the Universal GameMaker OpenGL helper and new work/output directories.');
 fs.mkdirSync(work,{recursive:true});const result=build({version:'software-gl-v3-universal',output:path.join(work,'compiled')}),profile=JSON.parse(fs.readFileSync(path.join(root,'producers/included-helpers/profiles/gamemaker-opengl-helper.json'))),payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 for(const name of ['software-opengl.dylib','helper.json','license.txt']){fs.copyFileSync(path.join(result.output,name),path.join(payload,name));fs.chmodSync(path.join(payload,name),name.endsWith('.dylib')?0o755:0o644);}
 return helperPackage({id,version:registered.version,arch,output,minimumMacOS:result.minimumMacOS,sourceSha256:result.sourceSha256,manifestRelative:'manifest.json',record:{...profile.managedManifest,executableRelative:profile.executableRelative,source:profile.source},notices:profile.notices});
}
export function main(args){const options={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','arch','output','work'].includes(key)||!args[i+1]||Object.hasOwn(options,key))throw Error('Use --project, --arch, --output and --work.');options[key]=args[i+1];}return buildOpenGL(options);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error);process.exitCode=1;}
