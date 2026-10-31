#!/usr/bin/env node
// Developer build and publication of the fixed AIM adaptation. Play uses only
// this sealed payload and a separately acquired original Android image.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {prepareAimSources,source} from '../src/modules/android/providers/aim/source.mjs';
const require = createRequire(import.meta.url);
const B = require('../src/modules/shared/runtime/bundled-native');
const Native = require('../src/modules/shared/runtime/local-native');
const Supplemental = require('./native-supplementals.cjs');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const minimumMacOS = '26.0';
const binaries = ['aimctl','maclauncher-aim','aim-apps','aim-display','aim-binderd','aim-lock-holder','aim-pty-holder','guest-init','linux-run','linux-translate','android-image-extract','android-runtime-prepare'];
const imageProducts = ['daemon','art','boot-image','device-services','system-server','oat','moltenvk',
  ...['allocator','audio','bluetooth','camera','composer','gles','gnss','health','mapper','sensors','vulkan'].map(name=>'hal/'+name)];
const appHostFiles = ['target/aim/daemons/bin/aim-app-host-agent','target/aim/device-services/aim-nearby.jar',
  ...['aim-app-host-agent.rc','aim-system','aim-system.rc','services'].map(file=>'image/app-host/'+file)];
const run = (program,args,options={}) => execFileSync(program,args,{stdio:'inherit',...options});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function copy(from,to) { fs.mkdirSync(path.dirname(to),{recursive:true}); fs.copyFileSync(from,to); }
function files(root,relative='') {
  return fs.readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const name=path.posix.join(relative,entry.name);
    if(entry.isSymbolicLink()) throw new Error('Payload cannot contain symbolic links: '+name);
    return entry.isDirectory()?files(root,name):[name];
  });
}
function architecture(file) { try { return Native.readMachOArchitectures(file,{allowLibrary:true}); } catch { return null; } }
function inventory(root) { return files(root).map(file=>{
  const full=path.join(root,file),stat=fs.statSync(full),arch=architecture(full);
  return {path:file,size:stat.size,mode:stat.mode&0o777,sha256:sha(full),...(arch?{architectures:arch}:{})};
}); }
function overlaySources(root,manifest,seen=new Set()) {
  if(seen.has(manifest)) return seen;
  seen.add(manifest);
  for(const match of fs.readFileSync(path.join(root,manifest),'utf8').matchAll(/^source = "([^"]+)"/gm)) {
    B.relativeFile(match[1]); seen.add(match[1]);
    if(match[1].endsWith('.toml')) {
      // Includes are flat in the upstream schema.
      for(const nested of fs.readFileSync(path.join(root,match[1]),'utf8').matchAll(/^source = "([^"]+)"/gm)) { B.relativeFile(nested[1]);seen.add(nested[1]); }
    }
  }
  return seen;
}
function noticeTree(from,to) {
  for(const file of files(from)) copy(path.join(from,file),path.join(to,file));
}
export function stageAim({build,angle,angleNotices,output,writeDistribution=true,environment=process.env,version=source.version}) {
  build=path.resolve(build);angle=path.resolve(angle);angleNotices=path.resolve(angleNotices);output=path.resolve(output);
  if(fs.existsSync(output))throw new Error('The AIM runtime version already exists. Staging requires a new immutable version.');
  const temporary=output+'.stage-'+process.pid;
  fs.rmSync(temporary,{recursive:true,force:true});
  const payload=path.join(temporary,'files');fs.mkdirSync(payload,{recursive:true});
  try {
    const metadata=JSON.parse(run('cargo',['metadata','--format-version','1','--locked'],{cwd:build,env:environment,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:32*1024*1024}));
    // cargo-aim compiles host programs here before publishing executable
    // copies. Other source builds may share the public target directory.
    const hostBinaries=path.join(metadata.target_directory,'aim-host-build/release');
    for(const name of binaries) {
      const file=path.join(payload,'bin',name);copy(path.join(hostBinaries,name),file);
      fs.chmodSync(file,0o755);
      run('/usr/bin/strip',['-S',file]);
      // ASIF storage is used by every ordinary launch. Publish that real OS
      // requirement in the executable as well as in the package declaration.
      run('/usr/bin/vtool',['-set-build-version','macos',minimumMacOS,'27.0','-replace','-output',file,file]);
      run('/usr/bin/codesign',['--force','--sign','-',file]);
    }
    for(const file of overlaySources(build,'image/overlay.toml')) copy(path.join(build,file),path.join(payload,file));
    for(const file of appHostFiles) copy(path.join(build,file),path.join(payload,file));
    for(const name of ['libEGL.dylib','libGLESv2.dylib']) copy(path.join(angle,name),path.join(payload,'_build/angle-source/out/AimRelease',name));
    for(const name of ['libMoltenVK.dylib','LICENSE']) copy(path.join(build,'target/aim/moltenvk',name),path.join(payload,'target/aim/moltenvk',name));
    const molten=path.join(payload,'target/aim/moltenvk/libMoltenVK.dylib');
    if(architecture(molten).length>1) run('/usr/bin/lipo',[molten,'-thin','arm64','-output',molten]);
    const notices=[];
    for(const [name,license,from,to,url] of [
      ['AIM','Apache-2.0',path.join(build,'LICENSE'),'notices/aim/LICENSE','https://github.com/hahnlee/aim'],
      ['AIM notice','See notice',path.join(build,'NOTICE'),'notices/aim/NOTICE','https://github.com/hahnlee/aim'],
      ['AIM third-party notices','Multiple',path.join(build,'THIRD_PARTY_NOTICES.md'),'notices/aim/THIRD_PARTY_NOTICES.md','https://github.com/hahnlee/aim'],
      ['AIM licensing exceptions','Multiple',path.join(build,'LICENSING.md'),'notices/aim/LICENSING.md','https://github.com/hahnlee/aim'],
      ['MoltenVK','Apache-2.0',path.join(build,'target/aim/moltenvk/LICENSE'),'notices/moltenvk/LICENSE','https://github.com/KhronosGroup/MoltenVK'],
      ['BoringSSL','ISC AND OpenSSL',path.join(build,'_build/aosp/external/boringssl/src/LICENSE'),'notices/boringssl/LICENSE','https://boringssl.googlesource.com/boringssl'],
    ]) {copy(from,path.join(payload,to));notices.push({name,license,path:to,sourceUrl:url});}
    const modifications='notices/aim/MacLauncher-modifications.txt';
    fs.writeFileSync(path.join(payload,modifications),
      `AIM runtime modified by MacLauncher.\nRuntime version: ${version}\nOriginal AIM revision: ${source.commit}\n`+
      'Modifications cover filesystem paths, process ownership, display routing and build integration.\n'+
      'Cgroup pruning reuses owner thread lists within each transaction; anonymous memfd retirement queries VM region information without vnode paths.\n'+
      'Cgroup writes acquire descriptor ownership before file position; the controller preserves pending first-draw activity starts.\n'+
      'Build recipes and modification sources: https://github.com/procrastinine/maclauncher-builds\n');
    notices.push({name:'MacLauncher AIM modifications',license:'See source licenses',path:modifications,sourceUrl:'https://github.com/procrastinine/maclauncher-builds'});
    noticeTree(path.join(build,'licensing'),path.join(payload,'notices/aim/licensing'));
    for(const file of files(path.join(payload,'notices/aim/licensing/third-party'))) notices.push({name:'AIM dependency '+file,license:'See notice',path:'notices/aim/licensing/third-party/'+file,sourceUrl:'https://github.com/hahnlee/aim'});
    noticeTree(angleNotices,path.join(payload,'notices/angle'));
    const angleManifest=path.join(angle,'angle-manifest.json');
    if(fs.existsSync(angleManifest))copy(angleManifest,path.join(payload,'notices/angle/angle-manifest.json'));
    for(const file of files(angleNotices).filter(name=>name.endsWith('.txt'))) notices.push({name:'ANGLE '+file,license:'See notice',path:'notices/angle/'+file,sourceUrl:'https://chromium.googlesource.com/angle/angle'});
    // Rust crate notices cover statically linked registry code too. Cargo's
    // locked metadata identifies the exact supplier for every included text.
    for(const pkg of metadata.packages.filter(pkg=>pkg.source?.startsWith('registry+'))) {
      const directory=path.dirname(pkg.manifest_path);
      for(const name of fs.readdirSync(directory).filter(file=>/^(LICENSE|COPYING|NOTICE|COPYRIGHT)(?:$|[-_.])/i.test(file)&&fs.statSync(path.join(directory,file)).isFile())) {
        const relative=`notices/rust/${pkg.name}-${pkg.version}/${name}`;copy(path.join(directory,name),path.join(payload,relative));
        notices.push({name:pkg.name+' '+pkg.version,license:pkg.license||'See notice',path:relative,sourceUrl:`https://crates.io/crates/${pkg.name}/${pkg.version}`});
      }
    }
    for(const file of files(payload)) {
      const full=path.join(payload,file),arch=architecture(full);
      fs.chmodSync(full,arch||(fs.statSync(full).mode&0o111)?0o755:0o644);
      if(arch) run('/usr/bin/codesign',['--force','--sign','-',full]);
    }
    const records=inventory(payload),dependencies=[];
    for(const file of records.filter(file=>file.architectures)) {
      const full=path.join(payload,file.path),lines=run('/usr/bin/otool',['-L',full],{encoding:'utf8',stdio:['ignore','pipe','inherit']}).split('\n').slice(1).filter(Boolean);
      const links=lines.map(line=>line.trim().split(' (compatibility')[0]);
      if(file.path.endsWith('.dylib')) links.shift();
      for(const link of links) if(!link.startsWith('/usr/lib/')&&!link.startsWith('/System/Library/')&&!link.startsWith('@loader_path/')) throw new Error('Unresolved native dependency '+file.path+': '+link);
      dependencies.push({file:file.path,links});
    }
    // The supplier derives these transactions from pinned AIDL and verifies
    // them against the original image. Keep the selected runtime's ABI.
    const aidl=fs.readFileSync(path.join(build,'target/aim/gen/service-aidl/lib.rs'),'utf8');
    const unlockCodes=[...aidl.matchAll(/pub const IS_USER_UNLOCKING_OR_UNLOCKED: u32 = (\d+);/g)];
    if(unlockCodes.length!==1)throw new Error('AIM user-state transaction is unavailable.');
    const appHostUserUnlockTransaction=Number(unlockCodes[0][1]);
    const manifest={schemaVersion:1,managerId:'android-aim',version:version,upstreamRevision:source.commit,platform:'darwin',arch:'arm64',minimumMacOS,capabilities:{appHost:true,appHostUserUnlockTransaction},
      executableRelative:'bin/aimctl',runtimeFiles:{controller:'bin/maclauncher-aim'},files:records,notices,dependencies,provenance:{sourceRevision:source.commit,verifiedBuild:true}};
    B.validateManifest(manifest);B.verifyPayload(payload,manifest);
    fs.writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    const declaration={id:'android-aim',version:version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS,directoryRelative:`android-aim/${version}/arm64`,
      manifestRelative:'manifest.json',manifestSha256:sha(path.join(temporary,'manifest.json')),sourceRelative:null,sourceSha256:sha(path.join(temporary,'manifest.json')),
      files:inventory(temporary),notices:notices.map(notice=>({...notice,path:'files/'+notice.path})),redistribution:'bundle'};
    Supplemental.validateDeclaration(declaration);
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.renameSync(temporary,output);
    if(writeDistribution)fs.writeFileSync(path.join(repo,'src/modules/android/aim-distribution.json'),JSON.stringify([declaration],null,2)+'\n');
    return {output,declaration};
  } catch(error) {fs.rmSync(temporary,{recursive:true,force:true});throw error;}
}

/** Add the original AIM graph flags without discarding inherited encoded arguments. */
export function aimCompilerEnvironment({build,jobs=2,environment=process.env}){
 const maps=[`--remap-path-prefix=${build}=/aim`,`--remap-path-prefix=${repo}=/maclauncher`,`--remap-path-prefix=${environment.CARGO_HOME||path.join(os.homedir(),'.cargo')}=/cargo`];
 const result={...environment,MACLAUNCHER_AIM_ROOT:build,CARGO_PROFILE_RELEASE_STRIP:'none',CARGO_BUILD_JOBS:String(jobs)};
 if(typeof environment.CARGO_ENCODED_RUSTFLAGS==='string'){
  result.CARGO_ENCODED_RUSTFLAGS=[...(environment.CARGO_ENCODED_RUSTFLAGS?environment.CARGO_ENCODED_RUSTFLAGS.split(String.fromCharCode(31)):[]),...maps].join(String.fromCharCode(31));
  delete result.RUSTFLAGS;
 }else result.RUSTFLAGS=[environment.RUSTFLAGS,...maps].filter(Boolean).join(' ');
 return result;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=(flag,fallback)=>{const at=args.indexOf(flag);return at<0?fallback:args[at+1];};
  const build=path.resolve(value('--work',path.join(os.homedir(),'Library/Caches/maclauncher/android-aim-build/upstream')));
  const jobs=Number(value('--jobs','2'));
  if(!Number.isSafeInteger(jobs)||jobs<1)throw new Error('AIM build jobs require a positive integer.');
  if(args.includes('--prepare')||args.includes('--build')) {
    // The public Builds producer owns the controller. Launcher-side developer
    // invocations pass that same source explicitly; no app controller is used.
    const controllerSource=path.resolve(value('--controller-source',fileURLToPath(new URL('../../android-aim-controller/keeper.rs',import.meta.url))));
    if(!fs.existsSync(controllerSource)||!fs.lstatSync(controllerSource).isFile()||fs.lstatSync(controllerSource).isSymbolicLink())
      throw new Error('Select the Builds-owned controller with --controller-source <maclauncher-builds/producers/android-aim-controller/keeper.rs>.');
    prepareAimSources({checkout:path.join(repo,'src/external/aim'),output:build,controllerSource,buildJobs:jobs});
    const stagedController=path.join(build,'crates/aimctl/src/bin/maclauncher-aim.rs');
    if(sha(stagedController)!==sha(controllerSource))throw new Error('The generated AIM controller source differs from its Builds input.');
  }
  // Publish the overlay's inputs. The app prepares its shared system image
  // during Play, so a build needs no additional mounted derived-image copy.
  if(args.includes('--build')) run('cargo',['aim','build','-j',String(jobs),...(args.includes('--image-only')?['image']:[...binaries.map(name=>'host/'+name),...imageProducts])],{cwd:build,env:aimCompilerEnvironment({build,jobs})});
  if(args.includes('--stage')) {
    const angle=value('--angle'),angleNotices=value('--angle-notices');
    if(!angle||!angleNotices) throw new Error('Staging needs --angle and --angle-notices for the pinned ANGLE supplier.');
    const output=path.join(repo,'build/managed-runtimes/android-aim',source.version,'arm64');
    const staged=stageAim({build,angle,angleNotices,output});
    console.log(JSON.stringify({output:staged.output,files:staged.declaration.files.length,bytes:staged.declaration.files.reduce((total,file)=>total+file.size,0),minimumMacOS}));
  }
}
