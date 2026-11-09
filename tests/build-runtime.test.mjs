import test from 'node:test';
import {sourceRevision,sourceCheckout} from '../lib/pins.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {execFileSync,spawnSync} from 'node:child_process';
import {verifyProducer,main,buildPlan,runBuild,checkBuildRequest,RUNNERS,HOSTED_RUNNERS} from '../tools/build-runtime.mjs';
import {findBuildTool} from '../tools/build-source.mjs';
import {prepareBuildHost} from '../tools/build-host.mjs';
import {initializeSources,initializeGitlinks} from '../tools/init-runtime-sources.mjs';
import {prepareRelease} from '../tools/release-runtime.mjs';
import {readProjects,buildRecord,buildRecords} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
// The paths one git command names after `--`.
const named=args=>args.includes('--')?args.slice(args.indexOf('--')+1):[];
// The app checkout is the gitlink that app-source.json declares.
const appCheckout=path.join(root,sourceCheckout(JSON.parse(fs.readFileSync(path.join(root,'producers/package-support/app-source.json')))));

test('Android recipes initialize the producer whose metadata they read from a cold checkout',()=>{
 assert.equal(readProjects(root,{resolvePins:false}).projects.find(project=>project.id==='android-angle-aim').build,undefined,'The historical AIM ANGLE project has no independent producer');
 for(const project of ['android-java-framework','android-java-converter','android-angle','android-art-image-extractor','android-launcher','android-art-java','android-image-data-1','android-image-data-2','android-image-data-3','android-image-data-4','android-image-data-5']){
  const commands=[],result=initializeSources({project,directory:root,run:(args,cwd)=>{
   commands.push({args,cwd});
   if(args[0]==='ls-files'){const links=cwd===root?['sources/maclauncher','sources/maclauncher-android','sources/maclauncher-kosmickrisp']:cwd===appCheckout?['src/external/maclauncher-android','src/external/maclauncher-kosmickrisp']:['sources/maclauncher'];return links.map(path=>'160000 '+'a'.repeat(40)+' 0\t'+path).join('\n')+'\n';}
   return '';
  }});
  const build=buildRecord(readProjects(root,{resolvePins:false}).projects.find(row=>row.id===project));
  assert.deepEqual(result.initialized,build.submodules.map(path=>({path,recursive:false})),project);
  assert.ok(!commands.some(({args})=>named(args).includes('sources/maclauncher')),'A build that declares no app file never initializes the app');
  assert.ok(commands.every(({args})=>!args.includes('--recursive')),'Shared source owners do not initialize unrelated upstream trees');
  assert.ok(commands.some(({args})=>args[0]==='submodule'&&args.includes('--init')&&named(args).includes('sources/maclauncher-android')),project);
 }
});

// Reads the app checkout: mpv declares app files, and initializeSources lists the app gitlinks they lie in from the app's own index.
test('only a build that declares app-source.json initializes the app, with the app gitlinks its app files lie in',()=>{
 const fake=(cwd,links)=>links.map(path=>'160000 '+'a'.repeat(40)+' 0\t'+path).join('\n');
 const initialize=project=>initializeSources({project,directory:root,run:(args,cwd)=>{
  if(args[0]!=='ls-files')return '';
  if(cwd===root)return fake(cwd,['sources/maclauncher','sources/maclauncher-android',...readProjects(root,{resolvePins:false}).projects.flatMap(row=>[].concat(row.build||[]).flatMap(build=>build.submodules||[]))]);
  return cwd===appCheckout?fake(cwd,['src/external/maclauncher-android','src/external/maclauncher-kosmickrisp']):'';
 }}).initialized.map(row=>row.path);
 const mpv=initialize('mpv');
 assert.ok(mpv.includes('sources/maclauncher'));
 assert.ok(mpv.includes('sources/maclauncher/src/external/maclauncher-kosmickrisp'),'image-color.h is a symlink into the app KosmicKrisp gitlink');
 assert.ok(!mpv.includes('sources/maclauncher/src/external/maclauncher-android'));
 assert.ok(!initialize('innoextract').some(path=>path==='sources/maclauncher'||path.startsWith('sources/maclauncher/')));
});

test('sources initialize with one submodule update per superproject and recursion group, listing each superproject once',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-groups-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.mkdirSync(path.join(directory,'producers/package-support'),{recursive:true});fs.writeFileSync(path.join(directory,'producers/package-support/app-source.json'),JSON.stringify({gitlink:'sources/maclauncher'}));
 const links={[directory]:['a','b','c','p','q'],[directory+'/b']:['x','y'],[directory+'/q']:['z']},calls=[],listed=[];
 const run=(args,cwd)=>{
  if(args[0]==='ls-files'){listed.push(cwd);return (links[cwd]||[]).map(link=>'160000 '+'a'.repeat(40)+' 0\t'+link).join('\n')+'\n';}
  calls.push({cwd,args});return '';
 };
 const plain=initializeGitlinks({paths:['a','b/x','b/y','c'],directory,run});
 assert.deepEqual(plain.map(row=>row.path),['a','b','b/x','b/y','c'],'Newly initialized gitlinks keep the order of the paths that name them');
 assert.deepEqual(calls.map(({cwd,args})=>[cwd,named(args)]),[[directory,['a','b','c']],[directory+'/b',['x','y']]]);
 assert.ok(calls.every(({args})=>args.includes('--depth')&&args[args.indexOf('--jobs')+1]==='8'));
 assert.deepEqual(listed,[directory,directory+'/b'],'Each superproject is listed once');
 calls.length=0;
 const recursive=initializeGitlinks({paths:['p','q/z'],directory,run,allowRecursive:true});
 assert.deepEqual(recursive,[{path:'p',recursive:true},{path:'q',recursive:false},{path:'q/z',recursive:true}]);
 assert.deepEqual(calls.map(({cwd,args})=>[cwd,args.includes('--recursive'),named(args)]),[[directory,true,['p']],[directory,false,['q']],[directory+'/q',true,['z']]]);
});

test('a dumb HTTP source falls back to one full fetch of the same group',()=>{
 const calls=[];
 initializeGitlinks({paths:['a','b'],directory:'/fixture',run:(args,cwd)=>{
  if(args[0]==='ls-files')return '160000 '+'a'.repeat(40)+' 0\ta\n160000 '+'a'.repeat(40)+' 0\tb\n';
  calls.push(args);if(args.includes('--depth'))throw Object.assign(Error('fetch failed'),{stderr:'fatal: dumb http transport does not support shallow capabilities'});return '';
 }});
 assert.deepEqual(calls.map(args=>[args.includes('--depth'),named(args)]),[[true,['a','b']],[false,['a','b']]]);
});

test('a recursive build recurses into its own sources and never into the shared source owners',()=>{
 const build=buildRecord(readProjects(root,{resolvePins:false}).projects.find(project=>project.id==='ai5'));
 assert.equal(build.recursiveSubmodules,true);
 const commands=[];
 initializeSources({project:'ai5',version:build.version,directory:root,run:(args,cwd)=>{
  commands.push(args);
  if(args[0]==='ls-files'){const links=cwd===root?['sources/maclauncher','sources/maclauncher-android','sources/maclauncher-kosmickrisp',...build.submodules]:cwd===appCheckout?['src/external/maclauncher-android','src/external/maclauncher-kosmickrisp']:['sources/maclauncher'];return links.map(path=>'160000 '+'a'.repeat(40)+' 0\t'+path).join('\n')+'\n';}
  return '';
 }});
 assert.deepEqual(commands.filter(args=>args.includes('--recursive')).flatMap(named),build.submodules);
});

test('producer routing never substitutes Android for a different project',()=>{
 const selected=main(['--project','fna','--check']);assert.equal(selected.id,'fna');assert.equal(selected.sourceDirectory,'producers/package-support');assert.ok(!selected.entries.some(entry=>/^(producers\/android|sources\/maclauncher-android)/.test(entry)));
 assert.throws(()=>main(['--project','flash-projector','--check']),/retains its supplied binary/);
 assert.throws(()=>main(['--project','not-registered','--check']),/Unknown build project/);
 assert.throws(()=>main(['--project','android','--runtime','fna','--check']),/Select one project/);
});

test('runtime builds read the source commit recorded by the hub',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-producer-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'sources/android');fs.mkdirSync(path.join(source,'tools'),{recursive:true});
 const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(source,'init','-q');git(source,'config','user.name','Build test');git(source,'config','user.email','test@example.invalid');
 for(const entry of ['build.mjs','check-sources.mjs'])fs.writeFileSync(path.join(source,'tools',entry),'export {};\n');
 git(source,'add','tools');git(source,'commit','-qm','Runtime source');const revision=git(source,'rev-parse','HEAD');
 git(root,'init','-q');git(root,'config','user.name','Build test');git(root,'config','user.email','test@example.invalid');
 git(root,'update-index','--add','--cacheinfo',`160000,${revision},sources/android`);git(root,'commit','-qm','Pin producer');
 const recipe={schemaVersion:1,id:'android',gitlink:'sources/android',buildEntry:'tools/build.mjs',checkEntry:'tools/check-sources.mjs'};
 assert.equal(verifyProducer(root,recipe),source);
 assert.equal(sourceRevision(recipe,root),revision);
});

// A registry with one GitHub-built project and a command that writes a data-only package.
function githubFixture(t,build={architectures:['arm64','x64']},command){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-github-build-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const project={id:'engine',name:'Engine',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['producers/engine/build.mjs'],sourceDirectory:'producers/engine'},upstreams:[],packageProfiles:[{version:'1.0.0',label:'Engine 1.0'}],build:{version:'1.0.0',command:'producers/engine/build.mjs',submodules:['producers/engine/upstream'],tools:['meson','ninja'],...build}};
 const helper={id:'helper',name:'Helper',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['producers/helper/build.mjs']},upstreams:[]};
 fs.mkdirSync(path.join(root,'projects'));fs.mkdirSync(path.join(root,'producers/engine'),{recursive:true});
 fs.writeFileSync(path.join(root,'projects.json'),JSON.stringify({schemaVersion:2,repository:'owner/builds',updatePolicy:'manual',registries:{downloadable:'projects/downloadable.json',bundled:'projects/bundled.json'}}));
 fs.writeFileSync(path.join(root,'projects/downloadable.json'),JSON.stringify([project]));fs.writeFileSync(path.join(root,'projects/bundled.json'),JSON.stringify([helper]));
 fs.writeFileSync(path.join(root,'producers/engine/build.mjs'),command??`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const o={};for(let i=2;i<process.argv.length;i+=2)o[process.argv[i].slice(2)]=process.argv[i+1];
const payload=path.join(o.output,'payload');fs.mkdirSync(payload,{recursive:true});
const files={'manifest.json':JSON.stringify({version:'1.0.0',arch:o.arch}),'LICENSE':'MIT'};
for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(payload,name),bytes,{mode:0o644});
const record=name=>({path:name,size:Buffer.byteLength(files[name]),mode:0o644,sha256:crypto.createHash('sha256').update(files[name]).digest('hex')});
const cpus=o.arch==='arm64'?['arm64']:o.arch==='x64'?(process.env.ENGINE_CPUS||'arm64,x64').split(','):['arm64','x64'];
fs.writeFileSync(path.join(o.output,'declaration.json'),JSON.stringify({id:o.project,version:'1.0.0',arch:o.arch,launcherArchitectures:cpus,minimumMacOS:'13.0',directoryRelative:o.project+'/1.0.0/'+o.arch,manifestRelative:'manifest.json',manifestSha256:record('manifest.json').sha256,sourceSha256:record('manifest.json').sha256,sourceRelative:'manifest.json',files:Object.keys(files).map(record)}));
if(process.env.ENGINE_EXTRA)fs.writeFileSync(path.join(o.output,'extra.txt'),'extra');
`);
 return root;
}

const row=(arch,version='1.0.0')=>({project:'engine',version,arch,runner:RUNNERS[arch]});

test('a manual GitHub build plans the registered version once for each architecture',t=>{
 const root=githubFixture(t);
 assert.deepEqual(buildPlan({project:'engine',directory:root}),{include:[row('arm64'),row('x64')]});
 assert.equal(RUNNERS.arm64,'xcode-27');assert.equal(RUNNERS.x64,'macos-26-intel');assert.equal(RUNNERS.universal,RUNNERS.arm64);
 assert.deepEqual(buildPlan({project:'engine',arch:'x64',version:'1.0.0',directory:root}),{include:[row('x64')]});
 assert.throws(()=>buildPlan({project:'engine',arch:'universal',directory:root}),/builds arm64 and x64 packages/);
 assert.throws(()=>buildPlan({project:'engine',version:'2.0',directory:root}),/builds version 1\.0/);
 assert.throws(()=>buildPlan({project:'helper',directory:root}),/no GitHub build command/);
 assert.deepEqual(main(['--plan','--project','engine'],root),{include:[row('arm64'),row('x64')]});
 for(const args of [['--plan','--project','engine','--output','/tmp/out'],['--plan'],['--plan','--before','a'.repeat(40),'--project','engine'],['--before','a'.repeat(40),'--project','engine','--check']])
  assert.throws(()=>main(args,root),/--plan|Use --project/);
});

test('GitHub build records name a contained command, exclusive universal builds and plain tool names',()=>{
 const project=build=>({id:'engine',producer:{kind:'maclauncher',sourceDirectory:'producers/engine'},packageProfiles:[{version:'1.0.0'}],build:{version:'1.0.0',command:'producers/engine/build.mjs',architectures:['arm64'],...build}});
 assert.deepEqual(buildRecord(project({})).architectures,['arm64']);
 assert.equal(buildRecord(project({command:'tools/build-engine.mjs'})).command,'tools/build-engine.mjs');
 for(const [build,error] of [[{architectures:[]},/distinct arm64/],[{architectures:['arm64','arm64']},/distinct arm64/],
  [{command:'producers/other/build.mjs'},/command/],[{command:'producers/engine/../build.mjs'},/command/],[{command:'producers/engine/build.sh'},/command/],
  [{tools:['meson; rm']},/tools/],[{version:'2.0'},/declared/],[{version:undefined},/declared/],[{submodules:['../outside']},/submodules/],[{runner:'self-hosted'},/command/]])assert.throws(()=>buildRecord(project(build)),error);
 assert.throws(()=>buildRecord({...project({}),producer:{kind:'prebuilt'}}),/command/);
});

test('a materialized GitHub build runs the command in a tree holding only its build definition',t=>{
 const fixtureRunners=process.platform==='linux'?{arm64:'ubuntu-24.04',x64:'ubuntu-24.04'}:undefined;
 const root=githubFixture(t,{architectures:['arm64','x64'],tools:undefined,submodules:['producers/engine/upstream','producers/engine/linked'],...(fixtureRunners?{runners:fixtureRunners}:{})}),command=path.join(root,'producers/engine/build.mjs');
 fs.appendFileSync(command,"const tree=path.resolve(import.meta.dirname,'../..');if(tree!==path.join(path.dirname(o.work),'tree')||fs.existsSync(path.join(tree,'undeclared.txt')))process.exitCode=4;\n");
 fs.writeFileSync(path.join(root,'undeclared.txt'),'not part of the definition');
 const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Build test','-c','user.email=test@example.invalid','-c','protocol.file.allow=always',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 const upstream=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-github-upstream-')));t.after(()=>fs.rmSync(upstream,{recursive:true,force:true}));
 fs.writeFileSync(path.join(upstream,'source.c'),'int main(void){return 0;}\n');git(upstream,'init','-q');git(upstream,'add','.');git(upstream,'commit','-qm','upstream');
 git(root,'init','-q');git(root,'submodule','add','-q',upstream,'producers/engine/upstream');
 // A Gitlink whose checkout is a linked worktree of another clone, as the app pin's is.
 const shared=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-github-shared-')));t.after(()=>fs.rmSync(shared,{recursive:true,force:true}));
 fs.writeFileSync(path.join(shared,'shared.c'),'int shared;\n');git(shared,'init','-q');git(shared,'add','.');git(shared,'commit','-qm','shared');
 const sharedCommit=git(shared,'rev-parse','HEAD');git(shared,'worktree','add','-q','--detach',path.join(root,'producers/engine/linked'),sharedCommit);
 git(root,'config','-f','.gitmodules','submodule.linked.path','producers/engine/linked');git(root,'config','-f','.gitmodules','submodule.linked.url',shared);
 git(root,'update-index','--add','--cacheinfo','160000,'+sharedCommit+',producers/engine/linked');git(root,'add','.');git(root,'commit','-qm','fixture');
 const work=path.join(root,'work'),built=runBuild({project:'engine',arch:'x64',output:path.join(root,'out-x64'),work,directory:root,materialize:true});
 assert.equal(built.arch,'x64');
 assert.ok(fs.existsSync(path.join(work,'tree/producers/engine/build.mjs'))&&fs.existsSync(path.join(work,'tree/projects/downloadable.json')));
 assert.equal(fs.existsSync(path.join(work,'tree/undeclared.txt')),false);
 assert.equal(git(path.join(work,'tree/producers/engine/upstream'),'rev-parse','HEAD'),git(upstream,'rev-parse','HEAD'));
 assert.ok(fs.existsSync(path.join(work,'tree/producers/engine/upstream/source.c')));
 assert.ok(fs.existsSync(path.join(work,'tree/producers/engine/linked/shared.c')));
 // Each materialized checkout is a repository of its own: a depth fetch in it leaves the shallow
 // list, refs and configuration of the submodule store and of the linked checkout's clone unchanged.
 const store=dir=>git(dir,'rev-parse','--path-format=absolute','--git-common-dir');
 const state=dir=>[git(dir,'for-each-ref'),fs.readFileSync(path.join(store(dir),'config'),'utf8'),fs.existsSync(path.join(store(dir),'shallow'))];
 const sources=['upstream','linked'].map(link=>path.join(root,'producers/engine',link)),before=sources.map(state);
 for(const [link,origin] of [['upstream',upstream],['linked',shared]]){
  const checkout=path.join(work,'tree/producers/engine',link);
  assert.ok(store(checkout).startsWith(path.join(work,'tree')+path.sep),link);
  git(checkout,'fetch','-q','--depth','1','file://'+origin,'HEAD');
 }
 assert.deepEqual(sources.map(state),before);
 assert.throws(()=>runBuild({project:'engine',arch:'x64',output:path.join(root,'out-in-place'),directory:root}),/exited with status 4/);
 fs.appendFileSync(command,'\n');
 assert.throws(()=>runBuild({project:'engine',arch:'x64',output:path.join(root,'out-changed'),work:path.join(root,'work-changed'),directory:root,materialize:true}),/Commit the declared build files/);
 assert.throws(()=>main(['--materialize','--project','engine','--check'],root),/--materialize with --project, --arch and --output/);
});

test('a GitHub build runs the registered command and accepts only its declared package',t=>{
 const fixtureRunners=process.platform==='linux'?{arm64:'ubuntu-24.04',x64:'ubuntu-24.04'}:undefined;
 const root=githubFixture(t,{architectures:['arm64','x64'],tools:undefined,...(fixtureRunners?{runners:fixtureRunners}:{})}),work=path.join(root,'work');
 const built=runBuild({project:'engine',arch:'x64',output:path.join(root,'out-x64'),work,directory:root});
 assert.equal(built.version,'1.0.0');assert.equal(built.arch,'x64');assert.equal(built.payload,path.join(root,'out-x64/payload'));
 assert.equal(main(['--project','engine','--arch','arm64','--output',path.join(root,'out-arm64')],root).arch,'arm64');
 assert.throws(()=>runBuild({project:'engine',arch:'universal',output:path.join(root,'out-universal'),directory:root}),/builds arm64 and x64/);
 assert.throws(()=>runBuild({project:'engine',arch:'x64',output:path.join(root,'out-x64'),directory:root}),/new absolute output/);
 assert.throws(()=>runBuild({project:'engine',arch:'x64',output:'relative',directory:root}),/new absolute output/);
 const previous={...process.env};t.after(()=>{for(const key of ['ENGINE_CPUS','ENGINE_EXTRA'])if(previous[key]===undefined)delete process.env[key];});
 process.env.ENGINE_CPUS='x64';assert.equal(runBuild({project:'engine',arch:'x64',output:path.join(root,'out-intel-only'),directory:root}).arch,'x64');

 const failing=githubFixture(t,{architectures:['arm64'],tools:undefined,...(fixtureRunners?{runners:{arm64:fixtureRunners.arm64}}:{})},'process.exitCode=3;\n');
 assert.throws(()=>runBuild({project:'engine',arch:'arm64',output:path.join(failing,'out'),directory:failing}),/exited with status 3/);
});

test('every registered GitHub build names an existing command and submodule of this repository',()=>{
 const modules=fs.readFileSync(path.join(root,'.gitmodules'),'utf8'),registry=readProjects(root,{resolvePins:false});
 for(const project of registry.projects.filter(project=>project.build))for(const build of buildRecords(project)){
  for(const entry of project.producer.entries||[]){const stat=fs.statSync(path.join(root,entry));assert.ok(stat.isFile()||stat.isDirectory(),project.id+' '+entry);}
  assert.ok(fs.statSync(path.join(root,build.command)).isFile(),project.id);
  const roots=[...modules.matchAll(/\tpath = ([^\n]+)\n/g)].map(match=>match[1]);
  for(const submodule of build.submodules||[])assert.ok(roots.some(root=>submodule===root||submodule.startsWith(root+'/')),project.id+' '+submodule);
  // Nested paths are checked at each Gitlink by init-runtime-sources before compilation.
 }
});

test('a VNDS-LOVE package revision preserves engine files and historical packaging',async t=>{
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'vnds-love-build-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const {compile,assemble}=await import('../producers/engine-adaptations/stage.mjs'),output=path.join(work,'build');
 const staged=assemble({project:'vnds-love',arch:'universal',output,compiled:compile({project:'vnds-love',work:path.join(work,'compile')})});
 const built={version:staged.version,declaration:path.join(output,'declaration.json'),payload:path.join(output,'payload')};
 assert.equal(built.version,buildRecord(readProjects(root,{resolvePins:false}).projects.find(row=>row.id==='vnds-love')).version);
 const {stageData}=await import('../producers/engine-adaptations/stage.mjs'),input=path.join(work,'historical');
 const declaration=stageData({project:'vnds-love',output:input});
 const release=await prepareRelease({project:'vnds-love',input,declaration,output:path.join(work,'release')});
 assert.equal(release.id,'vnds-love');
 const actual=JSON.parse(fs.readFileSync(built.declaration));
 assert.deepEqual(actual.files.filter(row=>row.path!=='manifest.json'),declaration.files.filter(row=>row.path!=='manifest.json'));
});

test('build jobs cannot mutate repository contents',()=>{
 const pipeline=fs.readFileSync(path.join(root,'.github/workflows/runtime-level.yml'),'utf8');
 for(const name of ['build']){
  const body=pipeline.slice(pipeline.indexOf('  '+name+':')).split(/\n  [A-Za-z][A-Za-z0-9]*:/)[0];
  assert.match(body,/^\s+contents: read\s*$/m);assert.doesNotMatch(body,/^\s+contents: write\s*$/m);
 }
});

test('registered GitHub build commands reject architectures their projects do not build',async t=>{
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-build-commands-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const request=(project,arch)=>({project,arch,output:path.join(work,project+'-'+arch),work:path.join(work,project+'-'+arch+'-work')});
 const registry=readProjects(root,{resolvePins:false}),selected=(id,arch)=>buildRecords(registry.projects.find(p=>p.id===id)).find(b=>b.architectures.includes(arch));
 assert.throws(()=>checkBuildRequest(request('vnds-love','arm64')),/builds universal packages/);
 assert.throws(()=>checkBuildRequest(request('rlvm-adapter','x64')),/builds universal packages/);
 assert.throws(()=>checkBuildRequest({...request('sys3-decompiler','universal'),version:selected('sys3-decompiler','arm64').version}),/builds .*packages/);
 assert.throws(()=>checkBuildRequest(request('web-renderer-network','ppc')),/builds arm64 and x64 packages/);
 const {compile:compileDecompiler}=await import('../producers/package-support/scripts/build-decompiler.mjs');
 await assert.rejects(compileDecompiler({project:'gemrb',arch:'arm64',output:path.join(work,'gemrb'),work:path.join(work,'gemrb-work')}),/decompiler profiles have no release/);
 assert.throws(()=>checkBuildRequest({...request('sys3-decompiler','arm64'),version:'0.5.0'}),/builds version|declared|version/);
 for(const [id,architectures] of [['sys3-decompiler',['arm64','x64']],['xsys35-decompiler',['arm64','x64']],['gm8-decompiler',['arm64','x64']],['catsystem2-kif-crypto',['arm64','x64']],['web-renderer-network',['arm64','x64']]])assert.deepEqual(buildRecords(registry.projects.find(project=>project.id===id)).flatMap(build=>build.architectures).sort(),architectures);
 const java=buildRecords(registry.projects.find(project=>project.id==='java-steamworks'));
 for(const [base,architectures] of [['1.9.0',['x64']],['1.10.0',['universal']]])assert.deepEqual(java.find(build=>build.version.startsWith(base+'-MCLv'))?.architectures,architectures);
 const {helperProfile}=await import('../tools/build-helper.mjs');
 assert.throws(()=>helperProfile('gemrb'),/ENOENT|helper-builds/);
 for(const id of ['catsystem2-kif-crypto','web-renderer-network','steam-api-helper','steam-ticket-loader','mkxpz-config-helper'])assert.ok(registry.projects.find(project=>project.id===id).packageProfiles.some(profile=>profile.version===helperProfile(id).profile.version));
});

test('one shared request check covers every registered build command before its recipe starts',t=>{
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'build-requests-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const gemrb=readProjects(root,{resolvePins:false}).projects.find(p=>p.id==='gemrb'),gemrbBuild=arch=>buildRecords(gemrb).find(b=>b.architectures.includes(arch));
 const request={project:'gemrb',version:gemrbBuild('arm64').version,arch:'arm64',platform:'darwin',cpu:'arm64',output:path.join(work,'out'),work:path.join(work,'work')};
 assert.equal(checkBuildRequest(request).build.command,'tools/build-portable-runtime.mjs');
 for(const [change,pattern] of [[{output:'relative'},/new absolute output/],[{output:work},/new absolute output/],[{work:path.join(work,'out','work')},/separate absolute work/],
  [{version:'0.0'},/builds version/],[{platform:'linux',cpu:'arm64'},/cannot run/],[{platform:'darwin',cpu:'x64',arch:'arm64'},/cannot run/]])
  assert.throws(()=>checkBuildRequest({...request,...change}),pattern);
 // An Apple Silicon Mac also builds for an Intel runner; GitHub prepares only the exact runner.
 assert.equal(checkBuildRequest({...request,version:gemrbBuild('x64').version,arch:'x64',platform:'darwin',cpu:'arm64'}).runner,'macos-26-intel');
 // A recipe started for another project stops before it builds anything.
 const other=readProjects(root,{resolvePins:false}).projects.find(project=>project.id===(process.platform==='linux'?'android-java-converter':'gemrb')),otherBuild=buildRecords(other).find(build=>(build.runners?.[build.architectures[0]]||'xcode-27')===(process.platform==='linux'?'ubuntu-24.04':'xcode-27'))||buildRecords(other).at(-1);
 const started=spawnSync(process.execPath,[path.join(root,'tools/build-fna.mjs'),'--project',other.id,'--version',otherBuild.version,'--arch',otherBuild.architectures[0],'--output',request.output,'--work',request.work],{cwd:root,encoding:'utf8'});
 assert.notEqual(started.status,0);assert.match(started.stderr,/ builds with /);assert.ok(!fs.existsSync(request.output)&&!fs.existsSync(request.work));
});

test('build tools come from declared Homebrew formulae before PATH',t=>{
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'build-tools-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const tool=directory=>{fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'flex');fs.writeFileSync(file,'#!/bin/sh\n',{mode:0o755});return file;};
 const declared=tool(path.join(work,'opt/flex/bin')),xcode=tool(path.join(work,'xcode/bin'));
 assert.equal(findBuildTool('flex',{CMAKE_PREFIX_PATH:path.join(work,'opt/flex'),PATH:path.dirname(xcode)}),declared);
 assert.equal(findBuildTool('flex',{PATH:path.dirname(xcode)}),xcode);
 assert.throws(()=>findBuildTool('bison',{CMAKE_PREFIX_PATH:path.join(work,'opt/flex'),PATH:path.dirname(xcode)}),/Declare the Homebrew formula/);
});

test('an owned helper builds a separate package for each CPU, and only Intel executables also serve Apple Silicon',{skip:process.platform!=='darwin'&&'macOS toolchain'},async t=>{
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'helper-builds-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const cpus={};
 for(const [id,arch] of [['catsystem2-kif-crypto','arm64'],['catsystem2-kif-crypto','x64'],['web-renderer-network','x64']]){
  const built=runBuild({project:id,arch,output:path.join(work,id+'-'+arch),work:path.join(work,id+'-'+arch+'-work'),directory:root});
  cpus[id+'/'+arch]=JSON.parse(fs.readFileSync(built.declaration)).launcherArchitectures;
 }
 assert.deepEqual(cpus,{'catsystem2-kif-crypto/arm64':['arm64'],'catsystem2-kif-crypto/x64':['arm64','x64'],'web-renderer-network/x64':['x64']});
});

test('a project with multiple ABI builds plans each declared version independently',t=>{
 const directory=githubFixture(t),file=path.join(directory,'projects/downloadable.json'),projects=JSON.parse(fs.readFileSync(file)),project=projects[0];
 project.packageProfiles.push({version:'1.1.0',label:'Engine ABI 1.1'});project.build=[{...project.build,architectures:['x64']},{...project.build,version:'1.1.0',architectures:['universal']}];fs.writeFileSync(file,JSON.stringify(projects));
 assert.deepEqual(buildPlan({project:'engine',directory}),{include:[row('x64'),row('universal','1.1.0')]});
 assert.deepEqual(buildPlan({project:'engine',version:'1.1.0',directory}),{include:[row('universal','1.1.0')]});
 assert.deepEqual(buildPlan({project:'engine',arch:'x64',directory}),{include:[row('x64')]});
 assert.deepEqual(buildPlan({project:'engine',arch:'universal',directory}),{include:[row('universal','1.1.0')]});
 assert.throws(()=>buildRecords({...project,build:[project.build[0],project.build[0]]}),/distinct declared versions/);
});

test('graphics outputs use different build hosts while retaining one version per CPU',t=>{
 const project=readProjects(root,{resolvePins:false}).projects.find(project=>project.id==='reshade');
 const directory=githubFixture(t),manifest=JSON.parse(fs.readFileSync(path.join(root,'projects.json')));
 for(const file of ['projects.json',...Object.values(manifest.registries)])fs.copyFileSync(path.join(root,file),path.join(directory,file));
 const matrix=buildPlan({project:'reshade',directory}).include;
 const version=buildRecord(project).version;
 assert.deepEqual(matrix.map(row=>[row.version,row.arch,row.runner]),[[version,'universal','xcode-27'],[version,'x64','macos-26-intel']]);
 assert.deepEqual(buildRecord(project).architectures,['universal','x64']);
 assert.throws(()=>buildRecord({...project,build:{...project.build,runners:{x64:'self-hosted'}}}),/hosted/);
 assert.throws(()=>buildRecord({...project,build:{...project.build,runners:{arm64:'macos-26'}}}),/hosted/);
});

test('every build host is prepared by one shared step on its declared hosted runner',()=>{
 for(const label of Object.values(RUNNERS))assert.ok(HOSTED_RUNNERS[label],label);
 for(const [label,runner] of Object.entries(HOSTED_RUNNERS)){
  assert.ok(['macos','linux'].includes(runner.os)&&['arm64','x64'].includes(runner.cpu),label);
  assert.equal(Boolean(runner.developerDirectory),runner.os==='macos',label);
  assert.doesNotMatch(label,/-(?:large|xlarge)$|self-hosted/);
 }
 const calls=[],run=(command,args)=>calls.push([command,...args]);
 const linux={label:'ubuntu-24.04',runner:HOSTED_RUNNERS['ubuntu-24.04'],rustToolchain:'1.99.0',platform:'linux',cpu:'x64',environment:{PATH:'/usr/bin:/bin'},run};
 assert.throws(()=>prepareBuildHost({...linux,build:{},cpu:'arm64'}),/ubuntu-24\.04 runner \(linux x64\), which linux arm64 cannot run/);
 assert.throws(()=>prepareBuildHost({...linux,build:{},label:'xcode-27',runner:HOSTED_RUNNERS['xcode-27']}),/xcode-27 runner \(macos arm64\)/);
 const prepared=prepareBuildHost({...linux,build:{rustTargets:['aarch64-apple-darwin']}});
 assert.deepEqual(prepared,{env:{RUSTUP_TOOLCHAIN:'1.99.0'},paths:[]});
 assert.deepEqual(calls,[['rustup','toolchain','install','1.99.0','--profile','minimal'],['rustup','target','add','--toolchain','1.99.0','aarch64-apple-darwin']]);

});
