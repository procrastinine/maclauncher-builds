import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyProducer,main} from '../tools/build-runtime.mjs';

test('producer routing never substitutes Android for a different project',()=>{
 assert.throws(()=>main(['--project','fna','--check']),/FNA game host producer is maintained in MacLauncher/);
 assert.throws(()=>main(['--project','flash-projector','--check']),/retains its supplied binary/);
 assert.throws(()=>main(['--project','not-registered','--check']),/Unknown build project/);
 assert.throws(()=>main(['--project','android','--runtime','fna','--check']),/Select one project/);
});

test('runtime builds require the exact clean source commit recorded by the hub',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-producer-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'sources/android');fs.mkdirSync(path.join(source,'tools'),{recursive:true});
 const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(source,'init','-q');git(source,'config','user.name','Build test');git(source,'config','user.email','test@example.invalid');
 for(const entry of ['build.mjs','check-sources.mjs'])fs.writeFileSync(path.join(source,'tools',entry),'export {};\n');
 git(source,'add','tools');git(source,'commit','-qm','Runtime source');const revision=git(source,'rev-parse','HEAD');
 git(root,'init','-q');git(root,'config','user.name','Build test');git(root,'config','user.email','test@example.invalid');
 git(root,'update-index','--add','--cacheinfo',`160000,${revision},sources/android`);git(root,'commit','-qm','Pin producer');
 const recipe={schemaVersion:1,id:'android',revision,path:'sources/android',buildEntry:'tools/build.mjs',checkEntry:'tools/check-sources.mjs'};
 assert.equal(verifyProducer(root,recipe),source);
 assert.throws(()=>verifyProducer(root,{...recipe,revision:'0'.repeat(40)}),/pinned/);
 fs.appendFileSync(path.join(source,'tools/build.mjs'),'// changed\n');assert.throws(()=>verifyProducer(root,recipe),/local changes/);
});
