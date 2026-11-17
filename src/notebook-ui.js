    // Notebook Viewer is a distinct Settings section. Everything is rendered as
    // React text/elements; untrusted notebook HTML, SVG and scripts are NOT run.
    const NOTEBOOK_LIMIT = 12 * 1024 * 1024;
    function notebookText(value) {
      return Array.isArray(value) ? value.filter(part => typeof part === 'string').join('') :
        typeof value === 'string' ? value : '';
    }
    function parseNotebook(value) {
      if (!value || typeof value !== 'object' || value.nbformat !== 4 ||
          !Array.isArray(value.cells) || value.cells.length > 2000) {
        throw Error('请选择符合 nbformat 4 规范的 Jupyter Notebook（最多 2000 个单元格）');
      }
      return value;
    }
    function notebookInlineText(text) {
      const result = [];
      const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
      let last = 0;
      let found;
      while ((found = pattern.exec(text)) !== null) {
        if (found.index > last) result.push(text.slice(last, found.index));
        const raw = found[0];
        result.push(raw.startsWith('**')
          ? h('strong', { key: found.index }, raw.slice(2, -2))
          : h('code', { key: found.index }, raw.slice(1, -1)));
        last = found.index + raw.length;
      }
      if (last < text.length) result.push(text.slice(last));
      return result;
    }
    function notebookMarkdown(source) {
      const lines = source.split(/\r?\n/);
      const blocks = [];
      let fence = null;
      let pending = [];
      const flush = () => {
        if (pending.length) {
          blocks.push(h('p', { key: blocks.length }, notebookInlineText(pending.join(' '))));
          pending = [];
        }
      };
      for (const line of lines) {
        if (line.trim().startsWith(String.fromCharCode(96, 96, 96))) {
          if (fence === null) { flush(); fence = []; }
          else {
            blocks.push(h('pre', { key: blocks.length, className: 'rss-nb-md-code' }, fence.join('\n')));
            fence = null;
          }
          continue;
        }
        if (fence !== null) { fence.push(line); continue; }
        const head = line.match(/^(#{1,6})\s+(.+)/);
        if (head) {
          flush();
          blocks.push(h('div', { key: blocks.length, className: 'rss-nb-heading rss-nb-h' + head[1].length },
            notebookInlineText(head[2])));
        } else if (/^\s*[-*+]\s+/.test(line)) {
          flush();
          blocks.push(h('div', { key: blocks.length, className: 'rss-nb-listitem' }, '\u2022 ', notebookInlineText(line.replace(/^\s*[-*+]\s+/, ''))));
        } else if (/^\s*>\s?/.test(line)) {
          flush();
          blocks.push(h('blockquote', { key: blocks.length }, notebookInlineText(line.replace(/^\s*>\s?/, ''))));
        } else if (!line.trim()) flush();
        else pending.push(line.trim());
      }
      if (fence !== null) blocks.push(h('pre', { key: blocks.length }, fence.join('\n')));
      flush();
      return blocks;
    }
    function notebookOutputs(outputs) {
      return (Array.isArray(outputs) ? outputs : []).map((output, index) => {
        if (!output || typeof output !== 'object') return null;
        if (output.output_type === 'stream') {
          return h('pre', { key: index, className: 'rss-nb-stream' }, notebookText(output.text).slice(0, 500000));
        }
        if (output.output_type === 'error') {
          return h('pre', { key: index, className: 'rss-nb-error' },
            notebookText(output.traceback).slice(0, 500000) || [output.ename, output.evalue].filter(Boolean).join(': '));
        }
        const data = output.data || {};
        for (const mime of ['image/png', 'image/jpeg', 'image/gif']) {
          const encoded = notebookText(data[mime]).replace(/\s+/g, '');
          if (encoded && encoded.length <= NOTEBOOK_LIMIT * 2 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
            return h('div', { key: index, className: 'rss-nb-output' },
              h('img', { src: 'data:' + mime + ';base64,' + encoded, alt: 'Notebook image output', loading: 'lazy' }));
          }
        }
        const plain = notebookText(data['text/plain']);
        if (plain) return h('pre', { key: index, className: 'rss-nb-output' }, plain.slice(0, 500000));
        return h('div', { key: index, className: 'rss-nb-muted' }, '此输出仅提供 HTML/SVG/交互内容，为安全起见未执行或嵌入。');
      });
    }
    function NotebookDocument({ notebook, filename }) {
      return h('div', { className: 'rss-nb-document' },
        h('div', { className: 'rss-nb-document-head' }, filename, ' · ', notebook.cells.length, ' 个单元格 · 只读'),
        notebook.cells.map((cell, index) => h('section', {
            key: cell.id || index,
            className: 'rss-nb-cell rss-nb-' + cell.cell_type
          },
          cell.cell_type === 'markdown'
            ? h('div', { className: 'rss-nb-markdown' }, notebookMarkdown(notebookText(cell.source)))
            : h(React.Fragment, null,
                h('div', { className: 'rss-nb-cell-label' },
                  cell.cell_type === 'code' ? 'In [' + (cell.execution_count ?? ' ') + ']:' : 'Raw'),
                h('pre', { className: 'rss-nb-source' }, notebookText(cell.source).slice(0, 1000000)),
                cell.cell_type === 'code' && notebookOutputs(cell.outputs))
        )));
    }
    function NotebookViewer() {
      const [mode, setMode] = useState('local');
      const [hosts, setHosts] = useState([]);
      const [host, setHost] = useState('');
      const [directory, setDirectory] = useState('~');
      const [listing, setListing] = useState(null);
      const [document, setDocument] = useState(null);
      const [filename, setFilename] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      useEffect(() => {
        let active = true;
        api('/state').then(state => {
          if (!active) return;
          setHosts(state.hosts || []);
          if (state.hosts?.length) setHost(state.hosts[0].id);
        }).catch(() => { if (active) setHosts([]); });
        return () => { active = false; };
      }, []);
      const loadLocal = async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        setError(''); setDocument(null);
        try {
          if (!/\.ipynb$/i.test(file.name)) throw Error('请选择 .ipynb 文件');
          if (file.size > NOTEBOOK_LIMIT) throw Error('文件超过 12 MiB 预览限制');
          const value = parseNotebook(JSON.parse(await file.text()));
          setDocument(value); setFilename(file.name);
        } catch (e) { setError(e.message || String(e)); }
        event.target.value = '';
      };
      const listRemote = async target => {
        if (!host) return setError('请选择 SSH 主机');
        setBusy(true); setError('');
        try {
          const value = await api('/browse?host=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(target));
          setListing(value); setDirectory(value.path);
        } catch (e) { setError(e.message || String(e)); }
        finally { setBusy(false); }
      };
      const openRemote = async remotePath => {
        if (!host) return;
        setBusy(true); setError(''); setDocument(null);
        try {
          const res = await fetch('/api/remote-ssh-notebook/read?host=' + encodeURIComponent(host) +
            '&path=' + encodeURIComponent(remotePath), { credentials: 'same-origin', cache: 'no-store' });
          const data = await res.json();
          if (!res.ok || !data.ok) throw Error(data.error || '无法读取 Notebook。请确认 Notebook Viewer 组件已启用。');
          setDocument(parseNotebook(data.notebook)); setFilename(data.path);
        } catch (e) { setError(e.message || String(e)); }
        finally { setBusy(false); }
      };
      return h('div', { className: 'rss-notebook-container' },
        h('div', { className: 'rss-nb-top' },
          h('div', null, h('strong', null, 'Jupyter Notebook Viewer'),
            h('p', null, '只读预览 .ipynb；不会运行 Python、JavaScript 或 Notebook 单元格。')),
          h('div', { className: 'rss-nb-switch' },
            h('button', { type: 'button', 'aria-pressed': mode === 'local',
              onClick: () => { setMode('local'); setError(''); setDocument(null); } }, '本地文件'),
            h('button', { type: 'button', 'aria-pressed': mode === 'remote',
              onClick: () => { setMode('remote'); setError(''); setDocument(null); } }, 'SSH 远程'))),
        mode === 'local'
          ? h('div', { className: 'rss-nb-picker' },
              h('label', null, '选择本机 Notebook 文件',
                h('input', { type: 'file', accept: '.ipynb,application/x-ipynb+json,application/json',
                  onChange: loadLocal })),
              h('small', null, '文件只在当前页面解析；不会上传到 SSH 服务器。'))
          : h('div', { className: 'rss-nb-remote' },
              h('div', { className: 'rss-nb-controls' },
                h('label', null, 'SSH 主机',
                  h('select', { value: host, onChange: e => {
                      setHost(e.target.value); setListing(null); setDocument(null); setDirectory('~');
                    } },
                    !hosts.length && h('option', { value: '' }, '尚无已保存主机'),
                    hosts.map(item => h('option', { key: item.id, value: item.id }, item.label || item.host)))),
                h('label', null, '远程目录',
                  h('input', { value: directory, onChange: e => setDirectory(e.target.value),
                    spellCheck: false, placeholder: '/home/user/notebooks' })),
                h('button', { type: 'button', disabled: busy || !host, onClick: () => listRemote(directory) }, '浏览')),
              listing && h('div', { className: 'rss-nb-files', role: 'list' },
                listing.path !== '/' && h('button', { type: 'button', onClick: () =>
                  listRemote(listing.parent), disabled: busy }, '↑ 返回上一级'),
                (listing.entries || []).filter(item => item.type === 'directory' ||
                    (item.type === 'file' && /\.ipynb$/i.test(item.name))).map(item =>
                  h('button', { type: 'button', key: item.name, disabled: busy,
                    onClick: () => item.type === 'directory'
                      ? listRemote(listing.path.replace(/\/$/, '') + '/' + item.name)
                      : openRemote(listing.path.replace(/\/$/, '') + '/' + item.name) },
                    item.type === 'directory' ? '📁 ' : '📓 ', item.name))),
              !listing && h('p', { className: 'rss-nb-muted' }, '选择已保存的 SSH 主机，再浏览远程目录中的 .ipynb 文件。')),
        busy && h('p', { className: 'rss-nb-muted', role: 'status' }, '正在读取…'),
        error && h('p', { className: 'rss-nb-alert', role: 'alert' }, error),
        document && h(NotebookDocument, { notebook: document, filename }));
    }
    function registerNotebookViewer(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'notebook-viewer', order: 45,
        label: () => 'Notebook',
      }, NotebookViewer));
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: 'notebook-viewer',
      }, ({ size = 16 }) => h(Icon, { name: 'file', size })));
    }
