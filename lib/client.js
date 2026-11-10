/* Remote SSH — DSH settings.section client module, built by scripts/build-client.mjs. */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-ssh',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;
    const CSS = "/* DSH Remote SSH — deliberately sized for the narrow Settings section.\n   A self-contained light palette avoids mismatched DSH host theme variables.\n   Every rule is namespaced to prevent style leakage into the client. */\n.rss-settings-container {\n  --rss-bg:#ffffff;\n  --rss-subtle:#f8f9fb;\n  --rss-hover:#f3f6fa;\n  --rss-text:#222832;\n  --rss-secondary:#606b7a;\n  --rss-muted:#7c8796;\n  --rss-line:#e5e8ec;\n  --rss-accent:#3268d7;\n  --rss-tint:#edf3ff;\n  --rss-tint-border:#c9d9ff;\n  --rss-green:#17774a;\n  --rss-red:#b52e38;\n  width:100%;min-width:0;container:remote-ssh-settings / inline-size;\n  color:var(--rss-text);\n}\n.rss-settings-container,.rss-settings-container *{box-sizing:border-box}\n.rss-settings-container button,.rss-settings-container input,.rss-settings-container select{font-family:inherit}\n.rss-settings-container button{cursor:pointer}\n.rss-settings-container button:disabled{cursor:not-allowed;opacity:.45}\n.rss-settings-container :is(button,input,select,summary):focus-visible{outline:2px solid var(--rss-accent);outline-offset:2px}\n.rss-app{width:100%;min-width:0;display:flex;flex-direction:column;gap:0;background:var(--rss-bg);color:var(--rss-text);font-family:inherit;font-size:13px;line-height:1.5}\n.rss-topbar{display:flex;align-items:center;justify-content:space-between;min-height:56px;padding:7px 0 16px;gap:12px}\n.rss-topbar-title{min-width:0}\n.rss-topbar-title h2{font-size:17px;line-height:1.3;letter-spacing:-.3px;color:var(--rss-text);font-weight:700;margin:0 0 4px}\n.rss-topbar-title p{margin:0;color:var(--rss-secondary);font-size:12px;line-height:1.5}\n.rss-app .rss-btn,.rss-settings-container .rss-modal .rss-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:0 12px;min-height:32px;border:1px solid #d7dce3;border-radius:7px;background:var(--rss-bg)!important;color:var(--rss-text)!important;font-size:12px!important;font-weight:550;white-space:nowrap;box-shadow:none!important;transition:background .15s,border-color .15s}\n.rss-app .rss-btn:hover:not(:disabled),.rss-settings-container .rss-modal .rss-btn:hover:not(:disabled){background:var(--rss-hover)!important;border-color:#bdc6d2}\n.rss-app .rss-btn.rss-small,.rss-settings-container .rss-modal .rss-btn.rss-small{padding:0;width:32px;height:32px;min-height:32px;flex:none}\n.rss-app .rss-btn.rss-primary,.rss-settings-container .rss-modal .rss-btn.rss-primary{background:var(--rss-accent)!important;border-color:var(--rss-accent);color:#fff!important}\n.rss-app .rss-btn.rss-primary:hover:not(:disabled),.rss-settings-container .rss-modal .rss-btn.rss-primary:hover:not(:disabled){background:#2356bb!important}\n.rss-app .rss-btn.rss-refresh{border-color:transparent;color:var(--rss-muted)!important}\n.rss-hosts{padding:4px 0 13px;border-bottom:1px solid var(--rss-line);min-width:0}\n.rss-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}\n.rss-section-title-copy{display:flex;align-items:baseline;gap:9px;min-width:0}\n.rss-section-title-copy strong{font-weight:660;font-size:13px;color:var(--rss-text)}\n.rss-section-title-copy span{font-size:11px;color:var(--rss-muted)}\n.rss-app .rss-btn.rss-add-host{border-color:#d5e1f7;color:var(--rss-accent)!important;min-height:30px}\n.rss-host-list{max-height:163px;overflow:auto;display:flex;flex-direction:column;gap:4px;min-width:0}\n.rss-app .rss-host{width:100%;display:flex;align-items:center;text-align:left;gap:10px;padding:9px 11px;border:1px solid var(--rss-line);border-radius:9px;background:var(--rss-bg)!important;color:var(--rss-text)!important;min-height:57px;min-width:0}\n.rss-app .rss-host:hover{background:var(--rss-hover)!important}\n.rss-app .rss-host.rss-selected{background:var(--rss-tint)!important;border-color:var(--rss-tint-border)}\n.rss-host-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;border:1px solid var(--rss-line);background:#fff;flex:none;color:#67778d}\n.rss-selected .rss-host-icon{color:var(--rss-accent);border-color:var(--rss-tint-border)}\n.rss-host-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}\n.rss-host-text strong{font-size:12px;font-weight:650;color:var(--rss-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.rss-host-text small{font-size:11px;color:var(--rss-secondary);font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.rss-dot{width:7px;height:7px;border-radius:50%;background:#a9b0bb;flex:none;display:inline-block}\n.rss-dot-green{background:var(--rss-green)}\n.rss-search{display:flex;align-items:center;gap:8px;padding:0 10px;margin-bottom:8px;height:34px;border:1px solid var(--rss-line);border-radius:7px;color:var(--rss-muted)}\n.rss-search input{width:100%;min-width:0;background:transparent;border:0;outline:none;color:var(--rss-text);font-size:12px}\n.rss-empty-side{font-size:12px;color:var(--rss-muted);padding:12px 3px;margin:0}\n.rss-empty-hosts{display:flex;gap:12px;align-items:center;padding:16px;border:1px dashed #d8dee7;border-radius:9px;background:var(--rss-subtle)}\n.rss-empty-hosts strong{display:block;font-size:12px;font-weight:650}\n.rss-empty-hosts p{margin:2px 0 0;color:var(--rss-secondary);font-size:11px}\n.rss-empty-icon{width:37px;height:37px;display:grid;place-items:center;flex:none;color:#7193cb;background:#f2f6fd;border-radius:9px}\n.rss-disclosure{border-top:1px solid var(--rss-line);margin-top:12px;padding-top:6px}\n.rss-disclosure summary{display:flex;align-items:center;justify-content:space-between;gap:10px;list-style:none;cursor:pointer;color:var(--rss-secondary);font-size:11.5px;padding:5px 3px}\n.rss-disclosure summary::-webkit-details-marker{display:none}\n.rss-disclosure[open] summary svg{transform:rotate(90deg)}\n.rss-alias-grid{padding:5px 0;display:flex;flex-wrap:wrap;gap:6px}\n.rss-alias-grid button{display:flex;align-items:center;gap:5px;background:var(--rss-bg)!important;border:1px solid var(--rss-line);border-radius:6px;padding:5px 9px;color:var(--rss-text)!important;font-size:11px}\n.rss-alias-grid button:hover{background:var(--rss-hover)!important}\n.rss-main{display:flex;flex-direction:column;gap:0;min-width:0;padding:17px 0 0}\n.rss-connection-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}\n.rss-connection-title{display:flex;align-items:center;gap:9px;min-width:0;flex-wrap:wrap}\n.rss-connection-title h3{margin:0;min-width:0;max-width:250px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:15px;line-height:1.35;color:var(--rss-text);font-weight:680}\n.rss-status{display:flex;align-items:center;gap:6px;border-radius:5px;border:1px solid var(--rss-line);padding:2px 7px;color:var(--rss-secondary);font-size:10px;white-space:nowrap}\n.rss-status.rss-online{color:var(--rss-green);border-color:#cde9d9;background:#f3fcf6}\n.rss-status.rss-failed{color:var(--rss-red);border-color:#f5d4d8;background:#fff7f7}\n.rss-connection-actions{display:flex;align-items:center;gap:6px;flex:none}\n.rss-connection-actions .rss-delete:hover{color:var(--rss-red)!important}\n.rss-host-address{margin:6px 0 15px;font:11px/1.5 ui-monospace,Consolas,monospace;color:var(--rss-secondary);word-break:break-all}\n.rss-session{background:var(--rss-subtle);border:1px solid var(--rss-line);border-radius:9px;padding:12px 13px;margin-bottom:14px;min-width:0}\n.rss-subheading{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--rss-text);margin-bottom:9px}\n.rss-subheading svg{color:var(--rss-secondary)}\n.rss-subheading strong{font-weight:620}\n.rss-session-controls{display:flex;gap:8px;align-items:center}\n.rss-session-controls select{width:100%;min-width:0;flex:1;height:34px;border:1px solid #d5dce5;border-radius:7px;background:#fff;color:var(--rss-text);padding:0 10px;font-size:12px}\n.rss-session-description{margin:6px 0 0;font-size:11px;color:var(--rss-secondary);line-height:1.5}\n.rss-tabs{display:flex;align-items:center;gap:22px;border-bottom:1px solid var(--rss-line);min-width:0}\n.rss-app .rss-tab{display:inline-flex;align-items:center;gap:6px;padding:0 2px;height:38px;white-space:nowrap;border:0;border-bottom:2px solid transparent;background:transparent!important;color:var(--rss-secondary)!important;font-size:12px!important;font-weight:500}\n.rss-app .rss-tab.rss-tab-active{color:var(--rss-accent)!important;border-bottom-color:var(--rss-accent);font-weight:650}\n.rss-app .rss-tab:hover{color:var(--rss-text)!important}\n.rss-files-tab,.rss-terminal-tab,.rss-info-tab{display:flex;flex-direction:column;gap:10px;padding:13px 0 8px;min-width:0}\n.rss-pathbar{display:flex;align-items:center;gap:6px;min-width:0}\n.rss-path-form{display:flex;align-items:center;flex:1;min-width:0;height:32px;border:1px solid #d7dce3;border-radius:7px;background:#fff}\n.rss-path-form input{border:0;background:transparent;min-width:0;width:100%;height:100%;outline:none;padding:0 10px;color:var(--rss-text);font:11px ui-monospace,Consolas,monospace}\n.rss-path-form button{display:grid;place-items:center;height:29px;width:30px;flex:none;border:0;background:transparent!important;color:var(--rss-secondary)!important}\n.rss-path-form button:hover{color:var(--rss-accent)!important}\n.rss-filelist{border:1px solid var(--rss-line);border-radius:8px;background:#fff;min-height:143px;max-height:220px;overflow:auto}\n.rss-filelist-heading{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--rss-line);padding:7px 10px;font-size:10.5px;color:var(--rss-secondary)}\n.rss-filelist-heading span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.rss-filelist-heading span:last-child{flex:none}\n.rss-app .rss-file-row{display:flex;align-items:center;gap:9px;width:100%;height:33px;padding:0 11px;text-align:left;border:0;border-bottom:1px solid #f1f2f4;background:#fff!important;color:var(--rss-text)!important;font-size:11.5px!important}\n.rss-app .rss-file-row svg:first-child{color:#668dc7;flex:none}\n.rss-app .rss-file-row svg:last-child{color:var(--rss-muted)}\n.rss-app .rss-file-row span{min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n.rss-app .rss-file-row:hover:not(:disabled){background:var(--rss-hover)!important}\n.rss-app .rss-file-row:disabled{opacity:1;color:var(--rss-secondary)!important}\n.rss-app .rss-file-row:disabled svg:first-child{color:#a4afbb}\n.rss-folder-intro{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:143px;gap:5px;text-align:center;padding:13px}\n.rss-folder-intro .rss-empty-icon{width:33px;height:33px;margin-bottom:1px}\n.rss-folder-intro strong{font-size:12px;font-weight:650}\n.rss-folder-intro p{margin:0 0 3px;font-size:11px;color:var(--rss-secondary);line-height:1.5}\n.rss-folder-intro .rss-btn{min-height:28px}\n.rss-loading{padding:32px 12px;text-align:center;color:var(--rss-muted);font-size:12px}\n.rss-workspace-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--rss-subtle);border:1px solid var(--rss-line);border-radius:9px;padding:11px 13px}\n.rss-workspace-actions>div{min-width:0;flex:1}\n.rss-workspace-actions strong{font-size:12px;font-weight:650}\n.rss-workspace-actions p{margin:3px 0 0;color:var(--rss-secondary);font-size:11px;line-height:1.5}\n.rss-hint{font-size:11px;color:var(--rss-secondary);margin:0;line-height:1.6}\n.rss-truncated{padding:6px 10px}\n.rss-console{height:175px;min-height:130px;overflow:auto;padding:12px;background:#17212e;border:1px solid #1e2938;border-radius:8px;color:#eef3f8;font:11px/1.6 ui-monospace,Consolas,monospace}\n.rss-console pre{margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}\n.rss-console-cmd{color:#97cdfd}\n.rss-console-muted{color:#b9c6d6}\n.rss-command-row{display:flex;align-items:center;gap:8px;border:1px solid var(--rss-line);border-radius:7px;background:#fff;padding:5px 6px 5px 10px;color:var(--rss-green)}\n.rss-command-row input{width:100%;min-width:0;flex:1;background:transparent;border:0;outline:0;color:var(--rss-text);font:11px ui-monospace,Consolas,monospace}\n.rss-command-row button{display:flex;align-items:center;gap:5px;flex:none;padding:6px 9px;border:0;border-radius:5px;background:var(--rss-accent)!important;color:white!important;font-size:11px}\n.rss-info-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:8px 1px;border-bottom:1px solid var(--rss-line)}\n.rss-info-row span{color:var(--rss-secondary);font-size:11px;flex:none}\n.rss-info-row code{font-size:11px;text-align:right;max-width:68%;overflow-wrap:anywhere;color:var(--rss-text)}\n.rss-recent-wrap{margin-bottom:8px}\n.rss-app .rss-recent{display:flex;align-items:center;gap:9px;padding:6px 7px;width:100%;text-align:left;border:0;border-radius:5px;background:transparent!important;color:var(--rss-secondary)!important;font-size:11px}\n.rss-recent span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.rss-recent:hover{background:var(--rss-hover)!important}\n.rss-feedback{padding:4px 0 12px}\n.rss-notice{display:flex;align-items:flex-start;gap:8px;min-width:0;border:1px solid;border-radius:7px;padding:8px 9px;font-size:11.5px;line-height:1.5;overflow-wrap:anywhere}\n.rss-notice>span{flex:1;min-width:0}\n.rss-notice>button{border:0;background:transparent!important;color:inherit!important;font-size:17px;line-height:1;flex:none}\n.rss-notice.rss-error{color:var(--rss-red);background:#fff5f5;border-color:#f1cdcd}\n.rss-notice.rss-success{color:var(--rss-green);background:#f0faf4;border-color:#cde9d9}\n.rss-notice.rss-warn{color:#885c1e;background:#fff9ec;border-color:#e6d5ae}\n/* Modal lives next to .rss-app under .rss-settings-container; do not inherit variables from .rss-app. */\n.rss-modal-backdrop{position:fixed;inset:0;z-index:180;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(28,37,50,.34)}\n.rss-modal{width:min(440px,100%);max-height:min(88vh,720px);overflow:auto;border:1px solid var(--rss-line);border-radius:13px;background:var(--rss-bg);padding:22px;color:var(--rss-text);box-shadow:0 16px 56px rgba(25,40,60,.19)}\n.rss-modal-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:15px}\n.rss-modal h2{font-size:16px;line-height:1.35;font-weight:680;color:var(--rss-text);margin:0 0 4px}\n.rss-modal p{font-size:11px;line-height:1.6;color:var(--rss-secondary);margin:0}\n.rss-field{display:flex;flex-direction:column;gap:5px;font-size:11.5px;font-weight:600;color:var(--rss-text);margin-bottom:12px}\n.rss-field input{height:34px;min-width:0;background:#fff;color:var(--rss-text);padding:0 9px;border:1px solid #d7dce3;border-radius:7px;font-size:12px;font-weight:400}\n.rss-field input:focus{outline:2px solid #cbd9fb;outline-offset:1px}\n.rss-form-columns{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:10px}\n.rss-checkboxes{display:flex;flex-wrap:wrap;gap:16px;margin:4px 0 12px}\n.rss-checkboxes label,.rss-checkbox-line{display:flex;align-items:center;gap:7px;color:var(--rss-secondary);font-size:11px}\n.rss-checkboxes input,.rss-checkbox-line input{accent-color:var(--rss-accent)}\n.rss-checkbox-line{margin:10px 0}\n.rss-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}\n.rss-fingerprint{border:1px solid var(--rss-line);background:var(--rss-subtle);border-radius:7px;padding:11px;margin:12px 0;display:flex;flex-direction:column;gap:6px}\n.rss-fingerprint span{font-size:10px;color:var(--rss-secondary)}\n.rss-fingerprint code{font-size:11px;color:var(--rss-text);word-break:break-all;user-select:all}\n.rss-trust-dialog .rss-warn{margin:12px 0}\n@container remote-ssh-settings (max-width:440px){\n  .rss-connection-head{align-items:flex-start;flex-direction:column;gap:9px}\n  .rss-connection-actions{align-self:flex-start}\n  .rss-host-address{margin-top:8px}\n  .rss-workspace-actions{align-items:flex-start;flex-wrap:wrap}\n  .rss-tabs{gap:13px}\n  .rss-tab{font-size:11px!important}\n  .rss-section-title-copy{gap:6px}\n}\n@media (prefers-color-scheme:dark){\n  .rss-settings-container{\n    --rss-bg:#20242b;--rss-subtle:#282d35;--rss-hover:#323944;\n    --rss-text:#e9edf2;--rss-secondary:#b0bac7;--rss-muted:#96a1ae;\n    --rss-line:#424a55;--rss-accent:#82a9ff;--rss-tint:#283b5b;--rss-tint-border:#476aa3;\n    --rss-green:#72d8a4;--rss-red:#ff9ca2;\n  }\n  .rss-host-icon,.rss-app .rss-host,.rss-app .rss-file-row,.rss-filelist,.rss-path-form,.rss-session-controls select,.rss-command-row,.rss-field input,.rss-alias-grid button{background:var(--rss-bg)!important;color:var(--rss-text)!important}\n  .rss-status.rss-online{color:var(--rss-green);background:#1a372c;border-color:#365e4c}\n  .rss-status.rss-failed{color:var(--rss-red);background:#3a282d;border-color:#75404b}\n  .rss-notice.rss-error{color:var(--rss-red);background:#3a282d;border-color:#75404b}\n  .rss-notice.rss-success{color:var(--rss-green);background:#1a372c;border-color:#365e4c}\n  .rss-notice.rss-warn{color:#f2ca89;background:#3c3429;border-color:#69553a}\n  .rss-app .rss-file-row{border-bottom-color:var(--rss-line)}\n  .rss-empty-icon{background:#293f5d;color:#a4c1f1}\n  .rss-app .rss-btn,.rss-settings-container .rss-modal .rss-btn{background:var(--rss-subtle)!important;color:var(--rss-text)!important;border-color:var(--rss-line)}\n  .rss-app .rss-btn.rss-primary,.rss-settings-container .rss-modal .rss-btn.rss-primary{background:#386ccf!important;color:#fff!important}\n  .rss-app .rss-btn.rss-add-host{color:var(--rss-accent)!important}\n}\n\n/* v1.0.4: inherited OpenSSH config is displayed without persisting overrides. */\n.rss-alias-picker select{width:100%;height:34px;border:1px solid var(--rss-line,#d9dfe8);border-radius:7px;padding:0 9px;background:var(--rss-surface,#fff);color:inherit;font:inherit}\n.rss-inherited-tag{font-size:10px;font-style:normal;font-weight:500;color:#2762bd;margin-left:8px}\n.rss-config-toggle{margin-top:7px;margin-bottom:5px}\n.rss-config-preview{border:1px solid #c6daf7;border-radius:8px;background:#f0f6ff;color:#243b60;padding:10px 12px;margin:8px 0;font-size:12px;line-height:1.7;overflow-wrap:anywhere}\n.rss-config-preview strong{font-size:12px}\n.rss-config-preview code{font-family:ui-monospace,Consolas,monospace;font-size:12px}\n.rss-config-proxy{color:#2f6098}\n.rss-modal .rss-config-warning{font-size:12px;color:#ae4e15;line-height:1.6;overflow-wrap:anywhere;margin:6px 0}\n.rss-config-warning code{display:block;color:inherit;font-size:11px}\n.rss-form-hint-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;color:#66758a}\n.rss-form-hint-row button{border:0;background:none;color:#2466d0;font-size:11px;cursor:pointer;white-space:nowrap}\n@media(max-width:440px){.rss-form-hint-row{align-items:flex-start;flex-direction:column}}\n\n@media(prefers-color-scheme:dark){\n  .rss-alias-picker select{background:var(--rss-bg);border-color:var(--rss-line);color:var(--rss-text)}\n  .rss-config-preview{background:#243950;border-color:#3b608b;color:#d3e5ff}\n  .rss-config-proxy{color:#a3c6fa}\n  .rss-modal .rss-config-warning{color:#ffc17b}\n}\n\n/* Form fields use the same box model and align at small Settings widths. */\n.rss-modal,.rss-modal *{box-sizing:border-box}\n.rss-modal .rss-field{min-width:0}\n.rss-modal .rss-field input,.rss-modal .rss-field select{width:100%;min-width:0;height:35px;border:1px solid var(--rss-line);border-radius:7px;padding:0 10px;font:inherit;font-size:12px;background:var(--rss-bg);color:var(--rss-text)}\n.rss-modal .rss-field input:focus,.rss-modal .rss-field select:focus{outline:2px solid var(--rss-tint-border);outline-offset:0}\n.rss-modal .rss-field span{display:block;margin-bottom:0}\n.rss-modal .rss-form-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,110px);gap:12px}\n.rss-modal .rss-form-columns .rss-field{margin-bottom:12px}\n.rss-no-session{flex:1;padding:8px 10px;border:1px dashed var(--rss-line);border-radius:7px;font-size:12px;color:var(--rss-secondary)}\n@media(max-width:480px){.rss-modal{padding:16px}.rss-modal .rss-form-columns{grid-template-columns:minmax(0,1fr) minmax(80px,92px);gap:8px}}\n";
    // Injected from package.json by scripts/build-client.mjs. Compared against
    // /state.version to detect a stale host plugin module in the running DSH.
    const CLIENT_VERSION = "1.0.7";
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
          setSession(old => next.sessions.find(item => item.id === old)?.id || next.sessions.find(item => item.latest)?.id || next.sessions[0]?.id || '');
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
      const sessionText = !state.sessions.length ? '尚未检测到可切换的 Agent。先在目标 DSH 对话中发送一条消息，然后刷新这里。' : activeSession?.remote ? '所选会话当前使用远程工作区；DSH 工作区列表仍显示本地目录（宿主限制）。' : activeSession ? '将下面浏览的目录设置为所选 DSH 会话的工作目录；切换只影响所选会话。' : '选择要切换的 DSH 会话。';
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
        const result = await run('open', () => api('/workspace/open', { host: selected, path: dir || '~', sessionId: session }));
        if (result) {
          setSuccess('已切换会话 ' + String(result.sessionId).slice(0, 8) + ' 的 Agent 工作目录。请切到该 DSH 会话使用；DSH 的工作区列表仍显示本地目录（宿主限制）。');
          refresh();
        }
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
              h('div', { className: 'rss-subheading' }, h(Icon, { name: 'folder', size: 16 }), h('strong', null, 'DSH 会话工作区')),
              h('div', { className: 'rss-session-controls' },
                state.sessions.length ? h('select', { 'aria-label': '选择 DSH Agent 会话', value: session, onChange: e => setSession(e.target.value) },
                  h('option', { value: '' }, '选择 DSH 会话'),
                  state.sessions.map(item => h('option', { value: item.id, key: item.id },
                    (item.cwd || '当前会话').split(/[\\/]/).filter(Boolean).slice(-1)[0] + ' · ' + item.id.slice(0, 8) + (item.remote ? ' (远程)' : '') + (item.latest ? ' · 最新' : '')))) :
                  h('span', { className: 'rss-no-session' }, '暂无已启动的 Agent'),
                h(Button, { icon: 'refresh', small: true, onClick: refresh, title: '刷新会话列表' }),
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
                h('div', null, h('strong', null, '切换所选会话的工作区'),
                  h('p', null, session ? '将所选会话切换到当前浏览的远程目录。' : '先选择上方的 DSH 会话，才能切换其目录。')),
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
