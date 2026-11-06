import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gitSource} from '../producers/steam-bridge/build.mjs';

test('Steam bridge Git inputs depend on their commit, not a licence file or digest map', t => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-git-input-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const git=args=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init']);fs.writeFileSync(path.join(directory,'source.txt'),'source input');
 git(['add','source.txt']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','source']);
 const revision=git(['rev-parse','HEAD']);
 assert.equal(gitSource({path:'sources/input'},revision,directory),directory);
 fs.writeFileSync(path.join(directory,'LICENSE'),'a notice with no hash contract');
 assert.equal(gitSource({path:'sources/input'},revision,directory),directory);
 fs.rmSync(path.join(directory,'LICENSE'));
 assert.equal(gitSource({path:'sources/input'},revision,directory),directory);
 assert.throws(()=>gitSource({path:'sources/input'},'0'.repeat(40),directory),/declared commit/);
});
