import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalReport} from '../lib/canonical-report.mjs';
import {releaseTag} from '../lib/project-identity.mjs';
const read=value=>JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8'));
/** Record generated input facts beside the sealed payload, before the release bundle is attested. */
export function sealBuildInputReport({project,output,environment=process.env}){
 if(!environment.BUILD_REPORTS)return;
 const reports=read(environment.BUILD_REPORTS),report=reports[project];if(!report?.definition)throw Error('The build has no resolved input report: '+project);
 const definition=canonicalReport(report.definition),digest=crypto.createHash('sha256').update(definition).digest('hex');
 if(digest!==report.definitionDigest)throw Error('The build definition differs from its plan.');
 const prepared=environment.MACLAUNCHER_BUILD_INPUTS?read(environment.MACLAUNCHER_BUILD_INPUTS):{};
 const inputs=Object.values(prepared).map(({record,evidence})=>({id:record.id,version:record.version,arch:record.arch,sha256:record.asset.sha256,
  release:releaseTag(record),url:record.asset.url,sourceRevision:record.build?.sourceRevision||evidence?.sourceRevision,runId:record.build?.runId||evidence?.runId}));
 for(const [name,content]of [['build-definition.json',definition],['build-inputs.json',canonicalReport({schemaVersion:1,definitionDigest:digest,inputs})]]){
  fs.writeFileSync(path.join(output,name),content,{flag:'wx',mode:0o644});
 }
}
