import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 draw descriptor source changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}

export async function applyDescriptorReuseOverlay(root) {
  const base = path.join(root, 'core/libs/prx/libSceAgcDriver/Graphics');
  const header = path.join(base, 'include/ShaderResources.hpp');
  let declarations = await fs.readFile(header, 'utf8');
  declarations = replace(declarations, '    mutable std::vector<VkDescriptorPoolSize> drawPoolSizes;',
    '    mutable std::vector<VkDescriptorPoolSize> drawPoolSizes;\n#ifdef __APPLE__\n    mutable std::weak_ptr<DrawBindings> lastDrawBindings;\n    mutable std::vector<std::size_t> lastDrawSelected;\n#endif');
  await fs.writeFile(header, declarations);
  const file = path.join(base, 'src/ShaderResources.cpp');
  const original = await fs.readFile(file, 'utf8');
  const begin = original.indexOf('std::shared_ptr<ShaderResources::DrawBindings> ShaderResources::PrepareDrawBindings(');
  const end = original.indexOf('\nvoid ShaderResources::requireGuestBuffers(', begin);
  if (begin < 0 || end < 0) throw Error('AnyPS5 draw bindings source changed');
  let source = original.slice(begin, end);
  source = replace(source, '    if (selected.empty()) return {};', `    if (selected.empty()) return {};
#ifdef __APPLE__
    static const bool reuseSets = std::getenv("APS5_NO_DRAW_SET_REUSE") == nullptr;
    if (reuseSets) {
        if (auto last = lastDrawBindings.lock(); last != nullptr && lastDrawSelected == selected && std::equal(last->snapshots.begin(), last->snapshots.end(), result->snapshots.begin(), result->snapshots.end(), [](const auto& left, const auto& right) {
            return left.address == right.address && left.buffer == right.buffer && left.offset == right.offset && left.bytes == right.bytes;
        })) {
            recorder.Keep(last);
            for (const auto& snapshot : last->snapshots) recorder.KeepBytes(snapshot.buffer.get(), snapshot.buffer->Bytes().size());
            return last;
        }
    }
#endif`);
  source = replace(source, '    return result;\n}', `#ifdef __APPLE__
    if (reuseSets) {
        lastDrawBindings = result;
        lastDrawSelected.assign(selected.begin(), selected.end());
    }
#endif
    return result;
}`);
  await fs.writeFile(file, original.slice(0, begin) + source + original.slice(end));
}

/*
 * Portions adapted from AnyPS5-ARM (GPL-2.0-only).
 * unchanged draw-descriptor reuse:
 * https://github.com/AnyTogether/AnyPS5-ARM/commit/3023832ab76e41aa2596647e18c2fb3cec07660e
 */
