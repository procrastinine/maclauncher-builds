import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {addLicense} from '../lib/licenses.mjs';
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'licenses-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
test('components share identical licence text and retain distinct copyright text',t=>{
 const root=temporary(t),sources=path.join(root,'sources'),payload=path.join(root,'payload');fs.mkdirSync(sources);
 for(const [name,text]of Object.entries({a:'GPL text\n',b:'MIT text\n',c:'GPL\r\n text  ',d:'MIT text with another copyright\n'}))fs.writeFileSync(path.join(sources,name),text);
 for(const [component,file,licence]of [['A','a','GPL-3.0'],['B','b','MIT'],['C','c','GPL-3.0'],['D','d','MIT']])addLicense(payload,component,path.join(sources,file),licence);
 assert.deepEqual(fs.readdirSync(path.join(payload,'licenses')).sort(),['GPL-3.0.txt','MIT-2.txt','MIT.txt','components.txt']);
 assert.equal(fs.readFileSync(path.join(payload,'licenses/components.txt'),'utf8'),'A: GPL-3.0.txt\nB: MIT.txt\nC: GPL-3.0.txt\nD: MIT-2.txt\n');
});
test('a missing licence emits one warning without throwing or changing the package',t=>{
 const root=temporary(t),messages=[];t.mock.method(console,'log',message=>messages.push(message));
 assert.doesNotThrow(()=>addLicense(root,'Missing',path.join(root,'missing')));assert.equal(messages.length,1);assert.match(messages[0],/^::warning::No licence text for Missing:/);assert.equal(fs.existsSync(path.join(root,'licenses')),false);
});
