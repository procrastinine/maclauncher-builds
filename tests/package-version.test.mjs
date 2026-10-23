import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {nextPackageVersion,nextSnapshotVersion} from '../lib/package-version.mjs';
import {prepareRelease} from '../tools/release-runtime.mjs';
import {verify} from '../tools/runtime-package.mjs';
import {reversionPackage} from '../tools/reversion-runtime.mjs';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
test('tagged upstream revisions reset for a new exact upstream version',()=>{
 const catalog={packages:[{version:'0.7.7-MCLv3'},{version:'0.7.7-MCLv9'},{version:'0.7.70-MCLv50'}]};
 assert.equal(nextPackageVersion('0.7.7',catalog),'0.7.7-MCLv10');assert.equal(nextPackageVersion('0.7.8',catalog),'0.7.8-MCLv1');
 assert.equal(nextPackageVersion('0.7.7',{packages:[{version:'0.7.7-MCLv3'}]}),'0.7.7-MCLv4');
});
test('commit snapshots increase numerically across December and January',()=>{
 assert.equal(nextSnapshotVersion('2027-01-25T10:00:00Z',{packages:[{version:'MCLv1-1008'},{version:'MCLv9-1231'}]}),'MCLv10-0125');
 assert.equal(nextSnapshotVersion('2026-10-08T12:00:00Z',[]),'MCLv1-1008');assert.equal(nextSnapshotVersion('2026-10-23T21:28:03-07:00',[]),'MCLv1-1024');
 assert.throws(()=>nextSnapshotVersion('2026-10-08',[]),/timestamp/);
});
test('package version rewrite changes only consumed metadata and preserves every runtime byte',async t=>{
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reversion-package-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[{id:'engine',name:'Engine',delivery:'downloadable',producer:{kind:'prebuilt',version:'0.7.7',architectures:['arm64']},upstreams:[]}]}));
 const input=path.join(directory,'input');fs.mkdirSync(input);const manifest=Buffer.from('{"version":"0.7.7-macos-v3","upstreamVersion":"0.7.7","runtimeFiles":{"executable":"engine"}}\n'),native=Buffer.from('unchanged executable identity\0old-embedded-version'),data={'manifest.json':manifest,engine:native,LICENSE:Buffer.from('MIT')};const files=Object.entries(data).map(([file,bytes])=>{fs.writeFileSync(path.join(input,file),bytes,{mode:file==='engine'?0o755:0o644});return{path:file,size:bytes.length,sha256:hash(bytes),mode:file==='engine'?0o755:0o644};});
 const declaration={id:'engine',version:'0.7.7-macos-v3',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',directoryRelative:'engine/0.7.7-macos-v3/arm64',manifestRelative:'manifest.json',manifestSha256:hash(manifest),sourceRelative:'manifest.json',sourceSha256:hash(manifest),files,notices:[{name:'Engine',license:'MIT',path:'LICENSE'}],redistribution:'bundle'};
 const bundle=path.join(directory,'release'),release=await prepareRelease({project:'engine',input,declaration,output:bundle,directory}),record=JSON.parse(fs.readFileSync(path.join(bundle,release.assets.find(a=>a.role==='record').filename))),archive=path.join(bundle,record.asset.filename),before=hash(fs.readFileSync(archive)),output=path.join(directory,'engine-0.7.7-MCLv1-arm64.tar.gz');
 const result=await reversionPackage({archive,record,version:'0.7.7-MCLv1',output});assert.equal(hash(fs.readFileSync(archive)),before);assert.equal(result.manifest.version,'0.7.7-MCLv1');assert.equal(result.manifest.upstreamVersion,'0.7.7');assert.equal(result.declaration.sourceRelative,null);assert.equal(result.record.sourceSha256,declaration.sourceSha256);
 const checked=await verify({archive:output,sha256:result.record.asset.sha256,project:'engine',version:'0.7.7-MCLv1',arch:'arm64',includeDeclaration:true,includeManifest:true});assert.equal(checked.manifest.version,checked.declaration.version);assert.notEqual(checked.declaration.manifestSha256,declaration.manifestSha256);
 for(const file of files.filter(f=>f.path!=='manifest.json'))assert.deepEqual(checked.declaration.files.find(f=>f.path===file.path),file);
 await assert.rejects(reversionPackage({archive,record,version:'0.7.7-MCLv1',output}),/new archive path/);
});
