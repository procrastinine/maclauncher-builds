import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveBuildInputs} from '../tools/resolve-build-inputs.mjs';
import {createRecipeBuildReporter} from '../tools/recipe-build-report.mjs';
import {registerSelection} from '../tools/release-selection.mjs';
import {helperPackage} from '../tools/helper-package.mjs';
import {sealBuildInputReport} from '../tools/seal-build-input-report.mjs';
import {prepareRelease,verifyRelease} from '../tools/release-runtime.mjs';
import {prepareBuildInputs} from '../tools/build-run-inputs.mjs';
import {preparedBuildInput} from '../tools/prepared-build-inputs.mjs';
import {buildInput} from '../tools/build-input.mjs';
import {verify} from '../tools/runtime-package.mjs';

function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-report-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(directory,file)),{recursive:true});fs.writeFileSync(path.join(directory,file),typeof value==='string'?value:JSON.stringify(value));};
 const entry=id=>({id,name:id,delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['tools/'+id+'.mjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:id}],build:{version:'1.0.0',architectures:['arm64'],command:'tools/'+id+'.mjs'}});
 const consumer=entry('consumer'),input=entry('input');input.versionBindings=[{file:'producers/input.json',pointer:'/version'}];
 write('projects.json',{schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[consumer,input]});
 write('tools/consumer.mjs',"import './shared.mjs'; const definition='producers/consumer.json';\n");
 write('tools/shared.mjs','export const shared = true;\n');write('tools/input.mjs',"const definition='producers/input.json';\n");
 write('producers/input.json',{version:'1.0.0',source:{revision:'original-source'},flags:['complete']});
 write('producers/consumer.json',{dependency:{project:'input'},upstream:{revision:'consumer-source'}});
 return {directory,write};
}

test('existing recipe references discover the consumed graph and build unpublished inputs at their releases.txt versions first',async t=>{
 const f=fixture(t),describe=createRecipeBuildReporter({directory:f.directory});
 await assert.rejects(resolveBuildInputs({selection:[{id:'consumer',version:'keep-this-name'}],describe,published:()=>null}),/input has no public release and no line in releases.txt/);
 const result=await resolveBuildInputs({selection:[{id:'consumer',version:'keep-this-name'}],describe,published:()=>null,listed:new Map([['input',['new-input-name']]])});
 assert.deepEqual(result.orderedSelection,[{id:'input',version:'new-input-name'},{id:'consumer',version:'keep-this-name'}]);assert.deepEqual(result.dependencyGraph,{input:[],consumer:['input']});assert.deepEqual(result.levels,[['input'],['consumer']]);assert.equal(result.reports.consumer.definition.inputs[0].definitionDigest,result.reports.input.definitionDigest);
 assert.ok(describe('consumer').definition.files.some(file=>file.path==='tools/shared.mjs'));
 // Build and seal the input selected by that graph; archive verification stays real.
 registerSelection({selection:result.orderedSelection,directory:f.directory});
 const environment={GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'42',GITHUB_SHA:'b'.repeat(40),RELEASE_SELECTION:JSON.stringify(result.orderedSelection),RELEASE_GRAPH:JSON.stringify(result.dependencyGraph),BUILD_REPORTS:JSON.stringify(result.reports)};
 function dataHelper(id,version,contents){
  const output=path.join(f.directory,id+'-output');fs.mkdirSync(path.join(output,'payload'),{recursive:true});
  fs.writeFileSync(path.join(output,'payload','data.txt'),contents,{mode:0o644});fs.writeFileSync(path.join(output,'payload','LICENSE'),'Permission to use this fixture.',{mode:0o644});
  helperPackage({id,version,arch:'arm64',output,minimumMacOS:'13.0',sourceSha256:'c'.repeat(64),record:{}});return output;
 }
 const inputOutput=dataHelper('input','new-input-name','fresh data from this run');sealBuildInputReport({project:'input',output:inputOutput,environment});
 const bundle=path.join(f.directory,'input-release');await prepareRelease({project:'input',input:path.join(inputOutput,'payload'),declaration:JSON.parse(fs.readFileSync(path.join(inputOutput,'declaration.json'))),output:bundle,directory:f.directory});
 // Only Actions transport is injected. Bind the real archive record
 // to that fixture run, as the production prepare step does on GitHub.
 const sidecar=fs.readdirSync(bundle).find(name=>name.endsWith('.tar.gz.json')),record=JSON.parse(fs.readFileSync(path.join(bundle,sidecar)));
 record.build={sourceRevision:environment.GITHUB_SHA,runId:environment.GITHUB_RUN_ID,workflow:'owner/builds/.github/workflows/runtime-build.yml'};
 fs.writeFileSync(path.join(bundle,sidecar),JSON.stringify(record));
 await verifyRelease({bundle,directory:f.directory});
 const transports=[];
 const actual=await prepareBuildInputs({project:'consumer',output:path.join(f.directory,'materialized'),directory:f.directory,environment,
  runGh:async args=>{transports.push(args);assert.equal(args[2],'42');assert.equal(args[6],'runtime-input-new-input-name-arm64');fs.cpSync(bundle,args.at(-1),{recursive:true});}});
 assert.equal(transports.length,1);const map=path.join(f.directory,'materialized/inputs.json');environment.MACLAUNCHER_BUILD_INPUTS=map;
 const fresh=preparedBuildInput('input',environment);assert.equal(fresh.record.asset.sha256,record.asset.sha256);assert.equal(fs.readFileSync(path.join(fresh.root,'data.txt'),'utf8'),'fresh data from this run');
 assert.ok(fs.existsSync(path.join(fresh.root,'../declaration.json')));assert.equal(actual.input.record.version,'new-input-name');
 const previous=process.env.MACLAUNCHER_BUILD_INPUTS;process.env.MACLAUNCHER_BUILD_INPUTS=map;
 let bridged;try{bridged=await buildInput({url:'https://github.com/owner/maclauncher-builds/releases/download/input%2Fvold%2Farm64/old.tar.gz',sha256:'0'.repeat(64)});}finally{if(previous===undefined)delete process.env.MACLAUNCHER_BUILD_INPUTS;else process.env.MACLAUNCHER_BUILD_INPUTS=previous;}
 assert.equal(bridged,fresh.archive);await verify({archive:bridged,sha256:record.asset.sha256,project:'input',version:'new-input-name',arch:'arm64'});
 const consumerOutput=dataHelper('consumer','keep-this-name',fs.readFileSync(path.join(fresh.root,'data.txt'),'utf8'));sealBuildInputReport({project:'consumer',output:consumerOutput,environment});
 const trace=JSON.parse(fs.readFileSync(path.join(consumerOutput,'payload/build-inputs.json')));
 assert.deepEqual(trace.inputs,[{id:'input',version:'new-input-name',arch:'arm64',sha256:record.asset.sha256,release:'input/vnew-input-name/arm64',url:fresh.record.asset.url,sourceRevision:environment.GITHUB_SHA,runId:'42'}]);
 const consumerRelease=path.join(f.directory,'consumer-release');await prepareRelease({project:'consumer',input:path.join(consumerOutput,'payload'),declaration:JSON.parse(fs.readFileSync(path.join(consumerOutput,'declaration.json'))),output:consumerRelease,directory:f.directory});await verifyRelease({bundle:consumerRelease,directory:f.directory});
});

test('a published input is reused as published until its own line is requested',async t=>{
 const f=fixture(t);
 f.write('producers/input.json',{version:'9.9.9-custom',source:{revision:'original-source'},flags:['complete']});
 const describe=createRecipeBuildReporter({directory:f.directory}),published=()=>({version:'1.0.0',digests:{arm64:'exact-verified-archive-digest'}});
 const reused=await resolveBuildInputs({selection:[{id:'consumer',version:'custom-consumer'}],describe,published});
 assert.deepEqual(reused.orderedSelection,[{id:'consumer',version:'custom-consumer'}]);assert.deepEqual(reused.reuseBindings,[{id:'input',version:'1.0.0',digests:{arm64:'exact-verified-archive-digest'}}]);
 f.write('producers/input.json',{version:'9.9.9-custom',source:{revision:'changed-real-source'},flags:['complete']});
 const unchanged=await resolveBuildInputs({selection:[{id:'consumer',version:'custom-consumer'}],describe:createRecipeBuildReporter({directory:f.directory}),published});
 assert.deepEqual(unchanged.orderedSelection,[{id:'consumer',version:'custom-consumer'}]);assert.deepEqual(unchanged.reuseBindings,reused.reuseBindings);
 const requested=await resolveBuildInputs({selection:[{id:'input',version:'1.0.1'},{id:'consumer',version:'custom-consumer'}],describe:createRecipeBuildReporter({directory:f.directory}),published});
 assert.deepEqual(requested.orderedSelection,[{id:'input',version:'1.0.1'},{id:'consumer',version:'custom-consumer'}]);assert.deepEqual(requested.reuseBindings,[]);
});

