// SPDX-License-Identifier: GPL-2.0-only
#include "prx/libc/include/FileStream.hpp"

namespace {
FileStream input{stdin};
}

extern "C" {

FileStream _Stderr_nid_postfix{stderr};
FileStream _Stdout_nid_postfix{stdout};
FileStream _Stdin_nid_postfix{stdin};

FileStream* __stdinp_nid_postfix = &input;
FileStream* __stdoutp_nid_postfix = &_Stdout_nid_postfix;
FileStream* __stderrp_nid_postfix = &_Stderr_nid_postfix;

}
