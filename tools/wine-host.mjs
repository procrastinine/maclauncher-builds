// SPDX-License-Identifier: MIT
/** Explicit target architecture for Wine Unix producers; paths describe outputs,
 * while the compiler and binary headers establish their architecture. */
export function wineHost(arch='x64') {
  if (arch==='x64'||arch==='x86_64') return {arch:'x64',macho:'x86_64',unix:'x86_64-unix'};
  if (arch==='arm64') return {arch:'arm64',macho:'arm64',unix:'aarch64-unix'};
  throw Error('Wine host architecture must be x64 or arm64.');
}
