import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {catalogIndex} from './release-runtime.mjs';
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
export function renderIndex(index){
 if(index.projects.some(project=>!groups.some(group=>group.id===project.delivery)))throw Error('Every indexed project requires a delivery classification.');
 const anchors=new Set(index.projects.map(project=>project.projectId));
 const profileAnchor=anchor=>{if(!anchor||anchors.has(anchor))return '';anchors.add(anchor);return ' id="'+escape(anchor)+'"';};
 const projectGroups=groups.map(group=>({...group,projects:index.projects.filter(project=>project.delivery===group.id)}));
 const packageCount=projects=>projects.reduce((total,project)=>total+project.releases.length,0);
 const tabs=projectGroups.map((group,position)=>`<button type="button" role="tab" id="tab-${group.id}" aria-controls="panel-${group.id}" aria-selected="${position===0}" tabindex="${position===0?0:-1}" data-group="${group.id}">${group.label} <span class="tab-count" aria-hidden="true">${packageCount(group.projects)}</span></button>`).join('\n');
 const panels=projectGroups.map((group,position)=>{
  const rows=group.projects.flatMap(project=>project.releases.map((release,releasePosition)=>`<tr data-package data-project="${escape(project.projectId)}" data-delivery="${group.id}"${releasePosition===0?' id="'+escape(project.projectId)+'"':''}><td><strong>${escape(project.name)}</strong><span class="secondary">${escape(project.projectId)}</span>${release.profile?'<span class="profile"'+profileAnchor(release.anchor)+'>'+escape(release.profile)+'</span>':''}</td><td><code>${escape(release.version)}</code></td><td>${platform(release)}</td><td><a class="download" href="${escape(release.asset.url)}">${group.id==='bundled'?'Archive':'Download'} <span>${size(release.asset.bytes)}</span></a><div class="links"><a href="https://github.com/${escape(index.repository)}/tree/${encodeURIComponent(release.tag)}">Source</a> · <a href="${escape(project.catalog.url)}">Catalog</a></div><details><summary>SHA-256</summary><code>${escape(release.asset.sha256)}</code></details></td></tr>`)).join('\n');
  return `<section role="tabpanel" id="panel-${group.id}" aria-labelledby="tab-${group.id}" data-panel data-delivery="${group.id}"${position?' hidden':''}><p class="group-description">${group.description}</p><div class="table-scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version</th><th scope="col">Platform</th><th scope="col">Files</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
 }).join('\n');
 const first=projectGroups[0];
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>MacLauncher packages</title><link rel="icon" href="data:,"><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--muted:#626b75;--line:#d9dee4;--accent:#075fc0;--selected:#edf4fc}*{box-sizing:border-box}body{margin:0 auto;padding:48px 24px;max-width:1280px;line-height:1.5}h1{font-size:2rem;letter-spacing:-.035em;margin:0 0 12px}p{max-width:78ch}a{color:var(--accent);text-underline-offset:3px}nav{display:flex;gap:24px;flex-wrap:wrap;margin:20px 0 32px}label{display:block;font-weight:600}input{font:inherit;width:100%;max-width:560px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}#count,.secondary,.links,details{color:var(--muted);font-size:.86rem}.secondary{display:block;font-weight:400;margin:4px 0}.group-tabs{display:flex;gap:8px;overflow-x:auto;margin:0 0 24px;padding:2px 2px 8px}.group-tabs button{font:inherit;font-weight:600;white-space:nowrap;cursor:pointer;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;padding:10px 14px}.group-tabs button[aria-selected=true]{background:var(--selected);border-color:var(--accent);color:var(--accent)}.group-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.tab-count{font-size:.8rem;font-weight:400;margin-left:10px}.group-description{margin:18px 0 0}.table-scroll{overflow:auto;margin-top:16px}table{border-collapse:collapse;width:100%;min-width:750px;text-align:left}th,td{padding:16px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}td:first-child{min-width:240px}[id]{scroll-margin-top:20px}td:nth-child(2){max-width:350px;overflow-wrap:anywhere}code{font: .85rem ui-monospace,SFMono-Regular,Menlo,monospace}.download{white-space:nowrap;font-weight:600}.download span{font-size:.85rem;font-weight:400}.links{margin-top:8px}details{margin-top:8px}details code{display:block;max-width:250px;overflow-wrap:anywhere;margin-top:6px}.profile{font-size:.8rem;display:inline-block;border:1px solid var(--line);border-radius:5px;padding:2px 6px;margin:5px 0}footer{font-size:.86rem;color:var(--muted);margin-top:32px}@media(prefers-color-scheme:dark){:root{--muted:#a5adb7;--line:#39424d;--accent:#8abfff;--selected:#172b42}}[hidden]{display:none!important}
</style><noscript><style>[data-panel][hidden]{display:block!important}</style></noscript></head><body><header><h1>MacLauncher packages</h1><p>Versioned macOS binaries for <a href="https://github.com/procrastinine/maclauncher">MacLauncher</a>, with matching source and patches at each release tag.</p><nav aria-label="Package references"><a href="https://github.com/${escape(index.repository)}">Repository</a><a href="https://github.com/${escape(index.repository)}/blob/main/docs/PACKAGES.md">Package reference</a><a href="verification.html">Verify packages</a><a href="index.json">JSON index</a></nav></header><main><div class="group-tabs" role="tablist" aria-label="Package delivery">${tabs}</div><label for="search">Find a package</label><input id="search" type="search" placeholder="Runtime, version, ABI or architecture" autocomplete="off"><p id="count" role="status">${packageCount(first.projects)} packages · ${first.projects.length} projects</p>${panels}<p id="empty" hidden>No matching packages in this group.</p></main><footer>Archives have immutable versions and checksums. HashLink and Java Steamworks retain separate game ABI profiles.</footer><script>
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
// Verification pages use the committed catalogs, without GitHub requests or
// assumptions about the provenance of older releases.
export function verificationIndex(index,directory=root){
 const packages=index.projects.flatMap(project=>{
  const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalogs',project.projectId+'.json')));
  return project.releases.map(release=>{
   const record=catalog.packages.find(row=>row.version===release.version&&row.arch===release.arch),build=record.build,rebuild=record.rebuild;
   const recipeCommit=/^[a-f0-9]{40}$/.test(build?.sourceRevision||'')?build.sourceRevision:record.source?.repository===index.repository?record.source.revision:undefined;
   const runId=/^[1-9][0-9]{0,19}$/.test(String(build?.runId||''))?String(build.runId):undefined;
   const attestationUrl='https://api.github.com/repos/'+index.repository+'/attestations/sha256:'+release.asset.sha256;
   return {projectId:project.projectId,name:project.name,version:release.version,arch:release.arch,minimumMacOS:record.minimumMacOS,asset:release.asset,
    recipe:{url:'https://github.com/'+index.repository+'/tree/'+encodeURIComponent(recipeCommit||release.tag),...(recipeCommit?{commit:recipeCommit}:{tag:release.tag})},
    ...(runId?{build:{runId,url:'https://github.com/'+index.repository+'/actions/runs/'+runId}}:{}),
    attestation:{url:attestationUrl},
    rebuild:rebuild||{status:'not-recorded'}};
  });
 });
 return {schemaVersion:1,repository:index.repository,packages};
}
export function renderVerification(index){
 const guide='https://github.com/'+index.repository+'/blob/main/VERIFYING.md';
 const status={match:'Byte-for-byte match',different:'Archive bytes differ',unavailable:'Rebuild unavailable','not-recorded':'Not recorded'};
 const rows=index.packages.map(record=>{
  const rebuild=record.rebuild,label=status[rebuild.status]||'Not recorded',report=typeof rebuild.reportUrl==='string'&&rebuild.reportUrl.startsWith('https://')?rebuild.reportUrl:undefined;
  return `<tr><td><a href="${escape(record.asset.url)}">${escape(record.name)}</a><small>${escape(record.projectId)}</small></td><td><code>${escape(record.version)}</code></td><td>${escape(record.arch)}</td><td>${escape(record.minimumMacOS)}+</td><td><a href="${escape(record.recipe.url)}">${record.recipe.commit?'<code>'+escape(record.recipe.commit.slice(0,12))+'</code>':'Tagged source'}</a>${record.recipe.commit?'':'<small>Commit not recorded</small>'}</td><td>${record.build?'<a href="'+escape(record.build.url)+'">'+escape(record.build.runId)+'</a>':'Not recorded'}</td><td><a href="${escape(record.attestation.url)}">Find build record</a></td><td>${report?'<a href="'+escape(report)+'">'+escape(label)+'</a>':escape(label)}${rebuild.summary?'<small>'+escape(rebuild.summary)+'</small>':''}</td></tr>`;
 }).join('\n');
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>MacLauncher package verification</title><link rel="icon" href="data:,"><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}body{max-width:1440px;padding:40px 24px;margin:auto;line-height:1.5}h1{letter-spacing:-.03em}p{max-width:85ch}a{color:light-dark(#075fc0,#8abfff);text-underline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:24px;margin:24px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:1050px;text-align:left}th,td{padding:14px 12px;border-bottom:1px solid light-dark(#d9dee4,#39424d);vertical-align:top}th{font-size:.85rem}code{font:.85rem ui-monospace,SFMono-Regular,Menlo,monospace}small{display:block;font-size:.8rem;max-width:30ch;color:light-dark(#626b75,#a5adb7);margin-top:4px}footer{margin-top:24px;font-size:.86rem}
</style></head><body><header><h1>Package verification</h1><p>This page lists every package that MacLauncher Builds has published, with the evidence of how each one was built. A package comes from a recipe: the instructions and patches in this repository that turn a project's source code into a Mac package. GitHub builds each package and signs a build record, called an attestation, that names the recipe commit and the build run behind the archive.</p><nav aria-label="Verification references"><a href="${escape(guide)}">How to verify a package</a><a href="index.html">Package downloads</a><a href="verification.json">Verification JSON</a><a href="https://github.com/procrastinine/maclauncher/blob/master/docs/runtimes/SYSTEM_REQUIREMENTS.md">App feature requirements</a></nav></header><main><p>Each CPU build has its own row: <code>arm64</code> for Apple Silicon, <code>x64</code> for Intel and <code>universal</code> for both. The minimum macOS version is the one recorded for the complete package, which can differ from the SDK it was built with. The recipe commit is the commit of this repository that built the package, which is a different value from the engine's own upstream commit.</p><p>“Find build record” searches GitHub for an attestation that matches the archive's SHA-256; the link appears on every row, whether or not such a record exists. “Not recorded” marks a build run or rebuild result that was never recorded, as for some older packages. The verification guide shows the command that checks the record's signature, workflow, commit and type of build machine.</p><div class="scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version</th><th scope="col">CPU</th><th scope="col">Minimum macOS</th><th scope="col">Recipe commit</th><th scope="col">Build run</th><th scope="col">Build record</th><th scope="col">Rebuild result</th></tr></thead><tbody>${rows}</tbody></table></div></main><footer>Generated from the same catalogs as the package downloads. “Byte-for-byte match” describes one recorded rebuild, and “Not recorded” says nothing about whether a rebuild would match.</footer></body></html>\n`;
}

export function buildIndex({directory=root,output}){
 if(!output)throw Error('An output directory is required.');
 const index=catalogIndex(directory);fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'index.json'),JSON.stringify(index,null,2)+'\n');fs.writeFileSync(path.join(output,'index.html'),renderIndex(index));fs.writeFileSync(path.join(output,'.nojekyll'),'');
 const verification=verificationIndex(index,directory);fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(verification,null,2)+'\n');fs.writeFileSync(path.join(output,'verification.html'),renderVerification(verification));
 return{projects:index.projects.length,packages:index.projects.reduce((total,p)=>total+p.releases.length,0),output:path.resolve(output)};
}
export function main(args){if(args.length!==2||args[0]!=='--output')throw Error('Use --output <directory>.');return buildIndex({output:args[1]});}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(main(process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
