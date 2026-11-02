import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {MOLTENVK} from '../producers/maclauncher/src/modules/shared/reshade/libplacebo-build.mjs';
import {buildInput} from './build-input.mjs';
import {helperPackage} from './helper-package.mjs';
import {recipeMain} from './build-source.mjs';
/** Preserve the selected original MoltenVK library and build headers without re-signing. */
export async function buildGraphicsMoltenVK({project,version,output,work}){
 fs.mkdirSync(work,{recursive:true});const archive=await buildInput(MOLTENVK.archive,path.join(work,'archives')),source=path.join(work,'source');fs.mkdirSync(source);
 execFileSync('/usr/bin/tar',['-xf',archive,'-C',source],{stdio:'inherit'});
 const payload=path.join(output,'payload'),library='MoltenVK/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib';
 if(crypto.createHash('sha256').update(fs.readFileSync(path.join(source,library))).digest('hex')!==MOLTENVK.sha256)throw Error('The selected original MoltenVK library changed.');
 fs.mkdirSync(payload,{recursive:true});
 for(const relative of [library,'MoltenVK/MoltenVK/include','MoltenVK/LICENSE']){const target=path.join(payload,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(source,relative),target,{recursive:true,dereference:true});}
 fs.chmodSync(path.join(payload,library),0o755);
 return helperPackage({id:project,version,arch:'universal',output,minimumMacOS:'13.0',sourceSha256:MOLTENVK.archive.sha256,manifestRelative:'moltenvk.json',record:{kind:'original-MoltenVK',upstream:MOLTENVK},notices:[{name:'MoltenVK',license:MOLTENVK.license,path:'MoltenVK/LICENSE',sourceUrl:MOLTENVK.source}]});
}
recipeMain(import.meta,buildGraphicsMoltenVK);
