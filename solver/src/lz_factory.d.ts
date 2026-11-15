// Type declarations for the extracted LZ-String module (`lz_factory.js`).
// The implementation is vendored verbatim from the shapez.io 1.5.7 bundle and
// must not be edited or reformatted; only the savegame reader uses it.

export function compressX64(input: string): string;
export function decompressX64(input: string): string;
export function compressU8(input: string): Uint8Array;
export function compressU8WHeader(input: string): Uint8Array;
export function decompressU8WHeader(input: Uint8Array): string;
