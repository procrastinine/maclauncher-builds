import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {buildIndex,renderIndex} from '../tools/package-index.mjs';
import {readProjects} from '../lib/projects.mjs';
import {assetName,releaseTag} from '../lib/project-identity.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('the static browser and JSON use exactly the current catalog packages and immutable names',t=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'package-index-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const result=buildIndex({directory:root,output}),index=JSON.parse(fs.readFileSync(path.join(output,'index.json'))),html=fs.readFileSync(path.join(output,'index.html'),'utf8');
 assert.equal(result.projects,35);assert.equal(result.packages,37);assert.deepEqual(index,JSON.parse(fs.readFileSync(path.join(root,'catalogs/index.json'))));
 for(const project of index.projects){
  assert.equal(project.releases.length,['hashlink','java-steamworks'].includes(project.projectId)?2:1);
  for(const release of project.releases){const identity={id:project.projectId,...release};assert.equal(release.asset.filename,assetName(identity));assert.equal(release.tag,releaseTag(identity));assert.ok(html.includes('href="'+release.asset.url+'"'));assert.ok(html.includes(release.asset.sha256));}
 }
 assert.equal((html.match(/<tr data-package/g)||[]).length,37);
 assert.equal(index.projects.filter(project=>project.delivery==='downloadable').length,25);assert.equal(index.projects.filter(project=>project.delivery==='bundled').length,10);
 assert.equal((html.match(/data-package data-project="[^"]+" data-delivery="downloadable"/g)||[]).length,26);assert.equal((html.match(/data-package data-project="[^"]+" data-delivery="bundled"/g)||[]).length,11);
 assert.ok(html.includes('Downloadable runtimes and tools'));assert.ok(html.includes('Included components'));assert.ok(html.includes('Bundled with MacLauncher for offline use. No separate installation or setup.'));
 assert.throws(()=>renderIndex({projects:[{delivery:'unknown'}]}),/delivery classification/);
 for(const project of index.projects){assert.ok(html.includes('id="'+project.projectId+'"'));assert.ok(project.pageUrl.endsWith('/#'+project.projectId));}
 for(const anchor of ['hashlink-1-9','hashlink-1-12','java-steamworks-1-9','java-steamworks-1-10'])assert.ok(html.includes('id="'+anchor+'"'));
 assert.equal(index.projects.find(p=>p.projectId==='hashlink').releases[0].pageUrl,'https://procrastinine.github.io/maclauncher-builds/#hashlink-1-9');
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
