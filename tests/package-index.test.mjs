import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {buildIndex,renderIndex} from '../tools/package-index.mjs';
import {catalogIndex} from '../tools/release-runtime.mjs';
import {readProjects} from '../lib/projects.mjs';
import {assetName,releaseTag} from '../lib/project-identity.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('the static browser and JSON use exactly the current catalog packages and immutable names',t=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'package-index-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const result=buildIndex({directory:root,output}),index=JSON.parse(fs.readFileSync(path.join(output,'index.json'))),html=fs.readFileSync(path.join(output,'index.html'),'utf8');
 const published=readProjects(root,{resolvePins:false}).projects.flatMap(project=>{
  const file=path.join(root,'catalogs',project.id+'.json');if(!fs.existsSync(file))return[];
  const catalog=JSON.parse(fs.readFileSync(file));return catalog.packages.length?[{project,packages:catalog.packages}]:[];
 });
 const expected=new Map(published.map(row=>[row.project.id,row])),total=published.reduce((count,row)=>count+row.packages.length,0);
 assert.equal(result.projects,published.length);assert.equal(result.packages,total);
 const committed=JSON.parse(fs.readFileSync(path.join(root,'catalogs/index.json'))),comparable=structuredClone(index);
 // Earlier indexes omit this additive field. Source changes do not publish a
 // replacement catalog; all existing snapshot fields still match exactly.
 for(const project of comparable.projects)for(const release of project.releases){
  const previous=committed.projects.find(row=>row.projectId===project.projectId)?.releases.find(row=>row.version===release.version&&row.arch===release.arch);
  if(previous&&!Object.hasOwn(previous,'launcherArchitectures'))delete release.launcherArchitectures;
 }
 assert.deepEqual(comparable,committed);
 assert.deepEqual(index.projects.map(project=>project.projectId).sort(),[...expected.keys()].sort());
 for(const project of index.projects){
  const supplied=expected.get(project.projectId);assert.equal(project.delivery,supplied.project.delivery);
  assert.equal(project.releases.length,supplied.packages.length);
  assert.deepEqual(project.releases.map(release=>[release.version,release.arch,release.asset]),supplied.packages.map(release=>[release.version,release.arch,release.asset]));
  for(const release of project.releases){const identity={id:project.projectId,...release};assert.equal(release.asset.filename,assetName(identity));assert.equal(release.tag,releaseTag(identity));assert.ok(html.includes('href="'+release.asset.url+'"'));assert.ok(html.includes(release.asset.sha256));}
 }
 assert.equal((html.match(/<tr data-package/g)||[]).length,total);
 for(const delivery of ['downloadable','bundled']){
  const supplied=published.filter(row=>row.project.delivery===delivery);
  assert.equal(index.projects.filter(project=>project.delivery===delivery).length,supplied.length);
  const rows=new RegExp('data-package data-project="[^"\n]+" data-delivery="'+delivery+'"','g');
  assert.equal((html.match(rows)||[]).length,supplied.reduce((count,row)=>count+row.packages.length,0));
 }
 assert.ok(html.includes('Downloadable runtimes and tools'));assert.ok(html.includes('Included components'));assert.ok(html.includes('Core graphics components and internal helpers included in the app.'));
 assert.throws(()=>renderIndex({projects:[{delivery:'unknown'}]}),/delivery classification/);
 for(const project of index.projects){assert.ok(html.includes('id="'+project.projectId+'"'));assert.ok(project.pageUrl.endsWith('/#'+project.projectId));}
 for(const anchor of ['hashlink-1-9','hashlink-1-12','java-steamworks-1-9','java-steamworks-1-10'])assert.ok(html.includes('id="'+anchor+'"'));
 const hashlink19=expected.get('hashlink').project.packageProfiles.find(profile=>profile.anchor==='hashlink-1-9');assert.ok(hashlink19);
 assert.equal(index.projects.find(p=>p.projectId==='hashlink').releases.find(release=>release.version===hashlink19.version).pageUrl,'https://procrastinine.github.io/maclauncher-builds/#hashlink-1-9');
 for(const label of ['HashLink 1.9 ABI','HashLink 1.12 ABI','Steamworks4j 1.9 JNI ABI','Steamworks4j 1.10 JNI ABI'])assert.ok(html.includes(label));
 assert.ok(fs.existsSync(path.join(output,'.nojekyll')));
});
test('package groups, search, keyboard tabs and deep links operate entirely offline',()=>{
 const html=renderIndex({repository:'owner/builds',projects:[]}),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 const row=(textContent,delivery,project)=>({textContent,dataset:{delivery,project},closest(){return this;},scrollIntoView(){this.scrolled=true;}});
 const rows=[row('HashLink 1.9 ABI x64','downloadable','hashlink'),row('HashLink 1.12 ABI x64','downloadable','hashlink'),row('Steamworks4j 1.10 JNI ABI arm64','bundled','java-steamworks')];
 const tab=group=>({dataset:{group},handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},setAttribute(name,value){this[name]=value;},focus(){this.focused=true;}});
 const tabs=[tab('downloadable'),tab('bundled')],panels=tabs.map(tab=>({dataset:{delivery:tab.dataset.group}})),count={},empty={},input={value:'',addEventListener(name,fn){this.onInput=fn;}},location={hash:''},events={};
 vm.runInNewContext(script,{document:{querySelector:selector=>({'#search':input,'#count':count,'#empty':empty})[selector],querySelectorAll:selector=>({'[data-package]':rows,'[role=tab]':tabs,'[data-panel]':panels})[selector],getElementById:id=>({'hashlink-1-12':rows[1],'java-steamworks-1-10':rows[2]})[id]},window:{location,addEventListener(name,fn){events[name]=fn;}},requestAnimationFrame:fn=>fn()});
 assert.deepEqual(panels.map(panel=>panel.hidden),[false,true]);assert.equal(count.textContent,'2 of 2 packages · 1 project');
 input.value='hashlink 1.12 x64';input.onInput();assert.deepEqual(rows.map(row=>row.hidden),[true,false,true]);assert.equal(count.textContent,'1 of 2 packages · 1 project');assert.equal(empty.hidden,true);
 tabs[1].handlers.click();assert.deepEqual(panels.map(panel=>panel.hidden),[true,false]);assert.equal(empty.hidden,false);assert.equal(tabs[1]['aria-selected'],'true');assert.equal(tabs[0].tabIndex,-1);
 input.value='Steamworks4j 1.10';input.onInput();assert.equal(empty.hidden,true);assert.equal(count.textContent,'1 of 1 packages · 1 project');
 let prevented=false;tabs[1].handlers.keydown({key:'ArrowLeft',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(tabs[0].focused,true);assert.deepEqual(panels.map(panel=>panel.hidden),[false,true]);
 location.hash='#java-steamworks-1-10';events.hashchange();assert.equal(input.value,'');assert.deepEqual(panels.map(panel=>panel.hidden),[true,false]);assert.equal(rows[2].scrolled,true);
 location.hash='#hashlink-1-12';events.hashchange();assert.deepEqual(panels.map(panel=>panel.hidden),[false,true]);assert.equal(rows[1].scrolled,true);
 location.hash='#%invalid';assert.doesNotThrow(()=>events.hashchange());
});
test('package names and ABI labels are escaped before rendering public HTML',()=>{
 const index=JSON.parse(fs.readFileSync(path.join(root,'catalogs/index.json')));index.projects[0].name='<script>bad()</script>';index.projects[0].releases[0].profile='ABI <unsafe>';
 const html=renderIndex(index);assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));assert.ok(html.includes('ABI &lt;unsafe&gt;'));assert.equal(html.includes('<script>bad()'),false);
});
test('ABI profile metadata rejects duplicate versions and incomplete labels',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'package-profiles-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const registry=readProjects(root),project=registry.projects.find(p=>p.id==='hashlink');project.packageProfiles[1].version=project.packageProfiles[0].version;fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify(registry));assert.throws(()=>readProjects(directory),/ABI profiles/);
 project.packageProfiles=[{version:'1.9-macos-v2',label:''}];fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify(registry));assert.throws(()=>readProjects(directory),/ABI profiles/);
});

test('each package states its CPU architecture and the Mac CPUs that can run it',()=>{
 const index=catalogIndex(root),html=renderIndex(index);
 for(const project of index.projects)for(const release of project.releases){
  assert.ok(['arm64','x64','universal'].includes(release.arch));
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'catalogs',project.projectId+'.json'))),record=catalog.packages.find(row=>row.version===release.version&&row.arch===release.arch);
  assert.deepEqual(release.launcherArchitectures,record.launcherArchitectures);
  for(const own of release.arch==='universal'?['arm64','x64']:[release.arch])assert.ok(release.launcherArchitectures.includes(own));
 }
 assert.ok(html.includes('Apple Silicon<span class="secondary">arm64 · macOS 13.0+</span>'));
 assert.ok(html.includes('Universal<span class="secondary">arm64 and x64 · macOS'));
 assert.ok(html.includes('Intel<span class="secondary">x64 · macOS 13.0+</span>'));
});
