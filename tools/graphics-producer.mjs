import './producer-environment.mjs';
import {appSourceRoot} from './app-source.mjs';
import sdlHeaders from '../producers/dependencies/sdlHeaders.json' with {type:'json'};
import spirvCross from '../producers/dependencies/spirvCross.json' with {type:'json'};
import {checkoutSource,placeDeclaredSource} from './build-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
/** Build one graphics package; SDK and deployment requirements stay separate. */
export async function buildGraphicsSource({version,arch,output,work,sdkPath,sources={},sourceRoot,reuse={},tools={},inputs={}}){
 appSourceRoot();
 const {plan,build,fetchInput}=await import('../producers/package-support/scripts/build-graphics-runtime.mjs');
 if(!version)throw Error('An exact registered graphics source-stage version is required.');
 if(tools.meson&&!tools.python){const candidate=path.join(path.dirname(tools.meson),"python");if(fs.existsSync(candidate))tools.python=candidate;}
 const cross=path.join(work,'spirv-cross-source');
 if(!fs.existsSync(path.join(cross,'.git')))checkoutSource({...spirvCross,destination:cross});
 sources['macfx-spirv-cross']=cross;
 if(!sources['sdl-vulkan'])sources['sdl-vulkan']=placeDeclaredSource(sdlHeaders,path.join(work,'sdl-headers-source'));
 const options={jobs:6,work,arch,sdkPath,sources,reuse,tools,inputs},initial=plan(options);
 const blocked=initial.unresolved.filter(value=>(!value.startsWith('input ')||!value.endsWith(': fetchable'))&&!['tool meson: missing','tool ninja: missing'].includes(value));
 if(blocked.length)throw Error('Unresolved graphics build inputs:\n  '+blocked.join('\n  '));
 fs.mkdirSync(work,{recursive:true});
 const context=path.join(work,"graphics-build.json"),identity={project:'reshade',version,arch};
 if(fs.existsSync(context)&&JSON.stringify(JSON.parse(fs.readFileSync(context)))!==JSON.stringify(identity))throw Error("The graphics work directory belongs to another version or CPU.");
 if(!fs.existsSync(context))fs.writeFileSync(context,JSON.stringify(identity)+"\n",{flag:"wx"});
 if(!tools.meson||!tools.ninja){
  const environment=path.join(work,'build-tools');
  if(!fs.existsSync(environment))execFileSync('uv',['venv','--python','3.13',environment],{maxBuffer:Infinity,stdio:'inherit',timeout:120000});
  execFileSync('uv',['pip','install','--python',path.join(environment,'bin/python'),'--no-deps','--requirement',path.join(root,'producers/package-support/scripts/graphics-build-requirements.txt')],{maxBuffer:Infinity,stdio:'inherit',timeout:120000});
  Object.assign(tools,{meson:path.join(environment,'bin/meson'),ninja:path.join(environment,'bin/ninja'),python:path.join(environment,'bin/python')});
 }
 for(const input of Object.values(initial.inputs))if(input.state==='fetchable')await fetchInput(input.id,work);
 const resolved=await build(options);fs.mkdirSync(output,{recursive:true});
 try {
  execFileSync(process.execPath,[...resolved.stage,'--version',version,'--output',path.join(output,'payload'),'--declaration',path.join(output,'declaration.json'),...(sourceRoot?['--source-root',sourceRoot]:[])],
   {maxBuffer:Infinity,cwd:root,stdio:'inherit',timeout:600000});
  return {project:'reshade',version,arch,output,resolved,tools};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
