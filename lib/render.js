'use strict';

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

let _jsDeps = null;

/** Lazily load the bundled asciidoctor.js / highlight.js (keeps CLI-only use cheap). */
function jsDeps() {
  if (_jsDeps) {
    return _jsDeps;
  }
  const Asciidoctor = require('@asciidoctor/core');
  const hljs = require('highlight.js');
  _jsDeps = {
    asciidoctor: Asciidoctor(),
    hljs,
    css: { light: loadHighlightCss('light'), dark: loadHighlightCss('dark') },
  };
  return _jsDeps;
}

/**
 * Read a highlight.js theme. esbuild inlines the literal `require`s at build
 * time; the fs branch keeps the module usable under plain Node (tests).
 * @param {'light'|'dark'} which
 * @returns {string}
 */
function loadHighlightCss(which) {
  if (which === 'dark') {
    try {
      return require('highlight.js/styles/github-dark.css');
    } catch {
      return readCssFromDisk('github-dark.css');
    }
  }
  try {
    return require('highlight.js/styles/github.css');
  } catch {
    return readCssFromDisk('github.css');
  }
}

function readCssFromDisk(name) {
  try {
    const base = dirname(require.resolve('highlight.js/package.json'));
    return readFileSync(join(base, 'styles', name), 'utf8');
  } catch {
    return '';
  }
}

function unescapeHtml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Tokenize asciidoctor.js listing blocks with highlight.js. asciidoctor.js
 * emits `<pre class="highlight"><code class="language-x">escaped</code></pre>`
 * when no server-side highlighter is configured.
 * @param {string} html
 * @param {import('highlight.js')} hljs
 * @returns {string}
 */
function highlightCodeBlocks(html, hljs) {
  return html.replace(
    /<pre class="highlight"><code class="language-([\w#+.-]+)"[^>]*>([\s\S]*?)<\/code><\/pre>/g,
    (match, lang, code) => {
      const src = unescapeHtml(code);
      let out;
      try {
        out = hljs.getLanguage(lang)
          ? hljs.highlight(src, { language: lang }).value
          : hljs.highlightAuto(src).value;
      } catch {
        return match;
      }
      return '<pre class="highlight"><code class="hljs language-' + lang + '">' + out + '</code></pre>';
    }
  );
}

function injectHighlightCss(html, css) {
  if (!css || html.indexOf('asciidoc-preview-hljs') !== -1 || html.indexOf('</head>') === -1) {
    return html;
  }
  return html.replace('</head>', '<style id="asciidoc-preview-hljs">' + css + '</style></head>');
}

/**
 * Render AsciiDoc with the bundled asciidoctor.js (no Ruby required) and, when
 * a highlighter is configured, tokenize `[source]` blocks with highlight.js.
 * The stylesheet is embedded by asciidoctor.js (`linkcss=false`) and the
 * highlight.js theme is injected as a `<style>` block.
 * @param {object} opts Same options as `renderWithCli`, plus `darkTheme`.
 * @returns {Promise<string>}
 */
function renderWithJs(opts) {
  const text = opts.text == null ? '' : String(opts.text);
  const maxSize = opts.maxFileSizeKb ? opts.maxFileSizeKb * 1024 : 0;
  const baseHref = opts.baseHref || '';
  if (maxSize && text.length > maxSize) {
    const err = new Error('Document exceeds maxFileSizeKb (' + opts.maxFileSizeKb + ' KB); not rendering.');
    err.docTooLarge = true;
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let deps;
    try {
      deps = jsDeps();
    } catch (e) {
      reject(new Error('asciidoctor.js is unavailable: ' + (e && e.message ? e.message : e)));
      return;
    }
    try {
      let html = deps.asciidoctor.convert(text, {
        backend: 'html5',
        header_footer: true,
        attributes: { linkcss: false },
      });
      if ((opts.sourceHighlighter || '').trim()) {
        html = highlightCodeBlocks(html, deps.hljs);
        html = injectHighlightCss(html, opts.darkTheme ? deps.css.dark : deps.css.light);
      }
      resolve(injectFont(injectBase(html, baseHref), opts.monoFont));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Pick a renderer. `cli` uses the local asciidoctor executable, `js` uses the
 * bundled asciidoctor.js, `auto` prefers the CLI and falls back to JS when it
 * is missing or cannot be launched.
 * @param {object} opts
 * @param {'auto'|'cli'|'js'} [opts.renderer='auto']
 * @returns {Promise<string>}
 */
function render(opts) {
  const which = (opts.renderer || 'auto').trim().toLowerCase();
  if (which === 'js') {
    return renderWithJs(opts);
  }
  if (which === 'cli') {
    return renderWithCli(opts);
  }
  const available = cliAvailable(opts.executable || 'asciidoctor');
  if (!available) {
    return renderWithJs(opts);
  }
  return renderWithCli(opts).catch((err) => {
    if (err && err.docTooLarge) {
      throw err;
    }
    if (isUnavailableError(err)) {
      return renderWithJs(opts);
    }
    throw err;
  });
}

/** @param {string} executable */
function cliAvailable(executable) {
  const resolved = resolveExecutable(executable);
  return /[\\/]/.test(resolved) && existsSync(resolved);
}

/** @param {Error} err */
function isUnavailableError(err) {
  const msg = String((err && err.message) || '');
  const code = err && err.code;
  return code === 'ENOENT' || code === 'EACCES' || /ENOENT|not recognized|not found|no such file/i.test(msg);
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
 * @param {string} [opts.sourceHighlighter=''] e.g. 'rouge'; silently skipped if unavailable.
 * @param {number} [opts.timeoutMs=20000] Kill asciidoctor after this long.
 * @returns {Promise<string>} Resolves with the rendered HTML document.
 */
function renderWithCli(opts) {
  const executable = opts.executable || 'asciidoctor';
  const text = opts.text == null ? '' : String(opts.text);
  const docDir = opts.docDir || '';
  const maxSize = opts.maxFileSizeKb ? opts.maxFileSizeKb * 1024 : 0;
  const timeoutMs = opts.timeoutMs || 20000;
  const baseHref = opts.baseHref || '';
  const highlighter = (opts.sourceHighlighter || '').trim();

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
      const buildArgs = (hl) => {
        const a = ['-b', 'html5', '-o', '-'];
        if (docDir) {
          a.push('-a', 'docdir=' + docDir);
        }
        if (hl) {
          a.push('-a', 'source-highlighter=' + hl);
        }
        a.push(src);
        return a;
      };

      const resolved = resolveExecutable(executable);
      let launch;
      if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(resolved)) {
        const int = interpretBatch(resolved);
        if (!int) {
          reject(new Error('Cannot interpret .bat/.cmd "' + resolved + '"; set "executable" to the real interpreter instead.'));
          return;
        }
        launch = (hl, cb) => execFile(int.interpreter, [int.script].concat(buildArgs(hl)), spawnOpts, cb);
      } else {
        launch = (hl, cb) => execFile(resolved, buildArgs(hl), spawnOpts, cb);
      }

      const finish = (execErr, stdout, stderr) => {
        if (execErr && highlighter && /highlighter/i.test(String(stderr || execErr.message || ''))) {
          launch('', done);
          return;
        }
        done(execErr, stdout, stderr);
      };

      launch(highlighter, finish);
    });
  });
}

module.exports = { render, renderWithCli, renderWithJs, isAsciiDoc, tempSourcePath, fileBaseHref, injectBase, injectFont, highlightCodeBlocks, resolveExecutable, interpretBatch };