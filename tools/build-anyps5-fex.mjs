import './producer-environment.mjs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {recipeMain} from './build-source.mjs';
import {preparePython} from './anyps5-python.mjs';
import {buildRuntime} from '../producers/anyps5/build-runtime.mjs';
import {packageRuntime} from '../producers/anyps5-fex/package-runtime.mjs';

export async function compile({arch,work}){
 const python=await preparePython(arch,work);
 const arm=path.join(work,'runtime'),host=path.join(work,'host');
 await buildRuntime({buildDirectory:arm,libraryArchitecture:'arm64',configureOnly:true,python});
 const recipe=path.join(import.meta.dirname,'../producers/anyps5-fex/build-proof.mjs');
 execFileSync(process.execPath,[recipe,'--anyps5-arm64',arm,'--out',host,'--python',python],{stdio:'inherit'});
 return {startBuild:path.join(host,'build/Bin')};
}
export async function assemble({version,output,compiled:{startBuild}}){
 return packageRuntime({startBuild,output,version,buildOutput:true});
}
recipeMain(import.meta,{compile,assemble});
