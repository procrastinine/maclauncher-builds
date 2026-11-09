import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {stageSource,run,recipeMain} from './build-source.mjs';
import {stageNativeStack} from './native-stack.mjs';
import {helperPackage} from './helper-package.mjs';
import {upstreamRevision} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
/** The OpenAL Soft commit this project's upstream pin names. */
const revision=project=>upstreamRevision(project,'openal-soft');
/** Compile OpenAL Soft from its staged source with the function-effects patch. */
export async function compile({project,arch,work}){
 fs.mkdirSync(work,{recursive:true});const original=path.join(root,'producers/package-support/src/external/openal-soft'),source=path.join(work,'source');
 const staged=await stageSource(original,revision(project),source),prefix=path.join(work,'prefix'),build=path.join(work,'build'),sdk=process.env.SDKROOT||execFileSync('/usr/bin/xcrun',['--show-sdk-path'],{maxBuffer:Infinity,encoding:'utf8'}).trim();
 run('git',['apply',path.join(root,'producers/native-openal/function-effects.patch')],{cwd:source});
 const flags=['file','debug','macro'].map(kind=>'-f'+kind+'-prefix-map='+work+'=NATIVE_STACK_BUILD').join(' '),options=['-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES='+(arch==='x64'?'x86_64':'arm64'),'-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_OSX_SYSROOT='+sdk,'-DCMAKE_INSTALL_PREFIX='+prefix,'-DCMAKE_POLICY_VERSION_MINIMUM=3.5','-DCMAKE_C_FLAGS='+flags,'-DCMAKE_CXX_FLAGS='+flags,'-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-headerpad_max_install_names','-DLIBTYPE=SHARED','-DALSOFT_UTILS=OFF','-DALSOFT_EXAMPLES=OFF','-DALSOFT_TESTS=OFF','-DALSOFT_INSTALL=ON','-DALSOFT_UPDATE_BUILD_VERSION=OFF','-DALSOFT_BACKEND_COREAUDIO=ON','-DALSOFT_REQUIRE_COREAUDIO=ON','-DALSOFT_BACKEND_PIPEWIRE=OFF','-DALSOFT_BACKEND_PULSEAUDIO=OFF','-DALSOFT_BACKEND_JACK=OFF','-DALSOFT_BACKEND_PORTAUDIO=OFF','-DALSOFT_BACKEND_SDL2=OFF','-DALSOFT_BACKEND_SDL3=OFF'];
 run('cmake',['-S',source,'-B',build,...options]);run('cmake',['--build',build,'--parallel','2']);run('cmake',['--install',build]);
 const built={prefix,sdk,architecture:arch,minimumMacOS:'13.0',version:'openal-soft-1.25.2',source:{version:'1.25.2',url:'https://github.com/kcat/openal-soft'},sourceRoot:source};
 return {built,staged};
}
/** Stage and describe the compiled OpenAL stack as its build-input package. */
export async function assemble({project,version,arch,output,work,compiled:{built,staged}}){
 const result=stageNativeStack({built,kind:'openal',arch,output,work});
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:staged.treeSha256,manifestRelative:'input.json',record:{upstreamVersion:'1.25.2',upstreamRevision:revision(project)}});
}
recipeMain(import.meta,{compile,assemble});
