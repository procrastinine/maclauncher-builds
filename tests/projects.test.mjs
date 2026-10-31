import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readProjects,resolveProject} from '../lib/projects.mjs';
import {validateCatalog,releaseTag} from '../lib/project-identity.mjs';
import {checkProjects,main} from '../tools/check-updates.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('project registry covers every selected package and excludes direct upstream binaries',()=>{
 const registry=readProjects(root),ids=new Set(registry.projects.map(value=>value.id));
 const catalogs=fs.readdirSync(path.join(root,'catalogs')).filter(name=>name.endsWith('.json')&&name!=='index.json');
 for(const file of catalogs)assert.ok(ids.has(file.slice(0,-5)),file+' has no registered producer');
 const mpv=resolveProject('mpv',root);assert.equal(mpv.delivery,'downloadable');assert.equal(mpv.producer.sourceDirectory,'producers/mpv-render/v7');assert.equal(mpv.upstreams[0].revision,'41f6a645068483470267271e1d09966ca3b9f413');assert.ok(catalogs.includes('mpv.json'));
 const media=JSON.parse(fs.readFileSync(path.join(root,'catalogs/mpv.json')));assert.equal(media.projectId,'mpv');assert.ok(mpv.packageProfiles.some(value=>value.version==='0.41.0-MCLv7'));assert.ok(mpv.packageProfiles.some(value=>value.version===mpv.build.version));
 for(const file of catalogs){const project=file.slice(0,-5),value=JSON.parse(fs.readFileSync(path.join(root,'catalogs',file)));validateCatalog(value,{project,repository:registry.repository,allowEmpty:Array.isArray(value.packages)&&value.packages.length===0});}
 for(const id of ['nwjs','renpy'])assert.throws(()=>resolveProject(id,root),/Unknown/);
 assert.equal(resolveProject('android',root).producer.recipe,'runtimes/android/source.json');
 assert.notEqual(releaseTag({id:'engine',version:'a-b-1',arch:'arm64'}),releaseTag({id:'engine-a',version:'b-1',arch:'arm64'}));
});
test('manual update checks keep project identities, reuse source metadata and do not change pins',async()=>{
 const registryFiles=['projects.json',...Object.values(JSON.parse(fs.readFileSync(path.join(root,'projects.json'))).registries)],before=registryFiles.map(file=>fs.readFileSync(path.join(root,file))),calls=[],revision='1'.repeat(40),upstream={id:'upstream',provider:'github',url:'https://github.com/owner/source',repository:'owner/source',revision};
 const projects=[{id:'one',name:'One',producer:{kind:'maclauncher'},upstreams:[upstream]},{id:'two',name:'Two',producer:{kind:'maclauncher'},upstreams:[upstream]},{id:'helper',name:'Helper',producer:{kind:'maclauncher'},upstreams:[]}];
 const report=await checkProjects(projects,{request:async url=>{calls.push(url);return url.includes('/commits')?[{sha:revision,commit:{message:'Fix native behavior',committer:{date:'2026-10-19T00:00:00Z'}}}]:[{tag_name:'1.0',html_url:'https://github.com/owner/source/releases/tag/1.0',published_at:'2026-10-01T00:00:00Z',body:'Release notes'}];}});
 assert.equal(report.updatePolicy,'manual');assert.deepEqual(report.projects.map(value=>value.projectId),['one','two','helper']);assert.equal(calls.length,2);assert.equal(report.projects[0].upstreams[0].headChanged,false);assert.equal(report.projects[2].status,'owned-source');assert.deepEqual(registryFiles.map(file=>fs.readFileSync(path.join(root,file))),before);
 await assert.rejects(main([]),/Select/);await assert.rejects(main(['--project','wrong-project']),/Unknown/);
});
test('upstream checks retain prerelease candidates and report incomplete metadata',async()=>{
 const project={id:'engine',name:'Engine',producer:{kind:'maclauncher'},upstreams:[{id:'source',provider:'github',url:'https://github.com/owner/source',repository:'owner/source',revision:'1'.repeat(40)}]};
 const report=await checkProjects([project],{request:async url=>url.includes('/commits')?[{sha:'2'.repeat(40),commit:{message:'Native fix'}}]:[{tag_name:'2.0-rc1',prerelease:true},{tag_name:'1.9',prerelease:false}]});
 assert.equal(report.projects[0].upstreams[0].release.tag,'2.0-rc1');assert.equal(report.projects[0].upstreams[0].release.prerelease,true);assert.equal(report.projects[0].upstreams[0].stableRelease.tag,'1.9');
 const failed=await checkProjects([project],{request:async()=>{throw Error('Unavailable');},gitHead:async()=>({revision:'2'.repeat(40)})});
 assert.equal(failed.projects[0].status,'incomplete');assert.equal(failed.projects[0].upstreams[0].releaseStatus,'unavailable');
});

test('delivery registries classify each project once and preserve a flat project API',t=>{
 const registry=readProjects(root),rawRegistry=readProjects(root,{resolvePins:false}),manifest=JSON.parse(fs.readFileSync(path.join(root,'projects.json')));
 assert.equal(registry.schemaVersion,1);assert.equal(manifest.schemaVersion,2);
 assert.equal(registry.projects.filter(project=>project.delivery==='downloadable').length,39);
 assert.equal(registry.projects.filter(project=>project.delivery==='bundled').length,18);
 assert.equal(resolveProject('mkxpz',root).delivery,'downloadable');assert.equal(resolveProject('reshade',root).delivery,'bundled');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'project-delivery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.mkdirSync(path.join(directory,'projects'));
 for(const file of Object.values(manifest.registries))fs.copyFileSync(path.join(root,file),path.join(directory,file));
 const save=value=>fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify(value));save(manifest);
 assert.deepEqual(readProjects(directory,{resolvePins:false}),rawRegistry);
 save(registry);assert.deepEqual(readProjects(directory),registry);save(manifest);
 const bundled=JSON.parse(fs.readFileSync(path.join(directory,manifest.registries.bundled)));
 bundled.push(JSON.parse(fs.readFileSync(path.join(directory,manifest.registries.downloadable)))[0]);fs.writeFileSync(path.join(directory,manifest.registries.bundled),JSON.stringify(bundled));
 assert.throws(()=>readProjects(directory,{resolvePins:false}),/duplicate project/);
 save({...manifest,registries:{...manifest.registries,bundled:'../outside.json'}});assert.throws(()=>readProjects(directory),/registry path/);
 save({...manifest,registries:{downloadable:manifest.registries.downloadable}});assert.throws(()=>readProjects(directory),/delivery registries/);
 const flat=structuredClone(registry);delete flat.projects[0].delivery;save(flat);assert.throws(()=>readProjects(directory),/delivery classification/);
 flat.projects[0].delivery='optional';save(flat);assert.throws(()=>readProjects(directory),/delivery classification/);
});

test('one version keeps a package for each architecture published for it',()=>{
 const registry=readProjects(root,{resolvePins:false}),catalog=JSON.parse(fs.readFileSync(path.join(root,'catalogs/hashlink.json')));
 const intel=catalog.packages[0];assert.equal(intel.arch,'x64');assert.deepEqual(intel.launcherArchitectures,['arm64','x64']);
 const other=arch=>{const tag=releaseTag({id:'hashlink',version:intel.version,arch}),filename='hashlink-'+intel.version+'-'+arch+'.tar.gz';
  return {...intel,arch,launcherArchitectures:arch==='arm64'?['arm64']:['arm64','x64'],tag,asset:{...intel.asset,filename,url:'https://github.com/'+registry.repository+'/releases/download/'+encodeURIComponent(tag)+'/'+filename}};};
 validateCatalog({...catalog,packages:[intel,other('arm64'),other('universal')]},{project:'hashlink',repository:registry.repository});
 assert.throws(()=>validateCatalog({...catalog,packages:[intel,other('arm64'),other('arm64')]},{project:'hashlink',repository:registry.repository}),/Duplicate/);
});
