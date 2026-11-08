import './producer-environment.mjs';
import {buildNativeStack,nativeStackInput,stackModule,nativeStackArchives} from './native-stack.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {recipeMain} from './build-source.mjs';
export async function buildNativeSdl2Mixer(options){
 const fonts=nativeStackInput(preparedBuildInput('native-sdl2-fonts'),{arch:options.arch,work:options.work+'-fonts'}),audio=nativeStackInput(preparedBuildInput('native-sndfile'),{arch:options.arch,work:options.work+'-audio'});
 // The existing mixer validates original archive identities even when its
 // complete font and audio compiler prefixes are supplied instead of rebuilt.
 const archives={...await nativeStackArchives(stackModule('fonts').PIN,{work:options.work}),...await nativeStackArchives(stackModule('audio').PIN,{work:options.work})};
 return buildNativeStack({...options,kind:'mixer',dependencyStacks:{fonts,audio},archives});
}
recipeMain(import.meta,buildNativeSdl2Mixer);
