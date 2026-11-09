import './producer-environment.mjs';
import {addLicenses} from '../lib/licenses.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {declaredSource,stageSource,run,recipeMain} from "./build-source.mjs";
import {rustEnvironment} from "./rust-build.mjs";
import {sealRuntime} from './seal-runtime.mjs';

const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const overlays=path.join(root,'producers/package-support/src/modules/gamemaker/overlays/opengmk-macos');
const Emulator=require(path.join(overlays,'apply-emulator.js')),Ramen=require(path.join(overlays,'apply-ramen.js')),Audio=require(path.join(overlays,'apply-audio.js'));
/** Compile the OpenGMK emulator with its ramen and libsoundio overlays. */
export async function compile({arch,work}){
 fs.mkdirSync(work,{recursive:true});
 const pins=require(path.join(overlays,'sources.json'));
 const inputs=[['OpenGMK','https://github.com/OpenGMK/OpenGMK',Emulator.REVISION,declaredSource('opengmk','opengmk')],['ramen','https://github.com/viriuwu/ramen',Ramen.REVISION,declaredSource(pins.ramen)],['udon','https://github.com/Adamcake/udon',Audio.REVISION,declaredSource(pins.udon)]];
 const sources=inputs.map(([name,repository,revision,source])=>({name,repository,revision,source}));
 const source=path.join(work,'source'),ramen=path.join(work,'ramen'),audio=path.join(work,'audio'),udon=path.join(work,'udon');
 await stageSource(sources[0].source,Emulator.REVISION,source);
 Ramen.applyRamenOverlay({sourceDir:sources[1].source,destination:ramen});Audio.applyAudioOverlay({sourceDir:path.join(sources[2].source,'libsoundio-sys'),destination:audio});
 Emulator.applyEmulatorOverlay({sourceDir:source,ramenDir:ramen,soundioDir:audio});
 await stageSource(sources[2].source,Audio.REVISION,udon);
 const manifest=path.join(udon,'Cargo.toml'),text=fs.readFileSync(manifest,'utf8'),before='libsoundio-sys = { path = "./libsoundio-sys" }';
 if(text.split(before).length!==2)throw Error('Pinned udon manifest changed.');
 fs.writeFileSync(manifest,text.replace(before,'libsoundio-sys = { path = '+JSON.stringify(audio)+' }'));fs.appendFileSync(path.join(source,'Cargo.toml'),'udon = { path = '+JSON.stringify(udon)+' }\n');
 fs.copyFileSync(path.join(root,'producers/package-support/helper-builds/opengmk.lock'),path.join(source,'Cargo.lock'));
 const target=arch==='x64'?'x86_64-apple-darwin':'aarch64-apple-darwin',env=rustEnvironment({work,minimumMacOS:'13.0'});
 run('cargo',['build','--release','--locked','--target',target,'--package','gm8emulator'],{cwd:source,env});
 const executable=path.join(work,'target',target,'release/gm8emulator');run(executable,['--version']);
 return {source,sources,env,executable};
}
/** Add the overlay notices and seal the compiled emulator. */
export async function assemble({project,arch,output,compiled:{source,sources,env,executable}}){
 addLicenses(source,'ramen',sources[1].source);addLicenses(source,'libsoundio',path.join(sources[2].source,'libsoundio-sys/libsoundio'));

 return sealRuntime({cargoRoot:source,env,project,arch,output,executable,sourceRoot:sources[0].source,upstreamRevision:Emulator.REVISION,provenance:{dependencies:sources.slice(1).map(({name,repository,revision})=>({name,repository,revision})),overlay:Emulator.OVERLAY_VERSION}});
}
recipeMain(import.meta,{compile,assemble});
