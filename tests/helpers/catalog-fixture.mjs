import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assetName,assetUrl,releaseTag} from '../../lib/project-identity.mjs';

export const repository='owner/builds';
export function packageRecord(id,{version='1.0.0',arch='arm64',...fields}={}){
 const identity={id,version,arch},hash=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
 return {schemaVersion:2,...identity,launcherArchitectures:arch==='arm64'?['arm64']:['arm64','x64'],minimumMacOS:'13.0',
  manifestRelative:'manifest.json',manifestSha256:hash,sourceSha256:hash,updatePolicy:'manual',tag:releaseTag(identity),
  asset:{filename:assetName(identity),sha256:hash,bytes:100,url:assetUrl(identity,repository)},...fields};
}
/** Standalone publication history with no dependency on the repository catalogs. */
export function catalogFixture(t,id,records){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-fixture-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'catalogs',id+'.json');fs.mkdirSync(path.dirname(file));
 fs.writeFileSync(file,JSON.stringify({schemaVersion:2,projectId:id,updatePolicy:'manual',packages:records}));
 return {directory,repository,value:JSON.parse(fs.readFileSync(file))};
}
