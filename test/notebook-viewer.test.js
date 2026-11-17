import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNotebookHttpHandler, MAX_NOTEBOOK_BYTES } from '../dist/notebook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notebook = { cells: [
  { cell_type: 'markdown', source: ['# Title\n', 'Notebook documentation'], metadata: {} },
  { cell_type: 'code', source: ['print(1)\n'], execution_count: 1,
    outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }], metadata: {} },
], metadata: {}, nbformat: 4, nbformat_minor: 5 };
const payload = Buffer.from(JSON.stringify(notebook));

function fixture() {
  const calls = [];
  let authorized = true;
  let data = payload;
  let declaredSize;
  const sftp = {
    realpath(file, cb) { calls.push(['realpath', file]); cb(null, file); },
    stat(file, cb) { calls.push(['stat', file]); cb(null, { isFile: () => true, size: declaredSize ?? data.length }); },
    readFile(file, cb) { calls.push(['readFile', file]); cb(null, data); },
  };
  const manager = {
    getHost(host) { if (host !== 'h1') throw Object.assign(Error('host not found'), { status: 404 }); },
    async connection() { return { sftp, remoteHome: async () => '/home/remote' }; },
  };
  const handler = createNotebookHttpHandler({
    manager: () => manager,
    requestRejection: () => authorized ? undefined : 401,
  });
  return { handler, calls, setAuthorized(v) { authorized = v; },
    setData(v) { data = v; }, setDeclaredSize(v) { declaredSize = v; } };
}
async function serverTest(run) {
  const fx = fixture();
  const server = http.createServer((req, res) => fx.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/remote-ssh-notebook';
  try {
    const call = async (route, options) => {
      const response = await fetch(base + route, options);
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    await run({ ...fx, call });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('the Notebook Viewer is a second Cordis component and ships a browser bundle', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  const bundle = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
  assert.equal(manifest.exports['./notebook'], './dist/notebook.js');
  assert.match(patch, /id: remote-ssh-notebook[\s\S]*name: dsh-plugin-remote-ssh\/notebook/);
  assert.match(bundle, /id: 'notebook-viewer'/);
  assert.match(bundle, /Notebook Viewer/);
});

test('authenticated viewer returns a read-only nbformat 4 document via SFTP', async () => {
  await serverTest(async ({ call, calls }) => {
    const result = await call('/read?host=h1&path=%2Fhome%2Fremote%2Fdemo.ipynb');
    assert.equal(result.status, 200);
    assert.equal(result.body.notebook.cells.length, 2);
    assert.equal(result.body.path, '/home/remote/demo.ipynb');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls.map(x => x[0]), ['realpath', 'stat', 'readFile']);
  });
});

test('signed cookie and same-origin checks run before opening remote notebooks', async () => {
  await serverTest(async ({ call, setAuthorized, calls }) => {
    setAuthorized(false);
    assert.equal((await call('/read?host=h1&path=demo.ipynb')).status, 401);
    setAuthorized(true);
    assert.equal((await call('/read?host=h1&path=demo.ipynb',
      { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call('/read?host=h1&path=demo.ipynb',
      { headers: { origin: 'https://malicious.example' } })).status, 403);
    assert.deepEqual(calls, []);
  });
});

test('the viewer only reads .ipynb files on configured SSH hosts', async () => {
  await serverTest(async ({ call, calls }) => {
    assert.equal((await call('/read?host=h1&path=%2Fetc%2Fpasswd')).status, 400);
    assert.equal((await call('/read?host=h2&path=private.ipynb')).status, 404);
    assert.equal((await call('/read?host=h1&path=C%3A%5CUsers%5Csecret.ipynb')).status, 400);
    assert.deepEqual(calls, []);
  });
});

test('oversized, malformed and unsupported notebooks are rejected', async () => {
  await serverTest(async ({ call, setDeclaredSize, setData, calls }) => {
    setDeclaredSize(MAX_NOTEBOOK_BYTES + 1);
    assert.equal((await call('/read?host=h1&path=large.ipynb')).status, 413);
    assert.equal(calls.some(x => x[0] === 'readFile'), false);
    setDeclaredSize(0);
    setData(Buffer.from('not json'));
    assert.equal((await call('/read?host=h1&path=bad.ipynb')).status, 422);
    setData(Buffer.from(JSON.stringify({ ...notebook, nbformat: 3 })));
    assert.equal((await call('/read?host=h1&path=old.ipynb')).status, 422);
  });
});

test('browser preview treats notebook HTML and SVG as untrusted output', () => {
  const ui = fs.readFileSync(path.join(root, 'src/notebook-ui.js'), 'utf8');
  assert.match(ui, /React text\/elements/);
  assert.match(ui, /image\/png/);
  assert.match(ui, /image\/jpeg/);
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|eval\s*\(|new Function\s*\(/);
  assert.match(ui, /only|只读/);
});
