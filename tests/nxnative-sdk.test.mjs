import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),upstream=path.join(root,'sources/nxnative');
test('generation uses upstream SDK facts for a game with no profile', {skip:!fs.existsSync(path.join(upstream,'dm/games/profile_guess.py'))},()=>{
 const script=`import runpy,struct,sys,tempfile
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
from keyless_input import generation
pg=SimpleNamespace(**runpy.run_path(str(Path(sys.argv[2])/'dm/games/profile_guess.py')))
with tempfile.TemporaryDirectory() as temporary:
 game=Path(temporary); exefs=game/'ExeFS'; exefs.mkdir()
 image=bytearray(4096); struct.pack_into('<I',image,4,0x20); image[0x20:0x24]=b'MOD0'; struct.pack_into('<i',image,0x24,0x20)
 struct.pack_into('<qQqQqQ',image,0x40,6,0x90,5,0x90,0,0)
 header=bytearray(256); header[:4]=b'NSO0'; struct.pack_into('<III',header,0x10,256,0,len(image))
 for at in (0x20,0x30): struct.pack_into('<III',header,at,256+len(image),len(image),0)
 sdk=exefs/'sdk'; sdk.write_bytes(header+image)
 assert generation(game,pg) is None
 image[256:267]=b'spec: Ounce'; sdk.write_bytes(header+image)
 assert generation(game,pg)==2
 sdk.unlink(); assert generation(game,pg) is None
 assert generation(game,None) is None
print('SDK facts pass without a profile')`;
 const output=execFileSync(process.env.PYTHON||'python3',['-I','-B','-c',script,path.join(root,'producers/nxnative/runtime'),upstream],{encoding:'utf8'});
 assert.match(output,/SDK facts pass/);
 assert.equal(fs.existsSync(path.join(root,'producers/nxnative/runtime/platforms.json')),false);
});
