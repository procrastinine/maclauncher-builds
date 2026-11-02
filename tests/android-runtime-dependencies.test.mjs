import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {anglePackageProfile} from '../tools/build-android-angle.mjs';
import {aimAngleInput} from '../tools/build-android-aim.mjs';
import {packageSdl3Framework} from '../tools/build-android-sdl3.mjs';
const profiles=JSON.parse(fs.readFileSync(new URL('../producers/android-inputs/angle.json',import.meta.url))).profiles,commonVersion=profiles.find(row=>row.id==='common').version,aimProfile=profiles.find(row=>row.id==='aim6');
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-runtime-deps-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
test('AIM ANGLE dependency preserves its own original program transport and historical common selection',()=>{
 const common=anglePackageProfile('android-angle',commonVersion).profile,aim=anglePackageProfile('android-angle-aim',aimProfile.packageVersion).profile;
 assert.equal(common.id,'common');assert.equal(aim.id,'aim6');assert.notEqual(common.programBinaryVersion,aim.programBinaryVersion);
 if(commonVersion!==aimProfile.version)assert.deepEqual(anglePackageProfile('android-angle',aimProfile.version).profile,aim);
 assert.equal(aim.androidSource.revision,'5041bb49525a4178ac9db5ab868e1f89cd225014');assert.equal(common.androidSource.revision,'0d50c2f70d90549a18a69e51e33ed9308338f446');
 assert.throws(()=>anglePackageProfile('android-angle-aim','unknown'),/declared source profile/);
});
test('AIM accepts only the prepared original AIM ANGLE package and rejects the common profile',t=>{
 const root=temp(t),{definition,profile}=anglePackageProfile('android-angle-aim',aimProfile.packageVersion);
 const manifest={version:profile.providerVersion,programBinaryVersion:profile.programBinaryVersion,angleRevision:definition.angle.revision};fs.writeFileSync(path.join(root,'angle-manifest.json'),JSON.stringify(manifest));
 const input={root,record:{id:'android-angle-aim',version:aimProfile.packageVersion}};const result=aimAngleInput(input);assert.equal(result.angle,root);assert.equal(result.angleNotices,path.join(root,'notices'));assert.equal(result.profileId,'aim6');
 manifest.programBinaryVersion=anglePackageProfile('android-angle',commonVersion).profile.programBinaryVersion;fs.writeFileSync(path.join(root,'angle-manifest.json'),JSON.stringify(manifest));assert.throws(()=>aimAngleInput(input),/original profile/);
});
test('SDL3 package retains the complete publisher framework API with regular aliasable inventory',t=>{
 const root=temp(t),sdl=path.join(root,'SDL3.framework'),version=path.join(sdl,'Versions/A');fs.mkdirSync(path.join(version,'Resources'),{recursive:true});fs.mkdirSync(path.join(version,'Headers'));
 fs.writeFileSync(path.join(version,'SDL3'),'fixture framework library',{mode:0o755});fs.writeFileSync(path.join(version,'Headers/SDL.h'),'complete fixture public API');fs.writeFileSync(path.join(version,'Resources/LICENSE.txt'),'original publisher licence');fs.writeFileSync(path.join(version,'Resources/Info.plist'),'publisher version metadata');
 fs.symlinkSync('A',path.join(sdl,'Versions/Current'));for(const name of ['SDL3','Headers','Resources'])fs.symlinkSync('Versions/Current/'+name,path.join(sdl,name));
 const output=path.join(root,'output');packageSdl3Framework({project:'native-sdl3',version:'3.4.18-MCLv1',output,sdl,profile:{version:'3.4.18',url:'https://example.com/SDL3.dmg',sha256:'a'.repeat(64)}});
 const declaration=JSON.parse(fs.readFileSync(path.join(output,'declaration.json')));assert.equal(declaration.id,'native-sdl3');assert.equal(declaration.arch,'universal');assert.ok(declaration.files.some(file=>file.path==='native/SDL3.framework/Headers/SDL.h'));assert.ok(declaration.files.some(file=>file.path==='native/SDL3.framework/Versions/A/Headers/SDL.h'));assert.equal(declaration.notices[0].path,'native/SDL3.framework/Resources/LICENSE.txt');for(const file of declaration.files)assert.equal(fs.lstatSync(path.join(output,'payload',file.path)).isSymbolicLink(),false);
});
