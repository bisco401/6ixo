import https from 'node:https';
import dns from 'node:dns';

// CI's public Cloudflare route can return 403 for datacenter IPs. The GitHub
// Pages origin serves the same public site; retain 6ixo's Host header, SNI,
// and normal HTTPS certificate verification. This is never used by visitors.
export async function readPublishedFile(url) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://6ixo.com') throw new Error('Publication checks must use the canonical 6ixo origin.');
  if (process.env.SIXO_VERIFY_GITHUB_PAGES_ORIGIN !== '1') {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      lookup: (_hostname, options, callback) => dns.lookup('bisco401.github.io', options, callback),
      timeout: 20000,
      headers: { 'cache-control': 'no-cache', 'user-agent': '6ixo-publication-verification/1.0' }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode === 200, status: response.statusCode, text }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Published file check timed out after 20 seconds.')));
    request.on('error', reject);
  });
}
