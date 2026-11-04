import {checkoutSource} from '../../../tools/build-source.mjs';
#!/usr/bin/env node
import {addLicenses,addLicense,includeLicenses,addCargoLicenses} from '../../../lib/licenses.mjs';
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
export function stageAim({build,angle,output,writeDistribution=true,environment=process.env,version=source.version}) {
  build=path.resolve(build);angle=path.resolve(angle);output=path.resolve(output);
  if(fs.existsSync(output))throw new Error('The AIM runtime version already exists. Staging requires a new immutable version.');
  const temporary=output+'.stage-'+process.pid;
  fs.rmSync(temporary,{recursive:true,force:true});
  const payload=path.join(temporary,'files');fs.mkdirSync(payload,{recursive:true});
  try {
    const metadata=JSON.parse(run('cargo',['metadata','--format-version','1','--locked'],{cwd:build,env:environment,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer: Infinity}));
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
    for(const name of ['libMoltenVK.dylib']) copy(path.join(build,'target/aim/moltenvk',name),path.join(payload,'target/aim/moltenvk',name));
    const molten=path.join(payload,'target/aim/moltenvk/libMoltenVK.dylib');
    if(architecture(molten).length>1) run('/usr/bin/lipo',[molten,'-thin','arm64','-output',molten]);
    addLicenses(payload,'AIM',build);
    addLicense(payload,'AIM',path.join(build,'THIRD_PARTY_NOTICES.md'));
    addLicenses(payload,'MoltenVK',path.join(build,'target/aim/moltenvk'));
    addLicenses(payload,'BoringSSL',path.join(build,'_build/aosp/external/boringssl/src'));
    addCargoLicenses(payload,'AIM',build,environment);
    includeLicenses(payload,path.join(angle,'licenses'));
    const angleManifest=path.join(angle,'angle-manifest.json');
    if(fs.existsSync(angleManifest))copy(angleManifest,path.join(payload,'angle-manifest.json'));
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
      dependencies.push({file:file.path,links});
    }
    // The supplier derives these transactions from pinned AIDL and verifies
    // them against the original image. Keep the selected runtime's ABI.
    const aidl=fs.readFileSync(path.join(build,'target/aim/gen/service-aidl/lib.rs'),'utf8');
    const unlockCodes=[...aidl.matchAll(/pub const IS_USER_UNLOCKING_OR_UNLOCKED: u32 = (\d+);/g)];
    if(unlockCodes.length!==1)throw new Error('AIM user-state transaction is unavailable.');
    const appHostUserUnlockTransaction=Number(unlockCodes[0][1]);
    const manifest={schemaVersion:1,managerId:'android-aim',version:version,upstreamRevision:source.commit,platform:'darwin',arch:'arm64',minimumMacOS,capabilities:{appHost:true,appHostUserUnlockTransaction},
      executableRelative:'bin/aimctl',runtimeFiles:{controller:'bin/maclauncher-aim'},files:records,dependencies,provenance:{sourceRevision:source.commit,verifiedBuild:true}};
    B.validateManifest(manifest);B.verifyPayload(payload,manifest);
    fs.writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    const declaration={id:'android-aim',version:version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS,directoryRelative:`android-aim/${version}/arm64`,
      manifestRelative:'manifest.json',manifestSha256:sha(path.join(temporary,'manifest.json')),sourceRelative:null,sourceSha256:sha(path.join(temporary,'manifest.json')),
      files:inventory(temporary),redistribution:'bundle'};
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
  if(args.includes('--prepare')) {
    // The public Builds producer owns the controller. Launcher-side developer
    // invocations pass that same source explicitly; no app controller is used.
    const controllerSource=path.resolve(value('--controller-source',fileURLToPath(new URL('../../android-aim-controller/keeper.rs',import.meta.url))));
    if(!fs.existsSync(controllerSource)||!fs.lstatSync(controllerSource).isFile()||fs.lstatSync(controllerSource).isSymbolicLink())
      throw new Error('Select the Builds-owned controller with --controller-source <maclauncher-builds/producers/android-aim-controller/keeper.rs>.');
    prepareAimSources({checkout:checkoutSource({repository:source.repository,revision:source.commit,destination:path.join(path.dirname(build),'aim-source')}),output:build,controllerSource,buildJobs:jobs});
    const stagedController=path.join(build,'crates/aimctl/src/bin/maclauncher-aim.rs');
    if(sha(stagedController)!==sha(controllerSource))throw new Error('The generated AIM controller source differs from its Builds input.');
  }
  // Publish the overlay's inputs. The app prepares its shared system image
  // during Play, so a build needs no additional mounted derived-image copy.
  if(args.includes('--build')) run('cargo',['aim','build','-j',String(jobs),...(args.includes('--image-only')?['image']:[...binaries.map(name=>'host/'+name),...imageProducts])],{cwd:build,env:aimCompilerEnvironment({build,jobs})});
  if(args.includes('--stage')) {
    const angle=value('--angle');
    if(!angle) throw new Error('Staging needs the pinned ANGLE supplier.');
    const output=path.join(repo,'build/managed-runtimes/android-aim',source.version,'arm64');
    const staged=stageAim({build,angle,output});
    console.log(JSON.stringify({output:staged.output,files:staged.declaration.files.length,bytes:staged.declaration.files.reduce((total,file)=>total+file.size,0),minimumMacOS}));
  }
}
