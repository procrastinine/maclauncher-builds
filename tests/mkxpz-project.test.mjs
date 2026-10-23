import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {resolveProject} from '../lib/projects.mjs';
import {main as build} from '../tools/build-runtime.mjs';
import {catalog} from '../tools/runtime-package.mjs';
import {validateCatalog} from '../lib/project-identity.mjs';
const root=path.resolve(import.meta.dirname,'..');
const baseline=JSON.parse(fs.readFileSync(path.join(root,'runtimes/mkxpz/baseline.json')));
const adaptedVersion=baseline.version+'-nfc1-arm64';
test('MKXP-Z uses its owned source recipe and preserves the universal publisher identity',()=>{
 const project=resolveProject('mkxpz',root);
 assert.equal(project.producer.kind,'maclauncher');
 assert.equal(project.producer.repository,'https://github.com/procrastinine/maclauncher-builds');
 assert.deepEqual(project.producer.entries,['producers/maclauncher/scripts/build-mkxpz-nfc.cjs','producers/maclauncher/src/modules/rgss/overlays/mkxpz-filename-nfc/source.json']);
 assert.equal(project.upstreams[0].revision,baseline.upstream.revision);
 assert.equal(baseline.upstream.revision,'37a04d14413454551a7b6aadbb4e93e67168accb');
 assert.equal(baseline.publisherArtifact.inputExecutableSha256,'3514341b5fff5b9410ff58f0e963d435a4ed1c7560008fb20e1a522e0e4a7f1c');
 assert.equal(baseline.executableRelative,'mkxp-z.universal.app/Contents/MacOS/bundle_mkxp-z');
 assert.equal(baseline.arch,'universal');assert.deepEqual(baseline.launcherArchitectures,['arm64','x64']);
 assert.equal(baseline.minimumMacOS,'11.0');assert.equal(baseline.publisherFiles,1083);
 assert.equal(build(['--project','mkxpz','--check']).sourceDirectory,'producers/maclauncher');
});
test('MKXP-Z catalog keeps adapted and publisher releases immutable and separately selectable',()=>{
 const project=resolveProject('mkxpz',root),value=JSON.parse(fs.readFileSync(path.join(root,'catalogs/mkxpz.json')));
 validateCatalog(value,{project:'mkxpz',repository:project.releaseRepository});
 const original=value.packages.find(item=>item.version===baseline.version&&item.arch==='universal'),adapted=value.packages.find(item=>item.version===adaptedVersion);
 assert.ok(original);assert.ok(adapted);
 assert.equal(original.arch,'universal');assert.deepEqual(original.launcherArchitectures,baseline.launcherArchitectures);
 assert.equal(original.sourceSha256,original.manifestSha256);
 assert.equal(original.asset.sha256,'85b3251bffff93f4224765c9b3f6095bf1521d06729270c78edb73fce220d509');
 assert.equal(adapted.arch,'arm64');assert.deepEqual(adapted.launcherArchitectures,['arm64']);
 assert.equal(adapted.minimumMacOS,'11.0');assert.equal(adapted.manifestRelative,'manifest.json');
 assert.notEqual(adapted.sourceSha256,original.sourceSha256);
 for(const record of [original,adapted])assert.throws(()=>catalog([{...record,asset:{...record.asset,sha256:'0'.repeat(64)}}],
   {project:'mkxpz',repository:project.releaseRepository,previous:value}),/immutable/);
});
test('MKXP-Z configuration helper has a separate source-free binary package',()=>{
 const value=JSON.parse(fs.readFileSync(path.join(root,'catalogs/mkxpz-config-helper.json')));
 validateCatalog(value,{project:'mkxpz-config-helper',repository:resolveProject('mkxpz-config-helper',root).releaseRepository});
 const helper=value.packages.find(row=>row.version==='config-identity-v7-universal-content1');
 assert.ok(helper);assert.equal(helper.arch,'universal');assert.equal(helper.minimumMacOS,'11.0');
});
