import fs from 'node:fs';
import path from 'node:path';
import {checkoutSource,stageSource,sourceNotices,run,recipeMain} from './build-source.mjs';
import {rustEnvironment,rustNotices} from './rust-build.mjs';
import {sealRuntime} from './seal-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const descriptor=JSON.parse(fs.readFileSync(new URL('../producers/android-art-inputs/source.json',import.meta.url)));

/** Build the original image reader independently of the Android system image. */
export async function buildArtInput({project,arch,version,output,work}){
 fs.mkdirSync(work,{recursive:true});
 const checkout=checkoutSource({repository:descriptor.repository,revision:descriptor.revision,destination:path.join(work,'upstream')});
 const source=path.join(work,'source'),staged=await stageSource(checkout,descriptor.revision,source);
 const crate=path.join(work,'crate');fs.mkdirSync(crate);
 fs.cpSync(path.join(source,descriptor.crate,'src'),path.join(crate,'src'),{recursive:true});
 const original=fs.readFileSync(path.join(source,descriptor.crate,'Cargo.toml'),'utf8');
 const manifest=original.replace('license.workspace = true','license = "Apache-2.0"').replace('sha2.workspace = true','sha2 = "0.10"');
 if(manifest===original||manifest.includes('.workspace'))throw Error('The original image reader workspace declarations changed.');
 fs.writeFileSync(path.join(crate,'Cargo.toml'),manifest);
 fs.copyFileSync(path.join(source,'Cargo.lock'),path.join(crate,'Cargo.lock'));
 // Resolve the isolated original crate from the upstream lock, then ensure that
 // every fetched package retains the exact version and checksum in that lock.
 const env=rustEnvironment({work,minimumMacOS:descriptor.minimumMacOS,env:{...process.env,CARGO_HOME:path.join(work,'cargo')}});
 run('cargo',['fetch','--manifest-path',path.join(crate,'Cargo.toml')],{env});
 const packages=text=>text.split(/^\[\[package\]\]\s*$/m).slice(1).map(block=>Object.fromEntries([...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"$/gm)].map(match=>[match[1],match[2]])));
 const upstream=packages(fs.readFileSync(path.join(source,'Cargo.lock'),'utf8'));
 for(const pkg of packages(fs.readFileSync(path.join(crate,'Cargo.lock'),'utf8')).filter(pkg=>pkg.source)){
  if(!upstream.some(row=>['name','version','source','checksum'].every(key=>row[key]===pkg[key])))throw Error('The image reader resolved a dependency outside the original lock: '+pkg.name);
 }
 run('cargo',['build','--offline','--locked','--release','--manifest-path',path.join(crate,'Cargo.toml'),'--jobs','2'],{env});
 const notices=[...sourceNotices(checkout,{name:'AIM',repository:descriptor.repository}),...rustNotices({source:crate,target:'aarch64-apple-darwin',output:path.join(work,'notices'),env})];
 return sealRuntime({project,version,arch,output,sourceRoot:checkout,upstreamRevision:descriptor.revision,executable:path.join(env.CARGO_TARGET_DIR,'release/android-image-extract'),maximumMacOS:descriptor.minimumMacOS,notices,
  provenance:{sourceTreeSha256:staged.treeSha256,gitDependencies:staged.dependencies,component:'android-image-extract',rustLockSha256:(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(crate,'Cargo.lock'))).digest('hex')}});
}
recipeMain(import.meta,buildArtInput);
