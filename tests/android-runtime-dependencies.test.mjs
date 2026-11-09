import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {anglePackageProfile} from '../tools/build-android-angle.mjs';
import {aimAngleInput} from '../tools/build-android-aim.mjs';
import {packageSdl3Framework} from '../tools/build-android-sdl3.mjs';
import {prepareSharedSdlFramework} from '../tools/android-common-publisher-inputs.mjs';
import {preparePackageLayout,materializePackageAliases} from '../tools/package-layout.mjs';
import {pack,verify} from '../tools/runtime-package.mjs';
const Native=createRequire(import.meta.url)('../producers/package-support/scripts/native-binary-tools.cjs');
const profiles=JSON.parse(fs.readFileSync(new URL('../producers/android-inputs/angle.json',import.meta.url))).profiles,commonVersion=profiles.find(row=>row.id==='common').version;
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-runtime-deps-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
test('AIM packaging builds generated product properties without booting a guest',t=>{
 const root=temp(t),bin=path.join(root,'bin'),work=path.join(root,'build'),capture=path.join(root,'command.json');fs.mkdirSync(bin);fs.mkdirSync(work);
 fs.writeFileSync(path.join(bin,'cargo'),'#!'+process.execPath+'\nrequire("node:fs").writeFileSync(process.env.AIM_COMMAND_OUTPUT,JSON.stringify(process.argv.slice(2)));\n',{mode:0o755});
 const script=fileURLToPath(new URL('../producers/package-support/scripts/build-android-aim.mjs',import.meta.url)),env={...process.env,PATH:bin+path.delimiter+process.env.PATH,AIM_COMMAND_OUTPUT:capture};
 execFileSync(process.execPath,[script,'--build','--jobs','2','--work',work],{env});const args=JSON.parse(fs.readFileSync(capture));
 assert.deepEqual(args.slice(0,4),['aim','build','-j','2']);assert.ok(args.includes('product-properties'),'the original overlay consumes target/aim/product-properties/build.prop');assert.ok(!args.includes('userdata/template'));assert.ok(!args.includes('derived-image'));
 execFileSync(process.execPath,[script,'--build','--image-only','--jobs','2','--work',work],{env});assert.deepEqual(JSON.parse(fs.readFileSync(capture)),['aim','build','-j','2','image']);
});
test('Android and AIM share the one published ANGLE input',()=>{
 const common=anglePackageProfile('android-angle',commonVersion).profile;
 assert.equal(common.id,'common');assert.equal(Object.hasOwn(common,'androidSource'),false);
 assert.equal(profiles.length,1);
 assert.throws(()=>anglePackageProfile('android-angle-aim','MCLv6'),/declared source profile/);
});
test('AIM consumes the sealed common ANGLE profile',t=>{
 const root=temp(t),{definition,profile}=anglePackageProfile('android-angle',commonVersion);
 fs.writeFileSync(path.join(root,'angle-manifest.json'),JSON.stringify({version:profile.providerVersion,angleRevision:definition.angle.revision}));
 const input={root,record:{id:'android-angle',version:commonVersion}};
 const result=aimAngleInput(input);assert.equal(result.angle,root);assert.equal(result.profileId,'common');
});

function frameworkImage(){
 const command=(type,offset,text)=>{const bytes=Buffer.alloc(Math.ceil((offset+Buffer.byteLength(text)+1)/8)*8);bytes.writeUInt32LE(type);bytes.writeUInt32LE(bytes.length,4);bytes.writeUInt32LE(offset,8);bytes.write(text,offset);return bytes;};
 const minimum=Buffer.alloc(16);minimum.writeUInt32LE(0x24);minimum.writeUInt32LE(16,4);minimum.writeUInt32LE(13<<16,8);minimum.writeUInt32LE(27<<16,12);
 const commands=[minimum,command(0x8000001c,12,'@loader_path/Frameworks'),command(0x8000001c,12,'@executable_path/../Frameworks'),command(0xd,24,'@rpath/SDL3.framework/Versions/A/SDL3')];
 const image=cpu=>{const bytes=Buffer.alloc(32+commands.reduce((n,x)=>n+x.length,0));bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(cpu,4);bytes.writeUInt32LE(6,12);bytes.writeUInt32LE(commands.length,16);bytes.writeUInt32LE(bytes.length-32,20);let at=32;for(const item of commands){item.copy(bytes,at);at+=item.length;}return bytes;};
 const slices=[image(0x0100000c),image(0x01000007)],fat=Buffer.alloc(64+slices.reduce((n,x)=>n+x.length,0));fat.writeUInt32BE(0xcafebabe);fat.writeUInt32BE(2,4);let at=64;for(let i=0;i<slices.length;i++){fat.writeUInt32BE(i?0x01000007:0x0100000c,8+i*20);fat.writeUInt32BE(at,16+i*20);fat.writeUInt32BE(slices[i].length,20+i*20);slices[i].copy(fat,at);at+=slices[i].length;}return fat;
}
test('SDL3 seals only its canonical Mach-O directory and restores the compile-time framework API in work',async t=>{
 const root=temp(t),sdl=path.join(root,'SDL3.framework'),version=path.join(sdl,'Versions/A');fs.mkdirSync(path.join(version,'Resources'),{recursive:true});fs.mkdirSync(path.join(version,'Headers'));
 const image=frameworkImage();fs.writeFileSync(path.join(version,'SDL3'),image,{mode:0o755});fs.writeFileSync(path.join(version,'Headers/SDL.h'),'complete fixture public API');fs.writeFileSync(path.join(version,'Resources/LICENSE.txt'),'original publisher licence');fs.writeFileSync(path.join(version,'Resources/Info.plist'),'publisher version metadata');
 // Only the platform tool's deployment-target query is replaced. Real bounded
 // Mach-O readers and the package alias/load-command guard inspect the image.
 t.mock.method(Native,'loadCommands',()=>({minimumMacOS:'13.0',rpaths:['@loader_path/Frameworks','@executable_path/../Frameworks']}));
 fs.symlinkSync('A',path.join(sdl,'Versions/Current'));for(const name of ['SDL3','Headers','Resources'])fs.symlinkSync('Versions/Current/'+name,path.join(sdl,name));
 const output=path.join(root,'output');packageSdl3Framework({project:'native-sdl3',version:'3.4.18-MCLv1',output,sdl,profile:{version:'3.4.18',url:'https://example.com/SDL3.dmg',sha256:'a'.repeat(64)}});
 const declaration=JSON.parse(fs.readFileSync(path.join(output,'declaration.json')));assert.equal(declaration.id,'native-sdl3');assert.equal(declaration.arch,'universal');assert.ok(!declaration.files.some(file=>file.path==='native/SDL3.framework/Headers/SDL.h'));assert.ok(declaration.files.some(file=>file.path==='native/SDL3.framework/Versions/A/Headers/SDL.h'));;for(const file of declaration.files)assert.equal(fs.lstatSync(path.join(output,'payload',file.path)).isSymbolicLink(),false);
 assert.deepEqual(declaration.files.filter(file=>file.architectures).map(file=>file.path),['native/SDL3.framework/Versions/A/SDL3']);
 assert.equal(fs.readFileSync(path.join(output,'payload/licenses/SDL3.txt'),'utf8'),'original publisher licence');
 assert.match(fs.readFileSync(path.join(output,'payload/licenses/components.txt'),'utf8'),/^SDL3: SDL3\.txt$/m);
 const payload=path.join(output,'payload');preparePackageLayout({input:payload,declaration,environment:{}});
 ;
 const archive=path.join(root,'native-sdl3-3.4.18-MCLv1-universal.tar.gz'),record=await pack({project:'native-sdl3',input:payload,declaration,output:archive});
 const checked=await verify({archive,sha256:record.asset.sha256,project:'native-sdl3',version:declaration.version,arch:'universal',includeDeclaration:true});
 ;
 materializePackageAliases({root:payload,declaration,inputs:{}});
 const view=prepareSharedSdlFramework({root:payload},path.join(root,'work'));
 for(const name of ['SDL3','Headers/SDL.h','Resources/LICENSE.txt']){
  assert.equal(fs.realpathSync(path.join(view,name)),fs.realpathSync(path.join(view,'Versions/A',name)));
  assert.deepEqual(fs.readFileSync(path.join(view,name)),fs.readFileSync(path.join(payload,'native/SDL3.framework/Versions/A',name)));
 }
 assert.equal(fs.lstatSync(path.join(view,'Versions/A')).isDirectory(),true);
 assert.equal(fs.lstatSync(path.join(view,'Versions/Current')).isSymbolicLink(),true);
 assert.deepEqual(fs.readdirSync(path.join(view,'Versions'),{withFileTypes:true}).filter(version=>version.isDirectory()).map(version=>version.name),['A'],'Android compile.mjs must discover the canonical version directory');
 assert.equal(fs.readlinkSync(path.join(view,'Versions/Current')),'A');
 assert.deepEqual(fs.readFileSync(path.join(view,'SDL3')),image,'Publisher Mach-O bytes remain unchanged');
 assert.ok(!fs.existsSync(path.join(payload,'native/SDL3.framework/SDL3')),'Compile-time links never enter the sealed dependency');
});


test("AIM source follows Android's upstream selection and shared original image declaration",async()=>{
 const {source}=await import('../producers/package-support/src/modules/android/providers/aim/source.mjs');
 const {aimSource}=await import('../lib/android-source.mjs');
 const image=JSON.parse(fs.readFileSync(new URL('../producers/android-image-data/source.json',import.meta.url))).archive;
 assert.equal(source.revision,aimSource().revision);assert.equal(source.androidImage.url,image.url);assert.equal(source.androidImage.sha256,image.sha256);assert.equal(source.androidImage.size,image.bytes);
});
