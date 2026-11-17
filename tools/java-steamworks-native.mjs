import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildInput} from './build-input.mjs';
import {archiveInput} from '../lib/pins.mjs';
import {sha} from './helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
const Native=require('../lib/package-format.cjs');
const inputs=JSON.parse(fs.readFileSync(path.join(root,'producers/java-steamworks/inputs.json')));
const run=(command,args,options={})=>{
 try{return execFileSync(command,args,{maxBuffer:Infinity,stdio:'pipe',timeout:180000,...options});}
 catch(error){if(error.stderr)process.stderr.write(error.stderr);throw error;}
};
const files=(directory,suffix)=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
 const file=path.join(directory,entry.name);return entry.isDirectory()?files(file,suffix):entry.isFile()&&file.endsWith(suffix)?[file]:[];
}).sort();
/** Build the original 1.9 JNI ABI with its original SDK, for each requested Mac CPU. */
export async function compileNative({original,arch,work,jdkBin}){
 const cpus={arm64:['arm64'],x64:['x86_64'],universal:['arm64','x86_64']}[arch];
 if(!cpus||!original.source)throw Error('The source build requires the original Steamworks4j 1.9 ABI.');
 const source=path.join(work,'source'),sdk=path.join(work,'sdk'),headers=path.join(work,'jni-headers'),bin=path.join(work,'bin');
 for(const directory of [source,sdk,headers,bin])fs.mkdirSync(directory,{recursive:true});
 for(const [record,destination] of [[original.source,source],[inputs.sdk,sdk]])run('/usr/bin/tar',['-xzf',await buildInput(archiveInput(record)),'--strip-components=1','-C',destination]);
 const jars=await Promise.all([inputs.jnigen,inputs.javaparser].map(record=>buildInput(archiveInput(record))));
 const wrapper=path.join(source,'java-wrapper'),server=path.join(source,'server'),classes=path.join(wrapper,'target/classes'),serverClasses=path.join(server,'target/classes'),generator=path.join(work,'generator');
 for(const directory of [classes,serverClasses,generator])fs.mkdirSync(directory,{recursive:true});
 run(path.join(jdkBin,'javac'),['--release','8','-h',headers,'-d',classes,...files(path.join(wrapper,'src/main/java'),'.java')]);
 run(path.join(jdkBin,'javac'),['--release','8','-h',headers,'-cp',classes,'-d',serverClasses,...files(path.join(server,'src/main/java'),'.java')]);
 run(path.join(jdkBin,'javac'),['--release','8','-cp',jars.join(path.delimiter),'-d',generator,...files(path.join(source,'jnigen/src/main/java'),'.java')]);
 fs.copyFileSync(path.join(root,'producers/java-steamworks/javah.cjs'),path.join(bin,'javah'));fs.chmodSync(path.join(bin,'javah'),0o755);
 run(path.join(jdkBin,'java'),['-cp',[generator,classes,serverClasses,...jars].join(path.delimiter),'com.codedisaster.steamworks.jnigen.JNICodeGenerator'],{cwd:source,env:{...process.env,PATH:[bin,path.dirname(process.execPath),process.env.PATH].join(path.delimiter),STEAMWORKS_JNI_HEADERS:headers}});
 const native=path.join(wrapper,'src/main/native'),publisherDependency=path.join(sdk,'redistributable_bin/osx/libsteam_api.dylib'),dependency=path.join(work,'libsteam_api.dylib');
 // The original SDK also ships i386. Project only the requested 64-bit slices
 // into owned staging before using the package reader, which accepts 64-bit code.
 run('/usr/bin/lipo',[publisherDependency,...cpus.flatMap(cpu=>['-extract',cpu]),'-output',dependency]);
 const dependencyCPUs=Native.readMachOArchitectures(dependency,{allowLibrary:true});
 if(cpus.some(cpu=>!dependencyCPUs.includes(cpu)))throw Error('The original Steam SDK library lacks a requested CPU: '+dependencyCPUs.join(', '));
 const slices=[];
 for(const cpu of cpus){
  const output=path.join(work,cpu+'.dylib');
  run('/usr/bin/xcrun',['clang++','-std=c++11','-dynamiclib','-O2','-DNDEBUG','-DMACOSX','-arch',cpu,'-mmacosx-version-min=11.0',
   '-I'+native,'-I'+path.join(native,'include/jni'),'-I'+path.join(native,'include/jni/mac'),'-I'+path.join(sdk,'public/steam'),
   '-ffile-prefix-map='+work+'=steamworks4j-build','-Wl,-install_name,@rpath/libsteamworks4j.dylib','-framework','CoreFoundation',...files(native,'.cpp'),dependency,'-o',output]);
  slices.push(output);
 }
 const library=path.join(work,'libsteamworks4j.dylib');
 if(slices.length>1)run('/usr/bin/lipo',['-create',...slices,'-output',library]);else fs.copyFileSync(slices[0],library);
 // Only the newly built bridge changes. The SDK publisher library stays intact.
 const links=run('/usr/bin/otool',['-L',library],{encoding:'utf8'});
 const sdkLink=/^\s+(.+libsteam_api\.dylib) \(/m.exec(links)?.[1];
 if(!sdkLink)throw Error('The JNI bridge did not link the original Steam API dependency.');
 run('/usr/bin/install_name_tool',['-change',sdkLink,'@loader_path/libsteam_api.dylib',library]);
 run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',library]);
 const actual=Native.readMachOArchitectures(library,{allowLibrary:true}).sort();
 if(JSON.stringify(actual)!==JSON.stringify(cpus.slice().sort()))throw Error('The JNI output differs from its requested CPUs.');
 return {library,dependency,sdk,source,classes,sourceBuild:{sourceRevision:original.sourceRevision,sourceArchiveSha256:original.source.sha256,sdkRevision:inputs.sdk.revision,sdkPublisherLibrarySha256:sha(publisherDependency),sdkLibrarySha256:sha(dependency),jnigenSha256:inputs.jnigen.sha256,javaparserSha256:inputs.javaparser.sha256}};
}
