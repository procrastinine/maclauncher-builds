import {moduleFile} from '../../../tools/app-source.mjs';
import {sourceRevision} from "../../../lib/pins.mjs";
import fs from "node:fs";
import path from "node:path";
const factories=Object.freeze({"histogram-exposure":"makeHistogramExposureNode","local-laplacian":"makeLocalLaplacianNode",cmaa2:"makeCmaa2Node",xegtao:"makeXegtaoNode",cacao:"makeCacaoNode","depth-fog":"makeDepthFogNode","depth-outlines":"makeDepthOutlinesNode","estimated-depth-fog":"makeEstimatedDepthFogNode","ffx-dof":"makeFfxDofNode","screen-space-reflections":"makeScreenSpaceReflectionsNode","ffx-lens":"makeFfxLensNode","ffx-blur":"makeFfxBlurNode"});
const translated=Object.freeze({cmaa2:"cmaa2",xegtao:"xegtao",cacao:"cacao","ffx-dof":"dof","screen-space-reflections":"ssr","ffx-lens":"lens","ffx-blur":"blur"});

// Feature declarations come from the same production source
// as the compiled dispatcher. No shader files or compiler processes are added.
const recipes="src/modules/shared/reshade",recipeFile=relative=>moduleFile(path.posix.join(recipes,relative));
export function stageNativeImageFilters({ownedSource,symbols}){
  const manifest=path.join(ownedSource,"src/native-filter-sources.json"),dispatcher=symbols.includes("makeNativeImageShaderNode");
  if(!fs.existsSync(manifest))return null;
  const metadata=JSON.parse(fs.readFileSync(manifest,"utf8"));
  const methods=[],owned=new Map(),pins=[];
  for(const provider of metadata.providers){
    if(!dispatcher||!symbols.includes(factories[provider.method]))continue;
    const source=JSON.parse(fs.readFileSync(path.join(ownedSource,"src",provider.sourceManifest),"utf8"));
    const ownedImplementation=source.implementation==="owned";
    const revision=ownedImplementation?undefined:sourceRevision(source.sourceFile?JSON.parse(fs.readFileSync(recipeFile(source.sourceFile),"utf8")):source);
    if(ownedImplementation)for(const name of source.files)owned.set(`maclauncher/native/${name}`,path.join(ownedSource,"src",name));
    if(Object.hasOwn(translated,provider.method)){
      const recipeName=translated[provider.method],sharedImageRecipe=["ffx-lens","ffx-blur"].includes(provider.method),
        recipe=recipeFile(sharedImageRecipe?"lens/translate.mjs":recipeName+"/build.mjs");
      const declaration=recipeFile(recipeName+"/source.json");
      owned.set(`maclauncher/${recipeName}/build.mjs`,recipeFile(recipeName+"/build.mjs"));owned.set(`maclauncher/${recipeName}/source.json`,declaration);
      if(sharedImageRecipe){
        owned.set("maclauncher/lens/translate.mjs",recipe);
      }
      const resources=Object.entries(source.ownedFiles||{});
      for(const [name]of resources)owned.set(path.posix.normalize(`maclauncher/${recipeName}/${name}`),recipeFile(recipeName+"/"+name));
    }
    methods.push(provider.method);if(!ownedImplementation)pins.push(` ${revision} third_party/native-filter/${provider.method}`);
  }
  return methods.length?{methods,owned,pins}:null;
}
