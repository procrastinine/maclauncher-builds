import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {verifyProducer,main,buildPlan,pushPlan,runBuild,checkBuildRequest,checkBuildOutput,RUNNERS,HOSTED_RUNNERS} from '../tools/build-runtime.mjs';
import {findBuildTool} from '../tools/build-source.mjs';
import {prepareBuildHost} from '../tools/build-host.mjs';
import {prepareRelease} from '../tools/release-runtime.mjs';
import {readProjects,buildRecord,buildRecords} from '../lib/projects.mjs';
const root=path.resolve(import.meta.dirname,'..');

test('producer routing never substitutes Android for a different project',()=>{
 const selected=main(['--project','fna','--check']);assert.equal(selected.id,'fna');assert.equal(selected.sourceDirectory,'producers/maclauncher');assert.ok(selected.entries.every(entry=>entry.startsWith('producers/maclauncher/')));
 assert.throws(()=>main(['--project','flash-projector','--check']),/retains its supplied binary/);
 assert.throws(()=>main(['--project','not-registered','--check']),/Unknown build project/);
 assert.throws(()=>main(['--project','android','--runtime','fna','--check']),/Select one project/);
});

test('runtime builds require the exact clean source commit recorded by the hub',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-producer-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'sources/android');fs.mkdirSync(path.join(source,'tools'),{recursive:true});
 const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(source,'init','-q');git(source,'config','user.name','Build test');git(source,'config','user.email','test@example.invalid');
 for(const entry of ['build.mjs','check-sources.mjs'])fs.writeFileSync(path.join(source,'tools',entry),'export {};\n');
 git(source,'add','tools');git(source,'commit','-qm','Runtime source');const revision=git(source,'rev-parse','HEAD');
 git(root,'init','-q');git(root,'config','user.name','Build test');git(root,'config','user.email','test@example.invalid');
 git(root,'update-index','--add','--cacheinfo',`160000,${revision},sources/android`);git(root,'commit','-qm','Pin producer');
 const recipe={schemaVersion:1,id:'android',revision,path:'sources/android',buildEntry:'tools/build.mjs',checkEntry:'tools/check-sources.mjs'};
 assert.equal(verifyProducer(root,recipe),source);
 assert.throws(()=>verifyProducer(root,{...recipe,revision:'0'.repeat(40)}),/pinned/);
 fs.appendFileSync(path.join(source,'tools/build.mjs'),'// changed\n');assert.throws(()=>verifyProducer(root,recipe),/local changes/);
});

// A registry with one GitHub-built project and a command that writes a data-only package.
function githubFixture(t,build={architectures:['arm64','x64']},command){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-github-build-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const project={id:'engine',name:'Engine',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['producers/engine/build.mjs'],sourceDirectory:'producers/engine'},upstreams:[],packageProfiles:[{version:'1.0',label:'Engine 1.0'}],build:{version:'1.0',command:'producers/engine/build.mjs',submodules:['producers/engine/upstream'],tools:['meson','ninja'],...build}};
 const helper={id:'helper',name:'Helper',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['producers/helper/build.mjs']},upstreams:[]};
 fs.mkdirSync(path.join(root,'projects'));fs.mkdirSync(path.join(root,'producers/engine'),{recursive:true});
 fs.writeFileSync(path.join(root,'projects.json'),JSON.stringify({schemaVersion:2,repository:'owner/builds',updatePolicy:'manual',registries:{downloadable:'projects/downloadable.json',bundled:'projects/bundled.json'}}));
 fs.writeFileSync(path.join(root,'projects/downloadable.json'),JSON.stringify([project]));fs.writeFileSync(path.join(root,'projects/bundled.json'),JSON.stringify([helper]));
 fs.writeFileSync(path.join(root,'producers/engine/build.mjs'),command??`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const o={};for(let i=2;i<process.argv.length;i+=2)o[process.argv[i].slice(2)]=process.argv[i+1];
const payload=path.join(o.output,'payload');fs.mkdirSync(payload,{recursive:true});
const files={'manifest.json':JSON.stringify({version:'1.0',arch:o.arch}),'LICENSE':'MIT'};
for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(payload,name),bytes,{mode:0o644});
const record=name=>({path:name,size:Buffer.byteLength(files[name]),mode:0o644,sha256:crypto.createHash('sha256').update(files[name]).digest('hex')});
const cpus=o.arch==='arm64'?['arm64']:o.arch==='x64'?(process.env.ENGINE_CPUS||'arm64,x64').split(','):['arm64','x64'];
fs.writeFileSync(path.join(o.output,'declaration.json'),JSON.stringify({id:o.project,version:'1.0',arch:o.arch,launcherArchitectures:cpus,minimumMacOS:'13.0',directoryRelative:o.project+'/1.0/'+o.arch,manifestRelative:'manifest.json',manifestSha256:record('manifest.json').sha256,sourceSha256:record('manifest.json').sha256,sourceRelative:'manifest.json',files:Object.keys(files).map(record),notices:[{name:'Engine',license:'MIT',path:'LICENSE'}]}));
if(process.env.ENGINE_EXTRA)fs.writeFileSync(path.join(o.output,'extra.txt'),'extra');
`);
 return root;
}

const row=(arch,version='1.0')=>({project:'engine',version,arch,runner:RUNNERS[arch]});
const commit=(root,message)=>{for(const args of [['add','-A'],['-c','user.name=t','-c','user.email=t@example.com','commit','-qm',message]])execFileSync('git',['-C',root,...args]);return execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();};

test('a manual GitHub build plans the registered version once for each missing architecture',t=>{
 const root=githubFixture(t),none=()=>[];
 assert.deepEqual(buildPlan({project:'engine',directory:root,tags:none}),{include:[row('arm64'),row('x64')]});
 assert.equal(RUNNERS.arm64,'xcode-27');assert.equal(RUNNERS.x64,'macos-26-intel');assert.equal(RUNNERS.universal,RUNNERS.arm64);
 assert.deepEqual(buildPlan({project:'engine',arch:'x64',version:'1.0',directory:root,tags:none}),{include:[row('x64')]});
 assert.throws(()=>buildPlan({project:'engine',arch:'universal',directory:root,tags:none}),/builds arm64 and x64 packages/);
 assert.throws(()=>buildPlan({project:'engine',version:'2.0',directory:root,tags:none}),/builds version 1\.0/);
 assert.throws(()=>buildPlan({project:'helper',directory:root,tags:none}),/no GitHub build command/);
 // A catalog record or a release tag, which a staged draft also has, means the architecture is never built again.
 fs.mkdirSync(path.join(root,'catalogs'));fs.writeFileSync(path.join(root,'catalogs/engine.json'),JSON.stringify({packages:[{version:'1.0',arch:'arm64'}]}));
 assert.deepEqual(buildPlan({project:'engine',directory:root,tags:none}),{include:[row('x64')]});
 assert.throws(()=>buildPlan({project:'engine',arch:'arm64',directory:root,tags:none}),/already has a arm64 package or tag/);
 assert.throws(()=>buildPlan({project:'engine',directory:root,tags:()=>['engine/v1.0/x64','engine/v0.9/arm64']}),/already has a package for each architecture/);
 execFileSync('git',['init','-q',root]);commit(root,'registry');
 assert.deepEqual(main(['--plan','--project','engine'],root),{include:[row('x64')]});
 for(const args of [['--plan','--project','engine','--output','/tmp/out'],['--plan'],['--plan','--before','a'.repeat(40),'--project','engine'],['--before','a'.repeat(40),'--project','engine','--check']])
  assert.throws(()=>main(args,root),/--plan|--before/);
});

test('a push builds only the GitHub builds whose version or architectures it changed',t=>{
 const root=githubFixture(t,{architectures:['arm64']});execFileSync('git',['init','-q',root]);
 const first=commit(root,'registry'),registry=file=>path.join(root,'projects',file);
 const update=change=>{const projects=JSON.parse(fs.readFileSync(registry('downloadable.json')));change(projects[0]);fs.writeFileSync(registry('downloadable.json'),JSON.stringify(projects));};
 assert.deepEqual(pushPlan({before:'0'.repeat(40),directory:root}),{include:[]});
 assert.deepEqual(pushPlan({before:first,directory:root}),{include:[]});
 fs.writeFileSync(path.join(root,'notes.txt'),'unrelated');const unrelated=commit(root,'notes');
 assert.deepEqual(main(['--plan','--before',first],root),{include:[]});
 // Adding Intel to the build record plans only the new architecture of the published version.
 fs.mkdirSync(path.join(root,'catalogs'));fs.writeFileSync(path.join(root,'catalogs/engine.json'),JSON.stringify({packages:[{version:'1.0',arch:'arm64'}]}));
 update(project=>{project.build.architectures=['arm64','x64'];});commit(root,'intel');
 assert.deepEqual(pushPlan({before:unrelated,directory:root}),{include:[row('x64')]});
 // A previously designated ARM output can be attested but still await catalog publication.
 fs.rmSync(path.join(root,'catalogs/engine.json'));
 assert.deepEqual(pushPlan({before:unrelated,directory:root}),{include:[row('x64')]});
 // A newly declared version plans every architecture without a record or tag.
 const intel=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 update(project=>{project.packageProfiles.push({version:'1.1',label:'Engine 1.1'});project.build.version='1.1';});commit(root,'1.1');
 assert.deepEqual(pushPlan({before:intel,directory:root}),{include:[row('arm64','1.1'),row('x64','1.1')]});
 execFileSync('git',['-C',root,'tag','engine/v1.1/arm64']);
 assert.deepEqual(main(['--plan','--before',intel],root),{include:[row('x64','1.1')]});
});

test('GitHub build records name a contained command, exclusive universal builds and plain tool names',()=>{
 const project=build=>({id:'engine',producer:{kind:'maclauncher',sourceDirectory:'producers/engine'},packageProfiles:[{version:'1.0'}],build:{version:'1.0',command:'producers/engine/build.mjs',architectures:['arm64'],...build}});
 assert.deepEqual(buildRecord(project({})).architectures,['arm64']);
 assert.equal(buildRecord(project({command:'tools/build-engine.mjs'})).command,'tools/build-engine.mjs');
 for(const [build,error] of [[{architectures:[]},/distinct arm64/],[{architectures:['arm64','arm64']},/distinct arm64/],
  [{command:'producers/other/build.mjs'},/command/],[{command:'producers/engine/../build.mjs'},/command/],[{command:'producers/engine/build.sh'},/command/],
  [{tools:['meson; rm']},/tools/],[{version:'2.0'},/declared/],[{version:undefined},/declared/],[{submodules:['../outside']},/submodules/],[{runner:'self-hosted'},/command/]])assert.throws(()=>buildRecord(project(build)),error);
 assert.throws(()=>buildRecord({...project({}),producer:{kind:'prebuilt'}}),/command/);
});

test('a GitHub build runs the registered command and accepts only its declared package',t=>{
 const fixtureRunners=process.platform==='linux'?{arm64:'ubuntu-24.04',x64:'ubuntu-24.04'}:undefined;
 const root=githubFixture(t,{architectures:['arm64','x64'],tools:undefined,...(fixtureRunners?{runners:fixtureRunners}:{})}),work=path.join(root,'work');
 const built=runBuild({project:'engine',arch:'x64',output:path.join(root,'out-x64'),work,directory:root});
 assert.equal(built.version,'1.0');assert.equal(built.arch,'x64');assert.equal(built.payload,path.join(root,'out-x64/payload'));
 assert.equal(main(['--project','engine','--arch','arm64','--output',path.join(root,'out-arm64')],root).arch,'arm64');
 assert.throws(()=>runBuild({project:'engine',arch:'universal',output:path.join(root,'out-universal'),directory:root}),/builds arm64 and x64/);
 assert.throws(()=>runBuild({project:'engine',arch:'x64',output:path.join(root,'out-x64'),directory:root}),/new absolute output/);
 assert.throws(()=>runBuild({project:'engine',arch:'x64',output:'relative',directory:root}),/new absolute output/);
 const previous={...process.env};t.after(()=>{for(const key of ['ENGINE_CPUS','ENGINE_EXTRA'])if(previous[key]===undefined)delete process.env[key];});
 process.env.ENGINE_CPUS='x64';assert.equal(runBuild({project:'engine',arch:'x64',output:path.join(root,'out-intel-only'),directory:root}).arch,'x64');
 process.env.ENGINE_CPUS='arm64';assert.throws(()=>runBuild({project:'engine',arch:'x64',output:path.join(root,'out-cpus'),directory:root}),/Mac CPUs/);delete process.env.ENGINE_CPUS;
 process.env.ENGINE_EXTRA='1';assert.throws(()=>runBuild({project:'engine',arch:'arm64',output:path.join(root,'out-extra'),directory:root}),/only declaration.json and payload/);delete process.env.ENGINE_EXTRA;
 const failing=githubFixture(t,{architectures:['arm64'],tools:undefined,...(fixtureRunners?{runners:{arm64:fixtureRunners.arm64}}:{})},'process.exitCode=3;\n');
 assert.throws(()=>runBuild({project:'engine',arch:'arm64',output:path.join(failing,'out'),directory:failing}),/exited with status 3/);
});

test('Linux outputs reject Mach-O files with explicit and legacy format metadata',t=>{
 const directory=githubFixture(t,{architectures:['arm64'],tools:undefined,runners:{arm64:'ubuntu-24.04'}}),output=path.join(directory,'built');
 const built=runBuild({project:'engine',arch:'arm64',output,directory,platform:'linux',cpu:'x64'});
 const declaration=JSON.parse(fs.readFileSync(built.declaration)),bytes=Buffer.alloc(32);
 bytes.writeUInt32LE(0xfeedfacf,0);bytes.writeUInt32LE(0x0100000c,4);bytes.writeUInt32LE(6,12);
 fs.writeFileSync(path.join(built.payload,'native.dylib'),bytes);
 const file={path:'native.dylib',size:bytes.length,mode:0o644,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),architectures:['arm64']};
 declaration.files.push(file);
 for(const format of [undefined,'mach-o']){
  if(format)file.format=format;else delete file.format;
  fs.writeFileSync(built.declaration,JSON.stringify(declaration));
  assert.throws(()=>checkBuildOutput({project:{id:'engine'},build:{version:'1.0'},arch:'arm64',output,platform:'linux'}),/Mac programs require a hosted Mac runner/);
 }
});

test('every registered GitHub build names an existing command and submodule of this repository',()=>{
 const modules=fs.readFileSync(path.join(root,'.gitmodules'),'utf8'),registry=readProjects(root,{resolvePins:false});
 for(const project of registry.projects.filter(project=>project.build))for(const build of buildRecords(project)){
  for(const entry of project.producer.entries||[])assert.ok(fs.statSync(path.join(root,entry)).isFile(),project.id+' '+entry);
  assert.ok(fs.statSync(path.join(root,build.command)).isFile(),project.id);
  const roots=[...modules.matchAll(/\tpath = ([^\n]+)\n/g)].map(match=>match[1]);
  for(const submodule of build.submodules||[])assert.ok(roots.some(root=>submodule===root||submodule.startsWith(root+'/')),project.id+' '+submodule);
  // Nested paths are checked at each Gitlink by init-runtime-sources before compilation.
 }
});

test('a VNDS-LOVE package revision preserves engine files and historical packaging',async t=>{
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'vnds-love-build-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const {build}=await import('../producers/engine-adaptations/stage.mjs'),output=path.join(work,'build');
 const staged=build({project:'vnds-love',arch:'universal',output});
 const built={version:staged.version,declaration:path.join(output,'declaration.json'),payload:path.join(output,'payload')};
 assert.equal(built.version,buildRecord(readProjects(root,{resolvePins:false}).projects.find(row=>row.id==='vnds-love')).version);
 const published=JSON.parse(fs.readFileSync(path.join(root,'catalogs/vnds-love.json'))).packages[0];
 const {stageData}=await import('../producers/engine-adaptations/stage.mjs'),input=path.join(work,'historical');
 const declaration=stageData({project:'vnds-love',version:published.version,output:input});
 const release=await prepareRelease({project:'vnds-love',input,declaration,output:path.join(work,'release')});
 assert.equal(release.assets.find(asset=>asset.role==='runtime').sha256,published.asset.sha256);
 const actual=JSON.parse(fs.readFileSync(built.declaration));
 assert.deepEqual(actual.files.filter(row=>row.path!=='manifest.json'),declaration.files.filter(row=>row.path!=='manifest.json'));
});

test('the Runtime build workflow builds each architecture on its own runner before staging drafts',()=>{
 const workflow=fs.readFileSync(path.join(root,'.github/workflows/runtime-build.yml'),'utf8');
 assert.match(workflow,/node tools\/build-runtime\.mjs --plan --before "\$BEFORE"/);assert.match(workflow,/node tools\/build-runtime\.mjs --plan --project "\$BUILD_PROJECT" --arch "\$BUILD_ARCH"/);
 assert.match(workflow,/matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);assert.match(workflow,/runs-on: \$\{\{ matrix\.runner \}\}/);
 assert.match(workflow,/tools\/release-runtime\.mjs prepare --project "\$BUILD_PROJECT"/);assert.match(workflow,/tools\/release-runtime\.mjs verify --bundle "\$RUNNER_TEMP\/release" --project "\$BUILD_PROJECT" --version "\$BUILD_VERSION" --arch "\$BUILD_ARCH"/);
 const stage=workflow.slice(workflow.indexOf('\n  stage:'));
 assert.match(stage,/if: github\.event_name == 'workflow_dispatch' && inputs\.operation == 'stage'/);
 assert.match(workflow,/push:\n    branches: \[main\]\n    paths:\n      - projects\.json\n      - projects\/\*\*/);assert.match(workflow,/if: needs\.plan\.outputs\.empty == 'false'/);
 const attestations=[...workflow.matchAll(/      - uses: actions\/attest-build-provenance@([a-f0-9]{40}) # v4\.2\.2\n((?:        [^\n]*\n)+)/g)];assert.equal(attestations.length,2);assert.equal(attestations[0][1],attestations[1][1]);
 for(const [, ,block] of attestations)assert.match(block,/subject-path: \$\{\{ runner\.temp \}\}\/release\/\*\.tar\.gz/);
 assert.match(attestations[0][2],/id: attest\n        continue-on-error: true/);assert.match(attestations[1][2],/if: steps\.attest\.outcome == 'failure' && !cancelled\(\)/);assert.ok(!attestations[1][2].includes('continue-on-error'));
 assert.match(workflow,/run: sleep 5/);assert.match(stage,/needs: build/);assert.match(stage,/github\.ref != 'refs\/heads\/main'/);
 assert.match(stage,/stage --bundle "\$bundle" --target "\$GITHUB_SHA"/);assert.ok(!workflow.slice(0,workflow.indexOf('\n  stage:')).includes('contents: write'));
 const release=fs.readFileSync(path.join(root,'.github/workflows/runtime-release.yml'),'utf8');
 assert.match(release,/build-run:/);assert.match(release,/tools\/verified-build-run\.mjs --input/);
 assert.match(release,/--json workflowName,headSha,headBranch,status,jobs/);
 assert.match(release,/\[ "\$BUILD_SOURCE_REVISION" = "\$RELEASE_SOURCE_REVISION" \]/);
 assert.match(release,/--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/runtime-build\.yml" --source-digest/);
 assert.equal(release.split("git rev-parse 'FETCH_HEAD^{commit}'").length,3,'Both release paths resolve annotated tags to their source commit.');
 assert.match(release,/verify-remote --bundle/);
 const proofStep=release.match(/      - name: Verify and record the signed build\n        if: env.PUBLICATION_AUTHORITY != 'supplied-publisher'\n        run: \|\n((?:          [^\n]*\n)+)/)?.[1];
 assert.ok(proofStep,'Compiled release paths import the signed proof before publication.');
 assert.match(release,/const supplied = readPublisherInput\(\{project: p.id\}\)/);
 assert.match(release,/supplied && process.env.BUILD_RUN/);
 assert.match(release,/name: Verify supplied publisher archive\n        if: env.PUBLICATION_AUTHORITY == 'supplied-publisher'\n        run: node tools\/publisher-files\.mjs verify/);
 assert.match(proofStep,/--format json > "\$RUNNER_TEMP\/verified-build\.json"/);
 assert.match(proofStep,/node tools\/record-github-build\.mjs --release-bundle "\$RUNNER_TEMP\/runtime-release" --bundle "\$RUNNER_TEMP\/verified-build\.json"/);
 assert.equal([...release.matchAll(/gh attestation verify/g)].length,1);
 assert.ok(release.indexOf('name: Verify and record the signed build')<release.indexOf('name: Stage the existing build artifact'));
 assert.ok(release.indexOf('name: Verify and record the signed build')<release.indexOf('name: Verify the existing draft'));
});

test('registered GitHub build commands reject architectures their projects do not build',async t=>{
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'github-build-commands-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const request=(project,arch)=>({project,arch,output:path.join(work,project+'-'+arch),work:path.join(work,project+'-'+arch+'-work')});
 assert.throws(()=>checkBuildRequest(request('vnds-love','arm64')),/builds universal packages/);
 assert.throws(()=>checkBuildRequest(request('rlvm-adapter','x64')),/builds universal packages/);
 assert.throws(()=>checkBuildRequest({...request('sys3-decompiler','universal'),version:'0.5.0-MCLv2'}),/builds arm64 packages/);
 assert.throws(()=>checkBuildRequest(request('web-renderer-network','ppc')),/builds arm64 and x64 packages/);
 const {buildDecompiler}=await import('../producers/maclauncher/scripts/build-decompiler.mjs');
 await assert.rejects(buildDecompiler({project:'gemrb',arch:'arm64',output:path.join(work,'gemrb'),work:path.join(work,'gemrb-work')}),/decompiler profiles have no release/);
 assert.throws(()=>checkBuildRequest({...request('sys3-decompiler','arm64'),version:'0.5.0'}),/builds version|declared|version/);
 const registry=readProjects(root,{resolvePins:false});
 for(const [id,architectures] of [['sys3-decompiler',['arm64','x64']],['xsys35-decompiler',['arm64','x64']],['gm8-decompiler',['arm64','x64']],['catsystem2-kif-crypto',['arm64','x64']],['web-renderer-network',['arm64','x64']]])assert.deepEqual(buildRecords(registry.projects.find(project=>project.id===id)).flatMap(build=>build.architectures).sort(),architectures);
 assert.deepEqual(buildRecords(registry.projects.find(project=>project.id==='java-steamworks')).map(build=>[build.version,build.architectures]),[['1.9.0-MCLv2',['x64']],['1.10.0-MCLv2',['universal']]]);
 const {helperProfile}=await import('../tools/build-helper.mjs');
 assert.throws(()=>helperProfile('gemrb'),/ENOENT|helper-builds/);
 for(const id of ['catsystem2-kif-crypto','web-renderer-network','steam-api-helper','steam-ticket-loader','mkxpz-config-helper'])assert.equal(helperProfile(id).profile.version,registry.projects.find(project=>project.id===id).build.version);
});

test('one shared request check covers every registered build command before its recipe starts',t=>{
 const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'build-requests-')));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const commands=new Set(readProjects(root,{resolvePins:false}).projects.filter(project=>project.build).flatMap(project=>buildRecords(project).map(build=>build.command)));
 for(const command of commands){
  const source=fs.readFileSync(path.join(root,command),'utf8');
  assert.match(source,/recipeMain\(import\.meta,|checkBuildRequest/,command);
  // Host input selection (for example a JDK archive) may observe the CPU.
  assert.doesNotMatch(source,/process\.arch\s*[!=]=|(?:if|throw)[^\n]*process\.arch/,command);
 }
 const request={project:'gemrb',version:'MCLv2-1020',arch:'arm64',platform:'darwin',cpu:'arm64',output:path.join(work,'out'),work:path.join(work,'work')};
 assert.equal(checkBuildRequest(request).build.command,'tools/build-portable-runtime.mjs');
 for(const [change,pattern] of [[{output:'relative'},/new absolute output/],[{output:work},/new absolute output/],[{work:path.join(work,'out','work')},/separate absolute work/],
  [{version:'0.0'},/builds version/],[{platform:'linux',cpu:'arm64'},/cannot run/],[{platform:'darwin',cpu:'x64',arch:'arm64'},/cannot run/]])
  assert.throws(()=>checkBuildRequest({...request,...change}),pattern);
 // An Apple Silicon Mac also builds for an Intel runner; GitHub prepares only the exact runner.
 assert.equal(checkBuildRequest({...request,version:'MCLv1-1020',arch:'x64',platform:'darwin',cpu:'arm64'}).runner,'macos-26-intel');
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
 assert.doesNotMatch(String(findBuildTool),/homebrew|usr\/local/);
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


test('a project with multiple ABI builds plans missing versions independently',t=>{
 const directory=githubFixture(t),file=path.join(directory,'projects/downloadable.json'),projects=JSON.parse(fs.readFileSync(file)),project=projects[0];
 project.packageProfiles.push({version:'1.1',label:'Engine ABI 1.1'});project.build=[{...project.build,architectures:['x64']},{...project.build,version:'1.1',architectures:['universal']}];fs.writeFileSync(file,JSON.stringify(projects));
 assert.deepEqual(buildPlan({project:'engine',directory,tags:()=>[]}),{include:[row('x64'),row('universal','1.1')]});
 assert.deepEqual(buildPlan({project:'engine',version:'1.1',directory,tags:()=>[]}),{include:[row('universal','1.1')]});
 assert.deepEqual(buildPlan({project:'engine',arch:'x64',directory,tags:()=>[]}),{include:[row('x64')]});
 assert.deepEqual(buildPlan({project:'engine',arch:'universal',directory,tags:()=>[]}),{include:[row('universal','1.1')]});
 assert.deepEqual(buildPlan({project:'engine',directory,tags:()=>['engine/v1.0/x64']}),{include:[row('universal','1.1')]});
 assert.throws(()=>buildPlan({project:'engine',directory,tags:()=>['engine/v1.0/x64','engine/v1.1/universal']}),/already has a package for each declared version/);
 assert.throws(()=>buildRecords({...project,build:[project.build[0],project.build[0]]}),/distinct declared versions/);
});


test('graphics outputs use different build hosts while retaining one version per CPU',()=>{
 const matrix=buildPlan({project:'reshade',directory:root,tags:()=>[]}).include;
 assert.deepEqual(matrix.map(row=>[row.version,row.arch,row.runner]),[['0.3.1','universal','xcode-27'],['0.3.1','x64','macos-26-intel']]);
 const project=readProjects(root,{resolvePins:false}).projects.find(project=>project.id==='reshade');
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
 const workflow=fs.readFileSync(path.join(root,'.github/workflows/runtime-build.yml'),'utf8');
 assert.match(workflow,/run: node tools\/build-runtime\.mjs --prepare --project "\$BUILD_PROJECT" --arch "\$BUILD_ARCH" --version "\$BUILD_VERSION"/);
 for(const text of ['brew install','rustup ','xcodebuild','init-runtime-sources','cleanup-runner.mjs'])assert.ok(!workflow.includes(text),text);
});
