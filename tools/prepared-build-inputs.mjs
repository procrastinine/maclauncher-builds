import fs from 'node:fs';
import path from 'node:path';
import {projectId} from '../lib/project-identity.mjs';
/** Verified inputs materialized by this build run, without network access. */
export function preparedBuildInput(id,env=process.env){
 projectId(id);if(!env.MACLAUNCHER_BUILD_INPUTS)return undefined;
 const value=env.MACLAUNCHER_BUILD_INPUTS,map=JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8')),input=map[id];
 if(!input)return undefined;
 if(input.record?.id!==id||input.declaration?.id!==id||input.record.version!==input.declaration.version||input.record.arch!==input.declaration.arch||!input.evidence||!path.isAbsolute(input.root||'')||!path.isAbsolute(input.archive||'')||!fs.statSync(input.root).isDirectory()||!fs.statSync(input.archive).isFile())throw Error('Invalid prepared build input: '+id);
 return input;
}
