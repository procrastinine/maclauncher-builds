import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as Arm64 from '../producers/dxmt/build.mjs';
import * as Intel from '../producers/dxmt/build-x64.mjs';
import {recipeMain} from './build-source.mjs';

const builder = options => options.arch === 'x64' ? Intel : Arm64;
export const prepare = options => builder(options).prepare(options);
export async function compile(options) {
  const result = await builder(options).compile(options);
  if (options.arch === 'x64') fs.writeFileSync(path.join(options.work, 'compiled.json'), JSON.stringify(result));
  return result;
}
export const assemble = options => builder(options).assemble({
  ...options, compiled: JSON.parse(fs.readFileSync(path.join(options.work, 'compiled.json')))
});
recipeMain(import.meta, {prepare, compile, assemble});
