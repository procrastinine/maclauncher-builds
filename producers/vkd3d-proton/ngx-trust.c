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

static const WCHAR owner_uri[] = L"https://github.com/procrastinine/maclauncher-builds/ngx";
static const WCHAR tracking_key[] = L"SOFTWARE\\MacLauncher\\NGX";
static const WCHAR tracking_value[] = L"CertificateThumbprint";

static BOOL owned(PCCERT_CONTEXT cert) {
    WCHAR name[256];
    if (!CertCompareCertificateName(X509_ASN_ENCODING, &cert->pCertInfo->Issuer, &cert->pCertInfo->Subject)) return FALSE;
    // Earlier project packages used this self-issued name without the URI.
    if (CertGetNameStringW(cert, CERT_NAME_ATTR_TYPE, 0, (void *)szOID_COMMON_NAME, name, 256) && !wcscmp(name, L"MacLauncher NGX")) return TRUE;
    PCERT_EXTENSION extension = CertFindExtension(szOID_SUBJECT_ALT_NAME2, cert->pCertInfo->cExtension, cert->pCertInfo->rgExtension);
    CERT_ALT_NAME_INFO *names = NULL; DWORD size = 0; BOOL result = FALSE;
    if (!extension) return FALSE;
    if (CryptDecodeObjectEx(X509_ASN_ENCODING, X509_ALTERNATE_NAME, extension->Value.pbData, extension->Value.cbData,
        CRYPT_DECODE_ALLOC_FLAG, NULL, &names, &size)) {
        for (DWORD i = 0; i < names->cAltEntry; ++i)
            if (names->rgAltEntry[i].dwAltNameChoice == CERT_ALT_NAME_URL && !wcscmp(names->rgAltEntry[i].pwszURL, owner_uri)) result = TRUE;
        LocalFree(names);
    }
    return result;
}
static BOOL hash_of(PCCERT_CONTEXT cert, WCHAR text[41]) {
    BYTE bytes[20]; DWORD size = sizeof(bytes); static const WCHAR hex[] = L"0123456789ABCDEF";
    if (!CryptHashCertificate(0, CALG_SHA1, 0, cert->pbCertEncoded, cert->cbCertEncoded, bytes, &size) || size != 20) return FALSE;
    for (DWORD i = 0; i < 20; ++i) { text[i*2] = hex[bytes[i] >> 4]; text[i*2+1] = hex[bytes[i] & 15]; }
    text[40] = 0; return TRUE;
}
static LONG verify(const WCHAR *file) {
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    WINTRUST_FILE_INFO info = {0}; info.cbStruct = sizeof(info); info.pcwszFilePath = file;
    WINTRUST_DATA data = {0}; data.cbStruct = sizeof(data); data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE; data.dwUnionChoice = WTD_CHOICE_FILE;
    data.pFile = &info; data.dwStateAction = WTD_STATEACTION_VERIFY; data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;
    LONG result = WinVerifyTrust(NULL, &action, &data);
    data.dwStateAction = WTD_STATEACTION_CLOSE; WinVerifyTrust(NULL, &action, &data);
    wprintf(L"NGX Authenticode %08lx %ls\n", (unsigned long)result, file); return result;
}
static LONG tracked(HKEY key, WCHAR hash[41]) {
    DWORD type = 0, size = 41*sizeof(WCHAR); hash[0] = 0;
    LONG result = RegQueryValueExW(key, tracking_value, NULL, &type, (BYTE *)hash, &size);
    if (result == ERROR_FILE_NOT_FOUND) return ERROR_SUCCESS;
    if (result || type != REG_SZ || size != 41*sizeof(WCHAR) || hash[40]) return ERROR_INVALID_DATA;
    for (DWORD i = 0; i < 40; ++i) if (!((hash[i] >= L'0' && hash[i] <= L'9') || (hash[i] >= L'A' && hash[i] <= L'F'))) return ERROR_INVALID_DATA;
    return ERROR_SUCCESS;
}
static BOOL delete_hash_key(const WCHAR *hash) {
    WCHAR key[160]; swprintf(key, 160, L"SOFTWARE\\Microsoft\\SystemCertificates\\ROOT\\Certificates\\%ls", hash);
    LONG result = RegDeleteTreeW(HKEY_LOCAL_MACHINE, key);
    return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND;
}
static BOOL remove_hash(HCERTSTORE store, const WCHAR *hash) {
    PCCERT_CONTEXT current = NULL; WCHAR found[41];
    while ((current = CertEnumCertificatesInStore(store, current))) {
        if (hash_of(current, found) && !wcscmp(hash, found)) {
            if (!owned(current)) { CertFreeCertificateContext(current); return FALSE; }
            return CertDeleteCertificateFromStore(current) && delete_hash_key(hash);
        }
    }
    // A killed add may have left an incomplete registry blob which cannot be
    // enumerated as a certificate. Only the tracked, validated hash is removed.
    return delete_hash_key(hash);
}
static BOOL prune(HCERTSTORE store, const WCHAR *keep) {
    for (;;) {
        PCCERT_CONTEXT current = NULL, remove = NULL; WCHAR hash[41];
        while ((current = CertEnumCertificatesInStore(store, current))) {
            if (owned(current) && hash_of(current, hash) && (!keep || wcscmp(hash, keep))) {
                remove = CertDuplicateCertificateContext(current); CertFreeCertificateContext(current); break;
            }
        }
        if (!remove) return TRUE;
        if (!hash_of(remove, hash) || !CertDeleteCertificateFromStore(remove) || !delete_hash_key(hash)) return FALSE;
    }
}
int wmain(int argc, WCHAR **argv) {
    if (argc == 3 && !wcscmp(argv[1], L"verify")) return verify(argv[2]) == ERROR_SUCCESS ? 0 : 1;
    HCERTSTORE store = NULL; HKEY tracking = NULL; PCCERT_CONTEXT cert = NULL, prior = NULL; HANDLE mutex = NULL;
    int result = 0; BOOL added = FALSE; WCHAR selected[41], previous[41];
    if (argc != 2 && (argc != 4 || (wcscmp(argv[1], L"install") && wcscmp(argv[1], L"remove")))) return 2;
    mutex = CreateMutexW(NULL, FALSE, L"Local\\MacLauncherNgxTrust");
    if (!mutex) return 3;
    DWORD wait = WaitForSingleObject(mutex, 30000);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED) { CloseHandle(mutex); return 3; }
    store = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0, CERT_SYSTEM_STORE_LOCAL_MACHINE, L"Root");
    if (!store) { result = 4; goto done; }
    if (argc == 2) {
        if (wcscmp(argv[1], L"count")) { result = 2; goto done; }
        DWORD count = 0; PCCERT_CONTEXT current = NULL;
        while ((current = CertEnumCertificatesInStore(store, current))) if (owned(current)) ++count;
        wprintf(L"{\"owned\":%lu}\n", (unsigned long)count); goto done;
    }
    HANDLE file = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) { result = 5; goto done; }
    DWORD size = GetFileSize(file, NULL), read = 0; BYTE *bytes = size && size <= 65536 ? malloc(size) : NULL;
    BOOL ok = bytes && ReadFile(file, bytes, size, &read, NULL) && read == size; CloseHandle(file);
    cert = ok ? CertCreateCertificateContext(X509_ASN_ENCODING, bytes, size) : NULL; free(bytes);
    if (!cert || !owned(cert) || !hash_of(cert, selected)) { result = 6; goto done; }
    if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, tracking_key, 0, NULL, 0, KEY_READ|KEY_WRITE, NULL, &tracking, NULL) || tracked(tracking, previous)) { result = 7; goto done; }
    if (!wcscmp(argv[1], L"remove")) {
        if (!remove_hash(store, selected)) result = 8;
        if (!wcscmp(previous, selected)) RegDeleteValueW(tracking, tracking_value);
        goto done;
    }
    // Remove the previous selected root before adding a different one. Record
    // the next fixed hash before its add, so interruption cannot orphan it.
    if (*previous && wcscmp(previous, selected) && !remove_hash(store, previous)) { result = 8; goto done; }
    if (!prune(store, selected)) { result = 8; goto done; }
    prior = CertFindCertificateInStore(store, X509_ASN_ENCODING, 0, CERT_FIND_EXISTING, cert, NULL);
    if (wcscmp(previous, selected) && RegSetValueExW(tracking, tracking_value, 0, REG_SZ, (const BYTE *)selected, sizeof(selected))) { result = 7; goto done; }
    if (!prior) {
        if (!CertAddCertificateContextToStore(store, cert, CERT_STORE_ADD_REPLACE_EXISTING, NULL)) { result = 9; goto done; }
        added = TRUE;
    }
    if (verify(argv[3]) != ERROR_SUCCESS) {
        if (added) { remove_hash(store, selected); RegDeleteValueW(tracking, tracking_value); }
        result = 10;
    }
done:
    if (prior) CertFreeCertificateContext(prior);
    if (cert) CertFreeCertificateContext(cert);
    if (tracking) RegCloseKey(tracking);
    if (store) CertCloseStore(store, 0);
    ReleaseMutex(mutex); CloseHandle(mutex); return result;
}
