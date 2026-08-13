function normalizeAuditUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(https?|file):\/\//i.test(text)) return text;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text)) return `http://${text}`;
  if (text.startsWith('/')) return `file://${text}`;
  throw new Error('请输入完整地址，支持 http://、https://、file:// 或本地文件绝对路径');
}

module.exports = { normalizeAuditUrl };

