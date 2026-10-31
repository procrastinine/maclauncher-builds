import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {checkoutSource,stageSource,sourceNotices,run,buildOptions} from './build-source.mjs';
import {rustEnvironment,rustNotices} from './rust-build.mjs';
import {sealRuntime} from './seal-runtime.mjs';
import {rustLicenseInputs} from './rust-license-inputs.mjs';
const root=path.resolve(import.meta.dirname,'..'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function buildSiglus({project,arch,output,work}){
 if(project!=='siglus'||!['arm64','x64'].includes(arch)||!path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select Siglus, a CPU and new absolute work/output paths.');
 const record=buildRecord(resolveProject(project,root)),owned=path.join(root,'producers/vn-adaptations/siglus'),pin=JSON.parse(fs.readFileSync(path.join(root,'producers/vn-adaptations/source.json'))).projects.siglus;
 fs.mkdirSync(work,{recursive:true});
 const sourceRoot=checkoutSource({repository:pin.upstream.url,revision:pin.upstream.revision,destination:path.join(work,'upstream')}),source=path.join(work,'source');
 const staged=await stageSource(sourceRoot,pin.upstream.revision,source),target=arch==='arm64'?'aarch64-apple-darwin':'x86_64-apple-darwin',env=rustEnvironment({work,minimumMacOS:'13.0'});
 for(const relative of ['src/app_path.rs','src/text_render.rs']){
  const file=path.join(source,'crates/siglus_scene_vm',relative),original=fs.readFileSync(file,'utf8'),before='let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));';
  if(original.split(before).length!==2)throw Error('Siglus resource lookup source differs from its pinned recipe.');
  fs.writeFileSync(file,original.replace(before,'let manifest_dir = std::env::current_exe().ok().and_then(|file| file.parent().map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("."));'));
 }
 run('cargo',['build','--locked','--release','--lib','--package','game_launcher','--target',target],{cwd:source,env});
 return packageSiglus({project,arch,output,work,sourceRoot,source,env,target,staged});
}
/** Seal compiled Siglus products and the matching source and license inputs. */
export async function packageSiglus({project,arch,output,work,sourceRoot,source,env,target,staged}){
 const record=buildRecord(resolveProject(project,root)),owned=path.join(root,'producers/vn-adaptations/siglus'),pin=JSON.parse(fs.readFileSync(path.join(root,'producers/vn-adaptations/source.json'))).projects.siglus;
 const licenses=await rustLicenseInputs({file:path.join(owned,'licenses.json'),output:path.join(work,'license-inputs')});
 const host=path.join(work,'siglus-host'),library=path.join(work,'libsiglus.dylib');
 run('/usr/bin/xcrun',['clang','-arch',arch==='x64'?'x86_64':arch,'-mmacosx-version-min=13.0','-O2','-fobjc-arc','-ffile-prefix-map='+owned+'=siglus-host',path.join(owned,'host.m'),'-framework','AppKit','-framework','Foundation','-o',host]);
 fs.copyFileSync(path.join(env.CARGO_TARGET_DIR,target,'release/libgame_launcher.dylib'),library);
 const profile=path.join(work,'siglus-profile.json'),license=path.join(owned,'LICENSE-siglus_rs.txt');
 fs.writeFileSync(profile,JSON.stringify({schema:1,profile:'siglus-rs-published-library-direct-host-v1',version:record.version,upstreamRevision:pin.upstream.revision,hostSourceSha256:hash(path.join(owned,'host.m')),files:{}},null,2)+'\n');
 return sealRuntime({project,arch,output,sourceRoot,upstreamRevision:pin.upstream.revision,executable:host,executableRelative:'bin/siglus-host',
  payloads:[{source:library,relative:'lib/libsiglus.dylib'},{source:profile,relative:'siglus-profile.json'},{source:license,relative:'LICENSE-siglus_rs.txt'}],
  notices:[...sourceNotices(source,{name:'siglus_rs',repository:pin.upstream.url}),...rustNotices({source,output:path.join(work,'notices'),env,target,licenseInputs:licenses.licenseInputs})],
  runtimeFiles:{siglusLibrary:'lib/libsiglus.dylib',siglusProfile:'siglus-profile.json'},
  jsonMetadata:{'siglus-profile.json':(value,{files})=>({...value,files:Object.fromEntries(['bin/siglus-host','lib/libsiglus.dylib','LICENSE-siglus_rs.txt'].map(name=>[name,hash(path.join(files,name))]))})},
  provenance:{licenseInputs:licenses.provenance,sourceTreeSha256:staged.treeSha256,gitDependencies:staged.dependencies,hostSourceSha256:hash(path.join(owned,'host.m')),resourceLookup:'executable-relative',nativeApi:'game_run_entry-v1'}});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildSiglus(buildOptions(process.argv.slice(2))).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
