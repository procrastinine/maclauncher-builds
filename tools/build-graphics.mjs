import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {plan,build,fetchInput} from '../producers/maclauncher/scripts/build-graphics-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Build one graphics package; SDK and deployment requirements stay separate. */
export async function buildGraphics({project:id,arch,output,work,sdkPath,sources={},sourceRoot,reuse={},tools={}}){
 const project=resolveProject(id,root,{resolvePins:false}),registered=buildRecord(project);
 if(id!=='reshade'||!registered.architectures.includes(arch)||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||''))throw Error('Select reshade, a declared architecture and new absolute output and work directories.');
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
export async function main(args){const o={};for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['project','arch','output','work'].includes(key)||!args[i+1]||Object.hasOwn(o,key))throw Error('Use --project, --arch, --output and --work.');o[key]=args[i+1];}return buildGraphics(o);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
