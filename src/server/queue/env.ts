// Standalone processes (the worker) don't get Next's automatic .env loading.
// This runs as a side-effect import — imported FIRST in worker.ts — so that
// .env* is loaded into process.env before @/lib/db (imported later) constructs
// its pg pool. A loadEnvConfig() call in the worker body would run too late,
// since ESM hoists all imports above module-body code.
//
// @next/env is CJS, so the named export is pulled off the default import
// (a bare named import breaks under tsx's ESM interop).
import nextEnv from '@next/env';
import { assertEnv } from '@/config/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

// Validate immediately, HERE rather than in worker.ts's body, for the same
// ordering reason the load itself lives here: ESM hoists every import above
// module-body code, so an assertEnv() call in worker.ts would run only after
// @/lib/db had already constructed its pool. As a side-effect import that
// worker.ts lists first, this runs before any of that.
assertEnv('worker');
