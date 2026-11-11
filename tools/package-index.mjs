import './producer-environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {canonicalReport} from '../lib/canonical-report.mjs';
import {packageChanges} from '../lib/package-changes.mjs';
import {catalogIndex} from './release-runtime.mjs';
import {buildCoverage} from './build-coverage.mjs';
import {readProjects} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
import {escape,verifyCommand,renderIndex,renderPackagePage,orderedArchitectures} from './package-pages.mjs';
export {renderIndex,renderPackagePage} from './package-pages.mjs';
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
  const rows=orderedArchitectures(records).map(record=>{
   const rebuild=record.rebuild,label=status[rebuild.status]||'Not recorded',report=typeof rebuild.reportUrl==='string'&&rebuild.reportUrl.startsWith('https://')?rebuild.reportUrl:undefined;
   return `<tr data-verification-state="${escape(record.state)}"><td><a href="${escape(record.asset.url)}">${escape(record.name||record.projectId)}</a><small>${escape(record.projectId)}</small></td><td><code>${escape(record.version)}</code><small>SHA-256: ${escape(record.asset.sha256)}</small></td><td>${escape(record.arch)}</td><td>${record.minimumMacOS?escape(record.minimumMacOS)+'+':'Not recorded'}</td><td><a href="${escape(record.recipe.url)}"><code>${escape(record.recipe.commit.slice(0,12))}</code></a></td><td><a href="${escape(record.build.url)}">${escape(record.build.runId)}</a></td><td>${record.attestation.verified?'Verified · ':''}<a href="${escape(record.attestation.url)}">Find build record</a><details><summary>Verify the archive</summary><code>${escape(record.attestation.command)}</code></details></td><td>${report?'<a href="'+escape(report)+'">'+escape(label)+'</a>':escape(label)}${rebuild.summary?'<small>'+escape(rebuild.summary)+'</small>':''}</td></tr>`;
  }).join('\n');
  return `<div class="scroll"><table><thead><tr><th scope="col">Package</th><th scope="col">Version and archive</th><th scope="col">CPU</th><th scope="col">Minimum macOS</th><th scope="col">Recipe commit</th><th scope="col">Build run</th><th scope="col">Build record</th><th scope="col">Rebuild result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
 };
 const publisherTable=records=>{
  const rows=orderedArchitectures(records).map(record=>{
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

function writeProjectPages(directory,output,index,changes){
 const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(JSON.parse(canonicalReport(value)),null,2)+'\n');
 write(path.join(output,'changes.json'),changes);
 const paths={changes:path.join(output,'changes'),packages:path.join(output,'packages')};
 for(const target of Object.values(paths)){
  if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Generated package files require ordinary directories.');
  fs.mkdirSync(target,{recursive:true});
 }
 const ids=new Set(changes.projects.map(project=>project.projectId));
 for(const [kind,target] of Object.entries(paths)){
  const extension=kind==='changes'?'.json':'.html';
  for(const file of fs.readdirSync(target)){
   if(file.endsWith(extension)&&!ids.has(file.slice(0,-extension.length)))fs.unlinkSync(path.join(target,file));
  }
 }
 const registry=readProjects(directory,{resolvePins:false});
 for(const change of changes.projects){
  write(path.join(paths.changes,change.projectId+'.json'),{schemaVersion:changes.schemaVersion,...change});
  const registered=registry.projects.find(project=>project.id===change.projectId);
  const project=index.projects.find(project=>project.projectId===change.projectId)||
   {projectId:change.projectId,name:registered?.name||change.projectId,delivery:registered?.delivery,releases:[]};
  const catalog=JSON.parse(fs.readFileSync(path.join(directory,'catalogs',change.projectId+'.json')));
  fs.writeFileSync(path.join(paths.packages,change.projectId+'.html'),renderPackagePage(project,change,catalog,index.repository));
 }
}

export async function buildIndex({directory=root,output}){
 if(!output)throw Error('An output directory is required.');
 const coverage=await buildCoverage(directory),index=catalogIndex(directory,{coverage});fs.mkdirSync(output,{recursive:true});
 if(fs.realpathSync(output)===fs.realpathSync(directory))throw Error('Package index output must be separate from its source tree.');
 const changes=packageChanges({directory});
 writeProjectPages(directory,output,index,changes);
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
