import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';
import {prepareBuildInputs} from '../tools/build-run-inputs.mjs';
import {createRequire} from 'node:module';
const requirements=createRequire(import.meta.url)('./support/requirements.cjs');

const project=(id,command)=>({id,name:id,delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:[command]},upstreams:[],packageProfiles:[{version:'1.0.0',label:id}],build:{version:'1.0.0',architectures:['arm64'],command}});

function fixture(t,files,projects=[project('recipe','tools/recipe.cjs')],buildCode){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-modules-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(directory,file)),{recursive:true});fs.writeFileSync(path.join(directory,file),typeof value==='string'?value:JSON.stringify(value));};
 write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects,...(buildCode?{buildCode}:{})});
 for(const [file,value] of Object.entries(files))write(file,value);
 execFileSync('git',['init','-q'],{cwd:directory});execFileSync('git',['add','-A'],{cwd:directory});
 return {directory,write};
}
const paths=report=>report.definition.files.map(file=>file.path).sort();

test('a definition holds the declared inputs and every tracked file their literal imports name',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.entries.push('tools/helpers','tools/missing.cjs');
 const f=fixture(t,{'tools/recipe.cjs':'const path=require("node:path");require("./helpers"); require("./imported.cjs"); require("../lib/shared.mjs"); require(path.join(__dirname,"computed.cjs"));\n',
  'tools/helpers/index.js':'module.exports = require("./more");\n','tools/helpers/more.js':'module.exports = 1;\n','tools/helpers/data.json':{version:'1.0.0'},
  'tools/imported.cjs':'module.exports = 2;\n','tools/computed.cjs':'module.exports = 5;\n','lib/shared.mjs':'import "./nested.mjs";\nexport const shared = 1;\n','lib/nested.mjs':'export {};\n'},[recipe],['lib/shared.mjs']);
 const describe=createRecipeBuildReporter({directory:f.directory}),report=describe('recipe');
 assert.deepEqual(paths(report),['lib/nested.mjs','lib/shared.mjs','tools/computed.cjs','tools/helpers/data.json','tools/helpers/index.js','tools/helpers/more.js','tools/imported.cjs','tools/recipe.cjs']);
 assert.deepEqual(describe.unresolved('recipe'),[{file:'projects',expression:'tools/missing.cjs',reason:'missing'}]);
 // A literal path assembled from __dirname is an input too.
 f.write('tools/computed.cjs','module.exports = 6;\n');assert.notEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definitionDigest,report.definitionDigest);
 f.write('tools/imported.cjs','module.exports = 3;\n');assert.notEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definitionDigest,report.definitionDigest);
});

test('a definition holds the literal paths its code builds from its own location',t=>{
 const recipe=project('recipe','tools/recipe.mjs');
 const f=fixture(t,{'tools/recipe.mjs':'import fs from "node:fs";\nimport path from "node:path";\nimport {base} from "./places.mjs";\nconst root=path.resolve(import.meta.dirname,".."),native=path.join(base,"native");\n'+
  'fs.readFileSync(path.join(root,"data/source.json"));fs.readFileSync(path.join(native,"scene.json"));fs.readFileSync(new URL("../data/url.json",import.meta.url));fs.readFileSync(path.join(root,process.env.NAME||"data/dynamic.json"));\n',
  'tools/places.mjs':'import path from "node:path";\nexport const root=path.resolve(import.meta.dirname,".."),base=path.join(root,"producers/support");\n',
  'data/source.json':{a:1},'data/url.json':{b:1},'data/dynamic.json':{c:1},'producers/support/native/scene.json':{d:1}},[recipe]);
 assert.deepEqual(paths(createRecipeBuildReporter({directory:f.directory})('recipe')),['data/source.json','data/url.json','producers/support/native/scene.json','tools/places.mjs','tools/recipe.mjs']);
});

for(const [project,file] of [['siglus','producers/vn-adaptations/source.json'],['vulkan-moltenvk-scene','producers/package-support/src/modules/shared/vulkan/native/moltenvk-scene-source.json']])test(project+' definitions hold the data their recipes read through literal paths',()=>{
 assert.ok(paths(createRecipeBuildReporter()(project)).includes(file));
});

test('vnds-love definitions hold the data their recipes copy from source lists',()=>{
 const engine='producers/engine-adaptations/vnds-love',files=paths(createRecipeBuildReporter()('vnds-love'));
 for(const file of Object.keys(JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'..',engine,'source.json'),'utf8')).files))assert.ok(files.includes(engine+'/'+file),file);
});

test('java-steamworks declares the steamworks4j notice of every publisher release it builds',()=>{
 // The recipe reads steamworks4j-<version>-MIT.txt through a computed path, so a declaration must cover it.
 const base='producers/package-support/src/modules/java/runtime/steamworks',files=paths(createRecipeBuildReporter()('java-steamworks'));
 for(const release of JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'..',base,'publisher-releases.json'),'utf8')))
  assert.ok(files.includes(base+'/steamworks4j-'+release.version+'-MIT.txt'),release.version);
});

test('Builds definitions hold the helpers their recipes import without listing them',()=>{
 // origin/main before the closure: mpv omitted tools/helper-package.mjs and java-steamworks tools/build-input.mjs.
 const describe=createRecipeBuildReporter();
 assert.ok(paths(describe('mpv')).includes('tools/helper-package.mjs'));
 assert.ok(paths(describe('java-steamworks')).includes('tools/build-input.mjs'));
});

test('a declared .js file brings the package.json whose type Node loads it by',t=>{
 const recipe=project('recipe','tools/recipe.mjs');recipe.producer.entries.push('producers/support/module.js','producers/support/data.cjs');
 const f=fixture(t,{'tools/recipe.mjs':'export {};\n','producers/support/module.js':'module.exports = 1;\n','producers/support/data.cjs':'module.exports = 2;\n',
  'producers/package.json':{type:'commonjs'},'producers/other/package.json':{type:'module'}},[recipe]);
 const report=createRecipeBuildReporter({directory:f.directory})('recipe');
 assert.deepEqual(paths(report),['producers/package.json','producers/support/data.cjs','producers/support/module.js','tools/recipe.mjs']);
 f.write('producers/package.json',{type:'module'});
 assert.notEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definitionDigest,report.definitionDigest);
});

test('each project declares its own package inputs, also when projects share a command',t=>{
 const first=project('first','tools/shared.mjs'),second=project('second','tools/shared.mjs'),unknown=project('unknown','tools/shared.mjs');
 first.build.inputs=['input'];unknown.build.inputs=['absent'];
 const f=fixture(t,{'tools/input.mjs':'export const input = true;\n','tools/shared.mjs':'export const shared = true;\n'},[first,second,unknown,project('input','tools/input.mjs')]);
 const describe=createRecipeBuildReporter({directory:f.directory});
 assert.deepEqual(describe('first').inputs,[{id:'input'}]);assert.deepEqual(describe('second').inputs,[]);
 assert.deepEqual(describe.unresolved('unknown'),[{file:'projects',expression:'absent',reason:'input',problem:'A package input names another registered project.'}]);
});

test('an upstream pinned by a record inside a checkout takes the record commit, not the checkout commit',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.build.submodules=['sources/supplier'];
 recipe.upstreams=[{id:'engine',provider:'github',url:'https://github.com/owner/engine',repository:'owner/engine',pin:{file:'sources/supplier/upstreams.json',pointer:'/engine/revision',repositoryPointer:'/engine/repository'}}];
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n','sources/supplier/upstreams.json':{engine:{repository:'https://github.com/owner/engine',revision:'3'.repeat(40)}}},[recipe]);
 const supplier=path.join(f.directory,'sources/supplier'),git=(cwd,...args)=>execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid',...args],{cwd,stdio:'ignore'});
 execFileSync('git',['rm','-r','-q','--cached','sources/supplier'],{cwd:f.directory});
 git(supplier,'init','-q');git(supplier,'add','-A');git(supplier,'commit','-q','-m','supplier');git(f.directory,'add','sources/supplier');
 const checkout=execFileSync('git',['rev-parse','HEAD'],{cwd:supplier,encoding:'utf8'}).trim();
 const [source]=createRecipeBuildReporter({directory:f.directory})('recipe').definition.sources;
 assert.equal(source.revision,'3'.repeat(40));assert.notEqual(source.gitlink,checkout);
});

test('an app entry without the app source profile is unresolved',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.appEntries=['src/app.js'];
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n'},[recipe]);
 assert.deepEqual(createRecipeBuildReporter({directory:f.directory}).unresolved('recipe').map(row=>row.expression),['app:src/app.js']);
});

test('declared records and pins are validated once, by the resolver',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.entries.push('tools/source.json');
 recipe.upstreams=[{id:'engine',provider:'github',url:'https://github.com/owner/engine',repository:'owner/engine',revision:'1'.repeat(40),pin:{file:'tools/source.json',pointer:'/engine'}}];
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n','tools/source.json':{engine:{repository:'https://github.com/owner/engine',commit:'2'.repeat(40)}}},[recipe]);
 assert.deepEqual(createRecipeBuildReporter({directory:f.directory}).unresolved('recipe').map(row=>[row.reason,row.problem]),[
  ['pin','A referenced source pin cannot also declare a revision, version or timestamp override.'],
  ['record','A source record names its exact commit as revision.'],
  ['record','A source record names its exact commit as revision.']]);
});

test('a source record with an archive digest is a source archive that the input step fetches',async t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.entries.push('tools/sources.json');
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n','tools/sources.json':{sources:[
  {id:'tool',repository:'https://github.com/owner/tool',revision:'1'.repeat(40),archive:{sha256:'a'.repeat(64)}},
  {id:'elsewhere',repository:'https://example.com/tool',revision:'2'.repeat(40),archive:{sha256:'b'.repeat(64)}}]}},[recipe]);
 const describe=createRecipeBuildReporter({directory:f.directory}),report=describe('recipe');
 assert.deepEqual(report.definition.archives,[{url:'https://github.com/owner/tool/archive/'+'1'.repeat(40)+'.tar.gz',sha256:'a'.repeat(64)}]);
 assert.deepEqual(describe.unresolved('recipe').map(row=>[row.reason,row.problem]),[['record','A source archive names a GitHub repository, its exact revision and the archive SHA-256.']]);
 const fetched=[];
 await prepareBuildInputs({project:'recipe',output:path.join(f.directory,'prepared'),directory:f.directory,environment:{RELEASE_SELECTION:'recipe=1.0.0',BUILD_REPORTS:JSON.stringify({recipe:report})},fetchArchive:async archive=>{fetched.push(archive);}});
 assert.deepEqual(fetched,report.definition.archives);
});
test('archive pins list the archive records they select, each fetched only for the architectures that read it',async t=>{
 const recipe=project('recipe','tools/recipe.cjs'),file='tools/inputs.json',row=(name,digit)=>({url:'https://example.com/'+name+'.tar.gz',sha256:digit.repeat(64)});
 recipe.build.architectures=['arm64','x64'];recipe.build.archives=[{file,pointer:'/common'},{file,pointer:'/arm64',arch:'arm64'},{file,pointer:'/x64',arch:'x64'},{file,pointer:'/notes'}];
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n',[file]:{common:{tool:row('tool','a')},arm64:[row('sdk-arm64','b'),row('runtime','c')],x64:{sdk:row('sdk-x64','d'),runtime:row('runtime','c')},notes:{text:'none'}}},[recipe]);
 const describe=createRecipeBuildReporter({directory:f.directory}),report=describe('recipe');
 assert.deepEqual(report.definition.archives,[row('runtime','c'),{...row('sdk-arm64','b'),arch:'arm64'},{...row('sdk-x64','d'),arch:'x64'},row('tool','a')]);
 assert.deepEqual(describe.unresolved('recipe').map(row=>[row.reason,row.problem]),[['archive','The archive pin selects no archive record.']]);
 const fetched=[];
 await prepareBuildInputs({project:'recipe',output:path.join(f.directory,'prepared'),directory:f.directory,environment:{RELEASE_SELECTION:'recipe=1.0.0',BUILD_ARCH:'x64',BUILD_REPORTS:JSON.stringify({recipe:report})},fetchArchive:async archive=>{fetched.push(archive.url);}});
 assert.deepEqual(fetched,['https://example.com/runtime.tar.gz','https://example.com/sdk-x64.tar.gz','https://example.com/tool.tar.gz']);
});
test('a files row without its own url reads the url of the record that lists it',t=>{
 const recipe=project('recipe','tools/recipe.cjs'),file='tools/catalog.json';recipe.build.archives=[{file,pointer:''}];
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n',[file]:{url:'https://example.com/main.jar',files:[{path:'main.jar',size:5,sha256:'a'.repeat(64)},{path:'extra.jar',url:'https://example.com/extra.jar',sha256:'b'.repeat(64)}],member:{path:'lib.dylib',size:3,sha256:'c'.repeat(64)}}},[recipe]);
 assert.deepEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definition.archives,[{url:'https://example.com/extra.jar',sha256:'b'.repeat(64)},{url:'https://example.com/main.jar',sha256:'a'.repeat(64),bytes:5}]);
});
test('a lock-file archive pin reads the record fields from the shell-style variables it names',t=>{
 const recipe=project('recipe','tools/recipe.cjs'),file='tools/toolchain.lock';
 recipe.build.archives=[{file,keys:{url:'JDK_URL',sha256:'JDK_SHA256'}},{file,keys:{url:'TOOLS_URL',sha256:'TOOLS_SHA256'}}];
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n',[file]:'# Toolchain\nJDK_URL=https://example.com/jdk.tar.gz\nJDK_SHA256='+'a'.repeat(64)+'\nTOOLS_URL=https://example.com/tools.zip\n'},[recipe]);
 const describe=createRecipeBuildReporter({directory:f.directory}),report=describe('recipe');
 assert.deepEqual(report.definition.archives,[{url:'https://example.com/jdk.tar.gz',sha256:'a'.repeat(64)}]);
 assert.ok(report.definition.files.some(row=>row.path===file));
 assert.deepEqual(describe.unresolved('recipe').map(row=>[row.reason,row.problem]),[['pin','Missing or ambiguous lock value TOOLS_SHA256 in toolchain.lock.']]);
});
test('a directory entry declares every tracked file below it',t=>{
 const recipe=project('recipe','tools/recipe.cjs');recipe.producer.entries.push('native/base');
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};\n','native/base/src/compile.cpp':'int main() {}\n','native/base/THIRD_PARTY.md':'notices\n','native/other.cpp':'int other;\n'},[recipe]);
 assert.deepEqual(createRecipeBuildReporter({directory:f.directory})('recipe').definition.files.map(file=>file.path).sort(),['native/base/THIRD_PARTY.md','native/base/src/compile.cpp','tools/recipe.cjs']);
});

test('publication changes leave every package definition unchanged',t=>{
 const f=fixture(t,{'tools/first.cjs':'require("./pack");','tools/second.cjs':'require("./pack");','tools/pack.js':'exports.pack = () => 1; exports.catalog = () => import("./publication/catalog.mjs");','tools/publication/catalog.mjs':'export const publish = 1;'},[project('first','tools/first.cjs'),project('second','tools/second.cjs')],['tools/pack.js']);
 const digests=()=>{const describe=createRecipeBuildReporter({directory:f.directory});return ['first','second'].map(id=>describe(id).definitionDigest);};
 const before=digests();f.write('tools/publication/catalog.mjs','export const publish = 2;');assert.deepEqual(digests(),before);
 f.write('tools/first.cjs','require("./pack"); exports.changed = true;');const recipe=digests();assert.notEqual(recipe[0],before[0]);assert.equal(recipe[1],before[1]);
 f.write('tools/pack.js','exports.pack = () => 2; exports.catalog = () => import("./publication/catalog.mjs");');const packed=digests();assert.notEqual(packed[0],recipe[0]);assert.notEqual(packed[1],recipe[1]);
});

test('the shared build action and the tools it runs are declared build code',t=>{
 const f=fixture(t,{'tools/recipe.cjs':'module.exports = {};','.github/actions/build-runtime/action.yml':'runs:\n  steps:\n    - run: node tools/package.mjs prepare\n    - uses: ./.github/actions/network\n','.github/actions/network/action.yml':'runs:\n  using: node24\n  main: ../../../tools/network-action.cjs\n','tools/network-action.cjs':'require("./download.mjs");','tools/download.mjs':'export const retryNetwork = true;','tools/package.mjs':'export const pack = 1;'},undefined,['.github/actions','tools/download.mjs','tools/network-action.cjs','tools/package.mjs']);
 const report=()=>createRecipeBuildReporter({directory:f.directory})('recipe');const before=report();
 assert.deepEqual(paths(before),['.github/actions/build-runtime/action.yml','.github/actions/network/action.yml','tools/download.mjs','tools/network-action.cjs','tools/package.mjs','tools/recipe.cjs']);
 f.write('tools/package.mjs','export const pack = 2;');assert.notEqual(report().definitionDigest,before.definitionDigest);
});

test('only a definition that declares app-source.json carries the app pin and its declared app gitlinks',requirements({sourceTree:'sources/maclauncher'}),async()=>{
 const directory=path.resolve(import.meta.dirname,'..'),{readProjects}=await import('../lib/projects.mjs'),describe=createRecipeBuildReporter({directory});
 for(const project of readProjects(directory,{resolvePins:false}).projects.filter(project=>project.build)){
  const links=describe(project.id).definition.gitlinks.map(link=>link.path),declares=(project.producer.entries||[]).includes('producers/package-support/app-source.json');
  assert.equal(links.includes('sources/maclauncher'),declares,project.id);
  if(!declares)assert.ok(!links.some(link=>link.startsWith('sources/maclauncher/')),project.id);
 }
});

test('every production definition excludes publication, catalog and planning files',requirements({sourceTree:'sources/maclauncher'}),async()=>{
 const directory=path.resolve(import.meta.dirname,'..'),{readProjects}=await import('../lib/projects.mjs'),describe=createRecipeBuildReporter({directory});
 for(const project of readProjects(directory,{resolvePins:false}).projects.filter(project=>project.build)){
  for(const file of describe(project.id).definition.files)assert.doesNotMatch(file.path,/^tools\/(?:publication\/|publish-|plan-|dispatch-|catalog-|package-index|release-runtime|publication-authority)/,project.id+': '+file.path);
 }
});

test('a source pinned by a gitlink inside a pinned checkout records that checkout\'s commit for it',t=>{
 const root=path.resolve(import.meta.dirname,'..'),outer='sources/maclauncher-kosmickrisp',inner=outer+'/sources/mesa';
 if(!fs.existsSync(path.join(root,outer,'.git')))return t.skip('KosmicKrisp source is not initialized');
 const recorded=execFileSync('git',['-C',path.join(root,outer),'rev-parse',execFileSync('git',['-C',root,'rev-parse','HEAD:'+outer],{encoding:'utf8'}).trim()+':sources/mesa'],{encoding:'utf8'}).trim();
 const reporter=createRecipeBuildReporter({directory:root}),definition=reporter('vulkan-kosmickrisp-gles32').definition;
 const source=definition.sources.find(row=>row.pin?.gitlink===inner);
 assert.equal(source.gitlink,recorded);
 assert.deepEqual(reporter.unresolved('vulkan-kosmickrisp-gles32'),[]);
});
