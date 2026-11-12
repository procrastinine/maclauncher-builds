// SPDX-License-Identifier: MIT
#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#include <windows.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <stdio.h>
#include <stdlib.h>

static LONG verify(const WCHAR *file) {
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    WINTRUST_FILE_INFO info = {0}; info.cbStruct = sizeof(info); info.pcwszFilePath = file;
    WINTRUST_DATA data = {0}; data.cbStruct = sizeof(data); data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE; data.dwUnionChoice = WTD_CHOICE_FILE;
    data.pFile = &info; data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;
    LONG result = WinVerifyTrust(NULL, &action, &data);
    data.dwStateAction = WTD_STATEACTION_CLOSE; WinVerifyTrust(NULL, &action, &data);
    wprintf(L"NGX Authenticode %08lx %ls\n", (unsigned long)result, file);
    return result;
}
int wmain(int argc, WCHAR **argv) {
    if (argc == 3 && !wcscmp(argv[1], L"verify")) return verify(argv[2]) == ERROR_SUCCESS ? 0 : 1;
    if (argc != 4 || (wcscmp(argv[1], L"install") && wcscmp(argv[1], L"remove"))) return 2;
    HANDLE file = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return 3;
    DWORD size = GetFileSize(file, NULL), read = 0;
    if (!size || size > 65536) { CloseHandle(file); return 3; }
    BYTE *bytes = malloc(size);
    BOOL ok = bytes && ReadFile(file, bytes, size, &read, NULL) && read == size; CloseHandle(file);
    PCCERT_CONTEXT cert = ok ? CertCreateCertificateContext(X509_ASN_ENCODING, bytes, size) : NULL;
    free(bytes); if (!cert) return 4;
    HCERTSTORE store = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0, CERT_SYSTEM_STORE_LOCAL_MACHINE, L"Root");
    if (!store) { CertFreeCertificateContext(cert); return 5; }
    PCCERT_CONTEXT prior = CertFindCertificateInStore(store, X509_ASN_ENCODING, 0, CERT_FIND_EXISTING, cert, NULL);
    int result = 0;
    if (!wcscmp(argv[1], L"remove")) { if (prior) CertDeleteCertificateFromStore(prior); }
    else {
        ok = prior || CertAddCertificateContextToStore(store, cert, CERT_STORE_ADD_NEW, NULL);
        if (ok && verify(argv[3]) != ERROR_SUCCESS) {
            if (!prior) { PCCERT_CONTEXT added = CertFindCertificateInStore(store, X509_ASN_ENCODING, 0, CERT_FIND_EXISTING, cert, NULL); if (added) CertDeleteCertificateFromStore(added); }
            result = 7;
        } else if (!ok) result = 6;
        if (prior) CertFreeCertificateContext(prior);
    }
    CertCloseStore(store, 0); CertFreeCertificateContext(cert); return result;
}
