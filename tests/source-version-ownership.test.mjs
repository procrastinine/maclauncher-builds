import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ownedPackageSource,plainSemanticVersion} from '../lib/source-ownership.mjs';
import {releaseVersion,buildReleaseVersion,outputVersion} from '../lib/package-version.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {androidBuildInputRequirements} from '../tools/android-signed-inputs.mjs';
import {catalog} from '../tools/runtime-package.mjs';
import {assetUrl} from '../lib/project-identity.mjs';
import {catalogFixture,packageRecord,repository} from './helpers/catalog-fixture.mjs';
const root=path.resolve(import.meta.dirname,'..');

test('package versions follow product source ownership, not ownership of a wrapper recipe',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'owned-version-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify({repository:'https://github.com/owner/product'}));
 assert.equal(ownedPackageSource({producer:{kind:'pinned-source',recipe:'source.json'}},'owner/builds',directory),true);
 const derived={producer:{kind:'maclauncher',repository:'https://github.com/owner/builds'},upstreams:[{repository:'upstream/library'}]};
 assert.equal(ownedPackageSource(derived,'owner/builds',directory),false);
 assert.equal(ownedPackageSource({...derived,producer:{...derived.producer,sourceRepository:'https://github.com/owner/product'}},'owner/builds',directory),true);
 for(const value of ['0.2.1-MCL','0.2.1-MCLv1','MCLv2-1101'])assert.equal(plainSemanticVersion(value),false,value);
});

test('owned version suggestions use semantic versions while explicit registered names remain unchanged',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'owned-build-version-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.mkdirSync(path.join(directory,'runtimes/owned-game'),{recursive:true});fs.mkdirSync(path.join(directory,'catalogs'));
 fs.writeFileSync(path.join(directory,'runtimes/owned-game/source.json'),JSON.stringify({repository:'https://github.com/owner/product'}));
 const versions=['0.2.1','0.2.0-MCLv1','0.2.0-MCLv2'];
 const project={id:'owned-game',name:'Owned game',delivery:'downloadable',producer:{kind:'pinned-source',recipe:'runtimes/owned-game/source.json'},upstreams:[],packageProfiles:versions.map(version=>({version,label:version}))};
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[project]}));
 fs.writeFileSync(path.join(directory,'catalogs/owned-game.json'),JSON.stringify({packages:[{version:'0.2.0-MCLv1'}]}));
 assert.equal(buildReleaseVersion('owned-game','0.2.1',directory),'0.2.1');
 assert.equal(buildReleaseVersion('owned-game','0.2.0-MCLv1',directory),'0.2.0-MCLv1');
 assert.equal(releaseVersion('owned-game','0.2.0-MCLv2',directory),'0.2.0-MCLv2');
 assert.equal(buildReleaseVersion('owned-game','0.2.0-MCLv2',directory),'0.2.0-MCLv2');
 assert.equal(outputVersion('owned-game','0.2.0-MCLv2',directory),'0.2.0-MCLv2');

});

test('Android signed input versions are declared independently of publication history',t=>{
 for(const input of androidBuildInputRequirements()){
  const project=resolveProject(input.id,root,{resolvePins:false});
  assert.ok(project.packageProfiles.some(profile=>profile.version===input.version),input.id+' declares its required input version');
  const {value}=catalogFixture(t,input.id,[packageRecord(input.id,{version:input.version})]);
  assert.equal(value.packages[0].version,input.version);
 }
});

test('a new catalog record comes first and earlier records are kept unchanged',t=>{
 const {value:previous}=catalogFixture(t,'android',[packageRecord('android',{version:'0.2.0-MCLv1'})]),old=previous.packages[0];
 const record={...old,version:'0.2.1',asset:{...old.asset,filename:'android-0.2.1-arm64.tar.gz'}};delete record.tag;
 record.asset.url=assetUrl(record,repository);
 const result=catalog([record],{project:'android',repository:repository,previous});
 assert.equal(result.packages[0].version,'0.2.1');assert.deepEqual(result.packages.find(p=>p.version===old.version),old);
});
