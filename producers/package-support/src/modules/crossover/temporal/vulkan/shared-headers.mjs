// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';

/** Use the ordinary source-tree fallback of include-only layout alternatives.
 * Wine makedep scans every branch, unlike the C preprocessor. */
export function canonicalSharedIncludes(text) {
  return text.replace(/^[ \t]*#if[ \t]+__has_include\([^\n]+\)\r?\n(?:(?!^[ \t]*#if|^[ \t]*#endif)[\s\S])*?^[ \t]*#else[ \t]*\r?\n((?:(?!^[ \t]*#if|^[ \t]*#endif)[\s\S])*?)^[ \t]*#endif[^\n]*(?:\n|$)/gm,
    (block, fallback) => {
      const directives = fallback.split('\n').map(line => line.trim()).filter(Boolean);
      if (!directives.length || directives.some(line => !/^#include\s+"[^"]+"\s*$/.test(line)))
        throw Error('The shared header layout fallback contains non-include code.');
      return fallback;
    });
}

/** Project the complete quoted-include closure from the canonical shared root. */
export function projectSharedHeaders(root, entries) {
  root = fs.realpathSync(root);
  const headers = new Map();
  function visit(relative) {
    relative = path.posix.normalize(relative);
    if (path.posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../'))
      throw Error('Shared header escapes its production root: ' + relative);
    if (headers.has(relative)) return;
    const text = canonicalSharedIncludes(fs.readFileSync(path.join(root, relative), 'utf8'));
    headers.set(relative, Buffer.from(text));
    for (const match of text.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm))
      visit(path.posix.join(path.posix.dirname(relative), match[1]));
  }
  for (const entry of entries) visit(entry);
  return headers;
}
