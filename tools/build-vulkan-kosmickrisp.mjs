import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sealRuntime} from './seal-runtime.mjs';
import {buildZstd} from './build-zstd.mjs';
import {buildSpirvTools} from './build-spirv-tools.mjs';
import {pythonBuildTools,recipeMain} from './build-source.mjs';
import {buildKosmic} from '../producers/maclauncher/src/modules/shared/vulkan/native/kosmickrisp-build.mjs';
import {buildKosmicLoader} from '../producers/maclauncher/src/modules/shared/vulkan/native/kosmickrisp-targets.mjs';
const root=path.resolve(import.meta.dirname,'..');
const run=(command,args,options={})=>String(execFileSync(command,args,{encoding:'utf8',maxBuffer:64<<20,...options})||'').trim();
const prefix=name=>run('brew',['--prefix',name]);
export async function buildKosmicKrisp({project:id,arch,output,work}){
 fs.mkdirSync(work,{recursive:true});
 const tools=pythonBuildTools(work,path.join(root,'tools/sdk27-build-requirements.txt')),meson=path.join(tools.bin,'meson'),ninja=path.join(tools.bin,'ninja');
 const native=path.join(root,'producers/maclauncher/src/modules/shared/vulkan/native'),pin=JSON.parse(fs.readFileSync(path.join(native,'kosmickrisp-source.json'))),inputs=JSON.parse(fs.readFileSync(path.join(native,'kosmickrisp-targets.json'))),source=path.join(root,inputs.sourcePath);
 const llvm=prefix('llvm'),observedInputs={...inputs,tools:{...inputs.tools,llvm:run(path.join(llvm,'bin/llvm-config'),['--version']),spirvLLVMTranslator:run('pkg-config',['--modversion','LLVMSPIRVLib'])}};
 const spirv=await buildSpirvTools({work:path.join(work,'spirv-tools'),ninja,python:tools.python,architecture:arch,jobs:2});
 const zstd=await buildZstd({work:path.join(work,'zstd'),architecture:arch,jobs:2,ninja});
 const built=buildKosmic({source,work:path.join(work,'mesa'),meson,ninja,llvm,architecture:arch,jobs:2,pkgConfigPath:[zstd.pkgConfigPath,spirv.pkgConfigPath,process.env.PKG_CONFIG_PATH].filter(Boolean).join(path.delimiter)});
 const loader=buildKosmicLoader({source:path.join(root,inputs.vulkanLoader.path),headersSource:path.join(root,inputs.vulkanHeaders.path),work:path.join(work,'loader'),architecture:arch,jobs:2});
 const notices=[...spirv.notices,...zstd.notices,{file:path.join(source,'docs/license.rst'),name:'Mesa',license:'MIT and upstream notices',sourceUrl:pin.repository},{file:loader.loaderNotice,name:'Vulkan-Loader',license:'Apache-2.0',sourceUrl:inputs.vulkanLoader.repository}];
 for(const name of fs.readdirSync(path.join(source,'licenses')))if(fs.statSync(path.join(source,'licenses',name)).isFile())notices.push({file:path.join(source,'licenses',name),name:'Mesa '+name,license:name,sourceUrl:pin.repository});
 return sealRuntime({project:id,arch,output,sourceRoot:source,upstreamRevision:pin.revision,executable:built.library,executableRelative:pin.library,maximumMacOS:'26.0',notices,
  payloads:[{source:loader.loader,relative:'libvulkan.1.dylib'}],runtimeFiles:{loader:'libvulkan.1.dylib'},provenance:{targetInputs:observedInputs,spirvToolsSource:spirv.provenance,zstdSource:zstd.provenance,capabilities:{openglES:'3.2',geometry:'Mesa Poly',transformFeedback:'Mesa Poly'}}});
}
recipeMain(import.meta,buildKosmicKrisp);
