// Standalone processes (the worker) don't get Next's automatic .env loading.
// This runs as a side-effect import — imported FIRST in worker.ts — so that
// .env* is loaded into process.env before @/lib/db (imported later) constructs
// its pg pool. A loadEnvConfig() call in the worker body would run too late,
// since ESM hoists all imports above module-body code.
//
// @next/env is CJS, so the named export is pulled off the default import
// (a bare named import breaks under tsx's ESM interop).
import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
