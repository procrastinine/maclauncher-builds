import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {tidyNotices,NOTICE_LIMIT} from '../lib/notices.mjs';
import Contract from '../lib/package-contract.cjs';
import B from '../lib/bundled-native.cjs';
import {helperPackage} from '../tools/helper-package.mjs';
import {pack,verify} from '../tools/runtime-package.mjs';
import {execFileSync} from 'node:child_process';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('notice text is stored once and an unusable notice entry never fails sealing',t=>{
 const payload=fs.mkdtempSync(path.join(os.tmpdir(),'notices-'));t.after(()=>fs.rmSync(payload,{recursive:true,force:true}));
 const licence=Array.from({length:12},(_,line)=>'Permission clause '+line+' of the shared licence text, repeated by several components.').join('\n');
 const texts={'files/bin/tool':'binary','files/licenses/a.txt':'Copyright A\n\n'+licence+'\n','files/licenses/b.txt':'Copyright B\n\n'+licence+'\n',
  'files/licenses/c.txt':'Copyright A\n\n'+licence+'\n','files/licenses/d.txt':'Copyright D\n\n'+licence.split('\n').map(line=>' * '+line.replace(/ of /g,'\n *   of ')).join('\n')+'\n',
  'files/licenses/gl.h.txt':'#define GL 1\n/* Copyright Khronos\n SPDX-License-Identifier: MIT */\nint code(void);\n'};
 const row=name=>({path:name,size:Buffer.byteLength(texts[name]),mode:0o644,sha256:digest(texts[name])});
 const names=Object.keys(texts),notices=names.slice(1).map(name=>({name,license:'MIT',path:name.slice(6),sourceUrl:'https://example.com'}));
 for(const name of names){fs.mkdirSync(path.dirname(path.join(payload,name)),{recursive:true});fs.writeFileSync(path.join(payload,name),texts[name]);}
 const manifest=Buffer.from(JSON.stringify({files:names.map(name=>({...row(name),path:name.slice(6)})),notices}));fs.writeFileSync(path.join(payload,'manifest.json'),manifest);
 const declaration={id:'tool',version:'1.0.0',arch:'arm64',manifestRelative:'manifest.json',sourceRelative:'manifest.json',manifestSha256:digest(manifest),sourceSha256:digest(manifest),
  files:[row('files/bin/tool'),{path:'manifest.json',size:manifest.length,mode:0o644,sha256:digest(manifest)}],
  notices:[...names.slice(1).map(name=>({name,license:'MIT',path:name})),{name:'broken',license:'',path:'missing.txt'}]};
 tidyNotices(payload,declaration);
 assert.deepEqual(declaration.notices.map(notice=>notice.path),['files/licenses/a.txt','files/licenses/b.txt','files/licenses/a.txt','files/licenses/d.txt','files/licenses/gl.h.txt']);
 assert.equal(fs.existsSync(path.join(payload,'files/licenses/c.txt')),false);
 assert.match(fs.readFileSync(path.join(payload,'files/licenses/b.txt'),'utf8'),/^Copyright B\n\n\[Same text as lines 3-14 of files\/licenses\/a\.txt\]\n$/);
 assert.equal(fs.readFileSync(path.join(payload,'files/licenses/d.txt'),'utf8'),'Copyright D\n\n[Same text as lines 3-14 of files/licenses/a.txt]\n');
 assert.equal(fs.readFileSync(path.join(payload,'files/licenses/gl.h.txt'),'utf8'),'/* Copyright Khronos\n SPDX-License-Identifier: MIT */\n');
 for(const file of declaration.files){const bytes=fs.readFileSync(path.join(payload,file.path));assert.equal(file.size,bytes.length);assert.equal(file.sha256,digest(bytes));}
 const sealed=JSON.parse(fs.readFileSync(path.join(payload,'manifest.json')));
 assert.equal(declaration.sourceSha256,declaration.manifestSha256);
 assert.deepEqual(sealed.files.map(file=>[file.path,file.sha256]),declaration.files.filter(file=>file.path.startsWith('files/')).map(file=>[file.path.slice(6),file.sha256]));
 assert.equal(sealed.notices[2].path,'licenses/a.txt');
 assert.ok(declaration.files.every(file=>!file.path.includes('licenses/')));
 assert.ok(sealed.files.every(file=>!file.path.includes('licenses/')));
});

test('a package that other recipes consume keeps its notice files as built',t=>{
 const payload=fs.mkdtempSync(path.join(os.tmpdir(),'notices-input-'));t.after(()=>fs.rmSync(payload,{recursive:true,force:true}));
 const text='Shared licence text\n'.repeat(40),names=['a.txt','b.txt'];for(const name of names)fs.writeFileSync(path.join(payload,name),text);
 const manifest=Buffer.from('{}');fs.writeFileSync(path.join(payload,'manifest.json'),manifest);
 const declaration={id:'input',version:'1',arch:'arm64',manifestRelative:'manifest.json',files:[...names.map(name=>({path:name,size:text.length,mode:0o644,sha256:digest(text)})),{path:'manifest.json',size:2,mode:0o644,sha256:digest(manifest)}],
  notices:names.map(name=>({name,license:'MIT',path:name}))};
 tidyNotices(payload,declaration,{share:false});
 assert.deepEqual(declaration.notices.map(notice=>notice.path),names);for(const name of names)assert.equal(fs.readFileSync(path.join(payload,name),'utf8'),text);
});

 test('notice intake drops a sparse 1 TB file and all unusable candidates without reading them',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'notice-intake-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sparse=path.join(root,'huge.txt');fs.writeFileSync(sparse,'');fs.truncateSync(sparse,1024**4);
 fs.writeFileSync(path.join(root,'binary.txt'),Buffer.from('text\0binary'));fs.mkdirSync(path.join(root,'directory'));fs.symlinkSync('binary.txt',path.join(root,'link.txt'));
 const names=['huge.txt','binary.txt','missing.txt','directory','link.txt'];
 const declaration={id:'sample',version:'1',arch:'arm64',manifestRelative:'manifest.json',sourceRelative:'manifest.json',files:names.map(name=>({path:name})),notices:[...names.map(name=>({name,license:'MIT',path:name,sourceUrl:'https://example.com/source'})),null,{name:'bad',license:'',path:'../outside'}]};
 const result=tidyNotices(root,declaration,{share:false});
 assert.equal(result.notices.length,1);assert.equal(result.notices[0].path,'package-notice.txt');assert.ok(result.warnings.length>=7);
 assert.match(fs.readFileSync(path.join(root,'package-notice.txt'),'utf8'),/sample/);assert.equal(declaration.files.some(file=>file.path==='huge.txt'),false);
 assert.equal(NOTICE_LIMIT,1024*1024);
 });

 test('broken notice rows and missing notice files do not reject a contract or installed payload',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'notice-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('{}'),hash=digest(bytes);fs.writeFileSync(path.join(root,'manifest.json'),bytes);
 const declaration={id:'sample',version:'1',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',directoryRelative:'sample/1/arm64',manifestRelative:'manifest.json',manifestSha256:hash,sourceRelative:'manifest.json',sourceSha256:hash,files:[{path:'manifest.json',size:2,mode:0o644,sha256:hash}],notices:[null,{name:'Missing',license:'MIT',path:'missing.txt'},{name:'Invalid',license:'',path:'../outside'}]};
 assert.doesNotThrow(()=>Contract.validateDeclaration(declaration));assert.doesNotThrow(()=>B.verifyPayload(root,declaration));
 });

 test('notice-file failures have no throwing validation outside the notice intake',()=>{
 const root=path.resolve(import.meta.dirname,'..');
 const files=execFileSync('git',['ls-files','lib','tools','producers'],{cwd:root,encoding:'utf8'}).trim().split('\n');
 const failures=[];
 for(const file of files){if(!/\.(?:js|cjs|mjs)$/.test(file)||file==='lib/notices.mjs'||file.startsWith('producers/flash-projector/')||file==='tools/publisher-files.mjs'||file.endsWith('/rosetta.js'))continue;
 const lines=fs.readFileSync(path.join(root,file),'utf8').split('\n');for(const [index,line]of lines.entries())if([...line.matchAll(/throw(?: new)? (?:Error|TypeError)\((['"`])((?:\\.|(?!\1).)*)\1/g)].some(match=>/notice|licen[cs]e/i.test(match[2])))failures.push(file+':'+(index+1));}
 assert.deepEqual(failures,[]);
 });

test('a real helper recipe seals and archives a sparse 1 TB notice without hashing it',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'notice-recipe-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const output=path.join(root,'build'),payload=path.join(output,'payload');fs.mkdirSync(path.join(payload,'notices'),{recursive:true});
 fs.writeFileSync(path.join(payload,'tool.dat'),'real helper payload');const huge=path.join(payload,'notices','huge.txt');fs.writeFileSync(huge,'');fs.truncateSync(huge,1024**4);
 const result=helperPackage({id:'fixture',version:'1.0.0',arch:'arm64',output,minimumMacOS:'13.0',sourceSha256:'a'.repeat(64),record:{schemaVersion:1},notices:[{name:'Fixture',license:'MIT',path:'notices/huge.txt',sourceUrl:'https://example.com/source'}]});
 const declaration=JSON.parse(fs.readFileSync(path.join(output,'declaration.json')));
 assert.equal(fs.existsSync(huge),false);assert.ok(declaration.notices.some(row=>row.path==='package-notice.txt'));assert.ok(declaration.files.every(row=>!row.path.startsWith('notices/')&&row.path!=='package-notice.txt'));
 const archive=path.join(root,'fixture-1.0.0-arm64.tar.gz');const record=await pack({project:'fixture',input:payload,declaration,output:archive});
 const checked=await verify({archive,sha256:record.asset.sha256,project:'fixture',version:'1.0.0',arch:'arm64',includeDeclaration:true});
 assert.ok(checked.declaration.files.every(row=>row.path!=='package-notice.txt'));assert.ok(fs.statSync(archive).size<8192);
});

 test('a rejected dual-role file keeps its payload bytes and inventory facts',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'notice-dual-role-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const name='effects/consumed.fx',bytes=Buffer.alloc(NOTICE_LIMIT+1,65);fs.mkdirSync(path.join(root,'effects'));fs.writeFileSync(path.join(root,name),bytes);
 const fact={path:name,size:bytes.length,mode:0o644,sha256:digest(bytes)};
 const declaration={id:'sample',version:'1',files:[fact],notices:[{name:'Shader source',license:'MIT',path:name}]};
 const result=tidyNotices(root,declaration);assert.ok(result.warnings.some(warning=>warning.includes(name)));
 assert.ok(!declaration.notices.some(row=>row.path===name));assert.deepEqual(fs.readFileSync(path.join(root,name)),bytes);assert.deepEqual(declaration.files,[fact]);
 });
