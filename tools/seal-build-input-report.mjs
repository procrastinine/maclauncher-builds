import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {canonicalReport} from '../lib/canonical-report.mjs';
import {releaseTag} from '../lib/project-identity.mjs';
const require=createRequire(import.meta.url),B=require('../lib/bundled-native.cjs');
const read=value=>JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8'));
import {tidyNotices} from '../lib/notices.mjs';
export {tidyNotices};
/** Add generated input facts to a new build, before its archive is attested. */
export function sealBuildInputReport({project,output,environment=process.env}){
 if(!environment.BUILD_REPORTS)return;
 const reports=read(environment.BUILD_REPORTS),report=reports[project];if(!report?.definition)throw Error('The build has no resolved input report: '+project);
 const payload=path.join(output,'payload'),file=path.join(output,'declaration.json'),declaration=JSON.parse(fs.readFileSync(file));
 tidyNotices(payload,declaration,{share:!Object.values(reports).some(other=>other.inputs?.some(input=>input.id===project))});
 const definition=canonicalReport(report.definition),digest=crypto.createHash('sha256').update(definition).digest('hex');
 if(digest!==report.definitionDigest)throw Error('The build definition differs from its plan.');
 const prepared=environment.MACLAUNCHER_BUILD_INPUTS?read(environment.MACLAUNCHER_BUILD_INPUTS):{};
 const inputs=Object.values(prepared).map(({record,evidence})=>({id:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256,
  release:releaseTag(record),url:record.asset.url,sourceRevision:record.build?.sourceRevision||evidence?.sourceRevision,runId:record.build?.runId||evidence?.runId}));
 for(const [name,content]of [['build-definition.json',definition],['build-inputs.json',canonicalReport({schemaVersion:1,definitionDigest:digest,inputs})]]){
  const bytes=Buffer.from(content);fs.writeFileSync(path.join(payload,name),bytes,{flag:'wx',mode:0o644});
  declaration.files.push({path:name,size:bytes.length,mode:0o644,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 }
 fs.writeFileSync(file,JSON.stringify(declaration,null,2)+'\n');B.verifyPayload(payload,declaration);
}
