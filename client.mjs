// Thin client for wukusy.app's dropshipper panel. The site has no API: pages are
// server-rendered HTML, so reads scrape tables and writes replay the page's own AJAX calls.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';

export const BASE = 'https://wukusy.app';
export const SESSION_FILE = process.env.WUKUSY_SESSION_FILE || join(homedir(), '.config', 'wukusy-mcp', 'session.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export class SessionExpiredError extends Error {
  constructor() {
    super('Wukusy session expired or missing. Run `npm run login` in ~/wukusy-mcp and log in again.');
  }
}

async function loadCookie() {
  if (process.env.WUKUSY_COOKIE) return process.env.WUKUSY_COOKIE;
  try {
    const { cookies } = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
    return cookies.filter((c) => /(^|\.)wukusy\.app$/.test(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    throw new SessionExpiredError();
  }
}

// jQuery-style form encoding: arrays become key[]=v, which is what $.ajax sends.
function encodeForm(data) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(`${k}[]`, String(x)));
    else p.append(k, String(v));
  }
  return p;
}

export class Wukusy {
  #csrf = null;

  async request(path, { method = 'GET', query, form, json, multipart, csrf = false, retry = true } = {}) {
    const url = new URL(path, BASE);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { Cookie: await loadCookie(), 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/dropshiper/analytics` };
    let body;
    if (form) { body = encodeForm(form); headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; }
    if (json) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
    if (multipart) body = multipart;
    if (csrf) headers['X-CSRF-TOKEN'] = await this.csrfToken();

    const res = await fetch(url, { method, headers, body, redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    if (res.status === 401 || (res.status >= 300 && res.status < 400 && /login/i.test(loc))) {
      this.#csrf = null;
      throw new SessionExpiredError();
    }
    const text = await res.text();
    // CakePHP answers a stale/missing token with 403 + "CSRF token ... did not match".
    if (res.status === 403 && csrf && /CSRF token/i.test(text)) {
      this.#csrf = null;
      if (retry) return this.request(path, { method, query, form, json, multipart, csrf, retry: false });
    }
    if (res.status >= 400) throw new Error(`Wukusy ${method} ${url.pathname} failed: HTTP ${res.status} ${errorMessage(text)}`);
    return text;
  }

  get(path, query) { return this.request(path, { query }); }

  async html(path, query) { return cheerio.load(await this.get(path, query)); }

  // Writes need the per-session token the pages embed as `var token = "..."`.
  async csrfToken() {
    if (this.#csrf) return this.#csrf;
    const page = await this.get('/dropshiper/wallet');
    const m = page.match(/\btoken\s*=\s*["']([A-Za-z0-9+/=]{40,})["']/);
    if (!m) throw new Error('Could not find the CSRF token on /dropshiper/wallet; the page layout may have changed.');
    this.#csrf = m[1];
    return this.#csrf;
  }

  // Every write is a POST with X-CSRF-TOKEN; the reply is JSON (served as text/html)
  // like {"status":"success", ...}. dryRun returns the request instead of sending it.
  async post(path, data, { json = false, dryRun = false } = {}) {
    if (dryRun) return { dry_run: true, method: 'POST', path, encoding: json ? 'json' : 'form', body: redact(data) };
    return checkResult(path, await this.request(path, { method: 'POST', csrf: true, ...(json ? { json: data } : { form: data }) }));
  }

  async postMultipart(path, formData, { dryRun = false } = {}) {
    if (dryRun) return { dry_run: true, method: 'POST', path, encoding: 'multipart', body: redact(Object.fromEntries([...formData].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.name || ''} ${v.size} bytes>`]))) };
    return checkResult(path, await this.request(path, { method: 'POST', csrf: true, multipart: formData }));
  }
}

// Pull the human-readable message out of a CakePHP error page.
function errorMessage(text) {
  const $ = cheerio.load(text);
  return clean($('h2').first().text() || $('title').text() || text).slice(0, 300);
}

export class WukusyWriteError extends Error {}

// Success looks like {"status":"success"}. Failures come back as HTTP 200 too, as
// {"status":"error","msg":...}, {"status":{"msg":...}}, or an HTML page; none of those
// may be reported as success.
export function checkResult(path, text) {
  let data;
  try { data = JSON.parse(text); } catch {
    throw new WukusyWriteError(`${path}: expected a JSON reply, got HTML/text: ${errorMessage(text)}`);
  }
  const status = data?.status;
  const ok = status === true || data?.success === true || (typeof status === 'string' && /^(success|ok|true)$/i.test(status));
  if (!ok) {
    const msg = data?.msg || data?.message || data?.error || status?.msg || status?.message || JSON.stringify(data).slice(0, 300);
    throw new WukusyWriteError(`${path} was rejected by Wukusy: ${msg}`);
  }
  return data;
}

export function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text.replace(/\s+/g, ' ').trim().slice(0, 2000) }; }
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();

// Generic table scraper: header cells become keys. Links inside cells are kept since
// they carry the order/product ids the write tools need.
export function parseTables($) {
  return $('table').toArray().map((t) => {
    const $t = $(t);
    const headers = $t.find('thead th, tr:first-child th').toArray().map((th) => clean($(th).text()));
    const rows = $t.find('tbody tr').toArray().map((tr) => {
      const $tr = $(tr);
      const cells = $tr.find('td').toArray();
      if (cells.length === 0 || (cells.length === 1 && /no (record|data)/i.test($(cells[0]).text()))) return null;
      const row = {};
      cells.forEach((td, i) => {
        const $td = $(td);
        row[headers[i] || `col${i + 1}`] = clean($td.text());
        const links = $td.find('a[href]').toArray().map((a) => $(a).attr('href')).filter((h) => h && !h.startsWith('javascript'));
        if (links.length) row[`${headers[i] || `col${i + 1}`} links`] = links;
      });
      const ids = {};
      for (const el of [tr, ...$tr.find('[data-id],[data-uuid],[data-sid],input[type=checkbox][value]').toArray()]) {
        for (const [k, v] of Object.entries(el.attribs || {})) if (k.startsWith('data-') && v && !/title|toggle|bs-|placement/.test(k)) ids[k.slice(5)] = v;
        if (el.attribs?.type === 'checkbox' && el.attribs.value) ids.checkbox_value = el.attribs.value;
      }
      if (Object.keys(ids).length) row._ids = ids;
      return row;
    }).filter(Boolean);
    return { headers, rows };
  });
}

export function parsePagination($) {
  const m = clean($('body').text()).match(/Page (\d+) of (\d+), showing (\d+) record\(s\) out of (\d+) total/);
  return m ? { page: +m[1], pages: +m[2], shown: +m[3], total: +m[4] } : null;
}

export async function listPage(client, path, query) {
  const $ = await client.html(path, query);
  const [table] = parseTables($);
  return { pagination: parsePagination($), headers: table?.headers ?? [], rows: table?.rows ?? [] };
}

// Analytics cards are <h3>value</h3><p>label</p> pairs.
export function parseCards($) {
  const out = {};
  $('h3').each((_, h) => {
    const label = clean($(h).nextAll('p').first().text());
    if (label) out[label] = clean($(h).text());
  });
  return out;
}

export async function readInputs(client, path) {
  const $ = await client.html(path);
  const byName = {};
  const byId = {};
  $('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const v = el.name === 'select' ? $el.find('option[selected]').attr('value') ?? '' : $el.attr('value') ?? $el.text() ?? '';
    if (el.attribs.name && !(el.attribs.name in byName)) byName[el.attribs.name] = v;
    if (el.attribs.id && !(el.attribs.id in byId)) byId[el.attribs.id] = v;
  });
  return { $, byName, byId };
}

export const PROFILE_FIELDS = ['account_trade', 'gst_pincode', 'gst_state', 'gst_city', 'gst_address', 'gst_name', 'new_password', 'bank_name', 'mobile', 'account_ifsc', 'name', 'account_pan', 'aadhar_number', 'account_name', 'account_number', 'account_gst'];
export const SENSITIVE_FIELDS = ['account_number', 'account_ifsc', 'account_pan', 'aadhar_number', 'account_gst'];

export function mask(v) {
  if (!v) return v;
  return v.length <= 4 ? '****' : `${'*'.repeat(v.length - 4)}${v.slice(-4)}`;
}

export function redact(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, SENSITIVE_FIELDS.includes(k) || k === 'new_password' ? mask(String(v ?? '')) : v]));
}
