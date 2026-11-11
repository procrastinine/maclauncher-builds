import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The attest job downloads every runtime-* artifact with a pattern. The pinned
// actions/download-artifact extracts into one folder per artifact only when the pattern
// matches several artifacts; a run that built a single package version for a single
// architecture gets that artifact's files directly in the download path. The attestation
// subject must cover every built file in both layouts.
const workflow=fs.readFileSync(new URL('../.github/workflows/runtime-build.yml',import.meta.url),'utf8');
const job=workflow.slice(workflow.indexOf('\n  attest:'),workflow.indexOf('\n  publish:'));
const temp='/runner-temp';
const download=JSON.parse(job.match(/name: Read the built packages[\s\S]*?inputs: '([^']+)'/)[1].replaceAll('${{ runner.temp }}',temp)).path;
const subject=JSON.parse(job.match(/uses: \.\/\.github\/actions\/attest[\s\S]*?inputs: '([^']+)'/)[1].replace('${{ github.token }}','token').replaceAll('${{ runner.temp }}',temp))['subject-path'];
const members=['build-definition.json','build-inputs.json'];

function downloaded(root,artifacts){
 for(const artifact of artifacts){
  const into=artifacts.length===1?root:path.join(root,artifact);
  fs.mkdirSync(into,{recursive:true});
  for(const name of [artifact.replace(/^runtime-/,'')+'.tar.gz',artifact.replace(/^runtime-/,'')+'.tar.gz.json',...members])fs.writeFileSync(path.join(into,name),artifact);
 }
 return fs.readdirSync(root,{recursive:true}).map(name=>path.join(root,name)).filter(file=>fs.statSync(file).isFile()).sort();
}

for(const artifacts of [['runtime-fidelityfx-api-1.0.1-MCLv8-x64'],['runtime-reshade-0.3.11-universal','runtime-reshade-0.3.11-x64']]){
 test(`attestation covers every file when ${artifacts.length} artifact${artifacts.length===1?'':'s'} downloaded`,()=>{
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'attest-subjects-'));
  try{
   const root=path.join(scratch,path.relative(temp,download));
   const files=downloaded(root,artifacts);
   const pattern=path.join(scratch,path.relative(temp,subject));
   const subjects=fs.globSync(pattern).filter(file=>fs.statSync(file).isFile()).sort();
   assert.deepEqual(subjects,files);
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
 });
}
