import {retryNetworkAsync} from './download.mjs';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const time=value=>{const ms=Date.parse(value||'');return Number.isFinite(ms)?ms:null;};
const span=(from,to)=>{from=time(from);to=time(to);return from===null||to===null||to<from?null:to-from;};
/** Milliseconds as "1h 2m 3s"; zero units are dropped except seconds. */
export function formatDuration(ms){
 if(ms===null||ms===undefined)return '—';
 const total=Math.round(ms/1000),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60;
 return [h&&h+'h',(h||m)&&m+'m',s+'s'].filter(Boolean).join(' ');
}
const delta=(ms,before)=>ms===null||before===null||before===undefined?'—':ms===before?'0s':(ms>before?'+':'-')+formatDuration(Math.abs(ms-before));
const cell=value=>String(value??'').replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
const list=value=>Array.isArray(value)?value:Array.isArray(value?.jobs)?value.jobs:(()=>{throw Error('The jobs input has no jobs array.');})();
const timing=job=>({name:job.name,labels:(job.labels||[]).join(', ')||'—',queued:span(job.created_at,job.started_at),duration:span(job.started_at,job.completed_at),started:time(job.started_at),conclusion:job.conclusion||job.status||'—'});
/** Markdown table and summary lines for one run's jobs, with deltas against a previous run's jobs. */
export function renderTimings(jobs,previous){
 const rows=list(jobs).map(timing).sort((a,b)=>(a.started??Infinity)-(b.started??Infinity)||a.name.localeCompare(b.name));
 const before=previous&&new Map(list(previous).map(job=>[job.name,timing(job).duration]));
 const lines=['## Job timings','','| Job | Runner labels | Queued | Duration | Conclusion |'+(before?' Delta |':''),'| --- | --- | ---: | ---: | --- |'+(before?' ---: |':'')];
 for(const row of rows)lines.push('| '+[cell(row.name),cell(row.labels),formatDuration(row.queued),formatDuration(row.duration),cell(row.conclusion),...before?[before.has(row.name)?delta(row.duration,before.get(row.name)):'new']:[]].join(' | ')+' |');
 const created=list(jobs).map(job=>time(job.created_at)).filter(value=>value!==null),completed=list(jobs).map(job=>time(job.completed_at)).filter(value=>value!==null);
 const queue=rows.filter(row=>row.queued!==null).sort((a,b)=>b.queued-a.queued)[0],longest=rows.filter(row=>row.duration!==null).sort((a,b)=>b.duration-a.duration)[0];
 lines.push('',
  '- Run wall time: '+(created.length&&completed.length?formatDuration(Math.max(...completed)-Math.min(...created)):'—'),
  '- Longest queue wait: '+(queue?formatDuration(queue.queued)+' ('+queue.name+')':'—'),
  '- Longest job: '+(longest?formatDuration(longest.duration)+' ('+longest.name+')':'—'),'');
 return lines.join('\n');
}
async function fetchJobs(run,repo,token,fetcher){
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo||'')||!/^\d+$/.test(String(run||'')))throw Error('A run id and owner/name repository are required.');
 const jobs=[];
 for(let page=1;;page++){
  const body=await retryNetworkAsync(async()=>{const response=await fetcher(`https://api.github.com/repos/${repo}/actions/runs/${run}/jobs?per_page=100&page=${page}`,{headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',...token?{authorization:'Bearer '+token}:{}}});
  if(!response.ok)throw Object.assign(Error(`GitHub returned ${response.status} for run ${run}.`),{statusCode:response.status});
  return response.json();});const batch=list(body);jobs.push(...batch);
  if(!batch.length||jobs.length>=(body.total_count??jobs.length))return jobs;
 }
}
/** Never fails the run: any problem becomes one warning line. */
export async function main(argv=process.argv.slice(2),{env=process.env,fetcher=globalThis.fetch,stdout=process.stdout}={}){
 try{
  const option=name=>{const at=argv.indexOf('--'+name);return at<0?undefined:argv[at+1];};
  const load=async(file,run)=>file?JSON.parse(fs.readFileSync(file,'utf8')):run?fetchJobs(run,option('repo'),env.GITHUB_TOKEN,fetcher):undefined;
  const jobs=await load(option('jobs'),option('run'));if(!jobs)throw Error('Pass --jobs FILE or --run ID with --repo OWNER/NAME.');
  const text=renderTimings(jobs,await load(option('compare'),option('compare-run')));
  if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,text+'\n');stdout.write(text+'\n');
 }catch(error){stdout.write('Job timings unavailable: '+String(error?.message||error).split('\n')[0]+'\n');}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fs.realpathSync(process.argv[1]))await main();
