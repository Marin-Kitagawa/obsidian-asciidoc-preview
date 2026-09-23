'use strict';

const { Plugin, ItemView, MarkdownView, Notice, debounce, PluginSettingTab, Setting } = require('obsidian');
const renderer = require('./lib/render.js');

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
        this.debouncedRender();
      })
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updateStatus();
        if (this.getPreviewLeaves().length > 0) {
          this.debouncedRender();
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
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      view.setMessage('No active file.');
      return;
    }
    if (!renderer.isAsciiDoc(file.path)) {
      view.setMessage(file.name + ' is not an AsciiDoc file.');
      return;
    }

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