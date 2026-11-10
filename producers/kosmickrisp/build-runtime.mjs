import {placeDeclaredSource} from '../../tools/build-source.mjs';
import vulkanHeaders from '../dependencies/vulkanHeaders.json' with {type:'json'};
import {sourceCheckout,sourceRevision} from '../../lib/pins.mjs';
import {upstreamRevision} from '../../lib/projects.mjs';
import {addLicenses} from '../../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sealRuntime} from '../../tools/seal-runtime.mjs';
import {buildZstd} from '../../tools/build-zstd.mjs';
import {buildSpirvTools} from '../../tools/build-spirv-tools.mjs';
import {pythonBuildTools,recipeMain} from '../../tools/build-source.mjs';
const root=path.resolve(import.meta.dirname,'../..');
// The pinned maclauncher-kosmickrisp repository holds the adaptations and the build recipe over its Mesa pin.
const adaptation=path.join(root,'sources/maclauncher-kosmickrisp');
const run=(command,args,options={})=>String(execFileSync(command,args,{encoding:'utf8',maxBuffer:Infinity,...options})||'').trim();
const prefix=name=>run('brew',['--prefix',name]);
/** Compile the KosmicKrisp driver over its Mesa pin, its host tools and the Vulkan loader. */
export async function compile({project:id,arch,work}){
 fs.mkdirSync(work,{recursive:true});
 const {buildKosmic}=await import(pathToFileURL(path.join(adaptation,'kosmickrisp-build.mjs')));
 const {buildKosmicLoader}=await import(pathToFileURL(path.join(adaptation,'kosmickrisp-targets.mjs')));
 const requirements=path.join(root,'tools/sdk27-build-requirements.txt');
 const tools=pythonBuildTools(work,requirements),meson=path.join(tools.bin,'meson'),ninja=path.join(tools.bin,'ninja');
 const pin=JSON.parse(fs.readFileSync(path.join(adaptation,'kosmickrisp-source.json'))),inputs=JSON.parse(fs.readFileSync(path.join(adaptation,'kosmickrisp-targets.json'))),source=path.join(adaptation,sourceCheckout(pin));
 const pythonVersions=Object.fromEntries(fs.readFileSync(requirements,'utf8').split(/\r?\n/).filter(line=>line.includes('==')).map(line=>line.split('==')));
 const llvm=prefix('llvm'),observedInputs={...inputs,tools:{...pythonVersions,llvm:run(path.join(llvm,'bin/llvm-config'),['--version']),spirvLLVMTranslator:run('pkg-config',['--modversion','LLVMSPIRVLib'])}};
 // Mesa's system shader compilers execute on the Apple Silicon build host.
 // Cross-built x64 drivers consume their output without target LLVM libraries.
 const spirv=await buildSpirvTools({work:path.join(work,'spirv-tools'),ninja,python:tools.python,architecture:'arm64',jobs:6});
 const zstd=await buildZstd({work:path.join(work,'zstd'),architecture:'arm64',jobs:6,ninja});
 const targetSpirv=arch==='arm64'?spirv:await buildSpirvTools({work:path.join(work,'target-spirv-tools'),ninja,python:tools.python,architecture:arch,jobs:6});
 const targetZstd=arch==='arm64'?zstd:await buildZstd({work:path.join(work,'target-zstd'),architecture:arch,jobs:6,ninja});
 const built=buildKosmic({source,work:path.join(work,'mesa'),meson,ninja,llvm,architecture:arch,jobs:6,
  pkgConfigPath:[zstd.pkgConfigPath,spirv.pkgConfigPath,process.env.PKG_CONFIG_PATH].filter(Boolean).join(path.delimiter),
  targetPkgConfigPath:[targetZstd.pkgConfigPath,targetSpirv.pkgConfigPath].join(path.delimiter)});
 const loader=buildKosmicLoader({source:path.join(root,'sources/vulkan-loader'),loaderRevision:upstreamRevision(id,'vulkan-loader'),headersRevision:sourceRevision(vulkanHeaders),headersSource:placeDeclaredSource(vulkanHeaders,path.join(work,'vulkan-headers')),work:path.join(work,'loader'),jobs:6});
 return {built,source,pin,loader,observedInputs,targetSpirv,targetZstd};
}
/** Add the Mesa notices and seal the compiled driver with its loader. */
export async function assemble({project:id,arch,output,compiled:{built,source,pin,loader,observedInputs,targetSpirv,targetZstd}}){
 // Mesa's own licence folder joins the driver's licence texts.
 addLicenses(path.dirname(path.dirname(built.library)),'Mesa',source);
 return sealRuntime({project:id,arch,output,sourceRoot:adaptation,upstreamRevision:upstreamRevision(id,'maclauncher-kosmickrisp'),executable:built.library,executableRelative:pin.library,payloads:[{source:loader.loader,relative:'libvulkan.1.dylib'}],runtimeFiles:{loader:'libvulkan.1.dylib'},provenance:{targetInputs:observedInputs,spirvToolsSource:targetSpirv.provenance,zstdSource:targetZstd.provenance,capabilities:{openglES:'3.2',geometry:'Mesa Poly',transformFeedback:'Mesa Poly'}}});
}
recipeMain(import.meta,{compile,assemble});
