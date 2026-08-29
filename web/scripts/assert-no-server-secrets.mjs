import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const forbidden = ['server-secret-sentinel', 'wallet-secret-sentinel'];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? files(target) : [target];
    }),
  );
  return nested.flat();
}

for (const file of await files(new URL('../dist', import.meta.url))) {
  const contents = await readFile(file, 'utf8').catch(() => '');
  for (const secret of forbidden) {
    if (contents.includes(secret)) throw new Error(`Server secret leaked into ${file}`);
  }
}

console.log('Browser bundle contains no backend secret sentinels.');
