import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {androidSource} from '../lib/android-source.mjs';
import {angleDefinition,packageAngleInput} from '../tools/build-android-angle.mjs';
import {sha} from '../tools/helper-package.mjs';
const requirements=createRequire(import.meta.url)('./support/requirements.cjs');
const Native=createRequire(import.meta.url)('../producers/package-support/scripts/native-binary-tools.cjs');

test('ANGLE seals its generated binary token without a second source declaration',requirements({sourceTree:'sources/maclauncher-android'}),t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'angle-package-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const definition=angleDefinition(),profile=definition.profiles.find(row=>row.id==='common'),angle=path.join(root,'angle');fs.mkdirSync(angle);
 assert.equal(Object.hasOwn(profile,'programBinaryVersion'),false);
 const files=['libEGL.dylib','libGLESv2.dylib'].map((name,index)=>{
  const image=Buffer.alloc(52);image.writeUInt32LE(0xfeedfacf);image.writeUInt32LE(0x0100000c,4);image.writeUInt32LE(6,12);image.writeUInt32LE(1,16);image.writeUInt32LE(16,20);image.writeUInt32LE(0x24,32);image.writeUInt32LE(16,36);image.writeUInt32LE(13<<16,40);image.writeUInt32LE(27<<16,44);image.writeUInt32LE(index,48);
  const file=path.join(angle,name);fs.writeFileSync(file,image,{mode:0o755});return {path:name,size:image.length,sha256:sha(file)};
 });
 // The platform query is injected; the actual bounded Mach-O reader checks the CPU.
 t.mock.method(Native,'loadCommands',()=>({minimumMacOS:'13.0',rpaths:[]}));
 const manifest={version:profile.providerVersion,angleRevision:definition.angle.revision,programBinaryVersion:'a'.repeat(32),adaptations:[],files},file=path.join(angle,'angle-manifest.json');
 fs.writeFileSync(file,JSON.stringify(manifest));
 const input={angle,profileId:profile.id,source:path.resolve(import.meta.dirname,'..',androidSource().directory)},output=path.join(root,'package');
 packageAngleInput({project:definition.id,version:profile.version,arch:'arm64',output,input});
 assert.equal(JSON.parse(fs.readFileSync(path.join(output,'payload/angle-manifest.json'))).programBinaryVersion,manifest.programBinaryVersion);
 fs.appendFileSync(path.join(angle,'libEGL.dylib'),'changed');
 assert.throws(()=>packageAngleInput({project:definition.id,version:profile.version,arch:'arm64',output:path.join(root,'changed-library'),input}),/compiler product differs/);
});
