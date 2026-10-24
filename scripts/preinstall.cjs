const fs = require('node:fs');
const path = require('node:path');

if (!(process.env.npm_config_user_agent || '').startsWith('pnpm/')) {
  console.error('Use pnpm instead');
  process.exit(1);
}

for (const lockfile of ['package-lock.json', 'yarn.lock']) {
  fs.rmSync(path.resolve(__dirname, '..', lockfile), { force: true });
}
