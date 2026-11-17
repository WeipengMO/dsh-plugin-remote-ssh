import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(root, 'src/notebook-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/client.css'), 'utf8');

function setup() {
  let sanitizedMarkup = '';
  const h = (type, props, ...children) => ({ type, props: props || {}, children });
  class TableOnlyParser {
    parseFromString(markup) {
      sanitizedMarkup = markup;
      const first = markup.match(/<table>([\s\S]*?)<\/table>/);
      if (!first) return { querySelector: () => null };
      const rows = Array.from(first[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g), match => ({
        children: Array.from(match[1].matchAll(/<(th|td)>([\s\S]*?)<\/\1>/gi), cell => ({
          tagName: cell[1].toUpperCase(), textContent: cell[2],
        })),
      }));
      return { querySelector: () => ({ querySelectorAll: () => rows }) };
    }
  }
  const context = { h, React: { Fragment: 'fragment' }, DOMParser: TableOnlyParser,
    TextDecoder, console };
  vm.runInNewContext(ui + '\n globalThis.__viewer = { notebookOutputs, notebookCode, notebookPlainTable, NotebookDocument };',
    context, { filename: 'src/notebook-ui.js' });
  return { viewer: context.__viewer, markup: () => sanitizedMarkup };
}
function nodes(root) {
  if (!root) return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (typeof root !== 'object') return [];
  return [root, ...nodes(root.children)];
}
function textOf(root) {
  if (typeof root === 'string') return root;
  if (Array.isArray(root)) return root.map(textOf).join('');
  if (!root || typeof root !== 'object') return '';
  return textOf(root.children);
}

test('Notebook preview grows with workspace scrolling rather than 68vh nested viewport', () => {
  assert.match(css, /\.rss-nb-document\s*\{[^}]*max-height:none/);
  assert.match(css, /\.rss-nb-page\s*\{[^}]*max-width:1220px/);
  assert.doesNotMatch(css, /max-height:min\(68vh/);
  assert.match(css, /@media \(max-width:680px\)/);
});

test('pandas text/plain tables become accessible table rows', () => {
  const { viewer } = setup();
  const table = viewer.notebookPlainTable(
    '   n_sen_high_cells  n_patients  evaluated_modules\n0             22510          40                 30\n', 0);
  assert.equal(table.type, 'div');
  const tags = nodes(table);
  assert.equal(tags.filter(n => n.type === 'table').length, 1);
  assert.equal(tags.filter(n => n.type === 'tr').length, 2);
  assert.match(textOf(table), /n_sen_high_cells/);
  assert.match(textOf(table), /22510/);
  assert.equal(viewer.notebookPlainTable('hello\nworld', 0), null);
});

test('HTML table display wins over plain text and strips scripts, URLs, event handlers and styles', () => {
  const { viewer, markup } = setup();
  const output = viewer.notebookOutputs([{ output_type: 'execute_result', data: {
    'text/html': '<style>body{color:red}</style><img src="https://example.invalid/pixel">' +
      '<script>alert(1)</script><table class="dataframe" onclick="attack()">' +
      '<tr><th>name</th><th>score</th></tr><tr><td>sample</td><td>7</td></tr></table>',
    'text/plain': 'ignored fallback',
  } }]);
  assert.equal(output.length, 1);
  assert.equal(nodes(output).filter(n => n.type === 'table').length, 1);
  assert.match(textOf(output), /sample/);
  assert.doesNotMatch(textOf(output), /ignored fallback/);
  assert.doesNotMatch(markup(), /<script|<img|<style|onclick|src=/i);
});

test('code cells have per-line number gutters, Python tokens and safe text values', () => {
  const { viewer } = setup();
  const block = viewer.notebookCode("from pathlib import Path\nprint('<script>') # note\n", 'python');
  const items = nodes(block);
  assert.equal(items.filter(n => n.props.className === 'rss-nb-code-line').length, 3);
  assert.deepEqual(items.filter(n => n.props.className === 'rss-nb-line-number').map(textOf), ['1','2','3']);
  const classes = items.map(n => n.props.className);
  assert.ok(classes.includes('rss-nb-token-keyword'));
  assert.ok(classes.includes('rss-nb-token-string'));
  assert.ok(classes.includes('rss-nb-token-comment'));
  assert.match(textOf(block), /<script>/);
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|eval\s*\(|new Function\s*\(/);
});

test('Notebook document preserves execution labels, read-only state and markdown', () => {
  const { viewer } = setup();
  const tree = viewer.NotebookDocument({ filename: 'demo.ipynb', notebook: {
    nbformat: 4, metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title'] },
      { cell_type: 'code', source: ['x = 1'], execution_count: 8, outputs: [] },
    ],
  } });
  assert.match(textOf(tree), /demo.ipynb/);
  assert.match(textOf(tree), /只读/);
  assert.match(textOf(tree), /In \[8\]:/);
  assert.ok(nodes(tree).some(n => n.props.className === 'rss-nb-h1'));
});
