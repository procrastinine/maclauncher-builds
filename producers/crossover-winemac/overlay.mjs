// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareSceneWindow} from './scene-window.mjs';
import {adaptSurfaceLifetime} from './surface-lifetime.mjs';
export const source = JSON.parse(fs.readFileSync(new URL('./source.json', import.meta.url)));
export function applyProfile(directory) {
 const file = path.join(directory, source.original.file), original = fs.readFileSync(file, 'utf8');
 if (crypto.createHash('sha256').update(original).digest('hex') !== source.original.sha256)
  throw Error('The CrossOver winemac source differs from its declared original.');
 const before = 'static void macdrv_map_device_extensions(struct vulkan_device_extensions *extensions)\n{\n}';
 const precedent = fs.readFileSync(path.join(directory, source.precedent.file), 'utf8');
 const statements = precedent.split('\n').filter(line => /^    if \(extensions->has_VK_KHR_external_(?:memory|semaphore|fence)_(?:win32|fd)\)/.test(line));
 if (statements.length !== 6 || original.split(before).length !== 2)
  throw Error('The original six FD mappings or macdrv function differ.');
 const sceneWindow = prepareSceneWindow(directory, source.sceneWindow, adaptSurfaceLifetime);
 fs.writeFileSync(file, original.replace(before, before.slice(0, -1) + statements.join('\n') + '\n}'));
 for (const [relative, bytes] of Object.entries(sceneWindow.files)) fs.writeFileSync(path.join(directory, relative), bytes);
 return {file:source.original.file, originalSha256:source.original.sha256,
  adaptedSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), addedStatements:6, sceneWindow:sceneWindow.record};
}
