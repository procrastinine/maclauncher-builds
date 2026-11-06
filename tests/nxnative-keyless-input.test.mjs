import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),upstream=path.join(root,'sources/nxnative');
test('keyless input uses upstream NUP/dump readers with generated metadata and safe paths',{skip:!fs.existsSync(path.join(upstream,'scripts/pack_nup.py'))},()=>{
 const script=`import sys,runpy,tempfile,struct,hashlib
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from keyless_input import inspect_keyless
upstream=Path(sys.argv[2]); sys.path.insert(0,str(upstream/'scripts'))
nup=runpy.run_path(str(upstream/'scripts/pack_nup.py'))
with tempfile.TemporaryDirectory() as temporary:
 root=Path(temporary); game=root/'dump'; (game/'base/exefs').mkdir(parents=True); (game/'base/romfs').mkdir()
 title=0x0100000000010000; npdm=bytearray(0x98); npdm[:4]=b'META'; struct.pack_into('<II',npdm,0x70,0x80,24); npdm[0x80:0x84]=b'ACI0'; struct.pack_into('<Q',npdm,0x90,title)
 (game/'base/exefs/main.npdm').write_bytes(npdm)
 facts=inspect_keyless(game,upstream); assert facts['versions']==['v0']; assert facts['keyRequirement']=='none'; assert facts['generation'] is None
 names=b'exefsromfsmain.npdm'; pool=48+64+3*24+80+12; length=pool+len(names); blob=(128+length+15)//16*16
 toc=nup['TOC'].pack(b'TOC'+bytes([1]),1,3,1,pool,len(names),0)
 toc+=nup['PKG'].pack(title,0,1,2,0,0,0,0,0,0,0)
 toc+=nup['DIR'].pack(0,0,0,2,0)+nup['DIR'].pack(0,5,2,1,0)+nup['DIR'].pack(5,5,3,0,0)
 toc+=nup['FILE'].pack(10,9,len(npdm),blob,len(npdm),hashlib.sha256(npdm).digest(),0,0,0)+struct.pack('<III',1,2,3)+names
 header=nup['SUPER'].pack(b'NUP'+bytes([1]),128,0,128,len(toc),hashlib.sha256(toc).digest(),blob,blob+len(npdm),1,0,bytes(16),bytes(32))
 file=root/'generated.nup'; file.write_bytes(header+toc+bytes(blob-128-len(toc))+npdm)
 facts=inspect_keyless(file,upstream); assert facts['titleId']=='0100000000010000'; assert facts['selectedUpdate']=='v0'; assert facts['keyRequirement']=='none'
 file.write_bytes(b'NUP'+bytes([1]))
 try: inspect_keyless(file,upstream); raise AssertionError('truncated NUP accepted')
 except ValueError: pass
 file.unlink(); (game/'base/romfs/escape').symlink_to(root)
 try: inspect_keyless(game,upstream); raise AssertionError('escaping dump accepted')
 except ValueError: pass
 old=root/'older-source'; old.mkdir(); containers=root/'containers'; containers.mkdir(); (containers/'game.nsp').write_bytes(b'PFS0')
 assert inspect_keyless(containers,old) is None
print('NUP and dump input regressions pass')`;
 const output=execFileSync(process.env.PYTHON||'python3',['-I','-B','-c',script,path.join(root,'producers/nxnative/runtime'),upstream],{encoding:'utf8'});assert.match(output,/input regressions pass/);
});
