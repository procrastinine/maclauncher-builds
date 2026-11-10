import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {buildAndroidArtSupplier} from '../tools/build-android-art-supplier.mjs';
const requirements=createRequire(import.meta.url)('./support/requirements.cjs');

// The Android modules link into the Android repository's own app checkout.
test('ART supplier hands generated ARM32 source records to the source exporter',requirements({sourceTree:['sources/maclauncher-android','sources/maclauncher-android/sources/maclauncher']}),async t=>{
 const {arm32BuildProducts}=await import('../sources/maclauncher-android/src/modules/android/native/arm32/components.mjs');
 const {nativeBridgeTrees}=await import('../sources/maclauncher-android/src/modules/android/art/source-archive.mjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'art-source-handoff-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const arm32=arm32BuildProducts(directory),revision='a'.repeat(40);fs.mkdirSync(arm32.sources);
 fs.writeFileSync(path.join(arm32.sources,'bionic.json'),JSON.stringify({revision,files:['linker/source.cpp']}));
 fs.writeFileSync(path.join(arm32.sources,'bionic-portable-families.json'),JSON.stringify({revision,jump:['libc/jump.S']}));
 // Exercise the supplier's actual handoff expression and the upstream reader,
 // without running the compiler before that boundary.
 const expression=buildAndroidArtSupplier.toString().match(/nativeBridgeSources:(\{[^{}]*\})/)?.[1];assert.ok(expression);
 const input=Function('arm32','arm32Inputs','return ('+expression+');')(arm32,{ndkHeaders:path.join(directory,'ndk')});
 assert.equal(input.arm32Sources,arm32.sources);
 const files=nativeBridgeTrees(input,revision);assert.ok(files.includes('linker/source.cpp'));assert.ok(files.includes('libc/jump.S'));
 assert.throws(()=>nativeBridgeTrees(input,'b'.repeat(40)),/revision differs/);
});
