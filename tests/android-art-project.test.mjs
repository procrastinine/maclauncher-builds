import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readProjects,resolveProject} from '../lib/projects.mjs';
import {assetName,releaseTag,assetUrl,validateCatalog} from '../lib/project-identity.mjs';
import {catalog} from '../tools/runtime-package.mjs';
import {buildAndroidArt} from '../tools/build-android-art.mjs';
import {createRequire} from 'node:module';
const requirements=createRequire(import.meta.url)('./support/requirements.cjs');

test('ART inputs belong to the shared Android runtime rather than a separate release project',()=>{
 const registry=readProjects(undefined,{resolvePins:false});
 assert.equal(registry.projects.some(row=>row.id==='android-art'),false);
 const common=registry.projects.find(row=>row.id==='android');
 for(const id of ['android-art-elf','android-art-ffi','android-art-java','android-art-image-extractor'])assert.ok(common.build.inputs.includes(id));
});

test('registered ART builds delegate unchanged inputs to the canonical ART entry',requirements({sourceTree:'sources/maclauncher-android'}),async t=>{
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
 write(path.join(directory,'runtimes/android/source.json'),JSON.stringify({schemaVersion:1,id:'android',gitlink:'sources/maclauncher-android',buildEntry:'tools/build.mjs',checkEntry:'tools/check-sources.mjs'}));
 fs.cpSync(path.join(hub,'tools'),path.join(directory,'tools'),{recursive:true});
 assert.deepEqual(await buildAndroidArt({source:producer,check:true}),{id:'android-art',action:'check'});
 const output=path.join(directory,'output'),inputs=path.join(directory,'inputs.json'),options={output,sources:{source:producer,klepton:producer,glesHeaders:producer,aosp:producer},runner:{precise:{archives:['retained-cpu.a']}},sourceArchive:path.join(directory,'complete-source.tar.gz')};
 write(inputs,JSON.stringify(options));const built=await buildAndroidArt({source:producer,inputs});assert.equal(built.root,options.output);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'observed.json'))),options);
});
