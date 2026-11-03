import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {tidyNotices} from '../tools/seal-build-input-report.mjs';
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
  files:[...names.map(row),{path:'manifest.json',size:manifest.length,mode:0o644,sha256:digest(manifest)}],
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
