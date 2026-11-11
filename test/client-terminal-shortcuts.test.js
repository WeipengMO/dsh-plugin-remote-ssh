import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class DataTransferMock {
  constructor() { this.contents = new Map(); }
  setData(type, value) { this.contents.set(type, value); }
  getData(type) { return this.contents.get(type) || ''; }
}
class ClipboardEventMock {
  constructor(type, options) { Object.assign(this, options); this.type = type; }
}

function fixture() {
  const captures = [];
  const removed = [];
  const copies = [];
  const pasted = [];
  const cleanup = [];
  const clipboard = {
    async writeText(value) { copies.push(value); },
    async readText() { return 'paste via clipboard\nsecond line'; },
  };
  let hasSelection = false;
  const textarea = {
    isConnected: true,
    closest(selector) { return selector === '.xterm' ? terminal : null; },
    dispatchEvent(event) {
      if (event.type === 'paste') pasted.push(event.clipboardData.getData('text/plain'));
    },
  };
  const terminal = {
    closest(selector) { return selector === '[data-sidebar-terminal]' ? {} : null; },
    querySelector(selector) {
      if (selector === '.xterm-helper-textarea') return textarea;
      if (selector === '.xterm-selection') return { children: hasSelection ? [{}] : [] };
      return null;
    },
    contains(node) { return node === textarea; },
    dispatchEvent(event) {
      if (event.type === 'copy' && hasSelection) {
        event.clipboardData.setData('text/plain', 'selected remote terminal text');
      }
    },
  };
  const doc = {
    activeElement: textarea,
    head: { appendChild() {} },
    createElement() { return { remove() {}, textContent: '', id: '' }; },
    execCommand() { return true; },
  };
  const React = {
    createElement() { return null; },
    useEffect() {},
    useState(v) { return [v, () => {}]; },
    useCallback(v) { return v; },
  };
  let plugin;
  const win = {
    DataTransfer: DataTransferMock, ClipboardEvent: ClipboardEventMock,
    navigator: { clipboard },
    addEventListener(type, fn, capture) { captures.push({ type, fn, capture }); },
    removeEventListener(type, fn, capture) { removed.push({ type, fn, capture }); },
    __ModuleLoader__: { load({ factory }) { plugin = factory(name => {
      assert.equal(name, 'react'); return React;
    }); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8'), {
    window: win, document: doc, console,
  });
  plugin.apply({
    effect(register) { cleanup.push(register()); },
    slots: { inject() { return () => {}; } },
  });
  const listener = captures.find(x => x.type === 'keydown');
  assert.ok(listener, 'clipboard must install a scoped keydown handler');
  assert.equal(listener.capture, true);
  const sendKey = (key, target = textarea, extras = {}) => {
    const event = {
      key, target, ctrlKey: true, metaKey: false, altKey: false,
      shiftKey: false, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...extras,
    };
    listener.fn(event);
    return event;
  };
  return {
    copies, pasted, clipboard, textarea, terminal, captures, removed,
    setSelection(value) { hasSelection = value; },
    sendKey, dispose() { cleanup.forEach(c => c?.()); },
  };
}

test('selected text: Ctrl+C copies and never interrupts the terminal', async () => {
  const f = fixture();
  f.setSelection(true);
  const event = f.sendKey('c');
  await Promise.resolve();
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(f.copies, ['selected remote terminal text']);
  f.dispose();
  assert.equal(f.removed.length, 1);
});

test('without selection: Ctrl+C stays native for SIGINT', () => {
  const f = fixture();
  const event = f.sendKey('c');
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.stopped, false);
  assert.deepEqual(f.copies, []);
  f.dispose();
});

test('Ctrl+V dispatches paste through xterm; multiline text is not directly written to a PTY', async () => {
  const f = fixture();
  const event = f.sendKey('v');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(f.pasted, ['paste via clipboard\nsecond line']);
  f.dispose();
});

test('clipboard bindings never capture chat fields, shift modifiers or terminal tab changes', async () => {
  const f = fixture();
  f.setSelection(true);
  const ordinary = { closest() { return null; } };
  assert.equal(f.sendKey('c', ordinary).defaultPrevented, false);
  assert.equal(f.sendKey('v', ordinary).defaultPrevented, false);
  assert.equal(f.sendKey('c', f.textarea, { shiftKey: true }).defaultPrevented, false);
  f.textarea.isConnected = false;
  const e = f.sendKey('v');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(f.pasted, []);
  f.dispose();
});

test('Settings UI does not paint an opaque application panel in dark mode', () => {
  const css = fs.readFileSync(path.join(root, 'src/client.css'), 'utf8');
  assert.match(css, /\.rss-settings-container \.rss-app,[\s\S]*?background: transparent !important/);
  assert.match(css, /\.rss-settings-container \.rss-workspace-actions \{/);
});

test('remote SSH command explicitly selects bar cursor; local subprocess remains unchanged', () => {
  const source = fs.readFileSync(path.join(root, 'src/connection.ts'), 'utf8');
  assert.match(source, /DECSCUSR 6/);
  assert.match(source, /printf .*033\[6 q/);
  const router = fs.readFileSync(path.join(root, 'src/native-terminal-router.ts'), 'utf8');
  assert.match(router, /return await original\.call\(runtime, spec\)/);
});
