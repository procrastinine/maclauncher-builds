import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {releaseVersion} from '../lib/package-version.mjs';

test('release versions are declared once and hash segments must name upstream revisions',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-version-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'producers'));fs.writeFileSync(path.join(root,'producers/source-pins.json'),JSON.stringify({sources:['465c88c3','838e47b','5f358ef1360b'].map(prefix=>prefix.padEnd(40,'a'))}));
 const versions=['0.2.0','3.0.0-465c88c3-MCLv2','0.0.13-838e47b-MCLv1','1.0.0-preview.5f358ef1360b-MCLv1','0.1.0-8da3e063-ba5d556d','0.1.0-'+'d'.repeat(64)];
 fs.writeFileSync(path.join(root,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[{id:'engine',name:'Engine',delivery:'downloadable',producer:{kind:'prebuilt',version:'1.0',architectures:['arm64']},packageProfiles:versions.map(version=>({version,label:version})),upstreams:['465c88c3','838e47b','5f358ef1360b'].map((prefix,index)=>({id:'source-'+index,provider:'github',repository:'owner/source-'+index,url:'https://github.com/owner/source-'+index,pin:{file:'producers/source-pins.json',pointer:'/sources/'+index}}))}]}));
 for(const value of versions.slice(0,4))assert.equal(releaseVersion('engine',value,root),value);
 for(const value of versions.slice(4))assert.throws(()=>releaseVersion('engine',value,root),/declared upstream revision/);
 assert.throws(()=>releaseVersion('engine','0.3.0',root),/not declared/);
 assert.throws(()=>releaseVersion('engine',undefined,root),/Select an explicitly declared/);
});
