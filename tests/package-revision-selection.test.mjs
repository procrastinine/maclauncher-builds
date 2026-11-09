import test from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';
import{createRequire}from'node:module';
import{javaSteamworksProfile}from'../tools/build-java-steamworks.mjs';
const require=createRequire(import.meta.url),producer=require('../producers/package-support/scripts/build-mkxpz-nfc.cjs');
const originals=JSON.parse(fs.readFileSync(new URL('../producers/package-support/src/modules/java/runtime/steamworks/publisher-releases.json',import.meta.url)));
test('new Steamworks package revisions retain the exact original ABI source and publisher pins',()=>{
 for(const base of ['1.9.0','1.10.0'])for(const revision of [1,3,42]){
  const selected=javaSteamworksProfile(base+'-MCLv'+revision),original=originals.find(row=>row.version===base);
  assert.deepEqual(selected,original);assert.equal(selected.sourceRevision,original.sourceRevision);assert.equal(selected.publisherJarSha256,original.publisherJarSha256);
 }
});
test('Steamworks rejects unknown upstream profiles and malformed revisions before acquisition',()=>{
 for(const version of ['1.11.0-MCLv3','1.9.0-MCLv0','1.9.0','1.9.0-MCLv3/other'])assert.throws(()=>javaSteamworksProfile(version),/no ABI release/);
});
const args=['--work','/work','--archive','/source.tar.gz','--meson','/tools/meson','--ninja','/tools/ninja','--output','/output'];
test('MKXP CLI passes an explicit package version independently of its pinned upstream source',()=>{
 for(const version of ['MCLv3-1003','2.4.2-MCLv3','2.4.2-MCLv42']){
  assert.equal(producer.parseInputs([...args,'--version',version]).version,version);
  assert.equal(producer.packageVersion(version),version);
 }
 assert.equal(producer.SOURCE_SHA256,'364394e8cb3089b1f5adb12a4ab524770e743bf3973ec53e8f411ba5e11886d6');
});
test('MKXP refuses missing, repeated or path-shaped package versions before touching source inputs',()=>{
 assert.throws(()=>producer.parseInputs(args),/package version/);
 assert.throws(()=>producer.parseInputs([...args,'--version','2.4.2-MCLv3','--version','2.4.2-MCLv4']),/explicit/);
 for(const version of ['','../other','version/other','x y'])assert.throws(()=>producer.packageVersion(version),/explicit MKXP-Z package version/);
});
