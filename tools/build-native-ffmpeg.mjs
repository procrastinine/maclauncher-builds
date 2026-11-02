import {buildNativeStack} from './native-stack.mjs';
import {recipeMain} from './build-source.mjs';
export const buildNativeFfmpeg=options=>buildNativeStack({...options,kind:'movie'});
recipeMain(import.meta,buildNativeFfmpeg);
