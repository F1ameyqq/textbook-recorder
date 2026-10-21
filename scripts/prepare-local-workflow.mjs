import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLocal } from '../src/local-preparation.mjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareLocal(process.argv.slice(2), { project, cwd: process.cwd() });
    console.log(result.help ?? JSON.stringify(result, null, 2));
    process.exitCode = result.help || result.ok ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
