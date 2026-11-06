import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {compilerPath} from '../producers/steam-bridge/build.mjs';
test('the bridge discovers bison from the caller PATH',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-bison-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'bison'),'#!/bin/sh\nprintf caller-bison\n',{mode:0o755});
 assert.equal(execFileSync('/usr/bin/env',['bison'],{env:{PATH:compilerPath(path.join(root,'compiler'),root)},encoding:'utf8'}),'caller-bison');
});
