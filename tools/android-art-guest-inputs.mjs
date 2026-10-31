import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {checkoutSource,run} from './build-source.mjs';
import {acquireArtSourceSelection} from './android-art-source-selection.mjs';
const root=path.resolve(import.meta.dirname,'..');
const profile=JSON.parse(fs.readFileSync(new URL('../producers/android-art-inputs/guest.json',import.meta.url)));
const read=(program,args)=>execFileSync(program,args,{encoding:'utf8'}).trim();
function alias(destination,source){
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 if(fs.existsSync(destination))throw Error('The ART source input already exists: '+destination);
 fs.symlinkSync(fs.realpathSync(source),destination,'dir');
}

/** Preserve original AIDL backend choices when generating C++ declarations. */
export async function cppAidlSources({directory,android,parser,targets}){
 const files=fs.globSync('**/*.aidl',{cwd:directory}),blueprint=path.join(directory,'Android.bp');
 if(!targets)return files;
 if(!fs.existsSync(blueprint))throw Error('Missing original AIDL module declarations.');
 const {parseBlueprint}=await import(pathToFileURL(path.join(android,'src/modules/android/native/upstream/blueprint.mjs')));
 const modules=parseBlueprint(fs.readFileSync(blueprint,'utf8'),{file:blueprint,parser}).modules;
 const patterns=(values,seen=new Set())=>(values||[]).flatMap(value=>{
  if(!value.startsWith(':'))return [value];
  const name=value.slice(1),matches=modules.filter(row=>row.properties.name===name);
  if(seen.has(name)||matches.length!==1)throw Error('Invalid original AIDL source group: '+name);
  return patterns(matches[0].properties.srcs,new Set([...seen,name]));
 });
 const selected=targets.map(name=>{
  const matches=modules.filter(row=>row.properties.name===name);
  if(matches.length!==1||matches[0].type!=='aidl_interface'||matches[0].properties.backend?.cpp?.enabled===false)throw Error('Missing original C++ AIDL target: '+name);
  return matches[0];
 });
 return [...new Set(selected.flatMap(row=>patterns(row.properties.srcs).flatMap(pattern=>fs.globSync(pattern,{cwd:directory}))))].filter(file=>file.endsWith('.aidl'));
}

/** Reconstruct the original ART guest's coherent AIDL/HIDL input groups. */
export async function prepareArtGuestInputs({common,hwui,image,ndk,work}){
 if(!common?.sources||!hwui?.sources||!hwui?.tools||!path.isAbsolute(image?.root||'')||!path.isAbsolute(ndk||'')||!path.isAbsolute(work||'')||fs.existsSync(work))throw Error('ART guest inputs require completed common/HWUI inputs, original image, NDK and a new absolute work directory.');
 const android=path.join(root,profile.androidSource.directory);
 if(read('git',['-C',android,'rev-parse','HEAD'])!==profile.androidSource.revision)throw Error('The ART source profile differs from its selected revision.');
 const sourceRoot=path.join(work,'source');fs.mkdirSync(sourceRoot,{recursive:true});
 for(const[relative,key]of Object.entries(profile.sourceLinks)){
  const source=common.sources[key]||common.inputs?.[key];if(!path.isAbsolute(source||''))throw Error('The common producer must supply '+key+'.');
  alias(path.join(sourceRoot,relative),source);
 }
 for(const[relative,key]of Object.entries(profile.hwuiLinks))alias(path.join(sourceRoot,relative),hwui.sources[key]);
 for(const record of profile.extraSources){
  const source=checkoutSource({...record,destination:path.join(work,'upstream',record.directory.replaceAll('/','-'))});alias(path.join(sourceRoot,record.directory),source);
 }
 for(const record of profile.stockSources){
  const source=await acquireArtSourceSelection(record,path.join(work,'tools',record.directory.replaceAll('/','-')));alias(path.join(sourceRoot,record.directory),source);
 }
 const generated=path.join(sourceRoot,'generated'),headers=path.join(generated,'include'),cpp=path.join(generated,'src');fs.mkdirSync(headers,{recursive:true});fs.mkdirSync(cpp);
 const roots=profile.cppAidlRoots.map(relative=>path.join(sourceRoot,relative)),frozen=profile.frozenCpp.map(record=>({...record,root:path.join(sourceRoot,record.directory)}));
 const imports=[...roots,...profile.cppAidlImportRoots.map(relative=>path.join(sourceRoot,relative)),path.join(sourceRoot,'frameworks/base/core/java'),...frozen.map(record=>record.root)].map(directory=>'-I'+directory);
 for(const directory of roots){
  if(!fs.existsSync(directory))throw Error('Original ART AIDL source group is missing: '+path.relative(sourceRoot,directory));
  for(const relative of await cppAidlSources({directory,android,parser:common.tools.blueprintParser,targets:profile.cppAidlModules[path.relative(sourceRoot,directory)]}))run(common.tools.aidl,['--lang=cpp',...imports,'-h',headers,'-o',cpp,path.join(directory,relative)]);
 }
 for(const record of frozen){
  const hash=fs.readFileSync(path.join(record.root,'.hash'),'utf8').trim().split('\n').at(-1);
  for(const relative of fs.globSync('**/*.aidl',{cwd:record.root}))run(common.tools.aidl,['--lang=cpp','--structured','--stability=vintf','--version='+record.version,'--hash='+hash,...imports,'-h',headers,'-o',cpp,path.join(record.root,relative)]);
 }
 for(const name of profile.hidlPackages)run(hwui.tools.hidlGen,['-Lc++-headers','-o',headers,'-R','-randroid.hardware:'+path.join(sourceRoot,'hardware/interfaces'),'-randroid.hidl:'+path.join(sourceRoot,'system/libhidl/transport'),name]);
 // The original release aconfig output is shared with HWUI instead of rebuilt.
 const guiFlags=path.join(hwui.work,'module/gen/aconfig/gui/include');
 const includeDirectories=[...new Set([...profile.includeDirectories.map(relative=>path.join(sourceRoot,relative)),guiFlags,
  path.join(hwui.work,'module/gen/include')])];
 const bin=path.join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin');
 return {nativeSource:common.sources['native-source']||common.inputs['native-source'],sourceRoot,
  compiler:path.join(sourceRoot,profile.compiler),linkCompiler:path.join(bin,'aarch64-linux-android35-clang++'),cCompiler:path.join(bin,'aarch64-linux-android35-clang'),strip:path.join(bin,'llvm-strip'),
  ninja:common.tools.ninja,python:common.tools.python,blueprintParser:common.tools.blueprintParser,aidl:common.tools.aidl,
  binderFlags:profile.binderFlags,includeDirectories,generatedSources:Object.fromEntries(Object.entries(profile.generatedSources).map(([name,files])=>[name,files.map(file=>path.join(sourceRoot,file))])),image:image.root};
}
