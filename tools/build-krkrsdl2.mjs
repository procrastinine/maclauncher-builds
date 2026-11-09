import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {stageSource,run,recipeMain} from "./build-source.mjs";
import {sealRuntime} from './seal-runtime.mjs';
import {addLicense,addLicenses} from '../lib/licenses.mjs';
import {upstreamRevision} from '../lib/projects.mjs';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),Compat=require('../producers/package-support/src/modules/kirikiri/native-compat.js');
// The packaged KAG3 manifest names the kag3 revision its files come from, read from the kag3 gitlink.
export function stageKag3Resources(work){
 const resources=path.join(root,'producers/vn-adaptations/kag3-polyfill'),staged=path.join(work,'kag3-polyfill'),revision=upstreamRevision('krkrsdl2','kag3');
 fs.cpSync(resources,staged,{recursive:true});
 const {schema,id,sourceUrl,...rest}=JSON.parse(fs.readFileSync(path.join(resources,'manifest.json'),'utf8'));
 fs.writeFileSync(path.join(staged,'manifest.json'),JSON.stringify({schema,id,upstreamRevision:revision,sourceUrl:sourceUrl+'/tree/'+revision,...rest},null,2)+'\n');
 return staged;
}
/** Compile krkrsdl2 from its staged source. */
export async function compile({arch,work}){
 fs.mkdirSync(work,{recursive:true});const sourceRoot=path.join(root,'producers/package-support/src/external/krkrsdl2'),source=path.join(work,'source'),build=path.join(work,'build');
 const staged=await stageSource(sourceRoot,Compat.REVISION,source),overlay=Compat.prepareSource({sourceRoot:source,revision:Compat.REVISION});
 const header=path.join(root,'producers/package-support/src/modules/kirikiri/overlays/macos-compat.h'),cpu=arch==='x64'?'x86_64':'arm64';
 const flags=['-ffile-prefix-map='+work+'=krkrsdl2-build','-fdebug-prefix-map='+work+'=krkrsdl2-build','-include '+header].join(' ');
 run('cmake',['-S',source,'-B',build,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_ARCHITECTURES='+cpu,'-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_POLICY_VERSION_MINIMUM=3.12','-DOPTION_BUILD_MACOS_BUNDLE=OFF','-DOPTION_ENABLE_EXTERNAL_PLUGINS=OFF','-DFETCHCONTENT_FULLY_DISCONNECTED=ON','-DFETCHCONTENT_UPDATES_DISCONNECTED=ON','-DSDL_SHARED=OFF','-DSDL_STATIC=ON','-DSDL_TEST=OFF','-DCMAKE_C_FLAGS='+flags,'-DCMAKE_CXX_FLAGS='+flags+' -DKRKRSDL2_RENDERER_FULL_UPDATES']);
 run('cmake',['--build',build,'--parallel','2']);
 return {source,build,sourceRoot,staged,overlay};
}
/** Add the notices and the KAG3 resources, then seal the compiled engine. */
export async function assemble({project,arch,output,work,compiled:{source,build,sourceRoot,staged,overlay}}){
 const resources=path.join(root,'producers/vn-adaptations/kag3-polyfill');
 addLicense(work,'KAG3 polyfill font',path.join(resources,'FONT_LICENSE.txt'));
 addLicenses(work,'FAudio',path.join(source,'external/FAudio'));
 addLicenses(work,'SDL',path.join(source,'external/SDL'));
 addLicenses(work,'SDL HIDAPI',path.join(source,'external/SDL/src/hidapi'));
 addLicense(work,'SDL HIDAPI',path.join(source,'external/SDL/src/hidapi/AUTHORS.txt'));
 addLicenses(work,'SDL yuv2rgb',path.join(source,'external/SDL/src/video/yuv2rgb'));
 addLicenses(work,'krkrz',path.join(source,'external/krkrz'));
 addLicenses(work,'ANGLE headers',path.join(source,'external/krkrz/external/angle'));
 addLicenses(work,'FreeType',path.join(source,'external/krkrz/external/freetype/docs'));
 addLicense(work,'FreeType',path.join(source,'external/krkrz/external/freetype/docs/FTL.TXT'));
 addLicenses(work,'glm',path.join(source,'external/krkrz/external/glm'));
 addLicenses(work,'jxrlib',path.join(source,'external/krkrz/external/jxrlib'));
 addLicenses(work,'libjpeg-turbo',path.join(source,'external/krkrz/external/libjpeg-turbo'));
 addLicense(work,'libjpeg-turbo',path.join(source,'external/krkrz/external/libjpeg-turbo/README.ijg'));
 addLicenses(work,'libogg',path.join(source,'external/krkrz/external/libogg'));
 addLicenses(work,'libpng',path.join(source,'external/krkrz/external/lpng'));
 addLicenses(work,'Oniguruma',path.join(source,'external/krkrz/external/onig'));
 addLicenses(work,'Opus',path.join(source,'external/krkrz/external/opus'));
 addLicenses(work,'opusfile',path.join(source,'external/krkrz/external/opusfile'));
 addLicenses(work,'SIMDe',path.join(source,'external/simde'));
 return sealRuntime({project,arch,output,executable:path.join(build,'krkrsdl2'),sourceRoot,upstreamRevision:Compat.REVISION,payloads:[{source:stageKag3Resources(work),relative:'share/kag3-polyfill'}],runtimeFiles:{kag3Manifest:'share/kag3-polyfill/manifest.json'},provenance:{sourceTreeSha256:staged.treeSha256,gitDependencies:staged.dependencies,sourceOverlay:overlay,features:{storageDirlist:true,systemAddFont:true,monitorAdjust:true,fullFramePresentation:true,kag3Resources:1}}});
}
recipeMain(import.meta,{compile,assemble});
