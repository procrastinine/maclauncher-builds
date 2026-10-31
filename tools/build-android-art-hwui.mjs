import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {checkoutSource,run} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {acquireArtProducer} from './android-art-producer.mjs';
import {rustEnvironment} from './rust-build.mjs';

const root=path.resolve(import.meta.dirname,'..');
const profile=JSON.parse(fs.readFileSync(new URL('../producers/android-art-inputs/hwui.json',import.meta.url)));
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',...options}).trim();
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const native='src/modules/android/native/hwui';

/** Original publisher tools used by the existing HWUI generators. */
export async function acquireHwuiTools(output){
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Choose a new absolute HWUI tool directory.');
 fs.mkdirSync(output,{recursive:true});
 const cache=path.join(output,'archives'),archive=await buildInput(profile.protoc,cache),protoc=path.join(output,'protoc');fs.mkdirSync(protoc);
 try{run('/usr/bin/unzip',['-q',archive,'-d',protoc]);fs.accessSync(path.join(protoc,'bin/protoc'),fs.constants.X_OK);fs.accessSync(path.join(protoc,'include/google/protobuf/descriptor.proto'));}finally{fs.rmSync(archive,{force:true});}
 const encoded=await buildInput(profile.hidlGen.transport,cache),bytes=Buffer.from(fs.readFileSync(encoded,'utf8'),'base64');
 const gitBlob=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 if(bytes.length!==profile.hidlGen.bytes||sha(bytes)!==profile.hidlGen.sha256||gitBlob!==profile.hidlGen.gitBlob)throw Error('The original HIDL generator differs from its pinned Git object.');
 const hidlGen=path.join(output,'hidl-gen');fs.writeFileSync(hidlGen,bytes,{mode:0o755,flag:'wx'});fs.rmSync(encoded);fs.rmdirSync(cache);
 return {protoc:path.join(protoc,'bin/protoc'),protocInclude:path.join(protoc,'include'),hidlGen};
}

/** Reuse exact common source checkouts and acquire only the remaining HWUI profiles. */
export function acquireHwuiSources({android,common,work}){
 const manifest=JSON.parse(fs.readFileSync(path.join(android,profile.sourceManifest))),sources={};
 const candidates=new Map();
 for(const directory of new Set(Object.values(common.sources||{}).filter(value=>typeof value==='string'))){
  try{const revision=read('git',['-C',directory,'rev-parse','HEAD']);if(!read('git',['-C',directory,'status','--porcelain','--untracked-files=no']))candidates.set(revision,directory);}catch{}
 }
 fs.mkdirSync(work,{recursive:true});
 for(const record of manifest.sources){
  const existing=candidates.get(record.revision);
  sources[record.key]=existing||checkoutSource({repository:record.repository,revision:record.revision,destination:path.join(work,record.key)});
  candidates.set(record.revision,sources[record.key]);
 }
 return {sources,manifest};
}

/** Use the shared toolchain flags and an owned Cargo cache for original HWUI. */
export function artHwuiBuildEnvironment({work,env=process.env}){
 return {...rustEnvironment({work,minimumMacOS:'13.0',env:{...env,CARGO_HOME:path.join(work,'cargo')}}),CARGO_BUILD_JOBS:'2'};
}

/** Prepare original host generators and a locked Cargo workspace before native HWUI compilation. */
export async function prepareArtHwui({common,image,ndk,work}){
 if(!common?.buildWork||!common?.tools||!path.isAbsolute(image?.root||'')||!path.isAbsolute(ndk||'')||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('HWUI requires completed common source products, the original image, NDK and a new absolute work directory.');
 fs.mkdirSync(work,{recursive:true});
 const android=acquireArtProducer({source:profile.androidSource,work});
 const {sources,manifest}=acquireHwuiSources({android,common,work:path.join(work,'sources')});
 if(image.contentSha256!==manifest.target.imageContentSha256)throw Error('HWUI requires its original selected Android image ABI.');
 const producer=path.join(work,'producer'),archive=path.join(work,'producer.tar');fs.mkdirSync(producer);
 run('git',['-C',android,'archive','--format=tar','--output='+archive,profile.androidSource.revision,'--','src']);
 run('/usr/bin/tar',['-xf',archive,'-C',producer]);fs.rmSync(archive);
 run('git',['apply',path.join(root,profile.buildOverlay)],{cwd:producer,env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(producer)}});
 const original=await acquireHwuiTools(path.join(work,'publisher-tools'));
 const foundationHost=common.foundationHost||path.join(common.buildWork,'build/keystore/foundation/libkeymint-soft-host.a');
 if(!fs.statSync(foundationHost).isFile())throw Error('The common original host foundation archive is required.');
 const hostProtobufRoot=path.join(work,'host-protobuf');
 const maps=['-ffile-prefix-map='+work+'=/android-hwui-build','-fdebug-prefix-map='+work+'=/android-hwui-build'].join(' ');
 run('cmake',['-S',sources.protobuf,'-B',hostProtobufRoot,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_POLICY_VERSION_MINIMUM=3.12','-DCMAKE_CXX_FLAGS='+maps+' -I'+path.join(sources.protobuf,'android'),'-Dprotobuf_BUILD_TESTS=OFF','-Dprotobuf_BUILD_CONFORMANCE=OFF','-Dprotobuf_BUILD_EXAMPLES=OFF','-Dprotobuf_BUILD_PROTOC_BINARIES=OFF','-Dprotobuf_BUILD_LIBPROTOC=ON','-Dprotobuf_BUILD_SHARED_LIBS=OFF']);
 run('cmake',['--build',hostProtobufRoot,'--parallel','2','--target','libprotobuf','libprotoc']);
 const bin=path.join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin'),compile=path.join(work,'compile'),cargoHome=path.join(work,'cargo');fs.mkdirSync(cargoHome);
 const buildEnvironment=artHwuiBuildEnvironment({work});
 const tools={...original,clangxx:path.join(bin,'clang++'),ninja:common.tools.ninja,blueprintParser:common.tools.blueprintParser,
  aidl:common.tools.aidl,aconfig:common.tools.aconfig,python:common.tools.python,rustc:read('which',['rustc']),cargo:read('which',['cargo']),cargoHome,
  libclang:path.resolve(bin,'../lib'),foundationHost,hostProtobufRoot};
 for(const name of ['ninja','blueprintParser','aidl','aconfig','python'])if(!path.isAbsolute(tools[name]||''))throw Error('The completed common producer must supply '+name+'.');
 const {prepareHwuiInputs}=await import(pathToFileURL(path.join(producer,native,'inputs.mjs')));
 const ctx=await prepareHwuiInputs({work:compile,sources,tools,image});ctx.buildEnvironment=buildEnvironment;
 const {prepareHostGenerators}=await import(pathToFileURL(path.join(producer,native,'prepareHostGenerators.mjs')));
 const {preparePerfettoTools}=await import(pathToFileURL(path.join(producer,native,'preparePerfettoTools.mjs')));
 await prepareHostGenerators(ctx);await preparePerfettoTools(ctx);
 for(const group of ['generators','perfetto-generators']){
  const output=path.join(compile,'tools',group+'-build');
  run('cmake',['-S',path.join(compile,'tools',group),'-B',output,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_CXX_FLAGS='+maps]);
  run('cmake',['--build',output,'--parallel','2']);
 }
 Object.assign(tools,{syspropCpp:path.join(compile,'tools/generators-build/sysprop_cpp'),statsLogApiGen:path.join(compile,'tools/generators-build/stats-log-api-gen'),
  perfettoPlugins:Object.fromEntries(['perfetto_src_protozero_protoc_plugin_cppgen_plugin','protozero_plugin','ipc_plugin'].map(name=>[name,path.join(compile,'tools/perfetto-generators-build',name)]))});
 Object.assign(ctx.tools,tools);
 const {buildAvif}=await import(pathToFileURL(path.join(producer,native,'buildAvif.mjs')));
 const prepared=await buildAvif({...ctx,prepareOnly:true});
 run(tools.cargo,['fetch','--locked','--target','aarch64-linux-android','--manifest-path',path.join(prepared.workspace,'Cargo.toml')],{env:{...prepared.env,CARGO_BUILD_JOBS:'2'}});
 const sysroot=read(tools.rustc,['--print','sysroot']),rustRoot=['share/doc/rust','share/doc/rustc'].map(relative=>path.join(sysroot,relative)).find(directory=>fs.existsSync(path.join(directory,'COPYRIGHT-library.html'))&&fs.existsSync(path.join(directory,'licenses')));
 if(!rustRoot)throw Error('Original Rust standard-library notices are required.');
 const noticeInputs={rust:{root:rustRoot,version:read(tools.rustc,['--version'])},ndk:{root:ndk,version:'28.2.13676358',files:['NOTICE','NOTICE.toolchain']}};
 return {producer,options:{work:compile,sources,tools,image,noticeInputs,buildEnvironment}};
}

/** Build the unchanged complete HWUI target with sequential source groups and original notices. */
export async function buildArtHwui(options){
 const prepared=await prepareArtHwui(options);
 const {buildHwui}=await import(pathToFileURL(path.join(prepared.producer,native,'build.mjs')));
 const result=await buildHwui(prepared.options);
 return {...result,work:prepared.options.work,producer:prepared.producer,sources:prepared.options.sources,tools:prepared.options.tools};
}
