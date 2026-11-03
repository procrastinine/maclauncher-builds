import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {formatDuration,renderTimings,main} from '../tools/job-timings.mjs';

const job=(name,created,started,completed,conclusion='success',labels=['macos-15'])=>({name,labels,created_at:created,started_at:started,completed_at:completed,conclusion,status:completed?'completed':'queued'});
const jobs=[
 job('publish','2026-01-01T00:10:00Z','2026-01-01T00:10:30Z','2026-01-01T00:12:00Z'),
 job('build (a)','2026-01-01T00:00:00Z','2026-01-01T00:00:20Z','2026-01-01T00:10:00Z'),
 job('build (b)','2026-01-01T00:00:00Z','2026-01-01T00:02:00Z','2026-01-01T01:03:05Z','failure',['self-hosted','arm64']),
 job('skipped','2026-01-01T00:10:00Z',null,'2026-01-01T00:10:00Z','skipped',[]),
 job('waiting','2026-01-01T00:11:00Z',null,null,null),
];
test('durations format as h m s',()=>{
 assert.equal(formatDuration(0),'0s');assert.equal(formatDuration(65000),'1m 5s');assert.equal(formatDuration(3605000),'1h 0m 5s');assert.equal(formatDuration(null),'—');
});
test('rows are sorted by start time with unstarted jobs last',()=>{
 const rows=renderTimings({jobs}).split('\n').filter(line=>line.startsWith('| ')&&!line.startsWith('| Job')&&!line.startsWith('| ---'));
 assert.deepEqual(rows.map(row=>row.split(' | ')[0].slice(2)),['build (a)','build (b)','publish','skipped','waiting']);
 assert.equal(rows[0],'| build (a) | macos-15 | 20s | 9m 40s | success |');
 assert.equal(rows[1],'| build (b) | self-hosted, arm64 | 2m 0s | 1h 1m 5s | failure |');
});
test('skipped and unstarted jobs show dashes',()=>{
 const text=renderTimings(jobs);
 assert.match(text,/\| skipped \| — \| — \| — \| skipped \|/);
 assert.match(text,/\| waiting \| macos-15 \| — \| — \| queued \|/);
});
test('summary lines report wall time, longest queue and longest job',()=>{
 const text=renderTimings(jobs);
 assert.match(text,/- Run wall time: 1h 3m 5s\n/);
 assert.match(text,/- Longest queue wait: 2m 0s \(build \(b\)\)\n/);
 assert.match(text,/- Longest job: 1h 1m 5s \(build \(b\)\)\n/);
});
test('compare adds a delta column matched by job name',()=>{
 const previous=[job('build (a)','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:10:00Z'),job('build (b)','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T01:10:00Z'),job('publish','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:01:30Z')];
 const text=renderTimings(jobs,{jobs:previous});
 assert.match(text,/\| Conclusion \| Delta \|/);
 assert.match(text,/\| build \(a\) \| macos-15 \| 20s \| 9m 40s \| success \| -20s \|/);
 assert.match(text,/\| build \(b\) .* \| -8m 55s \|/);
 assert.match(text,/\| publish .* \| 0s \|/);
 assert.match(text,/\| skipped .* \| new \|\n/);
 assert.match(text,/\| waiting .* \| new \|\n/);
});
test('GITHUB_STEP_SUMMARY and stdout contain the same report',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'timings-')),input=path.join(dir,'jobs.json'),summary=path.join(dir,'summary.md');
 fs.writeFileSync(input,JSON.stringify({jobs}));fs.writeFileSync(summary,'existing\n');
 let out='';const stdout={write:text=>{out+=text;}};
 await main(['--jobs',input],{env:{GITHUB_STEP_SUMMARY:summary},stdout});
 assert.equal(fs.readFileSync(summary,'utf8'),'existing\n'+out);assert.match(out,/^## Job timings/);
 await main(['--jobs',input],{env:{},stdout});assert.match(out,/## Job timings/);
});
test('fetch pages are combined and errors only warn',async()=>{
 const pages=[{total_count:3,jobs:jobs.slice(0,2)},{total_count:3,jobs:jobs.slice(2,3)}],urls=[];
 const fetcher=async(url,options)=>{urls.push([url,options.headers.authorization]);return {ok:true,json:async()=>pages[urls.length-1]};};
 let out='';const stdout={write:text=>{out+=text;}};
 await main(['--run','7','--repo','o/r'],{env:{GITHUB_TOKEN:'t'},fetcher,stdout});
 assert.equal(urls.length,2);assert.match(urls[1][0],/o\/r\/actions\/runs\/7\/jobs\?per_page=100&page=2/);assert.equal(urls[0][1],'Bearer t');assert.match(out,/build \(a\)/);
 out='';await main(['--run','7','--repo','o/r'],{env:{},fetcher:async()=>({ok:false,status:403}),stdout});
 assert.match(out,/^Job timings unavailable: GitHub returned 403/);assert.equal(out.split('\n').length,2);
 out='';await main(['--jobs','/nonexistent.json'],{env:{},stdout});assert.match(out,/^Job timings unavailable/);
});
