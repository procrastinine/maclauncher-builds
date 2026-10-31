import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {checkoutSource,run,buildOptions} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
import {helperPackage,sha} from './helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..');
const descriptor=new URL('../producers/android-art-inputs/ffi.json',import.meta.url);
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',...options}).trim();

/** Compile the original Android libffi target with matching Linux host tools. */
export async function buildAndroidArtFfi({project,version,arch,output,work}){
 const profile=JSON.parse(fs.readFileSync(descriptor));version??=profile.version;
 if(project!==profile.id||version!==profile.version||arch!=='arm64'||process.platform!=='linux'||process.arch!=='x64'||[output,work].some(value=>!path.isAbsolute(value||'')||fs.existsSync(value)))throw Error('Select the declared ARM64 Android libffi input on Linux x64 with new absolute output/work directories.');
 fs.mkdirSync(work,{recursive:true});
 const android=checkoutSource({...profile.androidSource,destination:path.join(work,'android-source')}),source=checkoutSource({...profile.libffi,destination:path.join(work,'libffi-source')});
 const original=JSON.parse(fs.readFileSync(path.join(android,'src/modules/android/art/supplier.json'))).sources.libffi;
 if(original.url!==profile.libffi.repository||original.commit!==profile.libffi.revision)throw Error('The libffi input differs from the original ART profile.');
 const producer=path.join(work,'producer'),sourceArchive=path.join(work,'producer.tar');fs.mkdirSync(producer);
 run('git',['-C',android,'archive','--format=tar','--output='+sourceArchive,profile.androidSource.revision,'--','src']);run('/usr/bin/tar',['-xf',sourceArchive,'-C',producer]);fs.unlinkSync(sourceArchive);
 run('git',['apply',path.join(root,profile.buildOverlay)],{cwd:producer,env:{...process.env,GIT_CEILING_DIRECTORIES:work}});
 const ndkArchive=await buildInput(profile.ndk,path.join(work,'archives')),sdk=path.join(work,'sdk');fs.mkdirSync(sdk);run('/usr/bin/unzip',['-q',ndkArchive,'-d',sdk]);
 const ndk=path.join(sdk,profile.ndk.directory);
 if(!fs.readFileSync(path.join(ndk,'source.properties'),'utf8').includes('Pkg.Revision = '+profile.ndk.version))throw Error('The NDK archive differs from its declared version.');
 fs.unlinkSync(ndkArchive);
 const {buildArtFfi}=await import(pathToFileURL(path.join(producer,'src/modules/android/art/build-ffi.mjs')));
 const built=await buildArtFfi({source,output:path.join(work,'compiler'),ndk});
 const bin=path.join(ndk,'toolchains/llvm/prebuilt/linux-x86_64/bin'),members=read(path.join(bin,'llvm-ar'),['t',built.archive]).split('\n'),headers=read(path.join(bin,'llvm-readelf'),['--file-header',built.archive]);
 const machines=[...headers.matchAll(/^\s*Machine:\s*(.+)$/gm)].map(match=>match[1]);
 if(!members.length||machines.length!==members.length||machines.some(machine=>machine!=='AArch64'))throw Error('The libffi archive contains a different target architecture.');
 const payload=path.join(output,'payload');fs.mkdirSync(path.join(payload,'lib'),{recursive:true});fs.mkdirSync(path.join(payload,'notices'));
 fs.copyFileSync(built.archive,path.join(payload,'lib/libffi.a'));fs.cpSync(built.include,path.join(payload,'include'),{recursive:true});fs.copyFileSync(built.license,path.join(payload,'notices/libffi-LICENSE'));
 const result=helperPackage({id:project,version,arch,output,minimumMacOS:'13.0',sourceSha256:sha(descriptor),manifestRelative:'input.json',record:{androidSource:profile.androidSource,upstream:profile.libffi,ndk:{version:profile.ndk.version,sha256:profile.ndk.sha256},target:'aarch64-linux-android35',archiveMembers:members,tools:{autoconf:read('autoconf',['--version']).split('\n')[0],automake:read('automake',['--version']).split('\n')[0],make:read('make',['--version']).split('\n')[0]}},notices:[{name:'libffi',license:'MIT',path:'notices/libffi-LICENSE',sourceUrl:profile.libffi.repository}]});
 return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildAndroidArtFfi(buildOptions(process.argv.slice(2))).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
