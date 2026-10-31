import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {checkoutSource,run,buildOptions,sourceNotices} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {helperPackage,sha} from './helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),descriptor=path.join(root,'producers/android-inputs/java-converter.json');
const profile=()=>JSON.parse(fs.readFileSync(descriptor));
const read=(command,args)=>execFileSync(command,args,{encoding:'utf8',maxBuffer:32<<20}).trim();
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');

/** Compile the unchanged Java converter and its complete production overlay on either build host. */
export async function buildAndroidJavaConverterInput({output,work}){
 const definition=profile(),jdkPin=definition.jdk[process.platform+'-'+process.arch];
 if(!jdkPin||[output,work].some(file=>!path.isAbsolute(file||'')||fs.existsSync(file)))throw Error('Java converter inputs require a declared host JDK and new absolute output/work paths.');
 fs.mkdirSync(work,{recursive:true});fs.mkdirSync(output,{recursive:true});
 const android=checkoutSource({...definition.androidSource,destination:path.join(work,'android')}),native=path.join(android,'src/modules/android/native');
 const pins=JSON.parse(fs.readFileSync(path.join(native,'source-pins.json')));
 if(pins.dex2jvm!==definition.converter.revision||!fs.readFileSync(path.join(android,'.gitmodules'),'utf8').includes('url = '+definition.converter.repository+'\n'))throw Error('The Java converter source differs from its original Android pin.');
 const converter=checkoutSource({...definition.converter,destination:path.join(work,'converter')});
 const cache=path.join(work,'archives'),jdkArchive=await buildInput(jdkPin,cache),jdkRoot=path.join(work,'jdk');fs.mkdirSync(jdkRoot);
 run('/usr/bin/tar',['-xzf',jdkArchive,'-C',jdkRoot]);fs.unlinkSync(jdkArchive);
 const homes=fs.readdirSync(jdkRoot).map(name=>path.join(jdkRoot,name,...(process.platform==='darwin'?['Contents','Home']:[]))).filter(home=>fs.existsSync(path.join(home,'bin/javac')));
 if(homes.length!==1)throw Error('The original JDK input must supply one Java compiler.');
 const jdk=homes[0],tools=path.join(work,'tools');fs.mkdirSync(tools);
 const catalogs=Object.fromEntries(['asm','apksig'].map(name=>[name,JSON.parse(fs.readFileSync(path.join(native,name+'-binary.json')))]));
 for(const catalog of Object.values(catalogs))for(const file of catalog.files){
  const archive=await buildInput({url:file.url||catalog.url,sha256:file.sha256,bytes:file.size},cache);
  fs.copyFileSync(archive,path.join(tools,file.path),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.unlinkSync(archive);
 }
 const {javaSources}=await import(pathToFileURL(path.join(native,'framework-build.mjs'))),classes=path.join(converter,'build/classes');fs.mkdirSync(classes,{recursive:true});
 run(path.join(jdk,'bin/javac'),['--release','21','-nowarn','-d',classes,...javaSources(path.join(converter,'src/main/java'))]);
 fs.cpSync(path.join(converter,'src/main/resources'),classes,{recursive:true});
 run(path.join(jdk,'bin/jar'),['--create','--file',path.join(converter,'build/dex2jvm.jar'),'--date','1980-01-01T00:00:02Z','--main-class','io.github.kksimp.dex2jvm.Main','-C',classes,'.']);
 const {buildConverter}=await import(pathToFileURL(path.join(native,'converter-build.mjs'))),build=path.join(work,'build');
 const built=await buildConverter({root:native,build,output,jdk,checkout:converter,apksig:path.join(tools,catalogs.apksig.files[0].path),asmClasspath:catalogs.asm.files.map(file=>path.join(tools,file.path)).join(path.delimiter)});
 fs.copyFileSync(built.apiHeaders,path.join(output,'android-api-headers.jar'),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
 const notices=[];
 for(const [index,notice]of sourceNotices(converter,{name:'dex2jvm',repository:definition.converter.repository}).entries()){
  const relative='notices/converter/'+index+'-'+path.basename(notice.file);fs.mkdirSync(path.dirname(path.join(output,relative)),{recursive:true});fs.copyFileSync(notice.file,path.join(output,relative));const {file,...metadata}=notice;notices.push({...metadata,path:relative});
 }
 for(const name of ['asm','apksig']){
  fs.cpSync(path.join(native,'notices',name),path.join(output,'notices',name),{recursive:true});
  for(const relative of B.fileInventory(path.join(output,'notices',name)))notices.push({name:name+' '+relative,license:catalogs[name].license,path:'notices/'+name+'/'+relative,sourceUrl:catalogs[name].url});
 }
 return {root:output,notices,record:{androidSource:definition.androidSource,converter:definition.converter,jdk:{sha256:jdkPin.sha256,version:read(path.join(jdk,'bin/java'),['--version']).split('\n')[0]},tools:catalogs}};
}

/** Verify the sealed Java products before native composition consumes them. */
export function verifyAndroidJavaConverterInput(input){
 const declaration=JSON.parse(fs.readFileSync(path.join(path.dirname(input),'declaration.json')));validateDeclaration(declaration);B.verifyPayload(input,declaration);
 const definition=profile(),manifest=JSON.parse(fs.readFileSync(path.join(input,'input.json')));
 if(declaration.id!==definition.id||declaration.version!==definition.version||declaration.sourceSha256!==sha(descriptor)||JSON.stringify(manifest.androidSource)!==JSON.stringify(definition.androidSource)||JSON.stringify(manifest.converter)!==JSON.stringify(definition.converter))throw Error('Java converter input differs from its declared producer profile.');
 for(const file of ['dex2jvm.jar','converter-overlay.jar','android-api-headers.jar'])if(!declaration.files.some(record=>record.path===file))throw Error('Java converter input is incomplete.');
 return {root:input,declaration,manifest};
}
export async function buildAndroidJavaConverter({project,version,arch,output,work}){
 const definition=profile();version??=definition.version;
 if(project!==definition.id||version!==definition.version||!['arm64','x64'].includes(arch))throw Error('Select the declared Java converter package version and target CPU.');
 const built=await buildAndroidJavaConverterInput({output:path.join(output,'payload'),work});
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:built.record,notices:built.notices});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildAndroidJavaConverter(buildOptions(process.argv.slice(2))).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
