import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {runAction}=createRequire(import.meta.url)('../tools/network-action.cjs');
test('pinned actions use the shared retry policy and preserve action inputs and runtime environment',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'network-action-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const workspace=path.join(directory,'work','repo'),revision='a'.repeat(40),action=path.join(directory,'work','_actions','owner','action',revision),state=path.join(directory,'attempts');
 fs.mkdirSync(action,{recursive:true});fs.mkdirSync(workspace,{recursive:true});
 fs.writeFileSync(path.join(action,'action.yml'),'inputs:\n  defaulted:\n    default: true\nruns:\n  using: node24\n  main: main.cjs\n');
 fs.writeFileSync(path.join(action,'main.cjs'),`const fs=require('node:fs'),file=${JSON.stringify(state)};const attempts=fs.existsSync(file)?Number(fs.readFileSync(file)):0;fs.writeFileSync(file,String(attempts+1));if(attempts<2){console.error('fulcio.sigstore.dev ENOTFOUND');process.exitCode=1;}else{require('node:assert/strict').equal(process.env.INPUT_SUBJECT,'archive.tar.gz');require('node:assert/strict').equal(process.env.INPUT_DEFAULTED,'true');require('node:assert/strict').equal(process.env.ACTIONS_RUNTIME_TOKEN,'runtime-token');}`);
 const delays=[];await runAction({environment:{...process.env,RUNNER_WORKSPACE:workspace,INPUT_ACTION:'owner/action@'+revision,INPUT_INPUTS:JSON.stringify({subject:'archive.tar.gz'}),ACTIONS_RUNTIME_TOKEN:'runtime-token'},wait:async delay=>delays.push(delay)});
 assert.equal(fs.readFileSync(state,'utf8'),'3');assert.deepEqual(delays,[5000,10000]);
});
