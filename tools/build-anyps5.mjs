import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {buildOptions} from './build-source.mjs';
import {buildRelinker} from '../producers/anyps5/build-relinker.mjs';
import {buildRuntime} from '../producers/anyps5/build-runtime.mjs';
import {packageRuntime} from '../producers/anyps5/package-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
export async function buildAnyPS5({project,arch,output,work}){
 if(project!=='anyps5'||arch!=='arm64'||process.arch!=='arm64'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select AnyPS5 ARM64 and new absolute work/output paths.');
 const record=buildRecord(resolveProject(project,root));
 const relinkerBuild=path.join(work,'relinker'),runtimeBuild=path.join(work,'runtime');
 fs.mkdirSync(work,{recursive:true});
 const pythonPin=JSON.parse(fs.readFileSync(path.join(root,'producers/anyps5/dependencies.json'))).artifacts.find(input=>input.id==='build-python-arm64');
 const archive=await buildInput(pythonPin,path.join(work,'downloads')),pythonBase=path.join(work,'python-source'),pythonEnvironment=path.join(work,'python');
 fs.mkdirSync(pythonBase);execFileSync('/usr/bin/tar',['-xzf',archive,'-C',pythonBase]);
 execFileSync(path.join(pythonBase,'python/bin/python3'),['-m','venv','--without-pip',pythonEnvironment],{stdio:'inherit'});
 const python=path.join(pythonEnvironment,'bin/python3');
 if(execFileSync(python,['--version'],{encoding:'utf8'}).trim()!=='Python '+pythonPin.version)throw Error('The declared Python build interpreter has a different version.');
 await buildRelinker({buildDirectory:relinkerBuild,jobs:4});
 await buildRuntime({buildDirectory:runtimeBuild,jobs:4,python});
 return packageRuntime({runtimeBuild,relinkerBuild,output,version:record.version,buildOutput:true});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildAnyPS5(buildOptions(process.argv.slice(2))).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
