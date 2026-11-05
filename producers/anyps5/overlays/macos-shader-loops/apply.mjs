import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
        throw Error('AnyPS5 shader loop boundary changed: ' + before.slice(0, 80));
    return source.replace(before, after);
}

export async function applyShaderLoopsOverlay(root) {
    const relative = 'core/shader/recompiler/SpirvBackend/src/SpirvEmitter.cpp';
    const file = path.join(root, relative);
    let source = await fs.readFile(file, 'utf8');
    source = replace(source, '#include <string>', '#include <string>\n#include <unordered_map>\n#include <vector>\n#include <limits>');
    const split = await fs.readFile(new URL('./SplitContinueBodies.inc', import.meta.url), 'utf8');
    source = replace(source, 'namespace {\n', 'namespace {\n\n' + split + '\n');
    source = replace(source, '    return state.module.Finalize();', '#ifdef __APPLE__\n    return SplitContinueBodies(state.module.Finalize());\n#else\n    return state.module.Finalize();\n#endif');
    await fs.writeFile(file, source);
    return [relative];
}
