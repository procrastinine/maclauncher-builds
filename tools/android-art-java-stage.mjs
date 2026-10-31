import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {checkoutSource,run} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {helperPackage,sha} from './helper-package.mjs';
import {verifyAndroidJavaFrameworkInput} from './build-android-java-framework.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
const descriptor=path.join(root,'producers/android-art-inputs/java-stage.json');
const json=file=>JSON.parse(fs.readFileSync(file));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/** Select original image members from the verified portable image-data group. */
export function copyArtJavaImageMembers({input,output}){
 const inputs=Array.isArray(input)?input:[input],expected=json(path.join(root,'producers/android-image-data/source.json')),locations=new Map();let manifest,transportSha256;
 if(!inputs.length)throw Error('The original image data shards are required.');
 for(const selected of inputs){
  const declaration=json(path.join(selected,'../declaration.json'));validateDeclaration(declaration);B.verifyPayload(selected,declaration);
  const profile=expected.profiles.find(profile=>profile.id===declaration.id&&profile.version===declaration.version),metadata=json(path.join(selected,'input.json')),transport=fs.readFileSync(path.join(selected,'image-data.json')),current=JSON.parse(transport),content=json(path.join(selected,'content.json'));
  if(!profile||declaration.sourceSha256!==sha(path.join(root,'producers/android-image-data/source.json'))||current.archive_sha256!==expected.archive.sha256||current.source_revision!==expected.revision||['sha256','records','bytes'].some(key=>content[key]!==expected.content[key])||metadata.transportSha256!==digest(transport)||transportSha256&&transportSha256!==metadata.transportSha256)throw Error('ART Java requires its original verified Android image shards.');
  const shard=metadata.dataShard,original=current.shards.find(shard=>shard.id===profile.id&&shard.version===profile.version&&shard.shard===profile.shard);
  if(!original||JSON.stringify(shard)!==JSON.stringify(original))throw Error('Image shard metadata differs from its original transport index.');
  for(const object of shard.objects){if(locations.has(object.data))throw Error('Duplicate image shard object.');locations.set(object.data,{root:selected,object});}
  manifest=current;transportSha256=metadata.transportSha256;
 }
 fs.mkdirSync(output,{recursive:true});const result={};
 for(const name of ['services.jar','framework.jar']){
  const selected='system/framework/'+name;let record=manifest.records.find(record=>Buffer.from(record.path).toString('utf8')===selected);const seen=new Set();
  while(record?.kind==='hardlink'){const target=Buffer.from(record.link).toString('utf8');if(seen.has(target))throw Error('Circular image member link.');seen.add(target);record=manifest.records.find(record=>Buffer.from(record.path).toString('utf8')===target);}
  if(record?.kind!=='file'||!/^\d{8}$/.test(record.data||'')||!Number.isSafeInteger(record.size)||!/^[a-f0-9]{64}$/.test(record.sha256||''))throw Error('The original image Java member is unavailable: '+selected);
  const location=locations.get(record.data);if(!location||location.object.size!==record.size||location.object.sha256!==record.sha256)throw Error('The selected verified image shards do not contain '+selected+'.');
  const source=path.join(location.root,'data',record.data),bytes=fs.readFileSync(source);if(bytes.length!==record.size||digest(bytes)!==record.sha256)throw Error('The original image Java member checksum differs: '+selected);
  const destination=path.join(output,name);fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);result[name==='services.jar'?'imageServicesJar':'imageFrameworkJar']=destination;
 }
 return result;
}

/** Produce the unchanged ART hooks DEX and original delegated platform bodies on Linux. */
export async function buildAndroidArtJavaInput({framework,image,output,work,arch='arm64'}){
 if([output,work].some(file=>!path.isAbsolute(file||'')||fs.existsSync(file)))throw Error('ART Java inputs require new absolute output/work directories.');
 const stage=json(descriptor),checked=verifyAndroidJavaFrameworkInput(framework),definition=json(path.join(root,stage.frameworkInput)),javaProfile=json(path.join(root,stage.jdkInput)),jdkPin=javaProfile.jdk[process.platform+'-'+process.arch];if(!jdkPin)throw Error('ART Java has no declared JDK for this host.');
 fs.mkdirSync(work,{recursive:true});const members=copyArtJavaImageMembers({input:image,output:path.join(work,'image')});
 const android=checkoutSource({...definition.androidSource,destination:path.join(work,'android')}),cache=path.join(work,'archives'),jdkArchive=await buildInput(jdkPin,cache),jdkRoot=path.join(work,'jdk');fs.mkdirSync(jdkRoot);run('/usr/bin/tar',['-xzf',jdkArchive,'-C',jdkRoot]);fs.unlinkSync(jdkArchive);
 const homes=fs.readdirSync(jdkRoot).map(name=>path.join(jdkRoot,name,...(process.platform==='darwin'?['Contents','Home']:[]))).filter(home=>fs.existsSync(path.join(home,'bin/javac')));if(homes.length!==1)throw Error('The declared JDK must supply one compiler.');const jdk=homes[0];
 const profile=json(path.join(root,stage.publisherInputs)),tools=path.join(work,'tools');fs.mkdirSync(tools);
 const r8=path.join(tools,'r8.jar'),r8Archive=await buildInput(profile.r8,cache);fs.copyFileSync(r8Archive,r8,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.unlinkSync(r8Archive);
 const sdkArchive=await buildInput(profile.sdkPlatform,cache),coreSystemModules=path.join(tools,'core-for-system-modules.jar'),core=execFileSync('/usr/bin/unzip',['-p',sdkArchive,profile.sdkPlatform.entry],{maxBuffer:profile.sdkPlatform.entryBytes+1024});if(core.length!==profile.sdkPlatform.entryBytes||digest(core)!==profile.sdkPlatform.entrySha256)throw Error('The original Android core declarations changed.');fs.writeFileSync(coreSystemModules,core,{flag:'wx'});fs.unlinkSync(sdkArchive);
 const dex=json(path.join(android,'src/modules/android/art/dex-tools.json')),libraries=[];
 for(const filename of ['smali-dexlib2-3.0.10.jar','guava-31.1-android.jar','jsr305-3.0.2.jar']){const pin=dex.artifacts.find(file=>file.file===filename);if(!pin)throw Error('The original DEX compiler dependency is unavailable.');const archive=await buildInput({...pin,bytes:pin.size},cache),destination=path.join(tools,filename);fs.copyFileSync(archive,destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.unlinkSync(archive);libraries.push(destination);}
 const dexBodies={command:path.join(jdk,'bin/java'),arguments:['-Xmx512m','-cp',[path.join(framework,'dex-tool/classes'),...libraries].join(path.delimiter),'maclauncher.build.DexBodies']};
 const producer=path.join(work,'producer'),sourceArchive=path.join(work,'producer.tar');fs.mkdirSync(producer);
 if(sha(path.join(root,stage.compileOverlay.file))!==stage.compileOverlay.sha256)throw Error('ART compile declaration transport differs from its declared recipe.');
 try{run('git',['-C',android,'archive','--format=tar','--output='+sourceArchive,'HEAD']);run('/usr/bin/tar',['-xf',sourceArchive,'-C',producer]);}finally{fs.rmSync(sourceArchive,{force:true});}
 run('git',['apply',path.join(root,stage.compileOverlay.file)],{cwd:producer,env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(producer)}});
 const {buildArtJava}=await import(pathToFileURL(path.join(producer,'src/modules/android/art/build-java.mjs'))),built=await buildArtJava({output:path.join(work,'compile'),jdk,api:path.join(framework,'products/android-framework.jar'),coreSystemModules,sharedClasses:path.join(framework,'build/classes'),r8,...members,dexBodies});
 return packageAndroidArtJavaInput({framework,image,output,work,arch});
}

/** Seal the original producer's authenticated completed outputs without compiling them again. */
export function packageAndroidArtJavaInput({framework,image,output,work,arch='arm64'}){
 const stage=json(descriptor),checked=verifyAndroidJavaFrameworkInput(framework),definition=json(path.join(root,stage.frameworkInput)),javaProfile=json(path.join(root,stage.jdkInput)),jdkPin=javaProfile.jdk[process.platform+'-'+process.arch],profile=json(path.join(root,stage.publisherInputs)),android=path.join(work,'android'),dex=json(path.join(android,'src/modules/android/art/dex-tools.json'));
 if(!jdkPin||fs.existsSync(output))throw Error('The declared ART Java host and a new package output are required.');
 if(execFileSync('git',['-C',android,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==stage.androidSource.revision||execFileSync('git',['-C',android,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('The original ART Java source changed.');
 const completed=json(path.join(work,'compile/bootstrap-cache.json'));
 if(completed.value!==true||!Array.isArray(completed.inputs)||!completed.inputs.length||sha(path.join(work,'producer/src/modules/android/art/build-java.mjs'))!==stage.compileProducerSha256)throw Error('The original ART Java producer has not completed.');
 for(const record of completed.inputs)if(!path.isAbsolute(record.file||'')||sha(record.file)!==record.sha256||(fs.statSync(record.file).mode&0o7777)!==record.mode)throw Error('Completed ART Java source or output changed: '+record.file);
 const built={bootstrapDex:path.join(work,'compile/bootstrap/hooks-dex.jar'),servicesJar:path.join(work,'compile/bootstrap/services.jar'),frameworkJar:path.join(work,'compile/bootstrap/framework.jar'),frameworkResourcePreinitVersion:1};
 for(const file of [built.bootstrapDex,built.servicesJar,built.frameworkJar])if(!completed.inputs.some(record=>record.file===file))throw Error('ART Java completion does not include every declared product.');
 const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});for(const [key,name]of Object.entries({bootstrapDex:'hooks-dex.jar',servicesJar:'services.jar',frameworkJar:'framework.jar'}))fs.copyFileSync(built[key],path.join(payload,name),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
 fs.cpSync(path.join(framework,'notices'),path.join(payload,'notices/framework'),{recursive:true});fs.copyFileSync(path.join(Array.isArray(image)?image[0]:image,'notices/android-sdk-arm-dbt-license.txt'),path.join(payload,'notices/android-sdk-arm-dbt-license.txt'));
 const notices=B.fileInventory(path.join(payload,'notices')).map(file=>({name:'Android ART Java '+file,license:'See original notice',path:'notices/'+file,sourceUrl:definition.androidSource.repository}));
 return helperPackage({id:stage.id,version:stage.version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:{androidSource:definition.androidSource,frameworkInputSha256:checked.declaration.manifestSha256,originalImageSha256:json(path.join(root,'producers/android-image-data/source.json')).archive.sha256,buildOverlay:stage.compileOverlay,jdk:{sha256:jdkPin.sha256},compilerInputs:profile,dexTools:dex,frameworkResourcePreinitVersion:built.frameworkResourcePreinitVersion},notices});
}

/** Validate the neutral Java product group before adding its transport to an owned supplier export. */
export function verifyAndroidArtJavaInput(input){
 const definition=json(descriptor),declaration=json(path.join(input,'../declaration.json'));validateDeclaration(declaration);B.verifyPayload(input,declaration);const manifest=json(path.join(input,'input.json'));
 if(declaration.id!==definition.id||declaration.version!==definition.version||declaration.sourceSha256!==sha(descriptor)||JSON.stringify(manifest.androidSource)!==JSON.stringify(definition.androidSource))throw Error('ART Java input differs from its declared source profile.');return {root:input,declaration,manifest};
}
export function prepareArtJavaProducer({producer,input,work}){
 const checked=verifyAndroidArtJavaInput(input),owned=fs.realpathSync(work),source=fs.realpathSync(producer),definition=json(descriptor);
 if(!source.startsWith(owned+path.sep)||fs.existsSync(path.join(source,'.git'))||sha(path.join(source,'src/modules/android/art/build-java.mjs'))!==definition.consumerSourceSha256)throw Error('ART Java transport needs its unchanged original source in an owned supplier export.');
 run('git',['apply',path.join(root,'producers/android-art-inputs/java-consumer.patch')],{cwd:source,env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(source)}});return checked;
}
