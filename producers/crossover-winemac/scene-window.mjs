// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const sceneWindowInputs = ['scene-window.mjs', 'scene-window.h', 'scene-window.c', 'scene-window-cocoa.inc'];

export function prepareSceneWindow(directory, profile, adaptCocoaWindow = text => text) {
  const original = {};
  for (const [file, expected] of Object.entries(profile.originals)) {
    original[file] = fs.readFileSync(path.join(directory, file));
    if (sha(original[file]) !== expected)
      throw Error('The matched macdrv scene-window source differs: ' + file);
  }
  const base = 'dlls/winemac.drv/';
  const makefile = base + 'Makefile.in', cocoa = base + 'cocoa_window.m';
  const anchor = '\tmacdrv_main.c \\\n';
  const make = original[makefile].toString();
  if (make.split(anchor).length !== 2) throw Error('The macdrv source list differs.');
  const files = {
    [makefile]: make.replace(anchor, anchor + '\tmaclauncher_scene_window.c \\\n'),
    [cocoa]: adaptCocoaWindow(original[cocoa].toString()) + '\n' + fs.readFileSync(new URL('./scene-window-cocoa.inc', import.meta.url), 'utf8'),
    [base + 'maclauncher_scene_window.h']: fs.readFileSync(new URL('./scene-window.h', import.meta.url)),
    [base + 'maclauncher_scene_window.c']: fs.readFileSync(new URL('./scene-window.c', import.meta.url)),
  };
  return {files, record:{abi:1, entryPoint:'MacLauncherWineMacWithWindow1',
    files:Object.entries(files).map(([file, bytes]) => ({file, ...(profile.originals[file] ? {originalSha256:profile.originals[file]} : {}), adaptedSha256:sha(bytes)}))}};
}
