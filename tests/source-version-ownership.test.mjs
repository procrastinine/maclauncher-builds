import VersionOrder from '../lib/version-order.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ownedPackageSource,plainSemanticVersion} from '../lib/source-ownership.mjs';
import {nextPackageVersion,nextSnapshotVersion,releaseVersion,buildReleaseVersion,outputVersion} from '../lib/package-version.mjs';
import {resolveProject} from '../lib/projects.mjs';
import {androidBuildInputRequirements} from '../tools/android-signed-inputs.mjs';
import {catalog} from '../tools/runtime-package.mjs';
import {assetUrl} from '../lib/project-identity.mjs';
const root=path.resolve(import.meta.dirname,'..');

test('package versions follow product source ownership, not ownership of a wrapper recipe',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'owned-version-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify({repository:'https://github.com/owner/product'}));
 assert.equal(ownedPackageSource({producer:{kind:'pinned-source',recipe:'source.json'}},'owner/builds',directory),true);
 const derived={producer:{kind:'maclauncher',repository:'https://github.com/owner/builds'},upstreams:[{repository:'upstream/library'}]};
 assert.equal(ownedPackageSource(derived,'owner/builds',directory),false);
 assert.equal(ownedPackageSource({...derived,producer:{...derived.producer,sourceRepository:'https://github.com/owner/product'}},'owner/builds',directory),true);
 assert.equal(nextPackageVersion('0.2.0',[{version:'0.2.0-MCLv1'}],{sourceRepository:'https://github.com/owner/product',releaseRepository:'owner/builds'}),'0.2.1');
 assert.equal(nextPackageVersion('3.0.0',{packages:[{version:'legacy-label'}],versionSemantics:{'legacy-label':'3.0.0'}},{sourceRepository:'owner/product',releaseRepository:'owner/builds'}),'3.0.1');
 assert.equal(nextPackageVersion('0.2.0',[],{sourceRepository:'upstream/product',releaseRepository:'owner/builds'}),'0.2.0-MCLv1');
 for(const value of ['0.2.1-MCL','0.2.1-MCLv1','MCLv2-1101'])assert.equal(plainSemanticVersion(value),false,value);
 assert.throws(()=>nextSnapshotVersion('2026-11-01T00:00:00Z',[],{sourceRepository:'owner/product',releaseRepository:'owner/builds'}),/plain semantic version/);
});

test('new owned builds require semantic versions while published MCL identities still resolve',t=>{
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
 assert.throws(()=>buildReleaseVersion('owned-game','0.2.0-MCLv2',directory),/plain semantic version/);
 assert.throws(()=>outputVersion('owned-game','0.2.0-MCLv2',directory),/plain semantic version/);
 assert.throws(()=>catalog([{version:'0.2.0-MCLv2'}],{project:'owned-game',repository:'owner/builds',directory}),/plain semantic version/);
});

test('all existing Android signed input leaves retain their upstream-derived version scheme',()=>{
 for(const input of androidBuildInputRequirements()){
  const project=resolveProject(input.id,root,{resolvePins:false});
  assert.equal(ownedPackageSource(project,project.releaseRepository,root),false,input.id);
  assert.equal(input.version,'0.1.0-MCLv1');
 }
});

test('the ordinary Builds catalog places 0.2.1 before 0.2.0-MCLv1 and preserves the old record',()=>{
 const previous=JSON.parse(fs.readFileSync(path.join(root,'catalogs/android.json'))),old=previous.packages.find(p=>p.version==='0.2.0-MCLv1');
 const record={...old,version:'0.2.1',asset:{...old.asset,filename:'android-0.2.1-arm64.tar.gz'}};delete record.tag;
 record.asset.url=assetUrl(record,'procrastinine/maclauncher-builds');
 const result=catalog([record],{project:'android',repository:'procrastinine/maclauncher-builds',previous});
 assert.equal(result.packages[0].version,'0.2.1');assert.deepEqual(result.packages.find(p=>p.version===old.version),old);
});


test('catalog ordering uses declared semantic versions for every legacy label',()=>{
 const previous=JSON.parse(fs.readFileSync(path.join(root,'catalogs/gamemaker-opengl-helper.json'))),old=previous.packages[0];
 const next={...old,version:'3.0.1',asset:{...old.asset,filename:'gamemaker-opengl-helper-3.0.1-universal.tar.gz'}};delete next.tag;
 next.asset.url=assetUrl(next,'procrastinine/maclauncher-builds');
 const result=catalog([next],{project:old.id,repository:'procrastinine/maclauncher-builds',previous});
 assert.equal(result.versionSemantics[old.version],'3.0.0');
 assert.equal(result.packages[0].version,'3.0.1');assert.deepEqual(result.packages.find(p=>p.version===old.version),old);
 for(let a=0;a<result.packages.length;a++)for(let b=a+1;b<result.packages.length;b++)
  assert.ok(VersionOrder.compareRuntimeVersions(result.packages[a],result.packages[b],result.versionSemantics)<=0);
 assert.throws(()=>VersionOrder.versionSemantics({'legacy-label':'not-semver'}),/semantic versions/);
});
