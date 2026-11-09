import './producer-environment.mjs';
import {compileNativeStack,assembleNativeStack} from './native-stack.mjs';
import {recipeMain} from './build-source.mjs';
export const compile=options=>compileNativeStack({...options,kind:'audio'});
export const assemble=options=>assembleNativeStack({...options,kind:'audio'});
recipeMain(import.meta,{compile,assemble});
