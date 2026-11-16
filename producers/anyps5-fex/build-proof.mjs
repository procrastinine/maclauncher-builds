// SPDX-License-Identifier: GPL-2.0-only
// Builds the AnyPS5 under FEXCore proof host for arm64 macOS from pinned sources and owned overlays.
//
//   node producers/anyps5-fex/build-proof.mjs --out <directory> [--check <module.elf> <function> <slot> <bss>]
//
// The FEX checkout (with the submodules source.json lists) and the AnyPS5 paths are projected into
// <directory>, the overlays are applied there, AnyPS5's arm64 library objects are compiled, and the
// proof executable is linked against static FEXCore. AnyPS5 internals that the selected exports
// reference but the proof never reaches are linked as trapping stubs (proof/unreached-exports.py).
// --check runs the module function twice: with the import slot unbound (must fail) and bound to the
// thunk (must print PASS).
import {gitlink} from '../../lib/pins.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'../..');
const recipe=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'source.json'),'utf8'));
const git=(directory,args,options={})=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',maxBuffer:Infinity,stdio:['ignore','pipe','pipe'],...options});
const niced=(command,args,options={})=>execFileSync('nice',['-n','19',command,...args],{stdio:'inherit',...options});

function argumentsOf(argv){
 const options={};
 for(let at=0;at<argv.length;at++){
  if(argv[at]==='--out')options.out=path.resolve(argv[++at]);
  else if(argv[at]==='--check'){options.check=argv.slice(at+1,at+5);at+=4;}
  else throw Error('Unknown argument: '+argv[at]);
 }
 if(!options.out)throw Error('--out is required.');
 if(options.check&&options.check.length!==4)throw Error('--check takes a module and three addresses.');
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
 niced('cmake',['-S',path.join(out,'fex'),'-B',build,'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DBUILD_TESTING=OFF','-DBUILD_FEXCONFIG=OFF',
  '-DENABLE_JEMALLOC_GLIBC_ALLOC=OFF','-DENABLE_OFFLINE_TELEMETRY=OFF','-DENABLE_CCACHE=OFF','-DENABLE_LTO=OFF','-DTUNE_CPU=none','-DTUNE_ARCH=generic',
  '-DANYPS5_ARM64_OBJECTS='+objects.join(';')],{stdio:['ignore','ignore','inherit']});
 const result=spawnSync('nice',['-n','19','ninja','-C',build,recipe.proof.target],{encoding:'utf8',maxBuffer:Infinity});
 fs.writeFileSync(log,result.stdout+result.stderr);
 return result.status===0;
}

function check(binary,[module,functionAddress,slot,bss]){
 const run=mode=>spawnSync(binary,[module,functionAddress,slot,bss,mode],{encoding:'utf8',timeout:20000});
 const unbound=run('unbound'),bound=run('bound');
 process.stdout.write('--- unbound (exit '+unbound.status+')\n'+unbound.stdout+'--- bound (exit '+bound.status+')\n'+bound.stdout);
 if(unbound.status===0||/^PASS$/m.test(unbound.stdout))throw Error('The unbound run passed; the check proves nothing.');
 if(bound.status!==0||!/^PASS$/m.test(bound.stdout))throw Error('The bound run failed.');
}

const options=argumentsOf(process.argv.slice(2));
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('The proof builds on arm64 macOS.');
const fex=verifyCheckout(recipe.source),anyps5=verifyCheckout(recipe.anyps5);
fs.rmSync(path.join(options.out,'fex'),{recursive:true,force:true});fs.rmSync(path.join(options.out,'anyps5'),{recursive:true,force:true});
project(fex,path.join(options.out,'fex'));project(anyps5,path.join(options.out,'anyps5'),recipe.anyps5.paths);
for(const overlay of recipe.overlays)applyOverlay(path.join(options.out,overlay.target),overlay);
const proofSource=path.join(options.out,'fex/Source/AnyPS5FexProof');
fs.mkdirSync(proofSource,{recursive:true});
for(const file of ['CMakeLists.txt','AnyPS5FexProof.cpp'])fs.copyFileSync(path.join(import.meta.dirname,recipe.proof.directory,file),path.join(proofSource,file));

const objects=recipe.anyps5.objects.map(source=>{
 const object=path.join(options.out,path.basename(source,'.cpp')+'.arm64.o');
 niced('clang++',['-std=c++20','-arch','arm64','-O2','-c','-I',path.join(options.out,'anyps5/core/libs'),path.join(options.out,'anyps5',source),'-o',object]);
 return object;
});
const firstLog=path.join(options.out,'link-exports.log');
if(!link(options.out,objects,firstLog)){
 if(!/Undefined symbols/.test(fs.readFileSync(firstLog,'utf8')))throw Error('The proof build failed; see '+firstLog);
 const assembly=path.join(options.out,'anyps5-unreached-exports.s'),stubs=path.join(options.out,'anyps5-unreached-exports.o');
 const list=[];
 for(const object of objects){
  const part=assembly+'.'+list.length;
  execFileSync('python3',['-I',path.join(import.meta.dirname,recipe.proof.directory,'unreached-exports.py'),object,firstLog,part],{stdio:'inherit'});
  list.push(fs.readFileSync(part,'utf8'));
 }
 fs.writeFileSync(assembly,list.join('\n'));
 niced('clang',['-c','-arch','arm64',assembly,'-o',stubs]);
 const secondLog=path.join(options.out,'link-proof.log');
 if(!link(options.out,[...objects,stubs],secondLog))throw Error('The proof build failed; see '+secondLog);
}
const binary=path.join(options.out,'build/Bin',recipe.proof.target);
process.stdout.write(binary+'\n');
if(options.check)check(binary,options.check);
