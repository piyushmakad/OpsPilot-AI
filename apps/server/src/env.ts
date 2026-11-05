// Loads the repository-root .env before any other module runs. Imported first by cli.ts.
// Variables already set in the shell win, so `$env:PORT = 9000; npm run dev -- serve` still works.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
