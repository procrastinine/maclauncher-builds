const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {retryNetworkAsync}=require('./download.mjs');
async function runAction({environment=process.env,wait}={}){
 let ref=environment.INPUT_ACTION;
 if(ref&&!ref.includes('@')){
  const declaration=fs.readFileSync(path.join(__dirname,'../.github/actions',ref.split('/')[1],'action.yml'),'utf8');
  ref=declaration.match(/uses: (actions\/[\w.-]+@[a-f0-9]{40})/)[1];
 }
 const inputs=JSON.parse(environment.INPUT_INPUTS||'{}');
 if(!/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/.test(ref||''))throw Error('A network action requires an exact pinned action.');
 const [name,revision]=ref.split('@'),directory=path.join(environment.RUNNER_WORKSPACE,'..','_actions',name,revision);
 const metadata=fs.readFileSync(path.join(directory,'action.yml'),'utf8'),entry=/^\s+main:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(metadata)?.[1]?.trim();
 if(!/using:\s*['"]?node(?:20|24)['"]?/.test(metadata)||!entry||path.isAbsolute(entry)||entry.split(/[\\/]/).includes('..'))throw Error('The network action must use a contained JavaScript entrypoint.');
 const env={...environment};delete env.INPUT_ACTION;delete env.INPUT_INPUTS;
 const inputSection=metadata.split(/^inputs:\s*$/m)[1]?.split(/^\S/m)[0]||'';
 for(const block of inputSection.split(/(?=^  [\w-]+:\s*$)/m)){
  const key=/^  ([\w-]+):/m.exec(block)?.[1],value=/^    default:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
  if(key&&value!==undefined&&!Object.hasOwn(inputs,key))inputs[key]=({'${{ github.token }}':environment.GH_TOKEN||environment.GITHUB_TOKEN||'','${{ github.repository }}':environment.GITHUB_REPOSITORY||'','${{ github.run_id }}':environment.GITHUB_RUN_ID||''})[value]??value;
 }
 for(const [key,value]of Object.entries(inputs))env['INPUT_'+key.replace(/ /g,'_').toUpperCase()]=String(value);
 await retryNetworkAsync(()=>new Promise((resolve,reject)=>{
  let output='';const child=spawn(process.execPath,[path.join(directory,entry)],{env,stdio:['ignore','pipe','pipe']});
  for(const [stream,target]of [[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',chunk=>{target.write(chunk);output=(output+chunk).slice(-131072);});
  child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Object.assign(Error(output||'Action exited '+code),{status:code})));
 }),{wait});
}
module.exports={runAction};
if(require.main===module)runAction().catch(error=>{console.error(error.message);process.exitCode=1;});
