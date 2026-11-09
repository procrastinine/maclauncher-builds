import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareRelease} from '../tools/release-runtime.mjs';
import {publishLevel} from '../tools/publish-level.mjs';
import {buildIndex} from '../tools/package-index.mjs';
import {checkPublication} from '../tools/publication-preflight.mjs';

// The real publish and index code runs end to end against a local stand-in for
// the GitHub release, artifact, attestation, git and Pages interfaces.
const repository='owner/builds',runId='4242';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const identity={GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
const git=(cwd,args)=>execFileSync('git',args,{cwd,env:{...process.env,...identity},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const notFound=()=>Object.assign(Error('Not Found'),{stderr:'gh: Not Found (HTTP 404)'});

/** A stateful stand-in for the GitHub REST interfaces publication uses. */
function github({artifacts,failUpload=()=>false}){
 const state={releases:[],tags:new Map(),calls:[],nextId:100};
 const endpointOf=args=>args.find(arg=>arg.startsWith('repos/')||arg.startsWith('https://uploads.'));
 const runGh=async(args,options)=>{
  state.calls.push(args);
  if(args[0]==='attestation'||args[0]==='auth')return '';
  const endpoint=endpointOf(args),method=args.includes('--method')?args[args.indexOf('--method')+1]:'GET',field=name=>args.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1);
  const release=id=>state.releases.find(row=>String(row.id)===String(id));
  let match;
  if(endpoint.endsWith('/actions/runs/'+runId+'/artifacts?per_page=100'))return JSON.stringify([{artifacts:artifacts.map(({id,name})=>({id,name,expired:false}))}]);
  if(endpoint==='repos/'+repository+'/git/matching-refs/tags/')return JSON.stringify([[...state.tags.keys()].map(tag=>({ref:'refs/tags/'+tag}))]);
  if(endpoint==='repos/'+repository+'/pages')return JSON.stringify({build_type:'workflow'});
  if(endpoint==='repos/'+repository+'/environments/github-pages')return JSON.stringify({name:'github-pages'});
  if((match=endpoint.match(/\/git\/ref\/tags\/(.+)$/))){const commit=state.tags.get(match[1]);if(!commit)throw notFound();return JSON.stringify({object:{type:'commit',sha:commit}});}
  assert.ok(!endpoint.endsWith('/git/refs'),'publication never creates refs directly');
  if(endpoint.startsWith('repos/'+repository+'/releases?per_page=100'))return JSON.stringify([state.releases]);
  if((match=endpoint.match(/\/releases\/tags\/(.+)$/))){const found=state.releases.find(row=>row.tag_name===decodeURIComponent(match[1])&&!row.draft);if(!found)throw notFound();return JSON.stringify(found);}
  if(method==='POST'&&endpoint==='repos/'+repository+'/releases'){const created={id:state.nextId++,tag_name:field('tag_name'),target_commitish:field('target_commitish'),draft:true,assets:[]};state.releases.push(created);return JSON.stringify(created);}
  if(method==='POST'&&(match=endpoint.match(/\/releases\/(\d+)\/assets\?name=(.+)$/))){
   const file=args[args.indexOf('--input')+1],bytes=fs.readFileSync(file);if(failUpload(decodeURIComponent(match[2])))throw Object.assign(Error('upload failed'),{stderr:'HTTP 422'});
   const asset={id:state.nextId++,name:decodeURIComponent(match[2]),size:bytes.length,digest:'sha256:'+sha(bytes),state:'uploaded'};release(match[1]).assets.push(asset);return JSON.stringify(asset);
  }
  if((match=endpoint.match(/\/releases\/(\d+)$/))){
   const found=release(match[1]);
   if(method==='DELETE'){state.releases=state.releases.filter(row=>row!==found);return '';}
   if(!found)throw notFound();
   // Publishing a draft creates its tag at the recorded target.
   if(method==='PATCH'&&field('draft')==='false'){found.draft=false;state.tags.set(found.tag_name,found.target_commitish);}
   return JSON.stringify(found);
  }
  if((match=endpoint.match(/\/releases\/assets\/(\d+)$/)))return fs.readFileSync(artifacts.flatMap(row=>row.files).find(file=>sha(fs.readFileSync(file))===state.releases.flatMap(row=>row.assets).find(asset=>String(asset.id)===match[1]).digest.slice(7)));
  assert.fail('unexpected GitHub call: '+args.join(' '));
 };
 return {state,runGh};
}

async function fixture(t,{arches=['arm64','x64'],built=arches}={}){
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'publication-e2e-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const origin=path.join(work,'origin.git'),directory=path.join(work,'builds');
 git(work,['init','--quiet','--bare','--initial-branch=main',origin]);git(work,['clone','--quiet',origin,directory]);
 const project={id:'engine',name:'Engine',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/'+repository,entries:['tools/build.mjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:'Engine'}],build:{version:'1.0.0',command:'tools/build.mjs',architectures:arches}};
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository,updatePolicy:'manual',projects:[project]},null,1)+'\n');
 fs.mkdirSync(path.join(directory,'tools'));fs.writeFileSync(path.join(directory,'tools/build.mjs'),'export const build=true;\n');
 fs.mkdirSync(path.join(directory,'catalogs'));fs.writeFileSync(path.join(directory,'catalogs/.keep'),'');
 fs.mkdirSync(path.join(directory,'.github/workflows'),{recursive:true});
 for(const name of ['runtime-build.yml','runtime-level.yml','pages.yml'])fs.copyFileSync(new URL('../.github/workflows/'+name,import.meta.url),path.join(directory,'.github/workflows',name));
 git(directory,['add','.']);git(directory,['commit','--quiet','-m','Builds stand-in']);git(directory,['push','--quiet','origin','main']);
 const source=git(directory,['rev-parse','HEAD']);
 const env={...identity,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:runId,GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:source,GITHUB_WORKFLOW:'Build and release',GITHUB_WORKFLOW_REF:repository+'/.github/workflows/runtime-build.yml@refs/heads/main',RELEASE_SELECTION:JSON.stringify([{id:'engine',version:'1.0.0'}])};
 // Sealed fixture packages, produced by the same release preparation the build job runs.
 const saved={...process.env};Object.assign(process.env,env);t.after(()=>{for(const key of Object.keys(env))if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];});
 const artifacts=[];
 for(const [index,arch] of built.entries()){
  const input=path.join(work,'input-'+arch);fs.mkdirSync(input);const data={'manifest.json':JSON.stringify({version:'1.0.0',arch}),'LICENSE':'MIT'};
  const files=Object.entries(data).map(([name,bytes])=>{fs.writeFileSync(path.join(input,name),bytes,{mode:0o644});return {path:name,size:Buffer.byteLength(bytes),mode:0o644,sha256:sha(bytes)};});
  const declaration={id:'engine',version:'1.0.0',arch,launcherArchitectures:[arch],minimumMacOS:'13.0',directoryRelative:'engine/1.0.0/'+arch,manifestRelative:'manifest.json',manifestSha256:files[0].sha256,sourceSha256:files[0].sha256,sourceRelative:'manifest.json',files,redistribution:'bundle'};
  const bundle=path.join(work,'artifact-'+arch);await prepareRelease({project:'engine',input,declaration,sourceRevision:source,output:bundle,directory});
  artifacts.push({id:index+1,name:'runtime-engine-1.0.0-'+arch,files:fs.readdirSync(bundle).map(name=>path.join(bundle,name))});
 }
 const download=async({artifact,bundle})=>{for(const file of artifacts.find(row=>row.id===artifact.id).files)fs.copyFileSync(file,path.join(bundle,path.basename(file)));};
 return {work,origin,directory,env,source,artifacts,download,targets:arches.map(arch=>({project:'engine',version:'1.0.0',arch}))};
}
const catalogAt=(f,ref='main')=>{try{return JSON.parse(git(f.directory,['show','origin/'+ref+':catalogs/engine.json']));}catch{return null;}};

test('a sealed package publishes end to end: preflight, releases, tags, catalog and Pages index',async t=>{
 const f=await fixture(t),hub=github({artifacts:f.artifacts});
 const checked=await checkPublication({targets:f.targets,selection:[{id:'engine',version:'1.0.0'}],directory:f.directory,repository,releases:[],runGh:hub.runGh});
 assert.equal(checked.tags,2);
 const result=await publishLevel({targets:f.targets,output:path.join(f.work,'publication'),directory:f.directory,env:f.env,runGh:hub.runGh,download:f.download});
 assert.equal(result.failed,0,JSON.stringify(result.errors));assert.equal(result.published,2);
 assert.deepEqual([...hub.state.tags.keys()].sort(),['engine/v1.0.0/arm64','engine/v1.0.0/x64']);
 assert.ok(hub.state.releases.every(release=>release.draft===false&&release.assets.length===1));
 git(f.directory,['fetch','--quiet','origin','main']);
 assert.deepEqual(catalogAt(f).packages.map(row=>row.arch).sort(),['arm64','x64']);
 // The Pages job builds the index from published main: one artifact, containing the new packages.
 const checkout=path.join(f.work,'pages');git(f.work,['clone','--quiet',f.origin,checkout]);
 const output=path.join(f.work,'site'),index=await buildIndex({directory:checkout,output});
 assert.equal(index.packages,2);assert.ok(fs.existsSync(path.join(output,'index.html')));
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'catalogs/engine.json'),'utf8')).packages.map(row=>row.arch).sort(),['arm64','x64']);
 // Publishing the same run again resumes and completes without rebuilding or duplicating anything.
 const again=await publishLevel({targets:f.targets,output:path.join(f.work,'publication-again'),directory:f.directory,env:f.env,runGh:hub.runGh,download:f.download});
 assert.equal(again.failed,0,JSON.stringify(again.errors));assert.equal(hub.state.releases.length,2);
 git(f.directory,['fetch','--quiet','origin','main']);assert.equal(catalogAt(f).packages.length,2);
 // The preflight of a later run sees the names as taken.
 await assert.rejects(checkPublication({targets:f.targets,selection:[{id:'engine',version:'1.0.0'}],directory:f.directory,repository,releases:hub.state.releases,runGh:hub.runGh}),/tag engine\/v1\.0\.0\/arm64 already exists/);
});

test('P5 and target 8: a failed architecture leaves no tag, release or catalog entry for its version',async t=>{
 // Runs 41573494245, 41573478534, 41545894735 and others pushed tags before a failure.
 const f=await fixture(t,{built:['arm64']}),hub=github({artifacts:f.artifacts});
 const result=await publishLevel({targets:f.targets,output:path.join(f.work,'publication'),directory:f.directory,env:f.env,runGh:hub.runGh,download:f.download});
 assert.equal(result.published,0);assert.equal(result.skipped,2);
 assert.equal(hub.state.tags.size,0);assert.equal(hub.state.releases.length,0);
 assert.ok(hub.state.calls.every(args=>!args.includes('POST')),'nothing is created');
 git(f.directory,['fetch','--quiet','origin','main']);assert.equal(catalogAt(f),null);
});

test('P5: a publish step failing after a release was staged resumes on the next attempt',async t=>{
 const f=await fixture(t);let fail=true;
 const hub=github({artifacts:f.artifacts,failUpload:name=>name.includes('x64')&&fail});
 const first=await publishLevel({targets:f.targets,output:path.join(f.work,'publication'),directory:f.directory,env:f.env,runGh:hub.runGh,download:f.download});
 assert.equal(first.failed,1);assert.match(first.errors[0].error,/upload failed/);
 assert.ok(!hub.state.tags.has('engine/v1.0.0/x64'),'a failed arch pushes no tag');
 fail=false;
 const second=await publishLevel({targets:f.targets,output:path.join(f.work,'publication-2'),directory:f.directory,env:f.env,runGh:hub.runGh,download:f.download});
 assert.equal(second.failed,0,JSON.stringify(second.errors));
 assert.deepEqual([...hub.state.tags.keys()].sort(),['engine/v1.0.0/arm64','engine/v1.0.0/x64']);
 git(f.directory,['fetch','--quiet','origin','main']);assert.equal(catalogAt(f).packages.length,2);
});

test('P4: declaration and version checks run in the plan, before any build',async t=>{
 // Run 41545812737 failed at publish with "Invalid declared semantic versions." after a full build.
 const f=await fixture(t,{built:[]}),hub=github({artifacts:[]});
 await assert.rejects(checkPublication({targets:[{project:'engine',version:'3.0.1',arch:'universal'}],selection:[{id:'engine',version:'3.0.1'}],directory:f.directory,repository,runGh:hub.runGh}),/engine 3\.0\.1 universal: Release version is not declared/);
 await assert.rejects(checkPublication({targets:[{project:'engine',version:'1.0.0',arch:'sparc'}],selection:[{id:'engine',version:'1.0.0'}],directory:f.directory,repository,runGh:hub.runGh}),/engine 1\.0\.0 sparc:/);
});

test('the plan checks Pages, the environment, catalogs and token grants read-only',async t=>{
 const f=await fixture(t,{built:[]}),hub=github({artifacts:[]});
 const legacy=async args=>args.some(arg=>arg.endsWith('/pages'))?JSON.stringify({build_type:'legacy'}):hub.runGh(args);
 await assert.rejects(checkPublication({targets:f.targets,selection:[{id:'engine',version:'1.0.0'}],directory:f.directory,repository,runGh:legacy}),/Pages builds from legacy/);
 fs.writeFileSync(path.join(f.directory,'catalogs/engine.json'),'{"not":"a catalog"}');
 await assert.rejects(checkPublication({targets:f.targets,selection:[{id:'engine',version:'1.0.0'}],directory:f.directory,repository,runGh:hub.runGh}),/catalog engine:/);
 fs.rmSync(path.join(f.directory,'catalogs/engine.json'));
 const level=path.join(f.directory,'.github/workflows/runtime-level.yml');fs.writeFileSync(level,fs.readFileSync(level,'utf8').replace(/(\n  publish:[\s\S]*?)contents: write/,'$1contents: read'));
 await assert.rejects(checkPublication({targets:f.targets,selection:[{id:'engine',version:'1.0.0'}],directory:f.directory,repository,runGh:hub.runGh}),/runtime-level\.yml job publish needs contents: write/);
 fs.copyFileSync(new URL('../.github/workflows/runtime-level.yml',import.meta.url),level);
 assert.equal((await checkPublication({targets:f.targets,selection:[{id:'engine',version:'1.0.0'}],directory:f.directory,repository,runGh:hub.runGh})).tags,2);
 assert.ok(hub.state.calls.every(args=>!args.includes('--method')),'the preflight only reads');
});
