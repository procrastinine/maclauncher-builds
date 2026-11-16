# SPDX-License-Identifier: GPL-2.0-only
# Writes the __TEXT,__text bytes of an x86-64 Mach-O object and prints the offsets of the named symbols in them.
# Refuses an object whose text has relocations: the proof host maps the bytes as they are.
# Usage: macho-text.py <object.o> <out.bin> <symbol>...
import struct, sys

data = open(sys.argv[1], 'rb').read()
magic, cputype, _, _, ncmds, _, _, _ = struct.unpack_from('<IiiIIIII', data, 0)
if magic != 0xfeedfacf or cputype != 0x01000007:
    sys.exit('not an x86-64 Mach-O object')
offset, text, section_index, symtab = 32, None, 0, None
for _ in range(ncmds):
    cmd, size = struct.unpack_from('<II', data, offset)
    if cmd == 0x19:
        nsects = struct.unpack_from('<I', data, offset + 64)[0]
        for i in range(nsects):
            s = offset + 72 + 80 * i
            section_index += 1
            sectname, segname = data[s:s + 16].rstrip(b'\0'), data[s + 16:s + 32].rstrip(b'\0')
            addr, length, fileoff, _, _, nreloc = struct.unpack_from('<QQIIII', data, s + 32)
            if (segname, sectname) == (b'__TEXT', b'__text'):
                if nreloc:
                    sys.exit('__text has %d relocations' % nreloc)
                text = (section_index, addr, data[fileoff:fileoff + length])
    elif cmd == 0x2:
        symtab = struct.unpack_from('<IIII', data, offset + 8)
    offset += size
if text is None or symtab is None:
    sys.exit('no __text section or symbol table')
symoff, nsyms, stroff, _ = symtab
offsets = {}
for i in range(nsyms):
    strx, ntype, nsect, _, value = struct.unpack_from('<IBBHQ', data, symoff + 16 * i)
    name = data[stroff + strx:data.index(b'\0', stroff + strx)].decode()
    if nsect == text[0]:
        offsets[name.removeprefix('_')] = value - text[1]
missing = [s for s in sys.argv[3:] if s not in offsets]
if missing:
    sys.exit('symbols not found in __text: ' + ' '.join(missing))
open(sys.argv[2], 'wb').write(text[2])
print(' '.join(str(offsets[s]) for s in sys.argv[3:]))
