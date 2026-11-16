// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// RLVM's SConscript selects the theme PNGs. Its wxInclude --wxnone output uses
// mutable byte arrays named from each lowercase filename without the extension.
export function writeResources(output, inputs) {
 const names = new Set();
 const arrays = inputs.map(input => {
  const name = path.basename(input, path.extname(input)).toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || names.has(name)) throw Error('Invalid or duplicate theme resource: ' + name);
  names.add(name);
  const bytes = fs.readFileSync(input);
  const rows = [];
  for (let offset = 0; offset < bytes.length; offset += 10)
   rows.push(Array.from(bytes.subarray(offset, offset + 10), byte => '0x' + byte.toString(16).padStart(2, '0')).join(', '));
  return 'static unsigned char ' + name + '[] = {\n' + rows.join(',\n') + '\n};\n';
 });
 if (!arrays.length) throw Error('Missing RLVM theme resources');
 fs.writeFileSync(output, '// Theme image data from the pinned RLVM source; notices in COPYING.TXT.\n#ifndef _WXINCLUDE_RESOURCE_HEADER_H_\n#define _WXINCLUDE_RESOURCE_HEADER_H_\n' + arrays.join('\n') + '#endif\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const [output, ...inputs] = process.argv.slice(2);
 if (!output) throw Error('Resource output is required');
 writeResources(output, inputs);
}
