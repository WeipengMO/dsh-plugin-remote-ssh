import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('remote project views remain mounted while switching between hosts and local Desktop', () => {
  let plugin;
  let current;
  const registered = [];
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const owner = current;
      const index = owner.index++;
      if (!(index in owner.values)) owner.values[index] = typeof initial === 'function' ? initial() : initial;
      return [owner.values[index], value => {
        owner.values[index] = typeof value === 'function' ? value(owner.values[index]) : value;
      }];
    },
    useCallback: fn => fn,
    useEffect(fn) { if (current.mountEffects) current.effects.push(fn); },
    useRef(value) { return { current: value }; },
  };
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { URL, window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => react); } } } });
  plugin.apply({
    effect() {},
    slots: {
      inject(_name, fn) { const value = fn(); if (value && value[Symbol.iterator]) [...value]; },
      register(record, component) { registered.push({ record, component }); },
    },
  });
  const overlay = registered.find(x => x.record.id === 'remote-ssh-desktop-host').component;
  const settings = registered.find(x => x.record.id === 'remote-ssh').component;
  const overlayState = { values: [], index: 0, effects: [], mountEffects: true };
  function render(component, owner) { owner.index = 0; current = owner; return component({}); }
  render(overlay, overlayState);
  for (const effect of overlayState.effects) effect();
  overlayState.mountEffects = false;

  function walk(value) {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (!value || typeof value !== 'object') return [];
    return [value, ...walk(value.children)];
  }
  function open(host, path) {
    const data = { hosts: [{ id: host, label: host, host }], statuses: [], aliases: [], recent: [],
      effective: {}, remoteDsh: { desktopProfile: true, tunnels: [] } };
    const owner = { values: [data, host, '', { path, entries: [] }, path], index: 0, effects: [], mountEffects: false };
    const tree = render(settings, owner);
    const button = walk(tree).find(node => node.children?.includes('打开远程 DSH'));
    assert.ok(button && !button.props.disabled);
    button.props.onClick();
  }
  function view() { return render(overlay, overlayState); }
  function pages(tree) { return walk(tree).filter(node => node.type?.name === 'RemoteDshPage'); }

  open('one', '/project-a');
  let tree = view();
  assert.equal(pages(tree).length, 1);
  assert.equal(pages(tree)[0].props.visible, true);
  open('two', '/project-b');
  tree = view();
  let views = pages(tree);
  assert.equal(views.length, 2);
  assert.equal(views[0].props.visible, false);
  assert.equal(views[1].props.visible, true);
  const keys = views.map(page => page.props.key);
  walk(tree).find(node => node.children?.includes('返回本地')).props.onClick();
  tree = view();
  views = pages(tree);
  assert.deepEqual(views.map(page => page.props.key), keys);
  assert.ok(views.every(page => !page.props.visible));
  walk(tree).find(node => node.type === 'button' && node.children?.includes('one')).props.onClick();
  tree = view();
  views = pages(tree);
  assert.equal(views[0].props.visible, true);
  assert.equal(views[1].props.visible, false);
  open('one', '/project-a');
  assert.equal(pages(view()).length, 2, 'reopening a project reuses its view');
  const originalHostPage = pages(view())[0];
  open('one','/another-project');
  const reusedHostPages = pages(view());
  assert.equal(reusedHostPages.length, 2, 'switching projects on one SSH Host reuses Core Client/Connection');
  assert.equal(reusedHostPages[0].props.key, originalHostPage.props.key);
  assert.equal(reusedHostPages[0].props.selection.id, originalHostPage.props.selection.id);
  assert.equal(reusedHostPages[0].props.selection.path, '/project-a', 'do not silently retarget an existing Session');
  assert.equal(reusedHostPages[0].props.selection.requestedPath, '/another-project');
});
