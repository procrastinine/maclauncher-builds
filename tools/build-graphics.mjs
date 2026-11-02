import path from 'node:path';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {buildGraphicsSource} from './graphics-producer.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
export async function buildGraphics({project:id,version,...options}){
 const registered=buildRecord(resolveProject(id,root,{resolvePins:false}),version),moltenvk=preparedBuildInput('graphics-moltenvk');
 if(!moltenvk)throw Error('Graphics requires the prepared graphics-moltenvk package.');
 await buildGraphicsSource({...options,version:registered.version,inputs:{moltenvk:moltenvk.root}});
 return {project:id,version:registered.version,arch:options.arch,output:options.output};
}
recipeMain(import.meta,buildGraphics);
