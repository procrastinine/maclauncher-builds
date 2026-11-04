import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {prepareAndroidCommonJavaProducer} from '../tools/android-common-java-inputs.mjs';
import {helperPackage,sha} from '../tools/helper-package.mjs';
const root=path.resolve(import.meta.dirname,'..');

export async function javaFixture(directory,kind){
 const file=path.join(root,'producers/android-inputs/java-'+kind+'.json');
 const profile=JSON.parse(fs.readFileSync(file)),sourceSha256=sha(file);
 const output=path.join(directory,kind),payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
 const files=kind==='converter'?['dex2jvm.jar','converter-overlay.jar','android-api-headers.jar']:['products/android-framework.jar','build/classes/Fixture.class','build/framework-tool/Fixture.class','build/jni/fixture.h','build/host-callbacks.h','build/host-callbacks.c'];
 for(const name of files){fs.mkdirSync(path.dirname(path.join(payload,name)),{recursive:true});fs.writeFileSync(path.join(payload,name),'sealed fixture');}
 fs.writeFileSync(path.join(payload,'NOTICE'),'Fixture notice');
 await helperPackage({id:profile.id,version:profile.version,arch:'arm64',output,minimumMacOS:'13.0',sourceSha256,manifestRelative:'input.json',record:{androidSource:profile.androidSource,...(profile.converter?{converter:profile.converter}:{})}});
 return {profile,payload};
}

test('Java transport preserves the clean selected native producer independently of Java source pins',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-java-composition-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const original=path.join(root,'sources/maclauncher-android'),android=path.join(directory,'android');
 for(const file of ['build-options.mjs','compile.mjs','converter-build.mjs','framework-build.mjs','framework-modules.mjs','process-ids.c']){const relative='src/modules/android/native/'+file;fs.mkdirSync(path.dirname(path.join(android,relative)),{recursive:true});fs.copyFileSync(path.join(original,relative),path.join(android,relative));}
 const git=(...args)=>execFileSync('git',['-C',android,...args],{stdio:'pipe'});
 git('init','-q');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Independent native producer');
 const {payload:input}=await javaFixture(directory,'converter'),{payload:framework}=await javaFixture(directory,'framework');
 const output=path.join(directory,'producer');
 prepareAndroidCommonJavaProducer({android,input,framework,output});
 const native='src/modules/android/native/process-ids.c';
 assert.equal(sha(path.join(output,native)),sha(path.join(android,native)));
 assert.throws(()=>prepareAndroidCommonJavaProducer({android,input,framework,output}),/new export directory/);
});
