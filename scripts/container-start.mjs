import { spawn } from 'node:child_process';
if (!process.env.DATABASE_URL?.trim() && process.env.VERCEL) throw new Error('DATABASE_URL is required.');
for (const file of ['scripts/migrate.mjs', 'scripts/seed-admin.mjs']) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Database bootstrap failed')));
  });
}
await import('../.output/server/index.mjs');
