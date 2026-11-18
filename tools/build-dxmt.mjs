import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as Builder from '../producers/dxmt/build.mjs';
import {recipeMain} from './build-source.mjs';
export const prepare=options=>Builder.prepare(options);
export const compile=options=>Builder.compile(options);
export const assemble=options=>Builder.assemble({...options,compiled:JSON.parse(fs.readFileSync(path.join(options.work,'compiled.json')))});
recipeMain(import.meta,{prepare,compile,assemble});
