import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import Archive from '../lib/archive.cjs';
import {catalog} from '../tools/runtime-package.mjs';
import {readPublisherInput,recordPublisherFiles,verifyPublisherRecord,verifyPublisherArchive,assertPublisherSource,main as publisherMain} from '../tools/publisher-files.mjs';
import {requirePublicationAuthority} from '../tools/publication-authority.mjs';
import {stageRelease,publishRelease,applyRelease} from '../tools/release-runtime.mjs';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const id='sample-publisher',repository='owner/builds';
const supplied={'vendor/Player':{bytes:Buffer.from('#!/bin/sh\nexit 0\n'),mode:0o755},'vendor/data':{bytes:Buffer.from([0,1,2,3]),mode:0o644},'vendor/LICENSE':{bytes:Buffer.from('MIT license\n'),mode:0o644}};
async function bundle(directory,version,change=()=>{}){
 const files=Object.fromEntries(Object.entries(supplied).map(([name,row])=>[name,{...row}]));
 files['manifest.json']={bytes:Buffer.from(json({version,executableRelative:'vendor/Player'})),mode:0o644};
 const notices=[{name:'Supplied publisher',license:'MIT',path:'vendor/LICENSE'}];change(files,notices);
 const inventory=Object.entries(files).map(([name,row])=>({path:name,size:row.bytes.length,mode:row.mode,sha256:sha(row.bytes)}));
 const manifest=inventory.find(file=>file.path==='manifest.json');
 const declaration={id,version,arch:'universal',launcherArchitectures:['arm64','x64'],minimumMacOS:'11.0',directoryRelative:id+'/'+version+'/universal',manifestRelative:'manifest.json',manifestSha256:manifest.sha256,sourceRelative:null,sourceSha256:sha('baseline'),files:inventory,notices,redistribution:'bundle'};
 const output=fs.mkdtempSync(path.join(directory,'bundle-')),archive=path.join(output,id+'-'+version+'-universal.tar.gz'),bytes=Buffer.from(json(declaration));
 const packed=await Archive.writeArchive([{name:'runtime-package.json',bytes,size:bytes.length,mode:0o644,sha256:sha(bytes)},...inventory.map(file=>({...file,name:'files/'+file.path,bytes:files[file.path].bytes}))],archive);
 const record={schemaVersion:2,id,version,arch:'universal',launcherArchitectures:declaration.launcherArchitectures,minimumMacOS:'11.0',manifestRelative:'manifest.json',manifestSha256:manifest.sha256,sourceSha256:declaration.sourceSha256,updatePolicy:'manual',asset:{filename:path.basename(archive),sha256:packed.sha256,bytes:packed.bytes}};
 fs.writeFileSync(archive+'.json',json(record));fs.writeFileSync(path.join(output,id+'.json'),json(catalog([record],{project:id,repository})));
 return {archive,record,declaration,bundle:output};
}
async function fixture(t){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'publisher-files-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const input=await bundle(directory,'1.0-MCLv1'),output=await bundle(directory,'1.0');
 const descriptor={schemaVersion:1,kind:'registered-supplied-publisher-input',id,publisherVersion:'1.0',origin:'Supplied publisher application',input:{format:'runtime-package-v2',record:{id,version:input.record.version,arch:'universal'},archive:{...input.record.asset,url:'https://example.com/publisher.tar.gz'},archivePrefix:'files/vendor/'},output:{payloadPrefix:'vendor/'},files:input.declaration.files.filter(file=>file.path.startsWith('vendor/')).map(file=>({...file})),signature:{kind:'ad-hoc',developerId:null,teamIdentifier:null,publisherAuthenticated:false}};
 const file='producer/publisher-input.json';fs.mkdirSync(path.join(directory,'producer'));fs.writeFileSync(path.join(directory,file),json(descriptor));
 const project={id,name:'Supplied application',delivery:'downloadable',producer:{kind:'prebuilt',version:'1.0',architectures:['arm64','x64'],publisherFiles:{file,sha256:sha(fs.readFileSync(path.join(directory,file)))}},upstreams:[],packageProfiles:[{version:'1.0',label:'Publisher 1.0'},{version:'1.0-MCLv1',label:'Historical wrapper'}]};
 fs.writeFileSync(path.join(directory,'projects.json'),json({schemaVersion:1,repository,updatePolicy:'manual',projects:[project]}));
 const record=options=>recordPublisherFiles({project:id,inputArchive:input.archive,...output,directory,...options});
 return {directory,descriptor,project,input,output,record};
}

test('unmodified publisher files have explicit equality authority without a GitHub signer',async t=>{
 const f=await fixture(t);assert.equal(verifyPublisherRecord({record:f.output.record,repository,directory:f.directory}),undefined);
 const result=await f.record();assert.equal(result.files,3);assert.equal(result.publisherAuthenticated,false);assert.equal(result.sourceRevision,undefined);
 assert.equal((await verifyPublisherArchive({...f.output,directory:f.directory})).kind,'supplied-publisher');
 const catalogRecord=catalog([f.output.record],{project:id,repository}).packages[0];assert.equal(verifyPublisherRecord({record:catalogRecord,repository,directory:f.directory}).kind,'supplied-publisher');
 assert.equal((await requirePublicationAuthority({...f.output,repository,directory:f.directory})).kind,'supplied-publisher');
 await f.record({...f.input});assert.equal(verifyPublisherRecord({record:f.input.record,repository,directory:f.directory}).version,'1.0-MCLv1');
 assert.equal(sha(fs.readFileSync(f.input.archive)),f.descriptor.input.archive.sha256);
});

test('a prebuilt flag or forged equality flag cannot authorize compiled or changed content',async t=>{
 const f=await fixture(t),registry=path.join(f.directory,'projects.json'),value=JSON.parse(fs.readFileSync(registry));delete value.projects[0].producer.publisherFiles;fs.writeFileSync(registry,json(value));
 assert.equal(readPublisherInput({project:id,directory:f.directory}),undefined);
 await assert.rejects(requirePublicationAuthority({...f.output,repository,directory:f.directory}),/GitHub build record/);
 fs.writeFileSync(registry,json({schemaVersion:1,repository,updatePolicy:'manual',projects:[f.project]}));await f.record();
 const file=path.join(f.directory,'publisher-records',f.output.record.asset.sha256+'.json'),receipt=JSON.parse(fs.readFileSync(file));receipt.verified=true;fs.writeFileSync(file,json(receipt));
 assert.throws(()=>verifyPublisherRecord({record:f.output.record,repository,directory:f.directory}),/equality record/);
});

test('publisher comparison rejects changed bytes, modes, missing files and extra helpers before writing receipts',async t=>{
 const f=await fixture(t);let index=0;
 for(const change of [files=>{files['vendor/Player'].bytes=Buffer.from('changed executable');},files=>{files['vendor/data'].mode=0o755;},files=>{delete files['vendor/data'];},files=>{files['vendor/extra']={bytes:Buffer.from('helper'),mode:0o755};},files=>{files['adapter.dylib']={bytes:Buffer.from('compiled helper'),mode:0o755};},(files,notices)=>{files['helper.js']={bytes:Buffer.from('console.log(1)'),mode:0o644};notices.push({name:'Fake notice',license:'MIT',path:'helper.js'});}]){
  const changed=await bundle(f.directory,'1.0',change),outputDir=path.join(f.directory,'refused-'+index++);
  await assert.rejects(f.record({...changed,outputDir}),/supplied bytes|omits supplied|extra supplied|metadata|production/);assert.equal(fs.existsSync(outputDir),false);
 }
});

test('metadata must be bounded non-executable JSON or a declared textual notice',async t=>{
 const f=await fixture(t);
 for(const change of [files=>{files['manifest.json'].bytes=Buffer.from('invalid json');},files=>{files['manifest.json'].mode=0o755;},(files,notices)=>{files['NOTICE']={bytes:Buffer.from([0,1,2]),mode:0o644};notices.push({name:'Notice',license:'MIT',path:'NOTICE'});}]){
  const changed=await bundle(f.directory,'1.0',change);await assert.rejects(f.record({...changed}),/metadata|UTF-8|binary|JSON/);
 }
 const permitted=await bundle(f.directory,'1.0',(files,notices)=>{files['NOTICE']={bytes:Buffer.from('Publisher license notice\n'),mode:0o644};notices.push({name:'Notice',license:'MIT',path:'NOTICE'});});
 assert.equal((await f.record({...permitted})).kind,'supplied-publisher');
});

test('actual pinned input and output archives remain mandatory for publication equality',async t=>{
 const f=await fixture(t),badInput=path.join(f.directory,'bad-input.tar.gz'),bytes=fs.readFileSync(f.input.archive);bytes[bytes.length-1]^=1;fs.writeFileSync(badInput,bytes);
 await assert.rejects(f.record({inputArchive:badInput}),/checksum/);assert.equal(fs.existsSync(path.join(f.directory,'publisher-records')),false);
 await f.record();const badOutput=path.join(f.directory,'bad-output.tar.gz'),altered=fs.readFileSync(f.output.archive);altered[altered.length-1]^=1;fs.writeFileSync(badOutput,altered);
 await assert.rejects(verifyPublisherArchive({...f.output,archive:badOutput,directory:f.directory}),/checksum/);
});

function commitInputs(f){
 const git=args=>execFileSync('git',['-C',f.directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-q']);git(['add','projects.json','producer/publisher-input.json']);git(['-c','user.name=Build','-c','user.email=build@example.invalid','commit','-qm','Supplied input']);return git(['rev-parse','HEAD']);
}
test('publisher source tags pin the exact public descriptor and producer mapping',async t=>{
 const f=await fixture(t);await f.record();const revision=commitInputs(f);
 assert.equal(assertPublisherSource({record:f.output.record,directory:f.directory,sourceRevision:revision}),revision);
 await assert.rejects(requirePublicationAuthority({...f.output,repository,directory:f.directory,sourceRevision:'f'.repeat(40)}),/source commit/);
 const descriptor=path.join(f.directory,f.project.producer.publisherFiles.file);fs.appendFileSync(descriptor,'\n');
 assert.throws(()=>assertPublisherSource({record:f.output.record,directory:f.directory,sourceRevision:revision}),/checksum changed/);
});

test('publisher stage, publish and apply check real archives and normal source tags without a signer claim',async t=>{
 const f=await fixture(t);await f.record();const revision=commitInputs(f),calls=[];let staged=false,draft=true;
 const ref=()=>JSON.stringify({object:{type:'commit',sha:revision}}),remote=()=>({tag_name:id+'/v1.0/universal',draft,assets:[{id:1,name:f.output.record.asset.filename,size:f.output.record.asset.bytes,state:'uploaded',digest:'sha256:'+f.output.record.asset.sha256}]});
 const runGh=async args=>{calls.push(args);if(args[0]==='api'){if(args[1]?.includes('/git/ref/')){if(!staged)throw Object.assign(Error('missing'),{status:404});return ref();}if(args.includes('--paginate'))return JSON.stringify([staged?[remote()]:[]]);assert.ok(args.includes('POST'));staged=true;return ref();}if(args[1]==='create')return '';assert.equal(args[1],'edit');draft=false;return '';};
 await assert.rejects(stageRelease({bundle:f.output.bundle,target:'f'.repeat(40),directory:f.directory,runGh}),/source commit/);assert.equal(calls.length,0);
 await stageRelease({bundle:f.output.bundle,target:revision,directory:f.directory,runGh});await publishRelease({bundle:f.output.bundle,directory:f.directory,runGh});await applyRelease({bundle:f.output.bundle,directory:f.directory,runGh});
 const active=JSON.parse(fs.readFileSync(path.join(f.directory,'catalogs',id+'.json')));assert.equal(active.packages[0].asset.sha256,f.output.record.asset.sha256);assert.equal(active.packages[0].build,undefined);assert.equal(draft,false);
});

test('an existing publisher version tag without its descriptor cannot bypass the packaging source pin',async t=>{
 const f=await fixture(t);await f.record();
 const git=args=>execFileSync('git',['-C',f.directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-q']);git(['add','projects.json']);git(['-c','user.name=Build','-c','user.email=build@example.invalid','commit','-qm','Historical package']);
 const target=git(['rev-parse','HEAD']);git(['tag',id+'/v1.0/universal',target]);let calls=0;
 assert.equal((await verifyPublisherArchive({...f.output,directory:f.directory})).files,3);
 await assert.rejects(stageRelease({bundle:f.output.bundle,target,directory:f.directory,runGh:()=>{calls++;}}),/does not contain the declared publisher inputs/);
 assert.equal(calls,0);assert.equal(git(['rev-parse',id+'/v1.0/universal']),target);
});

test('read-only publisher verification accepts package records or validated equality receipts without writes',async t=>{
 const f=await fixture(t),result=await f.record(),receiptBytes=fs.readFileSync(result.file),names=fs.readdirSync(f.directory).sort();
 for(const recordFile of [f.output.archive+'.json',result.file]){const verified=await publisherMain(['verify','--project',id,'--archive',f.output.archive,'--record',recordFile,'--input-archive',f.input.archive],f.directory);assert.equal(verified.files,3);assert.equal(verified.publisherAuthenticated,false);}
 assert.deepEqual(fs.readdirSync(f.directory).sort(),names);assert.deepEqual(fs.readFileSync(result.file),receiptBytes);
 await assert.rejects(publisherMain(['verify','--project',id,'--archive',f.output.archive,'--record',result.file,'--output-dir',path.join(f.directory,'forbidden')],f.directory),/without an output directory/);assert.equal(fs.existsSync(path.join(f.directory,'forbidden')),false);
 const tampered=JSON.parse(receiptBytes);tampered.metadata[0].base64=Buffer.from('{}').toString('base64');const bad=path.join(f.directory,'bad-receipt.json');fs.writeFileSync(bad,json(tampered));await assert.rejects(publisherMain(['verify','--project',id,'--archive',f.output.archive,'--record',bad],f.directory),/metadata differs/);
});
