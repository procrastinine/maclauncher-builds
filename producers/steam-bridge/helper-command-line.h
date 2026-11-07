/* Copyright (c) MacLauncher contributors. MIT license. */
#pragma once

/* CommandLineToArgvW treats argv[0] separately: a leading quote ends at the
 * next quote; an unquoted executable ends at a space or tab. Keep the child
 * command line intact so raw parsers see the caller's quotes as well as argv. */
static const wchar_t *bridge_child_command_line(const wchar_t *command)
{
    if (*command == L'"')
    {
        ++command;
        while (*command && *command != L'"') ++command;
        if (*command) ++command;
    }
    else
        while (*command && *command != L' ' && *command != L'\t') ++command;
    while (*command == L' ' || *command == L'\t') ++command;
    return command;
}
