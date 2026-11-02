import path from 'node:path';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {buildGraphicsSource} from './graphics-producer.mjs';
import {recipeMain} from './build-source.mjs';
const root=path.resolve(import.meta.dirname,'..');
export async function buildGraphics({project:id,version,...options}){
 const registered=buildRecord(resolveProject(id,root,{resolvePins:false}),version);
 await buildGraphicsSource({...options,version:registered.version});
 return {project:id,version:registered.version,arch:options.arch,output:options.output};
}
recipeMain(import.meta,buildGraphics);
