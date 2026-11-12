// SPDX-License-Identifier: GPL-2.0-only
// Adapted from AnyTogether/AnyPS5-ARM commits 39d9838d532af080ec7d18c0be7e5ef933459e9e
// and d4987cc0361fad9aa8edcf1068d7ef4c1bb1faa6. Preserve owned lifecycle metadata
// and two-level library ordinals. Exact origins are also recorded in source.json.
import {applyArmPatches} from '../arm-patches.mjs';
export const applyArmImportRuntimeOverlay = root => applyArmPatches(root, import.meta.dirname, ['runtime']);
export const applyArmImportConverterOverlay = root => applyArmPatches(root, import.meta.dirname, ['converter']);
