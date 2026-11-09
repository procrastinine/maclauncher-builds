import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=name=>fs.readFileSync(new URL('../.github/'+name,import.meta.url),'utf8');
const job=(text,name)=>text.slice(text.indexOf('\n  '+name+':\n')).split(/\n  (?=[A-Za-z][A-Za-z0-9_-]*:\n)/)[1];

test('P3 regression: Multiple artifacts named "github-pages" were unexpectedly found for this workflow run',()=>{
 // Runs 41545832967, 41545826912, 41545821240: two Pages artifacts in one run.
 const pages=read('workflows/pages.yml'),build=read('workflows/runtime-build.yml'),level=read('workflows/runtime-level.yml');
 assert.match(job(pages,'build'),/outputs:\n      artifact: github-pages-\$\{\{ github\.run_attempt \}\}/);
 assert.ok(pages.includes('"name":"${{ needs.build.outputs.artifact }}"')||pages.includes('"name":"github-pages-${{ github.run_attempt }}"'));
 assert.ok(pages.includes('"artifact_name":"${{ needs.build.outputs.artifact }}"'),'deploy reads the artifact its own build job named');
 assert.equal(build.split('uses: ./.github/workflows/pages.yml').length-1,1,'one index call per run');
 assert.doesNotMatch(level,/pages/,'levels never build Pages artifacts');
});

test('P2 regression: Timeout reached, aborting! A Pages deploy reruns alone after packages published',()=>{
 // Run 41880376642: the Pages deploy timed out after its packages were published.
 const pages=read('workflows/pages.yml'),build=read('workflows/runtime-build.yml');
 assert.match(pages,/\n  workflow_dispatch:\n/,'the index deploys alone');
 assert.match(job(pages,'deploy'),/needs: build/);
 // A rerun of the failed deploy keeps its build job and reuses that job's artifact name, not the new attempt number.
 assert.doesNotMatch(job(pages,'deploy'),/github\.run_attempt/);
 assert.match(job(build,'level'),/needs: \[plan\]/,'publication never waits for the index');
 assert.doesNotMatch(job(build,'level'),/needs: \[[^\]]*index/);
});

test('release recovery retains only the original reports for thirty days',()=>{
 const workflow=read('workflows/runtime-build.yml'),level=read('workflows/runtime-level.yml');
 assert.match(workflow,/releases:[\s\S]*required: true/);
 assert.doesNotMatch(workflow+level,/publish_run|publishOnly|PUBLICATION_RUN_ID|PUBLICATION_SOURCE_SHA/);
 assert.match(workflow,/release-plan\/reports.json.*retention-days.*30/);
 assert.match(job(level,'publish'),/group: build-and-release-publication\n      cancel-in-progress: false\n      queue: max/);
});

test('builds run without publishing from the same workflow',()=>{
 const workflow=read('workflows/runtime-build.yml'),level=read('workflows/runtime-level.yml');
 assert.match(workflow,/      publish:\n        description: [^\n]+\n        required: false\n        default: true\n        type: boolean/);
 assert.match(job(level,'publish'),/if: \$\{\{ always\(\) && !cancelled\(\) && inputs\.publish \}\}/);
 assert.match(job(workflow,'index'),/inputs\.publish/);
 assert.match(job(level,'publish'),/needs: \[build\]/,'a level publishes after all its architectures finished');
});

test('levels run in plan order with no fixed depth',()=>{
 const workflow=read('workflows/runtime-build.yml');
 assert.match(job(workflow,'level'),/max-parallel: 1\n      matrix:\n        level: \$\{\{ fromJSON\(needs\.plan\.outputs\.levels\) \}\}/);
 assert.match(job(workflow,'level'),/uses: \.\/\.github\/workflows\/runtime-level\.yml/);
});

test('built archives are attested with the required write capabilities',()=>{
 const level=read('workflows/runtime-level.yml'),action=read('actions/build-runtime/action.yml');
 assert.match(action,/steps\.attest\.outcome == 'success'/);assert.doesNotMatch(action,/attestRetry/);
 assert.match(action,/uses: \.\/\.github\/actions\/attest[\s\S]*subject-path.*\$\{\{ runner.temp \}\}\/release\/\*/);
 assert.match(read('actions/attest/action.yml'),/uses: actions\/attest@[a-f0-9]{40}/);
 for(const body of [job(level,'build'),job(read('workflows/runtime-build.yml'),'level')]){assert.match(body,/attestations: write/);assert.match(body,/id-token: write/);}
});
