import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {plan,build,fetchInput} from '../producers/maclauncher/scripts/build-graphics-runtime.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Build one graphics package; SDK and deployment requirements stay separate. */
export async function buildGraphics({project:id,arch,output,work,sdkPath,sources={},sourceRoot,reuse={},tools={}}){
 const project=resolveProject(id,root,{resolvePins:false}),registered=buildRecord(project);
 if(tools.meson&&!tools.python){const candidate=path.join(path.dirname(tools.meson),"python");if(fs.existsSync(candidate))tools.python=candidate;}
 const options={work,arch,sdkPath,sources,reuse,tools},initial=plan(options);
 const blocked=initial.unresolved.filter(value=>(!value.startsWith('input ')||!value.endsWith(': fetchable'))&&!['tool meson: missing','tool ninja: missing'].includes(value));
 if(blocked.length)throw Error('Unresolved graphics build inputs:\n  '+blocked.join('\n  '));
 fs.mkdirSync(work,{recursive:true});
 const context=path.join(work,"graphics-build.json"),identity={project:id,version:registered.version,arch};
 if(fs.existsSync(context)&&JSON.stringify(JSON.parse(fs.readFileSync(context)))!==JSON.stringify(identity))throw Error("The graphics work directory belongs to another version or CPU.");
 if(!fs.existsSync(context))fs.writeFileSync(context,JSON.stringify(identity)+"\n",{flag:"wx"});
 if(!tools.meson||!tools.ninja){
  const environment=path.join(work,'build-tools');
  if(!fs.existsSync(environment))execFileSync('uv',['venv','--python','3.13',environment],{stdio:'inherit',timeout:120000});
  execFileSync('uv',['pip','install','--python',path.join(environment,'bin/python'),'--no-deps','--requirement',path.join(root,'producers/maclauncher/scripts/graphics-build-requirements.txt')],{stdio:'inherit',timeout:120000});
  Object.assign(tools,{meson:path.join(environment,'bin/meson'),ninja:path.join(environment,'bin/ninja'),python:path.join(environment,'bin/python')});
 }
 for(const input of Object.values(initial.inputs))if(input.state==='fetchable')await fetchInput(input.id,work);
 const resolved=await build(options);fs.mkdirSync(output,{recursive:true});
 try {
  execFileSync(process.execPath,[...resolved.stage,'--version',registered.version,'--output',path.join(output,'payload'),'--declaration',path.join(output,'declaration.json'),...(sourceRoot?['--source-root',sourceRoot]:[])],
   {cwd:path.join(root,'producers/maclauncher'),stdio:'inherit',timeout:600000});
  return {project:id,version:registered.version,arch,output};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
recipeMain(import.meta,buildGraphics);
