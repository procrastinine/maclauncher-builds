import {sourceRevision} from '../../../lib/pins.mjs';
import {appRequire} from '../../../tools/app-source.mjs';
import path from 'node:path';
const {SCENE_SHADER_INPUTS}=appRequire('src/modules/shared/effects/operation-contracts.mjs');
import {SOURCE,sceneDependencies} from '../src/modules/shared/reshade/libplacebo/scene-overlay.mjs';
export function stageLibplaceboScene({metadata,recipeRoot,upstream}){
  if(metadata.sceneInputsAPI===undefined||metadata.sceneInputsAPI===0)return null;
  const roles=SCENE_SHADER_INPUTS.filter(name=>!['viewMatrix','projectionMatrix'].includes(name));
  const {vulkanHeaders,fastFloat}=sceneDependencies(upstream);
  if(metadata.sceneInputsAPI!==1||JSON.stringify(metadata.sceneInputRoles)!==JSON.stringify(roles))throw Error('The libplacebo named input roles differ from the common image contract.');
  const recipes=['libplacebo-build.mjs','compiler-isolation.mjs','libplacebo/scene-source.mjs','libplacebo/scene-overlay.mjs','libplacebo/scene-profile.json','libplacebo/dependencies-build.mjs','libplacebo/dependencies.json','libplacebo/dependencies-CMakeLists.txt'];
  const owned=new Map(recipes.map(name=>['maclauncher/'+name,path.join(recipeRoot,name)]));
  const declarations=new Map(),pins=new Set();
  for(const architecture of metadata.architectures){
    const receiptName='scene-source'+(architecture==='arm64'?'':'.x86_64')+'.json';
    if(!metadata.files.some(row=>row.path===receiptName))throw Error('The libplacebo source interface declaration is missing: '+architecture);
    for(const [pin,relative]of [[SOURCE,'libplacebo-scene'],[vulkanHeaders,'libplacebo-vulkan-headers'],[fastFloat,'libplacebo-fast-float']]){
      declarations.set(pin.origin,pin);pins.add(`${sourceRevision(pin)} third_party/${relative}`);
    }
  }
  return {roles:[...roles],owned,pins:[...pins].map(line=>' '+line),sources:[...declarations.values()]};
}
