import sys
sys.dont_write_bytecode = True

import argparse
import importlib.util
import inspect
import tempfile
import json
import os
from pathlib import Path
import platform
import re
import runpy
import shlex
import shutil
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SHARE = ROOT / 'share/nxnative'
CONTAINERS = {'.nsp', '.nsz', '.xci', '.xcz'}

REQUIRED_SOURCE_FILES = (
    'scripts/build_ipa_from_nsp.py', 'dm/games/game.py',
    'dm/tools/nso2elf.py', 'dm/tools/nso.py', 'dm/tools/patch_nso.py', 'dm/tools/nacp.py', 'dm/tools/make_ext_font.py',
    'dm/tools/nx_extract/Program.cs', 'dm/tools/nx_extract/nx_extract.csproj',
    'dm/gfx/tools/dmsh_chain.py', 'dm/gfx/tools/dmsh_build.py', 'dm/gfx/tools/own_compilers.py',
    'dm/gfx/tools/dmsh_xlate/Program.cs', 'dm/gfx/tools/dmsh_xlate/dmsh_xlate.csproj', 'dm/ios/tools/ios_metal.py',
)
SOURCE_DIRECTORIES = ('scripts', 'dm/games', 'dm/tools', 'dm/gfx/tools', 'dm/ios/tools', 'dm/host')


def source_snapshot():
    config = json.loads((ROOT / 'runtime.json').read_text())
    if not config.get('sourceRequirement'):
        return {'root': SHARE, 'revision': config.get('sourceRevision', config.get('nativeSourceRevision', 'bundled')), 'kind': 'bundled'}
    value, revision = (os.environ.get(name, '') for name in ('NXNATIVE_SOURCE_ROOT', 'NXNATIVE_SOURCE_REVISION'))
    if not Path(value).is_absolute() or not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', revision):
        raise ValueError('Select an installed upstream nxnative source version in Runtimes.')
    root = Path(value).resolve(strict=True)
    for relative in REQUIRED_SOURCE_FILES:
        if not (root / relative).is_file(): raise ValueError('The selected nxnative source is missing ' + relative)
    for relative in SOURCE_DIRECTORIES:
        if not (root / relative).is_dir(): raise ValueError('The selected nxnative source is missing ' + relative)
    return {'root': root, 'revision': revision, 'kind': 'github-commit' if len(revision) == 40 else 'local-source',
            'committedAt': os.environ.get('NXNATIVE_SOURCE_COMMITTED_AT') or None if len(revision) == 40 else None}


def materialize_source(snapshot, repo, env):
    if repo.exists(): return
    config = json.loads((ROOT / 'runtime.json').read_text())
    if snapshot['kind'] == 'bundled':
        shutil.copytree(snapshot['root'], repo, copy_function=copy_file)
        return
    repo.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='source-', dir=repo.parent) as temporary:
        temporary = Path(temporary)
        for relative in SOURCE_DIRECTORIES:
            shutil.copytree(snapshot['root'] / relative, temporary / relative, copy_function=copy_file,
                            ignore=shutil.ignore_patterns('__pycache__', 'tests', 'fixtures', 'dmsh_xlate_bin'))
        chain = runpy.run_path(str(temporary / 'dm/gfx/tools/dmsh_chain.py'))
        for relative in chain['FILES']:
            target = (temporary / 'dm/gfx' / relative).resolve()
            source = (snapshot['root'] / 'dm/gfx' / relative).resolve()
            target.relative_to(temporary)
            source.relative_to(snapshot['root'])
            if not target.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                copy_file(source, target)
        translator = ROOT / Path(config['runtimeFiles']['shaderTranslator']).parent
        shutil.copytree(translator, temporary / 'dm/gfx/tools/dmsh_xlate_bin', copy_function=copy_file)
        toolchain = json.loads((ROOT / config['runtimeFiles']['shaderToolchain']).read_text())
        (temporary / 'dm/gfx/tools/dmsh_chain.lock').write_text(toolchain['lock'])
        (temporary / 'dm/gfx/nvn').mkdir(parents=True, exist_ok=True)
        result = subprocess.run([sys.executable, '-I', '-B', str(temporary / 'dm/gfx/tools/dmsh_chain.py'), '--header'], env=env, capture_output=True, text=True)
        if result.returncode:
            raise ValueError('The selected source cannot describe its shader chain: ' + (result.stderr or result.stdout).strip()[-1000:])
        header = (temporary / 'dm/gfx/nvn/dmsh_chain.h').read_text()
        if not re.search(r'#define DMSH_CHAIN "' + re.escape(toolchain['shaderChain']) + r'"', header):
            raise ValueError('The selected upstream source has a different shader format. Matching native tools are required.')
        os.rename(temporary, repo)


def validate_pipeline(pipeline):
    for name in ('cli', 'find_repo', 'check_prereqs', 'build_nx_extract', 'build_mac_host', 'toolchain', 'mac_run'):
        if not callable(getattr(pipeline, name, None)):
            raise ValueError('The selected upstream source requires a newer adapter: ' + name)
    if not {'work', 'game', 'patched', 'msl', 'gfx', 'lang', 'g'}.issubset(inspect.signature(pipeline.mac_run).parameters):
        raise ValueError('The selected upstream source uses an unsupported native launch interface.')
    if not {'repo', 'out', 'env', 'logs', 'g'}.issubset(inspect.signature(pipeline.build_mac_host).parameters):
        raise ValueError('The selected upstream source uses an unsupported native host interface.')



def event(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def environment():
    env = dict(os.environ)
    env['PATH'] = os.pathsep.join([str(ROOT / 'bin'), str(Path(sys.executable).parent), str(ROOT / 'dotnet'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    env['SPIRV_CROSS'] = str(ROOT / 'bin/spirv-cross')
    env['DOTNET_ROOT'] = str(ROOT / 'dotnet')
    env['DOTNET_ROOT_ARM64'] = str(ROOT / 'dotnet')
    env['DOTNET_MULTILEVEL_LOOKUP'] = '0'
    env['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1'
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env.setdefault('J', str(os.cpu_count() or 8))
    return env


def pfs_metadata(file):
    with file.open('rb') as stream:
        header = stream.read(16)
        if len(header) != 16 or header[:4] != b'PFS0': raise ValueError('Invalid PFS0 header.')
        count, size = struct.unpack_from('<II', header, 4)
        if count > 65536 or size > 8 * 1024 * 1024: raise ValueError('PFS0 directory exceeds its metadata limit.')
        table = stream.read(count * 24)
        names = stream.read(size)
        if len(table) != count * 24 or len(names) != size: raise ValueError('Truncated PFS0 directory.')
        data_offset = 16 + count * 24 + size
        files, encrypted = [], False
        for i in range(count):
            offset, length, start = struct.unpack_from('<QQI', table, i * 24)
            if start >= len(names): raise ValueError('Invalid PFS0 filename.')
            end = names.find(b'\0', start)
            if end < 0 or data_offset + offset + length > file.stat().st_size: raise ValueError('Invalid PFS0 member.')
            name = names[start:end].decode('utf-8', errors='replace')
            files.append({'name':name, 'bytes':length})
            if name.lower().endswith('.nca'):
                stream.seek(data_offset + offset + 0x200)
                if stream.read(4) not in (b'NCA0', b'NCA2', b'NCA3'): encrypted = True
        title = next((item['name'][:16].upper() for item in files if re.fullmatch(r'[0-9a-fA-F]{32}\.tik', item['name'])), None)
        return {'format':'nsz' if file.suffix.lower() == '.nsz' else 'nsp', 'titleId':title, 'encrypted':encrypted, 'files':files}


def inspect_input(value):
    file = Path(value).expanduser().resolve()
    if file.is_dir():
        launch = file / 'launch.json'
        if launch.is_file():
            metadata = json.loads(launch.read_text())
            return {'schemaVersion':1, 'format':'prepared', 'launchFile':str(launch), 'titleId':metadata.get('titleId')}
        if (file / 'ExeFS/main').is_file() and (file / 'RomFS').is_dir(): return {'schemaVersion':1,'format':'extracted','encrypted':False}
        files = sorted(p for p in file.iterdir() if p.is_file() and p.suffix.lower() in CONTAINERS)
        if not files: raise ValueError('No Switch application container was found.')
        if len(files) > 4096: raise ValueError('The application folder has too many containers.')
        rows = [inspect_input(p) for p in files]
        titles = list(dict.fromkeys(row.get('titleId') for row in rows if row.get('titleId')))
        return {'schemaVersion':1,'format':'switch-folder','titleId':titles[0] if titles else None,'encrypted':any(row.get('encrypted') for row in rows),'files':[p.name for p in files]}
    with file.open('rb') as stream: header = stream.read(0x400)
    result = {'schemaVersion':1, 'bytes':file.stat().st_size}
    if header[:4] == b'PFS0': result.update(pfs_metadata(file))
    elif header[0x100:0x104] == b'HEAD': result.update(format='xcz' if file.suffix.lower() == '.xcz' else 'xci', encrypted=True)
    elif header[:4] == b'NSO0':
        if len(header) < 0x70: raise ValueError('Truncated NSO header.')
        result.update(format='nso', architecture='arm64', buildId=header[0x40:0x60].hex(), encrypted=False)
    elif header[0x10:0x14] == b'NRO0': result.update(format='nro', architecture='arm64', encrypted=False)
    elif header[:4] == b'HFS0': result.update(format='hfs0', encrypted=True)
    else: raise ValueError('The file is not a supported Switch application format.')
    if not result.get('titleId'):
        match = re.search(r'\[([0-9A-Fa-f]{16})\]', file.name)
        if match: result['titleId'] = match.group(1).upper()
    return result


def game_module(value):
    file = Path(value).expanduser().resolve()
    if file.is_dir() and (file / 'launch.json').is_file():
        launch = json.loads((file / 'launch.json').read_text())
        file = Path(launch['env']['DM_ROMFS']).parent / 'ExeFS/main'
    elif file.is_dir():
        file = file / 'ExeFS/main' if (file / 'ExeFS/main').is_file() else file / 'main'
    if inspect_input(file)['format'] != 'nso': raise ValueError('ELF export requires an NSO application module.')
    return file


def export_elf(value, output):
    source = game_module(value); output = Path(output).expanduser().resolve()
    if source == output: raise ValueError('ELF export must use another file.')
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run([sys.executable, '-I', '-B', str(source_snapshot()['root'] / 'dm/tools/nso2elf.py'), str(source), str(output)], env=environment(), capture_output=True, text=True)
    if result.returncode: raise ValueError((result.stderr or result.stdout).strip())
    with output.open('rb') as stream: header = stream.read(20)
    if header[:4] != b'\x7fELF' or struct.unpack_from('<H', header, 18)[0] != 183: raise ValueError('NSO conversion did not produce an ARM64 ELF.')
    return str(output)


def copy_file(source, target):
    shutil.copy2(source, target)
    return target


def prepare(args):
    if platform.machine() != 'arm64': raise ValueError('nxnative requires an Apple Silicon Mac.')
    source = Path(args.input).expanduser().resolve(); output = Path(args.output).expanduser().resolve()
    if source == output or source.is_dir() and output.is_relative_to(source): raise ValueError('Preparation output must be outside the original game folder.')
    metadata = inspect_input(source)
    if not args.keys and metadata.get('encrypted'):
        event(ev='error',code='keys-required',message='This package requires a prod.keys file.'); return 78
    if metadata['format'] in ('nso', 'nro', 'hfs0', 'prepared', 'extracted'): raise ValueError('Preparation requires an NSP, XCI, NSZ or XCZ application container.')
    tools = json.loads((ROOT / 'runtime.json').read_text())
    if tools.get('requirements', {}).get('metalCompiler', {}).get('required'):
        compiler = subprocess.run([str(ROOT / 'bin/xcrun'), '--check-native-metal'], capture_output=True, text=True)
        if compiler.returncode:
            raise ValueError((compiler.stderr or compiler.stdout).strip() or 'The Apple Metal compiler required by the selected source is unavailable.')
    output.mkdir(parents=True, exist_ok=True)
    inputs = output / 'inputs'; inputs.mkdir(exist_ok=True)
    originals = [source] if source.is_file() else sorted(p for p in source.iterdir() if p.is_file() and p.suffix.lower() in CONTAINERS)
    for original in originals:
        target = inputs / (original.stem + original.suffix.lower())
        if target.is_symlink():
            if target.resolve() == original: continue
            target.unlink()
        if target.exists(): raise ValueError('A preparation input already uses this filename.')
        target.symlink_to(original)
    keys = Path(args.keys).expanduser().resolve() if args.keys else output / 'empty.keys'
    if not args.keys:
        keys.write_text(''); keys.chmod(0o600)
    if not keys.is_file(): raise ValueError('The selected keys file is unavailable.')
    identity = tools['version']
    snapshot = source_snapshot()
    repo = output / 'pipeline' / identity / snapshot['revision']
    env = environment(); os.environ.update(env)
    materialize_source(snapshot, repo, env)
    spec = importlib.util.spec_from_file_location('nxnative_pipeline', repo / 'scripts/build_ipa_from_nsp.py')
    pipeline = importlib.util.module_from_spec(spec); spec.loader.exec_module(pipeline)
    validate_pipeline(pipeline)
    pipeline.find_repo = lambda _: repo
    pipeline.TOOL_PATHS = []
    pipeline.apple_silicon = lambda: platform.machine() == 'arm64'
    def check_prereqs(_env, xlate, mac=False):
        if not mac: raise ValueError('This runtime prepares macOS applications.')
        for name in ('lz4.block', 'capstone', 'fontTools', 'backports.zstd'): __import__(name)
        for name in ('xcrun', 'spirv-cross', 'zstd', 'dotnet'):
            if not shutil.which(name, path=_env['PATH']): raise ValueError('The runtime tool is unavailable: ' + name)
        if not xlate.is_file(): raise ValueError('The runtime shader translator is unavailable.')
    pipeline.check_prereqs = check_prereqs
    pipeline.build_nx_extract = lambda *_args, **_kwargs: ROOT / 'tools/nx_extract/nx_extract'
    pipeline.toolchain = lambda *_args, **_kwargs: (('cmd',['xcrun','-sdk','macosx','metal','--version']),('cmd',['spirv-cross','--revision']))
    host = ROOT / 'bin/nxnative-host'

    def prepare_host(_repo, destination, host_env, _logs, game):
        host_env['NXNATIVE_PROFILE'] = str(game.table('game.tsv'))
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.is_file() or destination.stat().st_size != host.stat().st_size: shutil.copy2(host, destination)
        return destination
    pipeline.build_mac_host = prepare_host
    original_run = pipeline.mac_run
    launched = {}

    def mac_run(*values, **keywords):
        bound = inspect.signature(original_run).bind(*values, **keywords)
        profile = bound.arguments['g']
        command = original_run(*values, **keywords)
        words = shlex.split(command); index = words.index('&&') + 1; values = {}
        while index < len(words) and re.match(r'^[A-Za-z_][A-Za-z_0-9]*=', words[index]):
            key, value = words[index].split('=',1); values[key] = value; index += 1
        run = output / 'run'; (run / 'save').mkdir(parents=True, exist_ok=True); (run / 'temp').mkdir(exist_ok=True)
        values.update(NXNATIVE_PROFILE=str(profile.table('game.tsv')), DM_SAVE=str(run / 'save'), DM_TEMP=str(run / 'temp'))
        launched.update(schemaVersion=1,titleId=profile.id,sourceRevision=snapshot['revision'],sourceKind=snapshot['kind'],sourceCommittedAt=snapshot.get('committedAt'),nativeToolsVersion=identity,nativeSourceRevision=tools.get('nativeSourceRevision'),nativeSourceCommittedAt=tools.get('nativeSourceCommittedAt'),command=str(host),args=words[index + 1:],cwd=str(run),env=values)
        (output / 'launch.json').write_text(json.dumps(launched,ensure_ascii=False,indent=2)+'\n')
        return command
    pipeline.mac_run = mac_run
    argv = [str(inputs), '--keys', str(keys), '--platform', 'mac', '--progress', args.progress]
    if args.language: argv += ['--language', args.language]
    status = pipeline.cli(argv)
    if status: return status
    if not launched: raise ValueError('Preparation finished without a launch description.')
    event(ev='prepared',launchFile=str(output / 'launch.json'),titleId=launched['titleId'])
    return 0


def main():
    parser = argparse.ArgumentParser(prog='nxnative')
    parser.add_argument('--version',action='store_true')
    actions = parser.add_subparsers(dest='action')
    inspect = actions.add_parser('inspect'); inspect.add_argument('--input',required=True); inspect.add_argument('--export-elf')
    prep = actions.add_parser('prepare'); prep.add_argument('--input',required=True); prep.add_argument('--output',required=True); prep.add_argument('--keys'); prep.add_argument('--language'); prep.add_argument('--progress',choices=('json','lines','off'),default='json')
    run = actions.add_parser('run'); run.add_argument('--prepared',required=True)
    args = parser.parse_args()
    if args.version:
        print(json.loads((ROOT / 'runtime.json').read_text())['version']); return 0
    if args.action == 'inspect':
        result = inspect_input(args.input)
        if args.export_elf: result['elfPath'] = export_elf(args.input,args.export_elf)
        event(**result); return 0
    if args.action == 'prepare': return prepare(args)
    if args.action == 'run':
        value = json.loads((Path(args.prepared).expanduser().resolve() / 'launch.json').read_text())
        host = ROOT / 'bin/nxnative-host'
        if Path(value['command']).resolve() != host.resolve(): raise ValueError('The prepared host belongs to another runtime.')
        env = environment(); env.update(value['env']); os.chdir(value['cwd']); os.execve(str(host),[str(host),*value['args']],env)
    parser.print_help(); return 0


if __name__ == '__main__':
    try: sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        event(ev='error',code='preparation-failed',message=str(error)); sys.exit(1)
