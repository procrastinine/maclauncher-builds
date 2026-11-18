import './producer-environment.mjs';
import path from 'node:path';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {recipeMain} from './build-source.mjs';
import {preparePython} from './anyps5-python.mjs';
import {buildRelinker} from '../producers/anyps5/build-relinker.mjs';
import {buildRuntime} from '../producers/anyps5/build-runtime.mjs';
import {packageRuntime} from '../producers/anyps5/package-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** Compile the AnyPS5 converter and x86-64 runtime. */
export async function compile({project,version,arch,work}){
 const record=buildRecord(resolveProject(project,root),version);
 const relinkerBuild=path.join(work,'relinker'),runtimeBuild=path.join(work,'runtime');
 const python=await preparePython(arch,work);
 await buildRelinker({buildDirectory:relinkerBuild,jobs:4,architecture:arch});
 await buildRuntime({buildDirectory:runtimeBuild,jobs:4,python});
 return {runtimeBuild,relinkerBuild,record};
}
/** Package the compiled runtime. */
export async function assemble({project,version,arch,output,compiled:{runtimeBuild,relinkerBuild,record}}){
 return packageRuntime({runtimeBuild,relinkerBuild,output,version:record.version,arch,buildOutput:true});
}
recipeMain(import.meta,{compile,assemble});
