#!/usr/bin/env node
'use strict';
// Zero-dependency stdio MCP server for the LeadID platform API (read-only).
const fs = require('fs');
const path = require('path');
const FILTERS = require('./filters.json');

const DEFAULT_API_BASE_URL = 'https://api.visualvisitor.com/api/v1';
// Optional override, e.g. a white-label API host: LEADID_API_BASE=https://host/api/v1
const API_BASE_URL = (process.env.LEADID_API_BASE || '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE_URL;
const SERVER_INFO = { name: 'leadid', version: '0.1.0' };
const PROTOCOL = '2024-11-05';

const REFERENCE_LISTS = {
  ageRanges: 'Age ranges', annualIncomeRanges: 'Annual income ranges',
  companyEmployeeSizes: 'Company employee count ranges', companyIndustries: 'Company industries',
  companyLocationType: 'Company location types', addressTypes: 'Company office types',
  companyNaics: 'Company NAICS codes', companyRevenueBands: 'Company revenue bands',
  companySics: 'Company SICS codes', countries: 'Countries', genders: 'Genders',
  jobFunctions: 'Job functions', jobLevels: 'Job levels', jobStartDates: 'Job start date ranges',
  netWorthRanges: 'Net-worth ranges', savedBy: 'Saved by list', savedContactTags: 'Saved contact tag list',
  savedFrom: 'Saved from list', states: 'States', timeZones: 'Time zones', roles: 'User roles',
};

class ApiError extends Error {}

function envFirst(...names) {
  for (const n of names) { const v = (process.env[n] || '').trim(); if (v) return v; }
  return '';
}

function apiKey() {
  const k = envFirst('LEADID_API_KEY');
  if (k) return k;
  const dir = process.env.PLUGIN_DATA;
  if (dir) { try { return fs.readFileSync(path.join(dir, 'api-key'), 'utf8').trim(); } catch (_) {} }
  return '';
}

function authHeader(key) {
  const scheme = envFirst('LEADID_AUTH_SCHEME');
  return scheme ? `${scheme} ${key}` : key;
}

async function api(method, p, { query = {}, body, customerId, noCustomer } = {}) {
  const key = apiKey();
  if (!key) throw new ApiError('LEADID_API_KEY is not set. Create an API key in your LeadID dashboard under Configuration > API Integration and expose it to the plugin as the LEADID_API_KEY environment variable.');
  const cust = noCustomer ? '' : (customerId || envFirst('LEADID_CUSTOMER_ID') || '').toString().trim();
  const url = new URL(API_BASE_URL + p);
  if (cust) url.searchParams.set('customerId', cust);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = { Authorization: authHeader(key), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(`Network error calling LeadID: ${e.message}`);
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
  if (!res.ok) {
    const detail = data && typeof data === 'object' ? (data.detail || data.title || '') : String(data || '').slice(0, 200);
    const hint = {
      401: 'Unauthorized: the API key is missing, invalid or revoked. If the key is correct, the Authorization format may need a prefix: try setting LEADID_AUTH_SCHEME=Bearer.',
      403: 'Forbidden: the key lacks the required scope, or the account does not have the required plan (+PlusEmployee or +PlusPerson) for this endpoint.',
      400: 'Bad request (check filter values/ids).',
      404: 'Not found.',
      429: 'Rate limited (200 requests / 20 min per IP, 5,000 calls / day per API key). Retry later.',
    }[res.status] || `Request failed (HTTP ${res.status}).`;
    throw new ApiError(`HTTP ${res.status} ${method} ${p}: ${hint}${detail ? ` Server said: ${detail}` : ''}`);
  }
  return data;
}

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
function clean(o) {
  if (Array.isArray(o)) return o.map(clean);
  if (o && typeof o === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(o)) { const c = clean(v); if (!isEmpty(c)) r[k] = c; }
    return r;
  }
  return o;
}
const pick = (o, keys) => { const r = {}; for (const k of keys) if (!isEmpty(o?.[k])) r[k] = o[k]; return r; };
const page = (d, key, items) => ({ [key]: items, totalRecords: d.totalRecords, page: d.page, pageSize: d.pageSize, hasNextPage: d.hasNextPage });

function mapLead(l) {
  const v = clean(l);
  return clean({
    visitorId: v.visitorId,
    person: pick(v, ['firstName', 'lastName', 'jobTitle', 'professionalEmail', 'personalEmail', 'linkedInUrl', 'facebookUrl', 'twitterUrl', 'phone', 'phoneType', 'phoneMobile1', 'phoneMobile2',
      'gender', 'ageRange', 'isMarried', 'hasChildren', 'incomeRange', 'netWorth', 'isHomeOwner']),
    location: pick(v, ['residentAddress', 'residentAddress2', 'residentCity', 'residentState', 'residentZipCode']),
    company: pick(v, ['companyName', 'companyDomain', 'companyLinkedInUrl', 'companyPrimaryIndustry', 'companyEmployeeSizeRange', 'companyEmployees', 'companyRevenueRange',
      'companyAddress', 'companyAddress2', 'companyCity', 'companyRegionCode', 'companyPostalCode']),
    visit: pick(v, ['sessionDate', 'sessionId', 'referrer', 'firstVisit', 'searchTerm', 'searchEngine', 'campaignName', 'campaignSource', 'campaignMedium', 'campaignTerm', 'campaignContent', 'pagesVisited']),
  });
}

function mapSearchItems(d) {
  const key = ['contacts', 'companies', 'results', 'items'].find((k) => Array.isArray(d?.[k])) ||
    Object.keys(d || {}).find((k) => Array.isArray(d[k]));
  return clean(d?.[key] || []);
}

const clampInt = (v, lo, hi, dflt) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.trunc(+v))) : dflt);
function paging(a) { return { page: clampInt(a.page, 1, 50, 1), pageSize: clampInt(a.pageSize, 1, 200, 50) }; }

function filterProps(key) { return JSON.parse(JSON.stringify(FILTERS[key])); }
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PAGING = {
  page: { type: 'integer', minimum: 1, maximum: 50, description: 'Page number (API max 50 pages). Default 1.' },
  pageSize: { type: 'integer', minimum: 1, maximum: 200, description: 'Results per page (API max 200). Default 50.' },
};
const CUSTID = { type: 'string', description: 'Optional (partner accounts): customer id from list_customers; acts on behalf of that customer.' };
const PRODUCT = { type: 'string', enum: ['plusEmployee', 'plusPerson'], description: 'Which LeadID product to query. Account must have that plan enabled.' };

const TOOLS = [
  {
    name: 'search_leads',
    description: 'Search website-visitor leads (who visited the site) for a date range with filters. Read-only. Use list_reference_values to get valid values for range/industry/state filters. Returns leads plus totalRecords/page/hasNextPage.',
    inputSchema: obj({ product: PRODUCT, customerId: CUSTID, ...PAGING, filters: { type: 'object', description: 'Filters using exact documented field names for the chosen product (note: plusEmployee uses companyEmpoyeeSizeRanges [sic]; plusPerson uses visitEnddate [sic casing]).', properties: { ...filterProps('plusEmployee'), ...Object.fromEntries(Object.entries(filterProps('plusPerson')).filter(([k]) => !(k in FILTERS.plusEmployee))) }, additionalProperties: false } }, ['product']),
    async run(a) {
      const p = a.product;
      if (!FILTERS[p] || p === 'company' || p === 'contact') throw new ApiError('product must be plusEmployee or plusPerson');
      const f = a.filters || {};
      const bad = Object.keys(f).filter((k) => !(k in FILTERS[p]));
      if (bad.length) throw new ApiError(`Filter field(s) not documented for ${p}: ${bad.join(', ')}. Valid: ${Object.keys(FILTERS[p]).join(', ')}`);
      const d = await api('POST', `/${p}/leads`, { customerId: a.customerId, body: { ...f, ...paging(a) } });
      return page(d, 'leads', (d.leads || []).map(mapLead));
    },
  },
  {
    name: 'get_lead',
    description: 'Get full detail for one lead by numeric id: person, company, sessions with page views, campaign. Read-only. EXPERIMENTAL: live test showed visitorId values from search_leads return HTTP 400 "Visitor was not found"; the correct id source is undocumented.',
    inputSchema: obj({ product: PRODUCT, customerId: CUSTID, id: { type: 'string', description: 'visitorId' } }, ['product', 'id']),
    async run(a) {
      if (!['plusEmployee', 'plusPerson'].includes(a.product)) throw new ApiError('product must be plusEmployee or plusPerson');
      return clean(await api('GET', `/${a.product}/leads/${encodeURIComponent(a.id)}`, { customerId: a.customerId }));
    },
  },
  {
    name: 'search_companies',
    description: 'Search the Who To Contact company database (+PlusEmployee plan). Read-only, no credits spent.',
    inputSchema: obj({ ...PAGING, filters: { type: 'object', properties: filterProps('company'), additionalProperties: false } }),
    async run(a) {
      const f = a.filters || {};
      const bad = Object.keys(f).filter((k) => !(k in FILTERS.company));
      if (bad.length) throw new ApiError(`Undocumented company filter(s): ${bad.join(', ')}. Valid: ${Object.keys(FILTERS.company).join(', ')}`);
      const d = await api('POST', '/whoToContact/company', { body: { ...f, ...paging(a) } });
      return page(d, 'companies', mapSearchItems(d));
    },
  },
  {
    name: 'get_company',
    description: 'Get details of one company by id (from search_companies). Read-only, no credits spent.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    async run(a) { return clean(await api('GET', `/whoToContact/company/${encodeURIComponent(a.id)}`)); },
  },
  {
    name: 'search_contacts',
    description: 'Search contacts (+PlusEmployee Who To Contact). Returns availability FLAGS only (hasDirectPhone, hasCompanyEmail, ...), never contact details. Does not spend credits; revealing details is intentionally not available.',
    inputSchema: obj({ ...PAGING, filters: { type: 'object', properties: filterProps('contact'), additionalProperties: false } }),
    async run(a) {
      const f = a.filters || {};
      const bad = Object.keys(f).filter((k) => !(k in FILTERS.contact));
      if (bad.length) throw new ApiError(`Undocumented contact filter(s): ${bad.join(', ')}. Valid: ${Object.keys(FILTERS.contact).join(', ')}`);
      const d = await api('POST', '/whoToContact/contact', { body: { ...f, ...paging(a) } });
      return page(d, 'contacts', mapSearchItems(d));
    },
  },
  {
    name: 'list_reference_values',
    description: 'List valid filter values (key = value to send in filters, value = display label) for a reference list. Call this before building filters.',
    inputSchema: obj({ list: { type: 'string', enum: Object.keys(REFERENCE_LISTS), description: 'Reference list name' }, search: { type: 'string', description: 'Optional case-insensitive substring to filter results locally' } }, ['list']),
    async run(a) {
      if (!(a.list in REFERENCE_LISTS)) throw new ApiError(`Unknown list. Valid: ${Object.keys(REFERENCE_LISTS).join(', ')}`);
      let d = await api('GET', `/reference/${a.list}`);
      if (Array.isArray(d) && a.search) { const s = String(a.search).toLowerCase(); d = d.filter((x) => JSON.stringify(x).toLowerCase().includes(s)); }
      return { list: a.list, description: REFERENCE_LISTS[a.list], count: Array.isArray(d) ? d.length : undefined, values: d };
    },
  },
  {
    name: 'list_icps',
    description: 'List saved Ideal Customer Profiles (id, name, notes). Read-only (+PlusEmployee).',
    inputSchema: obj({}),
    async run() { const d = await api('GET', '/plusEmployee/icp'); return clean({ icps: d.icpDefinitions, totalCount: d.totalCount }); },
  },
  {
    name: 'get_download_limits',
    description: 'Get contact download limits (maxDownloadableContacts, remainingDownloadableContacts). Read-only.',
    inputSchema: obj({}),
    async run() { return clean(await api('GET', '/whoToContact/downloadLimit')); },
  },
];


// ---------- Partner customers, install check, lead counts ----------
const PRODUCT_MAP = { person: 'plusPerson', employee: 'plusEmployee' };
const mapCustomerItem = (c) => clean({ id: c.id, name: (c.customerName || '').trim(), domain: c.domain, product: c.product, plan: c.planName, freeTrial: c.freeTrial, freeTrialEndDate: c.freeTrial ? c.freeTrialEndDate : undefined, dateCreated: c.dateCreated });

async function fetchCustomerList() {
  const d = await api('GET', '/partner/customers', { noCustomer: true });
  return d.customers || [];
}
async function fetchCustomer(id) {
  const c = await api('GET', `/partner/customers/${encodeURIComponent(id)}`, { noCustomer: true });
  return c;
}
function parseInstall(inst) {
  const code = inst?.installation_Code || '';
  const m = /(?:https?:)?\/\/([a-z0-9.-]+)\/cscripts\/([A-Za-z0-9_-]+)\.js/i.exec(code);
  return { instruction: inst?.instruction, installationCode: code, scriptHost: m && m[1], scriptId: m && m[2], scriptUrl: m && m[0] };
}
async function getInstall(customerId) {
  return parseInstall(await api('GET', '/config/customer/installInstruction', { customerId, noCustomer: false }));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
async function fetchText(url, ms = 15000, maxBytes = 3_000_000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' } });
    const text = (await res.text()).slice(0, maxBytes);
    return { ok: res.ok, status: res.status, finalUrl: res.url, text };
  } finally { clearTimeout(t); }
}
const snippet = (text, idx, len) => text.slice(Math.max(0, idx - 80), Math.min(text.length, idx + len + 80)).replace(/\s+/g, ' ').trim();
const normalizeSite = (d) => { d = String(d || '').trim(); return d ? (/^https?:\/\//i.test(d) ? d : `https://${d}`) : ''; };

async function loadHomepage(domain) {
  const base = normalizeSite(domain);
  const u = new URL(base);
  const cands = [base];
  if (!u.hostname.startsWith('www.')) cands.push(`${u.protocol}//www.${u.hostname}${u.pathname}`);
  if (u.protocol === 'https:') cands.push(base.replace(/^https:/, 'http:'));
  const errors = [];
  for (const c of cands) {
    try {
      const r = await fetchText(c);
      if (r.ok) return { ...r, tried: c };
      errors.push(`${c} -> HTTP ${r.status}`);
    } catch (e) { errors.push(`${c} -> ${e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)}`); }
  }
  return { error: errors.join('; ') };
}

async function checkInstall({ customerId, website }) {
  const cust = await fetchCustomer(customerId);
  const site = website || cust.domainName;
  const install = await getInstall(customerId);
  const base = { customerId, customer: (cust.customerName || '').trim(), website: site, expectedScriptId: install.scriptId || null, expectedScriptUrl: install.scriptUrl || null };
  const out = (o) => ({ ...base, foundScriptIds: [], foundIn: null, gtmContainerIds: [], finalUrl: null, evidenceSnippet: null, ...o });
  if (!install.scriptId) return out({ status: 'not_confirmed', note: 'installInstruction did not contain a recognizable /cscripts/<id>.js URL.' });
  if (!site) return out({ status: 'not_confirmed', note: 'Customer has no website/domain on file.' });
  const page = await loadHomepage(site);
  if (page.error) return out({ status: 'site_down', error: page.error });
  const html = page.text;
  const idRx = /(?:https?:)?\/\/[a-z0-9.-]+\/cscripts\/([A-Za-z0-9_-]+)\.js/gi;
  const scan = (text) => { const r = []; let m; idRx.lastIndex = 0; while ((m = idRx.exec(text))) r.push({ id: m[1], at: m.index, len: m[0].length }); return r; };
  const htmlHits = scan(html);
  const ids = new Set(htmlHits.map((h) => h.id));
  const gtmContainerIds = [...new Set(html.match(/GTM-[A-Z0-9]{4,8}/g) || [])].slice(0, 5);
  const common = { finalUrl: page.finalUrl, httpStatus: page.status, gtmContainerIds, expectedScriptId: install.scriptId };
  const matchIdx = html.indexOf(install.scriptId);
  if (matchIdx >= 0) {
    ids.add(install.scriptId);
    return out({ ...common, status: 'running', foundIn: 'html', foundScriptIds: [...ids], evidenceSnippet: snippet(html, matchIdx, install.scriptId.length) });
  }
  const gtmChecked = [];
  let gtmEvidence = null; let gtmFoundIn = null;
  for (const gid of gtmContainerIds) {
    try {
      const g = await fetchText(`https://www.googletagmanager.com/gtm.js?id=${gid}`, 15000, 3_000_000);
      if (!g.ok) { gtmChecked.push({ container: gid, httpStatus: g.status, fetched: false }); continue; }
      scan(g.text).forEach((h) => ids.add(h.id));
      const gi = g.text.indexOf(install.scriptId);
      gtmChecked.push({ container: gid, httpStatus: g.status, fetched: true, containsExpectedId: gi >= 0 });
      if (gi >= 0 && !gtmEvidence) { gtmEvidence = snippet(g.text, gi, install.scriptId.length); gtmFoundIn = gid; ids.add(install.scriptId); }
    } catch (e) { gtmChecked.push({ container: gid, fetched: false, error: e.name === 'AbortError' ? 'timeout' : e.message }); }
  }
  const gtmField = gtmChecked.length ? { gtmChecked } : {};
  if (gtmEvidence) return out({ ...common, ...gtmField, status: 'running', foundIn: 'gtm', foundScriptIds: [...ids], evidenceSnippet: gtmEvidence, note: `Found in GTM container ${gtmFoundIn}.` });
  if (ids.size) {
    const h = htmlHits[0];
    return out({ ...common, ...gtmField, status: 'wrong_id', foundIn: h ? 'html' : 'gtm', foundScriptIds: [...ids], evidenceSnippet: h ? snippet(html, h.at, h.len) : `LeadID script id(s) ${[...ids].join(', ')} found in GTM container JS` });
  }
  if (gtmContainerIds.length) return out({ ...common, ...gtmField, status: 'not_confirmed', note: 'GTM is present on the page but the expected id was not found in the HTML or in any container that could be fetched (a container fetch may have failed, or the tag may load by a mechanism not visible in container JS).' });
  return out({ ...common, status: 'missing', note: 'No LeadID tracking script in the static homepage HTML and no GTM detected. Scripts injected by other tag managers, consent tools or client-side code, or present only on inner pages, could be missed.' });
}

const chicagoDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const WINDOWS = [1, 7, 30];
async function countLeads({ customerId, product }) {
  let prod = product;
  let cust = null;
  if (!prod) { cust = await fetchCustomer(customerId); prod = PRODUCT_MAP[cust.product] || 'plusEmployee'; }
  if (!['plusEmployee', 'plusPerson'].includes(prod)) throw new ApiError('product must be plusEmployee or plusPerson');
  const endField = prod === 'plusPerson' ? 'visitEnddate' : 'visitEndDate';
  const now = Date.now();
  const end = chicagoDate(new Date(now));
  const ranges = {};
  for (const n of WINDOWS) {
    const begin = chicagoDate(new Date(now - (n - 1) * 86400000));
    const d = await api('POST', `/${prod}/leads`, { customerId, body: { page: 1, pageSize: 1, visitBeginDate: begin, [endField]: end } });
    ranges[`last${n}d`] = { count: d.totalRecords, visitBeginDate: begin, [endField]: end };
  }
  return { customerId, customer: cust ? (cust.customerName || '').trim() : undefined, product: prod, timeZone: 'America/Chicago',
    counts: Object.fromEntries(Object.entries(ranges).map(([k, v]) => [k, v.count])), ranges,
    definition: 'Count is the API\'s totalRecords for the lead search: "visitor sessions found by a lead search" (per the API docs), not de-duplicated people. Windows are inclusive calendar days in America/Chicago ending today (today is partial), so last1d = today only.' };
}

TOOLS.push(
  {
    name: 'list_customers',
    description: 'PARTNER accounts: list all customers (id, name, domain, product, plan, free-trial status). Optional case-insensitive search on name or domain, applied client-side. The API returns everything in one response (no pagination). Read-only.',
    inputSchema: obj({ search: { type: 'string', description: 'Substring of customer name or domain' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max rows returned (default 100)' } }),
    async run(a) {
      let list = (await fetchCustomerList()).map(mapCustomerItem);
      const total = list.length;
      if (a.search) { const q = String(a.search).toLowerCase(); list = list.filter((c) => `${c.name} ${c.domain || ''}`.toLowerCase().includes(q)); }
      const limit = clampInt(a.limit, 1, 200, 100);
      return { totalCustomers: total, matched: list.length, returned: Math.min(limit, list.length), customers: list.slice(0, limit) };
    },
  },
  {
    name: 'get_customer',
    description: 'PARTNER accounts: get one customer by id (name, website domainName, product, plan, trial info, dates). Contact email/phone are deliberately omitted. Read-only.',
    inputSchema: obj({ customerId: { type: 'string' } }, ['customerId']),
    async run(a) {
      const c = await fetchCustomer(a.customerId);
      return clean({ id: c.id, name: (c.customerName || '').trim(), website: c.domainName, product: c.product, plan: c.planName, freeTrial: c.freeTrial, freeTrialEndDate: c.freeTrial ? c.freeTrialEndDate : undefined, dateCreated: c.dateCreated, dateUpdated: c.dateUpdated });
    },
  },
  {
    name: 'get_install_instruction',
    description: "Get a customer's tracking install snippet and the parsed unique script id/URL (from /config/customer/installInstruction). Read-only.",
    inputSchema: obj({ customerId: { type: 'string' } }, ['customerId']),
    async run(a) { const i = await getInstall(a.customerId); return clean({ customerId: a.customerId, scriptId: i.scriptId, scriptUrl: i.scriptUrl, scriptHost: i.scriptHost, installationCode: i.installationCode, instruction: i.instruction }); },
  },
  {
    name: 'check_tracking_install',
    description: "Check whether a customer's own LeadID tracking script (unique id from installInstruction) is present on their listed website homepage. Fetches the homepage like a browser (redirects, timeout) and also searches public Google Tag Manager container JS. Output: status (running | missing | wrong_id | not_confirmed | site_down), expectedScriptId, foundScriptIds[], foundIn ('html'|'gtm'|null), gtmContainerIds[], finalUrl, evidenceSnippet. not_confirmed = GTM present but the id could not be confirmed in it (or no website/install code). Static fetch can miss scripts injected by other means; only the homepage is checked. Read-only.",
    inputSchema: obj({ customerId: { type: 'string' }, website: { type: 'string', description: 'Optional override of the site to check (default: customer domain)' } }, ['customerId']),
    async run(a) { return await checkInstall(a); }, // not clean()ed: keep null/empty fields so the shape is stable
  },
  {
    name: 'count_leads',
    description: 'Count a customer\'s leads (API totalRecords of visitor sessions) for the last 1, 7 and 30 days (inclusive calendar days ending today, America/Chicago). Uses pageSize 1 searches. Product defaults to the customer\'s own product (person -> plusPerson, employee -> plusEmployee). Read-only.',
    inputSchema: obj({ customerId: { type: 'string' }, product: PRODUCT }, ['customerId']),
    async run(a) { return clean(await countLeads(a)); },
  },
);

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) throw { code: -32602, message: `Unknown tool: ${params?.name}` };
    try {
      const out = await tool.run(params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof ApiError ? e.message : `Internal error: ${e && e.message}` }] };
    }
  }
  throw { code: -32601, message: `Method not found: ${method}` };
}

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (msg.id === undefined || msg.id === null) continue; // notifications
    handle(msg).then(
      (result) => send({ jsonrpc: '2.0', id: msg.id, result }),
      (e) => send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message || String(e) } }),
    );
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));
