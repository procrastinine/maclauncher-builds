import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {declaredSource,stageSource,run,recipeMain,findBuildTool} from './build-source.mjs';
import {upstreamRevision} from '../lib/projects.mjs';
import {addLicense,addLicenses} from '../lib/licenses.mjs';
import {sealRuntime} from './seal-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
const CODECS=['Delta/C_Delta.cpp','DisPack/C_DisPack.cpp','4x4/C_4x4.cpp','External/C_External.cpp','LZMA2/C_LZMA.cpp','LZMA2/C_BCJ.cpp','Dict/C_Dict.cpp','REP/C_REP.cpp','LZP/C_LZP.cpp','Tornado/C_Tornado.cpp','GRZip/C_GRZip.cpp','MM/C_MM.cpp','MM/C_TTA.cpp','PPMD/C_PPMD.cpp','LZ4/C_LZ4.cpp'];
/** Compile native decoders and the Windows CLS host from the exact declared source trees. */
export async function compile({arch,work,includeWindowsHost=true,fixture=false}){
 if(!['arm64','x64'].includes(arch)||!path.isAbsolute(work||''))throw Error('FreeArc needs a target architecture and separate absolute work directory.');
 const sourceRoot=declaredSource('freearc','freearc'),porterRoot=declaredSource('freearc','porter-helpers');
 const source=path.join(work,'source'),porter=path.join(work,'helpers'),bin=path.join(work,'bin');
 fs.mkdirSync(work,{recursive:true});fs.mkdirSync(bin);
 const sourceFacts=await stageSource(sourceRoot,upstreamRevision('freearc','freearc'),source);
 const helperFacts=await stageSource(porterRoot,upstreamRevision('freearc','porter-helpers'),porter);
 const compression=path.join(source,'Compression'),shim=path.join(work,'shim');fs.mkdirSync(shim);
 fs.writeFileSync(path.join(shim,'malloc.h'),'#include <stdlib.h>\n');
 const cpu=arch==='x64'?'x86_64':'arm64',cxx=process.env.CXX||findBuildTool('clang++');
 const flags=['-arch',cpu,'-mmacosx-version-min=13.0','-std=gnu++14','-O2','-fno-exceptions','-fno-rtti','-Wno-c++11-narrowing','-DFREEARC_UNIX','-DFREEARC_INTEL_BYTE_ORDER','-DFREEARC_64BIT','-D_NO_EXCEPTIONS','-D_SC_AVPHYS_PAGES=_SC_PHYS_PAGES','-DRUSAGE_THREAD=RUSAGE_SELF','-I'+compression,'-I'+shim,
  ...[source,porter,work].flatMap((from,index)=>['file','debug','macro'].map(kind=>'-f'+kind+'-prefix-map='+from+'=source/freearc/'+index))];
 const filter=path.join(porter,'native/fa-filter.cpp');
 function filterBuild(name,decompressOnly){
  const objects=path.join(work,name+'-objects');fs.mkdirSync(objects);
  // LZMA's encoder includes Threads.c; decoder-only builds need the separate definition.
  const entries=['Common.cpp','CompressionLibrary.cpp',...(decompressOnly?['MultiThreading.cpp']:[]),...CODECS].map(f=>path.join(compression,f));
  const driver=path.join(work,name+'.cpp');
  let text=fs.readFileSync(filter,'utf8');
  if(!decompressOnly)text=text.replace('int rc = Decompress(argv[1], callback, NULL);','int rc = Compress(argv[1], callback, NULL);');
  fs.writeFileSync(driver,text);
  entries.push(driver);const out=[];
  for(let i=0;i<entries.length;i++){const object=path.join(objects,String(i)+'.o');run(cxx,['-c',...flags,...(decompressOnly?['-DFREEARC_DECOMPRESS_ONLY']:[]),entries[i],'-o',object]);out.push(object);}
  run(cxx,['-arch',cpu,'-mmacosx-version-min=13.0',...out,'-lpthread','-o',path.join(bin,name)]);
 }
 filterBuild('fa-filter',true);
 if(includeWindowsHost){const cc=process.env.MINGW32_CC||findBuildTool('i686-w64-mingw32-gcc');run(cc,['-O2','-s','-static','-ffile-prefix-map='+porter+'=source/porter-helpers','-o',path.join(bin,'clshost.exe'),path.join(porter,'native/clshost.c')]);}
 if(fixture)filterBuild('fa-compress-fixture',false);
 addLicenses(bin,'mac-game-porter',porter);
 addLicense(bin,'Cellar FreeArc mapper notice',path.join(porter,'native/freearc-map/LICENSE'));
 addLicenses(bin,'FreeArc',source);
 for(const name of ['NOTICE.txt','GPL-2.0.txt','LGPL-2.1.txt'])addLicense(bin,'FreeArc '+name,path.join(root,'producers/freearc/notices',name),name.replace('.txt',''));
 for(const name of fs.readdirSync(compression,{withFileTypes:true}).filter(x=>x.isDirectory()&&x.name!=='SREP').map(x=>x.name))addLicenses(bin,'FreeArc '+name,path.join(compression,name));
 return {sourceRoot,porterRoot,sourceFacts,helperFacts,bin,includeWindowsHost};
}
/** Seal decoder code only. Optional compressor fixtures never enter the runtime package. */
export async function assemble({project,version,arch,output,compiled}){
 if(!compiled.includeWindowsHost)throw Error('A runtime package requires the Windows CLS host as well as native decoders.');
 const result=await sealRuntime({project,version,arch,output,sourceRoot:compiled.sourceRoot,upstreamRevision:upstreamRevision('freearc','freearc'),executable:path.join(compiled.bin,'fa-filter'),
  payloads:[{source:path.join(compiled.bin,'clshost.exe'),relative:'bin/clshost.exe'},{source:path.join(compiled.bin,'licenses'),relative:'licenses'}],
  runtimeFiles:{filter:'bin/fa-filter',clsHost:'bin/clshost.exe'},provenance:{helpers:{repository:'KarmSakha/mac-game-porter',revision:upstreamRevision('freearc','porter-helpers')},sourceFacts:compiled.sourceFacts,helperFacts:compiled.helperFacts}});
 return result;
}
recipeMain(import.meta,{compile,assemble});
