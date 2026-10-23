const fs = require("node:fs");

const CPU_NAMES = new Map([[0x01000007, "x86_64"], [0x0100000c, "arm64"]]);

function readAt(fd, size, offset) {
  const data = Buffer.alloc(size);
  if (fs.readSync(fd, data, 0, size, offset) !== size) throw new Error("Truncated Mach-O runtime.");
  return data;
}

function readExecutableHeader(fd, offset, size, allowLibrary) {
  if (size < 32) throw new Error("Truncated Mach-O runtime.");
  const data = readAt(fd, 32, offset);
  const magic = data.readUInt32BE(0);
  const little = magic === 0xcffaedfe;
  if (!little && magic !== 0xfeedfacf) throw new Error("Runtime must be a 64-bit macOS Mach-O executable.");
  const read = position => little ? data.readUInt32LE(position) : data.readUInt32BE(position);
  if (read(12) !== 2 && !(allowLibrary && [6, 8].includes(read(12)))) throw new Error("Mach-O runtime is not an executable.");
  const architecture = CPU_NAMES.get(read(4));
  if (!architecture) throw new Error("Runtime uses an unsupported macOS CPU architecture.");
  if (read(20) > size - 32) throw new Error("Truncated Mach-O load commands.");
  return { cpu: read(4), architecture };
}

// Parse bounded headers without invoking file/lipo or executing the selected file.
function readMachOArchitectures(executablePath, { allowLibrary = false } = {}) {
  const stat = fs.statSync(executablePath);
  if (!stat.isFile() || stat.size < 32) throw new Error("Runtime must be a macOS Mach-O executable.");
  const fd = fs.openSync(executablePath, "r");
  try {
    const header = readAt(fd, 8, 0);
    const magic = header.readUInt32BE(0);
    const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    const fat32 = magic === 0xcafebabe || magic === 0xbebafeca;
    if (!fat64 && !fat32) return [readExecutableHeader(fd, 0, stat.size, allowLibrary).architecture];
    const little = magic === 0xbfbafeca || magic === 0xbebafeca;
    const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
    const stride = fat64 ? 32 : 20;
    if (count < 1 || count > 32 || 8 + count * stride > stat.size) throw new Error("Invalid universal Mach-O header.");
    const table = readAt(fd, count * stride, 8);
    const architectures = [];
    for (let i = 0; i < count; i += 1) {
      const start = i * stride;
      const read32 = position => little ? table.readUInt32LE(start + position) : table.readUInt32BE(start + position);
      const read64 = position => Number(little ? table.readBigUInt64LE(start + position) : table.readBigUInt64BE(start + position));
      const offset = fat64 ? read64(8) : read32(8);
      const size = fat64 ? read64(16) : read32(12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 8 + count * stride || size < 32 || offset > stat.size - size) {
        throw new Error("Invalid universal Mach-O slice.");
      }
      const slice = readExecutableHeader(fd, offset, size, allowLibrary);
      if (slice.cpu !== read32(0)) throw new Error("Universal Mach-O slice architecture mismatch.");
      architectures.push(slice.architecture);
    }
    return Array.from(new Set(architectures));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readMachOArchitectures };
