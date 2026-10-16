import { register } from 'tsconfig-paths';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

// #565: resolve dist/ from this file, not the cwd and not `./` (a relative dynamic import
// resolves against scripts/, so `./dist/...` pointed at scripts/dist and never loaded).
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Register tsconfig paths for module resolution in the compiled 'dist' directory
register({
  baseUrl: DIST,
  // You can optionally specify 'paths' here or rely on tsconfig.json
  paths: {},
});

// Import and run the compiled main entry point
import(pathToFileURL(path.join(DIST, 'src', 'index.js')).href).catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
