// SPDX-License-Identifier: GPL-2.0-only
// Builds the AnyPS5 under FEXCore proof host for arm64 macOS from pinned sources and owned overlays.
//
//   node producers/anyps5-fex/build-proof.mjs --out <directory> [--check <eboot.elf> <function> <slot> <bss> <main>]
//     [--only proof,abi,start,syscall] [--anyps5-arm64 <directory>]
//
// --anyps5-arm64 names the arm64 AnyPS5 tree that producers/anyps5's buildRuntime({libraryArchitecture:'arm64',
// configureOnly:true}) prepares at the same AnyPS5 revision: <directory>/source is its projection (every runtime
// overlay and the arm64 library overlay applied) and <directory>/build its configured CMake build. The per-source
// objects then compile from that projection, and source.json's anyps5.cmakeLibraries (VideoOut, Agc, AgcDriver and
// the PRX libraries they link) come from that build as objects and static libraries.
// The FEX checkout (with the submodules source.json lists) and the AnyPS5 paths are projected into
// <directory>, the overlays are applied there, AnyPS5's arm64 library objects are compiled, and the
// proof executable is linked against static FEXCore. Every host links every symbol it references (the proof takes the
// AnyPS5 objects it reaches from their archive), so a missing definition fails the build.
// The ABI proof's guest code (host/guest-abi.c) is compiled for x86-64 and its text extracted for the host to map.
// --check runs the module function twice, with the import slot unbound (must fail) and bound to the thunk (must
// print PASS), and the ABI proof twice, through the generic register shim (must fail) and through per-signature
// thunks (must print PASS), and the start host twice, without the game's sce_module PRX modules (must stop) and with
// them (must reach main and print PASS), and the SYSCALL entry check once (must print PASS).
import {gitlink} from '../../lib/pins.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'../..');
const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json'),'utf8'));
const git=(directory,args,options={})=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:Infinity,stdio:['ignore','pipe','pipe'],...options});
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});

function argumentsOf(argv){
 const options={};
 for(let at=0;at<argv.length;at++){
  if(argv[at]==='--out')options.out=path.resolve(argv[++at]);
  else if(argv[at]==='--check'){options.check=argv.slice(at+1,at+6);at+=5;}
  else if(argv[at]==='--only')options.only=new Set(argv[++at].split(','));
  else if(argv[at]==='--anyps5-arm64')options.anyps5Arm64=path.resolve(argv[++at]);
  else throw Error('Unknown argument: '+argv[at]);
 }
 if(!options.out)throw Error('--out is required.');
 if(options.check&&options.check.length!==5)throw Error('--check takes an eboot and four addresses.');
 return options;
}

function verifyCheckout(record){
 const directory=path.join(root,record.gitlink),expected=gitlink(record.gitlink);
 if(git(directory,['rev-parse','HEAD']).trim()!==expected)throw Error('Source pin mismatch: '+record.gitlink);
 if(git(directory,['remote','get-url','origin']).trim().replace(/\.git$/,'')!==record.repository.replace(/\.git$/,''))throw Error('Source origin mismatch: '+record.gitlink);
 if(git(directory,['status','--porcelain','--untracked-files=no']).trim())throw Error('Source checkout has local changes: '+record.gitlink);
 for(const submodule of record.submodules||[]){
  const status=git(directory,['submodule','status','--',submodule]);
  if(!status.startsWith(' '))throw Error('Submodule is not initialized at its pinned commit: '+record.gitlink+'/'+submodule);
 }
 return directory;
}

// Copies the tracked files (and those of initialized submodules) without .git, cloning file data.
function project(directory,destination,paths=[]){
 const listing=git(directory,['ls-files','--stage','--recurse-submodules','-z','--',...paths]).split('\0').filter(Boolean);
 for(const record of listing){
  const separator=record.indexOf('\t'),mode=record.slice(0,6),relative=record.slice(separator+1);
  if(mode==='160000')continue;
  const from=path.join(directory,relative),to=path.join(destination,relative);
  if(!fs.existsSync(from)&&mode!=='120000')continue;
  fs.mkdirSync(path.dirname(to),{recursive:true});
  if(mode==='120000')fs.symlinkSync(fs.readlinkSync(from),to);
  else{fs.copyFileSync(from,to,fs.constants.COPYFILE_FICLONE);fs.chmodSync(to,mode==='100755'?0o755:0o644);}
 }
}

// The objects, static libraries and other link inputs of the PRX libraries named, and of the PRX libraries they link,
// from the arm64 CMake build: libc and libkernel are left out, since the per-source objects provide what the host
// needs of them. CMake gives every object and custom command of a target
// order-only dependencies on the shared libraries it links, so Ninja runs on a copy of build.ninja without libc.prx and
// libkernel.prx among them. Objects of a source the per-source list compiles are left out too.
// overlaid is the projection this producer's overlays edited: an object whose source differs there is compiled from that
// source with its own CMake command, outside the arm64 build tree.
function cmakeLibraries(arm64,names,compiled,overlaid){
 const build=path.join(arm64,'build'),manifest=fs.readFileSync(path.join(build,'build.ninja'),'utf8').split('\n');
 const excluded=new Set(['core/libs/libs/unpatched/libc.prx','core/libs/libs/unpatched/libkernel.prx']);
 // No object needs a linked PRX library to compile: the order-only PRX inputs CMake adds would link libraries (and
 // through them libc.prx and libkernel.prx) that the host never uses.
 fs.writeFileSync(path.join(build,'objects-only.ninja'),manifest.map(line=>{
  if(!line.startsWith('build ')||!line.includes(' || '))return line;
  const at=line.indexOf(' || '),kept=line.slice(at+4).split(' ').filter(target=>!excluded.has(target)&&!/^core\/libs\/libs\/unpatched\/\S+\.prx$/.test(target));
  return line.slice(0,at)+(kept.some(Boolean)?' || '+kept.join(' '):'');
 }).join('\n'));
 const edges=new Map();
 for(let at=0;at<manifest.length;at++){
  const match=/^build (core\/libs\/libs\/unpatched\/\S+\.prx): \S+ (.*)$/.exec(manifest[at]);
  if(!match)continue;
  const variables={};
  for(let next=at+1;next<manifest.length&&manifest[next].startsWith('  ');next++){
   const separator=manifest[next].indexOf(' = ');
   variables[manifest[next].slice(2,separator)]=manifest[next].slice(separator+3);
  }
  edges.set(match[1],{inputs:match[2].split(' || ')[0].split(' | ')[0].trim().split(/\s+/),variables});
 }
 const commands=JSON.parse(execFileSync('ninja',['-C',build,'-t','compdb'],{encoding:'utf8',maxBuffer:Infinity}));
 const sourceOf=new Map(commands.map(entry=>[path.resolve(entry.directory,entry.output),path.resolve(entry.directory,entry.file)]));
 const commandOf=new Map(commands.map(entry=>[path.resolve(entry.directory,entry.output),entry.command]));
 const libraries=[],objects=[],changed=[],archives=[],link=[],sources=[],includes=[],defines=new Map(),seen=new Set(),pending=names.map(name=>'core/libs/libs/unpatched/'+name+'.prx');
 while(pending.length){
  const target=pending.shift();
  if(seen.has(target)||excluded.has(target))continue;
  seen.add(target);
  const edge=edges.get(target);
  if(!edge)throw Error('The arm64 AnyPS5 build has no PRX library '+target);
  libraries.push(path.basename(target,'.prx'));
  for(const input of edge.inputs){
   const object=path.join(build,input),source=sourceOf.get(object);
   if(source&&compiled.has(path.relative(path.join(arm64,'source'),source)))continue;
   const edited=source&&path.join(overlaid,path.relative(path.join(arm64,'source'),source));
   if(edited&&fs.existsSync(edited)&&!fs.readFileSync(edited).equals(fs.readFileSync(source)))changed.push([object,edited]);
   else objects.push(object);
   if(source)sources.push(path.relative(path.join(arm64,'source'),source));
   // The include directories outside the projected paths (SDL, the Vulkan headers, generated headers), which the
   // thunk units that include these sources' headers need as well.
   for(const [,directory] of (commandOf.get(object)||'').matchAll(/(?:^|\s)(?:-I|-isystem\s+)(\S+)/g))includes.push(path.resolve(build,directory));
   // And their definitions (APS5_ENABLE_TIMING_LOG, VK_ENABLE_BETA_EXTENSIONS), apart from each library's <name>_EXPORTS.
   for(const [,written] of (commandOf.get(object)||'').matchAll(/(?:^|\s)-D(\S+)/g)){
    // The command is shell text: MBEDTLS_USER_CONFIG_FILE=\"<path>\" names a header in quotes.
    const definition=written.replace(/\\(.)/g,'$1');
    if(/_EXPORTS$/.test(definition))continue;
    const name=definition.split('=')[0];
    if(defines.has(name)&&defines.get(name)!==definition)throw Error('The arm64 AnyPS5 libraries define '+name+' differently: '+defines.get(name)+', '+definition);
    defines.set(name,definition);
   }
  }
  const words=edge.variables.LINK_LIBRARIES.trim().split(/\s+/);
  for(let at=0;at<words.length;at++){
   const word=words[at];
   if(word.endsWith('.prx'))pending.push(word);
   else if(word.endsWith('.a'))archives.push(path.resolve(build,word));
   else if(word==='-framework')link.push(word+' '+words[++at]);
   else if(word.endsWith('.dylib'))link.push(path.resolve(build,word));
   else if(word.startsWith('-l'))link.push(word);
   else if(!word.startsWith('-Wl,-rpath,'))throw Error('Unknown link input of '+target+': '+word);
  }
  if(edge.variables.LINK_FLAGS.includes('-fexperimental-library'))link.push('-fexperimental-library');
 }
 const unique=list=>[...new Set(list)];
 // The unedited objects of the edited sources are built too, which makes the generated headers they include.
 // Static libraries outside the build tree (the prepared FFmpeg) are inputs only.
 const built=unique(archives).filter(file=>!path.relative(build,file).startsWith('..'));
 for(const file of unique(archives))if(!built.includes(file)&&!fs.existsSync(file))throw Error('The arm64 AnyPS5 build links a missing library '+file);
 run('ninja',['-C',build,'-f','objects-only.ninja',...unique([...objects,...changed.map(([object])=>object)]).map(file=>path.relative(build,file)),...built.map(file=>path.relative(build,file))]);
 for(const [object,edited] of new Map(changed)){
  const words=commandOf.get(object).split(' '),source=sourceOf.get(object),output=path.join(path.dirname(overlaid),'objects-cmake',path.relative(path.join(arm64,'source'),source)+'.o');
  if(/["'\\]/.test(commandOf.get(object)))throw Error('The CMake command of '+object+' is quoted; it is read word by word.');
  const args=[];
  for(let at=1;at<words.length;at++){
   const word=words[at];
   if(word==='-MD')continue;
   if(word==='-MT'||word==='-MF'){at++;continue;}
   if(word==='-o'){args.push('-o',output);at++;continue;}
   if(word===source){args.push(edited);continue;}
   args.push(word);
  }
  if(!args.includes(edited)||!args.includes(output))throw Error('The CMake command of '+object+' has no -o or source word.');
  args.push('-ffile-prefix-map='+overlaid+'=/anyps5','-fmacro-prefix-map='+overlaid+'/=');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  run(words[0],args,{cwd:build});
  objects.push(output);
 }
 return {libraries,objects:unique(objects),archives:unique(archives),link:unique(link),sources:unique(sources),includes:unique(includes),defines:[...defines.values()]};
}

// Makes destination hold exactly the files of source, copying a file only when its contents differ.
function syncTree(source,destination){
 const walk=(directory,prefix='')=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  const relative=path.join(prefix,entry.name);
  return entry.isDirectory()?walk(path.join(directory,entry.name),relative):[relative];
 });
 const wanted=new Set(walk(source));
 if(fs.existsSync(destination))for(const relative of walk(destination))if(!wanted.has(relative))fs.rmSync(path.join(destination,relative),{force:true});
 for(const relative of wanted){
  const from=path.join(source,relative),to=path.join(destination,relative),link=fs.lstatSync(from).isSymbolicLink();
  if(link){
   if(fs.existsSync(to)||fs.lstatSync(to,{throwIfNoEntry:false}))if(fs.lstatSync(to).isSymbolicLink()&&fs.readlinkSync(to)===fs.readlinkSync(from))continue;
   fs.rmSync(to,{force:true});fs.mkdirSync(path.dirname(to),{recursive:true});fs.symlinkSync(fs.readlinkSync(from),to);continue;
  }
  const existing=fs.lstatSync(to,{throwIfNoEntry:false});
  if(existing?.isFile()&&existing.size===fs.statSync(from).size&&fs.readFileSync(to).equals(fs.readFileSync(from))&&existing.mode===fs.statSync(from).mode)continue;
  fs.rmSync(to,{force:true,recursive:true});fs.mkdirSync(path.dirname(to),{recursive:true});
  fs.copyFileSync(from,to,fs.constants.COPYFILE_FICLONE);fs.chmodSync(to,fs.statSync(from).mode);
 }
}

function applyOverlay(target,overlay){
 // The ceiling keeps git apply from discovering an enclosing repository.
 git(target,['apply','--whitespace=nowarn',path.join(import.meta.dirname,overlay.file)],{env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(target)}});
}

// Paths in the binaries (__FILE__, debug information) name the build directory as /anyps5-fex, so no local path is
// recorded in them; __FILE__ of an AnyPS5 source reads core/libs/..., as AnyPS5's own build records it.
function prefixMaps(out){
 return ['-ffile-prefix-map='+out+'=/anyps5-fex','-fmacro-prefix-map='+path.join(out,'anyps5')+'/=','-fmacro-prefix-map='+out+'=/anyps5-fex'];
}

function link(out,objects,log){
 const build=path.join(out,'build');
 run('cmake',['-S',path.join(out,'fex'),'-B',build,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DBUILD_TESTING=OFF','-DBUILD_FEXCONFIG=OFF',
  '-DENABLE_JEMALLOC_GLIBC_ALLOC=OFF','-DENABLE_OFFLINE_TELEMETRY=OFF','-DENABLE_CCACHE=OFF','-DENABLE_LTO=OFF','-DTUNE_CPU=none','-DTUNE_ARCH=generic',
  '-DCMAKE_PROJECT_FEX_INCLUDE='+path.join(out,'host',recipe.host.entry),'-DANYPS5_ARM64_OBJECTS='+objects.join(';'),'-DANYPS5_SOURCE_DIR='+path.join(out,'anyps5'),'-DANYPS5_GENERATED_THUNKS='+generatedFiles.join(';'),
  '-DANYPS5_ARM64_LINK='+[...cmake.archives,...cmake.link].join(';'),'-DANYPS5_ARM64_INCLUDES='+cmake.includes.join(';'),
  '-DANYPS5_ARM64_DEFINES='+cmake.defines.join(';')],{stdio:['ignore','ignore','inherit']});
 // -k 0: every target's link errors, not only the first failing target's.
 const result=spawnSync('ninja',['-C',build,'-k','0',...recipe.host.targets],{encoding:'utf8',maxBuffer:Infinity});
 fs.writeFileSync(log,result.stdout+result.stderr);
 return result.status===0;
}

// Runs one binary in a failing and a passing mode; the failing mode must not pass.
function check(binary,args,failing,passing){
 const run=mode=>spawnSync(binary,[...args,mode],{encoding:'utf8',timeout:20000});
 const fail=run(failing),pass=run(passing);
 process.stdout.write('--- '+path.basename(binary)+' '+failing+' (exit '+fail.status+')\n'+fail.stdout+'--- '+path.basename(binary)+' '+passing+' (exit '+pass.status+')\n'+pass.stdout);
 if(fail.status===0||/^PASS$/m.test(fail.stdout))throw Error('The '+failing+' run passed; the check proves nothing.');
 if(pass.status!==0||!/^PASS$/m.test(pass.stdout))throw Error('The '+passing+' run failed.');
}

// The sources of an AnyPS5 CMake object library and their flags, read from the .cmake file that libc's CMakeLists.txt
// includes (the arm64 overlay's gdtoa/Build.cmake, which sits one directory below libc). It knows only the commands
// such a file uses and stops at any other, so a changed file is read again by hand rather than half understood.
function objectLibrary(file){
 const libraryDirectory=path.dirname(path.dirname(file)),root=path.join(options.out,'anyps5');
 const variables={CMAKE_CURRENT_SOURCE_DIR:libraryDirectory,LIBS_INCLUDE_DIR:path.join(root,'core/libs')};
 const expand=text=>text.replace(/\$\{(\w+)\}/g,(_,name)=>{if(!(name in variables))throw Error(file+': unknown variable '+name);return variables[name];});
 const text=fs.readFileSync(file,'utf8').replace(/#.*$/gm,'');
 let sources=[];const common=[],c=[];
 for(const [,command,body] of text.matchAll(/(\w+)\(([^)]*)\)/g)){
  const words=body.trim().split(/\s+/).map(word=>word.replace(/^"(.*)"$/,'$1'));
  if(command==='set')variables[words[0]]=expand(words[1]);
  else if(command==='add_library'){if(words[1]!=='OBJECT')throw Error(file+': not an object library');sources=words.slice(2).map(expand);}
  else if(command==='set_target_properties'){
   for(let i=2;i<words.length;i+=2){
    if(words[i]==='C_VISIBILITY_PRESET')c.push('-fvisibility='+words[i+1]);
    else if(words[i]!=='POSITION_INDEPENDENT_CODE')throw Error(file+': unknown property '+words[i]);
   }
  }
  else if(command==='target_include_directories')common.push(...words.slice(2).flatMap(directory=>['-I',expand(directory)]));
  else if(command==='target_compile_definitions')common.push(...words.slice(2).map(definition=>'-D'+definition));
  else if(command==='target_compile_options')common.push(...words.slice(2).map(expand));
  else if(command!=='target_sources'&&command!=='add_dependencies')throw Error(file+': unknown command '+command);
 }
 return sources.map(source=>[path.relative(root,source),[...common,...(source.endsWith('.c')?c:[])]]);
}

const options=argumentsOf(process.argv.slice(2));
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('The proof builds on arm64 macOS.');
const fex=verifyCheckout(recipe.source);
// The sources are prepared in a staging directory and then copied into place only where they changed, so unchanged
// files keep their timestamps and Ninja rebuilds only what changed.
const stage=path.join(options.out,'staging');
fs.rmSync(stage,{recursive:true,force:true});
project(fex,path.join(stage,'fex'));
for(const overlay of recipe.overlays.filter(overlay=>overlay.target==='fex'))applyOverlay(path.join(stage,'fex'),overlay);
if(options.anyps5Arm64){
 const exported=fs.readFileSync(path.join(options.anyps5Arm64,'source/AnyPS5ExportedSources.cmake'),'utf8');
 if(!exported.includes('set(ANYPS5_EXPORTED_REVISION "'+gitlink(recipe.anyps5.gitlink)+'")'))throw Error('The arm64 AnyPS5 tree is not at the pinned AnyPS5 revision.');
 for(const relative of recipe.anyps5.paths){
  const destination=path.join(stage,'anyps5',relative);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  run('cp',['-cR',path.join(options.anyps5Arm64,'source',relative),path.dirname(destination)+'/']);
 }
 // That projection has every runtime overlay and the arm64 library overlay, which also gives GuestCpu.hpp its arm64
 // branch (overlays/anyps5/guestcpu-arm64.patch); this producer's overlays come after them.
 for(const [directory,method] of recipe.anyps5.arm64HostOverlays)
  (await import(new URL('overlays/'+directory+'/apply.mjs',import.meta.url)))[method](path.join(stage,'anyps5'));
}else{
 const anyps5=verifyCheckout(recipe.anyps5);
 project(anyps5,path.join(stage,'anyps5'),recipe.anyps5.paths);
 for(const overlay of recipe.overlays.filter(overlay=>overlay.target==='anyps5'))applyOverlay(path.join(stage,'anyps5'),overlay);
 // Darwin overlays from producers/anyps5 RUNTIME_OVERLAYS that the compiled objects need and that edit only core/libs,
 // applied in that list's order.
 for(const [directory,method] of recipe.anyps5.runtimeOverlays)
  (await import(new URL('../anyps5/overlays/'+directory+'/apply.mjs',import.meta.url)))[method](path.join(stage,'anyps5'));
 // This producer's own overlays for the arm64 translation host (producers/anyps5-fex/overlays), after those.
 for(const [directory,method] of recipe.anyps5.hostOverlays)
  (await import(new URL('overlays/'+directory+'/apply.mjs',import.meta.url)))[method](path.join(stage,'anyps5'));
 // The arm64 library overlay's steps that the per-source objects need (the overlay belongs to the anyps5 producer): its shared sources
 // (GuestCpuArm64, the standard stream objects) and its raw x87 long double parsing and formatting, each a function of
 // a module in that overlay's directory, in the listed order.
 for(const [script,name] of recipe.anyps5.arm64Libraries.steps)
  (await import(new URL(recipe.anyps5.arm64Libraries.directory+'/'+script,import.meta.url)))[name](path.join(stage,'anyps5'));
}
// The host sources sit outside the FEX projection; fex-entry.cmake adds them to FEX's build.
const hostSource=path.join(stage,'host');
fs.mkdirSync(hostSource,{recursive:true});
for(const file of recipe.host.sources)fs.copyFileSync(path.join(import.meta.dirname,recipe.host.directory,file),path.join(hostSource,file));
for(const tree of ['fex','anyps5','host'])syncTree(path.join(stage,tree),path.join(options.out,tree));
fs.rmSync(stage,{recursive:true,force:true});

const guestObject=path.join(options.out,'guest-abi.x86_64.o'),guestText=path.join(options.out,'guest-abi.bin');
run('clang',['-arch','x86_64','-O2','-ffreestanding','-fno-builtin','-fno-stack-protector','-fno-asynchronous-unwind-tables','-c',
 path.join(import.meta.dirname,recipe.host.directory,recipe.host.guest.source),'-o',guestObject]);
const guestOffsets=execFileSync('python3',['-I',path.join(import.meta.dirname,recipe.host.directory,'macho-text.py'),guestObject,guestText,...recipe.host.guest.symbols],{encoding:'utf8'}).trim().split(' ');
const compile=(source,flags=[])=>{
 // Named after the whole source path: several libraries have an Export.cpp or a Process.cpp.
 const object=path.join(options.out,'objects',source.replace(/\.(cpp|c)$/,'.arm64.o'));
 fs.mkdirSync(path.dirname(object),{recursive:true});
 const cxx=source.endsWith('.cpp');
 run(cxx?'clang++':'clang',[...(cxx?['-std=c++20']:[]),'-arch','arm64','-O2','-c',...prefixMaps(options.out),'-I',path.join(options.out,'anyps5/core/libs'),'-I',path.join(options.out,'anyps5/3rdparty/ZArchive/include'),
  '-I',path.join(options.out,'anyps5/core/libs/nid/include'),...flags,path.join(options.out,'anyps5',source),'-o',object]);
 return object;
};
const libraryObjects=recipe.anyps5.objectLibraries.flatMap(file=>objectLibrary(path.join(options.out,'anyps5',file)));
const objects=[...recipe.anyps5.objects.map(source=>compile(source)),...libraryObjects.map(([source,flags])=>compile(source,flags))];
// The PRX libraries from the arm64 CMake build, after the per-source objects, so a name both define binds to the
// per-source definition.
const cmake=options.anyps5Arm64?cmakeLibraries(options.anyps5Arm64,recipe.anyps5.cmakeLibraries,new Set([...recipe.anyps5.objects,...libraryObjects.map(([source])=>source)]),path.join(options.out,'anyps5')):
 {libraries:[],objects:[],archives:[],link:[],sources:[],includes:[],defines:[]};
// Static libraries of the arm64 CMake build that the per-source objects need (ZArchive for AppArchive.cpp), which no
// CMake PRX library listed above links.
if(options.anyps5Arm64)cmake.archives.push(...recipe.anyps5.archives.map(name=>path.join(options.anyps5Arm64,'build',name)));
// The thunk units repeat their sources' includes, which the per-source compile resolves with these directories too.
cmake.includes.unshift(path.join(options.out,'anyps5/3rdparty/ZArchive/include'));
if(options.anyps5Arm64){
 const projected=path.join(options.anyps5Arm64,'source');
 cmake.includes=[...new Set(cmake.includes.map(directory=>{
  const relative=path.relative(projected,directory);
  return !relative.startsWith('..')&&recipe.anyps5.paths.some(prefix=>relative===prefix||relative.startsWith(prefix+'/'))?path.join(options.out,'anyps5',relative):directory;
 }))].filter(directory=>directory!==path.join(options.out,'anyps5/core/libs'));
 objects.push(...cmake.objects);
 process.stdout.write('arm64 CMake libraries: '+cmake.libraries.join(', ')+' ('+cmake.objects.length+' objects, '+cmake.archives.length+' static libraries)\n');
}
// AnyPS5 builds each PRX as its own library, and two libraries can export the same name (libc's and libkernel's exit,
// say). In this one image, a strong symbol that an earlier object already defines becomes local to the later object,
// whose own calls keep using its definition; imports bind to the first.
{
 const defined=new Set();
 for(const object of objects){
  const symbols=execFileSync('nm',['-gUm',object],{encoding:'utf8'}).split('\n').filter(line=>line&&!/\bweak\b/.test(line)).map(line=>line.trim().split(' ').pop());
  const repeated=symbols.filter(symbol=>defined.has(symbol));
  for(const symbol of symbols)defined.add(symbol);
  if(!repeated.length)continue;
  const local=object.replace(/\.o$/,'.local.o');
  run('ld',['-r','-arch','arm64',object,'-o',local,...repeated.flatMap(symbol=>['-unexported_symbol',symbol])]);
  fs.renameSync(local,object);
  process.stdout.write(path.relative(options.out,object)+': '+repeated.length+' symbols an earlier object defines made local\n');
 }
}
// One thunk translation unit per source, plus the part and data tables (generate-thunks.py prints the files).
const generatedThunks=path.join(options.out,'generated-thunks.cpp');
const generatedFiles=execFileSync('python3',['-I',path.join(import.meta.dirname,recipe.host.directory,recipe.host.generator.script),generatedThunks,
 [path.join(options.out,'anyps5/core/libs'),...cmake.includes].join(':'),...[...recipe.anyps5.objects,...cmake.sources.filter(source=>fs.existsSync(path.join(options.out,'anyps5',source)))].map(source=>path.join(options.out,'anyps5',source)),'--',...objects],{encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim().split('\n');
const linkLog=path.join(options.out,'link.log');
// Links and stub files of an earlier build never stand for this one.
for(const file of ['link-exports.log','link-proof.log','anyps5-unreached-exports.s','anyps5-unreached-exports.o','reachable-roots.txt','reachable-stubs.txt'])
 fs.rmSync(path.join(options.out,file),{force:true});
if(!link(options.out,objects,linkLog)){
 const missing=[...fs.readFileSync(linkLog,'utf8').matchAll(/^  "(.*)", referenced from:/gm)].map(match=>match[1]);
 throw Error((missing.length?missing.length+' symbols no object defines ('+missing.slice(0,40).join(', ')+(missing.length>40?', ...':'')+')':'The host build failed')+'; see '+linkLog);
}
const [proof,abi,start,syscall]=recipe.host.targets.map(target=>path.join(options.out,'build/Bin',target));
// The dynamic libraries the AnyPS5 libraries link (SDL) load from next to the executables (@executable_path).
for(const library of cmake.link.filter(item=>item.endsWith('.dylib')))fs.copyFileSync(library,path.join(options.out,'build/Bin',path.basename(library)));
process.stdout.write(proof+'\n'+abi+' '+guestText+' '+guestOffsets.join(' ')+'\n'+start+'\n'+syscall+'\n');
// The start host's static initializers include the AnyPS5 objects' registrations. Run without arguments, it stops at
// its usage message (exit 2) when every initializer returns.
{
 const usage=spawnSync(start,[],{encoding:'utf8',timeout:20000});
 if(usage.status!==2)throw Error(path.basename(start)+' did not reach main (status '+usage.status+', signal '+usage.signal+'): a static initializer failed.\n'+usage.stdout+usage.stderr);
}
if(options.check){
 const [eboot,functionAddress,slot,bss,main]=options.check;
 // A check whose inputs did not change is not rerun: --only names the ones to run.
 const runs=name=>!options.only||options.only.has(name);
 if(runs('proof'))check(proof,[eboot,functionAddress,slot,bss],'unbound','bound');
 if(runs('abi'))check(abi,[guestText,...guestOffsets],'generic','thunks');
 // The start check's game data folder is a build directory, not a launcher profile.
 const startData=path.join(options.out,'start-data');
 fs.mkdirSync(startData,{recursive:true});
 if(runs('start'))check(start,[path.dirname(eboot),startData,main],'eboot-only','modules');
 if(runs('syscall')){
 const entry=spawnSync(syscall,[eboot,functionAddress,slot,bss],{encoding:'utf8',timeout:20000});
 process.stdout.write('--- '+path.basename(syscall)+' (exit '+entry.status+')\n'+entry.stdout);
 if(entry.status!==0||!/^PASS$/m.test(entry.stdout))throw Error('The SYSCALL entry check failed.');
 }
}
