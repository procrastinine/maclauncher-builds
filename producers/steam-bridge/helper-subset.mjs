// Copyright (c) MacLauncher contributors. MIT license.
// Keep the selected upstream client/discovery routines without command handlers.
export function helperClientSource(source, {upstreamHandshake=false}={}) {
 const marker='static void setup_steam_registry(void)';
 const end=source.indexOf(marker);
 if(end<0||source.indexOf(marker,end+1)>=0)throw Error('Pinned helper boundary changed');
 let selected=source.slice(0,end);
 const create='    CreateWindowW(class_nameW, steamW, WS_POPUP, 40, 40,\n                  400, 300, NULL, NULL, NULL, NULL);';
 if(!selected.includes(create))throw Error('Pinned discovery window boundary changed');
 // Readiness is local and unnamed; the window itself is the upstream window.
 selected=selected.replace(create,create.replace('    CreateWindowW','    HWND window = CreateWindowW')+'\n    if (!window) return GetLastError();\n    if (arg) SetEvent((HANDLE)arg);');
 if(upstreamHandshake){
  const start=source.indexOf('#ifndef DIRECTORY_QUERY'),end=source.indexOf('BOOL is_ptraced(void)',start);
  if(start<0||end<start)throw Error('Pinned launch handshake boundary changed');
  const compare=source.indexOf('int strncmpW('),compareEnd=source.indexOf('static WCHAR *find_quote(',compare);
  if(compare<0||compareEnd<compare)throw Error('Pinned wide-string comparison boundary changed');
  selected+='\n'+source.slice(compare,compareEnd)+source.slice(start,end);
 }
 selected=selected.replace('steamclient_module = LoadLibraryA("steamclient64.dll");','#ifdef _WIN64\n    steamclient_module = LoadLibraryA("steamclient64.dll");\n#else\n    steamclient_module = LoadLibraryA("steamclient.dll");\n#endif');
 return selected;
}
