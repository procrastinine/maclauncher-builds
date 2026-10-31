import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {linuxToolSelection,installedToolsDirectory} from './build-tools.mjs';
const systemDirectories=process.platform==='win32'?[]:['/usr/bin','/bin','/usr/sbin','/sbin'];
const locate=(name,env)=>{try{return execFileSync('/usr/bin/which',[name],{encoding:'utf8',env,stdio:['ignore','pipe','ignore']}).trim();}catch{return undefined;}};
/** Limit additional executable and library discovery to declared build tools. */
export function runtimeBuildEnvironment(build,{environment=process.env,platform=process.platform}={}){
 const env={...environment},aliases=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-build-tools-'));
 try{
  const names=new Set(build.tools||[]),brew=platform==='darwin'?locate('brew',environment):undefined,prefixes=[];
  if(!['darwin','linux'].includes(platform))throw Error('Runtime builds support macOS and Linux.');
  if(platform==='linux'){
   const selected=linuxToolSelection([...names]);
   const search={...environment,PATH:[path.join(installedToolsDirectory(environment),'bin'),environment.PATH].filter(Boolean).join(path.delimiter)};
   for(const name of selected.commands){
    const file=locate(name,search);
    if(!file||!path.isAbsolute(file))throw Error('Declared Linux build tool is not installed: '+name);
    fs.symlinkSync(file,path.join(aliases,name));
   }
  }
  if(platform==='darwin'&&names.size){
   if(!brew)throw Error('Install the declared Homebrew build formulae.');
   const dependencies=execFileSync(brew,['deps','--installed','--union',...names],{encoding:'utf8',env:environment,stdio:['ignore','pipe','pipe']}).trim();
   for(const name of dependencies.split('\n').filter(Boolean))names.add(name);
   for(const name of names){
    const prefix=execFileSync(brew,['--prefix',name],{encoding:'utf8',env:environment,stdio:['ignore','pipe','pipe']}).trim();
    if(!path.isAbsolute(prefix)||!fs.statSync(prefix).isDirectory())throw Error('Declared build formula is not installed: '+name);
    prefixes.push(prefix);
   }
  }
  const binaries=prefixes.flatMap(prefix=>['bin','sbin'].map(name=>path.join(prefix,name))).filter(file=>fs.existsSync(file));
  let compilerDirectory;
  if(platform==='darwin'){
   compilerDirectory=path.dirname(execFileSync('/usr/bin/xcrun',['--find','clang'],{encoding:'utf8',env:environment,stdio:['ignore','pipe','pipe']}).trim());
   // PATH invokes Xcode's compiler directly. Its C++ standard-library headers
   // need the same selected SDK that the xcrun compiler wrapper supplies.
   env.SDKROOT=environment.SDKROOT||execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8',env:environment,stdio:['ignore','pipe','pipe']}).trim();
  }
  fs.symlinkSync(process.execPath,path.join(aliases,'node'));
  const hostTools=[...(platform==='darwin'?['brew']:[]),'npm','npx','corepack','java','javac','jar',...(build.rustComponents?.length||build.rustTargets?.length?['rustup','cargo','rustc','rustdoc','rustfmt','cargo-fmt','cargo-clippy','clippy-driver']:[])];
  for(const name of hostTools){
   const file=locate(name,environment);
   if(file&&path.isAbsolute(file)){
    const target=path.join(aliases,name);
    if(name==='brew'){
     const quoted="'"+file.replaceAll("'","'\\''")+"'";
     fs.writeFileSync(target,'#!/bin/sh\nexec '+quoted+' "$@"\n',{mode:0o755});
    }else fs.symlinkSync(file,target);
   }
  }
  for(const name of ['PKG_CONFIG_PATH','PKG_CONFIG_LIBDIR','PKG_CONFIG_SYSROOT_DIR','CMAKE_PREFIX_PATH','CMAKE_FRAMEWORK_PATH','CMAKE_LIBRARY_PATH','CMAKE_INCLUDE_PATH','CMAKE_TOOLCHAIN_FILE','CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','LIBRARY_PATH','DYLD_LIBRARY_PATH','DYLD_FRAMEWORK_PATH','PYTHONPATH','PYTHONHOME','PYTHONUSERBASE','PERL5LIB','RUBYLIB','NODE_PATH','CC','CXX','CPP','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS','RUSTC','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS'])delete env[name];
  const configs=prefixes.flatMap(prefix=>['lib/pkgconfig','share/pkgconfig'].map(name=>path.join(prefix,name))).filter(file=>fs.existsSync(file));
  env.PATH=[compilerDirectory,...binaries,aliases,...systemDirectories].filter(Boolean).join(path.delimiter);
  env.PKG_CONFIG_PATH=configs.join(path.delimiter);
  env.PKG_CONFIG_LIBDIR=env.PKG_CONFIG_PATH;
  env.CMAKE_PREFIX_PATH=prefixes.join(path.delimiter);
  return {env,formulae:[...names],dispose:()=>fs.rmSync(aliases,{recursive:true,force:true})};
 }catch(error){fs.rmSync(aliases,{recursive:true,force:true});throw error;}
}
