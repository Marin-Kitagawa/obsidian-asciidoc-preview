'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const DIST = join(__dirname, '..', 'dist', 'main.js');

/**
 * Minimal stand-ins for the pieces of `obsidian` our plugin pulls in at load
 * and onload time. Mirrors the surface Obsidian's real module map exposes.
 */
function obsidianStub() {
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    registerView() {} registerExtensions() {} addRibbonIcon() { return {}; } addCommand() {} registerEvent() {}
    addSettingTab() {} addStatusBarItem() { return { setText() {} }; }
    async loadData() { return null; } async saveData() { return null; }
    async load() { await this.onload(); }
  }
  class ItemView { constructor(leaf) { this.leaf = leaf; } }
  class MarkdownView {}
  class Notice {}
  class Modal { constructor(app) { this.app = app; } open() {} close() {} }
  class TFolder {}
  class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
  class Setting { constructor() {} setName() { return this; } setDesc() { return this; } addText() { return this; } addDropdown() { return this; } addToggle() { return this; } }
  function debounce(fn, wait, reset) { const f = (...a) => setTimeout(() => fn(...a), wait); f.cancel = () => {}; return f; }
  return { Plugin, ItemView, MarkdownView, Notice, Modal, TFolder, debounce, PluginSettingTab, Setting };
}

/** Emulates the whitespace/source-map trimming + window.eval wrapper. */
function evalPluginSource(source, o) {
  // eslint-disable-next-line no-new-func
  const run = new Function('require', 'module', 'exports', source);
  const module = { exports: {} };
  run(o.require, module, module.exports);
  return module;
}

test('bundled main.js loads and starts like Obsidian does', async () => {
  assert.ok(existsSync(DIST), 'run `node build.js` before testing the bundle');

  const source = readFileSync(DIST, 'utf8');
  const api = obsidianStub();

  // Obsidian's require shim: whitelisted 'obsidian' API map, Node core via the
  // real Node require, anything else = an unresolvable module (as in real life).
  const allowlist = new Map([
    ['obsidian', api],
    ['.', null],
  ]);
  const fakeRequire = (name) => {
    if (allowlist.has(name)) {
      return allowlist.get(name);
    }
    try {
      // Only true Node builtins are available on the desktop shim's fallback.
      return require(name);
    } catch (e) {
      throw new Error("Cannot find module '" + name + "'");
    }
  };

  const mod = evalPluginSource(source, { require: fakeRequire });
  const PluginClass = (mod.exports.default || mod.exports) || undefined;
  assert.ok(PluginClass, 'no plugin class exported');

  const newEl = () => ({ empty() {}, classList: { add() {} }, setText() {}, setAttribute() {}, createDiv() { return newEl(); }, createEl() { return newEl(); } });
  const workspace = {
    getLeavesOfType() { return []; },
    getLeaf() { return {}; },
    revealLeaf() { return Promise.resolve(); },
    getActiveFile() { return null; },
    getActiveViewOfType() { return null; },
    on() { return () => {}; },
    detachLeavesOfType() {},
  };
  const app = { workspace, vault: { on: () => () => {}, cachedRead: () => Promise.resolve(''), read: () => Promise.resolve(''), adapter: { getFullPath: () => 'C:/Vault' } } };

  const plugin = new PluginClass(app, { name: 'AsciiDoc Preview', id: 'asciidoc-preview', dir: '.obsidian/plugins/asciidoc-preview' });
  await plugin.load();
  assert.ok(true, 'onload completed without throwing');
});