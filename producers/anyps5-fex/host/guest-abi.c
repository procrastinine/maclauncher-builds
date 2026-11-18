// SPDX-License-Identifier: GPL-2.0-only
// x86-64 System V guest code for the per-signature thunk proof and the guest exception check. build-proof.mjs compiles
// it for x86-64 and the hosts run it under FEXCore. In the thunk proof each call goes through a slot that holds a thunk
// stub, as a PS5 module's import slots do.
typedef struct { long long a, b, c, d; } Big;          // 32 bytes: returned through a hidden pointer
typedef struct { long long tag; double value; } Pair; // INTEGER and SSE eightbytes: returned in rax and xmm0

struct Slots {
  Big (*make_big)(long long, long long, long long, long long, long long, long long, long long, long long, long long, long long);
  long double (*scale)(long double, int);
  double (*weigh)(double, double, double, double, double, double, double, double, double, double);
  Pair (*pair)(long long, double);
  int (*apply)(int (*)(int, int), int, int);
};
struct Inputs { long long i[10]; double d[10]; long double x; int n; long long tag; double value; int (*callback)(int, int); };
struct Results { Big big; long double scaled; double weighed; Pair pair; int applied; };

// Called back by the host through the function pointer in Inputs.
int guest_callback(int a, int b) {
  return a * 10 + b;
}

void guest_abi(const struct Slots* s, const struct Inputs* in, struct Results* out) {
  out->big = s->make_big(in->i[0], in->i[1], in->i[2], in->i[3], in->i[4], in->i[5], in->i[6], in->i[7], in->i[8], in->i[9]);
  out->scaled = s->scale(in->x, in->n);
  out->weighed = s->weigh(in->d[0], in->d[1], in->d[2], in->d[3], in->d[4], in->d[5], in->d[6], in->d[7], in->d[8], in->d[9]);
  out->pair = s->pair(in->tag, in->value);
  out->applied = s->apply(in->callback, 3, 4);
}

// The exception check (AnyPS5FexException.cpp): long chains of dependent integer operations between backward branches,
// which FEXCore keeps in its per-block register cache until the branch, and a handler that overwrites every
// caller-saved register. The host computes the same function and compares.
unsigned long long guest_spin(unsigned long long iterations, unsigned long long seed) {
  unsigned long long a = seed, b = seed * 3 + 1, c = seed ^ 0x9e3779b97f4a7c15ull, d = 7, e = 11, f = 13;
  for (unsigned long long i = 0; i < iterations; ++i) {
    a = a * 6364136223846793005ull + b;
    b ^= a >> 13;
    c += b * 31;
    d = (d ^ c) + (a >> 7);
    e += d ^ (c << 5);
    f = (f + e) * 2862933555777941757ull;
    a ^= f >> 17;
    b += e ^ (d >> 3);
    c ^= a + f;
    d += b >> 9;
    e ^= c * 5;
    f -= d ^ a;
  }
  return a ^ b ^ c ^ d ^ e ^ f;
}

void guest_on_exception(int signal, void* context) {
  (void)signal;
  (void)context;
  __asm__ volatile("movabsq $0x5a5a5a5a5a5a5a5a, %%rax\n\t"
                   "movq %%rax, %%rcx\n\tmovq %%rax, %%rdx\n\tmovq %%rax, %%rsi\n\tmovq %%rax, %%rdi\n\t"
                   "movq %%rax, %%r8\n\tmovq %%rax, %%r9\n\tmovq %%rax, %%r10\n\tmovq %%rax, %%r11"
                   ::: "rax", "rcx", "rdx", "rsi", "rdi", "r8", "r9", "r10", "r11", "memory");
}
