// Files a runtime payload never carries: private, test, generated and repository
// metadata paths, by the same rules the launcher applies to its own content.
const privateDirectories = ['.local', 'private-tests', '.git', '.agents', '.codex', '.claude'];
const testDirectories = ['test', 'tests', 'testsuite', 'testsuites', 'spec', 'specs', '__tests__', 'fixture', 'fixtures', '__fixtures__', 'testcases', 'testdata', 'test-data', '__mocks__'];
const generatedDirectories = ['.build', '.swiftpm', 'CMakeFiles', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'test-results', 'playwright-report'];
const generatedFiles = new Set(['CMakeCache.txt', 'CTestTestfile.cmake', 'build.ninja', '.ninja_log', '.ninja_deps', 'compile_commands.json']);
const instructionFiles = ['AGENTS.md'];
// Git repository metadata describes a checkout, not runtime content.
const repositoryFiles = new Set(['.gitmodules', '.gitattributes', '.gitignore']);
const sourceExtensions = ['c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'm', 'mm', 'swift', 'js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'rs', 'java', 'fx', 'sh', 'go'];
const namedTest = new RegExp('(?:^tests?(?:$|[-_.])|[-_]tests?(?:$|\\.(?:' + sourceExtensions.join('|') + ')(?:\\.|$))|\\.(?:test|spec)\\.(?:' + sourceExtensions.join('|') + ')(?:\\.|$))', 'i');
const pythonTestExtension = /^_ctypes_test\.cpython-[0-9]+[a-z]*-darwin\.so$/;
function excludedReason(file) {
  const parts = String(file).replaceAll('\\', '/').split('/').filter(Boolean);
  // Bundler::CLI::Gem copies these templates into generated gems. They are
  // production generator inputs, including its test-framework templates.
  const templates = parts.findIndex((part, index) => part === 'bundler' && parts[index + 1] === 'templates' && parts[index + 2] === 'newgem');
  const executableParts = templates < 0 ? parts : parts.slice(0, templates + 3);
  if (parts.some(part => privateDirectories.some(name => name.toLowerCase() === part.toLowerCase()))) return 'private development directory';
  if (parts.some(part => instructionFiles.some(name => name.toLowerCase() === part.toLowerCase()))) return 'process instruction file';
  if (executableParts.some(part => testDirectories.some(name => name.toLowerCase() === part.toLowerCase()) || /\.xctest$/i.test(part))) return 'test directory or fixture';
  if (parts.some(part => generatedDirectories.includes(part) || /\.dSYM$/.test(part)) || generatedFiles.has(parts.at(-1))) return 'generated build or test output';
  if (repositoryFiles.has(parts.at(-1))) return 'repository metadata';
  if (pythonTestExtension.test(parts.at(-1))) return 'Python test extension';
  if (executableParts.some(part => namedTest.test(part))) return 'test source or runner filename';
  return null;
}

module.exports = { excludedReason };
