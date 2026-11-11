import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {packageChanges} from '../tools/package-changes.mjs';
import {buildRecord} from '../lib/projects.mjs';

test('tag history records pin changes, scoped recipe commits, optional notes and first releases deterministically',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'package-changes-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2026-11-01T12:00:00Z',GIT_COMMITTER_DATE:'2026-11-01T12:00:00Z'}}).trim();
 git('init','-q');git('config','user.name','procrastinine');git('config','user.email','24549552+procrastinine@users.noreply.github.com');
 const project={id:'demo',producer:{entries:['recipe.mjs','source.json']},upstreams:[{id:'demo-source',url:'https://example.invalid/demo',pin:{file:'source.json',pointer:''}}],build:{version:'1.0.0',notes:'Initial package.'}};
 const registry=()=>fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,projects:[project]}));
 registry();fs.writeFileSync(path.join(directory,'recipe.mjs'),'// first\n');fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify({revision:'1'.repeat(40),version:'1.0'}));git('add','.');git('commit','-qm','Initial recipe');git('tag','demo/v1.0.0/arm64');
 project.build={version:'1.1.0',notes:'Updated source.'};registry();fs.writeFileSync(path.join(directory,'recipe.mjs'),'// updated\n');fs.writeFileSync(path.join(directory,'source.json'),JSON.stringify({revision:'2'.repeat(40),version:'1.1'}));git('add','.');git('commit','-qm','Update demo recipe');git('tag','demo/v1.1.0/arm64');git('tag','demo/v1.1.0/x64');
 project.build={version:'1.2.0'};registry();fs.writeFileSync(path.join(directory,'unrelated.txt'),'unrelated');git('add','.');git('commit','-qm','Unrelated change');git('tag','demo/v1.2.0/arm64');
 project.build={version:'1.3.0'};registry();git('add','.');git('commit','-qm','Register catalog-only version');
 const sourceRevision=git('rev-parse','HEAD');fs.mkdirSync(path.join(directory,'catalogs'));fs.writeFileSync(path.join(directory,'catalogs/demo.json'),JSON.stringify({packages:[{version:'1.3.0',build:{sourceRevision}}]}));
 const options={directory,projects:[{projectId:'demo'}]},result=packageChanges(options),[first,second,third,fourth]=result.projects[0].releases;
 assert.equal(first.previousVersion,null);assert.deepEqual(first.commits,[]);assert.ok(first.pins.every(pin=>pin.before===null));assert.equal(first.notes,'Initial package.');
 assert.equal(second.previousVersion,'1.0.0');assert.equal(second.tags.length,2);assert.deepEqual(second.versionSources,['tags']);assert.equal(second.notes,'Updated source.');assert.deepEqual(second.commits.map(row=>row.subject),['Update demo recipe']);
 const pin=second.pins.find(pin=>pin.input==='upstream:demo-source');assert.equal(pin.before.revision,'1'.repeat(40));assert.equal(pin.after.revision,'2'.repeat(40));
 assert.equal(third.previousVersion,'1.1.0');assert.equal(Object.hasOwn(third,'notes'),false);assert.deepEqual(third.commits,[]);assert.deepEqual(third.pins,[]);
 assert.equal(fourth.version,'1.3.0');assert.deepEqual(fourth.tags,[]);assert.deepEqual(fourth.versionSources,['catalog']);
 assert.equal(JSON.stringify(result),JSON.stringify(packageChanges(options)));
});

test('build notes accept one nonempty line',()=>{
 const project={producer:{kind:'maclauncher'},packageProfiles:[{version:'1.0.0'}],build:{version:'1.0.0',command:'tools/build.mjs',architectures:['arm64'],notes:'A source update.'}};
 assert.equal(buildRecord(project).notes,'A source update.');
 for(const notes of ['',42,'a\nb'])assert.throws(()=>buildRecord({...project,build:{...project.build,notes}}),/notes/);
});

test('legacy literal exports and catalog tuples resolve without executing producer code',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'package-changes-legacy-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8'}).trim();git('init','-q');git('config','user.name','procrastinine');git('config','user.email','24549552+procrastinine@users.noreply.github.com');
 fs.writeFileSync(path.join(directory,'source.js'),`throw Error('Producer code must never execute');\nconst REVISION = '${'a'.repeat(40)}';\nconst DEPENDENCIES = {'nested-library':'${'b'.repeat(40)}'};\nconst RELEASES = [["1.16", "${'c'.repeat(40)}"]];\nconst LINK_REVISION = gitlink('vendor/source');`);
 const pins=[{pointer:'/REVISION'},{pointer:'/DEPENDENCIES/nested-library'},{pointer:'/core/catalog',match:{version:'1.16'},field:'/upstreamRevision'},{pointer:'/LINK_REVISION'}];
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({projects:[{id:'legacy',producer:{entries:['source.js']},upstreams:pins.map((pin,i)=>({id:String(i),url:'https://example.invalid/source',pin:{file:'source.js',...pin}}))}]}));git('add','.');git('update-index','--add','--cacheinfo','160000,'+'d'.repeat(40)+',vendor/source');git('commit','-qm','Literal sources');git('tag','legacy/v1.0.0/arm64');
 const entry=packageChanges({directory,projects:[{projectId:'legacy'}]}).projects[0].releases[0];
 assert.equal(entry.unavailableInputs,undefined);assert.deepEqual(entry.pins.map(pin=>pin.after.revision),['a'.repeat(40),'b'.repeat(40),'c'.repeat(40),'d'.repeat(40)]);
});
