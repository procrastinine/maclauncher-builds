import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readProjects,resolveProject} from '../lib/projects.mjs';
import {releaseTag} from '../lib/project-identity.mjs';
import {checkProjects,main} from '../tools/check-updates.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('project registry covers every selected package and excludes direct upstream binaries',()=>{
 const registry=readProjects(root),ids=new Set(registry.projects.map(value=>value.id)),packages=JSON.parse(fs.readFileSync(path.join(root,'recipes/included-packages.json'))).packages;
 for(const record of packages)assert.ok(ids.has(record.id));
 assert.equal(ids.size,new Set([...packages.map(value=>value.id),'flash-projector','android-art']).size);
 for(const id of ['butterscotch','mkxpz','java-steamworks'])assert.throws(()=>resolveProject(id,root),/Unknown/);
 assert.equal(resolveProject('android',root).producer.recipe,'runtimes/android/source.json');
 assert.notEqual(releaseTag({id:'engine',version:'a-b-1',arch:'arm64'}),releaseTag({id:'engine-a',version:'b-1',arch:'arm64'}));
});
test('manual update checks keep project identities, reuse source metadata and do not change pins',async()=>{
 const before=fs.readFileSync(path.join(root,'projects.json')),calls=[],revision='1'.repeat(40),upstream={id:'upstream',provider:'github',url:'https://github.com/owner/source',repository:'owner/source',revision};
 const projects=[{id:'one',name:'One',producer:{kind:'maclauncher'},upstreams:[upstream]},{id:'two',name:'Two',producer:{kind:'maclauncher'},upstreams:[upstream]},{id:'helper',name:'Helper',producer:{kind:'maclauncher'},upstreams:[]}];
 const report=await checkProjects(projects,{request:async url=>{calls.push(url);return url.includes('/commits')?[{sha:revision,commit:{message:'Fix native behavior',committer:{date:'2026-10-19T00:00:00Z'}}}]:[{tag_name:'1.0',html_url:'https://github.com/owner/source/releases/tag/1.0',published_at:'2026-10-01T00:00:00Z',body:'Release notes'}];}});
 assert.equal(report.updatePolicy,'manual');assert.deepEqual(report.projects.map(value=>value.projectId),['one','two','helper']);assert.equal(calls.length,2);assert.equal(report.projects[0].upstreams[0].headChanged,false);assert.equal(report.projects[2].status,'owned-source');assert.deepEqual(fs.readFileSync(path.join(root,'projects.json')),before);
 await assert.rejects(main([]),/Select/);await assert.rejects(main(['--project','wrong-project']),/Unknown/);
});
test('upstream checks retain prerelease candidates and report incomplete metadata',async()=>{
 const project={id:'engine',name:'Engine',producer:{kind:'maclauncher'},upstreams:[{id:'source',provider:'github',url:'https://github.com/owner/source',repository:'owner/source',revision:'1'.repeat(40)}]};
 const report=await checkProjects([project],{request:async url=>url.includes('/commits')?[{sha:'2'.repeat(40),commit:{message:'Native fix'}}]:[{tag_name:'2.0-rc1',prerelease:true},{tag_name:'1.9',prerelease:false}]});
 assert.equal(report.projects[0].upstreams[0].release.tag,'2.0-rc1');assert.equal(report.projects[0].upstreams[0].release.prerelease,true);assert.equal(report.projects[0].upstreams[0].stableRelease.tag,'1.9');
 const failed=await checkProjects([project],{request:async()=>{throw Error('Unavailable');},gitHead:async()=>({revision:'2'.repeat(40)})});
 assert.equal(failed.projects[0].status,'incomplete');assert.equal(failed.projects[0].upstreams[0].releaseStatus,'unavailable');
});
