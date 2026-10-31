import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {catalogIndex} from './release-runtime.mjs';
import {buildCoverage} from './build-coverage.mjs';
import {readProjects} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
const escape=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const size=bytes=>bytes<1024*1024?(bytes/1024).toFixed(1)+' KB':(bytes/(1024*1024)).toFixed(1)+' MB';
// Each package names the CPU architecture it was built for.
const platform=release=>{
 const name={arm64:'Apple Silicon',x64:'Intel',universal:'Universal'}[release.arch]||release.arch,detail=[release.arch==='universal'?'arm64 and x64':release.arch,'macOS '+release.minimumMacOS+'+'];
 return escape(name)+'<span class="secondary">'+escape(detail.join(' · '))+'</span>';
};
const groups=[
 {id:'downloadable',label:'Downloadable runtimes and tools',description:'Installed through MacLauncher Runtimes or when a game needs them.'},
 {id:'bundled',label:'Included components',description:'Core graphics components and internal helpers included in the app.'}
];
export function renderIndex(index,summary){
 if(index.projects.some(project=>!groups.some(group=>group.id===project.delivery)))throw Error('Every indexed project requires a delivery classification.');
 const anchors=new Set([...index.projects.map(project=>project.projectId),...(index.retiredProjects||[]).map(project=>project.projectId)]);
 const profileAnchor=anchor=>{if(!anchor||anchors.has(anchor))return '';anchors.add(anchor);return ' id="'+escape(anchor)+'"';};
 const projectGroups=groups.map(group=>({...group,projects:index.projects.filter(project=>project.delivery===group.id)}));
 const packageCount=projects=>projects.reduce((total,project)=>total+project.releases.length,0);
 const tabs=projectGroups.map((group,position)=>`<button type="button" role="tab" id="tab-${group.id}" aria-controls="panel-${group.id}" aria-selected="${position===0}" tabindex="${position===0?0:-1}" data-group="${group.id}">${group.label} <span class="tab-count" aria-hidden="true">${packageCount(group.projects)}</span></button>`).join('\n');
 const panels=projectGroups.map((group,position)=>{
  const rows=group.projects.flatMap(project=>project.releases.map((release,releasePosition)=>`<tr data-package data-project="${escape(project.projectId)}" data-delivery="${group.id}"${releasePosition===0?' id="'+escape(project.projectId)+'"':''}><td><strong>${escape(project.name)}</strong><span class="secondary">${escape(project.projectId)}</span>${release.profile?'<span class="profile"'+profileAnchor(release.anchor)+'>'+escape(release.profile)+'</span>':''}</td><td><code>${escape(release.version)}</code></td><td>${platform(release)}</td><td><a class="download" href="${escape(release.asset.url)}">${group.id==='bundled'?'Archive':'Download'} <span>${size(release.asset.bytes)}</span></a><div class="links"><a href="https://github.com/${escape(index.repository)}/tree/${encodeURIComponent(release.tag)}">Source</a> · <a href="${escape(project.catalog.url)}">Catalog</a></div><details><summary>SHA-256</summary><code>${escape(release.asset.sha256)}</code></details></td></tr>`)).join('\n');
  return `<section role="tabpanel" id="panel-${group.id}" aria-labelledby="tab-${group.id}" data-panel data-delivery="${group.id}"${position?' hidden':''}><p class="group-description">${group.description}</p><div class="table-scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version</th><th scope="col">Platform</th><th scope="col">Files</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
 }).join('\n');
 const provenanceNotice=summary&&(summary.localCatalogPackages||summary.unpublishedGithubBuildOutputs)?'<p class="coverage-notice">'+escape(summary.localCatalogPackages)+' locally built archives are superseded; '+escape(summary.unpublishedGithubBuildOutputs)+' verified GitHub outputs await publication. <a href="verification.html">Review build coverage</a>.</p>':'';
 const retired=index.retiredProjects||[];
 const retiredList=retired.length?'<section aria-labelledby="retired-projects"><h2 id="retired-projects">Retired projects ('+retired.length+')</h2><p>Historical versions and build records remain available.</p><ul>'+retired.map(project=>'<li id="'+escape(project.projectId)+'"><strong>'+escape(project.name)+'</strong> · '+retirementMarkup(project)+(project.missingGithubOutputs?.length?' · Missing outputs: '+project.missingGithubOutputs.map(output=>'<code>'+escape(output.version)+' / '+escape(output.arch)+'</code>').join(', '):'')+' · <a href="'+escape(historyHref(project))+'">History</a></li>').join('')+'</ul></section>':'';
 const first=projectGroups[0];
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>MacLauncher packages</title><link rel="icon" href="data:,"><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--muted:#626b75;--line:#d9dee4;--accent:#075fc0;--selected:#edf4fc}*{box-sizing:border-box}body{margin:0 auto;padding:48px 24px;max-width:1280px;line-height:1.5}h1{font-size:2rem;letter-spacing:-.035em;margin:0 0 12px}p{max-width:78ch}a{color:var(--accent);text-underline-offset:3px}nav{display:flex;gap:24px;flex-wrap:wrap;margin:20px 0 32px}.coverage-notice{padding:14px 16px;border:1px solid var(--line);border-radius:8px;max-width:none}label{display:block;font-weight:600}input{font:inherit;width:100%;max-width:560px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}#count,.secondary,.links,details{color:var(--muted);font-size:.86rem}.secondary{display:block;font-weight:400;margin:4px 0}.group-tabs{display:flex;gap:8px;overflow-x:auto;margin:0 0 24px;padding:2px 2px 8px}.group-tabs button{font:inherit;font-weight:600;white-space:nowrap;cursor:pointer;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;padding:10px 14px}.group-tabs button[aria-selected=true]{background:var(--selected);border-color:var(--accent);color:var(--accent)}.group-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.tab-count{font-size:.8rem;font-weight:400;margin-left:10px}.group-description{margin:18px 0 0}.table-scroll{overflow:auto;margin-top:16px}table{border-collapse:collapse;width:100%;min-width:750px;text-align:left}th,td{padding:16px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}td:first-child{min-width:240px}[id]{scroll-margin-top:20px}td:nth-child(2){max-width:350px;overflow-wrap:anywhere}code{font: .85rem ui-monospace,SFMono-Regular,Menlo,monospace}.download{white-space:nowrap;font-weight:600}.download span{font-size:.85rem;font-weight:400}.links{margin-top:8px}details{margin-top:8px}details code{display:block;max-width:250px;overflow-wrap:anywhere;margin-top:6px}.profile{font-size:.8rem;display:inline-block;border:1px solid var(--line);border-radius:5px;padding:2px 6px;margin:5px 0}footer{font-size:.86rem;color:var(--muted);margin-top:32px}@media(prefers-color-scheme:dark){:root{--muted:#a5adb7;--line:#39424d;--accent:#8abfff;--selected:#172b42}}[hidden]{display:none!important}
</style><noscript><style>[data-panel][hidden]{display:block!important}</style></noscript></head><body><header><h1>MacLauncher packages</h1><p>Versioned macOS binaries for <a href="https://github.com/procrastinine/maclauncher">MacLauncher</a>, with public build recipes and supplied-file inventories.</p><nav aria-label="Package references"><a href="https://github.com/${escape(index.repository)}">Repository</a><a href="https://github.com/${escape(index.repository)}/blob/main/docs/PACKAGES.md">Package reference</a><a href="verification.html">Verify packages</a><a href="index.json">JSON index</a></nav></header><main>${provenanceNotice}<div class="group-tabs" role="tablist" aria-label="Package delivery">${tabs}</div><label for="search">Find a package</label><input id="search" type="search" placeholder="Runtime, version, ABI or architecture" autocomplete="off"><p id="count" role="status">${packageCount(first.projects)} packages · ${first.projects.length} projects</p>${panels}<p id="empty" hidden>No matching packages in this group.</p>${retiredList}</main><footer>Archives have immutable versions and checksums. HashLink and Java Steamworks retain separate game ABI profiles.</footer><script>
const input=document.querySelector('#search'),rows=[...document.querySelectorAll('[data-package]')],tabs=[...document.querySelectorAll('[role=tab]')],panels=[...document.querySelectorAll('[data-panel]')],count=document.querySelector('#count'),empty=document.querySelector('#empty');
let active='downloadable';
function filter(){
 const terms=input.value.toLowerCase().trim().split(/\\s+/).filter(Boolean),selected=rows.filter(row=>row.dataset.delivery===active);let visible=0;
 for(const row of rows){row.hidden=!terms.every(term=>row.textContent.toLowerCase().includes(term));if(row.dataset.delivery===active&&!row.hidden)visible++;}
 const projects=new Set(selected.map(row=>row.dataset.project)).size;count.textContent=visible+' of '+selected.length+' packages · '+projects+' '+(projects===1?'project':'projects');empty.hidden=visible!==0;
}
function activate(group,focus=false){
 active=group;
 for(const tab of tabs){const selected=tab.dataset.group===active;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();}
 for(const panel of panels)panel.hidden=panel.dataset.delivery!==active;
 filter();
}
for(const [position,tab] of tabs.entries()){
 tab.addEventListener('click',()=>activate(tab.dataset.group));
 tab.addEventListener('keydown',event=>{let target;if(event.key==='ArrowRight')target=(position+1)%tabs.length;else if(event.key==='ArrowLeft')target=(position+tabs.length-1)%tabs.length;else if(event.key==='Home')target=0;else if(event.key==='End')target=tabs.length-1;else return;event.preventDefault();activate(tabs[target].dataset.group,true);});
}
function followHash(){
 let id;try{id=decodeURIComponent(window.location.hash.slice(1));}catch{return;}
 const target=id&&document.getElementById(id),group=target&&target.closest('[data-delivery]')?.dataset.delivery;
 if(!group||!tabs.some(tab=>tab.dataset.group===group))return;
 input.value='';activate(group);requestAnimationFrame(()=>target.scrollIntoView({block:'start'}));
}
input.addEventListener('input',filter);window.addEventListener('hashchange',followHash);activate(active);followHash();
</script></body></html>\n`;
}
// Both download and verification pages consume the same signed-build coverage.
const localLabel='Built locally — no GitHub build record yet';
const buildUrl=(repository,runId)=>runId?'https://github.com/'+repository+'/actions/runs/'+runId:undefined;
const archiveIdentity=({filename,sha256,bytes})=>({filename,sha256,bytes});
const projectMetadata=({projectState='active',authorityPolicy='github-build',supersededBy,successor,activeSuccessor,historyUrl})=>({projectState,authorityPolicy,
 ...(supersededBy?{supersededBy}:{}),...(successor?{successor}:{}),...(activeSuccessor?{activeSuccessor}:{}),...(historyUrl?{historyUrl}:{})});
const historyHref=project=>project.historyUrl||'verification.html#project-'+encodeURIComponent(project.projectId);
function successorMarkup(project){
 const successor=project.successor,id=successor?.projectId||project.supersededBy;
 if(!id)return '';
 const link='<a href="'+escape(successor?.url||'verification.html#project-'+encodeURIComponent(id))+'">'+escape(successor?.name||id)+'</a>';
 const active=project.activeSuccessor;
 return 'Replaced by '+link+(active&&active.projectId!==id?' · Current project <a href="'+escape(active.url)+'">'+escape(active.name||active.projectId)+'</a>':'');
}
function retirementMarkup(project){return (project.projectState||project.state)==='retired'?'Retired'+(successorMarkup(project)?' · '+successorMarkup(project):''):'';}
function publisherPackage(row){return {projectId:row.projectId,name:row.name,...projectMetadata(row),version:row.version,arch:row.arch,minimumMacOS:row.minimumMacOS,
 asset:row.catalogPublished&&row.projectState!=='retired'?row.asset:archiveIdentity(row.asset),origin:'supplied-publisher',
 state:row.projectState==='retired'?'retired-publisher':row.catalogPublished?'publisher-published':'publisher-awaiting-publication',
 catalogPublished:row.catalogPublished,publisherProof:row.publisherProof};}
export function verificationIndex(index,directory=root,coverage){
 if(!coverage)throw Error('Verified GitHub build coverage is required.');
 const packages=coverage.catalogPackages.filter(row=>row.origin==='local'||row.origin==='github'&&row.projectState!=='retired'&&row.githubBuild?.catalogPublished===true).map(row=>{
  const {projectId,name,record,origin,githubBuild}=row,evidence=origin==='github'?githubBuild:undefined,rebuild=record.rebuild;
  const recipeCommit=evidence?.sourceRevision||record.build?.sourceRevision||(record.source?.repository===index.repository?record.source.revision:undefined);
  const runId=evidence?.runId;
  return {projectId,name,...projectMetadata(row),version:record.version,arch:record.arch,minimumMacOS:record.minimumMacOS,asset:record.asset,
   origin,state:origin==='github'?'published':'superseded-built-locally',...(origin==='local'?{label:localLabel}:{}),
   recipe:{url:'https://github.com/'+index.repository+'/tree/'+encodeURIComponent(recipeCommit||record.tag),...(recipeCommit?{commit:recipeCommit}:{tag:record.tag})},
   ...(runId?{build:{runId,url:buildUrl(index.repository,runId)}}:{}),
   attestation:{url:'https://api.github.com/repos/'+index.repository+'/attestations/sha256:'+record.asset.sha256,verified:origin==='github'},
   rebuild:rebuild||{status:'not-recorded'}};
 });
 const builds=coverage.githubBuilds.filter(record=>record.projectState==='retired'||!record.catalogPublished).map(record=>({
  projectId:record.projectId,name:record.name,...projectMetadata(record),version:record.version,arch:record.arch,minimumMacOS:record.minimumMacOS,asset:archiveIdentity(record.asset),
  origin:'github',state:record.projectState==='retired'?'retired-github':'awaiting-publication',
  recipe:{commit:record.sourceRevision,url:'https://github.com/'+index.repository+'/tree/'+record.sourceRevision},
  build:{runId:record.runId,url:buildUrl(index.repository,record.runId)},
  attestation:{...record.attestation,verified:true},rebuild:record.record?.rebuild||{status:'not-recorded'}}));
 const supplied=(coverage.publisherPackages||[]).map(publisherPackage);
 return {schemaVersion:2,repository:index.repository,summary:coverage.summary,projects:coverage.projects||[],retiredProjects:coverage.retiredProjects||[],publisherProjects:coverage.publisherProjects||[],
  packages:[...packages,...builds,...supplied],projectsWithoutGithubBuild:coverage.projectsWithoutGithubBuild,projectsWithoutPublisherProof:coverage.projectsWithoutPublisherProof||[],projectsWithoutAuthority:coverage.projectsWithoutAuthority||coverage.projectsWithoutGithubBuild};
}
export function localBuilds(coverage){
 return {schemaVersion:1,repository:coverage.repository,summary:coverage.summary,projects:coverage.projects||[],retiredProjects:coverage.retiredProjects||[],publisherProjects:coverage.publisherProjects||[],publisherPackages:(coverage.publisherPackages||[]).map(publisherPackage),
  localPackages:coverage.catalogPackages.filter(row=>row.origin==='local').map(row=>({projectId:row.projectId,name:row.name,...projectMetadata(row),version:row.record.version,arch:row.record.arch,minimumMacOS:row.record.minimumMacOS,asset:row.record.asset,state:'superseded-built-locally',label:localLabel})),
  projectsWithoutGithubBuild:coverage.projectsWithoutGithubBuild,projectsWithoutPublisherProof:coverage.projectsWithoutPublisherProof||[],projectsWithoutAuthority:coverage.projectsWithoutAuthority||coverage.projectsWithoutGithubBuild,
  githubBuilds:coverage.githubBuilds.map(row=>({projectId:row.projectId,name:row.name,...projectMetadata(row),version:row.version,arch:row.arch,asset:row.catalogPublished&&row.projectState!=='retired'?row.asset:archiveIdentity(row.asset),sourceRevision:row.sourceRevision,runId:row.runId,catalogPublished:row.catalogPublished}))};
}
export function renderVerification(index){
 const guide='https://github.com/'+index.repository+'/blob/main/VERIFYING.md';
 const status={match:'Byte-for-byte match',different:'Archive bytes differ',unavailable:'Rebuild unavailable','not-recorded':'Not recorded'};
 const anchored=new Set(),historyAnchor=projectId=>{if(anchored.has(projectId))return '';anchored.add(projectId);return ' id="project-'+escape(projectId)+'"';};
 const projectList=projects=>'<ul>'+projects.map(project=>'<li'+historyAnchor(project.projectId)+'><strong>'+escape(project.name||project.projectId)+'</strong> <code>'+escape(project.projectId)+'</code>'+(retirementMarkup(project)?' · '+retirementMarkup(project):'')+(project.authorityPolicy==='supplied-publisher'?' · Supplied files'+(project.hasPublisherProof===false?' proof missing':project.hasPublisherProof===true?' proof available':''):'')+' · <a href="'+escape(historyHref(project))+'">History</a></li>').join('')+'</ul>';
 const table=records=>{
  const rows=records.map(record=>{
   const rebuild=record.rebuild,label=status[rebuild.status]||'Not recorded',report=typeof rebuild.reportUrl==='string'&&rebuild.reportUrl.startsWith('https://')?rebuild.reportUrl:undefined;
   const target=['awaiting-publication','retired-github'].includes(record.state)?record.build?.url:record.asset?.url;
   const title=target?'<a href="'+escape(target)+'">'+escape(record.name||record.projectId)+'</a>':escape(record.name||record.projectId);
   return `<tr data-verification-state="${escape(record.state)}" data-project-state="${escape(record.projectState||'active')}"${historyAnchor(record.projectId)}><td>${title}<small>${escape(record.projectId)}</small>${retirementMarkup(record)?'<small>'+retirementMarkup(record)+'</small>':''}</td><td><code>${escape(record.version)}</code><small>SHA-256: ${escape(record.asset.sha256)}</small></td><td>${escape(record.arch)}</td><td>${record.minimumMacOS?escape(record.minimumMacOS)+'+':'Not recorded'}</td><td><a href="${escape(record.recipe.url)}">${record.recipe.commit?'<code>'+escape(record.recipe.commit.slice(0,12))+'</code>':'Tagged source'}</a>${record.recipe.commit?'':'<small>Commit not recorded</small>'}</td><td>${record.build?.url?'<a href="'+escape(record.build.url)+'">'+escape(record.build.runId)+'</a>':'No GitHub build record'}</td><td>${record.attestation.verified?'Verified · ':''}<a href="${escape(record.attestation.url||'https://api.github.com/repos/'+index.repository+'/attestations/sha256:'+record.asset.sha256)}">Find build record</a></td><td>${report?'<a href="'+escape(report)+'">'+escape(label)+'</a>':escape(label)}${rebuild.summary?'<small>'+escape(rebuild.summary)+'</small>':''}</td></tr>`;
  }).join('\n');
  return `<div class="scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version and archive</th><th scope="col">CPU</th><th scope="col">Minimum macOS</th><th scope="col">Recipe commit</th><th scope="col">Build run</th><th scope="col">Build record</th><th scope="col">Rebuild result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
 };
 const publisherTable=records=>{
  const rows=records.map(record=>{
   const proof=record.publisherProof,target=record.state==='publisher-published'?record.asset.url:proof.publisherRecord;
   const title=target?'<a href="'+escape(target)+'">'+escape(record.name||record.projectId)+'</a>':escape(record.name||record.projectId);
   const state=record.projectState==='retired'?retirementMarkup(record):record.catalogPublished?'Published':'Awaiting publication';
   return `<tr data-verification-state="${escape(record.state)}" data-project-state="${escape(record.projectState)}"${historyAnchor(record.projectId)}><td>${title}<small>${escape(record.projectId)}</small><small>${state}</small></td><td><code>${escape(record.version)}</code><small>SHA-256: ${escape(record.asset.sha256)}</small></td><td>${escape(record.arch)}</td><td>${record.minimumMacOS?escape(record.minimumMacOS)+'+':'Not recorded'}</td><td>${escape(proof.publisherVersion)}</td><td>${escape(proof.publisherFiles)} unchanged files</td><td><a href="${escape(proof.publisherInput)}">Input inventory</a><small><a href="${escape(proof.publisherRecord)}">Equality record</a></small></td><td>Not established by file equality</td></tr>`;
  }).join('\n');
  return `<div class="scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version and archive</th><th scope="col">CPU</th><th scope="col">Minimum macOS</th><th scope="col">Publisher version</th><th scope="col">Supplied files</th><th scope="col">Equality proof</th><th scope="col">Publisher authentication</th></tr></thead><tbody>${rows}</tbody></table></div>`;
 };
 const local=index.packages.filter(record=>record.origin==='local'),published=index.packages.filter(record=>record.state==='published'),pending=index.packages.filter(record=>record.state==='awaiting-publication'),retiredBuilds=index.packages.filter(record=>record.state==='retired-github');
 const awaiting=index.projectsWithoutGithubBuild||[],missingPublisher=index.projectsWithoutPublisherProof||[],missingAuthority=index.projectsWithoutAuthority||awaiting,summary=index.summary||{},retired=index.retiredProjects||[],activeProjects=summary.activeProjects??summary.projects??0;
 const supplied=index.packages.filter(record=>record.origin==='supplied-publisher'),publisherProjects=index.publisherProjects||[],githubRequired=summary.projectsRequiringGithubBuild??activeProjects;
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>MacLauncher package verification</title><link rel="icon" href="data:,"><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}body{max-width:1600px;padding:40px 24px;margin:auto;line-height:1.5}h1{letter-spacing:-.03em}h2{margin-top:36px}p{max-width:90ch}a{color:light-dark(#075fc0,#8abfff);text-underline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:24px;margin:24px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:1150px;text-align:left}th,td{padding:14px 12px;border-bottom:1px solid light-dark(#d9dee4,#39424d);vertical-align:top}th{font-size:.85rem}code{font:.85rem ui-monospace,SFMono-Regular,Menlo,monospace}small{display:block;font-size:.8rem;max-width:30ch;overflow-wrap:anywhere;color:light-dark(#626b75,#a5adb7);margin-top:4px}footer{margin-top:24px;font-size:.86rem}.count{font-size:.8em;font-weight:400}.notice{border-left:4px solid light-dark(#9a6700,#d29922);padding-left:16px}
</style></head><body><header><h1>Package verification</h1><p>A recipe is the public instructions and patches that turn a project's source into a Mac package. Compiled packages require a verified GitHub-hosted <code>runtime-build.yml</code> attestation for their exact archive SHA-256. Registered unmodified publisher files use a separate complete file-equality proof. Active downloads require the applicable proof. Earlier local packages remain separate below; existing app installations keep working.</p><nav aria-label="Verification references"><a href="${escape(guide)}">How to verify a package</a><a href="index.html">Package downloads</a><a href="verification.json">Verification JSON</a><a href="https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md">App feature requirements</a></nav></header><main><section aria-labelledby="local-builds"><h2 id="local-builds">${localLabel} <span class="count">(${local.length} archives)</span></h2><p class="notice">These catalog archives are superseded local packages. A recipe, a local rebuild or a GitHub build of another archive does not establish GitHub provenance for these bytes. New GitHub outputs keep their own archive identity and do not replace these rows until publication. For packages containing publisher binaries, “built locally” describes package assembly.</p>${local.length?table(local):'<p>No catalog archive lacks a verified GitHub build record.</p>'}</section><section aria-labelledby="active-build-coverage"><h2 id="active-build-coverage">Active projects without required verification <span class="count">(${missingAuthority.length})</span></h2><p>${escape(summary.projectsWithGithubBuild??0)} of ${escape(githubRequired)} active projects requiring GitHub builds have all current version and CPU outputs verified. ${escape(summary.suppliedPublisherProjects??0)} of ${publisherProjects.length} registered supplied-file projects have verified file equality. GitHub builds missing: ${awaiting.length}; supplied-file proofs missing: ${missingPublisher.length}. ${escape(summary.projects??activeProjects)} registered projects include ${escape(summary.retiredProjects??retired.length)} retired ${(summary.retiredProjects??retired.length)===1?'project':'projects'}. Retired projects remain in history and do not count as missing active builds. Archive counts above include local history from both active and retired projects.</p>${missingAuthority.length?projectList(missingAuthority):'<p>Every active project has its required verification.</p>'}</section><section aria-labelledby="github-published"><h2 id="github-published">Published GitHub packages <span class="count">(${published.length} archives)</span></h2>${published.length?table(published):'<p>No current catalog archive has a verified GitHub build record.</p>'}</section><section aria-labelledby="github-pending"><h2 id="github-pending">GitHub builds awaiting publication <span class="count">(${pending.length} archives)</span></h2><p>These exact archives have verified build records but are absent from the active package catalog. Links open their build runs. They are separate from any older local version.</p>${pending.length?table(pending):'<p>No verified GitHub output is awaiting publication.</p>'}</section><section aria-labelledby="supplied-files"><h2 id="supplied-files">Unchanged supplied files <span class="count">(${supplied.length} packages)</span></h2><p>These packages retain the registered supplied application files, including their bytes and modes. Package metadata and notices can differ. This route establishes file equality with a declared input, not a GitHub build or publisher authentication. An ad-hoc code signature is not a Developer ID signature and does not authenticate a publisher.</p>${supplied.length?publisherTable(supplied):'<p>No package has a verified supplied-file equality record.</p>'}${publisherProjects.length?'<details><summary>Registered supplied-file projects ('+publisherProjects.length+')</summary>'+projectList(publisherProjects)+'</details>':''}</section><section aria-labelledby="retired-projects"><h2 id="retired-projects">Retired projects <span class="count">(${retired.length})</span></h2><p>Retired project coverage: ${escape(summary.retiredProjectsWithGithubBuild??retired.filter(project=>project.hasGithubBuild).length)} with a verified GitHub output; ${escape(summary.retiredProjectsWithoutGithubBuild??retired.filter(project=>!project.hasGithubBuild).length)} without. Retirement removes a project from active downloads and build-coverage goals. Its original ID, historical versions, source and signed build evidence stay available. A successor link is a reference; it does not rename an archive or redirect an existing installation.</p>${retired.length?projectList(retired):'<p>No registered project is retired.</p>'}</section>${retiredBuilds.length?'<section aria-labelledby="retired-builds"><h2 id="retired-builds">Signed builds of retired projects <span class="count">('+retiredBuilds.length+' archives)</span></h2>'+table(retiredBuilds)+'</section>':''}<p>Each CPU build has its own row: <code>arm64</code> for Apple Silicon, <code>x64</code> for Intel and <code>universal</code> for both. Minimum macOS comes from the native package's recorded requirement, separately from its build SDK. A recipe commit identifies this repository; an engine's upstream commit is a different identity.</p></main><footer>Generated from catalog records, cryptographically verified GitHub build evidence and registered supplied-file equality records. A rebuild result describes one comparison; it does not establish a GitHub build record.</footer></body></html>\n`;
}

export async function buildIndex({directory=root,output}){
 if(!output)throw Error('An output directory is required.');
 const coverage=await buildCoverage(directory),index=catalogIndex(directory,{coverage});fs.mkdirSync(output,{recursive:true});
 if(fs.realpathSync(output)===fs.realpathSync(directory))throw Error('Package index output must be separate from its source tree.');
 fs.writeFileSync(path.join(output,'index.json'),JSON.stringify(index,null,2)+'\n');fs.writeFileSync(path.join(output,'index.html'),renderIndex(index,coverage.summary));fs.writeFileSync(path.join(output,'.nojekyll'),'');
 const catalogsDirectory=path.join(output,'catalogs');
 if(fs.existsSync(catalogsDirectory)&&fs.lstatSync(catalogsDirectory).isSymbolicLink())throw Error('Generated catalogs must use an ordinary directory.');
 fs.mkdirSync(catalogsDirectory,{recursive:true});
 for(const project of readProjects(directory,{resolvePins:false}).projects){
  const input=path.join(directory,'catalogs',project.id+'.json'),original=fs.existsSync(input)?JSON.parse(fs.readFileSync(input)):{schemaVersion:2,projectId:project.id,updatePolicy:'manual',packages:[]};
  const selected=index.projects.find(row=>row.projectId===project.id),packages=(selected?.releases||[]).map(release=>original.packages.find(record=>record.version===release.version&&record.arch===release.arch&&record.asset.sha256===release.asset.sha256));
  if(packages.some(record=>!record))throw Error('A generated catalog package is absent from its source catalog.');
  const bytes=Buffer.from(JSON.stringify({...original,packages},null,2)+'\n');
  if(selected&&(selected.catalog.bytes!==bytes.length||selected.catalog.sha256!==createHash('sha256').update(bytes).digest('hex')))throw Error('Generated catalog bytes differ from the package index.');
  const target=path.join(catalogsDirectory,project.id+'.json');if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Generated catalog files must be ordinary files.');
  fs.writeFileSync(target,bytes);
 }
 const verification=verificationIndex(index,directory,coverage);fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(verification,null,2)+'\n');fs.writeFileSync(path.join(output,'verification.html'),renderVerification(verification));
 return{projects:index.projects.length,packages:index.projects.reduce((total,p)=>total+p.releases.length,0),coverage:coverage.summary,output:path.resolve(output)};
}
export async function main(args){
 if(args.length===1&&args[0]==='--local-builds')return localBuilds(await buildCoverage(root));
 if(args.length!==2||args[0]!=='--output')throw Error('Use --output <directory> or --local-builds.');return buildIndex({output:args[1]});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
