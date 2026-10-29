import fs from 'node:fs/promises';
import path from 'node:path';

function replace(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before))
    throw Error('AnyPS5 graphics host boundary changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}
function wrapFunction(source, signature, apple) {
  const begin = source.indexOf(signature);
  if (begin < 0 || begin !== source.lastIndexOf(signature)) throw Error('AnyPS5 graphics host function changed: ' + signature);
  const open = source.indexOf('{', begin);
  let depth = 1, end = open + 1;
  for (; end < source.length && depth; ++end) { if (source[end] === '{') ++depth; else if (source[end] === '}') --depth; }
  if (depth) throw Error('Unclosed AnyPS5 graphics host function: ' + signature);
  return source.slice(0, open + 1) + '\n#ifdef __APPLE__\n' + apple + '\n#else' + source.slice(open + 1, end - 1) + '#endif\n' + source.slice(end - 1);
}
const include = '#ifdef __APPLE__\n#include "prx/libSceAgcDriver/Execution/include/DarwinAgcMemory.hpp"\n#endif\n';
export async function applyHostGraphicsOverlay(root) {
  const base = path.join(root, 'core/libs/prx/libSceAgcDriver');
  await fs.copyFile(new URL('./DarwinAgcMemory.hpp', import.meta.url), path.join(base, 'Execution/include/DarwinAgcMemory.hpp'));
  const edit = async (relative, transform) => {
    const file = path.join(base, relative);
    await fs.writeFile(file, transform(await fs.readFile(file, 'utf8')));
  };
  await edit('Graphics/src/ResidentMirror.cpp', source => {
    source = include + source;
    source = replace(source, 'struct Mapping {\n    std::uint64_t begin = 0;\n    std::uint64_t end = 0;\n    bool readable = false;\n    bool privateAnonymous = false;\n};', '#ifdef __APPLE__\nusing Mapping = DarwinAgcMemory::Mapping;\n#else\nstruct Mapping {\n    std::uint64_t begin = 0;\n    std::uint64_t end = 0;\n    bool readable = false;\n    bool privateAnonymous = false;\n};\n#endif');
    source = wrapFunction(source, 'std::vector<Mapping> mappings(std::uint64_t begin, std::uint64_t end)', '    return DarwinAgcMemory::Mappings(begin, end);');
    return wrapFunction(source, 'void populatedPages(std::vector<Candidate>& maybe, const Mapping& mapping)', `    DarwinAgcMemory::PopulatedPages(mapping, [&](std::uint64_t from, std::uint64_t to) {
        if (!maybe.empty() && maybe.back().end == from && maybe.back().readable == mapping.readable) maybe.back().end = to;
        else maybe.push_back({from, to, mapping.readable});
    });`);
  });
  await edit('Execution/src/PerformanceOverlay.cpp', source => wrapFunction(include + source,
    'std::optional<std::uint64_t> ReadProcessPrivateBytes()', '    return DarwinAgcMemory::PrivateBytes();'));
  await edit('Execution/src/PerformanceTrace.cpp', source => {
    source = replace(source, '#include <unistd.h>', '#include <unistd.h>\n#ifdef __APPLE__\n#include <crt_externs.h>\n#endif');
    return replace(source, '#else\n    char** entries = environ;', '#elif defined(__APPLE__)\n    char** entries = *_NSGetEnviron();\n#else\n    char** entries = environ;');
  });
  await edit('Graphics/src/GuestBufferMemory.cpp', source => replace(include + source,
    '#else\n        static const bool trace = std::getenv("APS5_TRACE_HOST_IMPORT") != nullptr;\n        if (std::FILE* maps = trace ? std::fopen("/proc/self/maps", "r") : nullptr)',
    '#elif defined(__APPLE__)\n        if (std::getenv("APS5_TRACE_HOST_IMPORT") != nullptr) DarwinAgcMemory::TraceMappings(base, bytes);\n#else\n        static const bool trace = std::getenv("APS5_TRACE_HOST_IMPORT") != nullptr;\n        if (std::FILE* maps = trace ? std::fopen("/proc/self/maps", "r") : nullptr)'));
  const optimizerFile = path.join(root, 'core/shader/recompiler/SpirvBackend/src/SpirvOptimizer.cpp');
  let optimizer = await fs.readFile(optimizerFile, 'utf8');
  optimizer = replace(optimizer, '            pthread_attr_t attributes;', '#ifdef __APPLE__\n            high = reinterpret_cast<std::uintptr_t>(pthread_get_stackaddr_np(pthread_self()));\n            const auto size = pthread_get_stacksize_np(pthread_self());\n            if (size <= high) low = high - size;\n#else\n            pthread_attr_t attributes;');
  optimizer = replace(optimizer, '            pthread_attr_destroy(&attributes);', '            pthread_attr_destroy(&attributes);\n#endif');
  await fs.writeFile(optimizerFile, optimizer);
}
