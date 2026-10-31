import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {checkoutSource,stageSource,run} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {sha} from './helper-package.mjs';
import {prepareAndroidBuildInputs} from './android-build-inputs.mjs';
import {artElfBuildEnvironment} from './build-android-art-elf.mjs';
import {acquireLockedArtSources} from './android-art-locked-sources.mjs';
import {verifyProducer} from './build-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
const json=file=>JSON.parse(fs.readFileSync(file));
function lockValue(file,key){const matches=[...fs.readFileSync(file,'utf8').matchAll(new RegExp('^'+key+'=([^\\r\\n]+)$','gm'))];if(matches.length!==1)throw Error('Missing original ART host input '+key);return matches[0][1];}

/** Reuse sealed ART ELFs; prepare only source inputs and original Mac host tools. */
export async function prepareArtMacBuildContext({elfInput,work}){
 if(process.platform!=='darwin'||process.arch!=='arm64'||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(elfInput?.root||''))throw Error('ART host context requires sealed ART ELFs and a new work directory on Apple Silicon macOS.');
 const descriptor=path.join(root,'producers/android-art-inputs/art-source.json'),profile=json(descriptor),declaration=elfInput.declaration||json(path.join(elfInput.root,'../declaration.json'));
 validateDeclaration(declaration);B.verifyPayload(elfInput.root,declaration);
 if(declaration.id!==profile.id||declaration.version!==profile.version||declaration.arch!=='arm64'||declaration.sourceSha256!==sha(descriptor))throw Error('ART ELF input differs from its declared leaf profile.');
 const record=json(path.join(elfInput.root,declaration.manifestRelative)),android=verifyProducer(root,json(path.join(root,'runtimes/android/source.json'))),supplier=json(path.join(android,'src/modules/android/art/supplier.json'));
 if(record.aimRevision!==supplier.sources.aim.commit||record.androidSource?.repository!==profile.androidSource.repository||record.androidSource?.revision!==profile.androidSource.revision||record.sourceLockSha256!==sha(path.join(android,profile.sourceLock)))throw Error('ART ELF and host context select different original source profiles.');
 fs.mkdirSync(work,{recursive:true});
 const checkout=checkoutSource({repository:supplier.sources.aim.url,revision:supplier.sources.aim.commit,destination:path.join(work,'upstream')}),source=path.join(work,'source');await stageSource(checkout,supplier.sources.aim.commit,source);
 const {prepareArtCompilerPaths}=await import(pathToFileURL(path.join(android,profile.compilerSource)));prepareArtCompilerPaths(source,{source:checkout});
 const {sdk,python}=await prepareAndroidBuildInputs({source,work:path.join(work,'inputs')});
 const javaLock=path.join(source,'upstream/java-toolchain.lock'),archive=await buildInput({url:lockValue(javaLock,'JDK_URL'),sha256:lockValue(javaLock,'JDK_SHA256')},path.join(work,'jdk-archives')),java=path.join(work,'jdk');fs.mkdirSync(java);run('/usr/bin/tar',['-xzf',archive,'-C',java]);fs.unlinkSync(archive);
 const homes=fs.readdirSync(java).map(name=>path.join(java,name,'Contents/Home')).filter(home=>fs.existsSync(path.join(home,'bin/javac')));if(homes.length!==1)throw Error('The pinned ART JDK must supply one compiler.');
 const target=path.join(work,'target'),fetched=path.join(work,'fetched');fs.mkdirSync(target);fs.renameSync(path.join(source,'_build'),fetched);fs.symlinkSync(target,path.join(source,'target'),'dir');fs.symlinkSync(fetched,path.join(source,'_build'),'dir');
 const env=artElfBuildEnvironment({work,target,sdk,jdk:homes[0],python});run('cargo',['fetch','--locked'],{cwd:source,env});
 // This original graph target has Mac program outputs and no image/ART node dependency.
 run('cargo',['run','--offline','--locked','--release','--quiet','--package','aim-build','--bin','cargo-aim','--','build','--jobs','2','host/linux-translate'],{cwd:source,env});
 if(!fs.statSync(path.join(target,'release/linux-translate')).isFile())throw Error('The original ART Mac translator is missing.');
 acquireLockedArtSources({source,output:path.join(fetched,'aosp'),work:path.join(work,'source-downloads')});
 const xsdc=lockValue(path.join(source,'upstream/android16-xsdc.lock'),'XSDC_REVISION');checkoutSource({repository:'https://android.googlesource.com/platform/system/tools/xsdc',revision:xsdc,destination:path.join(fetched,'xsdc')});
 const art=path.join(work,'art-products');fs.mkdirSync(art);
 for(const relative of profile.outputs){const destination=path.join(art,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(elfInput.root,relative),destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);}
 fs.cpSync(path.join(elfInput.root,'notices'),path.join(art,'notices'),{recursive:true});
 return {art,build:{source,checkout,fetched,sdk,jdk:homes[0],python,target,env},record};
}
