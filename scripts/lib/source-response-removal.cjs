// A failed or redirected request is not proof that the original item disappeared.
module.exports = function sourceResponseRemoval(meta, html, sourceUrl) {
  const status = Number(meta.status || 0);
  if (!status || [401, 403, 429].includes(status) || status >= 500) return false;
  const headings = [...String(html || '').matchAll(/<(?:title|h1)\b[^>]*>([\s\S]*?)<\/(?:title|h1)>/gi)]
    .map(match => match[1].replace(/<[^>]*>/g, ' ')).join(' ');
  if (/just a moment|access denied|verify you are human|attention required|captcha|too many requests|unusual traffic|security check/i.test(headings)) return false;
  try {
    const source = new URL(sourceUrl);
    const resolved = new URL(meta.resolvedUrl || sourceUrl);
    const host = url => url.hostname.replace(/^www\./, '').toLowerCase();
    if (host(source) !== host(resolved)) return false;
    const removed = resolved.searchParams.get('adRemoved');
    const ownId = source.pathname.match(/\/(\d+)\/?$/)?.[1];
    if (host(source) === 'kijiji.ca' && (removed === 'true' || (ownId && removed === ownId))) return true;
    if (source.pathname.replace(/\/$/, '') !== resolved.pathname.replace(/\/$/, '')) return false;
    return [404, 410].includes(status);
  } catch { return false; }
};
