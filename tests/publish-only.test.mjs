import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preparePublishOnly,retainedPublicationPlan} from '../tools/publish-only.mjs';
import {publishLevel} from '../tools/publish-level.mjs';
import {publishPackage} from '../tools/publish-package.mjs';

function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'publish-only-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 fs.writeFileSync(path.join(directory,'projects.json'),JSON.stringify({schemaVersion:1,repository:'owner/builds',updatePolicy:'manual',projects:[{id:'engine',name:'Engine',delivery:'downloadable',producer:{kind:'maclauncher',repository:'https://github.com/owner/builds',entries:['tools/build.mjs']},upstreams:[],packageProfiles:[{version:'1.0.0',label:'Engine'}],build:{version:'1.0.0',command:'tools/build.mjs',architectures:['arm64']}}]}));
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'owner/builds',GITHUB_RUN_ID:'456',GITHUB_SHA:'b'.repeat(40),GITHUB_WORKFLOW:'Build and release',GITHUB_WORKFLOW_REF:'owner/builds/.github/workflows/runtime-build.yml@refs/heads/main'};
 const original={databaseId:123,workflowName:'Build and release',headSha:'a'.repeat(40),headBranch:'main',status:'completed',conclusion:'failure',jobs:[{name:'build (engine 1.0.0 arm64)',status:'completed',conclusion:'success'}]};
 const reports={engine:{inputs:[],definitionDigest:'c'.repeat(64)}};
 return {directory,env,original,reports};
}
test('publish-only consumes the original failed run plan and attested output without a build',async t=>{
 const f=fixture(t),downloads=[],stages=[],authorities=[];
 const runGh=async args=>{
  if(args[0]==='run'&&args[1]==='view'){assert.equal(args[2],'123');return JSON.stringify(f.original);}
  if(args[0]==='run'&&args[1]==='download'){
   assert.equal(args[2],'123');downloads.push(args);
   if(args[6]==='release-plan')fs.writeFileSync(args.at(-1)+'/reports.json',JSON.stringify(f.reports));
   return '';
  }
  if(args[0]==='api')return JSON.stringify({body:'Built by https://github.com/owner/builds/actions/runs/123'});
  assert.fail('No build or unexpected transport: '+args.join(' '));
 };
 const plan=await preparePublishOnly({...f,runId:'123',output:path.join(f.directory,'plan'),runGh});
 assert.equal(plan.publishOnly,true);assert.deepEqual(plan.selection,[{id:'engine',version:'1.0.0'}]);
 const env={...f.env,PUBLICATION_RUN_ID:plan.publicationRun,PUBLICATION_SOURCE_SHA:plan.publicationSource,RELEASE_SELECTION:JSON.stringify(plan.selection),RELEASE_GRAPH:JSON.stringify(plan.graph)};
 const record={id:'engine',version:'1.0.0',arch:'arm64',asset:{filename:'engine.tar.gz',sha256:'d'.repeat(64)},build:{sourceRevision:f.original.headSha,runId:'123'}};
 const result=await publishLevel({directory:f.directory,env,targets:plan.independent.include,output:path.join(f.directory,'publication'),runGh,publish:options=>publishPackage({...options,
  verifyBundle:async()=>({record,declaration:{files:[]}}),recordBuild:async()=>authorities.push('attestation'),requireBuild:options=>{assert.equal(options.sourceRevision,f.original.headSha);authorities.push('source');},
  stageBundle:async options=>stages.push(options.target),publishBundle:async()=>{},append:async()=>({commit:'e'.repeat(40)})})});
 assert.equal(result.published,1);assert.equal(result.failed,0);assert.deepEqual(stages,[f.original.headSha]);assert.deepEqual(authorities,['attestation','source']);assert.equal(downloads.length,2);
 // A bundle made by the recovery run itself cannot masquerade as the original.
 await assert.rejects(publishPackage({directory:f.directory,env:{...env,BUILD_PROJECT:'engine',BUILD_VERSION:'1.0.0',BUILD_ARCH:'arm64'},bundle:f.directory,verifyBundle:async()=>({record:{...record,build:{sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}},declaration:{files:[]}})}),/differs from this build job/);
});
test('retained plans preserve levels and reused bindings; legacy reports recover only original matrix targets',async()=>{
 const saved={selection:[{id:'engine',version:'custom'}],graph:{engine:['input']},reuse:[{id:'input',version:'1.0.0',digest:'f'.repeat(64)}],independent:{include:[]},matrices:[{include:[]},{include:[{project:'engine',version:'custom',arch:'arm64'}]},{include:[]},{include:[]}]};
 assert.deepEqual(await retainedPublicationPlan({plan:saved,reports:{},readCatalog:()=>assert.fail()}),{...saved,reports:{}});
 const run={jobs:[{name:'build (input 1.0.0 universal)'},{name:'build (engine custom arm64)'},{name:'build (engine custom x64)'},{name:'publish1'}]};
 const legacy=await retainedPublicationPlan({run,reports:{input:{inputs:[]},engine:{inputs:[{id:'input'}]}},readCatalog:()=>assert.fail()});
 assert.equal(legacy.matrices[0].include.length,1);assert.equal(legacy.matrices[1].include.length,2);assert.equal(legacy.selection.length,2);assert.equal(legacy.independent.include.length,0);
});
test('workflow publish-only skips all builds and Pages uses the same per-attempt artifact name',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/runtime-build.yml',import.meta.url),'utf8');
 for(const name of ['independent','build0','build1','build2','build3']){
  const body=workflow.slice(workflow.indexOf('  '+name+':')).split(/\n  [A-Za-z][A-Za-z0-9]*:/)[0];
  assert.match(body,/needs\.plan\.outputs\.publishOnly != 'true'/);
 }
 assert.equal([...workflow.matchAll(/PUBLICATION_RUN_ID: \$\{\{ needs.plan.outputs.publicationRun \}\}/g)].length,5);
 assert.equal([...workflow.matchAll(/PUBLICATION_SOURCE_SHA: \$\{\{ needs.plan.outputs.publicationSource \}\}/g)].length,5);
 const pages=fs.readFileSync(new URL('../.github/workflows/pages.yml',import.meta.url),'utf8');
 const uploaded=/name: (github-pages-\$\{\{ github.run_attempt \}\})/.exec(pages)?.[1];
 assert.ok(uploaded);assert.ok(pages.includes('artifact_name: '+uploaded));assert.match(pages,/group: package-index\n  queue: max/);
});
