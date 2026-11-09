import './producer-environment.mjs';
import {compileNativeStack,assembleNativeStack} from './native-stack.mjs';
import {recipeMain} from './build-source.mjs';
export const compile=options=>compileNativeStack({...options,kind:'movie'});
export const assemble=options=>assembleNativeStack({...options,kind:'movie'});
recipeMain(import.meta,{compile,assemble});
