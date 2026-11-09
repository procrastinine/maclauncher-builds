import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stageKag3Resources} from '../tools/build-krkrsdl2.mjs';
import {appRequire} from '../tools/app-source.mjs';
import {gitlink} from '../lib/pins.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// The staged resources are sealed as a krkrsdl2 package and read by the pinned launcher's own KAG3 reader.
test('the pinned launcher accepts the packaged KAG3 resources',()=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'kag3-manifest-'));
 try{
  const staged=stageKag3Resources(work),installDir=path.join(work,'install'),payload=path.join(installDir,'project-payload'),files=[];
  const write=(relative,bytes,mode=0o644)=>{
   const target=path.join(payload,'files',relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{mode});fs.chmodSync(target,mode);
   const file={path:relative,size:bytes.length,mode,sha256:hash(bytes)};files.push(file);return file;
  };
  const resources=JSON.parse(fs.readFileSync(path.join(staged,'manifest.json'),'utf8'));
  for(const name of [...Object.keys(resources.files),'manifest.json'])write('share/kag3-polyfill/'+name,fs.readFileSync(path.join(staged,name)));
  const executable=Buffer.alloc(32);executable.writeUInt32LE(0xfeedfacf);executable.writeUInt32LE(process.arch==='arm64'?0x0100000c:0x01000007,4);executable.writeUInt32LE(2,12);
  const binary={...write('krkrsdl2',executable,0o755),architectures:[process.arch==='arm64'?'arm64':'x86_64']};files[files.length-1]=binary;
  const upstreamRevision=gitlink('producers/package-support/src/external/krkrsdl2'),version='kag3-manifest-check';
  const manifest={schemaVersion:1,managerId:'krkrsdl2',version,upstreamRevision,platform:'darwin',arch:process.arch,minimumMacOS:'13.0',
   executableRelative:'krkrsdl2',runtimeFiles:{kag3Manifest:'share/kag3-polyfill/manifest.json'},files,dependencies:[],provenance:{sourceRevision:upstreamRevision},notices:[]};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(payload,'manifest.json'),manifestBytes);
  const install={installDir,version,upstreamRevision,runtimeFiles:{kag3Manifest:'project-payload/files/share/kag3-polyfill/manifest.json'},
   catalogEntry:{projectPackage:{schemaVersion:2,id:'krkrsdl2',version,arch:process.arch,manifestRelative:'manifest.json',manifestSha256:hash(manifestBytes)}}};
  const accepted=appRequire('src/modules/kirikiri/prepare.js').resources(path.join(work,'user'),install);
  assert.equal(accepted.manifest.upstreamRevision,gitlink('producers/vn-adaptations/upstreams/kag3'));
  assert.equal(accepted.root,path.join(payload,'files/share/kag3-polyfill'));
 }finally{fs.rmSync(work,{recursive:true,force:true});}
});
