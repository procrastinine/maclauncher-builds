export const escape=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
export function verifyCommand(repository,filename){
 return 'gh attestation verify '+filename+' --repo '+repository+' --signer-workflow '+
  repository+'/.github/workflows/runtime-build.yml --deny-self-hosted-runners';
}
function buildLinks(repository,release){
 if(!release.build?.sourceRevision||!release.build?.runId)return '';
 const revision=escape(release.build.sourceRevision),run=escape(release.build.runId);
 return '<p>Built from <a href="https://github.com/'+escape(repository)+'/tree/'+revision+'">'+
  revision.slice(0,12)+'</a> by <a href="https://github.com/'+escape(repository)+'/actions/runs/'+run+'">'+
  'build '+run+'</a>.</p><details><summary>Verify the archive</summary><code>'+
  escape(verifyCommand(repository,release.asset.filename))+'</code></details>';
}
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
function changeDetails(entry,repository){
 if(!entry)return '<p>No generated changes are recorded.</p>';
 const items=entry.inputs.map(input=>{
  const before=escape(JSON.stringify(input.before)),after=escape(JSON.stringify(input.after));
  return '<li>'+escape(input.name)+': '+before+' → '+after+'</li>';
 }).join('');
 const commits=entry.commits.map(commit=>{
  const origin=commit.repository||'https://github.com/'+repository;
  const url=escape(origin.replace(/\.git$/,''))+'/commit/'+escape(commit.revision);
  const label=commit.repository?commit.repository.replace(/^https:\/\/github.com\//,'')+': ':'';
  return '<li><a href="'+url+'">'+escape(label+commit.subject)+'</a></li>';
 }).join('');
 const unrecorded=(entry.unrecordedInputs||[]).map(input=>
  escape(input.name+': '+input.reason)).join(', ');
 const since=entry.previousVersion?'Since '+escape(entry.previousVersion):'First published version; recorded source inputs.';
 return (entry.notes?'<div class="release-notes">'+renderNotes(entry.notes)+'</div>':'')+
  '<h3>Generated changes</h3><p>'+since+'</p>'+
  (items?'<ul>'+items+'</ul>':'')+(commits?'<ul>'+commits+'</ul>':'')+
  (unrecorded?'<p>Inputs without a recorded pin: '+unrecorded+'</p>':'');
}

const styles=String.raw`
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;
 --muted:#626b75;--line:#d9dee4;--accent:#075fc0}
*{box-sizing:border-box}body{margin:0 auto;padding:48px 24px;max-width:1280px;line-height:1.5}
h1{font-size:2rem;letter-spacing:-.035em;margin:0 0 12px}h2{margin-top:32px}p{max-width:78ch}
a{color:var(--accent);text-underline-offset:3px}
nav,.downloads{display:flex;gap:16px;flex-wrap:wrap}nav{margin:20px 0 32px}
.secondary,.links,details{color:var(--muted);font-size:.86rem}
.secondary{display:block;font-weight:400;margin:4px 0}.table-scroll{overflow:auto;margin-top:16px}
table{border-collapse:collapse;width:100%;min-width:650px;text-align:left}
th,td{padding:16px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
td:first-child{min-width:200px}[id]{scroll-margin-top:20px}
code{font:.85rem ui-monospace,SFMono-Regular,Menlo,monospace}
.download{white-space:nowrap;font-weight:600}.download span{font-size:.85rem;font-weight:400}
.links,details{margin-top:8px}details code{display:block;max-width:300px;overflow-wrap:anywhere;margin-top:6px}
.changes li{overflow-wrap:anywhere}.release{margin-top:36px}.release-notes{font-size:1rem}
.project-alias{display:block}.release h3{font-size:1rem}footer{font-size:.86rem;color:var(--muted);margin-top:32px}
@media(prefers-color-scheme:dark){:root{--muted:#a5adb7;--line:#39424d;--accent:#8abfff}}
`;

function inlineMarkdown(text){
 return escape(text).replace(/`([^`]+)`/g,'<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
  .replace(/\*([^*]+)\*/g,'<em>$1</em>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2">$1</a>');
}

function renderNotes(text){
 return text.split(/\r?\n\s*\r?\n/).map(block=>{
  const lines=block.split(/\r?\n/);
  if(lines.every(line=>/^[-*] /.test(line))){
   return '<ul>'+lines.map(line=>'<li>'+inlineMarkdown(line.slice(2))+'</li>').join('')+'</ul>';
  }
  return '<p>'+inlineMarkdown(block).replace(/\r?\n/g,'<br>')+'</p>';
 }).join('');
}

function shell(title,body,{script='',back=false}={}){
 const prefix=back?'../':'';
 return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'+
  '<meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<meta name="color-scheme" content="light dark"><title>'+escape(title)+'</title>'+
  '<link rel="icon" href="data:,"><style>'+styles+'</style></head><body>'+body+
  '<footer><a href="'+prefix+'verification.html">Package verification</a></footer>'+script+'</body></html>\n';
}

function aliases(project,used){
 return [...new Set(project.releases.map(release=>release.anchor).filter(Boolean))].filter(anchor=>{
  if(used.has(anchor))return false;used.add(anchor);return true;
 }).map(anchor=>'<span class="project-alias" id="'+escape(anchor)+'"></span>').join('');
}

function downloads(releases,delivery){
 return releases.map(release=>{
  const arch={arm64:'Apple Silicon',x64:'Intel',universal:'Universal'}[release.arch]||release.arch;
  return '<a class="download" href="'+escape(release.asset.url)+'">'+
   (delivery==='bundled'?'Archive':'Download')+' · '+escape(arch)+' <span>'+size(release.asset.bytes)+'</span></a>';
 }).join(' ');
}

export function renderIndex(index){
 if(index.projects.some(project=>!groups.some(group=>group.id===project.delivery)))throw Error('Every indexed project requires a delivery classification.');
 const used=new Set(index.projects.map(project=>project.projectId));
 const panels=groups.map(group=>{
  const projects=index.projects.filter(project=>project.delivery===group.id);
  const rows=projects.map(project=>{
   const latest=project.releases[0].version;
   const releases=project.releases.filter(release=>release.version===latest);
   return '<tr data-project="'+escape(project.projectId)+'" id="'+escape(project.projectId)+'">'+
    '<td>'+aliases(project,used)+'<a data-package-page href="packages/'+escape(project.projectId)+'.html">'+
    '<strong>'+escape(project.name)+'</strong></a><span class="secondary">'+escape(project.projectId)+'</span></td>'+
    '<td>'+(group.id==='bundled'?'Included':'Downloadable')+'</td><td><code>'+escape(latest)+'</code></td>'+
    '<td><div class="downloads">'+downloads(releases,group.id)+'</div></td></tr>';
  }).join('\n');
  return '<section><h2>'+escape(group.label)+'</h2><p>'+escape(group.description)+'</p>'+
   '<div class="table-scroll"><table><thead><tr><th>Package</th><th>Delivery</th><th>Latest version</th><th>Downloads</th></tr></thead>'+
   '<tbody>'+rows+'</tbody></table></div></section>';
 }).join('\n');
 const header='<header><h1>MacLauncher packages</h1><p>Versioned macOS binaries for '+
  '<a href="https://github.com/procrastinine/maclauncher">MacLauncher</a>. Each package page lists its versions and changes.</p>'+
  '<nav aria-label="Package references"><a href="https://github.com/'+escape(index.repository)+'">Repository</a>'+
  '<a href="https://github.com/'+escape(index.repository)+'/blob/main/docs/PACKAGES.md">Package reference</a>'+
  '<a href="verification.html">Verify packages</a><a href="index.json">JSON index</a></nav></header>';
 const script=`<script>
function forwardPackage(){
 let id;try{id=decodeURIComponent(window.location.hash.slice(1));}catch{return;}
 if(!id)return;
 const row=document.getElementById(id)?.closest('[data-project]');
 const link=row?.querySelector('[data-package-page]');
 if(link)window.location.replace(link.getAttribute('href')+(id===row.dataset.project?'':'#'+encodeURIComponent(id)));
}
window.addEventListener('hashchange',forwardPackage);forwardPackage();
</script>`;
 return shell('MacLauncher packages',header+'<main>'+panels+'</main>',{script});
}

export function renderPackagePage(project,changes,catalog,repository){
 const entries=new Map(changes.releases.map(release=>[release.version,release]));
 const versions=[...new Set(catalog.packages.map(release=>release.version))];
 const used=new Set();
 const sections=versions.map(version=>{
  const releases=project.releases.filter(release=>release.version===version);
  const entry=entries.get(version);
  const alias=aliases({releases},used);
  const files=releases.map(release=>{
   const source='https://github.com/'+repository+'/tree/'+encodeURIComponent(release.tag);
   return '<tr><td>'+platform(release)+'</td><td>'+downloads([release],project.delivery)+
    '<div class="links"><a href="'+escape(source)+'">Source</a></div>'+
    '<details><summary>SHA-256</summary><code>'+escape(release.asset.sha256)+'</code></details>'+
    buildLinks(repository,release)+'</td></tr>';
  }).join('');
  return '<section class="release" data-version="'+escape(version)+'" id="version-'+escape(version)+'">'+
   alias+'<h2>'+escape(version)+'</h2><div class="table-scroll"><table><thead><tr><th>Platform</th><th>Files</th></tr></thead>'+
   '<tbody>'+files+'</tbody></table></div><div class="changes">'+changeDetails(entry,repository)+'</div></section>';
 }).join('\n');
 const header='<header><a href="../index.html">All packages</a><h1>'+escape(project.name)+'</h1>'+
  '<p>'+escape(project.projectId)+' · '+(project.delivery==='bundled'?'Included component':'Downloadable package')+'</p></header>';
 const footer='<nav aria-label="JSON downloads"><a href="../catalogs/'+escape(project.projectId)+'.json">Catalog JSON</a>'+
  '<a href="../changes/'+escape(project.projectId)+'.json">Project changes JSON</a>'+
  '<a href="../changes.json">Combined changes JSON</a></nav>';
 return shell(project.name+' versions',header+'<main>'+sections+'</main>'+footer,{back:true});
}
