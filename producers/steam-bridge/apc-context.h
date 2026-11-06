/* Copyright (c) MacLauncher contributors. MIT license. */
struct bridge_apc_context {
    UNICODE_STRING path;
    char load_name[16];
    char terminate_name[24];
    WCHAR dll_path[1];
};
