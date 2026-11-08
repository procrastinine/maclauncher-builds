import './producer-environment.mjs';
import {buildNativeStack} from './native-stack.mjs';
import {recipeMain} from './build-source.mjs';
export const buildNativeSndfile=options=>buildNativeStack({...options,kind:'audio'});
recipeMain(import.meta,buildNativeSndfile);
