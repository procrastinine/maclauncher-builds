import {sourceRevision} from '../lib/pins.mjs';
import './producer-environment.mjs';
import {addLicense,addLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {checkoutSource,stageSource,run,recipeMain} from "./build-source.mjs";
import {rustEnvironment} from "./rust-build.mjs";
import {sealRuntime} from './seal-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Compile the Siglus library and host from the pinned source. */
export async function compile({project,arch,work}){
 const owned=path.join(root,'producers/vn-adaptations/siglus'),hostSource=path.join(owned,'host.m'),pin=JSON.parse(fs.readFileSync(path.join(root,'producers/vn-adaptations/source.json'))).projects.siglus;
 fs.mkdirSync(work,{recursive:true});
 const sourceRoot=checkoutSource({repository:pin.upstream.url,revision:sourceRevision(pin.upstream),destination:path.join(work,'upstream')}),source=path.join(work,'source');
 const staged=await stageSource(sourceRoot,sourceRevision(pin.upstream),source),target=arch==='arm64'?'aarch64-apple-darwin':'x86_64-apple-darwin',env=rustEnvironment({work,minimumMacOS:'13.0'});
 for(const relative of ['src/app_path.rs','src/text_render.rs']){
  const file=path.join(source,'crates/siglus_scene_vm',relative),original=fs.readFileSync(file,'utf8'),before='let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));';
  if(original.split(before).length!==2)throw Error('Siglus resource lookup source differs from its pinned recipe.');
  fs.writeFileSync(file,original.replace(before,'let manifest_dir = std::env::current_exe().ok().and_then(|file| file.parent().map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("."));'));
 }
 run('cargo',['build','--locked','--release','--lib','--package','game_launcher','--target',target],{cwd:source,env});
 const host=path.join(work,'siglus-host'),library=path.join(work,'libsiglus.dylib');
 run('/usr/bin/xcrun',['clang','-arch',arch==='x64'?'x86_64':arch,'-mmacosx-version-min=13.0','-O2','-fobjc-arc','-ffile-prefix-map='+path.dirname(hostSource)+'=siglus-host',hostSource,'-framework','AppKit','-framework','Foundation','-o',host]);
 fs.copyFileSync(path.join(env.CARGO_TARGET_DIR,target,'release/libgame_launcher.dylib'),library);
 return {sourceRoot,source,env,staged,host,library};
}
/** Seal the compiled Siglus products with their profile and the matching source and license inputs. */
export async function assemble({project,arch,output,work,compiled:{sourceRoot,source,env,staged,host,library}}){
 const record=buildRecord(resolveProject(project,root)),owned=path.join(root,'producers/vn-adaptations/siglus'),hostSource=path.join(owned,'host.m'),pin=JSON.parse(fs.readFileSync(path.join(root,'producers/vn-adaptations/source.json'))).projects.siglus;
 addLicenses(source,project,owned);
 const profile=path.join(work,'siglus-profile.json');
 fs.writeFileSync(profile,JSON.stringify({schema:1,profile:'siglus-rs-published-library-direct-host-v1',version:record.version,upstreamRevision:sourceRevision(pin.upstream),hostSourceSha256:hash(hostSource),files:{}},null,2)+'\n');
 return sealRuntime({cargoRoot:source,env,project,arch,output,sourceRoot,upstreamRevision:sourceRevision(pin.upstream),executable:host,executableRelative:'bin/siglus-host',payloads:[{source:library,relative:'lib/libsiglus.dylib'},{source:profile,relative:'siglus-profile.json'}],runtimeFiles:{siglusLibrary:'lib/libsiglus.dylib',siglusProfile:'siglus-profile.json'},jsonMetadata:{'siglus-profile.json':(value,{files})=>{
  const compatibility=addLicense(files,'siglus_rs',path.join(sourceRoot,'LICENSE-MPL-2.0'),'siglus_rs','LICENSE-siglus_rs.txt');
  return {...value,files:{...Object.fromEntries(['bin/siglus-host','lib/libsiglus.dylib'].map(name=>[name,hash(path.join(files,name))])),...(compatibility?{'LICENSE-siglus_rs.txt':compatibility.sha256}:{})}};
 }},provenance:{gitDependencies:staged.dependencies,hostSourceSha256:hash(hostSource),resourceLookup:'executable-relative',nativeApi:'game_run_entry-v1'}});
}
recipeMain(import.meta,{compile,assemble});
