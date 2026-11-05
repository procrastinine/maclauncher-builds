// Copyright (c) MacLauncher contributors. MIT license.
// Keep the selected upstream client/discovery routines without command handlers.
export function helperClientSource(source) {
 const marker='static void setup_steam_registry(void)';
 const end=source.indexOf(marker);
 if(end<0||source.indexOf(marker,end+1)>=0)throw Error('Pinned helper boundary changed');
 let selected=source.slice(0,end);
 const create='    CreateWindowW(class_nameW, steamW, WS_POPUP, 40, 40,\n                  400, 300, NULL, NULL, NULL, NULL);';
 if(!selected.includes(create))throw Error('Pinned discovery window boundary changed');
 // Readiness is local and unnamed; the window itself is the upstream window.
 selected=selected.replace(create,create.replace('    CreateWindowW','    HWND window = CreateWindowW')+'\n    if (!window) return GetLastError();\n    if (arg) SetEvent((HANDLE)arg);');
 return selected;
}
