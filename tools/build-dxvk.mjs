import './producer-environment.mjs';
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildInput,llvmMingwInput} from './build-input.mjs';
import {recipeMain,pythonBuildTools} from './build-source.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {buildProvider} from '../producers/dxvk/build.mjs';
import {packageProvider} from '../producers/dxvk/package.mjs';
const root=path.resolve(import.meta.dirname,'..');
export async function buildDxvk({project,arch,output,work}){
  const record=buildRecord(resolveProject(project,root,{resolvePins:false}));
  const archive=await buildInput(llvmMingwInput(),path.join(work,'downloads'));
  const toolchain=path.join(work,'llvm-mingw');fs.mkdirSync(toolchain,{recursive:true});
  execFileSync('/usr/bin/tar',['-xf',archive,'--strip-components','1','-C',toolchain],{stdio:'inherit'});
  const tools=pythonBuildTools(path.join(work,'build-tools'),path.join(root,'tools/sdk27-build-requirements.txt'));
  const built=buildProvider({jobs:6,work:path.join(work,'renderer'),output:path.join(work,'renderer-payload'),mingw:path.join(toolchain,'bin'),
    meson:path.join(tools.bin,'meson'),ninja:path.join(tools.bin,'ninja')});
  return packageProvider({input:built.output,output,project,version:record.version,arch});
}
recipeMain(import.meta,buildDxvk);
