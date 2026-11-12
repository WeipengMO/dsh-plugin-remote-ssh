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
            const error = Error(message);
            error.code = data.code || 'SSH_API_ERROR';
            throw error;
          }
          return data;
        });
    }
    function parentOf(remote) {
      if (!remote || remote === '/') return '/';
      return remote.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
    }
    function joinRemote(base, name) { return (base === '/' ? '' : base.replace(/\/+$/, '')) + '/' + name; }
    // The SSH Config picker populates ordinary editable fields once. Persist the
    // resolved HostName plus a separate alias so ProxyCommand still matches.
    const blankHost = { label: '', host: '', sshAlias: '', port: '', user: '', identityFile: '', useAgent: true };
    function HostModal({ value, aliases = [], onClose, onSave, busy }) {
      const [form, setForm] = useState(() => value ? {
        label: value.label || '', host: value.host || '', sshAlias: value.sshAlias || '',
        port: value.port == null ? '' : String(value.port), user: value.user || '',
        identityFile: value.identityFile || '', useAgent: value.useAgent !== false
      } : { ...blankHost });
      const [resolving, setResolving] = useState(false);
      const [configError, setConfigError] = useState('');
      const [missingKey, setMissingKey] = useState('');
      const request = React.useRef(0);
      function set(name, data) { setForm(old => ({ ...old, [name]: data })); }
      async function selectAlias(alias) {
        if (!alias) {
          ++request.current;
          setResolving(false); setConfigError(''); setMissingKey('');
          setForm(old => ({ ...old, sshAlias: '' }));
          return;
        }
        const id = ++request.current;
        setConfigError(''); setMissingKey(''); setResolving(true);
        setForm(old => ({ ...old, sshAlias: alias, label: old.label && old.label !== old.sshAlias ? old.label : alias }));
        try {
          const result = await api('/config/resolve?alias=' + encodeURIComponent(alias));
          if (id !== request.current) return;
          const cfg = result.effective;
          if (!cfg?.matchedHostConfig) throw Error('SSH Config 中没有该主机的有效配置');
          setForm(old => ({
            ...old, sshAlias: alias,
            label: old.label && old.label !== old.sshAlias ? old.label : alias,
            host: cfg.hostName || alias, user: cfg.user || '',
            port: String(cfg.port || 22), identityFile: cfg.identityFiles?.[0] || '',
          }));
          setMissingKey((cfg.missingIdentityFiles || [])[0] || '');
        } catch (err) {
          if (id === request.current) setConfigError(err.message || String(err));
        } finally {
          if (id === request.current) setResolving(false);
        }
      }
      function field(name, label, placeholder, opts = {}) {
        return h('label', { className: 'rss-field', key: name },
          h('span', null, label),
          h('input', { value: form[name] || '', placeholder, disabled: !!busy || resolving,
            onChange: e => { set(name, e.target.value); if (name === 'identityFile') setMissingKey(''); }, ...opts }));
      }
      const onSubmit = e => {
        e.preventDefault();
        const alias = form.sshAlias.trim();
        const payload = {
          label: form.label.trim() || alias || form.host.trim(),
          host: form.host.trim(),
          useSshConfig: !!alias, useAgent: form.useAgent,
          ...(alias ? { sshAlias: alias } : value?.id ? { sshAlias: null } : {}),
          ...(value?.id ? { port: null, user: null, identityFile: null } : {}),
          ...(form.port.trim() ? { port: Number(form.port) } : {}),
          ...(form.user.trim() ? { user: form.user.trim() } : {}),
          ...(form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
        };
        onSave(payload);
      };
      return h('div', { className: 'rss-modal-backdrop', onMouseDown: e => e.target === e.currentTarget && onClose() },
        h('form', { className: 'rss-modal', onSubmit },
          h('div', { className: 'rss-modal-top' },
            h('div', null, h('h2', null, value?.id ? '编辑 SSH 主机' : '添加 SSH 主机'),
              h('p', null, '选择已有主机自动填入参数，也可以手动编辑。')),
            h(Button, { icon: 'x', small: true, onClick: onClose, title: '关闭' })),
          aliases.length > 0 && h('label', { className: 'rss-field rss-alias-picker' },
            h('span', null, '从 ~/.ssh/config 导入（可选）'),
            h('select', { value: aliases.includes(form.sshAlias) ? form.sshAlias : '',
              onChange: e => selectAlias(e.target.value), disabled: !!busy || resolving },
              h('option', { value: '' }, '选择 SSH 主机…'),
              aliases.map(alias => h('option', { value: alias, key: alias }, alias)))),
          resolving && h('p', { className: 'rss-hint', role: 'status' }, '正在读取 SSH 配置…'),
          configError && h('p', { className: 'rss-config-warning', role: 'alert' }, configError),
          field('label', '显示名称', '例如：Nansha GPU'),
          field('host', '主机地址 / HostName', 'IP 地址或域名', { required: true, autoFocus: !value?.host }),
          h('div', { className: 'rss-form-columns' },
            field('user', '用户名', '例如：mowp', { required: true }),
            field('port', 'SSH 端口', '22', { type: 'number', min: 1, max: 65535, required: true })),
          field('identityFile', '私钥路径（可选）', '~/.ssh/id_ed25519'),
          missingKey && h('p', { className: 'rss-config-warning', role: 'alert' },
            '本机找不到这个私钥：' + missingKey + '。请确认 Windows 文件路径。'),
          h('label', { className: 'rss-checkbox-line' },
            h('input', { type: 'checkbox', checked: form.useAgent, onChange: e => set('useAgent', e.target.checked) }),
            '允许 ssh-agent'),
          h('p', { className: 'rss-hint' }, '仅保存密钥文件路径；首次连接时仍需验证服务器指纹。'),
          h('div', { className: 'rss-modal-actions' },
            h(Button, { onClick: onClose }, '取消'),
            h('button', { type: 'submit', className: 'rss-btn rss-primary',
              disabled: !!busy || resolving || !!configError },
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

    /**
     * DSH Web prints a bearer-token URL. It stays in browser memory only.
     * Never send that token to the Windows plugin HTTP API or any remote host
     * other than the tunnel bound to 127.0.0.1.
     */
    function localDshAccessUrl(remoteUrl, tunnel) {
      if (!tunnel || typeof tunnel.localPort !== 'number') throw Error('请先建立 SSH 访问通道');
      let source;
      try { source = new URL(String(remoteUrl).trim()); }
      catch { throw Error('请粘贴 Linux DSH 启动时输出的完整 dsh web: URL'); }
      if (source.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)) {
        throw Error('仅接受远端 DSH 输出的 http://127.0.0.1 或 http://localhost URL，不接受外部网址');
      }
      if (source.username || source.password || Number(source.port || 80) !== tunnel.remotePort) {
        throw Error('URL 端口必须与远端 DSH Web 端口一致，且不能含用户名/密码');
      }
      const local = new URL(tunnel.localUrl);
      if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || Number(local.port) !== tunnel.localPort) {
        throw Error('本机访问通道不是可信的 loopback 地址');
      }
      local.pathname = source.pathname;
      local.search = source.search;
      local.hash = source.hash;
      return local.href;
    }
    exports.localDshAccessUrl = localDshAccessUrl;

    // Mounted directly in the DSH Settings section, not in a global overlay.

    // A plugin-owned window surface, not a separate external browser. The
    // Electron WebView uses the official Desktop browser guest lease API so
    // SameSite=Strict DSH Web cookies remain first-party in the guest.
    const remoteViewListeners = new Set();
    function openEmbeddedDsh(host, path, label) {
      for (const notify of [...remoteViewListeners]) notify({host, path, label, id: Date.now() + Math.random()});
    }
    function RemoteDshPage({ selection, visible }) {
      const [view, setView] = useState({phase:'idle'});
      const [retry, setRetry] = useState(0);
      const container = React.useRef(null);
      const bridge = window.dshDesktop?.browser;
      useEffect(() => {
        if (!selection) return;
        let cancelled = false;
        let timer;
        let attempts = 0;
        const start = async () => {
          if (cancelled) return;
          try {
            const result = await api('/runtime/web/open',
              { host:selection.host, path:selection.path, installIfMissing:true });
            if (cancelled) return;
            if (result.phase === 'failed') {
              throw Error(result.message || '远端 DSH 启动失败');
            }
            if (result.phase === 'ready') {
              setView({phase:'ready', url:result.url, path:result.path,
                installation:result.installation});
            } else {
              attempts++;
              if (attempts >= 150) throw Error('远端 DSH 启动超时；检查服务器 Node.js、网络和 npm 状态');
              setView({phase:'starting', installation:result.installation});
              timer = setTimeout(start, 2000);
            }
          } catch(error) {
            if (!cancelled) setView({phase:'error', message:error.message || String(error)});
          }
        };
        setView({phase:'connecting'});
        void start();
        return () => { cancelled = true; clearTimeout(timer); };
      }, [selection?.id, retry]);
      useEffect(() => {
        const url = view.phase === 'ready' ? view.url : null;
        if (!selection || !url || !container.current || !bridge || typeof bridge.acquire !== 'function') return;
        let disposed = false, element, reservation;
        const attach = async () => {
          reservation = await bridge.acquire('dsh-remote-ssh:host:' + selection.host);
          if (disposed) { await bridge.release(reservation.lease); return; }
          element = document.createElement('webview');
          element.className = 'rss-remote-webview';
          element.dataset.sidebarBrowserFrame = 'webview';
          element.setAttribute('name', reservation.lease);
          element.setAttribute('partition', reservation.partition);
          element.setAttribute('allowpopups', '');
          element.setAttribute('src', 'about:blank#' + reservation.lease);
          element.setAttribute('aria-label', 'Linux 远端 DSH');
          element.addEventListener('dom-ready', () => {
            if (!disposed) void element.loadURL(url).catch(() => {
              if (!disposed) setView({phase:'error', message:'无法加载远端 DSH，请检查 SSH 连接后重试。'});
            });
          }, {once:true});
          element.addEventListener('did-fail-load', e => {
            if (!disposed && e.isMainFrame && e.errorCode !== -3) {
              setView({phase:'error',message:'远端 DSH 页面加载失败：' + e.errorDescription});
            }
          });
          if (container.current) container.current.appendChild(element);
        };
        void attach().catch(e => {
          if (!disposed) setView({phase:'error',message:'Desktop WebView 创建失败：' + (e.message || String(e))});
        });
        return () => {
          disposed = true;
          element?.remove();
          if (reservation) void bridge.release(reservation.lease).catch(() => {});
        };
      }, [selection?.id, view.phase === 'ready' ? view.url : null]);
      return h('div', {className:'rss-remote-page', style:{display:visible?'flex':'none'}},
        h('div', {className:'rss-remote-page-controls'},
          h('code', null, selection.requestedPath || selection.path),
          h(Button,{icon:'refresh',small:true,title:'重新连接此远程 Host',onClick:()=>setRetry(n=>n+1)},'重新连接')),
        h('p',{className:'rss-remote-session-notice'},
          '此 SSH 主机共用一个远端 DSH Host / Core Connection。请在远端 DSH 中选择所需工作区；此操作不会自动切换已有 Session。'),
        view.phase === 'ready' && bridge
          ? h('div',{className:'rss-remote-viewport',ref:container})
          : h('div',{className:'rss-remote-splash'},
              h('div',{className:'rss-remote-splash-content'},
                h(Icon,{name:view.phase==='error'?'alert':'cloud',size:32}),
                h('strong',null,view.phase==='error'?'远端 DSH 连接失败':'正在连接 Linux DSH'),
                h('p',null,view.phase==='error'?view.message:
                  '插件正在通过 SSH 启动 Linux 上的完整 DSH，首次启动可能需要下载官方 CLI。'),
                !bridge && h('p',null,'此模式需要 Windows DSH Desktop 提供受控 Electron WebView。'),
                view.phase==='error' && h(Button,{variant:'primary',onClick:()=>setRetry(n=>n+1)},'重试连接'))));
    }

    function RemoteDshDesktopView() {
      const [pages, setPages] = useState([]);
      const [active, setActive] = useState(null);
      useEffect(() => {
        const open = selection => {
          const key = JSON.stringify([selection.host]);
          // Keep one mounted Client/Connection per SSH Host. Changing the
          // requested project must not replace an existing Core Connection or
          // silently move a running remote Session to another Workspace.
          setPages(old => {
            const existing = old.find(page => page.key === key);
            return existing
              ? old.map(page => page.key === key ? {...page, requestedPath:selection.path} : page)
              : [...old, {...selection, key, requestedPath:selection.path}];
          });
          setActive(key);
        };
        remoteViewListeners.add(open);
        return () => remoteViewListeners.delete(open);
      }, []);
      if (!pages.length) return null;
      const close = key => {
        setPages(old => old.filter(page => page.key !== key));
        setActive(old => old === key ? null : old);
      };
      return h(React.Fragment, null,
        !active && h('div', {className:'rss-remote-launcher'},
          pages.map(page => h('button', {key:page.key, type:'button', title:page.path,
            onClick:()=>setActive(page.key)}, page.label || page.host))),
        h('section', {className:'rss-remote-main', style:{display:active?'flex':'none'},
          'aria-label':'Linux 远端 DSH Desktop 工作区'},
          h('header', {className:'rss-remote-main-header'},
            h('nav', {className:'rss-remote-tabs', 'aria-label':'远程 DSH 界面'},
              pages.map(page => h('div', {key:page.key, className:'rss-remote-tab'},
                h('button', {type:'button', title:page.path, 'aria-pressed':active===page.key,
                  onClick:()=>setActive(page.key)}, (page.label || page.host) + ' · Host'),
                h('button', {type:'button', title:'关闭远程界面', 'aria-label':'关闭 ' + (page.label || page.host),
                  onClick:()=>close(page.key)}, '×')))),
            h(Button,{icon:'x',small:true,title:'返回 Windows DSH',onClick:()=>setActive(null)},'返回本地')),
          pages.map(page => h(RemoteDshPage, {key:page.key, selection:page, visible:active===page.key}))));
    }

    function RemoteSSHSettings() {
      const [state, setState] = useState({ hosts: [], effective: {}, statuses: [], sessions: [], aliases: [], recent: [], remoteDsh: { desktopProfile: false, tunnels: [] } });
      const [selected, setSelected] = useState('');
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
      const [loading, setLoading] = useState(false);
      const [recentExpanded, setRecentExpanded] = useState(false);
      const [remoteRuntimeProbe, setRemoteRuntimeProbe] = useState(null);
      const currentHost = state.hosts.find(host => host.id === selected);
      const status = state.statuses.find(item => item.id === selected);
      const remoteDshDesktop = state.remoteDsh?.desktopProfile === true;
      const refresh = useCallback(async () => {
        try {
          const next = await api('/state');
          setState(next);
          setBuildWarning(next.version === CLIENT_VERSION ? '' :
            'Remote SSH 服务端插件版本与界面不一致（服务端 ' + (next.version || '旧版／未提供版本') + '，界面 ' + CLIENT_VERSION + '）。请完全退出并重启 DSH 客户端后硬刷新页面，否则无法读取 SSH Config。');
          setSelected(old => next.hosts.find(item => item.id === old)?.id || next.hosts[0]?.id || '');
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
      useEffect(() => { const tick = setInterval(refresh, 5000); return () => clearInterval(tick); }, [refresh]);
      const hosts = state.hosts.filter(item => (item.label + ' ' + item.host).toLowerCase().includes(filter.toLowerCase()));
      const stateLabel = status?.state === 'ready' ? '已连接' : status?.state === 'failed' ? '连接失败' : status?.state === 'connecting' ? '连接中' : '未连接';
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
      const checkRemoteRuntime = async () => {
        if (!selected) return;
        const result = await run('runtime-connect', () => api('/runtime/connect', { host: selected }));
        if (result) { setRemoteRuntimeProbe(result); refresh(); }
      };
      const openRemoteDshInDesktop = () => {
        if (!selected || !browse) { setError('请先选择服务器和远端目录'); return; }
        openEmbeddedDsh(selected, browse.path, currentHost?.label || currentHost?.host);
      };
      return h('div', { className: 'rss-settings-container' },
        h('div', { className: 'rss-app', role: 'region', 'aria-label': 'Remote SSH 设置与远程工作区' },
          h('header', { className: 'rss-topbar' },
            h('div', { className: 'rss-topbar-title' },
              h('h2', null, 'Remote SSH'),
              h('p', null, '在 Windows Desktop 内直接打开 SSH 工作区')),
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
            h('div', { className: 'rss-tabs', role: 'tablist', 'aria-label': '远程 SSH 工具' },
              [['files', '远程项目', 'folder'], ['info', '连接信息', 'shield']].map(([id, label, glyph]) =>
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
              h('div', { className: 'rss-workspace-actions rss-workspace-primary' },
                h('div', null, h('strong', null, '在 Linux DSH 中打开'),
                  h('p', null, remoteDshDesktop
                    ? '远端 DSH 独立管理会话、Git、终端和文件；首次启动可能需要下载官方 CLI。'
                    : '打开远程 DSH 需要 Windows Desktop。')),
                h(Button, { variant: 'primary', icon: 'arrow', disabled: !!busy || loading || !browse || !remoteDshDesktop,
                  onClick: openRemoteDshInDesktop }, '打开远程 DSH'))),
            tab === 'info' && h('div', { className: 'rss-info-tab', role: 'tabpanel' },
              h('section', { className: 'rss-runtime-info' },
                h('strong', null, 'Linux Remote Helper · 自动部署'),
                h('p', { className: 'rss-hint' }, '检查服务器上的 Node、helper 和 DSH；正常打开远程项目时会自动执行必要的检查。'),
                h(Button, { icon: 'refresh', onClick: checkRemoteRuntime, disabled: !!busy },
                  busy === 'runtime-connect' ? '检查中…' : '检查远端 Helper'),
                remoteRuntimeProbe && h('pre', { className: 'rss-dsh-output' },
                  JSON.stringify({ node: remoteRuntimeProbe.runtime?.node,
                    hash: remoteRuntimeProbe.runtime?.helperHash?.slice(0, 12),
                    dsh: remoteRuntimeProbe.remoteDsh }, null, 2))),
              [['主机地址', status?.hostName || currentHost.host], ['用户', status?.user || currentHost.user || 'SSH Config / 默认'],
                ['SSH 端口', status?.port || currentHost.port || 22], ['身份认证', (state.effective?.[selected]?.identityFiles || [])[0] || 'SSH Agent / 默认密钥'],
                ['连接代理', state.effective?.[selected]?.proxyCommand ? 'cloudflared (Cloudflare Access)' : '直连'],
                ['已验证指纹', status?.trustedFingerprint || '尚未连接或未知'],
                ['重连次数', status?.reconnectCount || 0]].map(([key, value]) =>
                h('div', { key, className: 'rss-info-row' }, h('span', null, key), h('code', null, String(value))))),
            h('section', { className: 'rss-recent-wrap', 'aria-label': '最近使用的远程目录' },
              h('div', { className: 'rss-recent-heading' },
                h('button', { type: 'button', className: 'rss-recent-toggle',
                    'aria-expanded': recentExpanded, onClick: () => setRecentExpanded(value => !value) },
                  h('span', null, '最近使用的远程目录'),
                  h(Icon, { name: 'chevron', size: 14, className: recentExpanded ? 'rss-chevron-open' : '' })),
                h('button', { type: 'button', className: 'rss-recent-clear',
                    disabled: !!busy || state.recent.length === 0,
                    title: '仅清空最近使用记录，不会删除工作区或服务器文件',
                    onClick: async () => {
                      if (!window.confirm('清空全部最近使用的远程目录记录？\n不会删除已经创建的 DSH 工作区或服务器文件。')) return;
                      const result = await run('recent-clear', () => api('/recent/clear', { confirmed: true }), '最近使用记录已清空');
                      if (result) await refresh();
                    } },
                  h(Icon, { name: 'trash', size: 13 }), '清空历史')),
              recentExpanded && h('div', { className: 'rss-recent-items' },
                state.recent.length === 0
                  ? h('p', { className: 'rss-recent-empty' }, '暂无最近使用记录')
                  : state.recent.slice(0, 7).map((entry, i) =>
                    h('button', { type: 'button', key: entry.connectionId + ':' + entry.remoteRoot,
                        className: 'rss-recent', title: entry.remoteRoot,
                        onClick: () => { setSelected(entry.connectionId); setDir(entry.remoteRoot);
                          loadDir(entry.connectionId, entry.remoteRoot); setTab('files'); } },
                      h(Icon, { name: 'folder', size: 14 }), h('span', null, entry.remoteRoot)))))),
        ),
        modal && h(HostModal, { key: modal === 'new' ? 'new' : modal.id || 'alias', value: modal === 'new' ? null : modal,
          busy: busy === 'save', aliases: state.aliases, onClose: () => setModal(null), onSave: saveHost }),
        trust && probe && h(TrustModal, { probe, busy: busy === 'trust', onClose: () => setTrust(false),
          onConfirm: async fingerprint => {
            const result = await run('trust', () => api('/trust', { host: selected, fingerprint, confirmed: true }), '已校验并信任 SSH 服务器身份');
            if (result) { setTrust(false); refresh(); loadDir(selected, '~'); }
          } }));
    }

    /**
     * Native DSH new-project source-folder flow. The parent owns the modal
     * and project creation: we only return a validated REAL local placeholder
     * to onPicked. DSH then creates/selects the project as usual.
     *
     * Both official slots are covered; no direct Agent mutation is needed.
     */
    function RemoteProjectDirectoryFlow(props) {
      const { open, busy, onPicked, onCancel, onError, pickDirectory } = props;
      const [mode, setMode] = useState('remote');
      const [hosts, setHosts] = useState([]);
      const [aliases, setAliases] = useState([]);
      const [hostId, setHostId] = useState('');
      const [hostProbe, setHostProbe] = useState(null);
      const [trustBusy, setTrustBusy] = useState(false);
      const [currentPath, setCurrentPath] = useState('~');
      const [listing, setListing] = useState(null);
      const [loading, setLoading] = useState(false);
      const [picking, setPicking] = useState(false);
      const [error, setError] = useState('');
      const requestId = React.useRef(0);
      const reported = React.useRef(false);
      useEffect(() => {
        if (!open) return;
        let disposed = false;
        reported.current = false;
        setError(''); setListing(null); setHostProbe(null); setHostId(''); setLoading(true);
        api('/state').then(state => {
          if (disposed) return;
          const list = state.hosts || [];
          const available = (state.aliases || []).filter(alias => !list.some(host => host.host === alias || host.sshAlias === alias));
          setHosts(list); setAliases(available); setLoading(false);
          setMode('remote');
          if (list.length === 1) { setHostId(list[0].id); void browse(list[0].id, '~'); }
          else if (list.length === 0 && available.length === 1) { void chooseHost('alias:' + available[0]); }
        }).catch(e => {
          if (disposed) return;
          setError(e.message || String(e)); setLoading(false);
        });
        return () => { disposed = true; ++requestId.current; };
      }, [open]);
      async function browse(host, remotePath) {
        if (!host) return;
        const id = ++requestId.current;
        setError(''); setLoading(true); setCurrentPath(remotePath);
        try {
          const result = await api('/browse?host=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(remotePath));
          if (requestId.current !== id) return;
          setListing(result); setCurrentPath(result.path);
        } catch (e) {
          if (requestId.current !== id) return;
          setListing(null);
          if (e.code === 'SSH_HOST_KEY_UNKNOWN' || /host.key|fingerprint|host key/i.test(e.message || '')) {
            const response = await api('/test', { host }).catch(() => null);
            if (response?.probe?.code === 'SSH_HOST_KEY_UNKNOWN' && response.probe.details?.fingerprint) {
              setHostProbe({ ...response.probe, host });
              setError('首次连接：请从可信渠道核对服务器指纹，并在当前窗口确认。');
            } else setError(e.message || String(e));
          } else setError(e.message || String(e));
        } finally { if (requestId.current === id) setLoading(false); }
      }
      async function chooseHost(value) {
        const selectionId = ++requestId.current;
        if (!value) { setHostId(''); setListing(null); setHostProbe(null); setLoading(false); return; }
        setError(''); setListing(null); setHostProbe(null); setCurrentPath('~');
        let id = value;
        if (value.startsWith('alias:')) {
          setLoading(true);
          try {
            const alias = value.slice(6);
            const added = await api('/host/quick-add', { alias });
            if (requestId.current !== selectionId) return;
            id = added.host.id;
            setHosts(old => old.some(host => host.id === id) ? old : [...old, added.host]);
            setAliases(old => old.filter(item => item !== alias));
          } catch (e) { if (requestId.current === selectionId) { setError(e.message || String(e)); setLoading(false); } return; }
        }
        setHostId(id);
        await browse(id, '~');
      }
      async function verifyHostFingerprint(fingerprint) {
        if (!hostProbe || !hostId) return;
        setTrustBusy(true); setError('');
        try {
          const result = await api('/trust', { host: hostId, fingerprint, confirmed: true });
          if (!result.connected) throw Error('已信任服务器，但连接未就绪');
          setHostProbe(null);
          await browse(hostId, currentPath);
        } catch (e) { setError(e.message || String(e)); }
        finally { setTrustBusy(false); }
      }
      async function chooseRemote() {
        if (reported.current || busy || picking || loading || !hostId || !listing || currentPath !== listing.path) return;
        const host = hosts.find(item => item.id === hostId);
        reported.current = true;
        onCancel();
        openEmbeddedDsh(hostId, listing.path, host?.label || host?.host || hostId);
      }
      async function chooseLocal() {
        if (reported.current || busy || picking) return;
        setPicking(true); setError('');
        try {
          const picked = await pickDirectory();
          if (reported.current) return;
          reported.current = true;
          if (picked == null) onCancel();
          else onPicked(picked);
        } catch (e) {
          if (typeof onError === 'function') {
            reported.current = true; onError(e.message || String(e));
          } else setError(e.message || String(e));
        } finally { setPicking(false); }
      }
      function cancel() {
        if (busy || picking || reported.current) return;
        reported.current = true; onCancel();
      }
      if (open === false) return null;
      return h('div', { className: 'rss-directory-backdrop', role: 'presentation',
        onMouseDown: e => { if (e.target === e.currentTarget) cancel(); } },
        h('div', { className: 'rss-directory-dialog', role: 'dialog', 'aria-modal': true,
          'aria-label': '选择工作区源文件夹', onKeyDown: e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } } },
          h('div', { className: 'rss-directory-head' },
            h('div', null, h('h2', null, '选择工作区源文件夹'),
              h('p', null, '本地项目使用本机 DSH；远程项目在独立 Linux DSH 界面中打开。')),
            h('button', { type: 'button', className: 'rss-directory-close', title: '关闭',
              disabled: !!busy || picking, onClick: cancel }, '×')),
          h('div', { className: 'rss-project-flow', role: 'region', 'aria-label': '选择项目源文件夹' },
        h('div', { className: 'rss-project-modes' },
          h('button', { type: 'button', className: mode === 'local' ? 'rss-project-active' : '', onClick: () => setMode('local') }, '本地电脑'),
          h('button', { type: 'button', className: mode === 'remote' ? 'rss-project-active' : '', onClick: () => setMode('remote') }, 'SSH 服务器')),
        mode === 'local' ? h('div', { className: 'rss-project-local' },
          h('p', null, '使用本机文件夹创建 DSH 项目。'),
          h('button', { type: 'button', className: 'rss-btn rss-primary', disabled: !!busy || picking, onClick: chooseLocal }, '选择本地文件夹…')) :
          h('div', { className: 'rss-project-remote' },
            h('label', { className: 'rss-project-label' }, 'SSH 主机',
              h('span', { className: 'rss-project-select-wrap' },
                h('select', { value: hostId, disabled: !!busy || picking, onChange: e => chooseHost(e.target.value) },
                  h('option', { value: '' }, '选择远程服务器…'),
                  hosts.map(host => h('option', { key: host.id, value: host.id }, host.label || host.host)),
                  aliases.length > 0 && h('optgroup', { label: '从 ~/.ssh/config 自动导入' },
                    aliases.map(alias => h('option', { key: 'alias:' + alias, value: 'alias:' + alias }, alias)))),
                h('span', { className: 'rss-project-select-chevron', 'aria-hidden': true },
                  h(Icon, { name: 'chevron', size: 15 })))),
            !hosts.length && !aliases.length && !loading && h('p', { className: 'rss-project-hint' }, '没有 SSH 主机：请配置 Windows ~/.ssh/config 或在设置中添加主机。'),
            hostId && h('div', { className: 'rss-project-path-row' },
              h('button', { type: 'button', className: 'rss-project-nav-button',
                title: '上级目录', 'aria-label': '上级目录', disabled: loading,
                onClick: () => browse(hostId, parentOf(listing?.path || currentPath)) },
                h(Icon, { name: 'back', size: 17 })),
              h('form', { onSubmit: e => { e.preventDefault(); browse(hostId, currentPath); } },
                h('input', { 'aria-label': '远程源目录', spellCheck: false, value: currentPath,
                  onChange: e => setCurrentPath(e.target.value), placeholder: '/home/user/project' }),
                h('button', { type: 'submit', className: 'rss-project-nav-button',
                  'aria-label': '跳转目录', title: '跳转目录', disabled: loading },
                  h(Icon, { name: 'arrow', size: 16 }))),
              h('button', { type: 'button', className: 'rss-project-nav-button',
                title: '刷新目录', 'aria-label': '刷新目录', disabled: loading,
                onClick: () => browse(hostId, listing?.path || currentPath) },
                h(Icon, { name: 'refresh', size: 17 }))),
            hostId && h('div', { className: 'rss-project-dir-list', role: 'list' },
              loading ? h('p', { className: 'rss-project-hint' }, '读取目录中…') :
              !listing ? h('p', { className: 'rss-project-hint' }, '选择服务器以浏览远程文件夹。') :
              listing.entries.filter(entry => entry.type === 'directory').length === 0 ?
                h('p', { className: 'rss-project-hint' }, '这是一个空文件夹，可以直接选用。') :
                listing.entries.filter(entry => entry.type === 'directory').map(entry =>
                  h('button', { type: 'button', key: entry.name,
                    title: entry.name, onClick: () => browse(hostId, joinRemote(listing.path, entry.name)) },
                    h(Icon, { name: 'folder', size: 15 }), h('span', null, entry.name),
                    h(Icon, { name: 'chevron', size: 14 })))),
            hostId && listing && h('div', { className: 'rss-project-selected' },
              '选中的远程目录：', h('code', null, listing.path)),
            hostId && h('p', { className: 'rss-project-hint' },
              'Linux DSH 管理远程会话和开发工具。输入新路径后请先跳转。'),
          ),
        error && h('p', { className: 'rss-project-error', role: 'alert' }, error),
        h('div', { className: 'rss-project-footer' },
          h('button', { type: 'button', className: 'rss-btn', onClick: cancel, disabled: !!busy || picking }, '取消'),
          mode === 'remote' && h('button', { type: 'button', className: 'rss-btn rss-primary',
            onClick: chooseRemote, disabled: !!busy || picking || loading || !listing || !hostId || currentPath !== listing.path },
            picking ? '正在打开…' : '在 Desktop 打开工作区')))),
        hostProbe && h(TrustModal, { probe: hostProbe, busy: trustBusy,
          onClose: () => setHostProbe(null), onConfirm: verifyHostFingerprint }));
    }


    // DSH's built-in right-sidebar terminal is now the SSH terminal surface.
    // The native terminalController invokes subprocess.spawnTerminal, which
    // the host plugin routes according to the current workspace's SSH cwd.
    // Do NOT create a second text-only SSH terminal dialog.


    /**
     * DSH's native xterm owns terminal input. Intercept copy/paste only while
     * keyboard focus is inside an actual terminal, never in chat or Settings.
     * Do not forward Ctrl+C when xterm owns a visible selection; otherwise
     * preserve Ctrl+C as SIGINT (the terminal's native behavior).
     *
     * xterm renders selection in .xterm-selection overlay elements. It also
     * handles browser copy/paste events, preserving bracketed-paste mode.
     */
    function installTerminalClipboard(root, doc, clipboard) {
      if (!root || typeof root.addEventListener !== 'function') return () => {};
      const onKey = event => {
        if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.defaultPrevented) return;
        const key = String(event.key || '').toLowerCase();
        if (key !== 'c' && key !== 'v') return;
        const element = event.target;
        const xterm = typeof element?.closest === 'function' ? element.closest('.xterm') : null;
        if (!xterm || !xterm.closest('[data-sidebar-terminal]')) return;
        const textarea = xterm.querySelector('.xterm-helper-textarea');
        if (!textarea || (element !== textarea && !xterm.contains(element))) return;

        if (key === 'c') {
          // xterm's selection is not a DOM Selection: window.getSelection()
          // is empty even when the user has highlighted terminal text.
          const selection = xterm.querySelector('.xterm-selection');
          if (!selection || !selection.children || selection.children.length === 0) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          try {
            // Let the xterm copy handler populate the text/plain clipboard.
            const data = new root.DataTransfer();
            const synthetic = new root.ClipboardEvent('copy',
              { bubbles: true, cancelable: true, clipboardData: data });
            xterm.dispatchEvent(synthetic);
            const selectedText = data.getData('text/plain');
            if (selectedText && typeof clipboard?.writeText === 'function') {
              void clipboard.writeText(selectedText).catch(() => {
                // Electron builds may not grant Clipboard API write access.
                try { doc.execCommand?.('copy'); } catch { /* no permission */ }
              });
            } else {
              // Browser ClipboardEvent integration also works on older builds.
              doc.execCommand?.('copy');
            }
          } catch {
            try { doc.execCommand?.('copy'); } catch { /* no permission */ }
          }
          return;
        }
        // Ctrl+V is normal paste on Windows. Ctrl+Shift+V and other xterm
        // keyboard sequences remain native and untouched.
        if (typeof clipboard?.readText !== 'function') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void clipboard.readText().then(value => {
          // An asynchronous clipboard read must never paste into a newly
          // selected terminal tab or a chat field.
          if (typeof value !== 'string' || !value || !textarea.isConnected ||
              doc.activeElement !== textarea) return;
          const data = new root.DataTransfer();
          data.setData('text/plain', value);
          textarea.dispatchEvent(new root.ClipboardEvent('paste',
            { bubbles: true, cancelable: true, clipboardData: data }));
        }).catch(error => {
          console.warn('Remote SSH: terminal clipboard read denied; try Ctrl+Shift+V', error);
        });
      };
      root.addEventListener('keydown', onKey, true);
      return () => root.removeEventListener('keydown', onKey, true);
    }

    /* -------------------------------------------------------------------- *
     * Remote DSH Host isolation.
     *
     * The Windows Desktop page owns one DSH Core Connection and cannot
     * assign a different Host to a subset of its native Sessions. Instead,
     * each SSH Host has one mounted remote DSH Client tree (guest WebView)
     * with its own genuine Core Connection, reused by all remote Sessions
     * opened within that tree. Never rebind the Windows page's global
     * Connection or imply that native Windows Sessions were migrated.
     * -------------------------------------------------------------------- */

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style'); style.id = 'dsh-remote-ssh-style'; style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'remote-ssh:styles');
      ctx.effect(() => installTerminalClipboard(window, document, window.navigator?.clipboard),
        'remote-ssh:terminal-clipboard');
      // Main-window remote Host surface is a first-class plugin overlay. Its
      // content is a lease-backed Electron WebView, not an iframe with broken
      // SameSite=Strict DSH cookies. It never replaces Core Connection.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name:'shell.overlay', id:'remote-ssh-desktop-host',order:1000,
      }, RemoteDshDesktopView));
      // Official DSH settings section seam, as used by @dsh-ssh/dsh-ssh.
      // No main sidebar entry or shell-wide overlay is registered.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'remote-ssh',
        order: 40,
        label: () => 'Remote SSH',
      }, RemoteSSHSettings));
      // DSH's own project creation and workspace selector consume these slots.
      // Priority -2 beats the stock picker (-0) and @dsh-ssh/dsh-ssh (-1).
      // Keeping both slots consistent avoids selecting the remote folder in
      // one flow only to fall back to a local folder in the other.
      // DSH's native local chooser lives on uiWorkspace, NOT workspaces.
      // On Windows/Electron prefer the desktop bridge as the official
      // ui-directory-picker-native plugin does; never call the absent
      // former workspace-service picker API.
      const injectFlow = () => ({ pickDirectory: () => {
        const desktop = window.__DSH_DIRECTORY_PICKER__;
        if (desktop && typeof desktop.pick === 'function') return desktop.pick();
        return ctx.uiWorkspace.pickDirectory();
      } });
      ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
        ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
          yield ctx.slots.register({
            name: 'conversation.hero.workspace.directoryFlow', priority: -2, inject: injectFlow,
          }, RemoteProjectDirectoryFlow);
          yield ctx.slots.register({
            name: 'sidebar.workspaces.directoryFlow', priority: -2, inject: injectFlow,
          }, RemoteProjectDirectoryFlow);
        }));
    }
    exports.apply = apply;
    exports.inject = ['slots', 'uiWorkspace'];
    return module.exports;
  }
});
