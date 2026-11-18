// SPDX-License-Identifier: GPL-2.0-only
import path from 'node:path';

// Recompiled units and generated thunks use the modified source headers.
// Generated and third-party include directories outside the projection still come from CMake.
export function projectedInclude(directory,build,source,projection,paths){
 const absolute=path.resolve(build,directory),relative=path.relative(source,absolute);
 return paths.some(prefix=>relative===prefix||relative.startsWith(prefix+'/'))?path.join(projection,relative):absolute;
}
