import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {buildIndex,renderIndex} from '../tools/package-index.mjs';
import {buildCoverage,currentBuildOutputs} from '../tools/build-coverage.mjs';
import {readProjects} from '../lib/projects.mjs';
import {assetName,releaseTag} from '../lib/project-identity.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('coverage selects the newest packaging revision per version line and CPU',()=>{
 const versions=['1.0-MCLv1','1.0-MCLv2','1.0-MCLv10','2.0-MCLv1'];
 const project={producer:{kind:'maclauncher'},packageProfiles:versions.map(version=>({version})),build:versions.map(version=>({version,command:'tools/build.mjs',architectures:version==='1.0-MCLv10'?['arm64']:['universal']}))};
 assert.deepEqual(currentBuildOutputs(project),[{version:'1.0-MCLv10',arch:'arm64'},{version:'1.0-MCLv2',arch:'universal'},{version:'2.0-MCLv1',arch:'universal'}]);
 project.build=[{version:'1.0-MCLv1',command:'tools/build.mjs',architectures:['arm64','x64']},{version:'1.0-MCLv2',command:'tools/build.mjs',architectures:['arm64']}];
 assert.deepEqual(currentBuildOutputs(project),[{version:'1.0-MCLv2',arch:'arm64'},{version:'1.0-MCLv1',arch:'x64'}]);
});
test('a project builds on GitHub when its current version and CPU outputs have verified builds',async()=>{
 const coverage=await buildCoverage(root),registry=readProjects(root,{resolvePins:false}),outputs=new Set(coverage.githubBuilds.map(row=>[row.projectId,row.version,row.arch].join('/')));
 const missing=new Set(coverage.projectsWithoutGithubBuild.map(row=>row.projectId));
 for(const project of registry.projects.filter(project=>project.supersededBy===undefined&&!coverage.publisherProjects.some(row=>row.projectId===project.id))){
  const expected=currentBuildOutputs(project).filter(({version,arch})=>!outputs.has([project.id,version,arch].join('/'))).map(({version,arch})=>version+'/'+arch);
  assert.equal(missing.has(project.id),project.build===undefined||expected.length>0,project.id);
  if(missing.has(project.id))assert.deepEqual(coverage.projectsWithoutGithubBuild.find(row=>row.projectId===project.id).missingGithubOutputs.map(row=>row.version+'/'+row.arch),expected);
 }
 assert.equal(coverage.summary.declaredOutputsWithoutGithubBuild,coverage.projectsWithoutGithubBuild.reduce((total,row)=>total+row.missingGithubOutputs.length,0));
 assert.equal(coverage.summary.activeProjectsWithGithubBuild,coverage.summary.projectsWithGithubBuild);
});
test('download pages include only exact verified archive authorities and verification keeps local history separate',async t=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'package-index-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const catalogSnapshot=fs.readFileSync(path.join(root,'catalogs/index.json'));
 const coverage=await buildCoverage(root),result=await buildIndex({directory:root,output}),index=JSON.parse(fs.readFileSync(path.join(output,'index.json'))),html=fs.readFileSync(path.join(output,'index.html'),'utf8');
 const registry=readProjects(root,{resolvePins:false});
 const activeRows=coverage.catalogPackages.filter(row=>row.projectState==='active'&&row.catalogState==='active'&&row.origin!=='local');
 for(const row of activeRows){assert.ok(['github','supplied-publisher'].includes(row.origin));if(row.origin==='github')assert.equal(row.githubBuild.record.asset.sha256,row.record.asset.sha256);else{assert.equal(row.publisherProof.publisherAuthenticated,false);assert.ok(row.publisherProof.publisherFiles>0);}}
 const published=registry.projects.flatMap(project=>{
  const packages=activeRows.filter(row=>row.projectId===project.id).map(row=>row.record);
  return packages.length?[{project,packages}]:[];
 });
 const expected=new Map(published.map(row=>[row.project.id,row])),total=published.reduce((count,row)=>count+row.packages.length,0);
 assert.equal(result.projects,published.length);assert.equal(result.packages,total);
 for(const project of registry.projects){const catalog=JSON.parse(fs.readFileSync(path.join(output,'catalogs',project.id+'.json')));const expected=activeRows.filter(row=>row.projectId===project.id);assert.equal(catalog.packages.length,expected.length);for(const record of catalog.packages)assert.ok(expected.some(row=>row.record.asset.sha256===record.asset.sha256));}
 assert.deepEqual(fs.readFileSync(path.join(root,'catalogs/index.json')),catalogSnapshot);
 assert.deepEqual(index.projects.map(project=>project.projectId).sort(),[...expected.keys()].sort());
 for(const project of index.projects){
  const supplied=expected.get(project.projectId);assert.equal(project.delivery,supplied.project.delivery);
  const catalogBytes=fs.readFileSync(path.join(output,'catalogs',project.projectId+'.json'));assert.equal(catalogBytes.length,project.catalog.bytes);assert.equal(createHash('sha256').update(catalogBytes).digest('hex'),project.catalog.sha256);assert.equal(project.catalog.url,'https://procrastinine.github.io/maclauncher-builds/catalogs/'+project.projectId+'.json');
  assert.equal(project.releases.length,supplied.packages.length);
  assert.deepEqual(project.releases.map(release=>[release.version,release.arch,release.asset]),supplied.packages.map(release=>[release.version,release.arch,release.asset]));
  for(const release of project.releases){const identity={id:project.projectId,...release};assert.equal(release.asset.filename,assetName(identity));assert.equal(release.tag,releaseTag(identity));assert.ok(html.includes('href="'+release.asset.url+'"'));assert.ok(html.includes(release.asset.sha256));}
 }
 assert.equal((html.match(/<tr data-package/g)||[]).length,total);
 for(const delivery of ['downloadable','bundled']){
  const supplied=published.filter(row=>row.project.delivery===delivery);
  assert.equal(index.projects.filter(project=>project.delivery===delivery).length,supplied.length);
  const rows=new RegExp('data-package data-project="[^"\\n]+" data-delivery="'+delivery+'"','g');
  assert.equal((html.match(rows)||[]).length,supplied.reduce((count,row)=>count+row.packages.length,0));
 }
 const verification=JSON.parse(fs.readFileSync(path.join(output,'verification.json'))),verifiedHtml=fs.readFileSync(path.join(output,'verification.html'),'utf8');
 const local=coverage.catalogPackages.filter(row=>row.origin==='local');
 assert.equal(verification.packages.filter(row=>row.origin==='local').length,local.length);
 assert.equal(verification.packages.filter(row=>row.state==='awaiting-publication').length,coverage.githubBuilds.filter(row=>row.projectState!=='retired'&&!row.catalogPublished).length);
 for(const {record} of local)assert.equal(index.projects.flatMap(project=>project.releases).some(row=>row.asset.sha256===record.asset.sha256),false);
 assert.ok(verifiedHtml.includes('Built locally — no GitHub build record yet'));assert.ok(verifiedHtml.includes('('+local.length+' archives)'));
 assert.deepEqual(verification.summary,coverage.summary);
 const publisherRows=verification.packages.filter(row=>row.origin==='supplied-publisher');assert.equal(publisherRows.length,coverage.publisherPackages.length);
 for(const row of publisherRows){assert.equal(row.build,undefined);assert.equal(row.attestation,undefined);assert.equal(row.publisherProof.publisherAuthenticated,false);assert.ok(coverage.publisherPackages.some(original=>original.asset.sha256===row.asset.sha256));if(row.state!=='publisher-published')assert.equal(row.asset.url,undefined);}
 assert.deepEqual(verification.projectsWithoutAuthority,coverage.projectsWithoutAuthority);
 if(coverage.summary.localCatalogPackages||coverage.summary.unpublishedGithubBuildOutputs){assert.ok(html.includes(coverage.summary.localCatalogPackages+' locally built archives are superseded; '+coverage.summary.unpublishedGithubBuildOutputs+' verified GitHub outputs await publication.'));assert.ok(html.includes('Review build coverage'));}
 assert.ok(html.includes('Downloadable runtimes and tools'));assert.ok(html.includes('Included components'));assert.ok(html.includes('Core graphics components and internal helpers included in the app.'));
 assert.throws(()=>renderIndex({projects:[{delivery:'unknown'}]}),/delivery classification/);
 for(const project of index.projects){assert.ok(html.includes('id="'+project.projectId+'"'));assert.ok(project.pageUrl.endsWith('/#'+project.projectId));}
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
 const registry=readProjects(root),project=registry.projects.find(p=>p.id==='hashlink');delete project.build;project.packageProfiles[1].version=project.packageProfiles[0].version;fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify(registry));assert.throws(()=>readProjects(directory),/ABI profiles/);
 project.packageProfiles=[{version:'1.9-macos-v2',label:''}];fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify(registry));assert.throws(()=>readProjects(directory),/ABI profiles/);
});

test('each package states its CPU architecture and the Mac CPUs that can run it',()=>{
 const registry=readProjects(root,{resolvePins:false});
 const index={repository:registry.repository,projects:registry.projects.flatMap(project=>{
  const file=path.join(root,'catalogs',project.id+'.json');if(!fs.existsSync(file))return[];
  const releases=JSON.parse(fs.readFileSync(file)).packages;
  return releases.length?[{projectId:project.id,name:project.name,delivery:project.delivery,catalog:{url:'https://raw.githubusercontent.com/'+registry.repository+'/main/catalogs/'+project.id+'.json'},releases}]:[];
 })},html=renderIndex(index);
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

test('ABI links have one anchor when a family gains versions and CPU rows',()=>{
 const index=JSON.parse(fs.readFileSync(path.join(root,'catalogs/index.json'))),project=index.projects.find(p=>p.projectId==='hashlink'),release=project.releases.find(r=>r.anchor==='hashlink-1-9');
 assert.ok(release);project.releases.unshift({...release,version:'1.9-MCLv2'},{...release,version:'1.9-MCLv2',arch:'arm64'});
 const html=renderIndex(index);assert.equal((html.match(/id="hashlink-1-9"/g)||[]).length,1);assert.ok(html.includes('1.9-MCLv2'));assert.ok(html.includes('Apple Silicon'));
});
