import fs from 'node:fs/promises';
import path from 'node:path';
import {changes} from './changes.mjs';

function replace(source, before, after, file) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
        throw Error('AnyPS5 mesh compute boundary changed: ' + file + ': ' + before.slice(0, 80));
    return source.replace(before, after);
}

export async function applyMeshComputeOverlay(root) {
    const changed = [];
    for (const change of changes) {
        const file = path.join(root, change.file);
        if (change.copy) await fs.copyFile(new URL('./' + change.copy, import.meta.url), file);
        else {
            let source = await fs.readFile(file, 'utf8');
            for (const [before, after] of change.replacements) source = replace(source, before, after, change.file);
            await fs.writeFile(file, source);
        }
        changed.push(change.file);
    }
    const edit = async (relative, transform) => {
        const file = path.join(root, relative);
        await fs.writeFile(file, transform(await fs.readFile(file, 'utf8'), relative));
        changed.push(relative);
    };
    await edit('core/shader/recompiler/ControlFlow/src/RequestSerializer.cpp', (source, file) => {
        source = replace(source, 'writer.WriteU32(51u);', 'writer.WriteU32(54u);', file);
        source = replace(source, 'version > 51u', 'version > 54u', file);
        source = replace(source, '    return base64Encode(buffer);', '    writer.WriteBool(request.target.meshAsCompute);\n    return base64Encode(buffer);', file);
        return replace(source, '    if (version >= 21u && reader.Remaining() != 0u)', '    if (version >= 54u) result.request.target.meshAsCompute = reader.ReadBool();\n    if (version >= 21u && reader.Remaining() != 0u)', file);
    });
    await edit('core/shader/recompiler/ShaderDiskCache.hpp', (source, file) => replace(source, 'FormatVersion = 50;', 'FormatVersion = 51;', file));
    await edit('core/shader/recompiler/CMakeLists.txt', (source, file) => replace(source,
        '    set(shaderCacheReviewedNames',
        '    set(shaderCacheReviewedNames\n        BuildMeshPassthroughVertexShader\n        MeshEmulationRole\n        EmulatedMeshSlots\n        MeshEmulationDescriptorSet', file));
    await edit('core/libs/prx/libSceAgcDriver/Graphics/src/Draw.cpp', (source, file) => replace(source,
        '            add(program.bdaAbiVersion);', '            add(program.bdaAbiVersion);\n            add(program.meshEmulation);', file));
    await edit('core/libs/prx/libSceAgcDriver/Graphics/src/Draw.cpp', (source, file) => replace(source,
        '        add(context.demoteToHelperInvocation); add(context.meshShader);', '        add(context.demoteToHelperInvocation); add(context.meshShader);\n        add(context.pushDescriptor);', file));
    return changed;
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * compute mesh route and passthrough shader:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/92bb89e6698eade9df44f437a3e72fe8f6675ec5
 * descriptor-backed mesh records and draw arguments:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/324e649e71cf7ec445387739a7edf4826702803d
 */
