import fs from 'node:fs/promises';
import path from 'node:path';
export function replace(source, before, after) {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
        throw Error('AnyPS5 graphics compatibility boundary changed: ' + before.slice(0, 96));
    return source.replace(before, after);
}
export const apple = (before, after) => '#ifdef __APPLE__\n' + after + '\n#else\n' + before + '\n#endif';
export function editor(root, changes) {
    return async (relative, transform) => {
        const file = path.join(root, relative);
        await fs.writeFile(file, await transform(await fs.readFile(file, 'utf8')));
        changes.push(relative);
    };
}
