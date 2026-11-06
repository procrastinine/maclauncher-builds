"""Offline metadata for nxnative's decrypted input routes. No content is acquired."""
from pathlib import Path
import runpy
import struct
import sys

MAX_TABLE = 16 * 1024 * 1024


def inspect_keyless(source, upstream):
    source, upstream = Path(source), Path(upstream)
    scripts = upstream / 'scripts'
    sys.path.insert(0, str(scripts))
    try:
        nups = [source] if source.is_file() else sorted(p for p in source.iterdir() if p.is_file() and p.suffix.lower() == '.nup')
        containers = [] if source.is_file() else [p for p in source.iterdir() if p.is_file() and p.suffix.lower() in {'.nsp', '.xci', '.nsz', '.xcz'}]
        if not nups and (source.is_file() or not any((source / p).exists() for p in ('base/exefs/main.npdm', 'exefs/main.npdm', 'updates'))): return None
        if not (scripts / 'pack_dump.py').is_file(): raise ValueError('Select an nxnative source with decrypted dump support.')
        dump = runpy.run_path(str(scripts / 'pack_dump.py'))
        is_dump = source.is_dir() and dump['is_dump'](source)
        if containers and (nups or is_dump) or is_dump and nups or len(nups) > 1:
            raise ValueError('Choose one NUP or a decrypted dump without other game inputs beside it.')
        if nups:
            file = nups[0]
            with file.open('rb') as stream:
                header = stream.read(128)
                if len(header) != 128 or header[:4] != b'NUP\x01': raise ValueError('Invalid NUP header.')
                toc, length = struct.unpack_from('<QQ', header, 8)
                if length < 48 or length > MAX_TABLE or toc > file.stat().st_size or length > file.stat().st_size - toc:
                    raise ValueError('NUP table exceeds its metadata limit.')
            module = runpy.run_path(str(scripts / 'pack_nup.py'))
            with module['Nup'](file) as n:
                if len(n.packages) > 4096 or n.ndirs + len(n.files) > 100000: raise ValueError('Too many NUP records.')
                for package in n.packages:
                    if package.meta_size > MAX_TABLE: raise ValueError('NUP control metadata exceeds its limit.')
                for name, size, *_ in n.files:
                    if name == b'main.npdm' and (size < 128 or size > 1024 * 1024): raise ValueError('Invalid NUP NPDM size.')
                for name, _, _ in n.dirs:
                    if len(name) > 4096 or name in (b'.', b'..') or b'/' in name or b'\\' in name or b'\0' in name: raise ValueError('Unsafe NUP directory.')
                for name, *_ in n.files:
                    if len(name) > 4096 or not name or name in (b'.', b'..') or b'/' in name or b'\\' in name or b'\0' in name: raise ValueError('Unsafe NUP file.')
                visiting, done = set(), set()
                def visit(index, depth):
                    if depth > 64 or index in visiting: raise ValueError('NUP directory cycle or depth limit.')
                    if index in done: return
                    visiting.add(index)
                    names = set()
                    for name, directory, child in n.children(index):
                        if name in names: raise ValueError('Duplicate NUP child.')
                        names.add(name)
                        if directory: visit(child, depth + 1)
                    visiting.remove(index)
                    done.add(index)
                for index in range(n.ndirs): visit(index, 0)
                title, base, updates, _ = module['scan'](n)
                versions = ([0] if base and base.romfs != module['NO_DIR'] else []) + list(updates)
            return facts('nup', title, versions)
        if not is_dump: return None
        root = source.resolve()
        count = 0
        def walk(folder, depth, ancestors):
            nonlocal count
            actual = folder.resolve()
            if not actual.is_relative_to(root) or actual in ancestors or depth > 64: raise ValueError('Unsafe Switch dump path.')
            for item in folder.iterdir():
                count += 1
                if count > 500000: raise ValueError('Too many dump files.')
                if not item.resolve().is_relative_to(root): raise ValueError('Switch dump path escapes its folder.')
                if item.name == 'main.npdm' and item.parent.name == 'exefs' and not 128 <= item.stat().st_size <= 1024 * 1024: raise ValueError('Invalid dump NPDM size.')
                if item.is_dir(): walk(item, depth + 1, ancestors | {actual})
                elif not item.is_file(): raise ValueError('Switch dump contains a special file.')
        walk(source, 0, set())
        title, updates, _ = dump['scan'](source)
        base = dump['base_of'](source)
        versions = ([0] if base and (base / 'romfs').is_dir() else []) + list(updates)
        for version in updates.values():
            if not dump['is_version'](version) or dump['program_id'](version / 'exefs/main.npdm') != title:
                raise ValueError('Update needs matching ExeFS and full RomFS.')
        return facts('dump', title, versions)
    except Exception as error:
        raise ValueError(str(error)) from error
    finally:
        sys.path.remove(str(scripts))


def facts(format, title, versions):
    return {'format': format, 'titleId': f'{title:016X}', 'versions': [f'v{v}' for v in sorted(versions)],
            'selectedUpdate': f'v{max(versions)}', 'keyRequirement': 'none', 'generation': None, 'encrypted': False}


def generation(extracted, profile_guess):
    """Use the selected upstream's SDK facts, independent of game profiles."""
    try:
        facts = profile_guess.facts_of(Path(extracted) / 'ExeFS', Path(extracted) / 'romfs_manifest.tsv')
        return 2 if facts.get('ounce') is True else None
    except Exception:
        return None  # Metadata is unknown when the selected source cannot inspect the SDK.
