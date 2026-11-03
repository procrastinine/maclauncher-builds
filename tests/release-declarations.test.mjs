import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareRelease,verifyRelease,verifyRemoteRelease,applyRelease} from '../tools/release-runtime.mjs';
import {publicDeclaration} from '../tools/runtime-package.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),target='a'.repeat(40);
function fixture(t,kind){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'published-declaration-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const producer=kind==='maclauncher'?{kind,repository:'https://github.com/owner/source',entries:['tools/build.mjs']}:{kind:'prebuilt',version:'1.0.0',architectures:['arm64']};
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[{id:'engine',name:'Engine',delivery:'downloadable',packageProfiles:[{version:'1.0.0',label:'Engine 1.0.0'}],producer,upstreams:[]}]}));
 const input=path.join(directory,'input');fs.mkdirSync(input);const data={'runtime.json':'{"version":"1.0.0"}','LICENSE':'Complete original MIT notice','NOTICE':'Original component notice','source.tar.gz':'original source'};
 const files=Object.entries(data).map(([name,content])=>{fs.writeFileSync(path.join(input,name),content,{mode:0o644});return {path:name,size:Buffer.byteLength(content),mode:0o644,sha256:sha(content)};});
 const declaration={id:'engine',version:'1.0.0',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',directoryRelative:'engine/1.0.0/arm64',manifestRelative:'runtime.json',manifestSha256:files[0].sha256,sourceRelative:'source.tar.gz',sourceSha256:sha(data['source.tar.gz']),files,notices:[{name:'Engine',license:'MIT',path:'LICENSE'},{name:'Component',license:'See original notice',path:'NOTICE'}]};
 return {project:'engine',directory,input,declaration,output:path.join(directory,'release')};
}
function remote(record){return async args=>{
 assert.equal(args[0],'api');assert.equal(args.includes('POST'),false);
 if(args[1].includes('/git/ref/'))return JSON.stringify({object:{sha:target,type:'commit'}});
 assert.deepEqual(args,['api','repos/owner/builds/releases/tags/engine%2Fv1.0.0%2Farm64']);
 return JSON.stringify({id:17,tag_name:'engine/v1.0.0/arm64',draft:false,assets:[{id:1,name:record.asset.filename,size:record.asset.bytes,state:'uploaded',digest:'sha256:'+record.asset.sha256}]});
};}
// The real archive and remote identity are checked; only cryptographic authority is injected,
// as in the existing release lifecycle fixtures. This grants no real publication authority.
const authority=({record,repository,archive})=>{assert.equal(repository,'owner/builds');assert.equal(sha(fs.readFileSync(archive)),record.asset.sha256);return {sourceRevision:target};};
for(const kind of ['maclauncher','prebuilt'])test(kind+' publication exports the verified full declaration once and rejects replacement before catalog writes',async t=>{
 const f=fixture(t,kind);await prepareRelease(f);
 const checked=await verifyRelease({bundle:f.output,directory:f.directory});assert.equal(checked.declaration,undefined);
 const included=await verifyRelease({bundle:f.output,directory:f.directory,includeDeclaration:true});assert.deepEqual(included.declaration,publicDeclaration(f.declaration));
 const options={bundle:f.output,directory:f.directory,runGh:remote(checked.record),verifyGithubBuild:authority};
 assert.deepEqual((await verifyRemoteRelease({...options,includeDeclaration:true})).declaration,included.declaration);
 const applied=await applyRelease(options),expected=path.join(f.directory,'catalogs/declarations/engine/1.0.0/arm64.json');assert.equal(applied.declaration,expected);
 const exported=JSON.parse(fs.readFileSync(expected));assert.deepEqual(exported,included.declaration);assert.deepEqual(exported.files,f.declaration.files);assert.deepEqual(exported.notices,f.declaration.notices);assert.equal(exported.manifestSha256,checked.record.manifestSha256);assert.equal(exported.sourceSha256,checked.record.sourceSha256);
 const original=fs.readFileSync(expected);await applyRelease(options);assert.deepEqual(fs.readFileSync(expected),original);
 const catalogFile=path.join(f.directory,'catalogs/engine.json'),indexFile=path.join(f.directory,'catalogs/index.json'),before=[fs.readFileSync(catalogFile),fs.readFileSync(indexFile)];
 exported.files[0].sha256='0'.repeat(64);fs.writeFileSync(expected,JSON.stringify(exported));
 await assert.rejects(applyRelease(options),/existing sealed declaration differs/);assert.deepEqual(fs.readFileSync(catalogFile),before[0]);assert.deepEqual(fs.readFileSync(indexFile),before[1]);
});
test('archive/record disagreement cannot export a declaration or mutate catalogs',async t=>{
 const f=fixture(t,'prebuilt');await prepareRelease(f);const sidecar=path.join(f.output,'engine-1.0.0-arm64.tar.gz.json'),record=JSON.parse(fs.readFileSync(sidecar));record.sourceSha256='0'.repeat(64);fs.writeFileSync(sidecar,JSON.stringify(record));
 await assert.rejects(applyRelease({bundle:f.output,directory:f.directory,runGh:()=>assert.fail('Invalid archive must stop before remote'),verifyGithubBuild:authority}),/record differs/);
 assert.equal(fs.existsSync(path.join(f.directory,'catalogs')),false);
});
