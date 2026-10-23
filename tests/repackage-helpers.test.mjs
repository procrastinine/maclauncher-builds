import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{createRequire}from'node:module';import{repackageHelper}from'../tools/repackage-helpers.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs');
test('helper publication preserves native bytes and notices while excluding source-only files',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helper-publication-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const input=path.join(root,'original'),output=path.join(root,'published');fs.mkdirSync(input);
 const binary=Buffer.alloc(32);binary.writeUInt32LE(0xfeedfacf);binary.writeUInt32LE(0x0100000c,4);binary.writeUInt32LE(2,12);
 const content={'helper.json':JSON.stringify({schemaVersion:1,id:'android-privacy',version:'1.0.0'}),'clipboard-helper':binary,'clipboard-helper.mm':'source','build.mjs':'build','license.txt':'MIT notice'};
 for(const[name,value]of Object.entries(content))fs.writeFileSync(path.join(input,name),value,{mode:name==='clipboard-helper'?0o755:0o644});
 const files=Object.keys(content).map(name=>{const{bytes,...f}=B.readRegular(path.join(input,name),B.LIMITS.fileBytes);return{path:name,...f,...(name==='clipboard-helper'?{architectures:['arm64']}:{})};});
 const declaration={id:'android-privacy',version:'1.0.0',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',directoryRelative:'android-privacy/1.0.0/arm64',sourceRelative:'clipboard-helper.mm',sourceSha256:B.digest(Buffer.from('source')),manifestRelative:'helper.json',manifestSha256:files.find(f=>f.path==='helper.json').sha256,files,notices:[{name:'Helper',license:'MIT',path:'license.txt'}]};
 const next=repackageHelper({input,declaration,output});assert.equal(next.sourceRelative,null);assert.equal(next.sourceSha256,declaration.sourceSha256);assert.equal(next.version,'1.0.0-content1');
 assert.deepEqual(fs.readdirSync(output).sort(),['clipboard-helper','helper.json','license.txt']);assert.deepEqual(fs.readFileSync(path.join(output,'clipboard-helper')),binary);assert.equal(JSON.parse(fs.readFileSync(path.join(output,'helper.json'))).version,next.version);B.verifyPayload(input,declaration);B.verifyPayload(output,next);
 fs.appendFileSync(path.join(input,'clipboard-helper.mm'),' changed');const rejected=path.join(root,'rejected');assert.throws(()=>repackageHelper({input,declaration,output:rejected}),/limit|checksum|size/);assert.equal(fs.existsSync(rejected),false);
});
