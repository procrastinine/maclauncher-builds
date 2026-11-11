import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {buildIndex,renderIndex,renderPackagePage} from '../tools/package-index.mjs';
import {buildCoverage,currentBuildOutputs} from '../tools/build-coverage.mjs';
import {readProjects} from '../lib/projects.mjs';
import {assetName,releaseTag} from '../lib/project-identity.mjs';
import {catalogFixture,packageRecord,repository} from './helpers/catalog-fixture.mjs';
import {createRequire} from 'node:module';
const requirements=createRequire(import.meta.url)('./support/requirements.cjs');
const root=path.resolve(import.meta.dirname,'..');
function indexFixture(t){
 const {directory,value}=catalogFixture(t,'hashlink',[
  packageRecord('hashlink',{version:'1.9',arch:'x64'}),
  packageRecord('hashlink',{version:'1.9',arch:'arm64'}),
  packageRecord('hashlink',{version:'1.12',arch:'universal'})]);
 return {directory,index:{repository,projects:[{projectId:'hashlink',name:'HashLink',delivery:'downloadable',
  catalog:{url:'https://example.invalid/hashlink.json'},releases:value.packages.map(row=>({...row,profile:'HashLink '+row.version+' ABI',anchor:'hashlink-'+row.version.replaceAll('.','-')}))}]}};
}

test('coverage selects the newest packaging revision per version line and CPU',()=>{
 const versions=['1.0-MCLv1','1.0-MCLv2','1.0-MCLv10','2.0-MCLv1'];
 const project={producer:{kind:'maclauncher'},packageProfiles:versions.map(version=>({version})),build:versions.map(version=>({version,command:'tools/build.mjs',architectures:version==='1.0-MCLv10'?['arm64']:['universal']}))};
 assert.deepEqual(currentBuildOutputs(project),[{version:'1.0-MCLv10',arch:'arm64'},{version:'1.0-MCLv2',arch:'universal'},{version:'2.0-MCLv1',arch:'universal'}]);
 project.build=[{version:'1.0-MCLv1',command:'tools/build.mjs',architectures:['arm64','x64']},{version:'1.0-MCLv2',command:'tools/build.mjs',architectures:['arm64']}];
 assert.deepEqual(currentBuildOutputs(project),[{version:'1.0-MCLv2',arch:'arm64'},{version:'1.0-MCLv1',arch:'x64'}]);
});
test('a project with a build record is covered when its current version and CPU outputs have verified builds',async()=>{
 const coverage=await buildCoverage(root),registry=readProjects(root,{resolvePins:false}),outputs=new Set(coverage.githubBuilds.map(row=>[row.projectId,row.version,row.arch].join('/')));
 const missing=new Set(coverage.projectsWithoutGithubBuild.map(row=>row.projectId));
 for(const project of registry.projects.filter(project=>!coverage.publisherProjects.some(row=>row.projectId===project.id))){
  const expected=currentBuildOutputs(project).filter(({version,arch})=>!outputs.has([project.id,version,arch].join('/'))).map(({version,arch})=>version+'/'+arch);
  assert.equal(missing.has(project.id),project.build!==undefined&&expected.length>0,project.id);
  if(missing.has(project.id))assert.deepEqual(coverage.projectsWithoutGithubBuild.find(row=>row.projectId===project.id).missingGithubOutputs.map(row=>row.version+'/'+row.arch),expected);
 }
 assert.equal(coverage.summary.declaredOutputsWithoutGithubBuild,coverage.projectsWithoutGithubBuild.reduce((total,row)=>total+row.missingGithubOutputs.length,0));
});
test('download and verification pages include only exact verified archive authorities',async t=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'package-index-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 fs.mkdirSync(path.join(output,'changes'));fs.writeFileSync(path.join(output,'changes','stale.json'),'{}');
 fs.mkdirSync(path.join(output,'packages'));fs.writeFileSync(path.join(output,'packages','stale.html'),'stale');
 const coverage=await buildCoverage(root),result=await buildIndex({directory:root,output}),index=JSON.parse(fs.readFileSync(path.join(output,'index.json'))),html=fs.readFileSync(path.join(output,'index.html'),'utf8');
 const registry=readProjects(root,{resolvePins:false});
 const catalogRows=coverage.catalogPackages;
 for(const row of catalogRows){assert.ok(['github','supplied-publisher'].includes(row.origin));if(row.origin==='github')assert.equal(row.githubBuild.record.asset.sha256,row.record.asset.sha256);else{assert.equal(row.publisherProof.publisherAuthenticated,false);assert.ok(row.publisherProof.publisherFiles>0);}}
 const published=registry.projects.flatMap(project=>{
  const approved=new Set(catalogRows.filter(row=>row.projectId===project.id).map(row=>row.record.asset.sha256));
  // The index preserves the source catalog's newest-first order, not coverage's inventory order.
  const file=path.join(root,'catalogs',project.id+'.json');
  const packages=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)).packages.filter(record=>approved.has(record.asset.sha256)):[];
  return packages.length?[{project,packages}]:[];
 });
 const expected=new Map(published.map(row=>[row.project.id,row])),total=published.reduce((count,row)=>count+row.packages.length,0);
 assert.equal(result.projects,published.length);assert.equal(result.packages,total);
 for(const project of registry.projects){const catalog=JSON.parse(fs.readFileSync(path.join(output,'catalogs',project.id+'.json')));const expected=catalogRows.filter(row=>row.projectId===project.id);assert.equal(catalog.packages.length,expected.length);for(const record of catalog.packages)assert.ok(expected.some(row=>row.record.asset.sha256===record.asset.sha256));}
 assert.deepEqual(index.projects.map(project=>project.projectId).sort(),[...expected.keys()].sort());
 for(const project of index.projects){
  const supplied=expected.get(project.projectId);assert.equal(project.delivery,supplied.project.delivery);
  const catalogBytes=fs.readFileSync(path.join(output,'catalogs',project.projectId+'.json'));assert.equal(catalogBytes.length,project.catalog.bytes);assert.equal(createHash('sha256').update(catalogBytes).digest('hex'),project.catalog.sha256);assert.equal(project.catalog.url,'https://procrastinine.github.io/maclauncher-builds/catalogs/'+project.projectId+'.json');
  assert.equal(project.releases.length,supplied.packages.length);
  assert.deepEqual(project.releases.map(release=>[release.version,release.arch,release.asset]),supplied.packages.map(release=>[release.version,release.arch,release.asset]));
  for(const release of project.releases){const identity={id:project.projectId,...release};assert.equal(release.asset.filename,assetName(identity));assert.equal(release.tag,releaseTag(identity));const page=fs.readFileSync(path.join(output,'packages',project.projectId+'.html'),'utf8');assert.ok(page.includes('href="'+release.asset.url+'"'));assert.ok(page.includes(release.asset.sha256));}
 }
 assert.equal((html.match(/<tr data-project=/g)||[]).length,index.projects.length);
 const combined=JSON.parse(fs.readFileSync(path.join(output,'changes.json')));
 const files=combined.projects.map(project=>project.projectId).sort();
 assert.deepEqual(fs.readdirSync(path.join(output,'changes')).sort(),files.map(id=>id+'.json').sort());
 assert.deepEqual(fs.readdirSync(path.join(output,'packages')).sort(),files.map(id=>id+'.html').sort());
 for(const project of combined.projects){
  const single=JSON.parse(fs.readFileSync(path.join(output,'changes',project.projectId+'.json')));
  assert.deepEqual(single,{schemaVersion:combined.schemaVersion,...project});
  const page=fs.readFileSync(path.join(output,'packages',project.projectId+'.html'),'utf8');
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'catalogs',project.projectId+'.json')));
  assert.deepEqual([...page.matchAll(/data-version="([^"]+)"/g)].map(match=>match[1]),
   [...new Set(catalog.packages.map(record=>record.version))]);
  assert.equal(page.includes('<script>'),false);
 }
 const expectedLatest=index.projects.flatMap(project=>project.releases.filter(release=>release.version===project.releases[0].version));
 const downloads=[...html.matchAll(/class="download" href="([^"]+)"/g)].map(match=>match[1]).sort();
 assert.deepEqual(downloads,expectedLatest.map(release=>release.asset.url).sort());
 assert.equal(html.includes('changes.json'),false);
 assert.equal(html.includes('Changes'),false);
 assert.equal(html.includes('data-version='),false);
 for(const delivery of ['downloadable','bundled']){
  const supplied=published.filter(row=>row.project.delivery===delivery);
  assert.equal(index.projects.filter(project=>project.delivery===delivery).length,supplied.length);

 }
 const verification=JSON.parse(fs.readFileSync(path.join(output,'verification.json'))),verifiedHtml=fs.readFileSync(path.join(output,'verification.html'),'utf8');
 const githubRows=verification.packages.filter(row=>row.origin==='github');assert.equal(githubRows.length,coverage.githubBuilds.length);
 for(const row of githubRows){assert.equal(row.state,'published');assert.ok(verifiedHtml.includes(row.asset.sha256));}
 assert.deepEqual(verification.summary,coverage.summary);
 const publisherRows=verification.packages.filter(row=>row.origin==='supplied-publisher');assert.equal(publisherRows.length,coverage.publisherPackages.length);
 for(const row of publisherRows){assert.equal(row.build,undefined);assert.equal(row.attestation,undefined);assert.equal(row.publisherProof.publisherAuthenticated,false);assert.ok(coverage.publisherPackages.some(original=>original.asset.sha256===row.asset.sha256));if(row.state!=='publisher-published')assert.equal(row.asset.url,undefined);}
 assert.deepEqual(verification.projectsWithoutAuthority,coverage.projectsWithoutAuthority);
 assert.ok(html.includes('Downloadable runtimes and tools'));assert.ok(html.includes('Included components'));assert.ok(html.includes('Core graphics components and internal helpers included in the app.'));
 assert.throws(()=>renderIndex({projects:[{delivery:'unknown'}]}),/delivery classification/);
 for(const project of index.projects){assert.ok(html.includes('id="'+project.projectId+'"'));assert.ok(project.pageUrl.endsWith('/#'+project.projectId));}
 assert.ok(fs.existsSync(path.join(output,'.nojekyll')));
});
test('app project and HashLink section hashes forward to static pages without fetching',()=>{
 const html=renderIndex({repository:'owner/builds',projects:[]});
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 const destinations=[],events={},location={hash:'',replace:value=>destinations.push(value)};
 const row=id=>({dataset:{project:id},querySelector:()=>({getAttribute:()=> 'packages/'+id+'.html'})});
 const projects={reshade:row('reshade'),'maclauncher-kosmickrisp':row('maclauncher-kosmickrisp'),hashlink:row('hashlink')};
 const anchors=Object.fromEntries(Object.entries(projects).map(([id,value])=>[id,{closest:()=>value}]));
 anchors['hashlink-1-12']={closest:()=>projects.hashlink};
 vm.runInNewContext(script,{document:{getElementById:id=>anchors[id]},window:{location,addEventListener:(name,fn)=>events[name]=fn}});
 assert.deepEqual(destinations,[]);
 location.hash='#reshade';events.hashchange();
 assert.deepEqual(destinations,['packages/reshade.html']);
 location.hash='#maclauncher-kosmickrisp';events.hashchange();
 location.hash='#hashlink-1-12';events.hashchange();
 assert.deepEqual(destinations,['packages/reshade.html','packages/maclauncher-kosmickrisp.html','packages/hashlink.html#hashlink-1-12']);
 location.hash='#%invalid';assert.doesNotThrow(()=>events.hashchange());
 location.hash='#missing';events.hashchange();assert.equal(destinations.length,3);
});
test('package names and latest versions are escaped before rendering public HTML',t=>{
 const {index}=indexFixture(t);index.projects[0].name='<script>bad()</script>';index.projects[0].releases[0].version='Version <unsafe>';
 const html=renderIndex(index);assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));assert.ok(html.includes('Version &lt;unsafe&gt;'));assert.equal(html.includes('<script>bad()'),false);
});
test('ABI profile metadata rejects duplicate versions and incomplete labels',requirements({sourceTree:'sources/maclauncher-android'}),t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'package-profiles-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const registry=readProjects(root),project=registry.projects.find(p=>p.id==='hashlink');delete project.build;project.packageProfiles[1].version=project.packageProfiles[0].version;fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify(registry));assert.throws(()=>readProjects(directory),/ABI profiles/);
 project.packageProfiles=[{version:'1.9-macos-v2',label:''}];fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify(registry));assert.throws(()=>readProjects(directory),/ABI profiles/);
});

test('each package states its CPU architecture and the Mac CPUs that can run it',t=>{
 const {index,directory}=indexFixture(t);
 const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalogs/hashlink.json')));
 const changes={projectId:'hashlink',releases:[...new Set(catalog.packages.map(record=>record.version))].map(version=>({version,previousVersion:null,inputs:[],commits:[]}))};
 const html=renderPackagePage(index.projects[0],changes,catalog,index.repository);
 for(const project of index.projects)for(const release of project.releases){
  assert.ok(['arm64','x64','universal'].includes(release.arch));
  const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalogs',project.projectId+'.json'))),record=catalog.packages.find(row=>row.version===release.version&&row.arch===release.arch);
  assert.deepEqual(release.launcherArchitectures,record.launcherArchitectures);
  for(const own of release.arch==='universal'?['arm64','x64']:[release.arch])assert.ok(release.launcherArchitectures.includes(own));
 }
 assert.ok(html.includes('Apple Silicon<span class="secondary">arm64 · macOS 13.0+</span>'));
 assert.ok(html.includes('Universal<span class="secondary">arm64 and x64 · macOS'));
 assert.ok(html.includes('Intel<span class="secondary">x64 · macOS 13.0+</span>'));
});

test('ABI links have one anchor when a family gains versions and CPU rows',t=>{
 const {index}=indexFixture(t),project=index.projects[0],release=project.releases.find(r=>r.anchor==='hashlink-1-9');
 assert.ok(release);project.releases.unshift({...release,version:'1.9-MCLv2'},{...release,version:'1.9-MCLv2',arch:'arm64'});
 const html=renderIndex(index);assert.equal((html.match(/id="hashlink-1-9"/g)||[]).length,1);assert.ok(html.includes('1.9-MCLv2'));assert.ok(html.includes('Apple Silicon'));
});

test('static version pages render Markdown notes before generated changes without scripts',t=>{
 const {index,directory}=indexFixture(t),project=index.projects[0];
 const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalogs/hashlink.json')));
 const changes={projectId:'hashlink',releases:[...new Set(catalog.packages.map(record=>record.version))].map(version=>({
  version,previousVersion:null,notes:'**Readable note** with `code`.\n\n- A setting.\n- <script>unsafe</script>',
  inputs:[],commits:[{revision:'a'.repeat(40),date:'2026-11-11T00:00:00Z',subject:'Generated subject'}]
 }))};
 const html=renderPackagePage(project,changes,catalog,index.repository);
 assert.ok(html.includes('<strong>Readable note</strong> with <code>code</code>'));
 assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
 assert.ok(html.indexOf('Readable note')<html.indexOf('Generated subject'));
 assert.equal(html.includes('<script>'),false);
 assert.ok(html.includes('../catalogs/hashlink.json'));assert.ok(html.includes('../changes/hashlink.json'));
});
