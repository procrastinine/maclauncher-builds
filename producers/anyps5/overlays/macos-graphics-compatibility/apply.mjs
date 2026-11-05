import {editor} from './common.mjs';
import {applyStorageCompatibility} from './storage.mjs';
import {applyShaderResultCompatibility} from './results.mjs';
import {applyTessellationCompatibility} from './tessellation.mjs';
import {applyProvokingCompatibility} from './provoking.mjs';

export async function applyGraphicsCompatibilityOverlay(root) {
    const changes = [];
    const edit = editor(root, changes);
    await applyStorageCompatibility(edit);
    await applyShaderResultCompatibility(edit);
    await applyTessellationCompatibility(edit);
    await applyProvokingCompatibility(edit);
    return [...new Set(changes)];
}
