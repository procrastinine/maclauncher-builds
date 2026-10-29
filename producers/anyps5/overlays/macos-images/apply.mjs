import fs from 'node:fs/promises';
import path from 'node:path';

export async function applyImagesOverlay(root) {
  const relative = 'core/libs/prx/libc/src/ApplicationProcessParameters.cpp';
  const file = path.join(root, relative);
  const source = await fs.readFile(file, 'utf8');
  const boundary = '#ifdef __linux__\n    static const auto guest = [] {';
  if (source.indexOf(boundary) < 0 || source.indexOf(boundary) !== source.lastIndexOf(boundary))
    throw new Error('Cannot locate the application guest allocator boundary');
  await fs.writeFile(file, source.replace(boundary,
    '#if defined(__linux__) || defined(__APPLE__)\n    static const auto guest = [] {'));
  return [relative];
}
