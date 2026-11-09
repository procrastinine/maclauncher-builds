import {moduleFile} from '../../../tools/app-source.mjs';
import {sourceRevision} from "../../../lib/pins.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const factories=Object.freeze({"histogram-exposure":"makeHistogramExposureNode","local-laplacian":"makeLocalLaplacianNode",cmaa2:"makeCmaa2Node",xegtao:"makeXegtaoNode",cacao:"makeCacaoNode","depth-fog":"makeDepthFogNode","depth-outlines":"makeDepthOutlinesNode","estimated-depth-fog":"makeEstimatedDepthFogNode","ffx-dof":"makeFfxDofNode","screen-space-reflections":"makeScreenSpaceReflectionsNode","ffx-lens":"makeFfxLensNode","ffx-blur":"makeFfxBlurNode"});
const translated=Object.freeze({cmaa2:"cmaa2",xegtao:"xegtao",cacao:"cacao","ffx-dof":"dof","screen-space-reflections":"ssr","ffx-lens":"lens","ffx-blur":"blur"}),sharedInputs=new Set(["../native/scene-projection.hlsl"]);
const filename=value=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

// Feature declarations come from the same production source
// as the compiled dispatcher. No shader files or compiler processes are added.
const recipes="src/modules/shared/reshade",recipeFile=relative=>moduleFile(path.posix.join(recipes,relative));
export function stageNativeImageFilters({ownedSource,symbols}){
  const manifest=path.join(ownedSource,"src/native-filter-sources.json"),dispatcher=symbols.includes("makeNativeImageShaderNode");
  if(!fs.existsSync(manifest)){if(dispatcher)throw Error("The native image filter source declaration is missing.");return null;}
  const metadata=JSON.parse(fs.readFileSync(manifest,"utf8"));
  if(metadata.schema!==1||!Array.isArray(metadata.providers))throw Error("The native image filter source declaration is invalid.");
  const methods=[],owned=new Map(),pins=[],seen=new Set();
  for(const provider of metadata.providers){
    if(!Object.hasOwn(factories,provider.method)||seen.has(provider.method)||!filename(provider.sourceManifest))throw Error("A native image filter source contract is invalid.");
    seen.add(provider.method);
    if(!dispatcher||!symbols.includes(factories[provider.method]))continue;
    const source=JSON.parse(fs.readFileSync(path.join(ownedSource,"src",provider.sourceManifest),"utf8"));
    const ownedImplementation=source.implementation==="owned";
    const revision=ownedImplementation?undefined:sourceRevision(source.sourceFile?JSON.parse(fs.readFileSync(recipeFile(source.sourceFile),"utf8")):source);
    if(source.schema!==1||!/^https:\/\//.test(source.repository||"")||!ownedImplementation&&!/^[a-f0-9]{40}$/.test(revision||""))throw Error("A native image filter source pin is missing.");
    if(ownedImplementation){
      if(provider.method!=="histogram-exposure"||source.repository!=="https://github.com/procrastinine/maclauncher"||!Array.isArray(source.files)||!source.files.length)throw Error("The owned image implementation declaration is invalid.");
      for(const name of source.files){if(!filename(name))throw Error("The owned image source filename is invalid.");owned.set(`maclauncher/native/${name}`,path.join(ownedSource,"src",name));}
    }
    if(Object.hasOwn(translated,provider.method)){
      const recipeName=translated[provider.method],sharedImageRecipe=["ffx-lens","ffx-blur"].includes(provider.method),
        recipe=recipeFile(sharedImageRecipe?"lens/translate.mjs":recipeName+"/build.mjs");
      const declaration=recipeFile(recipeName+"/source.json"),pin=JSON.parse(fs.readFileSync(declaration,"utf8"));
      if(pin.repository!==source.repository||sourceRevision(pin)!==revision)throw Error("The native image shader translation source pin changed.");
      owned.set(`maclauncher/${recipeName}/build.mjs`,recipeFile(recipeName+"/build.mjs"));owned.set(`maclauncher/${recipeName}/source.json`,declaration);
      if(sharedImageRecipe){
        owned.set("maclauncher/lens/translate.mjs",recipe);
      }
      const resources=Object.entries(source.ownedFiles||{});
      for(const [name]of resources){
        if((!filename(name)&&!sharedInputs.has(name)))throw Error("A native image shader translation resource is invalid.");
        const file=recipeFile(recipeName+"/"+name);
        owned.set(path.posix.normalize(`maclauncher/${recipeName}/${name}`),file);
      }
    }
    for(const file of provider.embeddedResources||[])if(!filename(file)||!fs.statSync(path.join(ownedSource,"src",file)).isFile())throw Error("An embedded image filter resource is missing.");
    methods.push(provider.method);if(!ownedImplementation)pins.push(` ${revision} third_party/native-filter/${provider.method}`);
  }
  return methods.length?{methods,owned,pins}:null;
}
