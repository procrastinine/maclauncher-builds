import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';
import {build,main} from '../producers/android-launcher/build.mjs';

test('the launcher compiles against the Java framework build stage, not the Android runtime package',()=>{
 const report=createRecipeBuildReporter()('android-launcher');
 assert.deepEqual(report.inputs,[{id:'android-java-framework'}]);
});

test('the launcher API classpath is an explicit list of absolute class directories or JARs',t=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'android-launcher-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const jdk=path.join(work,'jdk'),output=path.join(work,'output');fs.mkdirSync(jdk);
 for(const classpath of [undefined,[],['relative/classes']])assert.throws(()=>build({jdk,classpath,output}),/absolute class directories or JARs/);
 assert.throws(()=>main(['--jdk',jdk,'--runtime',work,'--output',output]),/Use --jdk, --classpath, --output/);
 assert.equal(fs.existsSync(output),false);
});
