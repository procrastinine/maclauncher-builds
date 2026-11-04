import {addLicense,addLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {recipeMain} from './build-source.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';import {nativeStackInput} from './native-stack.mjs';import {sealRuntime} from './seal-runtime.mjs';;
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Builder=require('../producers/maclauncher/src/modules/alicesoft/system3-portable.js'),Fonts=require('../producers/maclauncher/src/modules/shared/runtime/portable-sdl2-fonts.js');
export async function buildSystem3({project,arch,version,output,work,sourceDir,sdkPath}){
 sourceDir??=path.join(root,'producers/maclauncher/src/external/system3-sdl2');
 const archives={},fontStack=nativeStackInput(preparedBuildInput('native-sdl2-fonts'),{arch,work:work+'-shared-fonts'});
 const result=await Builder.buildPortableSystem3({sourceDir,archives,fontStack,workRoot:work,architecture:arch,pathMappings:[{from:work,to:'system3-build'}],dependencies:sdkPath?{readSDK:()=>sdkPath}:{}});

 addLicenses(result.dependencyClosure?.prefix,'ymfm',`${sourceDir}/deps/ymfm`);
 addLicense(result.dependencyClosure?.prefix,'MTLc3m font',`${sourceDir}/resources/fonts/MTLc3m.ttf.license`);
 return sealRuntime({project,version,arch,output,executable:result.executable,sourceRoot:sourceDir,upstreamRevision:Builder.REVISION,payloads:[{source:result.resources,relative:'share/system3'}],provenance:{}});
}
recipeMain(import.meta,buildSystem3);
