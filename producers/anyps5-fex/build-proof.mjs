// SPDX-License-Identifier: GPL-2.0-only
// Builds the AnyPS5 under FEXCore proof host for arm64 macOS from pinned sources and owned overlays.
//
//   node producers/anyps5-fex/build-proof.mjs --out <directory> [--check <eboot.elf> <function> <slot> <bss> <main>]
//     [--only proof,abi,start,syscall]
//
// The FEX checkout (with the submodules source.json lists) and the AnyPS5 paths are projected into
// <directory>, the overlays are applied there, AnyPS5's arm64 library objects are compiled, and the
// proof executable is linked against static FEXCore. AnyPS5 internals that the selected exports
// reference but the proof never reaches are linked as trapping stubs (host/unreached-exports.py).
// The ABI proof's guest code (host/guest-abi.c) is compiled for x86-64 and its text extracted for the host to map.
// --check runs the module function twice, with the import slot unbound (must fail) and bound to the thunk (must
// print PASS), and the ABI proof twice, through the generic register shim (must fail) and through per-signature
// thunks (must print PASS), and the start host twice, without the game's sce_module PRX modules (must stop) and with
// them (must reach main and print PASS), and the SYSCALL entry check once (must print PASS).
import {gitlink} from '../../lib/pins.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'../..');
const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json'),'utf8'));
const git=(directory,args,options={})=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:Infinity,stdio:['ignore','pipe','pipe'],...options});
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});

// Native builds run at the lowest priority. The process lowers its own priority first, so every compiler, CMake and
// Ninja child inherits it, and nothing builds when that is not permitted.
function lowestPriority(){
 try{os.setPriority(19);}catch(error){throw Error('Cannot lower the build priority to 19 ('+(error.info?.code||error.code)+'); nothing was built.');}
 if(os.getPriority()!==19)throw Error('The build priority is '+os.getPriority()+', not 19; nothing was built.');
}

function argumentsOf(argv){
 const options={};
 for(let at=0;at<argv.length;at++){
  if(argv[at]==='--out')options.out=path.resolve(argv[++at]);
  else if(argv[at]==='--check'){options.check=argv.slice(at+1,at+6);at+=5;}
  else if(argv[at]==='--only')options.only=new Set(argv[++at].split(','));
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

function applyOverlay(target,overlay){
 // The ceiling keeps git apply from discovering an enclosing repository.
 git(target,['apply','--whitespace=nowarn',path.join(import.meta.dirname,overlay.file)],{env:{...process.env,GIT_CEILING_DIRECTORIES:path.dirname(target)}});
}

function link(out,objects,log){
 const build=path.join(out,'build');
 run('cmake',['-S',path.join(out,'fex'),'-B',build,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DBUILD_TESTING=OFF','-DBUILD_FEXCONFIG=OFF',
  '-DENABLE_JEMALLOC_GLIBC_ALLOC=OFF','-DENABLE_OFFLINE_TELEMETRY=OFF','-DENABLE_CCACHE=OFF','-DENABLE_LTO=OFF','-DTUNE_CPU=none','-DTUNE_ARCH=generic',
  '-DCMAKE_PROJECT_FEX_INCLUDE='+path.join(out,'host',recipe.host.entry),'-DANYPS5_ARM64_OBJECTS='+objects.join(';'),'-DANYPS5_SOURCE_DIR='+path.join(out,'anyps5'),'-DANYPS5_GENERATED_THUNKS='+generatedFiles.join(';')],{stdio:['ignore','ignore','inherit']});
 const result=spawnSync('ninja',['-C',build,...recipe.host.targets],{encoding:'utf8',maxBuffer:Infinity});
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

const options=argumentsOf(process.argv.slice(2));
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('The proof builds on arm64 macOS.');
lowestPriority();
let niceness='unavailable';
try{niceness=execFileSync('ps',['-o','ni=','-p',String(process.pid)],{encoding:'utf8'}).trim();}catch{}
process.stdout.write('build priority (ps -o ni): '+niceness+'\n');
const fex=verifyCheckout(recipe.source),anyps5=verifyCheckout(recipe.anyps5);
fs.rmSync(path.join(options.out,'fex'),{recursive:true,force:true});fs.rmSync(path.join(options.out,'anyps5'),{recursive:true,force:true});
project(fex,path.join(options.out,'fex'));project(anyps5,path.join(options.out,'anyps5'),recipe.anyps5.paths);
for(const overlay of recipe.overlays)applyOverlay(path.join(options.out,overlay.target),overlay);
// Darwin overlays from producers/anyps5 RUNTIME_OVERLAYS that the compiled objects need and that edit only core/libs,
// applied in that list's order.
for(const [directory,method] of recipe.anyps5.runtimeOverlays)
 (await import(new URL('../anyps5/overlays/'+directory+'/apply.mjs',import.meta.url)))[method](path.join(options.out,'anyps5'));
// The arm64 library overlay's shared sources (GuestCpuArm64, owned by the PS5 library lane) go into the AnyPS5 projection.
const arm64Libraries=await import(new URL(recipe.anyps5.arm64Libraries.script,import.meta.url));
for(const name of recipe.anyps5.arm64Libraries.exports)arm64Libraries[name](path.join(options.out,'anyps5'));
// The host sources sit outside the FEX projection; fex-entry.cmake adds them to FEX's build.
const hostSource=path.join(options.out,'host');
fs.rmSync(hostSource,{recursive:true,force:true});fs.mkdirSync(hostSource,{recursive:true});
for(const file of recipe.host.sources)fs.copyFileSync(path.join(import.meta.dirname,recipe.host.directory,file),path.join(hostSource,file));

const guestObject=path.join(options.out,'guest-abi.x86_64.o'),guestText=path.join(options.out,'guest-abi.bin');
run('clang',['-arch','x86_64','-O2','-ffreestanding','-fno-builtin','-fno-stack-protector','-fno-asynchronous-unwind-tables','-c',
 path.join(import.meta.dirname,recipe.host.directory,recipe.host.guest.source),'-o',guestObject]);
const guestOffsets=execFileSync('python3',['-I',path.join(import.meta.dirname,recipe.host.directory,'macho-text.py'),guestObject,guestText,...recipe.host.guest.symbols],{encoding:'utf8'}).trim().split(' ');
const objects=recipe.anyps5.objects.map(source=>{
 // Named after the whole source path: several libraries have an Export.cpp or a Process.cpp.
 const object=path.join(options.out,'objects',source.replace(/\.cpp$/,'.arm64.o'));
 fs.mkdirSync(path.dirname(object),{recursive:true});
 run('clang++',['-std=c++20','-arch','arm64','-O2','-c','-I',path.join(options.out,'anyps5/core/libs'),'-I',path.join(options.out,'anyps5/3rdparty/ZArchive/include'),
  '-I',path.join(options.out,'anyps5/core/libs/nid/include'),path.join(options.out,'anyps5',source),'-o',object]);
 return object;
});
// One thunk translation unit per source, plus the part and data tables (generate-thunks.py prints the files).
const generatedThunks=path.join(options.out,'generated-thunks.cpp');
const generatedFiles=execFileSync('python3',['-I',path.join(import.meta.dirname,recipe.host.directory,recipe.host.generator.script),generatedThunks,
 path.join(options.out,'anyps5/core/libs'),...recipe.anyps5.objects.map(source=>path.join(options.out,'anyps5',source)),'--',...objects],{encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim().split('\n');
const firstLog=path.join(options.out,'link-exports.log');
if(!link(options.out,objects,firstLog)){
 if(!/Undefined symbols/.test(fs.readFileSync(firstLog,'utf8')))throw Error('The proof build failed; see '+firstLog);
 const assembly=path.join(options.out,'anyps5-unreached-exports.s'),stubs=path.join(options.out,'anyps5-unreached-exports.o');
 execFileSync('python3',['-I',path.join(import.meta.dirname,recipe.host.directory,'unreached-exports.py'),firstLog,assembly,...objects],{stdio:'inherit'});
 run('clang',['-c','-arch','arm64',assembly,'-o',stubs]);
 const secondLog=path.join(options.out,'link-proof.log');
 if(!link(options.out,[...objects,stubs],secondLog))throw Error('The proof build failed; see '+secondLog);
}
const [proof,abi,start,syscall]=recipe.host.targets.map(target=>path.join(options.out,'build/Bin',target));
process.stdout.write(proof+'\n'+abi+' '+guestText+' '+guestOffsets.join(' ')+'\n'+start+'\n'+syscall+'\n');
// The start host's static initializers include the AnyPS5 objects' registrations. Run without arguments, it stops at
// its usage message (exit 2) unless an initializer reaches one of the unreached-export stubs above (SIGTRAP).
{
 const usage=spawnSync(start,[],{encoding:'utf8',timeout:20000});
 if(usage.status!==2)throw Error(path.basename(start)+' did not reach main (status '+usage.status+', signal '+usage.signal+
  '): a static initializer called a symbol the proof does not link; see the crash report for the initializer.');
}
// Every link stub that an AnyPS5 export reaches through direct calls, with one call path each, in reachable-stubs.txt.
if(fs.existsSync(path.join(options.out,'anyps5-unreached-exports.s'))){
 const exports=objects.flatMap(object=>execFileSync('nm',['-gU','-j',object],{encoding:'utf8'}).split('\n')).filter(symbol=>symbol.endsWith('_nid_postfix'));
 const roots=path.join(options.out,'reachable-roots.txt'),report=path.join(options.out,'reachable-stubs.txt');
 fs.writeFileSync(roots,[...new Set(exports)].join('\n')+'\n');
 const reach=spawnSync('python3',['-I',path.join(import.meta.dirname,recipe.host.directory,'reachable-stubs.py'),start,
  path.join(options.out,'anyps5-unreached-exports.s'),'@'+roots],{encoding:'utf8',maxBuffer:Infinity});
 if(reach.status!==0)throw Error('reachable-stubs.py failed: '+reach.stderr);
 fs.writeFileSync(report,reach.stdout);
 process.stdout.write(reach.stderr.trim().split('\n').pop()+'; see '+report+'\n');
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
