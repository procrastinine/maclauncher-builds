import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sourceProvenance} from '../lib/pins.mjs';
import {refreshRuntime} from '../producers/nxnative/refresh-runtime.mjs';
const producer=path.resolve(import.meta.dirname,'../producers/nxnative'),pin=JSON.parse(fs.readFileSync(path.join(producer,'source.json')));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const appleSilicon=process.platform==='darwin'&&process.arch==='arm64';

/** A verified base runtime whose source.json records `origins`. */
function base(t,origins){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nxnative-refresh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(relative,bytes,mode)=>{fs.mkdirSync(path.dirname(path.join(root,relative)),{recursive:true});fs.writeFileSync(path.join(root,relative),bytes);fs.chmodSync(path.join(root,relative),mode);return {path:relative,size:Buffer.byteLength(bytes),mode,sha256:digest(bytes)};};
 const files=[write(pin.output.executableRelative,'host',0o755),write('runtime.json',JSON.stringify({runtimeFiles:{host:pin.output.hostRelative}}),0o644),write('source.json',JSON.stringify(origins),0o644)];
 files[0].architectures=[pin.architecture];
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({schemaVersion:1,managerId:pin.id,version:'MCLv0',upstreamRevision:'0'.repeat(40),platform:'darwin',arch:pin.architecture,minimumMacOS:pin.minimumMacOS,executableRelative:pin.output.executableRelative,files:files.sort((a,b)=>a.path<b.path?-1:1),dependencies:[]}));
 fs.chmodSync(path.join(root,'manifest.json'),0o644);
 return root;
}
const owned=()=>{const visit=(root,prefix)=>fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.name.startsWith('.')?[]:entry.isDirectory()?visit(path.join(root,entry.name),path.posix.join(prefix,entry.name)):[{path:path.posix.join(prefix,entry.name),sha256:digest(fs.readFileSync(path.join(root,entry.name)))}]);return visit(producer,'');};
const fullBuild=calls=>async options=>{calls.push(options);return {fullBuild:options.reason};};

test('a refresh over a base from another source pin runs the full build',{skip:!appleSilicon},async t=>{
 const calls=[],output=path.join(os.tmpdir(),'nxnative-refresh-output-'+process.pid);
 const result=await refreshRuntime({input:base(t,{source:{...sourceProvenance(pin.source),revision:'1'.repeat(40)},producerInputs:owned()}),output,version:'MCLv99',build:fullBuild(calls)});
 assert.equal(calls.length,1);assert.equal(calls[0].output,output);assert.equal(calls[0].version,'MCLv99');
 assert.match(result.fullBuild,/source pin or platform/);assert.equal(fs.existsSync(output),false);
});
test('a refresh after a native producer input changed runs the full build',{skip:!appleSilicon},async t=>{
 const inputs=owned().map(file=>file.path==='dependencies.json'?{...file,sha256:'0'.repeat(64)}:file),calls=[];
 const result=await refreshRuntime({input:base(t,{source:sourceProvenance(pin.source),producerInputs:inputs}),output:path.join(os.tmpdir(),'nxnative-refresh-output-'+process.pid),version:'MCLv99',build:fullBuild(calls)});
 assert.equal(calls.length,1);assert.match(result.fullBuild,/dependencies\.json changed/);
});
test('a refresh after a native producer input was removed runs the full build',{skip:!appleSilicon},async t=>{
 const calls=[],result=await refreshRuntime({input:base(t,{source:sourceProvenance(pin.source),producerInputs:[...owned(),{path:'retired.mjs',sha256:'0'.repeat(64)}]}),output:path.join(os.tmpdir(),'nxnative-refresh-output-'+process.pid),version:'MCLv99',build:fullBuild(calls)});
 assert.equal(calls.length,1);assert.match(result.fullBuild,/retired\.mjs was removed/);
});
