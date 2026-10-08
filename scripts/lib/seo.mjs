import fs from 'node:fs/promises';
import path from 'node:path';

export const ORIGIN = 'https://6ixo.com';
export const ROBOTS = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';
export const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export const decode = value => String(value ?? '').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
export const jsonLd = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
export const truncate = (value, max) => clean(value).length <= max ? clean(value) : `${clean(value).slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`;
export const slugify = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58) || 'listing';
export const httpUrl = value => {
  try { const url = new URL(clean(value)); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
};
export const pageFile = pathname => pathname === '/' ? 'index.html' : path.join(pathname.slice(1), 'index.html');
export const meta = (html, attribute, value, wanted = 'content', element = 'meta') => {
  const tag = [...html.matchAll(new RegExp(`<${element}\\b[^>]*>`, 'gi'))].map(m => m[0]).find(t => new RegExp(`\\b${attribute}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(t));
  return decode(tag?.match(new RegExp(`\\b${wanted}=(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] ?? '');
};
export async function writeChanged(filename, contents) {
  try { if (await fs.readFile(filename, 'utf8') === contents) return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
  return true;
}
export function parseCsv(input) {
  const rows = []; let row = [], cell = '', quoted = false;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { pushCell(); if (row.some(clean)) rows.push(row); row = []; };
  input = String(input).replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) { if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char; }
    else if (char === '"') quoted = true;
    else if (char === ',') pushCell(); else if (char === '\n') pushRow(); else if (char !== '\r') cell += char;
  }
  if (cell || row.length) pushRow();
  const headers = (rows.shift() || []).map(clean);
  return rows.map(values => Object.fromEntries(headers.map((header, i) => [header, values[i] || ''])));
}

// Google's longest matching rule wins; Allow wins a tie. Includes query strings.
export function crawlAllowed(url, robots) {
  const parsed = new URL(url, ORIGIN);
  const target = parsed.pathname + parsed.search;
  const rules = []; let applies = false, sawRule = false;
  for (const line of robots.split(/\r?\n/)) {
    const match = line.replace(/#.*$/, '').trim().match(/^(user-agent|allow|disallow):\s*(.*)$/i);
    if (!match) continue;
    const [, rawKind, value] = match, kind = rawKind.toLowerCase();
    if (kind === 'user-agent') { applies = sawRule ? value === '*' : applies || value === '*'; sawRule = false; continue; }
    sawRule = true;
    if (!applies || !value) continue;
    const expression = '^' + value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    if (new RegExp(expression).test(target)) rules.push({ allow: kind === 'allow', length: value.replace(/[*$]/g, '').length });
  }
  rules.sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
  return rules[0]?.allow ?? true;
}
