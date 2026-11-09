import {appRequire} from '../tools/app-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {createRequire} from 'node:module';
import {preparePackageLayout,materializePackageAliases} from '../tools/package-layout.mjs';
import {recordFromDeclaration} from '../tools/release-runtime.mjs';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const B=appRequire('src/modules/shared/runtime/bundled-native.js');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'package-layout-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const payload=path.join(root,'payload');fs.mkdirSync(payload);
 const files=[],write=(name,text)=>{const bytes=Buffer.from(text);fs.mkdirSync(path.dirname(path.join(payload,name)),{recursive:true});fs.writeFileSync(path.join(payload,name),bytes,{mode:0o644});const record={path:name,size:bytes.length,sha256:hash(bytes),mode:0o644};files.push(record);return record;};
 write('manifest.json','{"id":"consumer"}');write('a-data.txt','original component data');
 return {root,payload,files,write,declaration:{id:'consumer',version:'1.0.0',arch:'arm64',manifestRelative:'manifest.json',sourceRelative:null,files}};
}
test('packaging stores identical payload bytes once while preserving component data and logical paths',t=>{
 const f=fixture(t);f.write('a.bin','same binary payload');f.write('sub/b.bin','same binary payload');f.write('assets/vendor.txt','original component data');
 preparePackageLayout({input:f.payload,declaration:f.declaration,environment:{}});
 assert.deepEqual(JSON.parse(JSON.stringify(f.declaration.aliases)),{schema:1,files:{'assets/vendor.txt':'a-data.txt','sub/b.bin':'a.bin'}});assert.equal(fs.existsSync(path.join(f.payload,'assets/vendor.txt')),false);
 assert.equal(recordFromDeclaration(f.declaration,{filename:'test.tar.gz'}).launcherContract,undefined);
 assert.equal(recordFromDeclaration(f.declaration,{filename:'test.tar.gz'},undefined,undefined,{launcherContract:2}).launcherContract,2);

 materializePackageAliases({root:f.payload,declaration:f.declaration,inputs:{}});assert.equal(fs.readFileSync(path.join(f.payload,'sub/b.bin'),'utf8'),'same binary payload');assert.ok(!fs.lstatSync(path.join(f.payload,'sub/b.bin')).isSymbolicLink());assert.equal(fs.readFileSync(path.join(f.payload,'assets/vendor.txt'),'utf8'),'original component data');
});
test('prepared build inputs remain copied into the self-contained consumer',t=>{
 const f=fixture(t),shared=f.write('lib/shared.bin','a shared binary'),depRoot=path.join(f.root,'dependency');fs.mkdirSync(depRoot);fs.writeFileSync(path.join(depRoot,'shared.bin'),'a shared binary');
 const dependency={root:depRoot,declaration:{id:'shared',version:'2.0.0-MCLv1',files:[{...shared,path:'shared.bin'}],manifestRelative:'manifest.json'},record:{id:'shared',version:'2.0.0-MCLv1',asset:{sha256:'a'.repeat(64)}}},inputs={shared:dependency},environment={MACLAUNCHER_BUILD_INPUTS:JSON.stringify(inputs)};
 preparePackageLayout({input:f.payload,declaration:f.declaration,environment});assert.ok(fs.existsSync(path.join(f.payload,'lib/shared.bin')));
 assert.equal(f.declaration.dependencies,undefined);assert.equal(f.declaration.aliases,undefined);assert.equal(recordFromDeclaration(f.declaration,{filename:'test.tar.gz'}).launcherContract,undefined);

 materializePackageAliases({root:f.payload,declaration:f.declaration,inputs});assert.equal(fs.readFileSync(path.join(f.payload,'lib/shared.bin'),'utf8'),'a shared binary');assert.equal(fs.lstatSync(path.join(f.payload,'lib/shared.bin')).isSymbolicLink(),false);
});
test('build-only inputs never turn matching consumer bytes into runtime downloads',t=>{
 const f=fixture(t),shared=f.write('lib/owned.bin','the same stage bytes'),depRoot=path.join(f.root,'stage');fs.mkdirSync(depRoot);fs.writeFileSync(path.join(depRoot,'stage.bin'),'the same stage bytes');
 const dependency={root:depRoot,declaration:{id:'stage',version:'1.0.0',files:[{...shared,path:'stage.bin'}],manifestRelative:'manifest.json'},record:{id:'stage',version:'1.0.0',asset:{sha256:'a'.repeat(64)}}},environment={MACLAUNCHER_BUILD_INPUTS:JSON.stringify({stage:dependency})};
 preparePackageLayout({input:f.payload,declaration:f.declaration,environment});
 assert.equal(fs.readFileSync(path.join(f.payload,'lib/owned.bin'),'utf8'),'the same stage bytes');assert.equal(f.declaration.aliases,undefined);assert.equal(f.declaration.dependencies,undefined);
});
test('alias resolution rejects undeclared targets',t=>{
 const f=fixture(t);
 f.declaration.aliases={schema:1,files:{missing:{project:'undeclared',path:'../outside'}}};assert.throws(()=>materializePackageAliases({root:f.payload,declaration:f.declaration,inputs:{}}),/undeclared/);
});
test('native local aliases share the canonical inode and reject a changed symlink',t=>{
 const f=fixture(t),bytes=Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x0100000c,4);bytes.writeUInt32LE(6,12);
 for(const name of ['lib/a.dylib','lib/b.dylib'])Object.assign(f.write(name,bytes),{architectures:['arm64']});
 preparePackageLayout({input:f.payload,declaration:f.declaration,environment:{}});materializePackageAliases({root:f.payload,declaration:f.declaration,inputs:{}});
 const alias=path.join(f.payload,'lib/b.dylib'),canonical=path.join(f.payload,'lib/a.dylib');
 assert.equal(fs.readlinkSync(alias),'a.dylib');assert.equal(fs.statSync(alias).ino,fs.statSync(canonical).ino);
 fs.unlinkSync(alias);fs.symlinkSync('../a-data.txt',alias);assert.throws(()=>B.verifyPayload(f.payload,f.declaration),/local Mach-O alias differs/);
});
