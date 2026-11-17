import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/client-web.js', import.meta.url), 'utf8');
const begin = source.indexOf('    function RemoteProjectDirectoryFlow(props) {');
const end = source.indexOf("    // DSH's built-in right-sidebar terminal", begin);
assert.ok(begin > 0 && end > begin, 'directory flow must be present');
const flowSource = source.slice(begin, end);

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...tree.children.flatMap(nodes)];
}
function button(tree, text) {
  const match = nodes(tree).find(node => node.tag === 'button' && node.children.includes(text));
  assert.ok(match, 'button missing: ' + text);
  return match;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ nativePick, listDirectory, createDirectory } = {}) {
  let cursor = 0;
  let mounted = false;
  const slots = [];
  const effects = [];
  const picked = [];
  const cancelled = [];
  const errors = [];
  const h = (tag, props, ...children) => ({ tag, props: props || {}, children });
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next;
    }];
  };
  const React = {
    useRef(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index];
    },
  };
  const useEffect = effect => { if (!mounted) effects.push(effect); };
  const flow = vm.runInNewContext(flowSource + '\nRemoteProjectDirectoryFlow', {
    React, h, useState, useEffect,
    api: async route => route === '/state' ? { hosts: [] } : { ok: true },
    Icon() {}, parentOf() {}, joinRemote() {},
  });
  const props = {
    open: true, busy: false,
    pickDirectory: nativePick || (async () => null),
    listLocalDirectory: listDirectory || (async () => {
      throw Error('unexpected directory browse');
    }),
    createLocalDirectory: createDirectory,
    onPicked: path => picked.push(path),
    onCancel: () => cancelled.push(true),
    onError: error => errors.push(error),
  };
  const render = () => { cursor = 0; return flow(props); };
  const mount = async () => {
    render();
    mounted = true;
    effects.forEach(effect => effect());
    await tick();
  };
  const switchToLocal = () => button(render(), '本地电脑').props.onClick();
  const chooseLocal = async () => button(render(), '选择本地文件夹…').props.onClick();
  return { render, mount, switchToLocal, chooseLocal, picked, cancelled, errors };
}

const sample = {
  path: '/home/dev',
  home: '/home/dev',
  crumbs: [{ path: '/' }, { path: '/home' }, { path: '/home/dev' }],
  entries: [{ name: 'src', path: '/home/dev/src', hidden: false },
            { name: '.secret', path: '/home/dev/.secret', hidden: true }],
};
const child = {
  path: '/home/dev/src',
  home: '/home/dev',
  crumbs: [...sample.crumbs, { path: '/home/dev/src' }],
  entries: [],
};

test('Web browse capability falls back inside directory flow and adopts selected Host path', async () => {
  const listed = [];
  const ui = harness({
    nativePick: async () => { throw Error('directory picker failed: directoryPicker.pick needs the native capability; the composed picker serves "browse"'); },
    listDirectory: async path => {
      listed.push(path);
      return path === '/home/dev/src' ? child : sample;
    },
  });
  await ui.mount();
  ui.switchToLocal();
  await ui.chooseLocal();
  assert.deepEqual(listed, [undefined], 'browse lists Host home without native capability');
  assert.deepEqual(ui.errors, [], 'native capability mismatch must not reach the owner error modal');
  assert.deepEqual(ui.cancelled, [], 'fallback is not a cancellation');
  assert.ok(button(ui.render(), 'src'));
  assert.ok(!nodes(ui.render()).some(n => n.tag === 'button' && n.children.includes('.secret')));
  await button(ui.render(), 'src').props.onClick();
  assert.deepEqual(listed, [undefined, '/home/dev/src']);
  await button(ui.render(), '使用此本地文件夹').props.onClick();
  assert.deepEqual(ui.picked, ['/home/dev/src']);
  assert.deepEqual(ui.errors, []);
});

test('Desktop native chooser still uses original path and never browses Host', async () => {
  let scans = 0;
  const ui = harness({
    nativePick: async () => '/Users/dev/project',
    listDirectory: async () => { scans++; return sample; },
  });
  await ui.mount();
  ui.switchToLocal();
  await ui.chooseLocal();
  assert.deepEqual(ui.picked, ['/Users/dev/project']);
  assert.equal(scans, 0);
});

test('native chooser cancellation remains a cancellation, not a browser fallback', async () => {
  const ui = harness({ nativePick: async () => null });
  await ui.mount(); ui.switchToLocal(); await ui.chooseLocal();
  assert.equal(ui.cancelled.length, 1);
  assert.deepEqual(ui.picked, []);
});

test('unrelated native picker failures are reported rather than silently swallowed', async () => {
  const ui = harness({ nativePick: async () => { throw Error('native chooser crashed'); } });
  await ui.mount(); ui.switchToLocal(); await ui.chooseLocal();
  assert.deepEqual(ui.errors, ['native chooser crashed']);
  assert.deepEqual(ui.picked, []);
});

test('in-app Host browser creates a folder using DSH browse capability', async () => {
  const created = [];
  const ui = harness({
    nativePick: async () => { throw Error('directoryPicker.pick needs the native capability'); },
    listDirectory: async path => path === '/home/dev/new' ? { ...child, path: '/home/dev/new' } : sample,
    createDirectory: async (path, name) => {
      created.push([path, name]);
      return '/home/dev/new';
    },
  });
  await ui.mount(); ui.switchToLocal(); await ui.chooseLocal();
  const input = nodes(ui.render()).find(n => n.tag === 'input' && n.props['aria-label'] === '新文件夹名称');
  assert.ok(input);
  input.props.onChange({ target: { value: 'new' } });
  const form = nodes(ui.render()).find(n => n.tag === 'form' && n.props.className === 'rss-local-create');
  assert.ok(form);
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(created, [['/home/dev', 'new']]);
  await button(ui.render(), '使用此本地文件夹').props.onClick();
  assert.deepEqual(ui.picked, ['/home/dev/new']);
});
