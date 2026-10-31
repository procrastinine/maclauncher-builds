import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {sha} from './helper-package.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs'),{validateDeclaration}=require('../lib/declaration.cjs');
const descriptor=new URL('../producers/android-art-inputs/ffi.json',import.meta.url);

/** Read the sealed Linux-built Android libffi input through its ordinary inventory. */
export function readArtFfiInput(input){
 if(!path.isAbsolute(input||''))throw Error('The ART supplier requires a sealed Linux libffi input directory.');
 const profile=JSON.parse(fs.readFileSync(descriptor)),declaration=JSON.parse(fs.readFileSync(path.join(input,'declaration.json'))),payload=path.join(input,'payload');
 validateDeclaration(declaration);
 if(declaration.id!==profile.id||declaration.version!==profile.version||declaration.arch!=='arm64'||declaration.manifestRelative!=='input.json'||declaration.sourceSha256!==sha(descriptor))throw Error('The sealed libffi input differs from its declared profile.');
 B.verifyPayload(payload,declaration);
 const manifest=JSON.parse(B.readRegular(path.join(payload,'input.json'),B.LIMITS.manifestBytes).bytes);
 if(manifest.id!==declaration.id||manifest.version!==declaration.version||manifest.arch!==declaration.arch||manifest.sourceSha256!==declaration.sourceSha256||manifest.androidSource?.repository!==profile.androidSource.repository||manifest.androidSource?.revision!==profile.androidSource.revision||manifest.upstream?.repository!==profile.libffi.repository||manifest.upstream?.revision!==profile.libffi.revision||manifest.ndk?.version!==profile.ndk.version||manifest.ndk?.sha256!==profile.ndk.sha256||manifest.target!=='aarch64-linux-android35')throw Error('The sealed libffi source or target differs from the ART profile.');
 for(const relative of ['lib/libffi.a','include/ffi.h','include/ffitarget.h','notices/libffi-LICENSE'])B.readRegular(path.join(payload,relative),B.LIMITS.fileBytes);
 return {archive:path.join(payload,'lib/libffi.a'),include:path.join(payload,'include'),license:path.join(payload,'notices/libffi-LICENSE'),revision:profile.libffi.revision};
}
