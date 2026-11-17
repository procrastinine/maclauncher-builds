import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativeProviderArchitectures as inspect,verifyGraphicsExecutableModes} from '../producers/package-support/scripts/graphics-native-files.mjs';
function thin(cpu,type=2){const b=Buffer.alloc(32);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE(cpu,4);b.writeUInt32LE(type,12);return b;}
test('provider native classification follows actual headers even without executable mode or a suffix',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-native-mode-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const tools=[['anr-convert-dxil',0x100000c],['anr-verify',0x1000007]];
 for(const[name,cpu]of tools){const file=path.join(root,name);fs.writeFileSync(file,thin(cpu),{mode:0o644});assert.deepEqual([...inspect(file)],[cpu===0x100000c?'arm64':'x86_64']);}
 const data=path.join(root,'provider.json');fs.writeFileSync(data,'{}');assert.equal(inspect(data),null);
 const library=path.join(root,'without-extension');fs.writeFileSync(library,thin(0x100000c,6));assert.deepEqual([...inspect(library)],['arm64']);
});
test('universal extensionless provider tools retain both measured architectures and malformed native headers fail',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-native-fat-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.alloc(112);bytes.writeUInt32BE(0xcafebabe,0);bytes.writeUInt32BE(2,4);
 for(const[index,cpu]of [0x100000c,0x1000007].entries()){const at=8+index*20,offset=48+index*32;bytes.writeUInt32BE(cpu,at);bytes.writeUInt32BE(offset,at+8);bytes.writeUInt32BE(32,at+12);thin(cpu).copy(bytes,offset);}
 const file=path.join(root,'tool');fs.writeFileSync(file,bytes);assert.deepEqual([...inspect(file)],['arm64','x86_64']);
 fs.writeFileSync(file,Buffer.from([0xcf,0xfa,0xed,0xfe]));assert.throws(()=>inspect(file),/Mach-O/);
});

test('graphics mode verification rejects both declaration and filesystem permission gaps',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-mode-verify-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'anr-verify');fs.writeFileSync(file,thin(0x100000c),{mode:0o644});
 assert.throws(()=>verifyGraphicsExecutableModes(root,[{path:'anr-verify',mode:0o644}]),/not declared executable/);
 assert.throws(()=>verifyGraphicsExecutableModes(root,[{path:'anr-verify',mode:0o755}]),/no execute permission/);
 fs.chmodSync(file,0o755);assert.deepEqual(verifyGraphicsExecutableModes(root,[{path:'anr-verify',mode:0o755}]),{files:1,native:1,executables:1});
});
