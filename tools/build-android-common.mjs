import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyProducer} from './build-runtime.mjs';
import {checkoutAndroidCommonSources} from './android-common-sources.mjs';
import {prepareAndroidCommonPublisherInputs} from './android-common-publisher-inputs.mjs';
import {packageAndroidCommon} from './package-android-common.mjs';
import {run} from './build-source.mjs';
import {verifyAndroidJavaConverterInput} from './build-android-java-converter.mjs';
import {verifyAndroidJavaFrameworkInput} from './build-android-java-framework.mjs';
import {prepareAndroidCommonJavaProducer} from './android-common-java-inputs.mjs';
const root=path.resolve(import.meta.dirname,'..');
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',...options}).trim();
const javaSources=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?javaSources(path.join(directory,entry.name)):entry.isFile()&&entry.name.endsWith('.java')?[path.join(directory,entry.name)]:[]).sort();

/** Forward declared Ninja invocations with bounded compiler concurrency. */
export function writeAndroidNinjaLauncher({output,ninja}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(ninja||'')||!fs.statSync(ninja).isFile())throw Error('The Android Ninja launcher requires a new absolute path and the declared Ninja executable.');
 const source='#!'+process.execPath+'\nimport {spawnSync} from "node:child_process";\nconst result=spawnSync('+JSON.stringify(ninja)+',["-j2",...process.argv.slice(2)],{stdio:"inherit"});\nif(result.error)throw result.error;process.exit(result.status??1);\n';
 fs.writeFileSync(output,source,{flag:'wx',mode:0o755});return output;
}

/** Build the complete common/JVM supplier from declared source and input groups. */
export async function buildAndroidCommonInput({version,output,work,angle,codecs,aconfig,blueprint,platformPackages,java,javaFramework}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work)||!version||!angle?.angle||!codecs?.codecs||!codecs?.include||!path.isAbsolute(aconfig||'')||!blueprint?.parser||!path.isAbsolute(platformPackages||''))throw Error('The Android common producer requires its declared ANGLE, audio, flag, Blueprint and original platform package inputs.');
 const recipe=JSON.parse(fs.readFileSync(path.join(root,'runtimes/android/source.json'))),android=verifyProducer(root,recipe);
 const javaInput=java?verifyAndroidJavaConverterInput(java):null,frameworkInput=javaFramework?verifyAndroidJavaFrameworkInput(javaFramework):null;
 fs.mkdirSync(work,{recursive:true});
 const producer=javaInput||frameworkInput?prepareAndroidCommonJavaProducer({android,input:java,framework:javaFramework,output:path.join(work,'producer')}):android;
 const sources=await checkoutAndroidCommonSources({android,work:path.join(work,'sources')});
 const publisher=await prepareAndroidCommonPublisherInputs({work:path.join(work,'publisher')});
 const definition=JSON.parse(fs.readFileSync(path.join(android,'src/modules/android/native/platform-packages-binary.json')));
 for(const file of definition.files){
  const from=path.join(platformPackages,file.path),to=path.join(publisher.framework,file.path);
  fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
 }
 const pythonRoot=path.join(work,'python'),cargoHome=path.join(work,'cargo');fs.mkdirSync(cargoHome,{recursive:true});
 const pythonEnvironment={...process.env,UV_CACHE_DIR:path.join(work,'uv-cache'),UV_PYTHON_INSTALL_DIR:pythonRoot,UV_PYTHON_BIN_DIR:path.join(work,'python-bin')};
 const pythonVersion=JSON.parse(fs.readFileSync(path.join(root,'producers/android-inputs/aim.json'))).pythonVersion;
 run('uv',['python','install',pythonVersion],{env:pythonEnvironment});
 const python=read('uv',['python','find','--managed-python','--system',pythonVersion],{env:pythonEnvironment});
 if(!fs.realpathSync(python).startsWith(fs.realpathSync(pythonRoot)+path.sep))throw Error('The selected Python interpreter is outside the declared build input directory.');
 const buildWork=path.join(work,'compiler'),build=path.join(work,'build-output'),tools={jdk:publisher.jdk,python,ninja:writeAndroidNinjaLauncher({output:path.join(work,'ninja.mjs'),ninja:read('which',['ninja'])}),rustToolchain:read('rustc',['--print','sysroot']),aidl:publisher.aidl,aconfig,blueprintParser:blueprint.parser,cargoHome};
 // Build in a separate owned clone: immutable upstream inputs retain no generated files.
 const converter=path.join(work,'converter');run('git',['clone','--no-local',sources.converter,converter]);
 const converterOrigin=read('git',['-C',sources.converter,'remote','get-url','origin']);run('git',['-C',converter,'remote','set-url','origin',converterOrigin]);
 if(javaInput){
  fs.mkdirSync(path.join(converter,'build'),{recursive:true});fs.copyFileSync(path.join(java,'dex2jvm.jar'),path.join(converter,'build/dex2jvm.jar'),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
 }else{
  const classes=path.join(converter,'build/classes');fs.mkdirSync(classes,{recursive:true});
  run(path.join(publisher.jdk,'bin/javac'),['--release','21','-nowarn','-d',classes,...javaSources(path.join(converter,'src/main/java'))]);
  fs.cpSync(path.join(converter,'src/main/resources'),classes,{recursive:true});
  run(path.join(publisher.jdk,'bin/jar'),['--create','--file',path.join(converter,'build/dex2jvm.jar'),'--main-class','io.github.kksimp.dex2jvm.Main','-C',classes,'.']);
 }
 const {acquireNdkHeaders}=await import(new URL('../sources/maclauncher-android/src/modules/android/native/arm32/acquire-headers.mjs',import.meta.url));
 const ndk=acquireNdkHeaders(path.join(work,'ndk-headers'));
 const options={...sources,converter,jdk:publisher.jdk,sdl:publisher.sdl,'vulkan-headers':publisher.vulkanHeaders,'sndfile-headers':codecs.include,
  codecs:codecs.codecs,'codec-notices':codecs.codecNotices,angle:angle.angle,'angle-manifest':path.join(angle.angle,'angle-manifest.json'),framework:publisher.framework,
  output:build,'build-work':buildWork,'ndk-headers':ndk.include||path.join(work,'ndk-headers/include'),aidl:publisher.aidl,aconfig,'rust-toolchain':tools.rustToolchain,python,ninja:tools.ninja,
  'blueprint-parser':blueprint.parser,'blueprint-parser-sources':blueprint.sources};
 if(javaInput)options['java-inputs']=java;
 if(frameworkInput)options['java-framework-input']=javaFramework;
 const inputFile=path.join(work,'common-inputs.json');fs.writeFileSync(inputFile,JSON.stringify(options,null,2)+'\n');
 run(process.execPath,[path.join(producer,recipe.buildEntry),'--inputs',inputFile],{env:{...process.env,PATH:path.dirname(python)+path.delimiter+process.env.PATH,CARGO_BUILD_JOBS:'2',CARGO_HOME:cargoHome}});
 const packaged=packageAndroidCommon({build,version,sourceRevision:recipe.revision,output});
 return {...packaged,build,buildWork,inputs:options,sources,tools,sdl:publisher.sdl,codecs,buildTools:publisher.buildTools,
  arm32Work:path.join(buildWork,'build/arm32'),arm32Inputs:{importsDirectory:path.join(buildWork,'build/arm32/imports'),syscalls:path.join(buildWork,'build/arm32/syscalls'),format:path.join(buildWork,'build/arm32/format'),ndkHeaders:options['ndk-headers']},foundationHost:path.join(buildWork,'build/keystore/foundation/libkeymint-soft-host.a')};
}
