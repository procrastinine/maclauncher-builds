import './producer-environment.mjs';
import libffi from '../producers/dependencies/libffi.json' with {type:'json'};
import {androidSource,ndkSource} from '../lib/android-source.mjs';
import {addLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {checkoutSource,run,recipeMain} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {helperPackage,sha} from './helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..');
const descriptor=new URL('../producers/android-art-inputs/ffi.json',import.meta.url);
const read=(command,args,options={})=>execFileSync(command,args,{maxBuffer:Infinity,encoding:'utf8',...options}).trim();

/** Compile the ARM64 Android libffi with the pinned NDK and the original ART recipe. */
export async function compile({project,version,output,work}){
 const profile={...JSON.parse(fs.readFileSync(descriptor)),libffi:JSON.parse(fs.readFileSync(new URL('../producers/dependencies/libffi.json',import.meta.url)))};version??=profile.version;
 if(project!==profile.id||version!==profile.version||[output,work].some(value=>!path.isAbsolute(value||'')||fs.existsSync(value)))throw Error('Select the declared ARM64 Android libffi input on Linux x64 with new absolute output/work directories.');
 fs.mkdirSync(work,{recursive:true});
 const android=checkoutSource({...androidSource(),destination:path.join(work,'android-source')}),source=checkoutSource({...libffi,destination:path.join(work,'libffi-source')});
 const original=JSON.parse(fs.readFileSync(path.join(android,'src/modules/android/art/supplier.json'))).sources.libffi;
 const producer=path.join(work,'producer'),sourceArchive=path.join(work,'producer.tar');fs.mkdirSync(producer);
 run('git',['-C',android,'archive','--format=tar','--output='+sourceArchive,androidSource().revision,'--','src']);run('/usr/bin/tar',['-xf',sourceArchive,'-C',producer]);fs.unlinkSync(sourceArchive);
 run('git',['apply',path.join(root,profile.buildOverlay)],{cwd:producer,env:{...process.env,GIT_CEILING_DIRECTORIES:work}});
 const ndkArchive=await buildInput(profile.ndk,path.join(work,'archives')),sdk=path.join(work,'sdk');fs.mkdirSync(sdk);run('/usr/bin/unzip',['-q',ndkArchive,'-d',sdk]);
 const ndk=path.join(sdk,ndkSource().directory);
 if(!fs.readFileSync(path.join(ndk,'source.properties'),'utf8').includes('Pkg.Revision = '+ndkSource().version))throw Error('The NDK archive differs from its declared version.');
 fs.unlinkSync(ndkArchive);
 const {buildArtFfi}=await import(pathToFileURL(path.join(producer,'src/modules/android/art/build-ffi.mjs')));
 const built=await buildArtFfi({source,output:path.join(work,'compiler'),ndk});
 return {ndk,built,source,version,profile};
}
/** Package the compiled archive, headers and licences. */
export async function assemble({project,arch,output,compiled:{ndk,built,source,version,profile}}){
 const bin=path.join(ndk,'toolchains/llvm/prebuilt/linux-x86_64/bin'),members=read(path.join(bin,'llvm-ar'),['t',built.archive]).split('\n');
 const payload=path.join(output,'payload');fs.mkdirSync(path.join(payload,'lib'),{recursive:true});;
 fs.copyFileSync(built.archive,path.join(payload,'lib/libffi.a'));fs.cpSync(built.include,path.join(payload,'include'),{recursive:true});addLicenses(payload,'libffi',source);
 const result=helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:{androidSource:androidSource(),upstream:libffi,ndk:{version:ndkSource().version,sha256:profile.ndk.sha256},target:'aarch64-linux-android35',archiveMembers:members,tools:{autoconf:read('autoconf',['--version']).split('\n')[0],automake:read('automake',['--version']).split('\n')[0],make:read('make',['--version']).split('\n')[0]}}});
 return result;
}
recipeMain(import.meta,{compile,assemble});
