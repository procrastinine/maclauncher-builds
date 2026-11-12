// SPDX-License-Identifier: GPL-2.0-only
// Adapted from https://github.com/AnyTogether/AnyPS5-ARM.git
// abbbbfd0cfb73ea4ce08f347b5847ba22b14623d. Retain owned write-watch fault
// reporting/chaining and Darwin x87 TOP rotation. Exact origin is in source.json.
import {applyArmPatches} from '../arm-patches.mjs';
export const applyArmFaultOverlay = root => applyArmPatches(root, import.meta.dirname, ['runtime']);
