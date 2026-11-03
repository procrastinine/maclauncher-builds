import {reportDigest} from './recipe-build-report.mjs';

/** Resolve recipe-reported inputs before their consumers. The callbacks provide
 * acquisition, verified publication lookup and naming; this planner performs no
 * filesystem, network, registration or build operations.
 *
 * describe(id): {definition, inputs: [id | {id}]}
 * published(id): {definition, version, digest} | null
 * nextName(id, {definition, published}): version
 */
export async function resolveBuildInputs({selection,describe,published,nextName}){
 const roots=new Map();for(const entry of selection){const row=typeof entry==='string'?{id:entry}:entry,id=row.id||row.project;if(!roots.has(id))roots.set(id,[]);roots.get(id).push(row);}
 const orderedSelection=[],reuseBindings=[],resolved=new Map(),visiting=new Set(),reports={},dependencyGraph={},levels=[];
 async function visit(id){
  if(resolved.has(id))return resolved.get(id);
  if(visiting.has(id))throw Error('Build input cycle: '+[...visiting,id].join(' -> '));
  visiting.add(id);
  const report=await describe(id);if(!report||report.definition===undefined)throw Error('Recipe report has no normalized definition: '+id);
  const inputIds=[...new Set((report.inputs||[]).map(input=>typeof input==='string'?input:input.id||input.project))].sort();
  const children=[];for(const input of inputIds)children.push(await visit(input));
  const definition={recipe:report.definition,inputs:inputIds.map(input=>({id:input,definitionDigest:reports[input].definitionDigest}))},definitionDigest=reportDigest(definition);
  reports[id]={definition,definitionDigest,inputs:inputIds.map(id=>({id}))};dependencyGraph[id]=inputIds;
  const level=children.length?Math.max(...children.map(child=>child.level))+1:0;(levels[level]??=[]).push(id);
  const previous=await published(id);
  // Only requested lines build. Any other input with a public release is used as published, pinned by its digest for each architecture.
  const reuse=!roots.has(id)&&Boolean(previous);
  let result;
  if(reuse){const binding={id,version:previous.version,digests:previous.digests};reuseBindings.push(binding);result={...binding,reused:true};}
  else{
   const requests=roots.get(id)||[{id}],outputs=[];
   for(const request of requests){const version=request.version??await nextName(id,{definition,published:previous||null});const output={id,version};orderedSelection.push(output);outputs.push(output);}
   result={...outputs[0],reused:false};
  }
  result.level=level;visiting.delete(id);resolved.set(id,result);return result;
 }
 for(const id of roots.keys())await visit(id);
 return {orderedSelection,reuseBindings,reports,dependencyGraph,levels};
}
