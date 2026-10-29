#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// Adapted from AnyPS5 tools/unwrap_self.py at
// https://github.com/boykopovar/AnyPS5/tree/e7e3e9c1984c293f06bff08428b8c89b7b932ac2
// Copyright and license notices are retained in the accompanying AnyPS5 license.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SELF_MAGIC = 0x1d3d154f, SELF_MAGIC_KERNEL = 0xeef51454;
const FIRST_REGION = 0x400, MAX_ALIGNMENT_PADDING = 64n * 1024n * 1024n;
const PT_LOAD = 1, PT_NOTE = 4, ENTROPY_LIMIT = 7.5, ENTROPY_SAMPLE = 0x10000n;
const PHDR_NAMES = new Map([[1,"PT_LOAD"],[2,"PT_DYNAMIC"],[3,"PT_INTERP"],[4,"PT_NOTE"],
  [6,"PT_PHDR"],[7,"PT_TLS"],[0x6474e550,"PT_GNU_EH_FRAME"],[0x6474e551,"PT_GNU_STACK"],
  [0x6474e552,"PT_GNU_RELRO"],[0x61000000,"PT_SCE_DYNLIBDATA"],[0x61000001,"PT_OS_PROCPARAM"],
  [0x61000002,"PT_OS_0x61000002"],[0x6fffff00,"PT_OS_0x6fffff00"],[0x6fffff01,"PT_OS_0x6fffff01"]]);
class Refused extends Error { constructor(message) { super(message); this.name = "Refused"; } }
const min = (a,b) => a < b ? a : b, max = (a,b) => a > b ? a : b;
const hex = value => "0x" + value.toString(16);
const modulo = (value, divisor) => (value % divisor + divisor) % divisor;
const powerOfTwo = value => value > 0n && (value & (value - 1n)) === 0n;

function entropy(data) {
  if (!data.length) return 0;
  const counts = new Uint32Array(256);
  for (const value of data) counts[value]++;
  let result = 0;
  for (const count of counts) if (count) { const probability = count / data.length; result -= probability * Math.log2(probability); }
  return result;
}
function readRecords(data) {
  const records = [], length = BigInt(data.length);
  for (let offset = 0x40; offset + 0x20 <= FIRST_REGION; offset += 0x20) {
    const flags = data.readBigUInt64LE(offset), segment = data.readBigUInt64LE(offset + 8);
    const size = data.readBigUInt64LE(offset + 16), sizeAgain = data.readBigUInt64LE(offset + 24);
    if (size === 0n || size !== sizeAgain || segment >= length || segment < 0x350n || segment % 0x10n !== 0n || size > length) break;
    records.push({ flags, segment, size });
  }
  return records;
}
function parseElf(data) {
  const inner = data.indexOf(Buffer.from([0x7f,0x45,0x4c,0x46]));
  if (inner < 0) throw new Refused("no inner ELF header");
  if (inner + 0x40 > data.length) throw new Refused("inner ELF header is truncated");
  const header = Buffer.from(data.subarray(inner, inner + 0x40));
  if (header[4] !== 2 || header[5] !== 1) throw new Refused("inner ELF is not 64-bit little-endian");
  const programOffset = header.readBigUInt64LE(0x20), entrySize = header.readUInt16LE(0x36), count = header.readUInt16LE(0x38);
  if (entrySize !== 56 || count === 0) throw new Refused(`program header table is ${count} entries of ${entrySize} bytes`);
  if (programOffset < 64n) throw new Refused("ELF program header table overlaps the ELF header");
  if (BigInt(inner) + programOffset + BigInt(count * entrySize) > BigInt(data.length)) throw new Refused("ELF program header table does not fit the file");
  const headers = [];
  for (let index = 0; index < count; index++) {
    const offset = inner + Number(programOffset) + index * 56;
    const item = { index, type: data.readUInt32LE(offset), flags: data.readUInt32LE(offset + 4),
      offset: data.readBigUInt64LE(offset + 8), vaddr: data.readBigUInt64LE(offset + 16),
      size: data.readBigUInt64LE(offset + 32), memory: data.readBigUInt64LE(offset + 40),
      align: data.readBigUInt64LE(offset + 48), host: null };
    item.source = item.offset;
    if (item.type === PT_LOAD) {
      if (item.size > item.memory) throw new Refused(`segment ${index} file size exceeds memory size`);
      if (item.align && !powerOfTwo(item.align)) throw new Refused(`segment ${index} alignment is not a power of two`);
      if (item.memory > (1n << 64n) - item.vaddr) throw new Refused(`segment ${index} memory range exceeds ELF64`);
    }
    headers.push(item);
  }
  return { inner, header, headers, programOffset };
}
function placeSegments(data, headers, records) {
  const length = BigInt(data.length), loads = headers.filter(h => h.type === PT_LOAD), used = new Set(), placed = new Set();
  records.forEach(({flags, segment, size}, index) => {
    const target = flags >> 20n;
    if ((flags & 0x800n) && target < BigInt(headers.length) && !placed.has(Number(target)) && headers[Number(target)].size === size) {
      headers[Number(target)].source = segment; placed.add(Number(target)); used.add(index);
    }
  });
  const recorded = headers.filter(h => placed.has(h.index) && h.vaddr === 0n && h.type !== PT_LOAD);
  if (recorded.length) {
    const last = recorded.reduce((a,b) => a.offset >= b.offset ? a : b);
    let cursor = last.source + last.size;
    const trailing = headers.filter(h => !placed.has(h.index) && h.vaddr === 0n && h.type !== PT_LOAD && h.size && h.offset > last.offset);
    for (const item of trailing.sort((a,b) => a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0)) {
      placed.add(item.index);
      if (item.type === PT_NOTE) { item.source = 0n; item.size = 0n; continue; }
      item.source = cursor; cursor += item.size;
      if (cursor > length) { item.source = 0n; item.size = 0n; }
    }
  }
  for (const item of loads) {
    if (!item.size || placed.has(item.index)) continue;
    for (let index = 0; index < records.length; index++) {
      if (!used.has(index) && records[index].size === item.size) { used.add(index); item.source = records[index].segment; break; }
    }
  }
  function loadFor(vaddr, size) {
    let found = null;
    for (const item of loads) {
      const end = item.vaddr + item.memory;
      if (item.memory && item.vaddr <= vaddr && (vaddr < end || (size === 0n && vaddr === end))) found = item;
    }
    return found;
  }
  let tail = null;
  for (const item of headers) {
    if (item.type === PT_LOAD) continue;
    if (placed.has(item.index)) {
      if (item.size && (!tail || item.offset > tail[0])) tail = [item.offset, item.source - item.offset];
      continue;
    }
    if (item.vaddr !== 0n) {
      const host = loadFor(item.vaddr, item.size);
      if (!host) {
        if (item.size === 0n) { item.source = 0n; continue; }
        throw new Refused(`segment ${item.index} vaddr ${hex(item.vaddr)} is in no PT_LOAD`);
      }
      const offset = item.vaddr - host.vaddr;
      if (item.size && (offset > host.size || item.size > host.size - offset)) throw new Refused(`segment ${item.index} does not fit the file-backed range of PT_LOAD ${host.index}`);
      if (host.size === 0n || offset > host.size) { item.source = 0n; continue; }
      item.host = host; item.source = host.source + offset;
      if (!tail || item.offset > tail[0]) tail = [item.offset, item.source - item.offset];
    } else if (item.size) {
      item.source = min(item.offset + (tail ? tail[1] : 0n), length);
      const keep = max(0n, length - item.source);
      item.size = min(item.size, keep); item.memory = min(item.memory, keep);
    }
  }
  for (const item of headers) {
    if (item.type === PT_LOAD && item.size === 0n) continue;
    if (item.source < 0n || item.source > length || item.size > length - item.source) throw new Refused(`segment ${item.index} does not fit the file`);
  }
}
function checkDecrypted(data, headers) {
  const encrypted = [], loads = headers.filter(h => h.type === PT_LOAD && h.size);
  for (const item of loads) {
    const sample = data.subarray(Number(item.source), Number(item.source + min(item.size, ENTROPY_SAMPLE))), value = entropy(sample);
    if (value >= ENTROPY_LIMIT) encrypted.push(`segment ${item.index} at ${hex(item.source)} (${value.toFixed(2)} bits per byte)`);
  }
  if (encrypted.length && encrypted.length === loads.length) throw new Refused("every load segment looks encrypted: " + encrypted.join(", "));
}
function unwrapBuffer(data) {
  if (!Buffer.isBuffer(data)) throw new TypeError("SELF input must be a Buffer.");
  if (data.length < FIRST_REGION) throw new Refused("file is smaller than the SELF header area");
  const magic = data.readUInt32LE(0);
  if (![SELF_MAGIC,SELF_MAGIC_KERNEL].includes(magic)) throw new Refused(`not a SELF container (magic ${hex(magic)})`);
  const records = readRecords(data), parsed = parseElf(data), { headers, header, programOffset } = parsed;
  placeSegments(data, headers, records); checkDecrypted(data, headers);
  const regions = [], loadRegions = new Map();
  for (const item of headers) if (item.type === PT_LOAD && item.size) {
    const region = { old: item.source, size: item.size, vaddr: item.vaddr, align: item.align };
    regions.push(region); loadRegions.set(item.index, region);
  }
  const regionFor = (offset,size) => regions.find(region => region.old <= offset && offset + size <= region.old + region.size);
  for (const item of headers) {
    if (item.type === PT_LOAD || item.size === 0n) continue;
    if (!regionFor(item.source,item.size)) regions.push({old:item.source,size:item.size,vaddr:item.vaddr,align:item.align});
  }
  regions.sort((a,b) => a.old < b.old ? -1 : a.old > b.old ? 1 : 0);
  let cursor = max(BigInt(FIRST_REGION), programOffset + BigInt(headers.length * 56)), padding = 0n;
  for (const region of regions) {
    const alignment = powerOfTwo(region.align) ? region.align : 1n;
    const placed = cursor + modulo(region.vaddr - cursor,alignment);
    padding += placed - cursor; region.new = placed; cursor = placed + region.size;
  }
  let emptyEnd = cursor;
  for (const item of headers) if (item.type === PT_LOAD && item.size === 0n) emptyEnd = max(emptyEnd,item.vaddr % max(item.align,1n));
  padding += emptyEnd - cursor;
  if (padding > MAX_ALIGNMENT_PADDING) throw new Refused(`segment alignment requires more than ${MAX_ALIGNMENT_PADDING} bytes of output padding`);
  cursor = emptyEnd;
  if (cursor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Refused("ELF output exceeds the host buffer range");
  const result = Buffer.alloc(Number(cursor));
  for (const region of regions) data.copy(result,Number(region.new),Number(region.old),Number(region.old + region.size));
  for (const item of headers) {
    if (item.size === 0n && (item.type === PT_LOAD || item.source === 0n)) { item.new = item.type === PT_LOAD ? item.vaddr % max(item.align,1n) : 0n; continue; }
    const host = item.type === PT_LOAD ? item : item.host;
    let region = host ? loadRegions.get(host.index) : null;
    if (!region) region = regionFor(item.source,item.size);
    item.new = region ? region.new + (item.source - region.old) : item.source;
    if (item.new + item.size > BigInt(result.length)) throw new Refused(`segment ${item.index} escaped the output`);
  }
  header.copy(result,0); result.writeBigUInt64LE(0n,0x28); result.writeUInt16LE(0,0x3c); result.writeUInt16LE(0,0x3e);
  for (const item of headers) {
    const at = Number(programOffset) + item.index * 56;
    result.writeUInt32LE(item.type,at); result.writeUInt32LE(item.flags,at+4);
    [item.new,item.vaddr,item.vaddr,item.size,item.memory,item.align].forEach((value,index) => result.writeBigUInt64LE(value,at+8+index*8));
  }
  return { bytes: result, inner: parsed.inner, headers, records };
}
function resolvedPath(file) {
  const absolute = path.resolve(file);
  try { return fs.realpathSync(absolute); }
  catch (error) { if (error.code !== "ENOENT") throw error; const parent = path.dirname(absolute); return parent === absolute ? absolute : path.join(resolvedPath(parent),path.basename(absolute)); }
}
function unwrap(source, output, { verbose = false, log = console.log } = {}) {
  const input = resolvedPath(source), destination = resolvedPath(output);
  let same = input === destination;
  if (!same && fs.existsSync(destination)) { const a = fs.statSync(input), b = fs.statSync(destination); same = a.dev === b.dev && a.ino === b.ino; }
  if (same) throw new Refused("output aliases the input container");
  const data = fs.readFileSync(input), { bytes, inner, headers, records } = unwrapBuffer(data);
  if (verbose) {
    log(`${path.basename(source)}: ${hex(data.length)} bytes, inner ELF at ${hex(inner)}, ${headers.length} program headers, ${records.length} SELF records`);
    for (const item of headers) log(`  [${String(item.index).padStart(2)}] ${(PHDR_NAMES.get(item.type)||"PT_"+hex(item.type)).padEnd(18)} vaddr=${hex(item.vaddr)} filesz=${hex(item.size)} offset=${hex(item.new)}${item.new===item.offset?"":", was "+hex(item.offset)}`);
  }
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const temporary = path.join(path.dirname(destination),".unwrap-self-"+crypto.randomBytes(16).toString("hex"));
  let descriptor = fs.openSync(temporary,"wx");
  try {
    fs.writeFileSync(descriptor,bytes); fs.closeSync(descriptor); descriptor = null;
    if (process.platform !== "win32" && fs.existsSync(destination)) fs.chmodSync(temporary,fs.statSync(destination).mode);
    fs.renameSync(temporary,destination);
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return bytes.length;
}
function main(args = process.argv.slice(2)) {
  const verbose = args.includes("--verbose"), paths = args.filter(arg=>arg!=="--verbose");
  if (paths.length !== 2 || paths.some(arg=>arg.startsWith("--"))) { console.error("usage: unwrap-self.cjs <input.self> <output.elf> [--verbose]"); return 2; }
  try { const size = unwrap(paths[0],paths[1],{verbose}); console.log(`wrote ${paths[1]}, ${size} bytes`); return 0; }
  catch (error) { console.error(`FAIL: ${paths[0]}: ${error.message}`); return 2; }
}
module.exports = { unwrap, unwrapBuffer, Refused, entropy, readRecords, parseElf, placeSegments, checkDecrypted };
if (require.main === module) process.exitCode = main();
