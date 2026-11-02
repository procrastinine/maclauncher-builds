import {buildNativeStack} from './native-stack.mjs';
import {recipeMain} from './build-source.mjs';
export const buildNativeSdl2Fonts=options=>buildNativeStack({...options,kind:'fonts'});
recipeMain(import.meta,buildNativeSdl2Fonts);
