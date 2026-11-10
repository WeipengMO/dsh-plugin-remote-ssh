/* Remote SSH — DSH settings.section client module, built by scripts/build-client.mjs. */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-ssh',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;
    const CSS = __CSS_TEXT__;
    // Injected from package.json by scripts/build-client.mjs. Compared against
    // /state.version to detect a stale host plugin module in the running DSH.
    const CLIENT_VERSION = __PLUGIN_VERSION__;
    const iconPaths = {
      server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
      terminal: '<rect x="2" y="3" width="20" height="18" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
      x: '<path d="M18 6 6 18M6 6l12 12"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      refresh: '<path d="M20 11a8 8 0 0 0-14-5L4 8M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2m0 4v-4h-4"/>',
      arrow: '<path d="M5 12h14m-7-7 7 7-7 7"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      chevron: '<path d="m9 18 6-6-6-6"/>',
      check: '<path d="m4 12 5 5L20 6"/>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>',
      alert: '<path d="m12 3 10 18H2L12 3z"/><path d="M12 9v4m0 4h.01"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 4v7m4-7v7"/>',
      edit: '<path d="m15 5 4 4M4 20l5-.8L20 8a2.8 2.8 0 0 0-4-4L4.8 15z"/>',
      home: '<path d="m3 10 9-7 9 7v10H3zM9 20v-7h6v7"/>',
      copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
      cloud: '<path d="M7 19h10a5 5 0 0 0 1-9.9A7 7 0 0 0 4 11a4 4 0 0 0 3 8"/>',
    };
    function Icon({ name, size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', stroke: 'currentColor', fill: 'none', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, dangerouslySetInnerHTML: { __html: iconPaths[name] || iconPaths.server } });
    }
    function Button({ children, icon, variant, small, onClick, disabled, title, type = 'button', className = '' }) {
      return h('button', { type, title, disabled, onClick, className: ['rss-btn', variant ? 'rss-' + variant : '', small ? 'rss-small' : '', className].join(' ') },
        icon && h(Icon, { name: icon, size: small ? 15 : 17 }), children);
    }
    function api(route, payload) {
      const opts = payload === undefined ? { method: 'GET' } : {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-remote-ssh': '1' }, body: JSON.stringify(payload)
      };
      return fetch('/api/remote-ssh' + route, { credentials: 'same-origin', cache: 'no-store', ...opts })
        .then(async response => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) {
            const message = data.error || ('HTTP ' + response.status);
            if (response.status === 405 || /method not allowed/i.test(message)) {
              throw Error('服务端 Remote SSH 插件版本过旧，无法读取 SSH Config。请完全退出并重启 DSH 客户端（不是仅刷新页面），再硬刷新本页后重试。原始错误：' + message);
            }
            throw Error(message);
          }
          return data;
        });
    }
    function parentOf(remote) {
      if (!remote || remote === '/') return '/';
      return remote.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
    }
    function joinRemote(base, name) { return (base === '/' ? '' : base.replace(/\/+$/, '')) + '/' + name; }
    // SSH Config values are *inherited*, not copied into persisted overrides.
    // The user can see them in the form immediately but saving keeps the alias
    // linked to ~/.ssh/config so changes to HostName/User/Port/IdentityFile apply.
    const blankHost = { label: '', host: '', port: '', user: '', identityFile: '', useSshConfig: true, useAgent: true };
    function HostModal({ value, aliases = [], onClose, onSave, busy }) {
      const [form, setForm] = useState(value ? {
        label: value.label || '', host: value.host || '', port: value.port == null ? '' : String(value.port), user: value.user || '',
        identityFile: value.identityFile || '', useSshConfig: value.useSshConfig !== false, useAgent: value.useAgent !== false
      } : blankHost);
      const [effective, setEffective] = useState(null);
      const [configError, setConfigError] = useState('');
      const [resolving, setResolving] = useState(false);
      function set(name, data) { setForm(old => ({ ...old, [name]: data })); }
      function selectAlias(alias) {
        setForm(old => ({ ...old, host: alias, label: (!old.label || old.label === old.host) ? alias : old.label,
          port: '', user: '', identityFile: '', useSshConfig: true }));
      }
      useEffect(() => {
        if (!form.useSshConfig || !form.host.trim()) { setEffective(null); setConfigError(''); setResolving(false); return; }
        let cancelled = false;
        setEffective(null); setConfigError(''); setResolving(true);
        const timer = setTimeout(() => {
          api('/config/resolve?alias=' + encodeURIComponent(form.host.trim())).then(result => {
            if (!cancelled) { setEffective(result.effective); setConfigError(''); setResolving(false); }
          }).catch(err => {
            if (!cancelled) { setEffective(null); setConfigError(err.message); setResolving(false); }
          });
        }, 180);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [form.host, form.useSshConfig]);
      const inherited = form.useSshConfig && effective?.matchedHostConfig ? effective : null;
      const configValues = { user: inherited?.user || '', port: inherited?.port ? String(inherited.port) : '',
        identityFile: inherited?.identityFiles?.[0] || '' };
      function field(name, label, placeholder, opts = {}) {
        const inheritedValue = !form[name] && form.useSshConfig ? configValues[name] : '';
        return h('label', { className: 'rss-field', key: name },
          h('span', null, label, inheritedValue && h('em', { className: 'rss-inherited-tag' }, '来自 SSH Config')),
          h('input', { value: form[name] || inheritedValue || '', placeholder, disabled: busy,
            onChange: e => set(name, e.target.value), ...opts }));
      }
      const onSubmit = e => {
        e.preventDefault();
        const payload = {
          label: form.label.trim() || form.host.trim(), host: form.host.trim(),
          useSshConfig: form.useSshConfig, useAgent: form.useAgent,
          // null clears stale stored overrides on update, missing fields inherit config on create.
          ...(value?.id ? { port: null, user: null, identityFile: null } : {}),
          ...(form.port.trim() ? { port: Number(form.port) } : {}),
          ...(form.user.trim() ? { user: form.user.trim() } : {}),
          ...(form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
        };
        onSave(payload);
      };
      return h('div', { className: 'rss-modal-backdrop', onMouseDown: e => e.target === e.currentTarget && onClose() },
        h('form', { className: 'rss-modal', onSubmit },
          h('div', { className: 'rss-modal-top' }, h('div', null,
            h('h2', null, value?.id ? '编辑 SSH 主机' : '添加 SSH 主机'),
            h('p', null, '选择 SSH Config 主机即可自动读取连接参数。')),
            h(Button, { icon: 'x', small: true, onClick: onClose })),
          aliases.length > 0 && h('label', { className: 'rss-field rss-alias-picker' },
            h('span', null, '从 ~/.ssh/config 选择主机'),
            h('select', { value: aliases.includes(form.host) ? form.host : '',
              onChange: e => e.target.value && selectAlias(e.target.value), disabled: busy },
              h('option', { value: '' }, '选择已配置的 SSH 主机…'),
              aliases.map(alias => h('option', { value: alias, key: alias }, alias)))),
          field('label', '显示名称', '例如：GPU Server'),
          field('host', 'SSH 别名 / 主机地址', '例如：nansha 或 172.18.50.60', { required: true, autoFocus: !value?.host }),
          h('label', { className: 'rss-checkbox-line rss-config-toggle' },
            h('input', { type: 'checkbox', checked: form.useSshConfig, onChange: e => set('useSshConfig', e.target.checked) }),
            '使用 ~/.ssh/config 中的连接参数'),
          form.useSshConfig && form.host.trim() && (
            resolving ? h('p', { className: 'rss-hint' }, '正在解析 SSH Config…') :
            configError ? h('p', { className: 'rss-config-warning' }, configError) :
            inherited ? h('div', { className: 'rss-config-preview', role: 'status' },
              h('strong', null, '已解析：', form.host),
              h('div', null, h('code', null, inherited.user + '@' + inherited.hostName + ':' + inherited.port)),
              inherited.proxyCommand && h('div', { className: 'rss-config-proxy' }, '代理：Cloudflare Access (cloudflared)'),
              inherited.missingIdentityFiles?.length > 0 && h('div', { className: 'rss-config-warning' },
                '以下私钥路径在运行 DSH 的电脑上不存在：',
                h('code', null, inherited.missingIdentityFiles.join(', ')))) :
            h('p', { className: 'rss-config-warning' }, '未在 ~/.ssh/config 找到匹配 Host，将使用手动参数或 SSH 默认值。')),
          h('div', { className: 'rss-form-columns' },
            field('user', '用户名', inherited?.user || '例如：ubuntu'),
            field('port', 'SSH 端口', '22', { type: 'number', min: 1, max: 65535 })),
          field('identityFile', '私钥路径（可选）', inherited?.identityFiles?.[0] || '~/.ssh/id_ed25519'),
          form.useSshConfig && h('div', { className: 'rss-form-hint-row' },
            h('span', null, '上方自动填充的参数会继续跟随 SSH Config 更新。'),
            (form.user || form.port || form.identityFile) && h('button', { type: 'button',
              onClick: () => setForm(old => ({ ...old, user: '', port: '', identityFile: '' })) }, '清除手动覆盖')),
          h('label', { className: 'rss-checkbox-line' },
            h('input', { type: 'checkbox', checked: form.useAgent, onChange: e => set('useAgent', e.target.checked) }), '允许 ssh-agent'),
          h('p', { className: 'rss-hint' }, '只保存密钥路径，不读取或保存私钥内容；首次连接需要验证主机指纹。'),
          h('div', { className: 'rss-modal-actions' }, h(Button, { onClick: onClose }, '取消'),
            h('button', { type: 'submit', className: 'rss-btn rss-primary', disabled: busy || resolving || !!configError },
              busy ? '保存中…' : '保存主机'))));
    }
    function TrustModal({ probe, onClose, onConfirm, busy }) {
      const fingerprint = String(probe?.details?.fingerprint || '');
      const [typed, setTyped] = useState('');
      const [verified, setVerified] = useState(false);
      return h('div', { className: 'rss-modal-backdrop' }, h('div', { className: 'rss-modal rss-trust-dialog', role: 'dialog', 'aria-modal': true },
        h('div', { className: 'rss-modal-top' }, h('div', null, h('h2', null, '验证服务器身份'),
          h('p', null, '这是首次信任流程，必须从可信渠道核实指纹。')), h(Button, { icon: 'x', small: true, onClick: onClose })),
        h('div', { className: 'rss-notice rss-warn' }, h(Icon, { name: 'alert' }),
          h('span', null, '不要只根据此窗口显示的指纹直接确认。请在服务器控制台或联系管理员核对。')),
        h('div', { className: 'rss-fingerprint' }, h('span', null, 'ED25519 / SSH 主机密钥 SHA256 指纹'),
          h('code', null, fingerprint || '无法读取主机指纹')),
        h('label', { className: 'rss-field' }, h('span', null, '重新输入完整 SHA256 指纹'),
          h('input', { value: typed, placeholder: 'SHA256:…', onChange: e => setTyped(e.target.value), spellCheck: false })),
        h('label', { className: 'rss-checkbox-line' }, h('input', { type: 'checkbox', checked: verified, onChange: e => setVerified(e.target.checked) }),
          '我已通过独立可信渠道核对指纹'),
        h('div', { className: 'rss-modal-actions' }, h(Button, { onClick: onClose }, '取消'),
          h(Button, { variant: 'primary', disabled: busy || !verified || typed.trim() !== fingerprint,
            onClick: () => onConfirm(fingerprint) }, busy ? '正在校验…' : '信任并连接'))));
    }
    // Mounted directly in the DSH Settings section, not in a global overlay.
    function RemoteSSHSettings() {
      const [state, setState] = useState({ hosts: [], effective: {}, statuses: [], sessions: [], aliases: [], recent: [] });
      const [selected, setSelected] = useState('');
      const [session, setSession] = useState('');
      const [filter, setFilter] = useState('');
      const [browse, setBrowse] = useState(null);
      const [dir, setDir] = useState('~');
      const [tab, setTab] = useState('files');
      const [modal, setModal] = useState(null);
      const [probe, setProbe] = useState(null);
      const [trust, setTrust] = useState(false);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [success, setSuccess] = useState('');
      const [buildWarning, setBuildWarning] = useState('');
      const [command, setCommand] = useState('pwd && git status --short');
      const [log, setLog] = useState([]);
      const [loading, setLoading] = useState(false);
      const currentHost = state.hosts.find(host => host.id === selected);
      const status = state.statuses.find(item => item.id === selected);
      const activeSession = state.sessions.find(item => item.id === session);
      const refresh = useCallback(async () => {
        try {
          const next = await api('/state');
          setState(next);
          setBuildWarning(next.version === CLIENT_VERSION ? '' :
            'Remote SSH 服务端插件版本与界面不一致（服务端 ' + (next.version || '旧版／未提供版本') + '，界面 ' + CLIENT_VERSION + '）。请完全退出并重启 DSH 客户端后硬刷新页面，否则无法读取 SSH Config。');
          setSelected(old => next.hosts.find(item => item.id === old)?.id || next.hosts[0]?.id || '');
          setSession(old => next.sessions.find(item => item.id === old)?.id || (next.sessions.length === 1 ? next.sessions[0].id : ''));
        } catch (e) { setError(e.message); }
      }, []);
      const run = async (name, fn, msg) => {
        setBusy(name); setError(''); setSuccess('');
        try { const value = await fn(); if (msg) setSuccess(msg); return value; }
        catch (e) { setError(e.message); return null; }
        finally { setBusy(''); }
      };
      const loadDir = useCallback(async (host, value) => {
        if (!host) return;
        setLoading(true); setError('');
        try {
          const listing = await api('/browse?host=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(value));
          setBrowse(listing); setDir(listing.path);
        } catch (e) { setBrowse(null); setDir(value); setError(e.message); }
        finally { setLoading(false); }
      }, []);
      useEffect(() => { refresh(); }, [refresh]);
      useEffect(() => { const tick = setInterval(refresh, 12000); return () => clearInterval(tick); }, [refresh]);
      const hosts = state.hosts.filter(item => (item.label + ' ' + item.host).toLowerCase().includes(filter.toLowerCase()));
      const stateLabel = status?.state === 'ready' ? '已连接' : status?.state === 'failed' ? '连接失败' : status?.state === 'connecting' ? '连接中' : '未连接';
      const sessionText = activeSession?.remote ? '当前会话正在使用远程工作区' : activeSession ? '已选择会话，可以将远程目录设为工作区' : '先启动并选择 Agent 会话，再使用远程目录';
      const statusClass = status?.state === 'ready' ? 'rss-online' : status?.state === 'failed' ? 'rss-failed' : 'rss-idle';
      const test = async () => {
        const result = await run('test', () => api('/test', { host: selected }));
        if (!result) return;
        setProbe(result.probe);
        if (result.probe.ok) { setSuccess('SSH 与远程 Shell 连接已验证'); loadDir(selected, dir); }
        else if (result.probe.code === 'SSH_HOST_KEY_UNKNOWN') { setTrust(true); }
        else setError(result.probe.message || result.probe.code || '连接失败');
        refresh();
      };
      const saveHost = async form => {
        const result = await run('save', () => api(modal === 'new' || !modal?.id ? '/host/add' : '/host/update',
          modal === 'new' || !modal?.id ? form : { ...form, id: modal.id }), '主机配置已保存');
        if (result) { setSelected(result.host.id); setBrowse(null); setDir('~'); setModal(null); refresh(); }
      };
      const openWorkspace = async () => {
        if (!session) { setError('请先选择要切换的 DSH Agent 会话'); return; }
        const result = await run('open', () => api('/workspace/open', { host: selected, path: dir || '~', sessionId: session }), '已真实切换 Agent 工作目录');
        if (result) refresh();
      };
      const leaveWorkspace = async () => {
        if (!session) return;
        const result = await run('leave', () => api('/workspace/close', { sessionId: session }), '已恢复本地工作目录');
        if (result) refresh();
      };
      const execute = async e => {
        e.preventDefault();
        if (!command.trim() || !currentHost) return;
        const cmd = command.trim();
        setLog(lines => [...lines, { kind: 'command', text: '$ ' + cmd }]);
        const result = await run('exec', () => api('/exec', { host: selected, path: dir || '~', command: cmd }));
        if (result) setLog(lines => [...lines, { kind: 'result', text: (result.stdout || '') + (result.stderr || '') + '\n[exit ' + result.code + ']' }]);
      };
      return h('div', { className: 'rss-settings-container' },
        h('div', { className: 'rss-app', role: 'region', 'aria-label': 'Remote SSH 设置与远程工作区' },
          h('header', { className: 'rss-topbar' },
            h('div', { className: 'rss-topbar-title' },
              h('h2', null, 'Remote SSH'),
              h('p', null, '管理服务器连接，在远程目录中工作')),
            h(Button, { icon: 'refresh', small: true, onClick: refresh, title: '刷新连接状态', className: 'rss-refresh' })),
          (error || success || buildWarning) && h('div', { className: 'rss-feedback', role: 'status', 'aria-live': 'polite' },
            buildWarning && h('div', { className: 'rss-notice rss-warn' }, h(Icon, { name: 'alert', size: 16 }),
              h('span', null, buildWarning)),
            error && h('div', { className: 'rss-notice rss-error' }, h(Icon, { name: 'alert', size: 16 }),
              h('span', null, error), h('button', { type: 'button', 'aria-label': '关闭错误', onClick: () => setError('') }, '×')),
            success && h('div', { className: 'rss-notice rss-success' }, h(Icon, { name: 'check', size: 16 }),
              h('span', null, success), h('button', { type: 'button', 'aria-label': '关闭提示', onClick: () => setSuccess('') }, '×'))),
          h('section', { className: 'rss-hosts', 'aria-label': 'SSH 主机列表' },
            h('div', { className: 'rss-section-title' },
              h('div', { className: 'rss-section-title-copy' }, h('strong', null, 'SSH 主机'),
                h('span', null, state.hosts.length + ' 台已保存')),
              h(Button, { icon: 'plus', onClick: () => setModal('new'), className: 'rss-add-host' }, '添加主机')),
            state.hosts.length > 4 && h('div', { className: 'rss-search' }, h(Icon, { name: 'search', size: 15 }),
              h('input', { value: filter, placeholder: '搜索主机名或地址', 'aria-label': '搜索 SSH 主机', onChange: e => setFilter(e.target.value) })),
            state.hosts.length > 0 ?
              h('div', { className: 'rss-host-list' }, hosts.map(item => {
                const stat = state.statuses.find(it => it.id === item.id);
                return h('button', { key: item.id, type: 'button', className: 'rss-host ' + (selected === item.id ? 'rss-selected' : ''),
                    'aria-pressed': selected === item.id,
                    onClick: () => { if (selected !== item.id) { setSelected(item.id); setBrowse(null); setDir('~'); setProbe(null); setTab('files'); } } },
                  h('span', { className: 'rss-host-icon' }, h(Icon, { name: 'server', size: 16 })),
                  h('span', { className: 'rss-host-text' }, h('strong', null, item.label || item.host),
                    h('small', null, (stat?.user || item.user || 'ssh') + '@' + (stat?.hostName || item.host) + ':' + (stat?.port || item.port || 22))),
                  h('span', { className: 'rss-dot ' + (stat?.state === 'ready' ? 'rss-dot-green' : ''),
                    title: stat?.state === 'ready' ? '已连接' : '未连接' }));
              }), hosts.length === 0 && h('p', { className: 'rss-empty-side' }, '没有匹配的主机')) :
              h('div', { className: 'rss-empty-hosts' },
                h('div', { className: 'rss-empty-icon' }, h(Icon, { name: 'server', size: 21 })),
                h('div', null, h('strong', null, '还没有 SSH 主机'),
                  h('p', null, '添加远程服务器后，可浏览其目录并连接 Agent。'))),
            state.aliases.some(alias => !state.hosts.some(host => host.host === alias)) &&
              h('details', { className: 'rss-disclosure' },
                h('summary', null, '从 ~/.ssh/config 导入', h(Icon, { name: 'chevron', size: 14 })),
                h('div', { className: 'rss-alias-grid' },
                  state.aliases.filter(alias => !state.hosts.some(host => host.host === alias)).slice(0, 12).map(alias =>
                    h('button', { type: 'button', key: alias, onClick: () => setModal({ label: alias, host: alias, useSshConfig: true }) },
                      h(Icon, { name: 'plus', size: 13 }), alias))))),
          currentHost && h('section', { className: 'rss-main', 'aria-label': '当前 SSH 主机' },
            h('div', { className: 'rss-connection-head' },
              h('div', { className: 'rss-connection-title' },
                h('h3', null, currentHost.label || currentHost.host),
                h('span', { className: 'rss-status ' + statusClass },
                  h('span', { className: 'rss-dot ' + (status?.state === 'ready' ? 'rss-dot-green' : '') }), stateLabel)),
              h('div', { className: 'rss-connection-actions' },
                h(Button, { icon: 'refresh', onClick: test, disabled: !!busy, className: 'rss-connect-button' },
                  busy === 'test' ? '连接中…' : '测试连接'),
                h(Button, { icon: 'edit', small: true, title: '编辑主机', onClick: () => setModal(currentHost) }),
                h(Button, { icon: 'trash', small: true, title: '删除主机', className: 'rss-delete', onClick: async () => {
                  if (!window.confirm('确定删除主机「' + currentHost.label + '」及其保存的工作区记录？')) return;
                  const r = await run('remove', () => api('/host/remove', { id: selected }), '已删除主机');
                  if (r) { setSelected(''); setBrowse(null); refresh(); }
                } }))),
            h('div', { className: 'rss-host-address' },
              (status?.user || currentHost.user || 'ssh') + '@' + (status?.hostName || currentHost.host) + ':' + (status?.port || currentHost.port || 22)),
            h('section', { className: 'rss-session' },
              h('div', { className: 'rss-subheading' }, h(Icon, { name: 'folder', size: 16 }), h('strong', null, 'Agent 工作区')),
              h('div', { className: 'rss-session-controls' },
                h('select', { 'aria-label': '选择 DSH Agent 会话', value: session, onChange: e => setSession(e.target.value) },
                  h('option', { value: '' }, state.sessions.length ? '选择 Agent 会话' : '尚无活动的 Agent 会话'),
                  state.sessions.map(item => h('option', { value: item.id, key: item.id },
                    item.id.slice(0, 15) + ' · ' + (item.remote ? '远程' : '本地')))),
                activeSession?.remote && h(Button, { small: true, onClick: leaveWorkspace, disabled: !!busy },
                  busy === 'leave' ? '切换中…' : '返回本地')),
              h('p', { className: 'rss-session-description' }, sessionText)),
            h('div', { className: 'rss-tabs', role: 'tablist', 'aria-label': '远程 SSH 工具' },
              [['files', '文件浏览', 'folder'], ['terminal', '快速命令', 'terminal'], ['info', '连接信息', 'shield']].map(([id, label, glyph]) =>
                h('button', { key: id, role: 'tab', type: 'button', 'aria-selected': tab === id,
                    className: 'rss-tab ' + (tab === id ? 'rss-tab-active' : ''), onClick: () => setTab(id) },
                  h(Icon, { name: glyph, size: 15 }), label))),
            tab === 'files' && h('div', { className: 'rss-files-tab', role: 'tabpanel' },
              h('div', { className: 'rss-pathbar' },
                h(Button, { small: true, icon: 'home', title: '远程 Home 目录', onClick: () => loadDir(selected, '~') }),
                h(Button, { small: true, icon: 'back', title: '上一级', disabled: dir === '/', onClick: () => loadDir(selected, parentOf(dir)) }),
                h('form', { className: 'rss-path-form', onSubmit: e => { e.preventDefault(); loadDir(selected, dir); } },
                  h('input', { 'aria-label': '远程路径', value: dir, onChange: e => setDir(e.target.value), spellCheck: false, placeholder: '/home/user/project' }),
                  h('button', { title: '跳转目录', type: 'submit', 'aria-label': '跳转目录' }, h(Icon, { name: 'arrow', size: 16 }))),
                h(Button, { icon: 'refresh', small: true, onClick: () => loadDir(selected, dir), disabled: loading, title: '刷新远程目录' })),
              h('div', { className: 'rss-filelist' }, loading ? h('div', { className: 'rss-loading' }, '正在读取目录…') : !browse ?
                h('div', { className: 'rss-folder-intro' },
                  h('div', { className: 'rss-empty-icon' }, h(Icon, { name: 'folder', size: 21 })),
                  h('strong', null, '选择远程目录'),
                  h('p', null, '可浏览服务器目录，或在上方直接输入路径。'),
                  h(Button, { icon: 'folder', onClick: () => loadDir(selected, dir) }, '浏览目录')) :
                h(React.Fragment, null,
                  h('div', { className: 'rss-filelist-heading' }, h('span', null, browse.path), h('span', null, browse.entries.length + ' 项')),
                  browse.entries.length === 0 && h('div', { className: 'rss-loading' }, '这个目录是空的'),
                  browse.entries.map(entry => h('button', { key: entry.name, type: 'button', className: 'rss-file-row',
                      disabled: entry.type !== 'directory', title: entry.name,
                      onClick: () => entry.type === 'directory' && loadDir(selected, joinRemote(browse.path, entry.name)) },
                    h(Icon, { name: entry.type === 'directory' ? 'folder' : 'file', size: 15 }),
                    h('span', null, entry.name),
                    entry.type === 'directory' && h(Icon, { name: 'chevron', size: 13 }))),
                  browse.truncated && h('p', { className: 'rss-hint rss-truncated' }, '目录过大，只显示前 1000 项'))),
              h('div', { className: 'rss-workspace-actions' },
                h('div', null, h('strong', null, '设为当前 Agent 工作区'),
                  h('p', null, session ? '在此目录中执行 Agent 命令与文件操作。' : '先在上方选择一个活动会话。')),
                h(Button, { variant: 'primary', icon: 'arrow', disabled: !!busy || !session,
                  onClick: openWorkspace }, busy === 'open' ? '正在切换…' : '使用此目录'))),
            tab === 'terminal' && h('div', { className: 'rss-terminal-tab', role: 'tabpanel' },
              h('p', { className: 'rss-hint' }, '在服务器执行非交互式命令（30 秒超时）。不是完整 SSH 终端。'),
              h('div', { className: 'rss-console', 'aria-live': 'polite' },
                log.length === 0 ? h('span', { className: 'rss-console-muted' }, '命令输出将显示在这里。') :
                log.map((entry, i) => h('pre', { key: i, className: entry.kind === 'command' ? 'rss-console-cmd' : '' }, entry.text))),
              h('form', { className: 'rss-command-row', onSubmit: execute },
                h('span', null, '$'), h('input', { value: command, onChange: e => setCommand(e.target.value),
                  'aria-label': 'SSH 命令', spellCheck: false, placeholder: 'nvidia-smi' }),
                h('button', { disabled: !!busy || !command.trim(), type: 'submit' },
                  busy === 'exec' ? '执行中…' : '运行', h(Icon, { name: 'arrow', size: 15 })))),
            tab === 'info' && h('div', { className: 'rss-info-tab', role: 'tabpanel' },
              [['主机地址', status?.hostName || currentHost.host], ['用户', status?.user || currentHost.user || 'SSH Config / 默认'],
                ['SSH 端口', status?.port || currentHost.port || 22], ['身份认证', (state.effective?.[selected]?.identityFiles || [])[0] || 'SSH Agent / 默认密钥'],
                ['连接代理', state.effective?.[selected]?.proxyCommand ? 'cloudflared (Cloudflare Access)' : '直连'],
                ['已验证指纹', status?.trustedFingerprint || '尚未连接或未知'],
                ['重连次数', status?.reconnectCount || 0]].map(([key, value]) =>
                h('div', { key, className: 'rss-info-row' }, h('span', null, key), h('code', null, String(value))))),
            state.recent.length > 0 && h('details', { className: 'rss-disclosure rss-recent-wrap' },
              h('summary', null, '最近使用的远程目录', h(Icon, { name: 'chevron', size: 14 })),
              state.recent.slice(0, 7).map((entry, i) =>
                h('button', { type: 'button', key: i, className: 'rss-recent', title: entry.remoteRoot,
                  onClick: () => { setSelected(entry.connectionId); setDir(entry.remoteRoot);
                    loadDir(entry.connectionId, entry.remoteRoot); setTab('files'); } },
                  h(Icon, { name: 'folder', size: 14 }), h('span', null, entry.remoteRoot))))),
        ),
        modal && h(HostModal, { key: modal === 'new' ? 'new' : modal.id || 'alias', value: modal === 'new' ? null : modal,
          busy: busy === 'save', aliases: state.aliases, onClose: () => setModal(null), onSave: saveHost }),
        trust && probe && h(TrustModal, { probe, busy: busy === 'trust', onClose: () => setTrust(false),
          onConfirm: async fingerprint => {
            const result = await run('trust', () => api('/trust', { host: selected, fingerprint, confirmed: true }), '已校验并信任 SSH 服务器身份');
            if (result) { setTrust(false); refresh(); loadDir(selected, '~'); }
          } }));
    }
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style'); style.id = 'dsh-remote-ssh-style'; style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'remote-ssh:styles');
      // Official DSH settings section seam, as used by @dsh-ssh/dsh-ssh.
      // No main sidebar entry or shell-wide overlay is registered.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'remote-ssh',
        order: 40,
        label: () => 'Remote SSH',
      }, RemoteSSHSettings));
    }
    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  }
});
