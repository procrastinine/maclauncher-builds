import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {run} from './build-source.mjs';
import {buildInput} from './build-input.mjs';
const lockFile=path.join(import.meta.dirname,'python-build-tools.json');
const readLock=()=>JSON.parse(fs.readFileSync(lockFile,'utf8'));
const fileName=url=>decodeURIComponent(path.posix.basename(new URL(url).pathname));
/** The exact tool versions of one set in the Python build tool lock, by tool name in the set's order. */
export function pythonToolVersions(set){
 const lock=readLock();
 return Object.fromEntries(lock.sets[set].map(name=>[name,lock.wheels.find(row=>row.name===name).version]));
}
/** Install the locked Python interpreter for this host into work/python with uv, from its recorded archive and without a network read. */
export async function buildPython(work){
 const lock=readLock(),family={arm64:'aarch64',x64:'x86_64'}[process.arch],row=lock.interpreters.find(row=>row.platform===family+'-apple-darwin');
 if(process.platform!=='darwin'||!row)throw Error('The Python build tool lock has no interpreter for this host.');
 const archives=path.join(work,'python-archives'),archive=path.join(archives,fileName(row.url)),downloads=path.join(work,'python-downloads.json'),pythonRoot=path.join(work,'python');
 fs.mkdirSync(archives,{recursive:true});fs.copyFileSync(await buildInput(row),archive);
 const [major,minor,patch]=lock.python.split('.').map(Number),build=/^cpython-[^+]+\+(\d+)-/.exec(fileName(row.url))[1];
 // uv reads the interpreter's identity from this list instead of its built-in download list.
 fs.writeFileSync(downloads,JSON.stringify({[`cpython-${lock.python}-darwin-${family}-none`]:{name:'cpython',arch:{family,variant:null},os:'darwin',libc:'none',major,minor,patch,prerelease:'',url:pathToFileURL(archive).href,sha256:row.sha256,variant:null,build}}));
 const env={...process.env,UV_CACHE_DIR:path.join(work,'uv-cache'),UV_PYTHON_INSTALL_DIR:pythonRoot,UV_PYTHON_BIN_DIR:path.join(work,'python-bin'),UV_PYTHON_DOWNLOADS_JSON_URL:downloads};
 run('uv',['python','install','--offline',lock.python],{env});
 const python=execFileSync('uv',['python','find','--offline','--managed-python','--system',lock.python],{env,encoding:'utf8'}).trim();
 if(!fs.realpathSync(python).startsWith(fs.realpathSync(pythonRoot)+path.sep))throw Error('The selected Python interpreter is outside the declared build input directory.');
 return python;
}
/** A Python environment, by default in the work directory, on the locked interpreter and holding one tool set of the Python build tool lock.
 * Each wheel is an archive record the input step fetched; a tool can have one wheel per build platform, and
 * uv installs the compatible one without an index. */
export async function pythonBuildTools(work,set,environment=path.join(work,'tools')){
 const lock=readLock(),names=lock.sets[set];if(!names)throw Error('The Python build tool lock has no set '+set+'.');
 const python=path.join(environment,'bin/python'),wheels=path.join(work,'tool-wheels');
 if(!fs.existsSync(python))run('uv',['venv','--offline','--python',await buildPython(work),environment]);
 fs.mkdirSync(wheels,{recursive:true});
 for(const row of lock.wheels.filter(row=>names.includes(row.name)))fs.copyFileSync(await buildInput(row),path.join(wheels,fileName(row.url)));
 run('uv',['pip','install','--python',python,'--offline','--no-index','--find-links',wheels,'--no-deps',...Object.entries(pythonToolVersions(set)).map(([name,version])=>name+'=='+version)]);
 return {python,bin:path.join(environment,'bin')};
}
