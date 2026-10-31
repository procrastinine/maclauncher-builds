import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildInput} from './build-input.mjs';
import {buildOptions,checkoutSource} from './build-source.mjs';
import {resolveProject,buildRecord} from '../lib/projects.mjs';
import {publicDeclaration} from './runtime-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'producers/maclauncher');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file));
const run=(command,args)=>execFileSync(command,args,{stdio:'inherit'});
const native=path.join(base,'src/modules/shared/vulkan/native');
async function mingw(work){
 const pin=read(path.join(base,'src/modules/crossover/temporal/xess/source.json')).toolchain;
 const archive=await buildInput({url:pin.repository+'/releases/download/'+pin.version+'/'+pin.asset,sha256:pin.sha256},path.join(work,'downloads'));
 const directory=path.join(work,'toolchain');fs.mkdirSync(directory);run('/usr/bin/tar',['-xf',archive,'-C',directory]);
 return path.join(directory,'llvm-mingw-'+pin.version+'-ucrt-macos-universal/bin');
}
function finish({directory,declaration,output}){
 publicDeclaration(declaration);fs.mkdirSync(output,{recursive:true});
 fs.cpSync(directory,path.join(output,'payload'),{recursive:true});
 fs.writeFileSync(path.join(output,'declaration.json'),JSON.stringify(declaration,null,2)+'\n',{flag:'wx'});
 return {project:declaration.id,version:declaration.version,arch:declaration.arch,output};
}
export async function buildSceneRuntime({project:id,arch,output,work}){
 const record=buildRecord(resolveProject(id,root,{resolvePins:false}));
 if(!['winevulkan-scene','fidelityfx-api','vulkan-moltenvk-scene'].includes(id)||!record.architectures.includes(arch)||
  !path.isAbsolute(work||'')||fs.existsSync(work)||!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Select a scene adapter, its declared CPU and new absolute output/work directories.');
 fs.mkdirSync(work,{recursive:true});
 if(id==='winevulkan-scene'){
  const producer=path.join(base,'src/modules/crossover/temporal/vulkan'),source=read(path.join(producer,'source.json'));
  const [archive,bisonArchive,moltenvkArchive,compiler]=await Promise.all([
   buildInput(source.archive,path.join(work,'downloads')),buildInput(source.buildTools.bison,path.join(work,'downloads')),
   buildInput(source.vulkanLinkInput.archive,path.join(work,'downloads')),mingw(work)]);
  const module=await import(pathToFileURL(path.join(producer,'build.mjs'))),staged=path.join(work,'staged');
  await module.buildModule({archive,bisonArchive,moltenvkArchive,mingw:compiler,work:path.join(work,'wine'),output:staged,jobs:2});
  return finish({directory:path.join(staged,'payload'),declaration:read(path.join(staged,'runtime-package.json')),output});
 }
 if(id==='fidelityfx-api'){
  const producer=path.join(base,'src/modules/crossover/temporal/fidelityfx'),source=read(path.join(producer,'source.json'));
  const sdk=checkoutSource({...source.sdk,destination:path.join(work,'sdk')}),vulkan=checkoutSource({...source.vulkan,destination:path.join(work,'vulkan')});
  const compiler=await mingw(work),staged=path.join(work,'staged');
  run(process.execPath,[path.join(producer,'build.mjs'),'--sdk-source',sdk,'--vulkan-source',vulkan,'--compiler',path.join(compiler,'x86_64-w64-mingw32-clang++'),'--out',staged]);
  return finish({directory:path.join(staged,'payload'),declaration:read(path.join(staged,'runtime-package.json')),output});
 }
 const source=read(path.join(native,'moltenvk-scene-source.json'));
 const repository=checkoutSource({...source,destination:path.join(work,'moltenvk')}),dependencies={};
 for(const dependency of source.dependencies)dependencies[dependency.id]=checkoutSource({...dependency,destination:path.join(work,dependency.id)});
 const producer=await import(pathToFileURL(path.join(native,'moltenvk-scene-build.mjs'))),prepared=path.join(work,'provider-build');
 const projected=producer.prepareSceneSource({repository,work:prepared}),cpus=arch==='universal'?['arm64','x86_64']:[arch==='x64'?'x86_64':arch],providers=[];
 for(const architecture of cpus){const built=producer.buildSceneProvider({projected,work:prepared,dependencies,architecture,jobs:2}),directory=path.join(work,'raw-'+architecture);producer.publishSceneProvider({...built,projected,output:directory,architecture});providers.push(directory);}
 const directory=path.join(work,'package'),manifest=producer.publishScenePackage({providerDirectory:providers[0],peerDirectory:providers[1],output:directory});
 const manifestFile=path.join(directory,'manifest.json'),files=[...manifest.files,{path:'manifest.json',size:fs.statSync(manifestFile).size,mode:0o644,sha256:hash(manifestFile)}];
 const declaration={id,version:record.version,arch,launcherArchitectures:arch==='arm64'?['arm64']:['arm64','x64'],minimumMacOS:manifest.minimumMacOS,
  sourceRelative:null,sourceSha256:hash(path.join(native,'moltenvk-scene-source.json')),directoryRelative:[id,record.version,arch].join('/'),manifestRelative:'manifest.json',manifestSha256:hash(manifestFile),files,notices:manifest.notices};
 return finish({directory,declaration,output});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)buildSceneRuntime(buildOptions(process.argv.slice(2))).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
