import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {checkoutSource,stageSource,sourceNotices,run,recipeMain} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {acquireArtProducer} from './android-art-producer.mjs';
import {prepareAndroidBuildInputs,releaseAndroidImageArchive} from './android-build-inputs.mjs';
import {helperPackage,sha} from './helper-package.mjs';
import {rustEnvironment} from './rust-build.mjs';
const root=path.resolve(import.meta.dirname,'..');
const descriptor=path.join(root,'producers/android-art-inputs/art-source.json');
const read=(program,args,options={})=>execFileSync(program,args,{encoding:'utf8',...options}).trim();
function lockValue(file,key){
 const matches=[...fs.readFileSync(file,'utf8').matchAll(new RegExp('^'+key+'=([^\\r\\n]+)$','gm'))];
 if(matches.length!==1)throw Error('Missing or ambiguous ART build input '+key+'.');
 return matches[0][1];
}

/** Keep the ART output layout and profile on the shared Rust toolchain environment. */
export function artElfBuildEnvironment({work,target,sdk,jdk,python,env=process.env}){
 const result=rustEnvironment({work,minimumMacOS:'13.0',env:{...env,CARGO_HOME:path.join(work,'cargo')}});
 result.CARGO_ENCODED_RUSTFLAGS=[result.CARGO_ENCODED_RUSTFLAGS,'--remap-path-prefix='+work+'=/android-art-build','--remap-path-prefix='+root+'=/maclauncher-builds'].join(String.fromCharCode(31));
 return {...result,PATH:path.dirname(python)+path.delimiter+(env.PATH||''),CARGO_BUILD_JOBS:'2',CARGO_TARGET_DIR:target,ANDROID_SDK_ROOT:sdk,JAVA_HOME:jdk};
}
/** Build ART's original ELF group independently of host, HWUI and Java adapters. */
export async function buildArtElfsInput({output,work}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('ART ELF builds require Apple Silicon macOS and new absolute output/work paths.');
 const profile=JSON.parse(fs.readFileSync(descriptor));fs.mkdirSync(work,{recursive:true});
 const android=acquireArtProducer({source:profile.androidSource,work});
 const supplier=JSON.parse(fs.readFileSync(path.join(android,profile.supplier)));
 const checkout=checkoutSource({repository:supplier.sources.aim.url,revision:supplier.sources.aim.commit,destination:path.join(work,'upstream')});
 const source=path.join(work,'source'),staged=await stageSource(checkout,supplier.sources.aim.commit,source);
 const {prepareArtCompilerPaths}=await import(pathToFileURL(path.join(android,profile.compilerSource)));
 // This is the existing ART ELF adaptation from prepareAimSource. The remaining
 // AIM projection changes supply runtime execution, outside this compiler group.
 prepareArtCompilerPaths(source,{source:checkout});
 const {sdk,python,cache}=await prepareAndroidBuildInputs({source,work:path.join(work,'inputs'),image:supplier.imageAcquisition});
 const javaLock=path.join(source,'upstream/java-toolchain.lock'),jdkArchive=await buildInput({url:lockValue(javaLock,'JDK_URL'),sha256:lockValue(javaLock,'JDK_SHA256')},path.join(work,'inputs/downloads'));
 const java=path.join(work,'jdk');fs.mkdirSync(java);run('/usr/bin/tar',['-xzf',jdkArchive,'-C',java]);
 const homes=fs.readdirSync(java).map(name=>path.join(java,name,'Contents/Home')).filter(home=>fs.existsSync(path.join(home,'bin/javac')));
 if(homes.length!==1)throw Error('The pinned JDK archive did not supply one JDK home.');
 fs.unlinkSync(jdkArchive);
 const target=path.join(work,'target'),fetched=path.join(work,'fetched');fs.mkdirSync(target);fs.renameSync(path.join(source,'_build'),fetched);
 fs.symlinkSync(target,path.join(source,'target'),'dir');fs.symlinkSync(fetched,path.join(source,'_build'),'dir');
 const env=artElfBuildEnvironment({work,target,sdk,jdk:homes[0],python});
 run('cargo',['fetch','--locked'],{cwd:source,env});
 // buildArtElfs accepts the original producer's already-created image volume.
 // The image node compiles its original reader/translator and authenticates it.
 try{
 run('cargo',['run','--offline','--locked','--release','--quiet','--package','aim-build','--bin','cargo-aim','--','build','image'],{cwd:source,env});
 await releaseAndroidImageArchive({source,work,cache,image:supplier.imageAcquisition});
 const {buildArtElfs}=await import(pathToFileURL(path.join(android,profile.buildEntry)));
 const built=buildArtElfs({aim:source,fetched,sdk,work:target,jdk:homes[0],python,jobs:2,env});
 fs.mkdirSync(output,{recursive:true});
 for(const relative of profile.outputs){
  const file=path.join(built.art,relative),destination=path.join(output,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(file,destination);fs.chmodSync(destination,fs.statSync(file).mode&0o111?0o755:0o644);
 }
 const notices=sourceNotices(checkout,{name:'AIM ART producer',repository:supplier.sources.aim.url});
 for(const notice of sourceNotices(path.join(fetched,'aosp'),{name:'Android ART',repository:'https://android.googlesource.com'}))notices.push(notice);
 const records=notices.map((notice,index)=>{const relative='notices/'+index+'-'+path.basename(notice.file),destination=path.join(output,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(notice.file,destination);const {file,...metadata}=notice;return {...metadata,path:relative};});
 return {art:output,notices:records,build:{source,checkout,fetched,sdk,jdk:homes[0],python,target,env},record:{androidSource:profile.androidSource,aimRevision:supplier.sources.aim.commit,sourceTreeSha256:staged.treeSha256,sourceLockSha256:sha(path.join(android,profile.sourceLock))}};
 }finally{const mount=path.join(fetched,'android16-image');if(fs.existsSync(path.join(mount,'root.identity')))run('hdiutil',['detach',mount]);}
}

/** Seal the ELF group through the ordinary Runtime build output contract. */
export async function buildAndroidArtElf({project,version,arch,output,work}){
 const profile=JSON.parse(fs.readFileSync(descriptor));version??=profile.version;
 if(project!==profile.id||version!==profile.version||!path.isAbsolute(output||'')||fs.existsSync(output)||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('Select the declared ART ELF input version and arm64 with new absolute output/work paths.');
 const built=await buildArtElfsInput({output:path.join(output,'payload'),work});
 return helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:built.record,notices:built.notices});
}
recipeMain(import.meta,buildAndroidArtElf);
