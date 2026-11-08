import path from 'node:path';
import {appSourceRoot} from '../../tools/app-source.mjs';
/** Shared native tools are read from their exact app source pin. */
export function refreshNativeTools(sourceRoot){const source=appSourceRoot();if(path.resolve(sourceRoot)!==source.directory)throw Error('Use the pinned app source directory.');return source;}
