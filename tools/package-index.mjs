import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {catalogIndex} from './release-runtime.mjs';
import {buildCoverage} from './build-coverage.mjs';
import {readProjects} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
const escape=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const verifyCommand=(repository,filename)=>'gh attestation verify '+filename+' --repo '+repository+' --signer-workflow '+repository+'/.github/workflows/runtime-build.yml --deny-self-hosted-runners';
const buildLinks=(repository,release)=>release.build?.sourceRevision&&release.build?.runId?'<p>Built from <a href="https://github.com/'+escape(repository)+'/tree/'+escape(release.build.sourceRevision)+'">'+escape(release.build.sourceRevision.slice(0,12))+'</a> by <a href="https://github.com/'+escape(repository)+'/actions/runs/'+escape(release.build.runId)+'">build '+escape(release.build.runId)+'</a>.</p><details><summary>Verify the archive</summary><code>'+escape(verifyCommand(repository,release.asset.filename))+'</code></details>':'';
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
export function renderIndex(index){
 if(index.projects.some(project=>!groups.some(group=>group.id===project.delivery)))throw Error('Every indexed project requires a delivery classification.');
 const anchors=new Set(index.projects.map(project=>project.projectId));
 const profileAnchor=anchor=>{if(!anchor||anchors.has(anchor))return '';anchors.add(anchor);return ' id="'+escape(anchor)+'"';};
 const projectGroups=groups.map(group=>({...group,projects:index.projects.filter(project=>project.delivery===group.id)}));
 const packageCount=projects=>projects.reduce((total,project)=>total+project.releases.length,0);
 const tabs=projectGroups.map((group,position)=>`<button type="button" role="tab" id="tab-${group.id}" aria-controls="panel-${group.id}" aria-selected="${position===0}" tabindex="${position===0?0:-1}" data-group="${group.id}">${group.label} <span class="tab-count" aria-hidden="true">${packageCount(group.projects)}</span></button>`).join('\n');
 const panels=projectGroups.map((group,position)=>{
  const rows=group.projects.flatMap(project=>project.releases.map((release,releasePosition)=>`<tr data-package data-project="${escape(project.projectId)}" data-delivery="${group.id}"${releasePosition===0?' id="'+escape(project.projectId)+'"':''}><td><strong>${escape(project.name)}</strong><span class="secondary">${escape(project.projectId)}</span>${release.profile?'<span class="profile"'+profileAnchor(release.anchor)+'>'+escape(release.profile)+'</span>':''}</td><td><code>${escape(release.version)}</code></td><td>${platform(release)}</td><td><a class="download" href="${escape(release.asset.url)}">${group.id==='bundled'?'Archive':'Download'} <span>${size(release.asset.bytes)}</span></a><div class="links"><a href="https://github.com/${escape(index.repository)}/tree/${encodeURIComponent(release.tag)}">Source</a> · <a href="${escape(project.catalog.url)}">Catalog</a></div><details><summary>SHA-256</summary><code>${escape(release.asset.sha256)}</code></details>${buildLinks(index.repository,release)}</td></tr>`)).join('\n');
  return `<section role="tabpanel" id="panel-${group.id}" aria-labelledby="tab-${group.id}" data-panel data-delivery="${group.id}"${position?' hidden':''}><p class="group-description">${group.description}</p><div class="table-scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version</th><th scope="col">Platform</th><th scope="col">Files</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
 }).join('\n');
 const first=projectGroups[0];
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>MacLauncher packages</title><link rel="icon" href="data:,"><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--muted:#626b75;--line:#d9dee4;--accent:#075fc0;--selected:#edf4fc}*{box-sizing:border-box}body{margin:0 auto;padding:48px 24px;max-width:1280px;line-height:1.5}h1{font-size:2rem;letter-spacing:-.035em;margin:0 0 12px}p{max-width:78ch}a{color:var(--accent);text-underline-offset:3px}nav{display:flex;gap:24px;flex-wrap:wrap;margin:20px 0 32px}label{display:block;font-weight:600}input{font:inherit;width:100%;max-width:560px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}#count,.secondary,.links,details{color:var(--muted);font-size:.86rem}.secondary{display:block;font-weight:400;margin:4px 0}.group-tabs{display:flex;gap:8px;overflow-x:auto;margin:0 0 24px;padding:2px 2px 8px}.group-tabs button{font:inherit;font-weight:600;white-space:nowrap;cursor:pointer;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;padding:10px 14px}.group-tabs button[aria-selected=true]{background:var(--selected);border-color:var(--accent);color:var(--accent)}.group-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.tab-count{font-size:.8rem;font-weight:400;margin-left:10px}.group-description{margin:18px 0 0}.table-scroll{overflow:auto;margin-top:16px}table{border-collapse:collapse;width:100%;min-width:750px;text-align:left}th,td{padding:16px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}td:first-child{min-width:240px}[id]{scroll-margin-top:20px}td:nth-child(2){max-width:350px;overflow-wrap:anywhere}code{font: .85rem ui-monospace,SFMono-Regular,Menlo,monospace}.download{white-space:nowrap;font-weight:600}.download span{font-size:.85rem;font-weight:400}.links{margin-top:8px}details{margin-top:8px}details code{display:block;max-width:250px;overflow-wrap:anywhere;margin-top:6px}.profile{font-size:.8rem;display:inline-block;border:1px solid var(--line);border-radius:5px;padding:2px 6px;margin:5px 0}footer{font-size:.86rem;color:var(--muted);margin-top:32px}@media(prefers-color-scheme:dark){:root{--muted:#a5adb7;--line:#39424d;--accent:#8abfff;--selected:#172b42}}[hidden]{display:none!important}
</style><noscript><style>[data-panel][hidden]{display:block!important}</style></noscript></head><body><header><h1>MacLauncher packages</h1><p>Versioned macOS binaries for <a href="https://github.com/procrastinine/maclauncher">MacLauncher</a>, with public build recipes and supplied-file inventories.</p><nav aria-label="Package references"><a href="https://github.com/${escape(index.repository)}">Repository</a><a href="https://github.com/${escape(index.repository)}/blob/main/docs/PACKAGES.md">Package reference</a><a href="verification.html">Verify packages</a><a href="index.json">JSON index</a></nav></header><main><div class="group-tabs" role="tablist" aria-label="Package delivery">${tabs}</div><label for="search">Find a package</label><input id="search" type="search" placeholder="Runtime, version, ABI or architecture" autocomplete="off"><p id="count" role="status">${packageCount(first.projects)} packages · ${first.projects.length} projects</p>${panels}<p id="empty" hidden>No matching packages in this group.</p></main><footer>Archives have immutable versions and checksums. HashLink and Java Steamworks retain separate game ABI profiles.</footer><script>
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
const archiveIdentity=({filename,sha256,bytes})=>({filename,sha256,bytes});
export function verificationIndex(index,directory=root,coverage){
 if(!coverage)throw Error('Verified GitHub build coverage is required.');
 const packages=coverage.githubBuilds.map(row=>({projectId:row.projectId,name:row.name,version:row.version,arch:row.arch,minimumMacOS:row.minimumMacOS,asset:row.asset,origin:'github',state:'published',
  recipe:{url:'https://github.com/'+index.repository+'/tree/'+row.sourceRevision,commit:row.sourceRevision},build:{runId:row.runId,url:row.runUrl},
  attestation:{...row.attestation,verified:false,command:verifyCommand(index.repository,row.asset.filename)},rebuild:row.record.rebuild||{status:'not-recorded'}}));
 const supplied=coverage.publisherPackages.map(row=>({projectId:row.projectId,name:row.name,version:row.version,arch:row.arch,minimumMacOS:row.minimumMacOS,
  asset:row.catalogPublished?row.asset:archiveIdentity(row.asset),origin:'supplied-publisher',state:row.catalogPublished?'publisher-published':'publisher-awaiting-publication',
  catalogPublished:row.catalogPublished,publisherProof:row.publisherProof}));
 return {schemaVersion:2,repository:index.repository,summary:coverage.summary,projects:coverage.projects,publisherProjects:coverage.publisherProjects,
  packages:[...packages,...supplied],projectsWithoutGithubBuild:coverage.projectsWithoutGithubBuild,projectsWithoutPublisherProof:coverage.projectsWithoutPublisherProof,projectsWithoutAuthority:coverage.projectsWithoutAuthority};
}
export function renderVerification(index){
 const guide='https://github.com/'+index.repository+'/blob/main/VERIFYING.md';
 const status={match:'Byte-for-byte match',different:'Archive bytes differ',unavailable:'Rebuild unavailable','not-recorded':'Not recorded'};
 const projectList=projects=>'<ul>'+projects.map(project=>'<li><strong>'+escape(project.name||project.projectId)+'</strong> <code>'+escape(project.projectId)+'</code>'+(project.authorityPolicy==='supplied-publisher'?' · Supplied files'+(project.hasPublisherProof===false?' proof missing':project.hasPublisherProof===true?' proof available':''):'')+'</li>').join('')+'</ul>';
 const table=records=>{
  const rows=records.map(record=>{
   const rebuild=record.rebuild,label=status[rebuild.status]||'Not recorded',report=typeof rebuild.reportUrl==='string'&&rebuild.reportUrl.startsWith('https://')?rebuild.reportUrl:undefined;
   return `<tr data-verification-state="${escape(record.state)}"><td><a href="${escape(record.asset.url)}">${escape(record.name||record.projectId)}</a><small>${escape(record.projectId)}</small></td><td><code>${escape(record.version)}</code><small>SHA-256: ${escape(record.asset.sha256)}</small></td><td>${escape(record.arch)}</td><td>${record.minimumMacOS?escape(record.minimumMacOS)+'+':'Not recorded'}</td><td><a href="${escape(record.recipe.url)}"><code>${escape(record.recipe.commit.slice(0,12))}</code></a></td><td><a href="${escape(record.build.url)}">${escape(record.build.runId)}</a></td><td>${record.attestation.verified?'Verified · ':''}<a href="${escape(record.attestation.url)}">Find build record</a><details><summary>Verify the archive</summary><code>${escape(record.attestation.command)}</code></details></td><td>${report?'<a href="'+escape(report)+'">'+escape(label)+'</a>':escape(label)}${rebuild.summary?'<small>'+escape(rebuild.summary)+'</small>':''}</td></tr>`;
  }).join('\n');
  return `<div class="scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version and archive</th><th scope="col">CPU</th><th scope="col">Minimum macOS</th><th scope="col">Recipe commit</th><th scope="col">Build run</th><th scope="col">Build record</th><th scope="col">Rebuild result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
 };
 const publisherTable=records=>{
  const rows=records.map(record=>{
   const proof=record.publisherProof,target=record.state==='publisher-published'?record.asset.url:proof.publisherRecord;
   const title=target?'<a href="'+escape(target)+'">'+escape(record.name||record.projectId)+'</a>':escape(record.name||record.projectId);
   return `<tr data-verification-state="${escape(record.state)}"><td>${title}<small>${escape(record.projectId)}</small><small>${record.catalogPublished?'Published':'Awaiting publication'}</small></td><td><code>${escape(record.version)}</code><small>SHA-256: ${escape(record.asset.sha256)}</small></td><td>${escape(record.arch)}</td><td>${record.minimumMacOS?escape(record.minimumMacOS)+'+':'Not recorded'}</td><td>${escape(proof.publisherVersion)}</td><td>${escape(proof.publisherFiles)} unchanged files</td><td><a href="${escape(proof.publisherInput)}">Input inventory</a><small><a href="${escape(proof.publisherRecord)}">Equality record</a></small></td><td>Not established by file equality</td></tr>`;
  }).join('\n');
  return `<div class="scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version and archive</th><th scope="col">CPU</th><th scope="col">Minimum macOS</th><th scope="col">Publisher version</th><th scope="col">Supplied files</th><th scope="col">Equality proof</th><th scope="col">Publisher authentication</th></tr></thead><tbody>${rows}</tbody></table></div>`;
 };
 const published=index.packages.filter(record=>record.state==='published'),supplied=index.packages.filter(record=>record.origin==='supplied-publisher');
 const {summary,publisherProjects,projectsWithoutGithubBuild:awaiting,projectsWithoutPublisherProof:missingPublisher,projectsWithoutAuthority:missingAuthority}=index;
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>MacLauncher package verification</title><link rel="icon" href="data:,"><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}body{max-width:1600px;padding:40px 24px;margin:auto;line-height:1.5}h1{letter-spacing:-.03em}h2{margin-top:36px}p{max-width:90ch}a{color:light-dark(#075fc0,#8abfff);text-underline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:24px;margin:24px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:1150px;text-align:left}th,td{padding:14px 12px;border-bottom:1px solid light-dark(#d9dee4,#39424d);vertical-align:top}th{font-size:.85rem}code{font:.85rem ui-monospace,SFMono-Regular,Menlo,monospace}small{display:block;font-size:.8rem;max-width:30ch;overflow-wrap:anywhere;color:light-dark(#626b75,#a5adb7);margin-top:4px}footer{margin-top:24px;font-size:.86rem}.count{font-size:.8em;font-weight:400}
</style></head><body><header><h1>Package verification</h1><p>A recipe is the public instructions and patches that turn a project's source into a Mac package. Build jobs attest each archive digest with <code>runtime-build.yml</code>. The links and commands below verify that provenance through GitHub. Registered unmodified publisher files use a separate complete file-equality proof. Publication records the archive digest; signature verification is performed by consumers.</p><nav aria-label="Verification references"><a href="${escape(guide)}">How to verify a package</a><a href="index.html">Package downloads</a><a href="verification.json">Verification JSON</a><a href="https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md">App feature requirements</a></nav></header><main><section aria-labelledby="build-coverage"><h2 id="build-coverage">Projects without required verification <span class="count">(${missingAuthority.length})</span></h2><p>${escape(summary.projectsWithGithubBuild)} of ${escape(summary.projectsRequiringGithubBuild)} projects requiring GitHub builds have all current version and CPU outputs published. ${escape(summary.suppliedPublisherProjects)} of ${publisherProjects.length} registered supplied-file projects have verified file equality. GitHub builds missing: ${awaiting.length}; supplied-file proofs missing: ${missingPublisher.length}.</p>${missingAuthority.length?projectList(missingAuthority):'<p>Every project has its required verification.</p>'}</section><section aria-labelledby="github-published"><h2 id="github-published">Published GitHub packages <span class="count">(${published.length} archives)</span></h2>${published.length?table(published):'<p>No catalog archive has a recorded GitHub build.</p>'}</section><section aria-labelledby="supplied-files"><h2 id="supplied-files">Unchanged supplied files <span class="count">(${supplied.length} packages)</span></h2><p>These packages retain the registered supplied application files, including their bytes and modes. Package metadata and notices can differ. This route establishes file equality with a declared input, not a GitHub build or publisher authentication. An ad-hoc code signature is not a Developer ID signature and does not authenticate a publisher.</p>${supplied.length?publisherTable(supplied):'<p>No package has a verified supplied-file equality record.</p>'}${publisherProjects.length?'<details><summary>Registered supplied-file projects ('+publisherProjects.length+')</summary>'+projectList(publisherProjects)+'</details>':''}</section><p>Each CPU build has its own row: <code>arm64</code> for Apple Silicon, <code>x64</code> for Intel and <code>universal</code> for both. Minimum macOS comes from the native package's recorded requirement, separately from its build SDK. A recipe commit identifies this repository; an engine's upstream commit is a different identity.</p></main><footer>Generated from catalog records, recorded GitHub build metadata and registered supplied-file equality records. A rebuild result describes one comparison; it does not establish a GitHub build record.</footer></body></html>\n`;
}

export async function buildIndex({directory=root,output}){
 if(!output)throw Error('An output directory is required.');
 const coverage=await buildCoverage(directory),index=catalogIndex(directory,{coverage});fs.mkdirSync(output,{recursive:true});
 if(fs.realpathSync(output)===fs.realpathSync(directory))throw Error('Package index output must be separate from its source tree.');
 fs.writeFileSync(path.join(output,'index.json'),JSON.stringify(index,null,2)+'\n');fs.writeFileSync(path.join(output,'index.html'),renderIndex(index));fs.writeFileSync(path.join(output,'.nojekyll'),'');
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
 if(args.length!==2||args[0]!=='--output')throw Error('Use --output <directory>.');return buildIndex({output:args[1]});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
