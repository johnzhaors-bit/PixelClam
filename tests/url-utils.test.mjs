import assert from 'node:assert/strict';
import test from 'node:test';
import urlUtils from '../src/main/url-utils.cjs';

const { normalizeAuditUrl } = urlUtils;

test('保留完整网页和文件地址', () => {
  assert.equal(normalizeAuditUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeAuditUrl('file:///tmp/demo.html'), 'file:///tmp/demo.html');
  assert.equal(normalizeAuditUrl('/tmp/demo.html'), 'file:///tmp/demo.html');
});

test('本机地址可省略协议', () => {
  assert.equal(normalizeAuditUrl('localhost:4174/demo.html'), 'http://localhost:4174/demo.html');
  assert.equal(normalizeAuditUrl('127.0.0.1:4174/demo.html'), 'http://127.0.0.1:4174/demo.html');
  assert.equal(normalizeAuditUrl('[::1]:4174/demo.html'), 'http://[::1]:4174/demo.html');
});

test('拒绝不完整的远程地址', () => {
  assert.throws(() => normalizeAuditUrl('example.com'), /请输入完整地址/);
});
