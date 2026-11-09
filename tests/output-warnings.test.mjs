import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('output symptoms warn without rejecting the package',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'output-warnings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'fixtures'));fs.writeFileSync(path.join(root,'a.bin'),'same');fs.writeFileSync(path.join(root,'fixtures/b.bin'),'same');
 fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({version:'1.0'}));
 const declaration=path.join(root,'declaration.json');fs.writeFileSync(declaration,JSON.stringify({version:'2.0',manifestRelative:'runtime.json',files:[{path:'a.bin',sha256:'0'.repeat(64),size:4,mode:0o644},{path:'missing.bin',sha256:'0'.repeat(64),size:0,mode:0o644}]}));
 const result=spawnSync(process.execPath,['tools/output-warnings.mjs',root,'arm64',declaration],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/::warning::.*duplicates/);assert.match(result.stdout,/differs from generated package inventory/);assert.match(result.stdout,/Built metadata version 1.0 differs from package version 2.0/);
});
