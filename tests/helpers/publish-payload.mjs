// Every non-compile step on a real package payload, locally: release-package
// prepare, the publication preflight, publish (releases, tags, catalog commit)
// and the package index, against stand-ins for GitHub and a Builds origin.
// node tests/helpers/publish-payload.mjs <published-archive.tar.gz> <project>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {githubStandin} from './github-standin.mjs';

const root=path.resolve(import.meta.dirname,'../..'),repository='procrastinine/maclauncher-builds',runId='4242';
const identity={GIT_AUTHOR_NAME:'procrastinine',GIT_AUTHOR_EMAIL:'24549552+procrastinine@users.noreply.github.com',GIT_COMMITTER_NAME:'procrastinine',GIT_COMMITTER_EMAIL:'24549552+procrastinine@users.noreply.github.com'};
const git=(cwd,args)=>execFileSync('git',args,{cwd,env:{...process.env,...identity},encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:Infinity}).trim();
const [archive,project]=process.argv.slice(2);
if(!archive||!project)throw Error('Use: publish-payload.mjs <archive.tar.gz> <project>');
const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'publish-payload-'))),started=Date.now(),step=label=>console.log(((Date.now()-started)/1000).toFixed(1)+'s '+label);
try{
 // The published archive's sealed payload and declaration are the build job's outputs.
 const built=path.join(work,'build');fs.mkdirSync(built);execFileSync('tar',['-xzf',path.resolve(archive),'-C',built]);
 const declaration=JSON.parse(fs.readFileSync(path.join(built,'runtime-package.json'),'utf8'));
 fs.renameSync(path.join(built,'files'),path.join(built,'payload'));fs.renameSync(path.join(built,'runtime-package.json'),path.join(built,'declaration.json'));
 step('payload '+declaration.id+' '+declaration.version+' '+declaration.arch+': '+declaration.files.length+' files');
 // A Builds origin at this tree's commit, with this version not yet cataloged.
 const origin=path.join(work,'origin.git'),builds=path.join(work,'builds');
 git(work,['init','--quiet','--bare','--initial-branch=main',origin]);fs.mkdirSync(builds);
 execFileSync('sh',['-c','git -C "$1" archive HEAD | tar -x -C "$2" --exclude=.gitmodules','sh',root,builds]);
 const catalog=path.join(builds,'catalogs',project+'.json'),entries=JSON.parse(fs.readFileSync(catalog,'utf8'));
 entries.packages=entries.packages.filter(row=>!(row.version===declaration.version&&row.arch===declaration.arch));fs.writeFileSync(catalog,JSON.stringify(entries,null,2)+'\n');
 fs.rmSync(path.join(builds,'catalogs/declarations',project,declaration.version,declaration.arch+'.json'),{force:true});
 git(builds,['init','--quiet','--initial-branch=main']);git(builds,['add','.']);git(builds,['commit','--quiet','-m','Builds stand-in']);git(builds,['remote','add','origin',origin]);git(builds,['push','--quiet','origin','main']);
 // Repository tools read the pinned app source; serve it from this tree, untracked.
 fs.rmSync(path.join(builds,'sources/maclauncher'),{recursive:true,force:true});fs.symlinkSync(path.join(root,'sources/maclauncher'),path.join(builds,'sources/maclauncher'));
 fs.appendFileSync(path.join(builds,'.git/info/exclude'),'sources/maclauncher\n');
 const source=git(builds,['rev-parse','HEAD']);
 const env={...process.env,...identity,MACLAUNCHER_PACKAGE_PRODUCER:'1',GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:repository,GITHUB_RUN_ID:runId,GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:source,GITHUB_WORKFLOW:'Build and release',GITHUB_WORKFLOW_REF:repository+'/.github/workflows/runtime-build.yml@refs/heads/main',RELEASE_SELECTION:JSON.stringify([{id:project,version:declaration.version}])};
 // The build job's packaging step, unchanged.
 const release=path.join(work,'release');
 execFileSync(process.execPath,['tools/release-package.mjs','prepare','--project',project,'--input',path.join(built,'payload'),'--declaration',path.join(built,'declaration.json'),'--source-revision',source,'--output',release],{cwd:builds,env,stdio:['ignore','ignore','inherit']});
 const sealed=JSON.parse(fs.readFileSync(path.join(release,fs.readdirSync(release).find(name=>name.endsWith('.tar.gz.json'))),'utf8'));
 step('release-package prepare: '+sealed.asset.filename+' '+sealed.asset.bytes+' bytes, sha256 '+sealed.asset.sha256);
 const artifacts=[{id:1,name:'runtime-'+[project,declaration.version,declaration.arch].join('-'),files:fs.readdirSync(release).map(name=>path.join(release,name))}];
 const hub=githubStandin({repository,runId,artifacts}),targets=[{project,version:declaration.version,arch:declaration.arch}];
 const load=async module=>import(path.join(builds,module));
 const {checkPublication}=await load('tools/publication-preflight.mjs'),{publishLevel}=await load('tools/publish-level.mjs'),{buildIndex}=await load('tools/package-index.mjs');
 process.chdir(builds);Object.assign(process.env,env);
 const checked=await checkPublication({targets,selection:[{id:project,version:declaration.version}],directory:builds,repository,releases:[],runGh:hub.runGh});
 step('preflight: '+JSON.stringify(checked));
 const download=async({bundle})=>{for(const file of artifacts[0].files)fs.copyFileSync(file,path.join(bundle,path.basename(file)));};
 const result=await publishLevel({targets,output:path.join(work,'publication'),directory:builds,env,runGh:hub.runGh,download});
 if(result.failed||result.published!==1)throw Error('publication failed: '+JSON.stringify(result.errors||result));
 git(builds,['fetch','--quiet','origin','main']);
 const published=JSON.parse(git(builds,['show','origin/main:catalogs/'+project+'.json'])).packages.find(row=>row.version===declaration.version&&row.arch===declaration.arch);
 step('publish: release '+hub.state.releases.map(row=>row.tag_name+(row.draft?' (draft)':'')).join(', ')+'; tag '+[...hub.state.tags.keys()].join(', ')+'; catalog commit '+git(builds,['rev-parse','origin/main']).slice(0,12)+' with sha256 '+published.asset.sha256);
 const again=await publishLevel({targets,output:path.join(work,'publication-again'),directory:builds,env,runGh:hub.runGh,download});
 if(again.failed||hub.state.releases.length!==1)throw Error('resume failed: '+JSON.stringify(again.errors));
 step('publish again (rerun): completed, '+hub.state.releases.length+' release');
 const site=path.join(work,'site'),pages=path.join(work,'pages');git(work,['clone','--quiet',origin,pages]);
 fs.mkdirSync(path.join(pages,'sources'),{recursive:true});fs.rmSync(path.join(pages,'sources/maclauncher'),{recursive:true,force:true});fs.symlinkSync(path.join(root,'sources/maclauncher'),path.join(pages,'sources/maclauncher'));
 const index=await buildIndex({directory:pages,output:site}),listed=JSON.parse(fs.readFileSync(path.join(site,'index.json'),'utf8')).projects.find(row=>row.projectId===project).releases.find(row=>row.version===declaration.version&&row.arch===declaration.arch);
 if(!listed||listed.asset.sha256!==sealed.asset.sha256)throw Error('the index does not list the published package');
 execFileSync('tar',['--directory',site,'-cf',path.join(work,'artifact.tar'),'--exclude=.git','--exclude=.github','.']);
 step('index: '+index.projects+' projects, '+index.packages+' packages, lists '+project+' '+declaration.version+' '+declaration.arch+'; Pages artifact '+fs.statSync(path.join(work,'artifact.tar')).size+' bytes');
}finally{fs.rmSync(work,{recursive:true,force:true});}
