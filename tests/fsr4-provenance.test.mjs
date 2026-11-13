import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fsr4SourceCommits} from '../producers/package-support/src/modules/shared/reshade/temporal/fsr4/provenance.mjs';

test('the FSR 4 provider takes its source commits from the records fsr4-native-macos carries',t=>{
 const source=fs.mkdtempSync(path.join(os.tmpdir(),'fsr4-provenance-'));t.after(()=>fs.rmSync(source,{recursive:true,force:true}));
 const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(source,file)),{recursive:true});fs.writeFileSync(path.join(source,file),text);};
 const [headers,model,int8]=['1','2','3'].map(digit=>digit.repeat(40));
 write('third_party/fsr4/README.upstream.md',`# Notes\n\nwhere these files were published under the SDK's MIT licence at commit\n**\`${headers}\`** ("SDK 2.0.0").\n`);
 write('third_party/fsr411/import_manifest.json',JSON.stringify({source:{sdk_commit:model}}));
 write('third_party/fsr411/source_manifest.json',JSON.stringify({upstream_url:'https://example.invalid/int8',upstream_commit:int8}));
 assert.deepEqual(fsr4SourceCommits(source),[headers,model,int8]);
 write('third_party/fsr411/source_manifest.json',JSON.stringify({upstream_url:'https://example.invalid/int8',upstream_commit:'main'}));
 assert.throws(()=>fsr4SourceCommits(source),/records no exact commit/);
});
