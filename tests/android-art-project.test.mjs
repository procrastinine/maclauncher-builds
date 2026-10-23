import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readProjects,resolveProject} from '../lib/projects.mjs';
import {assetName,releaseTag,assetUrl,validateCatalog} from '../lib/project-identity.mjs';
import {catalog} from '../tools/runtime-package.mjs';
import {main as buildRuntime} from '../tools/build-runtime.mjs';

test('Android ART has its own producer, release identity and catalog without routing to the common JVM build',()=>{
 const common=resolveProject('android'),art=resolveProject('android-art');
 assert.equal(common.producer.kind,'pinned-source');
 assert.equal(common.producer.recipe,'runtimes/android/source.json');
 assert.deepEqual(art.producer,{kind:'maclauncher',repository:'https://github.com/procrastinine/maclauncher-builds',sourceDirectory:'sources/maclauncher-android',buildEntry:'tools/build-android-art.mjs',sourceProject:'android',entries:[
  'sources/maclauncher-android/tools/build-art.mjs','sources/maclauncher-android/src/modules/android/art/source.mjs','sources/maclauncher-android/src/modules/android/art/build-runner.mjs','sources/maclauncher-android/src/modules/android/art/build.mjs','sources/maclauncher-android/src/modules/android/art/build-image-extractor.mjs','sources/maclauncher-android/src/modules/android/art/package.mjs'
 ]});
 const identity={id:art.id,version:'1.2.3-ml1',arch:'arm64'};
 assert.equal(assetName(identity),'android-art-1.2.3-ml1-arm64.tar.gz');
 assert.equal(releaseTag(identity),'android-art/v1.2.3-ml1/arm64');
 assert.notEqual(releaseTag(identity),releaseTag({...identity,id:common.id}));
 assert.equal(assetUrl(identity,art.releaseRepository),'https://github.com/procrastinine/maclauncher-builds/releases/download/android-art%2Fv1.2.3-ml1%2Farm64/android-art-1.2.3-ml1-arm64.tar.gz');
 const record={schemaVersion:2,...identity,minimumMacOS:'13.0',launcherArchitectures:['arm64'],manifestRelative:'runtime.json',
  manifestSha256:'1'.repeat(64),sourceSha256:'2'.repeat(64),updatePolicy:'manual',asset:{filename:assetName(identity),sha256:'3'.repeat(64),bytes:1}};
 const selected=catalog([record],{project:art.id,repository:art.releaseRepository});
 assert.equal(selected.projectId,'android-art');
 assert.equal(selected.packages[0].id,'android-art');
 assert.throws(()=>catalog([record],{project:common.id,repository:common.releaseRepository}),/expected project android/);
 assert.throws(()=>validateCatalog(selected,{project:common.id,repository:common.releaseRepository}),/different project/);
});

test('registered ART builds delegate unchanged inputs to the canonical ART entry',t=>{
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-art-project-')));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const producer=path.join(directory,'sources/maclauncher-android');
 const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
 for(const entry of ['build.mjs','check-sources.mjs'])write(path.join(producer,'tools',entry),'throw Error("Wrong JVM producer");\n');
 write(path.join(producer,'tools/build-art.mjs'),`import fs from 'node:fs';import path from 'node:path';
 export function buildArtRuntime({inputs,check}){if(check)return {id:'android-art',action:'check'};const options=JSON.parse(fs.readFileSync(inputs));fs.mkdirSync(options.output,{recursive:true});fs.writeFileSync(path.join(options.output,'observed.json'),JSON.stringify(options));return {root:options.output,sourceArchive:options.sourceArchive};}\n`);
 const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 for(const cwd of [producer,directory]){git(cwd,'init','-q');git(cwd,'config','user.name','Build test');git(cwd,'config','user.email','test@example.invalid');}
 git(producer,'add','.');git(producer,'commit','-qm','ART producer fixture');const revision=git(producer,'rev-parse','HEAD');
 git(directory,'update-index','--add','--cacheinfo','160000,'+revision+',sources/maclauncher-android');git(directory,'commit','-qm','Pin source');
 const hub=path.resolve(import.meta.dirname,'..');fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify(readProjects(hub)));
 write(path.join(directory,'runtimes/android/source.json'),JSON.stringify({schemaVersion:1,id:'android',path:'sources/maclauncher-android',revision,buildEntry:'tools/build.mjs',checkEntry:'tools/check-sources.mjs'}));
 write(path.join(directory,'tools/build-android-art.mjs'),fs.readFileSync(path.join(hub,'tools/build-android-art.mjs')));
 assert.deepEqual(buildRuntime(['--project','android-art','--check'],directory),{id:'android-art',revision,action:'check'});
 const output=path.join(directory,'output'),inputs=path.join(directory,'inputs.json'),options={output,sources:{source:producer,klepton:producer,glesHeaders:producer,aosp:producer},runner:{precise:{archives:['retained-cpu.a']}},sourceArchive:path.join(directory,'complete-source.tar.gz')};
 write(inputs,JSON.stringify(options));assert.deepEqual(buildRuntime(['--project','android-art','--inputs',inputs],directory),{id:'android-art',revision,action:'build'});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'observed.json'))),options);
});
