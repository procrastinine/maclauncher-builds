import fs from 'node:fs';
import path from 'node:path';
import Contract from './package-contract.cjs';
import {readProjects,resolveProject} from './projects.mjs';
const root=path.resolve(import.meta.dirname,'..');
function githubRepository(value){
 if(typeof value!=='string')return;
 const match=/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(value);
 return match?.[1];
}
/** Publication metadata follows the verified payload and its producer source pins. */
export function recordMetadata({project,manifest,metadata={},directory=root}){
 const raw=readProjects(directory,{resolvePins:false}).projects.find(row=>row.id===project);
 if(raw?.delivery==='bundled')return {};
 const payload=Contract.compatibilityMetadata(manifest?.capabilities===undefined?{}:{capabilities:manifest.capabilities});
 const defaults=raw?.recordMetadata||{},requested={...defaults,...(payload.capabilities?{capabilities:{...defaults.capabilities,...payload.capabilities}}:{}),...metadata};
 Contract.validatePublicMetadata(requested);
 const capabilities=Contract.compatibilityMetadata(requested);
 if(Object.keys(requested).some(key=>key!=='source'&&!Object.hasOwn(capabilities,key)))throw Error('Unknown package record metadata field.');
 const revision=manifest?.upstreamRevision??manifest?.sourceRevision??manifest?.source?.source?.revision;
 if(revision!==undefined&&!/^[a-f0-9]{40}$/.test(revision))throw Error('The payload source revision is invalid.');
 let source=Contract.sourceMetadata(requested.source);
 if(source&&source.revision!==revision)throw Error('The record source differs from the verified payload.');
 if(!source&&revision&&raw){
  const registration=resolveProject(project,directory),matches=new Map();
  for(const upstream of registration.upstreams)if(upstream.revision===revision&&upstream.provider==='github')matches.set(upstream.repository,{repository:upstream.repository,revision});
  const producer=registration.producer.sourceProject?resolveProject(registration.producer.sourceProject,directory).producer:registration.producer;
  if(producer.kind==='pinned-source'){
   const recipe=JSON.parse(fs.readFileSync(path.join(directory,producer.recipe)));
   if(recipe.revision===revision){const repository=githubRepository(recipe.repository);if(repository)matches.set(repository,{repository,revision});}
  }
  if(matches.size===1)source=Contract.sourceMetadata([...matches.values()][0]);
  else if(matches.size>1)throw Error('The payload source has ambiguous producer origins.');
  else if(!registration.upstreams.some(upstream=>upstream.revision===revision)&&(registration.upstreams.length||producer.kind==='pinned-source'))throw Error('The payload source differs from the selected producer pins.');
 }
 return {...capabilities,...(source?{source}:{})};
}
