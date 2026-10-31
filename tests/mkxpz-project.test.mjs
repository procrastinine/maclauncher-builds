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
test('MKXP-Z uses its owned source recipe and preserves the universal publisher identity',()=>{
 const project=resolveProject('mkxpz',root);
 assert.equal(project.producer.kind,'maclauncher');
 assert.equal(project.producer.repository,'https://github.com/procrastinine/maclauncher-builds');
 assert.deepEqual(project.producer.entries,['producers/maclauncher/scripts/build-mkxpz-nfc.cjs','producers/maclauncher/src/modules/rgss/overlays/mkxpz-filename-nfc/source.json','producers/maclauncher/helper-builds/mkxpz.json']);
 assert.equal(project.upstreams.find(row=>row.id==='sdl2-image').revision,'d3c6d5963dbe438bcae0e2b6f3d7cfea23d02829');
 assert.equal(project.build.version,'MCLv2-1003');assert.equal(project.build.command,'tools/build-mkxpz.mjs');
 assert.deepEqual(project.build.architectures,['arm64']);
 assert.deepEqual(project.packageProfiles.map(row=>row.version),['MCLv1-1003','MCLv2-1003']);
 assert.equal(project.upstreams[0].revision,baseline.upstream.revision);
 assert.equal(baseline.upstream.revision,'37a04d14413454551a7b6aadbb4e93e67168accb');
 assert.equal(baseline.publisherArtifact.inputExecutableSha256,'3514341b5fff5b9410ff58f0e963d435a4ed1c7560008fb20e1a522e0e4a7f1c');
 assert.equal(baseline.executableRelative,'mkxp-z.universal.app/Contents/MacOS/bundle_mkxp-z');
 assert.equal(baseline.arch,'universal');assert.deepEqual(baseline.launcherArchitectures,['arm64','x64']);
 assert.equal(baseline.minimumMacOS,'11.0');assert.equal(baseline.publisherFiles,1083);
 assert.equal(build(['--project','mkxpz','--check']).sourceDirectory,'producers/maclauncher');
});
test('MKXP-Z catalog contains only the current patched Apple Silicon package',()=>{
 const project=resolveProject('mkxpz',root),value=JSON.parse(fs.readFileSync(path.join(root,'catalogs/mkxpz.json')));
 validateCatalog(value,{project:'mkxpz',repository:project.releaseRepository});
 assert.equal(value.packages.length,1);const adapted=value.packages[0];assert.ok(project.packageProfiles.some(profile=>profile.version===adapted.version));
 assert.equal(adapted.arch,'arm64');assert.deepEqual(adapted.launcherArchitectures,['arm64']);
 assert.equal(adapted.minimumMacOS,'11.0');assert.equal(adapted.manifestRelative,'manifest.json');
 assert.throws(()=>catalog([{...adapted,asset:{...adapted.asset,sha256:'0'.repeat(64)}}],
   {project:'mkxpz',repository:project.releaseRepository,previous:value}),/immutable/);
});
test('MKXP-Z configuration helper has a separate source-free binary package',()=>{
 const value=JSON.parse(fs.readFileSync(path.join(root,'catalogs/mkxpz-config-helper.json')));
 const project=resolveProject('mkxpz-config-helper',root);
 validateCatalog(value,{project:'mkxpz-config-helper',repository:project.releaseRepository});
 const helper=value.packages.find(row=>project.packageProfiles.some(profile=>profile.version===row.version));
 assert.ok(helper);assert.equal(helper.arch,'universal');assert.equal(helper.minimumMacOS,'11.0');
});
