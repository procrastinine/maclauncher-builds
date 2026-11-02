import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {preparePackageLayout,materializePackageAliases,checkPackageDuplicates} from '../tools/package-layout.mjs';
import {recordFromDeclaration} from '../tools/release-runtime.mjs';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'package-layout-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const payload=path.join(root,'payload');fs.mkdirSync(payload);
 const files=[],write=(name,text)=>{const bytes=Buffer.from(text);fs.mkdirSync(path.dirname(path.join(payload,name)),{recursive:true});fs.writeFileSync(path.join(payload,name),bytes,{mode:0o644});const record={path:name,size:bytes.length,sha256:hash(bytes),mode:0o644};files.push(record);return record;};
 write('manifest.json','{"id":"consumer"}');write('LICENSE','original component notice');
 return {root,payload,files,write,declaration:{id:'consumer',version:'1.0.0',arch:'arm64',manifestRelative:'manifest.json',sourceRelative:null,files,notices:[{path:'LICENSE'}]}};
}
test('packaging stores identical payload bytes once while preserving component notices and logical paths',t=>{
 const f=fixture(t);f.write('a.bin','same binary payload');f.write('sub/b.bin','same binary payload');f.write('licenses/vendor.txt','original component notice');
 preparePackageLayout({input:f.payload,declaration:f.declaration,environment:{}});
 assert.deepEqual(JSON.parse(JSON.stringify(f.declaration.aliases)),{schema:1,files:{'sub/b.bin':'a.bin'}});assert.ok(fs.existsSync(path.join(f.payload,'licenses/vendor.txt')));
 assert.equal(checkPackageDuplicates({declaration:f.declaration,environment:{}}).aliases,1);
 materializePackageAliases({root:f.payload,declaration:f.declaration,inputs:{}});assert.equal(fs.readFileSync(path.join(f.payload,'sub/b.bin'),'utf8'),'same binary payload');assert.ok(!fs.lstatSync(path.join(f.payload,'sub/b.bin')).isSymbolicLink());
});
test('a copied dependency becomes an exact release reference and a relative symlink without repacking its bytes',t=>{
 const f=fixture(t),shared=f.write('lib/shared.bin','a shared binary'),depRoot=path.join(f.root,'dependency');fs.mkdirSync(depRoot);fs.writeFileSync(path.join(depRoot,'shared.bin'),'a shared binary');
 const dependency={root:depRoot,declaration:{id:'shared',version:'2.0.0-MCLv1',files:[{...shared,path:'shared.bin'}],notices:[],manifestRelative:'manifest.json'},record:{id:'shared',version:'2.0.0-MCLv1',asset:{sha256:'a'.repeat(64)}}},inputs={shared:dependency},environment={MACLAUNCHER_BUILD_INPUTS:JSON.stringify(inputs)};
 preparePackageLayout({input:f.payload,declaration:f.declaration,environment});assert.ok(!fs.existsSync(path.join(f.payload,'lib/shared.bin')));
 assert.deepEqual(f.declaration.dependencies,[{project:'shared',release:'2.0.0-MCLv1',sha256:'a'.repeat(64)}]);assert.deepEqual(f.declaration.aliases.files['lib/shared.bin'],{project:'shared',path:'shared.bin'});
 assert.equal(recordFromDeclaration(f.declaration,{filename:'test.tar.gz'}).launcherContract,2);
 assert.equal(checkPackageDuplicates({declaration:f.declaration,environment}).dependencies,1);
 materializePackageAliases({root:f.payload,declaration:f.declaration,inputs});assert.equal(fs.readFileSync(path.join(f.payload,'lib/shared.bin'),'utf8'),'a shared binary');assert.ok(fs.lstatSync(path.join(f.payload,'lib/shared.bin')).isSymbolicLink());assert.ok(!path.isAbsolute(fs.readlinkSync(path.join(f.payload,'lib/shared.bin'))));
});
test('the single duplicate check rejects uncollapsed bytes and alias resolution rejects undeclared targets',t=>{
 const f=fixture(t);f.write('first.bin','duplicate');f.write('second.bin','duplicate');assert.throws(()=>checkPackageDuplicates({declaration:f.declaration,environment:{}}),/Duplicate stored payload/);
 f.declaration.aliases={schema:1,files:{missing:{project:'undeclared',path:'../outside'}}};assert.throws(()=>materializePackageAliases({root:f.payload,declaration:f.declaration,inputs:{}}),/undeclared/);
});
