import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {androidSource,ndkSource} from '../lib/android-source.mjs';
import {readArtFfiInput} from '../tools/android-art-ffi-input.mjs';
import {helperPackage,sha} from '../tools/helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),json=file=>JSON.parse(fs.readFileSync(path.join(root,file)));

test('included ART supplier retains the canonical acquisition metadata and source records',()=>{
 const relative='runtime/src/modules/android/art/supplier.json',file=path.join(root,'producers/android-launcher/supplied',relative),canonical=path.join(root,androidSource().directory,'src/modules/android/art/supplier.json');
 assert.deepEqual(fs.readFileSync(file),fs.readFileSync(canonical));
 const supplier=JSON.parse(fs.readFileSync(file));assert.ok(supplier.imageAcquisition);assert.ok(supplier.sources);
 const source=json('producers/android-launcher/source.json').files.find(row=>row.path==='supplied/'+relative),profile=json('producers/included-helpers/profiles/android-launcher.json').inputs.find(row=>row.path===relative);
 assert.equal(source.sha256,sha(file));assert.equal(profile.sha256,sha(file));assert.equal(profile.size,fs.statSync(file).size);
});

test('sealed ART FFI requires its archive and both API headers even when omitted from the inventory',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'art-ffi-input-'));try{
 const descriptor='producers/android-art-inputs/ffi.json',profile=json(descriptor),libffi=json('producers/dependencies.json').libffi,files=['lib/libffi.a','include/ffi.h','include/ffitarget.h'];
 for(const [index,missing]of [undefined,...files].entries()){
  const output=path.join(directory,String(index)),payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
  for(const file of files.filter(file=>file!==missing)){const destination=path.join(payload,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,'temporary archive/header fixture '+file);}
  helperPackage({id:profile.id,version:profile.version,arch:'arm64',output,minimumMacOS:'13.0',sourceSha256:sha(path.join(root,descriptor)),manifestRelative:'input.json',record:{androidSource:androidSource(),upstream:libffi,ndk:{version:ndkSource().version,sha256:profile.ndk.sha256},target:'aarch64-linux-android35'}});
  if(missing)assert.throws(()=>readArtFfiInput(output),undefined,missing);else assert.equal(readArtFfiInput(output).archive,path.join(payload,'lib/libffi.a'));
 }
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
