const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {Readable,Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
const B=require('./bundled-native.cjs');
const LIMITS={archiveBytes:4*1024**3,expandedBytes:8*1024**3,metadataBytes:8*1024**2,entries:300000};
const PRIVATE_PART=/^(?:\.git|\.local|\.env(?:\..*)?|localconfig.*\.json|__pycache__|\.DS_Store|\._.*)$|\.(?:log|har|pcap|heapsnapshot|pyc|pyo)$/i;
function safeFile(value) {
  const file = B.relativeFile(value);
  if (file.split('/').some(part => PRIVATE_PART.test(part))) throw new Error('Native payloads cannot contain private files, caches or diagnostics.');
  return file;
}
function tarHeader(name, size, mode, sourceDateEpoch = 0) {
  safeFile(name);
  let prefix = '', base = name;
  if (Buffer.byteLength(base) > 100) {
    const candidates = [...name.matchAll(/\//g)].map(match => match.index).reverse();
    const split = candidates.find(index => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100);
    if (split === undefined) throw new Error('A native payload path exceeds portable tar limits.');
    prefix = name.slice(0, split); base = name.slice(split + 1);
  }
  const header = Buffer.alloc(512);
  header.write(base, 0, 100); header.write(prefix, 345, 155);
  function number(value, offset, length) {
    const encoded = value.toString(8);
    if (!Number.isSafeInteger(value) || value < 0 || encoded.length >= length) throw new Error('Native payload exceeds portable tar numeric limits.');
    header.write(encoded.padStart(length - 1, '0') + '\0', offset, length);
  }
  number(mode, 100, 8); number(0, 108, 8); number(0, 116, 8); number(size, 124, 12); number(sourceDateEpoch, 136, 12);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}
async function checksum(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function writeArchive(entries, output, { sourceDateEpoch = 0 } = {}) {
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new Error('Archive source date epoch must be a nonnegative integer.');
  // Explicit source epochs select canonical order; legacy archive reproduction keeps its inventory order.
  const [inventory, ...files] = entries;
  if (sourceDateEpoch) entries = inventory?.name === 'runtime-package.json'
    ? [inventory, ...files.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))]
    : [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  if (entries.length > LIMITS.entries) throw new Error('Native payload has too many archive entries.');
  const archive = path.resolve(output);
  B.realDirectory(path.dirname(archive), { create: true });
  if (fs.existsSync(archive)) throw new Error('Choose a new archive path; existing release artifacts are preserved.');
  let started = false;
  async function* blocks() {
    let total = 0;
    for (const entry of entries) {
      total += 512 + Math.ceil(entry.size / 512) * 512;
      if (total > LIMITS.expandedBytes) throw new Error('Expanded native payload exceeds its aggregate limit.');
      yield tarHeader(entry.name, entry.size, entry.mode, sourceDateEpoch);
      const hash = crypto.createHash('sha256'); let size = 0;
      const stream = entry.bytes ? Readable.from([entry.bytes]) : fs.createReadStream(entry.file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
      for await (const chunk of stream) { size += chunk.length; if (size > entry.size) throw new Error('Native payload changed during export.'); hash.update(chunk); yield chunk; }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('Native payload changed during export.');
      if (size % 512) yield Buffer.alloc(512 - size % 512);
    }
    yield Buffer.alloc(1024);
  }
  try {
    const target = fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 });
    target.once('open', () => { started = true; });
    // RFC 1952's OS byte is part of the archive checksum. Preserve the Mac
    // package format when the same data package is prepared on another host.
    let compressedOffset = 0;
    const header = new Transform({ transform(chunk, _encoding, done) {
      if (compressedOffset <= 9 && compressedOffset + chunk.length > 9) {
        chunk = Buffer.from(chunk); chunk[9 - compressedOffset] = 19;
      }
      compressedOffset += chunk.length; done(null, chunk);
    } });
    await pipeline(Readable.from(blocks()), zlib.createGzip({ level: 6, windowBits: 15, memLevel: 8, strategy: zlib.constants.Z_DEFAULT_STRATEGY }), header, target);
    if (fs.statSync(archive).size > LIMITS.archiveBytes) throw new Error('Native archive exceeds its download limit.');
    return { archive: path.basename(archive), sha256: await checksum(archive), bytes: fs.statSync(archive).size };
  } catch (error) { if (started) fs.rmSync(archive, { force: true }); throw error; }
}
class ArchiveReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.total = 0; }
  async read(size, optional = false) {
    while (this.buffer.length < size) {
      const next = await this.iterator.next();
      if (next.done) { if (optional && !this.buffer.length) return null; throw new Error('Truncated native payload archive.'); }
      this.total += next.value.length;
      if (this.total > LIMITS.expandedBytes) throw new Error('Expanded native payload exceeds its aggregate limit.');
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
    const result = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return result;
  }
  async end() {
    if (this.buffer.some(byte => byte !== 0)) throw new Error('Unexpected data after native archive terminator.');
    let trailing = this.buffer.length;
    for await (const chunk of { [Symbol.asyncIterator]: () => this.iterator }) {
      trailing += chunk.length;
      if (trailing > LIMITS.metadataBytes || chunk.some(byte => byte !== 0)) throw new Error('Unexpected data after native archive terminator.');
    }
  }
}
function parseHeader(header) {
  const string = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
  const number = (start, length) => { const value = string(start, length).trim(); if (!/^[0-7]+$/.test(value)) throw new Error('Invalid native tar numeric field.'); const result = parseInt(value, 8); if (!Number.isSafeInteger(result)) throw new Error('Native tar number exceeds its limit.'); return result; };
  const expected = number(148, 8), copy = Buffer.from(header); copy.fill(32, 148, 156);
  if (copy.reduce((sum, byte) => sum + byte, 0) !== expected || string(257, 6) !== 'ustar' || ![0, 48].includes(header[156]) || string(157, 100)) throw new Error('Native payload must contain checksummed portable tar regular files only.');
  const prefix = string(345, 155), name = safeFile((prefix ? prefix + '/' : '') + string(0, 100));
  return { name, size: number(124, 12), mode: number(100, 8) };
}

module.exports={safeFile,tarHeader,checksum,writeArchive,ArchiveReader,parseHeader,LIMITS};
