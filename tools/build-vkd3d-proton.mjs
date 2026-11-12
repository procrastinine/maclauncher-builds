import './producer-environment.mjs';
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildInput,llvmMingwInput} from './build-input.mjs';
import {recipeMain} from './build-source.mjs';
import {pythonBuildTools} from './python-build-tools.mjs';
import {publicDeclaration} from './runtime-package.mjs';
import {signNgx} from '../producers/vkd3d-proton/ngx-signing.mjs';
import {addLicenses} from '../lib/licenses.mjs';
import {buildProvider} from '../producers/vkd3d-proton/build.mjs';
const require=createRequire(import.meta.url),B=require('../lib/package-format.cjs'),{readPeExports}=require('../lib/pe-exports.cjs');
const root=path.resolve(import.meta.dirname,'..'),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// Launcher floor: app package.json build.mac.minimumSystemVersion.
const minimumMacOS='13.0';
/** Compile the vkd3d-proton translator with the llvm-mingw toolchain. */
export async function compile({work}){
  const archive=await buildInput(llvmMingwInput());
  const toolchain=path.join(work,'llvm-mingw');fs.mkdirSync(toolchain,{recursive:true});
  execFileSync('/usr/bin/tar',['-xf',archive,'--strip-components','1','-C',toolchain],{stdio:'inherit'});
  const tools=await pythonBuildTools(path.join(work,'build-tools'),'sdk27');
  const built=buildProvider({work:path.join(work,'translator'),output:path.join(work,'payload'),mingw:path.join(toolchain,'bin'),
    meson:path.join(tools.bin,'meson'),ninja:path.join(tools.bin,'ninja')});
 const signingPin=JSON.parse(fs.readFileSync(path.join(root,'producers/dependencies/osslsigncode.json')))[process.arch];
  if(!signingPin)throw Error('NGX signing requires an arm64 or x64 macOS host.');
  const signingArchive=await buildInput(signingPin),signingTools=path.join(work,'osslsigncode');fs.mkdirSync(signingTools);
  execFileSync('/usr/bin/unzip',['-q',signingArchive,'-d',signingTools]);
  const signingRoot=path.join(signingTools,fs.readdirSync(signingTools)[0]);
  const openssl=path.join(execFileSync('brew',['--prefix','openssl@3'],{encoding:'utf8'}).trim(),'bin/openssl');
  built.ngxTrust=signNgx({work,output:built.output,mingw:path.join(toolchain,'bin'),osslsigncode:path.join(signingRoot,'osslsigncode'),openssl});
  addLicenses(built.output,'osslsigncode',signingRoot);
 return {built};
}
/** Stage, describe and declare the compiled translator. */
export async function assemble({project,version,arch,output,compiled:{built}}){
  if(fs.existsSync(output))throw Error('The immutable translator package output already exists.');
  const payload=path.join(output,'payload');fs.mkdirSync(output,{recursive:true});
  fs.cpSync(built.output,payload,{recursive:true});
  const source={repository:'https://github.com/procrastinine/maclauncher-builds',revision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    upstream:built.source,ngx:built.ngx,...(built.streamline?{streamline:built.streamline}:{}),...(built.minhook?{minhook:built.minhook}:{})};
  fs.writeFileSync(path.join(payload,'source.json'),JSON.stringify(source,null,2)+'\n');
  fs.writeFileSync(path.join(payload,'manifest.json'),JSON.stringify({schemaVersion:1,managerId:project,version,arch,platform:'windows',
    guestArchitectures:['x86','x86_64'],minimumMacOS,upstreamRevision:built.source.revision,ngxTrust:built.ngxTrust},null,2)+'\n');
  const files=B.fileInventory(payload).map(relative=>{
    const file=path.join(payload,relative),bytes=fs.readFileSync(file),pe=/\.(dll|exe)$/.test(relative)?readPeExports(file):null,mode=pe?0o755:0o644;
    fs.chmodSync(file,mode);
    return {path:relative,size:bytes.length,sha256:sha(bytes),mode,...(pe?{format:'pe',architectures:[pe.architecture]}:{})};
  });
  const declaration={id:project,version,arch,launcherArchitectures:['arm64','x64'],minimumMacOS,directoryRelative:project+'/'+version+'/'+arch,
    sourceRelative:'source.json',sourceSha256:files.find(f=>f.path==='source.json').sha256,
    manifestRelative:'manifest.json',manifestSha256:files.find(f=>f.path==='manifest.json').sha256,files,redistribution:'bundle'};
  publicDeclaration(declaration);
  fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n');
  return {project,version,arch,output};
}
recipeMain(import.meta,{compile,assemble});
