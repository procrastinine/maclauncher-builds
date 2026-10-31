//! Packaging materializer for the original image decoder. Android ownership and
//! labels travel as data; no host-specific extended-attribute API is called.
pub use android_image_extract::tree::{Node, Report, Tree, S_IFDIR, S_IFLNK, S_IFREG};
use android_image_extract::{invalid, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::os::unix::{ffi::OsStrExt, fs::{symlink, PermissionsExt}};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataChunk { pub data:String, pub size:u64, pub sha256:String }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Record {
    pub path: Vec<u8>,
    pub kind: String,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub label: Option<Vec<u8>>,
    pub link: Option<Vec<u8>>,
    pub data: Option<String>,
    pub size: u64,
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if="Vec::is_empty")]
    pub chunks: Vec<DataChunk>,
}
#[derive(Default)]
pub struct Materializer {
    root: Option<PathBuf>,
    records: BTreeMap<Vec<u8>, Record>,
    total: Report,
}
pub fn metadata_path(root: &Path) -> PathBuf {
    let mut name=root.file_name().unwrap().to_os_string();name.push(".metadata.json");root.with_file_name(name)
}
impl Materializer {
    fn record(&mut self, path: &Path, node: Node, kind: &str, label: Option<Vec<u8>>, link: Option<Vec<u8>>) -> Result<()> {
        let relative=path.strip_prefix(self.root.as_ref().unwrap())?.as_os_str().as_bytes().to_vec();
        self.records.insert(relative.clone(),Record{path:relative,kind:kind.into(),mode:node.mode,uid:node.uid,gid:node.gid,label,link,data:None,size:node.size,sha256:None,chunks:Vec::new()});Ok(())
    }
    pub fn extract(&mut self, tree: &dyn Tree, destination: &Path) -> Result<Report> {
        if self.root.is_none(){self.root=Some(destination.to_owned());}
        let root=tree.root();let node=tree.node(root)?;
        if node.kind()!=S_IFDIR{return Err(invalid("filesystem root is not a directory"));}
        match fs::symlink_metadata(destination){
            Ok(stat) if stat.is_dir()&&!stat.is_symlink()&&fs::read_dir(destination)?.next().is_none()=>{},
            Ok(_)=>return Err(invalid("image mount point is not an empty real directory")),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>fs::create_dir(destination)?,
            Err(error)=>return Err(error.into()),
        }
        fs::set_permissions(destination,fs::Permissions::from_mode(0o700))?;
        self.record(destination,node,"directory",tree.label(root)?,None)?;
        let mut report=Report::default();report.directories=1;
        self.walk(tree,root,destination,&mut HashMap::new(),&mut report,0)?;
        self.total.merge(report.clone());Ok(report)
    }
    fn walk(&mut self,tree:&dyn Tree,id:u64,directory:&Path,links:&mut HashMap<u64,PathBuf>,report:&mut Report,depth:usize)->Result<()> {
        if depth>128{return Err(invalid("directory nesting is too deep"));}
        let mut children=tree.children(id)?;children.sort();
        for(name,id)in children{
            if name.is_empty()||name==b"."||name==b".."||name.contains(&b'/')||name.contains(&0){return Err(invalid("invalid image entry name"));}
            let path=directory.join(std::ffi::OsStr::from_bytes(&name));let node=tree.node(id)?;
            match node.kind(){
                S_IFDIR=>{fs::create_dir(&path)?;fs::set_permissions(&path,fs::Permissions::from_mode(0o700))?;self.record(&path,node,"directory",tree.label(id)?,None)?;report.directories+=1;self.walk(tree,id,&path,links,report,depth+1)?;},
                S_IFREG=>{
                    if let Some(first)=links.get(&id).filter(|_|node.nlink>1){
                        fs::hard_link(first,&path)?;
                        self.record(&path,node,"hardlink",tree.label(id)?,Some(first.strip_prefix(self.root.as_ref().unwrap())?.as_os_str().as_bytes().to_vec()))?;report.hardlinks+=1;
                    }else{
                        let file=OpenOptions::new().write(true).create_new(true).open(&path)?;let mut writer=BufWriter::with_capacity(1<<20,file);
                        let count=tree.copy_file(id,&mut writer)?;writer.flush()?;
                        if count!=node.size{return Err(invalid("image file size mismatch"));}
                        self.record(&path,node,"file",tree.label(id)?,None)?;
                        if node.nlink>1{links.insert(id,path.clone());}report.files+=1;report.bytes+=count;
                    }
                },
                S_IFLNK=>{
                    let target=tree.read_link(id)?;if target.is_empty()||target.contains(&0){return Err(invalid("invalid image symlink"));}
                    symlink(std::ffi::OsStr::from_bytes(&target),&path)?;self.record(&path,node,"symlink",tree.label(id)?,Some(target))?;report.symlinks+=1;
                },
                _=>report.special.push((path,node.mode)),
            }
        }Ok(())
    }
    pub fn finish(self)->Result<Report>{
        let root=self.root.as_ref().ok_or_else(||invalid("archive has no extracted filesystem"))?;
        for row in self.records.values(){if row.kind=="file"{fs::set_permissions(root.join(std::ffi::OsStr::from_bytes(&row.path)),fs::Permissions::from_mode(row.mode&0o777))?;}}
        let mut directories=self.records.values().filter(|row|row.kind=="directory").collect::<Vec<_>>();directories.sort_by_key(|row|std::cmp::Reverse(row.path.len()));
        for row in directories{fs::set_permissions(root.join(std::ffi::OsStr::from_bytes(&row.path)),fs::Permissions::from_mode(row.mode&0o777))?;}
        let mut output=BufWriter::new(File::create_new(metadata_path(root))?);
        serde_json::to_writer(&mut output,&self.records.values().collect::<Vec<_>>())?;output.flush()?;
        Ok(self.total)
    }
}
