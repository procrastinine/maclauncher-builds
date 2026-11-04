import {artAimSource} from '../lib/android-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {checkoutSource,stageSource,run,recipeMain} from "./build-source.mjs";
import {rustEnvironment} from "./rust-build.mjs";
import {sealRuntime} from './seal-runtime.mjs';
const descriptor={...JSON.parse(fs.readFileSync(new URL('../producers/android-art-inputs/source.json',import.meta.url))),...artAimSource()};

/** Build the original image reader independently of the Android system image. */
export async function buildArtInput({project,arch,version,output,work}){
 fs.mkdirSync(work,{recursive:true});
 const checkout=checkoutSource({repository:descriptor.repository,revision:descriptor.revision,destination:path.join(work,'upstream')});
 const source=path.join(work,'source'),staged=await stageSource(checkout,descriptor.revision,source);
 const crate=path.join(source,descriptor.crate);
 const env=rustEnvironment({work,minimumMacOS:descriptor.minimumMacOS,env:process.env});
 run('cargo',['fetch','--locked','--manifest-path',path.join(crate,'Cargo.toml')],{env});
 run('cargo',['build','--offline','--locked','--release','--config','profile.release.incremental=false','--manifest-path',path.join(crate,'Cargo.toml'),'--jobs','2'],{env});
 return sealRuntime({cargoRoot:crate,env,project,version,arch,output,sourceRoot:checkout,upstreamRevision:descriptor.revision,executable:path.join(env.CARGO_TARGET_DIR,'release/android-image-extract'),provenance:{sourceTreeSha256:staged.treeSha256,gitDependencies:staged.dependencies,component:'android-image-extract',rustLockSha256:(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(source,'Cargo.lock'))).digest('hex')}});
}
recipeMain(import.meta,buildArtInput);
