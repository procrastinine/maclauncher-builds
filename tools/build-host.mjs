import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {macosSDKVersion} from '../lib/reproducible-build.mjs';
import {installBuildTools,installedToolsDirectory} from './build-tools.mjs';
const HOST_OS=Object.freeze({darwin:'macos',linux:'linux'});

/** A build runs on the OS and CPU of the GitHub-hosted runner its record selects. */
export function assertBuildHost(label,runner,{platform=process.platform,cpu=process.arch}={}){
 if(!runner||HOST_OS[platform]!==runner.os||cpu!==runner.cpu)throw Error('This build runs on the '+label+' runner ('+(runner?runner.os+' '+runner.cpu:'undeclared')+'), not on '+platform+' '+cpu+'.');
}

/** Rustup commands for the declared toolchain, components and CPU targets. */
export function rustSetupCommands(build,toolchain){
 const selection=toolchain?['--toolchain',toolchain]:[];
 return [...(toolchain?[['toolchain','install',toolchain,'--profile','minimal']]:[]),
  ...(build.rustComponents?.length?[['component','add',...selection,...build.rustComponents]]:[]),
  ...(build.rustTargets?.length?[['target','add',...selection,...build.rustTargets]]:[])];
}

/** Prepare the selected host's SDK, declared tools and Rust toolchain.
 * Returns the environment and PATH entries that source initialization and later steps keep. */
export function prepareBuildHost({build,label,runner,rustToolchain,install=true,verifyHost=true,environment=process.env,platform=process.platform,cpu=process.arch,
 run=(command,args,options)=>execFileSync(command,args,{stdio:'inherit',...options}),
 read=(command,args,options)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options}).trim(),
 installTools=installBuildTools}){
 if(verifyHost)assertBuildHost(label,runner,{platform,cpu});
 const env={},paths=[],current=()=>({...environment,...env,PATH:[...paths,environment.PATH].filter(Boolean).join(path.delimiter)});
 if(verifyHost&&runner?.developerDirectory){
  const hosted=environment.GITHUB_ACTIONS==='true'&&environment.RUNNER_ENVIRONMENT==='github-hosted';
  env.DEVELOPER_DIR=!hosted&&environment.DEVELOPER_DIR||runner.developerDirectory;
  const xcode=read('/usr/bin/xcodebuild',['-version'],{env:current()}).split('\n')[0].replace(/^Xcode /,''),sdk=macosSDKVersion(current(),{read:(command,args)=>read(command,args,{env:current()})});
  if(xcode!==runner.xcodeVersion||sdk!==runner.sdkVersion)throw Error('The '+label+' runner provides Xcode '+xcode+' and SDK '+sdk+'; its declaration names Xcode '+runner.xcodeVersion+' and SDK '+runner.sdkVersion+'.');
 }
 if(install&&build.cleanupRunner===true)run(process.execPath,[fileURLToPath(new URL('./cleanup-runner.mjs',import.meta.url)),...(environment.GITHUB_ACTIONS==='true'&&environment.RUNNER_ENVIRONMENT==='github-hosted'?['--apply']:[]),'--tools',(build.tools||[]).join(' ')],{env:current()});
 if(build.tools?.length){
  if(install){
   const toolEnvironment={...current(),HOMEBREW_NO_AUTO_UPDATE:'1',HOMEBREW_NO_INSTALL_CLEANUP:'1'};delete toolEnvironment.GITHUB_PATH;
   installTools(build.tools,{platform,environment:toolEnvironment,execute:run});
  }
  if(platform==='linux'&&build.tools.includes('uv'))paths.push(path.join(installedToolsDirectory(environment),'bin'));
 }
 if(build.rustComponents?.length||build.rustTargets?.length){
  if(rustToolchain)env.RUSTUP_TOOLCHAIN=rustToolchain;
  if(install)for(const args of rustSetupCommands(build,rustToolchain))run('rustup',args,{env:current()});
 }
 return {env,paths};
}
