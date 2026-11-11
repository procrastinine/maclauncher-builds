import {appPath,appRequire,appSourceRoot} from '../../../../../../../tools/app-source.mjs';
import vulkanHeaders from '../../../../../../dependencies/vulkanHeaders.json' with {type:'json'};
import {sourceRevision} from '../../../../../../../lib/pins.mjs';
import {upstreamRevision} from '../../../../../../../lib/projects.mjs';
import {addLicenses} from '../../../../../../../lib/licenses.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,app=appPath('src/modules/crossover/temporal/fidelityfx'),source=JSON.parse(fs.readFileSync(path.join(here,'source.json')));
const args=Object.fromEntries(process.argv.slice(2).reduce((rows,value,index,all)=>index%2?rows:[...rows,[value.replace(/^--/,''),all[index+1]]],[]));
if(!['sdk-source','vulkan-source','carrier-headers','compiler','out'].every(key=>args[key]))throw Error('Use --sdk-source SDK --vulkan-source VULKAN_HEADERS --carrier-headers VKD3D_PROTON_PRODUCER --compiler MINGW_CLANG++ --out DIRECTORY');
const sdk=fs.realpathSync(args['sdk-source']),vulkan=fs.realpathSync(args['vulkan-source']),carrier=fs.realpathSync(args['carrier-headers']),out=path.resolve(args.out),compiler=path.resolve(args.compiler);
fs.accessSync(compiler,fs.constants.X_OK);
for(const header of ['vk_temporal_frame.h','vkd3d_metalfx.h'])fs.accessSync(path.join(carrier,header),fs.constants.R_OK);
const git=(directory,...parameters)=>execFileSync('git',['-C',directory,...parameters],{env:{...process.env,GIT_NO_LAZY_FETCH:'1'},maxBuffer: Infinity});
const vulkanRevision=sourceRevision(vulkanHeaders),sdkRevision=upstreamRevision('fidelityfx-api','fidelityfx-sdk');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(out,{recursive:true});const inputs=path.join(out,'inputs');fs.mkdirSync(inputs,{recursive:true});
const originalInputs={};
for(const relative of source.sdk.headers){const target=path.join(inputs,relative.slice('ffx-api/include/'.length));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,git(sdk,'show',sdkRevision+':'+relative));originalInputs[relative]=hash(target);}
// The pinned Vulkan-Headers include tree, as vulkan/ and vk_video/ beside the SDK headers.
for(const file of git(vulkan,'ls-tree','-r','--name-only',vulkanRevision,source.vulkan.directory+'/').toString().split('\n').filter(name=>/\.h$/.test(name))){
 const relative=path.posix.relative(source.vulkan.directory,file),target=path.join(inputs,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(target,git(vulkan,'show',vulkanRevision+':'+file));originalInputs[relative]=hash(target);
}
for(const header of ['vk_temporal_frame.h','vkd3d_metalfx.h'])originalInputs['vkd3d-proton/'+header]=hash(path.join(carrier,header));
if(!source.version.startsWith(source.sdk.apiVersion+'-'))throw Error('The package version does not name its FidelityFX API version.');
const hooks=fs.readFileSync(path.join(inputs,'ffx_api/ffx_api.h'),'utf8'),expected=new Set(source.exports);
for(const name of expected)if(!new RegExp('FFX_API_ENTRY\\s+ffxReturnCode_t\\s+'+name+'\\s*\\(').test(hooks))throw Error('The pinned FidelityFX export declaration changed.');
const repository=appSourceRoot().directory,PE=appRequire('src/modules/crossover/temporal/streamline/pe-exports.js'),backends={};
// One proxy per backend. The pinned SDK's signed library supplies its export
// table and ordinals; at run time the proxy loads the game's own library.
for(const backend of Object.keys(source.libraries)){
 const directory=path.join(out,backend),declared=source.sdk.referenceLibraries[backend],reference=path.join(directory,'reference.dll');fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(reference,git(sdk,'show',sdkRevision+':'+declared.path));
 if(hash(reference)!==declared.sha256)throw Error('The pinned SDK '+backend+' library differs from its declared digest.');
 const exports=PE.inspect(reference);
 if(!Array.isArray(exports)||exports.length!==expected.size||exports.some(row=>!expected.has(row.name)))throw Error('The pinned SDK '+backend+' library does not have the five FidelityFX API exports.');
 const referenceVersion=appRequire('src/modules/shared/runtime/pe-version.js').readPeVersion(reference)?.fileVersion||null;
 fs.writeFileSync(path.join(directory,'profile.hpp'),'#pragma once\n#define MACLAUNCHER_FFX_BACKEND_VK '+(backend==='vk'?1:0)+'\nconstexpr const wchar_t*maclauncherOriginalLibrary=L'+JSON.stringify(source.original[backend])+';\n');
 fs.writeFileSync(path.join(directory,'exports.def'),'LIBRARY '+source.libraries[backend].replace(/\.dll$/,'')+'\nEXPORTS\n'+exports.map(row=>row.name+' @'+row.ordinal).join('\n')+'\n');
 const library=path.join(out,source.libraries[backend]);
 execFileSync(compiler,['-std=c++17','-O2','-shared','-static','-Wl,--exclude-all-symbols','-Wl,--no-insert-timestamp',
  '-ffile-prefix-map='+repository+'=MacLauncher','-ffile-prefix-map='+out+'=FidelityFXBuild','-ffile-prefix-map='+carrier+'=VKD3D-Proton',
  '-I'+inputs,'-I'+directory,'-I'+carrier,path.join(app,'proxy.cpp'),path.join(directory,'exports.def'),'-o',library],{stdio:'inherit'});
 const actual=PE.inspect(library),ordinals=new Map(exports.map(row=>[row.name,row.ordinal]));
 if(actual?.length!==exports.length||actual.some(row=>ordinals.get(row.name)!==row.ordinal))throw Error('The compiled FidelityFX '+backend+' exports changed.');
 backends[backend]={library:source.libraries[backend],sha256:hash(library),exports:actual,originalLibrary:source.original[backend],
  reference:{repository:source.sdk.repository,revision:sdkRevision,path:declared.path,sha256:declared.sha256,fileVersion:referenceVersion}};
}
// The headers also retain their original copyright notices in inputs/.
const runtimeBackends=Object.fromEntries(Object.entries(backends).map(([backend,row])=>[backend,{library:row.library,sha256:row.sha256,exports:row.exports,originalLibrary:row.originalLibrary}]));
const provider={schema:2,version:source.version,profile:source.profile,temporalFrames:1,backends:runtimeBackends};
const metadata={...provider,backends,sources:source,originalInputs};
fs.writeFileSync(path.join(out,'provider.json'),JSON.stringify(metadata,null,2)+'\n');
// The runtime package holds the proxies and notices; compiler inputs and the
// reference libraries stay in the producer output.
const files=Object.values(backends).map(row=>{const target=path.join(out,row.library);fs.chmodSync(target,0o755);return{
 path:row.library,size:fs.statSync(target).size,mode:0o755,sha256:hash(target),format:'pe',architectures:['x86_64']};});
const manifest={schemaVersion:1,managerId:source.id,version:source.version,platform:'darwin',arch:'x64',minimumMacOS:source.minimumMacOS,
 executableRelative:source.libraries.vk,provider,files,dependencies:[]};
const payload=path.join(out,'payload');fs.mkdirSync(payload,{recursive:true});
addLicenses(payload,'FidelityFX-SDK',sdk);
addLicenses(payload,'Vulkan-Headers',vulkan);
// The carrier headers are VKD3D-Proton producer files under its LGPL-2.1.
addLicenses(payload,'VKD3D-Proton',path.join(carrier,'source'));
for(const file of files){const target=path.join(payload,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(out,file.path),target);fs.chmodSync(target,file.mode);}
// The game-library adapter reads this descriptor from its installed payload.
const providerFile=path.join(payload,'provider.json');fs.writeFileSync(providerFile,JSON.stringify(provider,null,2)+'\n');fs.chmodSync(providerFile,0o644);
for(const relative of fs.readdirSync(payload,{recursive:true}).filter(name=>name!=='manifest.json'&&fs.statSync(path.join(payload,name)).isFile()))if(!files.some(file=>file.path===relative)){const file=path.join(payload,relative);files.push({path:relative,size:fs.statSync(file).size,mode:fs.statSync(file).mode&0o777,sha256:hash(file)});}
const manifestFile=path.join(payload,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');fs.chmodSync(manifestFile,0o644);
const declaration={id:source.id,version:source.version,arch:'x64',launcherArchitectures:['arm64','x64'],minimumMacOS:source.minimumMacOS,
 sourceRelative:null,sourceSha256:hash(path.join(here,'source.json')),directoryRelative:[source.id,source.version,'x64'].join('/'),
 manifestRelative:'manifest.json',manifestSha256:hash(manifestFile),files:[...files,{path:'manifest.json',size:fs.statSync(manifestFile).size,mode:0o644,sha256:hash(manifestFile)}]};
fs.writeFileSync(path.join(out,'runtime-package.json'),JSON.stringify(declaration,null,2)+'\n');
console.log(JSON.stringify({version:source.version,backends:Object.fromEntries(Object.entries(backends).map(([backend,row])=>[backend,row.sha256]))}));
