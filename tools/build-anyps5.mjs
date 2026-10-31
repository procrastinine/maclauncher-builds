import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInput} from './build-input.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
import {buildRelinker} from '../producers/anyps5/build-relinker.mjs';
import {buildRuntime} from '../producers/anyps5/build-runtime.mjs';
import {packageRuntime} from '../producers/anyps5/package-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
export async function buildAnyPS5({project,version,arch,output,work}){
 const record=buildRecord(resolveProject(project,root),version);
 const relinkerBuild=path.join(work,'relinker'),runtimeBuild=path.join(work,'runtime');
 fs.mkdirSync(work,{recursive:true});
 const pythonPin=JSON.parse(fs.readFileSync(path.join(root,'producers/anyps5/dependencies.json'))).artifacts.find(input=>input.id==='build-python-'+arch);
 if(!pythonPin)throw Error('The requested CPU has no declared Python build interpreter.');
 const archive=await buildInput(pythonPin,path.join(work,'downloads')),pythonBase=path.join(work,'python-source'),pythonEnvironment=path.join(work,'python');
 fs.mkdirSync(pythonBase);execFileSync('/usr/bin/tar',['-xzf',archive,'-C',pythonBase]);
 execFileSync(path.join(pythonBase,'python/bin/python3'),['-m','venv','--without-pip',pythonEnvironment],{stdio:'inherit'});
 const python=path.join(pythonEnvironment,'bin/python3');
 if(execFileSync(python,['--version'],{encoding:'utf8'}).trim()!=='Python '+pythonPin.version)throw Error('The declared Python build interpreter has a different version.');
 await buildRelinker({buildDirectory:relinkerBuild,jobs:4,architecture:arch});
 await buildRuntime({buildDirectory:runtimeBuild,jobs:4,python});
 return packageRuntime({runtimeBuild,relinkerBuild,output,version:record.version,arch,buildOutput:true});
}
recipeMain(import.meta,buildAnyPS5);
