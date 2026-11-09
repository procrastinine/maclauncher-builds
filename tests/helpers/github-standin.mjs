import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const notFound=()=>Object.assign(Error('Not Found'),{stderr:'gh: Not Found (HTTP 404)'});
/** A stateful stand-in for the GitHub REST interfaces publication uses. */
export function githubStandin({repository,runId,artifacts,failUpload=()=>false}){
 const state={releases:[],tags:new Map(),calls:[],nextId:100};
 const endpointOf=args=>args.find(arg=>arg.startsWith('repos/')||arg.startsWith('https://uploads.'));
 const runGh=async(args,options)=>{
  state.calls.push(args);
  if(args[0]==='attestation'||args[0]==='auth')return '';
  const endpoint=endpointOf(args),method=args.includes('--method')?args[args.indexOf('--method')+1]:'GET',field=name=>args.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1);
  const release=id=>state.releases.find(row=>String(row.id)===String(id));
  let match;
  if(endpoint.endsWith('/actions/runs/'+runId+'/artifacts?per_page=100'))return JSON.stringify([{artifacts:artifacts.map(({id,name})=>({id,name,expired:false}))}]);
  if(endpoint==='repos/'+repository+'/git/matching-refs/tags/')return JSON.stringify([[...state.tags.keys()].map(tag=>({ref:'refs/tags/'+tag}))]);
  if(endpoint==='repos/'+repository+'/pages')return JSON.stringify({build_type:'workflow'});
  if(endpoint==='repos/'+repository+'/environments/github-pages')return JSON.stringify({name:'github-pages'});
  if((match=endpoint.match(/\/git\/ref\/tags\/(.+)$/))){const commit=state.tags.get(match[1]);if(!commit)throw notFound();return JSON.stringify({object:{type:'commit',sha:commit}});}
  assert.ok(!endpoint.endsWith('/git/refs'),'publication never creates refs directly');
  if(endpoint.startsWith('repos/'+repository+'/releases?per_page=100'))return JSON.stringify([state.releases]);
  if((match=endpoint.match(/\/releases\/tags\/(.+)$/))){const found=state.releases.find(row=>row.tag_name===decodeURIComponent(match[1])&&!row.draft);if(!found)throw notFound();return JSON.stringify(found);}
  if(method==='POST'&&endpoint==='repos/'+repository+'/releases'){const created={id:state.nextId++,tag_name:field('tag_name'),target_commitish:field('target_commitish'),draft:true,assets:[]};state.releases.push(created);return JSON.stringify(created);}
  if(method==='POST'&&(match=endpoint.match(/\/releases\/(\d+)\/assets\?name=(.+)$/))){
   const file=args[args.indexOf('--input')+1],bytes=fs.readFileSync(file);if(failUpload(decodeURIComponent(match[2])))throw Object.assign(Error('upload failed'),{stderr:'HTTP 422'});
   const asset={id:state.nextId++,name:decodeURIComponent(match[2]),size:bytes.length,digest:'sha256:'+sha(bytes),state:'uploaded'};release(match[1]).assets.push(asset);return JSON.stringify(asset);
  }
  if((match=endpoint.match(/\/releases\/(\d+)$/))){
   const found=release(match[1]);
   if(method==='DELETE'){state.releases=state.releases.filter(row=>row!==found);return '';}
   if(!found)throw notFound();
   // Publishing a draft creates its tag at the recorded target.
   if(method==='PATCH'&&field('draft')==='false'){found.draft=false;state.tags.set(found.tag_name,found.target_commitish);}
   return JSON.stringify(found);
  }
  if((match=endpoint.match(/\/releases\/assets\/(\d+)$/)))return fs.readFileSync(artifacts.flatMap(row=>row.files).find(file=>sha(fs.readFileSync(file))===state.releases.flatMap(row=>row.assets).find(asset=>String(asset.id)===match[1]).digest.slice(7)));
  assert.fail('unexpected GitHub call: '+args.join(' '));
 };
 return {state,runGh};
}

