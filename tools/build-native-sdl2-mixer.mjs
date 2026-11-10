import './producer-environment.mjs';
import {compileNativeStack,assembleNativeStack,nativeStackInput,stackModule,nativeStackArchives} from './native-stack.mjs';
import {preparedBuildInput} from './prepared-build-inputs.mjs';
import {recipeMain} from './build-source.mjs';
export async function compile(options){
 const fonts=nativeStackInput(preparedBuildInput('native-sdl2-fonts'),{arch:options.arch,work:options.work+'-fonts'}),audio=nativeStackInput(preparedBuildInput('native-sndfile'),{arch:options.arch,work:options.work+'-audio'});
 // The existing mixer validates original archive identities even when its
 // complete font and audio compiler prefixes are supplied instead of rebuilt.
 const archives={...await nativeStackArchives(stackModule('fonts').PIN),...await nativeStackArchives(stackModule('audio').PIN)};
 return compileNativeStack({...options,kind:'mixer',dependencyStacks:{fonts,audio},archives});
}
export const assemble=options=>assembleNativeStack({...options,kind:'mixer'});
recipeMain(import.meta,{compile,assemble});
