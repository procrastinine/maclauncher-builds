import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {importVerifiedRun,main} from '../tools/publish-verified.mjs';

function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'verified-import-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const source='a'.repeat(40),project='engine',version='1.0',buildRun='123',output=path.join(directory,'output');
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[{id:project,name:'Engine',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['tools/build-engine.mjs']},upstreams:[],packageProfiles:[{version,label:'Engine'}],build:{version,command:'tools/build-engine.mjs',architectures:['arm64','x64']}}]}));
 const run={workflowName:'Runtime build',headSha:source,headBranch:'main',status:'completed',jobs:['arm64','x64'].map(arch=>({name:'build (engine 1.0 '+arch+')',status:'completed',conclusion:'success'}))};
 const calls=[],imports=[];
 const runGh=args=>{calls.push(args);if(args[0]==='run'&&args[1]==='view')return JSON.stringify(run);assert.equal(args[1],'download');const destination=args[args.indexOf('--dir')+1],arch=path.basename(destination);fs.writeFileSync(path.join(destination,'engine-1.0-'+arch+'.tar.gz'),'sealed');return '';};
 const verifyBundle=({bundle,project,version,arch})=>{assert.equal(fs.readFileSync(path.join(bundle,'engine-1.0-'+arch+'.tar.gz'),'utf8'),'sealed');return{record:{id:project,version,arch,build:{sourceRevision:source,runId:buildRun},asset:{filename:'engine-1.0-'+arch+'.tar.gz',sha256:(arch==='arm64'?'b':'c').repeat(64)}}};};
 // Cryptographic verification is the existing recordGithubBuild default. These
 // transport cases inject that boundary; no synthetic record is public authority.
 const recordBuild=({record,archive})=>{assert.ok(fs.existsSync(archive));imports.push(record);fs.mkdirSync(path.join(directory,'attestations'),{recursive:true});fs.writeFileSync(path.join(directory,'attestations',record.asset.sha256+'.json'),JSON.stringify({fixture:true,record}));};
 return{directory,source,project,version,buildRun,output,run,calls,imports,runGh,verifyBundle,recordBuild};
}

test('hosted import retains strict verified ledgers and uses the publisher download paths for both CPUs',async t=>{
 const f=fixture(t),rows=await importVerifiedRun(f);
 assert.deepEqual(rows.map(row=>row.arch),['arm64','x64']);assert.equal(f.imports.length,2);
 assert.equal(f.calls.filter(args=>args[1]==='view').length,1);
 assert.equal(f.calls.filter(args=>args[1]==='download').length,2);
 for(const row of rows){
  assert.ok(fs.existsSync(path.join(f.output,'downloads','engine','1.0',row.arch,'engine-1.0-'+row.arch+'.tar.gz')));
  assert.deepEqual(fs.readFileSync(path.join(f.output,'staged-ledgers',row.sha256+'.json')),fs.readFileSync(path.join(f.directory,'attestations',row.sha256+'.json')));
 }
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output,'imported-builds.json'))),rows);
 assert.ok(!fs.existsSync(path.join(f.directory,'catalogs')));
});

test('an unsuccessful selected matrix job refuses before download or ledger writes',async t=>{
 const f=fixture(t);f.run.jobs[1].conclusion='failure';
 await assert.rejects(importVerifiedRun(f),/no successful Runtime build job/);
 assert.equal(f.calls.length,1);assert.equal(f.imports.length,0);assert.ok(!fs.existsSync(f.output));
});

test('archive metadata from another source or run cannot enter the ledger',async t=>{
 const f=fixture(t),verify=f.verifyBundle;
 f.verifyBundle=options=>{const value=verify(options);value.record.build.runId='999';return value;};
 await assert.rejects(importVerifiedRun(f),/different source or build run/);
 assert.equal(f.imports.length,0);assert.ok(!fs.existsSync(path.join(f.output,'staged-ledgers')));
});

test('signature verification failure never produces a staged ledger',async t=>{
 const f=fixture(t);f.recordBuild=()=>{throw Error('Invalid signed evidence');};
 await assert.rejects(importVerifiedRun(f),/Invalid signed evidence/);
 assert.ok(!fs.existsSync(path.join(f.output,'staged-ledgers')));
});

test('publication CLI remains GitHub-only before build-run transport',()=>{
 assert.throws(()=>main(['--output','/tmp/output','--build-run','123','--project','engine','--version','1.0'],{env:{}}),/only by the Runtime release workflow/);
});
