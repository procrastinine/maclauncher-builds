import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {stageSource,sourceNotices,run,recipeMain} from './build-source.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Compat=require('../producers/maclauncher/src/modules/kirikiri/native-compat.js');
export async function buildKirikiri({project,arch,output,work}){
 fs.mkdirSync(work,{recursive:true});const sourceRoot=path.join(root,'producers/maclauncher/src/external/krkrsdl2'),source=path.join(work,'source'),build=path.join(work,'build');
 const staged=await stageSource(sourceRoot,Compat.REVISION,source),overlay=Compat.prepareSource({sourceRoot:source,revision:Compat.REVISION});
 const header=path.join(root,'producers/maclauncher/src/modules/kirikiri/overlays/macos-compat.h'),cpu=arch==='x64'?'x86_64':'arm64';
 const flags=['-ffile-prefix-map='+work+'=krkrsdl2-build','-fdebug-prefix-map='+work+'=krkrsdl2-build','-include '+header].join(' ');
 run('cmake',['-S',source,'-B',build,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES='+cpu,'-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_POLICY_VERSION_MINIMUM=3.12','-DOPTION_BUILD_MACOS_BUNDLE=OFF','-DOPTION_ENABLE_EXTERNAL_PLUGINS=OFF','-DFETCHCONTENT_FULLY_DISCONNECTED=ON','-DFETCHCONTENT_UPDATES_DISCONNECTED=ON','-DSDL_SHARED=OFF','-DSDL_STATIC=ON','-DSDL_TEST=OFF','-DCMAKE_C_FLAGS='+flags,'-DCMAKE_CXX_FLAGS='+flags+' -DKRKRSDL2_RENDERER_FULL_UPDATES']);
 run('cmake',['--build',build,'--parallel','2']);
 const resources=path.join(root,'producers/vn-adaptations/kag3-polyfill');
 return sealRuntime({project,arch,output,executable:path.join(build,'krkrsdl2'),sourceRoot,upstreamRevision:Compat.REVISION,
  payloads:[{source:resources,relative:'share/kag3-polyfill'}],runtimeFiles:{kag3Manifest:'share/kag3-polyfill/manifest.json'},
  notices:[...sourceNotices(source,{name:'KiriKiri SDL2',repository:'https://github.com/krkrsdl2/krkrsdl2'}),{file:path.join(resources,'FONT_LICENSE.txt'),name:'KAG3 polyfill font',license:'See original notice',sourceUrl:'https://github.com/krkrsdl2/kag3'}],
  provenance:{sourceTreeSha256:staged.treeSha256,gitDependencies:staged.dependencies,sourceOverlay:overlay,features:{storageDirlist:true,systemAddFont:true,monitorAdjust:true,fullFramePresentation:true,kag3Resources:1}}});
}
recipeMain(import.meta,buildKirikiri);
