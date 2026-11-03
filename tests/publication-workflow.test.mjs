import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('regression: Multiple artifacts named "github-pages" were unexpectedly found for this workflow run',()=>{
 const pages=fs.readFileSync(new URL('../.github/workflows/pages.yml',import.meta.url),'utf8'),name='github-pages-${{ github.run_attempt }}';
 assert.ok(pages.includes('name: '+name)&&pages.includes('artifact_name: '+name),'Multiple artifacts named "github-pages" were unexpectedly found for this workflow run');
});
test('release recovery retains only the original reports for thirty days',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/runtime-build.yml',import.meta.url),'utf8');
 assert.match(workflow,/releases:[\s\S]*required: true/);
 assert.doesNotMatch(workflow,/publish_run|publishOnly|PUBLICATION_RUN_ID|PUBLICATION_SOURCE_SHA/);
 assert.match(workflow,/path: \$\{\{ runner.temp \}\}\/release-plan\/reports.json[\s\S]*retention-days: 30/);
 for(const job of workflow.split(/\n  publish(?:Independent|[0-3]):/).slice(1))assert.match(job,/group: build-and-release-publication\n      cancel-in-progress: false\n      queue: max/);
});
