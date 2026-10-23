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
 for(const project of index.projects){assert.ok(html.includes('id="'+project.projectId+'"'));assert.ok(project.pageUrl.endsWith('/#'+project.projectId));}
 for(const anchor of ['hashlink-1-9','hashlink-1-12','java-steamworks-1-9','java-steamworks-1-10'])assert.ok(html.includes('id="'+anchor+'"'));
 assert.equal(index.projects.find(p=>p.projectId==='hashlink').releases[0].pageUrl,'https://procrastinine.github.io/maclauncher-builds/#hashlink-1-9');
 for(const label of ['HashLink 1.9 ABI','HashLink 1.12 ABI','Steamworks4j 1.9 JNI ABI','Steamworks4j 1.10 JNI ABI'])assert.ok(html.includes(label));
 assert.ok(fs.existsSync(path.join(output,'.nojekyll')));
});
test('browser search combines runtime, ABI and architecture terms without any network request',()=>{
 const index={repository:'owner/builds',projects:[]},html=renderIndex(index),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 const rows=[{textContent:'HashLink 1.9 ABI x64'},{textContent:'HashLink 1.12 ABI x64'},{textContent:'FNA arm64'}],count={},empty={},input={addEventListener(name,fn){this.onInput=fn;}};
 vm.runInNewContext(script,{document:{querySelector:selector=>({'#search':input,'#count':count,'#empty':empty})[selector],querySelectorAll:()=>rows}});
 input.value='hashlink 1.12 x64';input.onInput();assert.deepEqual(rows.map(row=>row.hidden),[true,false,true]);assert.equal(count.textContent,'1 of 3 packages');assert.equal(empty.hidden,true);
 input.value='unavailable';input.onInput();assert.equal(empty.hidden,false);
 input.value='';input.onInput();assert.deepEqual(rows.map(row=>row.hidden),[false,false,false]);
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
