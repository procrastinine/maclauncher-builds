import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
test('production build inputs contain no pins to a published Builds output',()=>{
 const directory=path.resolve(import.meta.dirname,'..'),findings=[];
 const files=execFileSync('git',['ls-files','-z','--','projects','producers','runtimes','tools'],{cwd:directory,encoding:'utf8'}).split('\0').filter(Boolean);
 for(const file of files){const absolute=path.join(directory,file);if(!fs.statSync(absolute,{throwIfNoEntry:false})?.isFile())continue;const text=fs.readFileSync(absolute,'utf8');
  for(const match of text.matchAll(/attestations\/[a-f0-9]{64}\.json|https:\/\/github\.com\/procrastinine\/maclauncher-builds\/(?:releases\/(?:download|tag)\/[^"'\s]+|actions\/runs\/[0-9]+)/g)){
   const reference=decodeURIComponent(match[0]);if(reference.includes('/releases/download/flash-projector/v35.0.0.60-MCLv1/universal/')||reference.includes('/releases/tag/flash-projector/v35.0.0.60-MCLv1/universal')||reference.includes('/releases/download/upstream-mirrors-1/'))continue;
   findings.push(file+': '+match[0]);
  }
 }
 assert.deepEqual(findings,[],'Specific published package pins: '+findings.length+'\n'+findings.join('\n'));
});
