import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {checkoutSource,run,recipeMain} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {helperPackage,sha} from './helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),descriptor=path.join(root,'producers/android-inputs/java-framework.json');
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
const json=file=>JSON.parse(fs.readFileSync(file));
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',maxBuffer:64<<20,...options}).trim();

/** Retain exact original Git trees while fetching only consumed source blobs. */
function sourceObjects({repository,revision},destination){
 run('git',['init','--bare',destination]);run('git',['-C',destination,'remote','add','origin',repository]);
 run('git',['-C',destination,'config','remote.origin.promisor','true']);run('git',['-C',destination,'config','remote.origin.partialclonefilter','blob:none']);
 run('git',['-C',destination,'fetch','--filter=blob:none','--depth','1','--no-tags','origin',revision]);run('git',['-C',destination,'update-ref','HEAD',revision]);
 if(read('git',['-C',destination,'rev-parse','HEAD'])!==revision)throw Error('Java source object store differs from its declared commit.');return destination;
}

/** Compile complete platform Java implementations and native declarations without Mac programs. */
export async function buildAndroidJavaFrameworkInput({output,work}){
 if([output,work].some(file=>!path.isAbsolute(file||'')||fs.existsSync(file)))throw Error('Framework Java inputs require new absolute output/work directories.');
 const profile=json(descriptor),javaProfile=json(path.join(root,'producers/android-inputs/java-converter.json')),jdkPin=javaProfile.jdk[process.platform+'-'+process.arch];
 if(!jdkPin)throw Error('The framework Java stage has no declared JDK for this build host.');
 fs.mkdirSync(work,{recursive:true});fs.mkdirSync(output,{recursive:true});
 const android=checkoutSource({...profile.androidSource,destination:path.join(work,'android')}),native=path.join(android,'src/modules/android/native'),pins=json(path.join(native,'source-pins.json'));
 const cache=path.join(work,'archives'),jdkArchive=await buildInput(jdkPin,cache),jdkRoot=path.join(work,'jdk');fs.mkdirSync(jdkRoot);run('/usr/bin/tar',['-xzf',jdkArchive,'-C',jdkRoot]);fs.unlinkSync(jdkArchive);
 const homes=fs.readdirSync(jdkRoot).map(name=>path.join(jdkRoot,name,...(process.platform==='darwin'?['Contents','Home']:[]))).filter(home=>fs.existsSync(path.join(home,'bin/javac')));if(homes.length!==1)throw Error('The declared JDK must supply one Java compiler.');const jdk=homes[0];
 const frameworkPin=json(path.join(native,'framework-binary.json')),frameworkDirectory=path.join(work,'framework-input');fs.mkdirSync(frameworkDirectory);
 for(const file of frameworkPin.files){const archive=await buildInput({url:file.url||frameworkPin.url,sha256:file.sha256,bytes:file.size},cache);fs.copyFileSync(archive,path.join(frameworkDirectory,file.path),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.unlinkSync(archive);}
 const asm=json(path.join(native,'asm-binary.json')),tools=path.join(work,'tools');fs.mkdirSync(tools);for(const file of asm.files){const archive=await buildInput({url:file.url||asm.url,sha256:file.sha256,bytes:file.size},cache);fs.copyFileSync(archive,path.join(tools,file.path),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.unlinkSync(archive);}
 const blueprintProfile=json(path.join(root,'producers/android-inputs/blueprint/source.json')),blueprint=checkoutSource({...blueprintProfile.upstream,destination:path.join(work,'blueprint')}),goPath=path.join(work,'go'),goSource=path.join(goPath,'src/github.com/google/blueprint');fs.mkdirSync(goSource,{recursive:true});fs.cpSync(path.join(blueprint,'parser'),path.join(goSource,'parser'),{recursive:true});
 const driver=path.join(root,'producers/android-inputs/blueprint/main.go');if(sha(driver)!==blueprintProfile.driverSha256)throw Error('The Blueprint transport differs from its declared source.');
 const parser=path.join(work,'android-blueprint-parser');run('go',['build','-p=2','-trimpath','-ldflags=-s -w -buildid=','-o',parser,driver],{env:{...process.env,GO111MODULE:'off',GOENV:'off',GOTOOLCHAIN:'local',GOPATH:goPath,GOCACHE:path.join(work,'go-cache'),CGO_ENABLED:'0',GOOS:process.platform,GOARCH:({x64:'amd64',arm64:'arm64'})[process.arch]}});
 const sources={};for(const record of profile.sources){if(pins[record.pin]!==record.revision)throw Error('The framework Java source pin differs from the original producer: '+record.id);sources[record.id]=sourceObjects(record,path.join(work,record.id));}
 for(const record of profile.sources){
  const objects=[...new Set(read('git',['-C',sources[record.id],'ls-tree','-r','--format=%(objecttype) %(objectname)',record.revision,'--',...record.prefetch]).split('\n').filter(line=>line.startsWith('blob ')).map(line=>line.slice(5)))];
  if(objects.length)run('git',['-C',sources[record.id],'fetch','--no-tags','--no-write-fetch-head','origin','--stdin'],{input:objects.join('\n')+'\n',stdio:['pipe','inherit','inherit']});
 }

 const build=path.join(work,'build'),products=path.join(output,'products');fs.mkdirSync(products,{recursive:true});
 const {frameworkInputs}=await import(pathToFileURL(path.join(native,'framework-base.mjs'))),framework=frameworkInputs(native,frameworkDirectory);
 const previousParser=process.env.ANDROID_BLUEPRINT_PARSER;process.env.ANDROID_BLUEPRINT_PARSER=parser;
 let modules,built;
 try{
  const {buildFrameworkModules}=await import(pathToFileURL(path.join(native,'framework-modules.mjs')));modules=await buildFrameworkModules({root:native,build,jdk,framework,apacheHttpSource:sources.apacheHttp,statsdSource:sources.statsd});
  const {prepareFrameworkGles}=await import(pathToFileURL(path.join(native,'gles-framework-sources.mjs')));prepareFrameworkGles(sources.framework,pins.aospFramework,build,native,sources.native,pins.aospNative);
  const {buildFramework}=await import(pathToFileURL(path.join(native,'framework-build.mjs')));built=await buildFramework({root:native,build,output:products,jdk,framework,frameworkArchives:modules.archives,asmClasspath:asm.files.map(file=>path.join(tools,file.path)).join(path.delimiter),graphicsRegistrations:path.join(build,'framework-gles/registrations.txt')});
 }finally{if(previousParser===undefined)delete process.env.ANDROID_BLUEPRINT_PARSER;else process.env.ANDROID_BLUEPRINT_PARSER=previousParser;}
 for(const name of ['framework-tool','classes','framework-declarations','jni'])fs.cpSync(path.join(build,name),path.join(output,'build',name),{recursive:true});
 for(const name of ['host-callbacks.h','host-callbacks.c'])fs.copyFileSync(path.join(build,name),path.join(output,'build',name));
 fs.copyFileSync(path.join(build,'framework-gles/registrations.txt'),path.join(output,'graphics-registrations.txt'));
 const dexProfile=json(path.join(android,'src/modules/android/art/dex-tools.json')),dexDependencies={};
 for(const [name,filename]of Object.entries({dexlib2:'smali-dexlib2-3.0.10.jar',guava:'guava-31.1-android.jar',annotations:'jsr305-3.0.2.jar'})){
  const pin=dexProfile.artifacts.find(file=>file.file===filename);if(!pin)throw Error('The original DEX tool profile is incomplete.');const archive=await buildInput({...pin,bytes:pin.size},cache),destination=path.join(tools,filename);fs.copyFileSync(archive,destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.unlinkSync(archive);dexDependencies[name]=destination;
 }
 const {buildDexBodies}=await import(pathToFileURL(path.join(android,'src/modules/android/art/dex-bodies.mjs'))),dexBuild=path.join(work,'dex-tool');await buildDexBodies({output:dexBuild,jdk,dependencies:dexDependencies});fs.cpSync(path.join(dexBuild,'classes'),path.join(output,'dex-tool/classes'),{recursive:true});
 const notices=[];for(const [index,archive]of modules.archives.entries()){const name=path.basename(archive);fs.mkdirSync(path.join(output,'modules'),{recursive:true});fs.copyFileSync(archive,path.join(output,'modules',name));const notice=modules.notices[index];fs.cpSync(notice.path,path.join(output,'notices',notice.name),{recursive:true});}
 for(const name of profile.notices)fs.cpSync(path.join(native,'notices',name),path.join(output,'notices',name),{recursive:true});
 fs.copyFileSync(path.join(android,'LICENSE'),path.join(output,'notices/Android-adapters-LICENSE'));
 for(const file of B.fileInventory(path.join(output,'notices')))notices.push({name:'Android framework '+file,license:'See original notice',path:'notices/'+file,sourceUrl:profile.androidSource.repository});
 return {root:output,notices,record:{androidSource:profile.androidSource,framework:frameworkPin,sources:profile.sources,blueprint:{...blueprintProfile.upstream,driverSha256:blueprintProfile.driverSha256,toolchain:read('go',['version'])},jdk:{sha256:jdkPin.sha256,version:read(path.join(jdk,'bin/java'),['--version']).split('\n')[0]},graphicsRegistrationsSha256:sha(path.join(output,'graphics-registrations.txt')),modules:modules.archives.map(file=>path.basename(file)),dexTools:dexProfile}};
}

export function verifyAndroidJavaFrameworkInput(input){
 const declaration=json(path.join(input,'../declaration.json'));validateDeclaration(declaration);B.verifyPayload(input,declaration);const profile=json(descriptor),manifest=json(path.join(input,'input.json'));
 if(declaration.id!==profile.id||declaration.version!==profile.version||declaration.sourceSha256!==sha(descriptor)||JSON.stringify(manifest.androidSource)!==JSON.stringify(profile.androidSource))throw Error('Framework Java input differs from its declared producer.');
 for(const name of ['products/android-framework.jar','build/classes','build/framework-tool','build/jni','build/host-callbacks.h','build/host-callbacks.c'])if(!fs.existsSync(path.join(input,name)))throw Error('Framework Java input is incomplete: '+name);
 return {root:input,declaration,manifest};
}
export async function buildAndroidJavaFramework({project,version,arch,output,work}){
 const profile=json(descriptor);version??=profile.version;if(project!==profile.id||version!==profile.version)throw Error('Select the declared framework Java profile.');
 const built=await buildAndroidJavaFrameworkInput({output:path.join(output,'payload'),work});return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:built.record,notices:built.notices});
}
recipeMain(import.meta,buildAndroidJavaFramework);
