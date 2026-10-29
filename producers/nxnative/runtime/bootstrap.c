#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    uint32_t capacity = 0; _NSGetExecutablePath(NULL, &capacity);
    char *executable = malloc(capacity), resolved[PATH_MAX];
    if (!executable || _NSGetExecutablePath(executable, &capacity) || !realpath(executable, resolved)) { fputs("nxnative: executable path unavailable\n", stderr); return 1; }
    char *last = strrchr(resolved, '/'); if (!last) return 1; *last = 0;
    char python[PATH_MAX], script[PATH_MAX];
    if (snprintf(python, sizeof python, "%s/../python/bin/python3", resolved) >= sizeof python || snprintf(script, sizeof script, "%s/../runtime/nxnative.py", resolved) >= sizeof script) return 1;
    const char *shared = getenv("NXNATIVE_PYTHON");
    if (shared) {
        if (shared[0] != '/' || snprintf(python, sizeof python, "%s", shared) >= sizeof python) { fputs("nxnative: invalid shared Python path\n", stderr); return 1; }
    }
    if (setenv("PYTHONDONTWRITEBYTECODE", "1", 1)) { perror("nxnative"); return 1; }
    char **arguments = calloc((size_t)argc + 4, sizeof(char *)); if (!arguments) return 1;
    arguments[0] = python; arguments[1] = "-I"; arguments[2] = "-B"; arguments[3] = script;
    for (int i = 1; i < argc; ++i) arguments[i + 3] = argv[i];
    execv(python, arguments); perror("nxnative"); return 1;
}
