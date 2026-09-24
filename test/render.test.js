'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const { render, isAsciiDoc, fileBaseHref, injectBase, injectFont, resolveExecutable, interpretBatch } = require('../lib/render.js');

const EXE = 'asciidoctor';

test('isAsciiDoc detects adoc/asciidoc/ad extensions', () => {
  assert.equal(isAsciiDoc('notes/guide.adoc'), true);
  assert.equal(isAsciiDoc('notes/guide.asciidoc'), true);
  assert.equal(isAsciiDoc('notes/guide.ad'), true);
  assert.equal(isAsciiDoc('notes/guide.adoc.md'), false);
  assert.equal(isAsciiDoc('notes/guide.txt'), false);
  assert.equal(isAsciiDoc(''), false);
  assert.equal(isAsciiDoc('notes/大写.adoc'), true);
});

test('fileBaseHref handles Windows and spaces', () => {
  assert.equal(fileBaseHref('C:\\Users\\Ahri\\My Vault\\docs'), 'file:///C:/Users/Ahri/My%20Vault/docs/');
  assert.equal(fileBaseHref('/home/u/docs'), 'file:///home/u/docs/');
  assert.equal(fileBaseHref(''), '');
});

test('injectBase only injects once when a head exists', () => {
  const html = '<!doctype html><html><head>\n<meta charset="utf-8">\n</head><body>hi</body></html>';
  const once = injectBase(html, 'file:///C:/docs/');
  assert.match(once, /<head[^>]*><base href="file:\/\/\/C:\/docs\/">/);
  const twice = injectBase(once, 'file:///C:/docs/');
  assert.equal(twice, once);
  assert.equal(injectBase('<html><body>x</body></html>', 'file:///C:/'), '<html><body>x</body></html>');
});

test('injectFont forces the given code font and is idempotent', () => {
  const html = '<html><head></head><body><pre>x</pre></body></html>';
  const once = injectFont(html, '"FiraCode Nerd Font",Consolas');
  assert.match(once, /font-family:"FiraCode Nerd Font",Consolas !important;/);
  assert.equal(injectFont(once, '"FiraCode Nerd Font",Consolas'), once);
  const fallback = injectFont('<html><head></head><body></body></html>', '');
  assert.match(fallback, /--font-monospace|FiraCode|Consolas|monospace/);
  assert.equal(injectFont('<html><body>x</body></html>', 'x-font'), '<html><body>x</body></html>');
});

test('render produces html and preserves UTF-8 text', async () => {
  const html = await render({
    executable: EXE,
    docPath: 'utf8.adoc',
    docDir: tmpdir(),
    text: '= Héllo\n\n日本語のテキストと café des élèves.',
  });
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.ok(html.includes('Héllo'), 'ascii title mangled');
  assert.ok(html.includes('日本語のテキストと café des élèves.'), 'utf-8 body mangled');
  assert.ok(html.includes('<meta charset="UTF-8">') || html.includes('<meta charset=\'UTF-8\'>'));
});

test('render resolves include:: relative to docDir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asd-test-'));
  try {
    writeFileSync(join(dir, 'part.adoc'), 'インクルードされた行, café.', 'utf8');
    const html = await render({
      executable: EXE,
      docPath: 'doc/main.adoc',
      docDir: dir,
      text: '= Main\n\ninclude::part.adoc[]',
      baseHref: fileBaseHref(dir),
    });
    assert.ok(html.includes('インクルードされた行, café.'), 'include not resolved');
    assert.ok(html.includes('<base href="'), 'base href not injected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render highlights [source] blocks with rouge', async () => {
  const html = await render({
    executable: EXE,
    docPath: 'hl.adoc',
    docDir: tmpdir(),
    text: '= H\n\n[source,scala]\n----\nobject Hello\n----',
    sourceHighlighter: 'rouge',
  });
  assert.match(html, /class="rouge highlight"/);
  assert.match(html, /<span class="k">object<\/span>/);
  assert.match(html, /pre\.rouge/);
});

test('render silently falls back when the highlighter is unavailable', async () => {
  const html = await render({
    executable: EXE,
    docPath: 'hl2.adoc',
    docDir: tmpdir(),
    text: '= H\n\n[source,scala]\n----\nobject Hello\n----',
    sourceHighlighter: 'definitely-not-a-real-highlighter',
  });
  assert.match(html, /<pre class="highlight">/);
  assert.doesNotMatch(html, /class="rouge highlight"/);
});

test('render rejects oversized documents before spawning', async () => {
  await assert.rejects(
    render({ executable: EXE, docPath: 'big.adoc', docDir: tmpdir(), text: 'x'.repeat(10), maxFileSizeKb: 0.001 }),
    /maxFileSizeKb/
  );
});

test('render rejects when the executable is missing', async () => {
  await assert.rejects(render({ executable: 'definitely-not-a-real-asciidoctor', docPath: 'x.adoc', docDir: tmpdir(), text: '= x', timeoutMs: 8000 }));
});

test('render surfaces asciidoctor stderr in the rejection message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asd-test-'));
  try {
    if (process.platform !== 'win32') {
      await assert.rejects(
        render({ executable: 'definitely-not-a-real-asciidoctor', docPath: 'x.adoc', docDir: dir, text: '= x', timeoutMs: 8000 })
      );
      return;
    }
    const realBat = resolveExecutable(EXE);
    const real = /\.(bat|cmd)$/i.test(realBat) ? interpretBatch(realBat) : null;
    assert.ok(real, 'expected asciidoctor.bat + ruby interpreter on this machine');
    const stub = join(dir, 'stub.cmd');
    const run = join(dir, 'stub-run.rb');
    writeFileSync(stub, '@ECHO OFF\r\n@"' + real.interpreter + '" "%~dp0\\stub-run.rb" %*\r\n', 'utf8');
    writeFileSync(run, "STDERR.puts 'FAKE_ASCIIDOCTOR_ERROR'\nexit 3\n", 'utf8');
    await assert.rejects(
      render({ executable: stub, docPath: 'x.adoc', docDir: dir, text: '= x', timeoutMs: 8000 }),
      /FAKE_ASCIIDOCTOR_ERROR/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});