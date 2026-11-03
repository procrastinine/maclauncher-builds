import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Inspect tracked contents, including binary payloads encoded as C/C++ word arrays.
test('tracked source contains no compiled code or archives',()=>{
 const root=path.resolve(import.meta.dirname,'..'),failures=[];
 const signatures=[
  ['Mach-O / Java class',['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca']],
  ['ELF',['7f454c46']],['PE',['4d5a','50450000']],
  ['ZIP / JAR / APK / wheel',['504b0304','504b0506','504b0708']],
  ['DEX',['6465780a','63646578']],['static library',['213c617263683e0a','213c7468696e3e0a']],
  ['COFF object',['4c01','6486','64aa']],
  ['binary XML',['03000800','41425800','62706c6973743030']],
  ['gzip',['1f8b']],['xz',['fd377a585a00']],['7z',['377abcaf271c']],
  ['RPA',['5250412d322e30','5250412d332e30']],['SPIR-V',['03022307','07230203']],
 ].flatMap(([kind,hexes])=>hexes.map(hex=>({kind,magic:Buffer.from(hex,'hex')})));
 for(const file of execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(Boolean)){
  const absolute=path.join(root,file),stat=fs.lstatSync(absolute,{throwIfNoEntry:false});
  if(!stat?.isFile())continue; // Deleted files, Gitlinks and symlinks contain no local payload.
  const bytes=fs.readFileSync(absolute),head=bytes.subarray(0,16);
  // Original artwork and font formats are source assets.
  if(['89504e470d0a1a0a','ffd8ff','474946383761','474946383961','00000100','49492a00','4d4d002a','00010000','4f54544f','74746366','774f4646','774f4632'].some(hex=>head.subarray(0,hex.length/2).equals(Buffer.from(hex,'hex')))||head.subarray(0,2).toString()==='BM'||head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WEBP')continue;
  let kind=signatures.find(({magic})=>head.subarray(0,magic.length).equals(magic))?.kind;
  if(!kind&&head[0]===0x80&&head[1]<=5)kind='pickle';
  if(!kind&&/\.(?:h|hpp|c|cc|cpp|inc)$/.test(file)&&/\{\s*0x07230203[uUlL]*\s*,/.test(bytes.toString('utf8')))kind='embedded SPIR-V';
  if(kind)failures.push(file+' ('+kind+')');
 }
 assert.deepEqual(failures,[],'Compiled code or archives must be built on GitHub or fetched from the original publisher:\n'+failures.join('\n'));
});
