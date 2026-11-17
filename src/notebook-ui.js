    // Notebook rendering for DSH's workspace document preview. Everything is
    // rendered as React text/elements; untrusted notebook HTML, SVG and scripts are NOT run.
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
    function notebookFilename(resourceAddress) {
      const value = typeof resourceAddress === 'string' ? resourceAddress : '';
      const cleaned = value.split(/[?#]/)[0];
      const parts = cleaned.split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : 'Notebook';
    }
    // Body for DSH's right-sidebar document preview. When a notebook is opened
    // from the workspace file tree, DSH reads the file (local or remote-SSH
    // routed) as complete bytes and hands them to this renderer; we decode,
    // validate nbformat 4, and render it read-only. Nothing is executed.
    function NotebookFileBody(props) {
      const content = props && props.content;
      const data = content && content.kind === 'bytes' ? content.data : undefined;
      if (data === undefined) {
        return h('div', { className: 'rss-nb-muted', role: 'status' }, '正在读取 Notebook…');
      }
      if (data.byteLength > NOTEBOOK_LIMIT) {
        return h('div', { className: 'rss-nb-alert', role: 'alert' }, 'Notebook 超过 12 MiB 预览限制。');
      }
      let notebook;
      try {
        const text = new TextDecoder('utf-8').decode(data);
        notebook = parseNotebook(JSON.parse(text));
      } catch (e) {
        return h('div', { className: 'rss-nb-alert', role: 'alert' },
          '无法预览 Notebook：' + (e && e.message ? e.message : String(e)));
      }
      return h(NotebookDocument, { notebook, filename: notebookFilename(props && props.resourceAddress) });
    }
    const NOTEBOOK_BODY_ID = 'dsh-plugin-remote-ssh/notebook';
    function registerNotebookPreview(ctx) {
      // Register .ipynb as an *extension* renderer in DSH's workspace document
      // preview. Extension priority wins over the built-in plain-text fallback,
      // so opening a Notebook from the workspace renders it instead of raw JSON.
      ctx.effect(() => ctx.documentPreviews.register({
        id: NOTEBOOK_BODY_ID,
        extensions: ['ipynb'],
        priority: 'extension',
        title: () => 'Notebook',
        loading: 'bytes-complete',
      }));
      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () =>
        ctx.slots.register({
          name: 'sidebar.right.tab.document',
          key: NOTEBOOK_BODY_ID,
        }, NotebookFileBody)));
    }
