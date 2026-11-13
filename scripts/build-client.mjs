import fs from 'node:fs';
import path from 'node:path';
const base = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(base, 'src/client-web.js'), 'utf8');
const css = fs.readFileSync(path.join(base, 'src/client.css'), 'utf8');
const notebookUi = fs.readFileSync(path.join(base, 'src/notebook-ui.js'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).version;
if (!source.includes('__CSS_TEXT__')) throw Error('client CSS injection placeholder missing');
if (!source.includes('__NOTEBOOK_UI__')) throw Error('Notebook Viewer injection placeholder missing');
if (!source.includes('__PLUGIN_VERSION__')) throw Error('client version injection placeholder missing');
if (typeof version !== 'string' || version.length === 0) throw Error('package.json version missing');
fs.mkdirSync(path.join(base, 'lib'), { recursive: true });
const output = source
  .replace('__PLUGIN_VERSION__', () => JSON.stringify(version))
  .replace('__CSS_TEXT__', () => JSON.stringify(css))
  .replace('__NOTEBOOK_UI__', () => notebookUi);
fs.writeFileSync(path.join(base, 'lib/client.js'), output);
console.log(`Native client bundle (v${version}): ${(fs.statSync(path.join(base, 'lib/client.js')).size / 1024).toFixed(1)} KB`);
