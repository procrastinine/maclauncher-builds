import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProject} from '../lib/projects.mjs';
import {assetName,releaseTag,assetUrl,validateCatalog} from '../lib/project-identity.mjs';
import {catalog} from '../tools/runtime-package.mjs';
import {main as buildRuntime} from '../tools/build-runtime.mjs';

test('Android ART has its own producer, release identity and catalog without routing to the common JVM build',()=>{
 const common=resolveProject('android'),art=resolveProject('android-art');
 assert.equal(common.producer.kind,'pinned-source');
 assert.equal(common.producer.recipe,'runtimes/android/source.json');
 assert.deepEqual(art.producer,{kind:'maclauncher',repository:'https://github.com/procrastinine/maclauncher',entries:[
  'src/modules/android/art/build.mjs','src/modules/android/art/build-image-extractor.mjs','src/modules/android/art/package.mjs'
 ]});
 assert.throws(()=>buildRuntime(['--project','android-art','--check']),/ART adapter producer is maintained in MacLauncher/);
 const identity={id:art.id,version:'1.2.3-ml1',arch:'arm64'};
 assert.equal(assetName(identity),'android-art-1.2.3-ml1-arm64.tar.gz');
 assert.equal(releaseTag(identity),'android-art/v1.2.3-ml1/arm64');
 assert.notEqual(releaseTag(identity),releaseTag({...identity,id:common.id}));
 assert.equal(assetUrl(identity,art.releaseRepository),'https://github.com/procrastinine/maclauncher-builds/releases/download/android-art%2Fv1.2.3-ml1%2Farm64/android-art-1.2.3-ml1-arm64.tar.gz');
 const record={schemaVersion:2,...identity,minimumMacOS:'13.0',launcherArchitectures:['arm64'],manifestRelative:'runtime.json',
  manifestSha256:'1'.repeat(64),sourceSha256:'2'.repeat(64),updatePolicy:'manual',asset:{filename:assetName(identity),sha256:'3'.repeat(64),bytes:1}};
 const selected=catalog([record],{project:art.id,repository:art.releaseRepository});
 assert.equal(selected.projectId,'android-art');
 assert.equal(selected.packages[0].id,'android-art');
 assert.throws(()=>catalog([record],{project:common.id,repository:common.releaseRepository}),/expected project android/);
 assert.throws(()=>validateCatalog(selected,{project:common.id,repository:common.releaseRepository}),/different project/);
});
