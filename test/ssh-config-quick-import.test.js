import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/client-web.js'), 'utf8');
const start = source.indexOf('    const blankHost = ');
const end = source.indexOf('    function TrustModal(', start);
assert.ok(start >= 0 && end > start, 'HostModal must remain available for regression testing');
const modalSource = source.slice(start, end);

function harness(value, config = {}) {
  const slots = [];
  const requests = [];
  const effects = [];
  let cursor = 0;
  let didMount = false;
  const createElement = (tag, props, ...children) => ({ tag, props: props || {}, children });
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next;
    }];
  };
  const React = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };
  const useEffect = fn => { if (!didMount) effects.push(fn); };
  const api = async url => {
    requests.push(url);
    const alias = new URL(url, 'http://localhost').searchParams.get('alias');
    return { effective: {
      matchedHostConfig: true,
      hostName: alias === 'second' ? 'second.example.org' : 'gpu.example.org',
      user: 'developer',
      port: 2222,
      identityFiles: ['/home/developer/.ssh/id_ed25519'],
      missingIdentityFiles: [],
      ...config,
    } };
  };
  const HostModal = vm.runInNewContext(modalSource + '\nHostModal', {
    React, h: createElement, useState, useEffect, api,
    Button() {},
  });
  const props = { value, aliases: ['compute', 'second'], busy: false,
    onClose() {}, onSave() {} };
  const render = () => { cursor = 0; return HostModal(props); };
  const mount = () => {
    render();
    didMount = true;
    return effects.map(effect => effect());
  };
  return { render, mount, requests };
}

function allNodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(allNodes);
  return [node, ...(node.children || []).flatMap(allNodes)];
}

function fieldValue(tree, label) {
  const field = allNodes(tree).find(node => node.tag === 'label'
    && node.props.className === 'rss-field'
    && node.children[0]?.tag === 'span'
    && node.children[0]?.children[0] === label);
  assert.ok(field, 'field must exist: ' + label);
  return field.children[1].props.value;
}

test('quick-import chip selects its alias and preserves unique modal identity', () => {
  assert.match(source, /setModal\(\{ label: alias, host: alias, sshAlias: alias, useSshConfig: true \}\)/);
  assert.match(source, /modal\.id \|\| modal\.sshAlias \|\| 'alias'/);
  assert.match(source, /\(host\.sshAlias \|\| host\.host\) === alias/);
});

test('clicking an SSH Config chip resolves HostName, username, port and key automatically', async () => {
  const ui = harness({ label: 'compute', host: 'compute', sshAlias: 'compute', useSshConfig: true });
  const cleanups = ui.mount();
  assert.equal(ui.requests.length, 1, 'must resolve once on modal mount');
  assert.match(ui.requests[0], /alias=compute/);
  await new Promise(resolve => setImmediate(resolve));
  const tree = ui.render();
  assert.equal(fieldValue(tree, '显示名称'), 'compute');
  assert.equal(fieldValue(tree, '主机地址 / HostName'), 'gpu.example.org');
  assert.equal(fieldValue(tree, '用户名'), 'developer');
  assert.equal(fieldValue(tree, 'SSH 端口'), '2222');
  assert.equal(fieldValue(tree, '私钥路径（可选）'), '/home/developer/.ssh/id_ed25519');
  cleanups.forEach(cleanup => cleanup?.());
});

test('manual entry and editing a saved host do not silently reread SSH Config', () => {
  for (const value of [null, {
    id: 'h-saved', label: 'Custom Label', host: 'saved.example.org',
    sshAlias: 'compute', useSshConfig: true, user: 'alice', port: 2022,
  }]) {
    const ui = harness(value);
    ui.mount();
    assert.equal(ui.requests.length, 0, 'manual creation and editing must not auto-resolve');
    if (value) {
      const tree = ui.render();
      assert.equal(fieldValue(tree, '主机地址 / HostName'), value.host);
      assert.equal(fieldValue(tree, '用户名'), value.user);
    }
  }
});

test('picker still resolves a changed alias after quick import', async () => {
  const ui = harness({ label: 'compute', host: 'compute', sshAlias: 'compute', useSshConfig: true });
  ui.mount();
  await new Promise(resolve => setImmediate(resolve));
  const select = allNodes(ui.render()).find(node => node.tag === 'select');
  assert.ok(select, 'SSH Config picker is still present');
  select.props.onChange({ target: { value: 'second' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.requests.length, 2);
  assert.equal(fieldValue(ui.render(), '主机地址 / HostName'), 'second.example.org');
  assert.equal(fieldValue(ui.render(), '显示名称'), 'second');
});

test('example placeholders are generic and do not reuse project-specific identifiers', () => {
  assert.match(source, /field\('label', '显示名称', '例如：开发服务器'\)/);
  assert.match(source, /field\('user', '用户名', '例如：developer'/);
  assert.doesNotMatch(source, /Nansha GPU|mowp/);
});
