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