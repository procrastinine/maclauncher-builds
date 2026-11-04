import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const build=fileURLToPath(new URL('../producers/maclauncher/src/modules/shared/reshade/neural/native/build.sh',import.meta.url));
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'neural-projection-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const native=path.join(root,'projection/src/modules/shared/reshade/neural/native'),bin=path.join(root,'bin');
 fs.mkdirSync(native,{recursive:true});fs.mkdirSync(bin);
 fs.copyFileSync(build,path.join(native,'build.sh'));
 fs.writeFileSync(path.join(bin,'swift'),'#!/bin/bash\nprintf "%s" "$MACLAUNCHER_MLX_DLSS_SOURCE" > "$OBSERVED_SOURCE"\nexit 42\n',{mode:0o755});
 return {root,native,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,
  MACLAUNCHER_MLX_DLSS_SOURCE:path.join(root,'input'),MACLAUNCHER_NEURAL_BUILD_ROOT:path.join(root,'build'),
  MACLAUNCHER_NEURAL_CACHE_ROOT:path.join(root,'cache'),CLANG_MODULE_CACHE_PATH:path.join(root,'clang'),
  SWIFTPM_MODULECACHE_OVERRIDE:path.join(root,'swift'),OBSERVED_SOURCE:path.join(root,'observed')}};
}
test('copied neural recipe prepares sources through its canonical helper before Swift',t=>{
 const {root,native,env}=fixture(t),helper=path.join(root,'canonical.mjs'),prepared=path.join(root,'prepared source');
 fs.writeFileSync(helper,`console.log(${JSON.stringify(prepared)});\n`);
 const result=spawnSync('/bin/bash',[path.join(native,'build.sh')],{env:{...env,MACLAUNCHER_NEURAL_PREPARE_UPSTREAM:helper},encoding:'utf8'});
 assert.equal(result.status,42,result.stderr);
 assert.equal(fs.readFileSync(env.OBSERVED_SOURCE,'utf8'),prepared);
});
test('source preparation failure stops the copied recipe before Swift',t=>{
 const {root,native,env}=fixture(t),helper=path.join(root,'canonical.mjs');
 fs.writeFileSync(helper,'process.exit(23);\n');
 const result=spawnSync('/bin/bash',[path.join(native,'build.sh')],{env:{...env,MACLAUNCHER_NEURAL_PREPARE_UPSTREAM:helper},encoding:'utf8'});
 assert.equal(result.status,23,result.stderr);
 assert.equal(fs.existsSync(env.OBSERVED_SOURCE),false);
});
