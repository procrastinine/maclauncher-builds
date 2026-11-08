import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {preparePackageLayout,materializePackageAliases} from '../tools/package-layout.mjs';
const Native=createRequire(import.meta.url)('../producers/package-support/scripts/native-binary-tools.cjs');
import {addLicense,addLicenses,includeLicenses,addCargoLicenses} from '../lib/licenses.mjs';
const fixture=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'licence-intake-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
test('the shared licence functions never throw for unavailable inputs or failed logging',t=>{
 t.mock.method(console,'log',()=>{throw Error('logging');});
 for(const value of [undefined,Symbol('directory'),{toString(){throw Error('conversion');}},Buffer.from('.'),new URL('file:///missing')]){
  for(const operation of [()=>addLicense(value,value,value),()=>addLicenses(value,value,value),()=>includeLicenses(value,value),()=>addCargoLicenses(value,value,value)])assert.doesNotThrow(operation);
 }
});
test('nested licence collections keep readable texts when another directory cannot be read',t=>{
 const root=fixture(t),source=path.join(root,'source'),payload=path.join(root,'payload');fs.mkdirSync(path.join(source,'licensing/third-party'),{recursive:true});fs.mkdirSync(path.join(source,'LICENSES/unreadable'),{recursive:true});fs.writeFileSync(path.join(source,'licensing/third-party/Apache-2.0.txt'),'upstream text');
 const read=fs.readdirSync;t.mock.method(fs,'readdirSync',(directory,...args)=>{if(String(directory).endsWith('unreadable'))throw Object.assign(Error('denied'),{code:'EACCES'});return read(directory,...args);});t.mock.method(console,'log',()=>{});
 assert.doesNotThrow(()=>addLicenses(payload,'component',source));assert.equal(fs.readFileSync(path.join(payload,'licenses/component.txt'),'utf8'),'upstream text');
});
test('missing files, malformed indexes and read-only destinations cannot escape intake',t=>{
 const root=fixture(t),source=path.join(root,'source'),payload=path.join(root,'payload'),index=path.join(root,'index');fs.mkdirSync(index);fs.writeFileSync(source,'readable text');fs.writeFileSync(path.join(index,'components.txt'),'malformed\nmissing: absent.txt\nvalid: text.txt\n');fs.writeFileSync(path.join(index,'text.txt'),'valid indexed text');t.mock.method(console,'log',()=>{});
 assert.doesNotThrow(()=>addLicense(payload,'missing',path.join(root,'absent')));assert.doesNotThrow(()=>includeLicenses(payload,index));assert.ok(fs.readFileSync(path.join(payload,'licenses/components.txt'),'utf8').includes('valid:'));
 t.mock.method(fs,'mkdirSync',()=>{throw Object.assign(Error('read-only'),{code:'EROFS'});});assert.doesNotThrow(()=>addLicense(path.join(root,'readonly'),'component',source));assert.doesNotThrow(()=>addLicenses(path.join(root,'readonly'),'component',root));
});
test('Cargo intake uses its supplied staged lock and toolchain availability is independent',t=>{
 const root=fixture(t),staged=path.join(root,'staged'),cargo=path.join(root,'cargo'),registry=path.join(cargo,'registry/src/test/crate-2.0.0'),home=path.join(root,'rustup'),docs=path.join(home,'toolchains/test/share/doc/rust/licenses');fs.mkdirSync(staged);fs.mkdirSync(registry,{recursive:true});fs.mkdirSync(docs,{recursive:true});fs.writeFileSync(path.join(staged,'Cargo.lock'),'[[package]]\nname = "crate"\nversion = "2.0.0"\n');fs.writeFileSync(path.join(registry,'LICENSE'),'compiled crate text');fs.writeFileSync(path.join(docs,'Apache-2.0.txt'),'standard library text');t.mock.method(console,'log',()=>{});
 const env={CARGO_HOME:cargo,RUSTUP_HOME:home,RUSTUP_TOOLCHAIN:'test'},payload=path.join(root,'payload');assert.doesNotThrow(()=>addCargoLicenses(payload,'Rust',staged,{...env,RUSTUP_HOME:path.join(root,'absent')}));assert.equal(fs.readFileSync(path.join(payload,'licenses/crate-2.0.0.txt'),'utf8'),'compiled crate text');
 const std=path.join(root,'std-only');assert.doesNotThrow(()=>addCargoLicenses(std,'Rust',path.join(root,'absent-lock'),env));assert.equal(fs.readFileSync(path.join(std,'licenses/Rust.txt'),'utf8'),'standard library text');
});

test('compatibility licence bytes and metadata survive aliases while failed intake remains optional',t=>{
 const root=fixture(t),source=path.join(root,'source.txt'),payload=path.join(root,'payload');fs.mkdirSync(payload);fs.writeFileSync(source,'verbatim upstream text');
 const result=addLicense(payload,'upstream',source,'upstream','LICENSE-upstream.txt');assert.equal(result.sha256,crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
 const profile={files:{native:'native checksum',...(result?{'LICENSE-upstream.txt':result.sha256}:{})}};fs.writeFileSync(path.join(payload,'manifest.json'),JSON.stringify(profile));
 const files=fs.readdirSync(payload,{recursive:true}).filter(name=>fs.statSync(path.join(payload,name)).isFile()).map(name=>{const bytes=fs.readFileSync(path.join(payload,name));return {path:name,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),mode:fs.statSync(path.join(payload,name)).mode&0o777};});
 const declaration={id:'fixture',version:'1.0.0',arch:'arm64',manifestRelative:'manifest.json',sourceRelative:null,files};preparePackageLayout({input:payload,declaration,environment:{}});materializePackageAliases({root:payload,declaration,inputs:{}});assert.equal(fs.readFileSync(path.join(payload,'LICENSE-upstream.txt'),'utf8'),'verbatim upstream text');assert.equal(JSON.parse(fs.readFileSync(path.join(payload,'manifest.json'))).files['LICENSE-upstream.txt'],result.sha256);
 t.mock.method(console,'log',()=>{throw Error('logger failure');});let missing;assert.doesNotThrow(()=>{missing=addLicense(payload,'missing',path.join(root,'missing'),'missing','LICENSE-missing.txt');});assert.deepEqual({native:'native checksum',...(missing?{'LICENSE-missing.txt':missing.sha256}:{})},{native:'native checksum'});
});
test('Homebrew classification uses canonical closure paths without filesystem work',t=>{
 t.mock.method(fs,'realpathSync',()=>{throw Error('must not reread a canonical source');});assert.deepEqual(Native.formulaRoot('/opt/homebrew/Cellar/glib/2.90.1/lib/libglib.dylib'),{root:'/opt/homebrew/Cellar/glib/2.90.1',name:'glib',version:'2.90.1'});assert.equal(Native.formulaRoot('/usr/lib/libSystem.B.dylib'),null);
});
test('immediate-child licence intake names each directory and contains missing, unreadable and logger failures',t=>{
 const root=fixture(t),source=path.join(root,'subprojects'),payload=path.join(root,'payload');
 for(const name of ['one','two']){fs.mkdirSync(path.join(source,name),{recursive:true});fs.writeFileSync(path.join(source,name,'LICENSE'),name+' upstream text');}
 fs.writeFileSync(path.join(source,'not-a-directory'),'ignored');fs.mkdirSync(path.join(source,'one','unrelated'));fs.writeFileSync(path.join(source,'one','unrelated','LICENSE'),'not a selected collection');
 addLicenses(payload,'group',source,true);const index=fs.readFileSync(path.join(payload,'licenses/components.txt'),'utf8');assert.ok(index.includes('one: one.txt\n'));assert.ok(index.includes('two: two.txt\n'));assert.equal(fs.readdirSync(path.join(payload,'licenses')).length,3);
 const read=fs.readdirSync;t.mock.method(fs,'readdirSync',(directory,...args)=>{if(directory===source)throw Object.assign(Error('unreadable'),{code:'EACCES'});return read(directory,...args);});t.mock.method(console,'log',()=>{throw Error('logger failure');});
 assert.doesNotThrow(()=>addLicenses(payload,'group',source,true));assert.doesNotThrow(()=>addLicenses(payload,'group',path.join(root,'missing'),true));
});
