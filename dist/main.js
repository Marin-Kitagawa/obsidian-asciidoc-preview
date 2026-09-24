'use strict';

const { Plugin, ItemView, MarkdownView, Notice, debounce, PluginSettingTab, Setting } = require('obsidian');
const renderer = (function initRenderer(module) {
const { execFile } = require('child_process');
const { existsSync, readFileSync, unlink, writeFile } = require('fs');
const { tmpdir } = require('os');
const { join, dirname, basename, extname } = require('path');

const EXT_RE = /\.(adoc|asciidoc|ad)$/i;

/**
 * Find a command on PATH, Windows flavoured. Node's spawn cannot resolve
 * `.bat`/`.cmd` like CreateProcess does, so the lookup is done by hand.
 * @param {string} cmd
 * @returns {string} Resolved command, or the input unchanged.
 */
function resolveExecutable(cmd) {
  const hasPath = /[\\/]/.test(cmd);
  if (hasPath) {
    return cmd;
  }
  const PATHEXT = ['.exe', '.com', '.bat', '.cmd'];
  if (PATHEXT.includes(extname(cmd).toLowerCase())) {
    return cmd;
  }
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    for (const ext of PATHEXT) {
      const p = { dir, file: join(dir, cmd + ext) }.file;
      if (existsSync(p)) {
        return p;
      }
    }
  }
  return cmd;
}

/**
 * Node (and CreateProcess) cannot directly execute `.bat`/`.cmd`. RubyGems
 * binstubs like asciidoctor's are two-liners that really just invoke a real
 * executable against a wrapper script:
 *
 *   @ECHO OFF
 *   @"%~dp0ruby.exe" "%~dpn0" %*
 *
 * Parse that line to recover the interpreter and script, so we can spawn the
 * actual `.exe` and skip the batch shell (whose quoting mangles arguments).
 * @param {string} bat Absolute path of a `.bat`/`.cmd` file.
 * @returns {{ interpreter: string, script: string } | null}
 */
function interpretBatch(bat) {
  let text;
  try {
    text = readFileSync(bat, 'utf8');
  } catch {
    return null;
  }
  const dir = dirname(bat);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^@?(echo|setlocal|rem|set|chcp|pushd|popd)\b/i.test(line)) {
      continue;
    }
    const m = line.match(/^@?"([^"]+)"\s+"([^"]+)"\s*%?\*?\s*$/);
    if (!m) {
      continue;
    }
    const expand = (s) => s
      .replace(/%~dp0/gi, dir + '\\')
      .replace(/%~dpn0/gi, join(dir, basename(bat, extname(bat))));
    const interpreter = expand(m[1]);
    const script = expand(m[2]);
    if (/\.(exe|com)$/i.test(interpreter) && existsSync(interpreter) && existsSync(script)) {
      return { interpreter, script };
    }
  }
  return null;
}

/**
 * True when the given path is an AsciiDoc document.
 * @param {string} path
 * @returns {boolean}
 */
function isAsciiDoc(path) {
  return EXT_RE.test(path || '');
}

/**
 * A stable per-document preview source path, hidden next to the real document.
 *
 * The file is co-located with the real document (rather than the OS temp dir)
 * because asciidoctor resolves `include::` and relative references strictly
 * against the source file's own directory. Falls back to the OS temp dir only
 * when the document directory is unknown.
 * @param {string} docPath Vault-relative document path.
 * @param {string} [docDir] Absolute directory of the document.
 * @returns {string}
 */
function tempSourcePath(docPath, docDir) {
  const base = String(docPath || 'doc')
    .split(/[\\/]/)
    .pop()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '');
  const bare = base.replace(/\.(adoc|asciidoc|ad)$/i, '');
  const name = '.' + bare + '.preview.adoc';
  if (docDir) {
    return join(docDir, name);
  }
  return join(tmpdir(), name);
}

/**
 * Convert a filesystem directory into a `file://` base URL string.
 * @param {string} dir Absolute directory path.
 * @returns {string}
 */
function fileBaseHref(dir) {
  if (!dir) {
    return '';
  }
  const forward = dir.split('\\').join('/');
  let out;
  const m = forward.match(/^([A-Za-z]:)(.*)$/);
  if (m) {
    // Windows drive path: keep the drive colon literal.
    out = 'file:///' + m[1] + m[2].split('/').map(encodeURIComponent).join('/');
  } else {
    out = 'file://' + forward.split('/').map(encodeURIComponent).join('/');
  }
  if (!/\/$/.test(out)) {
    out += '/';
  }
  return out;
}

/**
 * Inject a <base href> into the rendered HTML head so that relative
 * references (images, links) resolve against the real document directory.
 * @param {string} html
 * @param {string} baseHref
 * @returns {string}
 */
function injectBase(html, baseHref) {
  if (!baseHref || html.indexOf('<base ') !== -1 || html.indexOf('<head') === -1) {
    return html;
  }
  return html.replace(/<head[^>]*>/i, (m) => m + '<base href="' + baseHref + '">');
}

/**
 * Force the code font in the rendered HTML to match Obsidian's configured
 * monospace font. Needs `!important` because asciidoctor's embedded default
 * stylesheet sets its own font-family on pre/code.
 * @param {string} html
 * @param {string} [monoFont] A CSS font-family list (e.g. from `--font-monospace`).
 * @returns {string}
 */
function injectFont(html, monoFont) {
  const font = (monoFont || '').trim() ||
    '"FiraCode Nerd Font","Fira Code",Consolas,"Courier New",monospace';
  if (!html || html.indexOf('asciidoc-preview-font') !== -1 || html.indexOf('</head>') === -1) {
    return html;
  }
  const style =
    '<style id="asciidoc-preview-font">' +
    'pre,code,kbd,samp,.listingblock code,.literalblock code,.source code' +
    '{font-family:' + font + ' !important;}' +
    '</style></head>';
  return html.replace('</head>', style);
}

/**
 * Render AsciiDoc text with the local asciidoctor CLI.
 *
 * The buffer text is written to a UTF-8 file hidden next to the real document
 * (asciidoctor must not be fed via stdin: on Windows Ruby reads stdin with the
 * locale codepage and mangles non-ASCII; and co-locating the source is required
 * so `include::` and other file-relative references resolve against the real
 * document folder).
 *
 * @param {object} opts
 * @param {string} [opts.executable='asciidoctor'] asciidoctor command or path.
 * @param {string} opts.docPath Vault-relative path of the document (for the temp filename).
 * @param {string} opts.docDir Absolute path of the document's folder (cwd + docdir).
 * @param {string} opts.text Current document text.
 * @param {number} [opts.maxFileSizeKb=4096] Reject documents larger than this.
 * @param {string} [opts.baseHref=''] Optional file:// base URL for relative resources.
 * @param {string} [opts.monoFont=''] Optional CSS font-family list for code blocks.
 * @param {number} [opts.timeoutMs=20000] Kill asciidoctor after this long.
 * @returns {Promise<string>} Resolves with the rendered HTML document.
 */
function render(opts) {
  const executable = opts.executable || 'asciidoctor';
  const text = opts.text == null ? '' : String(opts.text);
  const docDir = opts.docDir || '';
  const maxSize = opts.maxFileSizeKb ? opts.maxFileSizeKb * 1024 : 0;
  const timeoutMs = opts.timeoutMs || 20000;
  const baseHref = opts.baseHref || '';

  if (maxSize && text.length > maxSize) {
    const err = new Error('Document exceeds maxFileSizeKb (' + opts.maxFileSizeKb + ' KB); not rendering.');
    err.docTooLarge = true;
    return Promise.reject(err);
  }

  const src = tempSourcePath(opts.docPath || 'doc', docDir || undefined);

  return new Promise((resolve, reject) => {
    const done = (execErr, stdout, stderr) => {
      unlink(src, () => {});
      if (execErr) {
        const detail = (stderr || execErr.message || '').trim();
        const err = new Error(detail || ('asciidoctor exited with ' + execErr.code));
        err.stdout = stdout;
        reject(err);
        return;
      }
      resolve(injectFont(injectBase(stdout, baseHref), opts.monoFont));
    };

    const spawnOpts = {
      cwd: docDir || undefined,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    };

    writeFile(src, text, { encoding: 'utf8' }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      const args = ['-b', 'html5', '-o', '-'];
      if (docDir) {
        args.push('-a', 'docdir=' + docDir);
      }
      args.push(src);

      const resolved = resolveExecutable(executable);
      let spawnArgs = args;
      if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(resolved)) {
        const int = interpretBatch(resolved);
        if (!int) {
          reject(new Error('Cannot interpret .bat/.cmd "' + resolved + '"; set "executable" to the real interpreter instead.'));
          return;
        }
        spawnArgs = [int.script].concat(args);
        execFile(int.interpreter, spawnArgs, spawnOpts, done);
      } else {
        execFile(resolved, spawnArgs, spawnOpts, done);
      }
    });
  });
}

module.exports = { render, isAsciiDoc, tempSourcePath, fileBaseHref, injectBase, injectFont, resolveExecutable, interpretBatch };
return module.exports;
})({ exports: {} });

const VIEW_TYPE = 'asciidoc-preview';

const DEFAULT_SETTINGS = {
  executable: 'asciidoctor',
  debounceMs: 400,
  mode: 'live', // 'live' | 'save'
  autoOpen: true,
  maxFileSizeKb: 4096,
  monoFont: '', // e.g. 'FiraCode Nerd Font'
};

/* ------------------------------------------------------------------ */
/* View                                                               */
/* ------------------------------------------------------------------ */

function escHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function simplePage(body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
    'font-size:13px;line-height:1.5;padding:20px;color:#c0392b;}' +
    '</style></head><body>' +
    body +
    '</body></html>'
  );
}

class AsciiDocPreviewView extends ItemView {
  /** @param {import('obsidian').WorkspaceLeaf} leaf @param {AsciiDocPreviewPlugin} plugin */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'AsciiDoc Preview';
  }

  getIcon() {
    return 'book-open';
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.classList.add('asciidoc-preview');
    this.statusEl = this.contentEl.createDiv({ cls: 'asciidoc-preview__status', text: '' });
    this.frameEl = this.contentEl.createDiv({ cls: 'asciidoc-preview__frame' });
    this.frame = this.frameEl.createEl('iframe');
    this.frame.setAttribute('sandbox', 'allow-same-origin');
    this.frame.setAttribute('referrerpolicy', 'no-referrer');
  }

  async onClose() {
    this.frame = null;
    this.statusEl = null;
  }

  /** @param {string} title */
  setContent(title, html) {
    if (!this.statusEl || !this.frame) {
      return;
    }
    this.statusEl.setText(title || '');
    this.frame.setAttribute('srcdoc', html);
  }

  /** @param {string} err */
  setError(title, err) {
    if (!this.statusEl || !this.frame) {
      return;
    }
    this.statusEl.setText((title ? title + ' — ' : '') + 'rendering failed');
    this.frame.setAttribute('srcdoc', simplePage(escHtml(err || 'unknown error')));
  }

  /** @param {string} msg */
  setMessage(msg) {
    if (!this.statusEl || !this.frame) {
      return;
    }
    this.statusEl.setText(msg);
    this.frame.setAttribute('srcdoc', simplePage(escHtml(msg)));
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

module.exports = class AsciiDocPreviewPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.rendering = false;
    this.renderPending = false;
    this.renderGeneration = 0;
    this.currentFilePath = null;

    this.registerView(VIEW_TYPE, (leaf) => new AsciiDocPreviewView(leaf, this));
    this.registerExtensions(['adoc', 'asciidoc', 'ad'], 'markdown');

    this.addRibbonIcon('book-open', 'Toggle AsciiDoc side-by-side preview', () => this.togglePreview());
    this.addCommand({
      id: 'toggle-preview',
      name: 'Toggle AsciiDoc side-by-side preview',
      callback: () => this.togglePreview(),
    });
    this.addCommand({
      id: 'toggle-mode',
      name: 'Toggle live / on-save preview mode',
      callback: () => {
        this.settings.mode = this.settings.mode === 'live' ? 'save' : 'live';
        this.saveData(this.settings);
        this.updateStatus();
        new Notice('AsciiDoc preview mode: ' + this.settings.mode);
        this.requestRender();
      },
    });
    this.addCommand({
      id: 're-render',
      name: 'Re-render AsciiDoc preview',
      callback: () => this.requestRender(true),
    });

    this.debouncedRender = debounce(() => this.requestRender(), this.settings.debounceMs, true);

    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        if (this.settings.mode !== 'live' || this.getPreviewLeaves().length === 0) {
          return;
        }
        this.debouncedRender();
      })
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.settings.mode !== 'save' || this.getPreviewLeaves().length === 0 || !renderer.isAsciiDoc(file.path)) {
          return;
        }
        this.debouncedRender();
      })
    );
    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        const file = this.app.workspace.getActiveFile();
        this.updateStatus();
        if (this.getPreviewLeaves().length === 0) {
          if (this.settings.autoOpen && renderer.isAsciiDoc(file && file.path)) {
            this.togglePreview();
          }
          return;
        }
        if (renderer.isAsciiDoc(file && file.path)) {
          this.debouncedRender();
        } else {
          this.app.workspace.detachLeavesOfType(VIEW_TYPE);
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updateStatus();
        if (this.getPreviewLeaves().length === 0 || this.isPreviewActive()) {
          return;
        }
        const file = this.app.workspace.getActiveFile();
        if (renderer.isAsciiDoc(file && file.path)) {
          this.debouncedRender();
        } else {
          this.app.workspace.detachLeavesOfType(VIEW_TYPE);
        }
      })
    );

    this.addSettingTab(new AsciiDocPreviewSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatus();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /* ------------------------------ helpers ------------------------------ */

  getPreviewLeaves() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE);
  }

  /** True when the preview pane itself currently has focus. */
  isPreviewActive() {
    const leaf = this.app.workspace.activeLeaf;
    return !!(leaf && leaf.view && leaf.view.getViewType && leaf.view.getViewType() === VIEW_TYPE);
  }

  /**
   * Open a preview pane to the right of the active pane, or close it if it is
   * already open.
   * @param {boolean|undefined} forceOpen
   */
  async togglePreview(forceOpen) {
    const open = forceOpen === undefined ? this.getPreviewLeaves().length === 0 : forceOpen;
    if (!open) {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE);
      return;
    }
    const leaf = this.app.workspace.getLeaf('split', 'vertical');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    await this.requestRender(true);
  }

  /** Absolute filesystem directory of a vault file, when available. */
  docDirFor(file) {
    try {
      const folder = file.parent ? file.parent.path : '';
      const absolute = this.app.vault.adapter.getFullPath(folder);
      return absolute || folder;
    } catch (e) {
      return (file.parent && file.parent.path) || '';
    }
  }

  /**
   * Render the active file into the preview pane.
   * @param {boolean} [force] Skip the debounce / pending coalescing.
   */
  async requestRender(force) {
    const leaves = this.getPreviewLeaves();
    if (leaves.length === 0) {
      return;
    }
    const view = this.getPreviewLeaves()[0].view;
    let file = this.app.workspace.getActiveFile();
    if (!file && this.isPreviewActive() && this.currentFilePath) {
      file = this.app.vault.getAbstractFileByPath(this.currentFilePath);
    }
    if (!file) {
      view.setMessage('No active file.');
      return;
    }
    if (!renderer.isAsciiDoc(file.path)) {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE);
      return;
    }
    this.currentFilePath = file.path;

    if (this.rendering) {
      this.renderPending = true;
      return;
    }
    this.rendering = true;
    const gen = ++this.renderGeneration;
    if (!force) {
      this.debouncedRender.cancel();
    }

    try {
      let text = null;
      const active = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (active && active.file && active.file.path === file.path) {
        text = active.editor.getValue();
      } else {
        try {
          text = await this.app.vault.cachedRead(file);
        } catch (e) {
          text = await this.app.vault.read(file);
        }
      }
      if (gen !== this.renderGeneration) {
        return;
      }
      const docDir = this.docDirFor(file);
      const html = await renderer.render({
        executable: this.settings.executable,
        docPath: file.path,
        docDir: docDir,
        text: text || '',
        maxFileSizeKb: this.settings.maxFileSizeKb,
        baseHref: renderer.fileBaseHref(docDir),
        monoFont: this.monospaceFont(),
      });
      if (gen !== this.renderGeneration) {
        return;
      }
      view.setContent(file.basename, html);
    } catch (err) {
      if (gen === this.renderGeneration) {
        view.setError(file.basename, err.message);
      }
    } finally {
      this.rendering = false;
      if (this.renderPending) {
        this.renderPending = false;
        this.requestRender();
      }
    }
  }

  /** User override, else Obsidian's configured monospace font. */
  monospaceFont() {
    const override = (this.settings.monoFont || '').trim();
    if (override) {
      return override;
    }
    try {
      const v = getComputedStyle(document.body).getPropertyValue('--font-monospace').trim();
      return v && v !== 'inherit' ? v : '';
    } catch (e) {
      return '';
    }
  }

  updateStatus() {
    if (!this.statusBarEl) {
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (renderer.isAsciiDoc(file && file.path)) {
      this.statusBarEl.setText('AsciiDoc ' + (this.settings.mode === 'live' ? 'LIVE' : 'SAVE'));
    } else {
      this.statusBarEl.setText('');
    }
  }
};

/* ------------------------------------------------------------------ */
/* Settings tab                                                       */
/* ------------------------------------------------------------------ */

class AsciiDocPreviewSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('asciidoctor executable')
      .setDesc('Command or absolute path used to render. Leave as `asciidoctor` if it is on PATH.')
      .addText((text) =>
        text
          .setPlaceholder('asciidoctor')
          .setValue(this.plugin.settings.executable)
          .onChange(async (value) => {
            this.plugin.settings.executable = value.trim() || 'asciidoctor';
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('Preview mode')
      .setDesc('live = re-render while typing, save = re-render when the file is saved.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('live', 'Live')
          .addOption('save', 'On save')
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            this.plugin.settings.mode = value;
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.updateStatus();
            this.plugin.requestRender();
          })
      );

    new Setting(containerEl)
      .setName('Debounce (ms)')
      .setDesc('Minimum delay between live re-renders while typing.')
      .addText((text) =>
        text
          .setPlaceholder('400')
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.debounceMs = Number.isFinite(n) && n > 0 ? n : 400;
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.debouncedRender = debounce(
              () => this.plugin.requestRender(),
              this.plugin.settings.debounceMs,
              true
            );
          })
      );

    new Setting(containerEl)
      .setName('Max file size (KB)')
      .setDesc('Documents larger than this are not rendered (avoids hammering asciidoctor).')
      .addText((text) =>
        text
          .setPlaceholder('4096')
          .setValue(String(this.plugin.settings.maxFileSizeKb))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.maxFileSizeKb = Number.isFinite(n) && n > 0 ? n : 4096;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('Preview monospace font')
      .setDesc('Font used for code blocks in the preview. Leave empty to use Obsidian\'s monospace font (e.g. from Settings → Appearance → Font).')
      .addText((text) =>
        text
          .setPlaceholder('FiraCode Nerd Font')
          .setValue(this.plugin.settings.monoFont || '')
          .onChange(async (value) => {
            this.plugin.settings.monoFont = value.trim();
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.requestRender();
          })
      );

    new Setting(containerEl)
      .setName('Auto-open preview')
      .setDesc('Open the side-by-side preview automatically when an AsciiDoc file is opened.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoOpen)
          .onChange(async (value) => {
            this.plugin.settings.autoOpen = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
  }
}