//! Build-time Android image transport. The original partition/APEX decoder is
//! compiled unchanged; only its filesystem materializer is supplied here.
pub use android_image_extract::{apex, cpio, erofs, ext4, gpt, invalid, le32, lp, lz4, source, zip, Result};
#[path = "upstream/tools/android-image-extract/src/image.rs"]
mod image;
mod tree;
use tree::Record;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::os::unix::{ffi::OsStrExt, fs::{MetadataExt, PermissionsExt}};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct Transport { schema_version:u32, archive_sha256:String, source_revision:String, records:Vec<Record> }
fn hex(bytes:impl AsRef<[u8]>)->String{bytes.as_ref().iter().map(|byte|format!("{byte:02x}")).collect()}
fn digest(path:&Path)->Result<String>{let mut hash=Sha256::new();std::io::copy(&mut File::open(path)?,&mut hash)?;Ok(hex(hash.finalize()))}
fn named(root:&Path,name:&[u8])->Result<PathBuf>{
 if name.contains(&0)||name.starts_with(b"/")||(!name.is_empty()&&name.split(|byte|*byte==b'/').any(|part|part.is_empty()||part==b"."||part==b"..")){return Err(invalid("invalid image transport path"));}
 Ok(root.join(std::ffi::OsStr::from_bytes(name)))
}
fn identity(root:&Path)->Result<serde_json::Value>{
 fn walk(root:&Path,relative:&Path,hash:&mut Sha256,records:&mut u64,bytes:&mut u64)->Result<()>{
  let file=root.join(relative);let stat=fs::symlink_metadata(&file)?;let name=relative.to_str().ok_or_else(||invalid("image identity path is not UTF-8"))?;let mode=stat.mode()&0o7777;
  let row=if stat.is_symlink(){serde_json::json!([name,"link",mode,fs::read_link(&file)?.to_str().ok_or_else(||invalid("symlink is not UTF-8"))?])}
  else if stat.is_dir(){serde_json::json!([name,"directory",mode])}
  else if stat.is_file(){*bytes+=stat.len();serde_json::json!([name,"file",mode,stat.len(),digest(&file)?])}
  else{return Err(invalid("unexpected image object"));};
  hash.update(serde_json::to_vec(&row)?);hash.update(b"\n");*records+=1;
  if stat.is_dir(){let mut names=fs::read_dir(file)?.map(|entry|entry.map(|entry|entry.file_name())).collect::<std::io::Result<Vec<_>>>()?;names.sort();for name in names{walk(root,&relative.join(name),hash,records,bytes)?;}}Ok(())
 }
 let mut hash=Sha256::new();let(mut records,mut bytes)=(0,0);walk(root,Path::new(""),&mut hash,&mut records,&mut bytes)?;
 Ok(serde_json::json!({"sha256":hex(hash.finalize()),"records":records,"bytes":bytes}))
}
fn export(archive:&Path,root:&Path,payload:&Path)->Result<()>{
 if payload.exists(){return Err(invalid("image transport output already exists"));}
 let lines=image::extract(archive,root)?;image::print(&lines,&mut std::io::stdout().lock())?;
 let(archive_sha256,identity_file)=image::record_identity(archive,root)?;
 let mut records:Vec<Record>=serde_json::from_reader(File::open(tree::metadata_path(root))?)?;
 let content=identity(root)?;println!("content {content}");
 let data=payload.join("data");fs::create_dir_all(&data)?;
 // All directory modes are restored from the sidecar on macOS. Make the
 // temporary Linux tree writable before moving its regular data objects.
 let mut directories=records.iter().filter(|row|row.kind=="directory").collect::<Vec<_>>();directories.sort_by_key(|row|row.path.len());
 for row in directories{fs::set_permissions(named(root,&row.path)?,fs::Permissions::from_mode(0o700))?;}
 for(index,row)in records.iter_mut().enumerate(){if row.kind=="file"{
  let file=named(root,&row.path)?;row.sha256=Some(digest(&file)?);row.size=fs::metadata(&file)?.len();let name=format!("{index:08}");
  fs::rename(file,data.join(&name))?;fs::set_permissions(data.join(&name),fs::Permissions::from_mode(0o644))?;row.data=Some(name);
 }}
 let manifest=Transport{schema_version:1,archive_sha256,source_revision:"9b5068fa8185d3f51f1862fe7c54d88d51f09ec8".into(),records};
 serde_json::to_writer(File::create_new(payload.join("image-data.json"))?,&manifest)?;
 serde_json::to_writer(File::create_new(payload.join("content.json"))?,&content)?;
 fs::remove_dir_all(root)?;fs::remove_file(tree::metadata_path(root))?;fs::remove_file(identity_file)?;Ok(())
}
#[cfg(target_os="macos")]
fn restore(payload:&Path,root:&Path)->Result<()>{
 use android_image_extract::inode_metadata::{write_new, AndroidInodeMetadata};
 use std::os::fd::AsRawFd;
 use std::os::unix::fs::symlink;
 use std::ffi::{c_int,c_char,c_void,CString};
 unsafe extern "C"{fn lchmod(path:*const c_char,mode:u16)->c_int;fn fsetxattr(fd:c_int,name:*const c_char,value:*const c_void,size:usize,position:u32,options:c_int)->c_int;fn setxattr(path:*const c_char,name:*const c_char,value:*const c_void,size:usize,position:u32,options:c_int)->c_int;}
 fn label(file:&File,value:&[u8])->Result<()>{if unsafe{fsetxattr(file.as_raw_fd(),c"dev.aim.xattr.security.selinux".as_ptr(),value.as_ptr().cast(),value.len(),0,2)}!=0{return Err(std::io::Error::last_os_error().into());}Ok(())}
 let transport:Transport=serde_json::from_reader(File::open(payload.join("image-data.json"))?)?;
 if transport.schema_version!=1||transport.source_revision!="9b5068fa8185d3f51f1862fe7c54d88d51f09ec8"{return Err(invalid("unsupported Android image transport"));}
 if root.exists(){return Err(invalid("image restore root already exists"));}
 let mut paths=std::collections::BTreeSet::new();
 for row in &transport.records{named(root,&row.path)?;if !paths.insert(row.path.clone()){return Err(invalid("duplicate image transport path"));}}
 let mut directories=transport.records.iter().filter(|row|row.kind=="directory").collect::<Vec<_>>();directories.sort_by_key(|row|row.path.len());
 for row in &directories{let file=named(root,&row.path)?;fs::create_dir(file)?;}
 for row in transport.records.iter().filter(|row|row.kind=="file"){
  let name=row.data.as_ref().ok_or_else(||invalid("missing image data object"))?;
  if name.len()!=8||!name.bytes().all(|byte|byte.is_ascii_digit()){return Err(invalid("invalid image data object name"));}
  let output=named(root,&row.path)?;
  if row.chunks.is_empty(){
   let data=payload.join("data").join(name);if fs::metadata(&data)?.len()!=row.size||Some(digest(&data)?)!=row.sha256{return Err(invalid("image data object checksum differs"));}fs::copy(data,&output)?;
  }else{
   let mut destination=File::create_new(&output)?;let mut size=0u64;
   for(index,chunk)in row.chunks.iter().enumerate(){
    if chunk.data!=format!("{name}-{index:04}")||chunk.size>128*1024*1024{return Err(invalid("invalid image data chunk"));}
    let input=payload.join("data").join(&chunk.data);if fs::metadata(&input)?.len()!=chunk.size||digest(&input)?!=chunk.sha256{return Err(invalid("image data chunk checksum differs"));}
    size+=std::io::copy(&mut File::open(input)?,&mut destination)?;
   }
   if size!=row.size||Some(digest(&output)?)!=row.sha256{return Err(invalid("restored image data checksum differs"));}
  }
  let file=File::open(&output)?;
  write_new(&file,AndroidInodeMetadata{uid:row.uid,gid:row.gid,mode:row.mode})?;if let Some(value)=&row.label{label(&file,value)?;}
  fs::set_permissions(&output,fs::Permissions::from_mode(row.mode&0o777))?;
 }
 for row in transport.records.iter().filter(|row|row.kind=="hardlink"){
  let link=row.link.as_ref().ok_or_else(||invalid("missing hardlink source"))?;
  let original=transport.records.iter().find(|candidate|candidate.path==*link&&candidate.kind=="file").ok_or_else(||invalid("invalid hardlink source"))?;
  if(row.mode,row.uid,row.gid,&row.label)!=(original.mode,original.uid,original.gid,&original.label){return Err(invalid("hardlink metadata differs"));}
  fs::hard_link(named(root,link)?,named(root,&row.path)?)?;
 }
 for row in transport.records.iter().filter(|row|row.kind=="symlink"){
  let target=row.link.as_ref().ok_or_else(||invalid("missing symlink target"))?;
  if target.is_empty()||target.contains(&0){return Err(invalid("invalid symlink target"));}
  let file=named(root,&row.path)?;symlink(std::ffi::OsStr::from_bytes(target),&file)?;
  // The selected original Mac image creates symlinks with mode0755. Linux
  // fixes symlink modes at0777; restoration keeps the original Mac identity.
  let name=CString::new(file.as_os_str().as_bytes())?;if unsafe{lchmod(name.as_ptr(),0o755)}!=0{return Err(std::io::Error::last_os_error().into());}
  if let Some(value)=&row.label{let name=CString::new(file.as_os_str().as_bytes())?;if unsafe{setxattr(name.as_ptr(),c"dev.aim.xattr.security.selinux".as_ptr(),value.as_ptr().cast(),value.len(),0,3)}!=0{return Err(std::io::Error::last_os_error().into());}}
 }
 directories.reverse();for row in directories{let path=named(root,&row.path)?;let file=File::open(&path)?;write_new(&file,AndroidInodeMetadata{uid:row.uid,gid:row.gid,mode:row.mode})?;if let Some(value)=&row.label{label(&file,value)?;}fs::set_permissions(path,fs::Permissions::from_mode(row.mode&0o777))?;}
 let got=identity(root)?;let expected:serde_json::Value=serde_json::from_reader(File::open(payload.join("content.json"))?)?;if got!=expected{return Err(invalid("restored Android image content differs"));}
 let mut name=root.file_name().unwrap().to_os_string();name.push(".identity");fs::write(root.with_file_name(name),transport.archive_sha256+"\n")?;println!("content {got}");Ok(())
}
fn main(){let args=std::env::args_os().skip(1).collect::<Vec<_>>();let result=match args.as_slice(){
 [command,archive,root,payload]if command=="export"=>export(Path::new(archive),Path::new(root),Path::new(payload)),
 #[cfg(target_os="macos")]
 [command,payload,root]if command=="restore"=>restore(Path::new(payload),Path::new(root)),
 _=>Err(invalid("Use export ARCHIVE ROOT PAYLOAD or restore PAYLOAD ROOT (macOS).")),
 };if let Err(error)=result{eprintln!("android-image-data: {error}");std::process::exit(1);}}
