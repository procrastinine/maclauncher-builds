// Cancellation for Builds steps that take an AbortSignal.
function createAbortError(message = "Download canceled.") { const err = new Error(message); err.name = "AbortError"; err.code = "ABORT_ERR"; return err; }
const isAbortError = err => Boolean(err) && (err.name === "AbortError" || err.code === "ABORT_ERR");
function throwIfAborted(signal) { if (signal?.aborted) throw createAbortError(); }
module.exports = { createAbortError, isAbortError, throwIfAborted };
