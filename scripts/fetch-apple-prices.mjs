#!/usr/bin/env node
/**
 * Refreshes the Apple data embedded in index.html from the App Store Connect API.
 *
 * It reads every US price point for one-time In-App Purchases and for
 * subscriptions, asks Apple for the equalized price in all other storefronts,
 * and rewrites the JSON blocks inside index.html. Read-only: it only sends GET
 * requests. Needs Node 18+ and no dependencies.
 *
 *   ASC_ISSUER_ID=…  ASC_KEY_ID=…  ASC_PRIVATE_KEY_PATH=~/keys/AuthKey_XXXX.p8 \
 *     node scripts/fetch-apple-prices.mjs
 *
 * Options
 *   --model=both|subscription|iap   which price ladders to fetch (default both)
 *   --only=9.99,39.99               fetch only these US price points
 *   --max-usd=200                   skip US price points above this amount
 *   --app=ID --subscription=ID --iap=ID   use these products instead of auto-discovery
 *   --update-tax                    rewrite tax rules that no longer match Apple's proceeds
 *   --out=path/to/index.html        file to update (default ../index.html)
 *   --concurrency=2                 parallel requests
 *   --cache=dir                     where to keep downloaded responses (default .asc-cache)
 *   --dry-run                       fetch and report, but do not write index.html
 *
 * Responses are cached in .asc-cache/ so an interrupted run resumes where it
 * stopped. Delete that folder to force a fresh download.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.appstoreconnect.apple.com';
const BASE = 'USA';
const TODAY = new Date().toISOString().slice(0, 10);

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) fail(`Unknown argument: ${a}`);
  return [m[1], m[2] === undefined ? true : m[2]];
}));
const OUT = path.resolve(args.out || path.join(ROOT, 'index.html'));
const CACHE = path.resolve(args.cache || path.join(ROOT, '.asc-cache'));
const MODELS = args.model === 'subscription' ? ['subscription'] : args.model === 'iap' ? ['iap'] : ['iap', 'subscription'];
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 2);

function fail(msg) {
  console.error('\n' + msg + '\n');
  process.exit(1);
}

/* ---------------------------------------------------------------- auth */
const ISSUER = process.env.ASC_ISSUER_ID;
const KEY_ID = process.env.ASC_KEY_ID;
let PRIVATE_KEY = process.env.ASC_PRIVATE_KEY;
if (!PRIVATE_KEY && process.env.ASC_PRIVATE_KEY_PATH) {
  PRIVATE_KEY = fs.readFileSync(process.env.ASC_PRIVATE_KEY_PATH.replace(/^~(?=\/)/, os.homedir()), 'utf8');
}
if (!ISSUER || !KEY_ID || !PRIVATE_KEY) {
  fail('Missing credentials. Set ASC_ISSUER_ID, ASC_KEY_ID and ASC_PRIVATE_KEY_PATH (or ASC_PRIVATE_KEY).\n' +
    'Create a key in App Store Connect > Users and Access > Integrations > App Store Connect API.');
}

let token = null, tokenAt = 0;
function jwt() {
  if (token && Date.now() - tokenAt < 10 * 60e3) return token;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  const body = b64({ iss: ISSUER, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: PRIVATE_KEY, dsaEncoding: 'ieee-p1363' });
  token = `${head}.${body}.${sig.toString('base64url')}`;
  tokenAt = Date.now();
  return token;
}

/* ---------------------------------------------------------------- http */
const WAIT_SCALE = Number(process.env.ASC_RETRY_SCALE || 1);
const sleep = ms => new Promise(r => setTimeout(r, ms * WAIT_SCALE));
let requests = 0, rateLimit = '';
async function get(url) {
  const full = url.startsWith('http') ? url : API + url;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(full, { headers: { Authorization: `Bearer ${jwt()}`, Accept: 'application/json' } });
    } catch (e) {
      if (attempt >= 6) throw e;
      await sleep(1500 * (attempt + 1));
      continue;
    }
    requests++;
    rateLimit = res.headers.get('x-rate-limit') || rateLimit;
    if (res.ok) return res.json();
    const text = await res.text();
    if (res.status === 401 && attempt < 2) { token = null; continue; }
    /* Apple answers some valid requests with a 403 when it is throttling a key,
       so a 403 gets a few slow retries with a fresh token before it counts. */
    if (res.status === 403 && attempt < 4) {
      token = null;
      await sleep([5e3, 15e3, 30e3, 60e3][attempt]);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await sleep(Math.min(60e3, 2000 * 2 ** attempt));
      continue;
    }
    let detail = text.slice(0, 300);
    try { const e = JSON.parse(text).errors[0]; detail = `${e.code}: ${e.detail || e.title}`; } catch (e) { /* not JSON */ }
    const err = new Error(`${res.status} ${detail}${rateLimit ? ` [rate limit ${rateLimit}]` : ''}`);
    err.status = res.status;
    err.url = full;
    throw err;
  }
}
async function getAll(url) {
  const data = [], included = [];
  for (let next = url; next;) {
    const page = await get(next);
    data.push(...(page.data || []));
    included.push(...(page.included || []));
    next = page.links && page.links.next;
  }
  return { data, included };
}
async function pool(items, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) { const n = i++; await worker(items[n], n); }
  }));
}

/* ---------------------------------------------------------------- index.html blocks */
function readBlock(html, id) {
  const m = html.match(new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`, 's'));
  if (!m) fail(`Could not find the #${id} data block in ${OUT}`);
  return JSON.parse(m[1]);
}
function writeBlock(html, id, obj) {
  const json = JSON.stringify(obj).replace(/<\//g, '<\\/');
  return html.replace(new RegExp(`(<script type="application/json" id="${id}">)(.*?)(</script>)`, 's'), (_, a, _b, c) => a + json + c);
}
/* The calculation engine is taken from index.html so there is one source of truth. */
function loadEngine(html, DATA) {
  const src = html.match(/const Engine = \{[\s\S]*?\n\};/);
  if (!src) fail('Could not find the Engine in index.html');
  return new Function('DATA', src[0] + '; return Engine;')(DATA);
}

/* ---------------------------------------------------------------- Apple helpers */
const tierKey = price => Number(price).toFixed(2);
const toNum = s => { const n = Number(s); return Number.isFinite(n) ? n : null; };
function territoryOf(item) {
  const rel = item.relationships && item.relationships.territory && item.relationships.territory.data;
  if (rel && rel.id) return rel.id;
  try { return JSON.parse(Buffer.from(item.id, 'base64').toString('utf8')).t || null; } catch (e) { return null; }
}

const LADDERS = {
  subscription: {
    label: 'subscription',
    points: id => `/v1/subscriptions/${id}/pricePoints?filter[territory]=${BASE}&limit=200`,
    equalizations: pp => `/v1/subscriptionPricePoints/${pp}/equalizations?limit=200`,
  },
  iap: {
    label: 'one-time In-App Purchase',
    points: id => `/v2/inAppPurchases/${id}/pricePoints?filter[territory]=${BASE}&limit=200`,
    equalizations: pp => `/v1/inAppPurchasePricePoints/${pp}/equalizations?limit=200`,
  },
  /* Paid-app price points share the ladder with one-time In-App Purchases;
     used when the account has no In-App Purchase to query. */
  app: {
    label: 'paid app (same ladder as one-time In-App Purchases)',
    points: id => `/v1/apps/${id}/appPricePoints?filter[territory]=${BASE}&limit=200`,
    equalizations: pp => `/v3/appPricePoints/${pp}/equalizations?limit=200`,
  },
};

async function discover() {
  const found = { subscription: args.subscription || null, iap: args.iap || null, app: args.app || null };
  const apps = args.app ? [{ id: args.app }] : (await getAll('/v1/apps?limit=200&fields[apps]=name,bundleId')).data;
  if (!apps.length) fail('This API key cannot see any apps.');
  if (!found.app) found.app = apps[0].id;
  for (const app of apps) {
    if (MODELS.includes('subscription') && !found.subscription) {
      const g = await get(`/v1/apps/${app.id}/subscriptionGroups?include=subscriptions&limit=50`);
      const sub = (g.included || []).find(x => x.type === 'subscriptions');
      if (sub) found.subscription = sub.id;
    }
    if (MODELS.includes('iap') && !found.iap) {
      const p = await get(`/v1/apps/${app.id}/inAppPurchasesV2?limit=1`);
      if (p.data && p.data[0]) { found.iap = p.data[0].id; found.app = app.id; }
    }
    if ((!MODELS.includes('subscription') || found.subscription) && (!MODELS.includes('iap') || found.iap)) break;
  }
  return found;
}

async function fetchLadder(kind, ladder, productId) {
  console.log(`\n${kind}: reading US price points (${ladder.label}) …`);
  let points = (await getAll(ladder.points(productId))).data
    .map(p => ({ id: p.id, tier: tierKey(p.attributes.customerPrice), attrs: p.attributes }))
    .sort((a, b) => Number(a.tier) - Number(b.tier));
  const allTiers = [...new Set(points.map(p => p.tier))].filter(t => Number(t) > 0);
  if (args.only) { const want = new Set(String(args.only).split(',').map(tierKey)); points = points.filter(p => want.has(p.tier)); }
  if (args['max-usd']) points = points.filter(p => Number(p.tier) <= Number(args['max-usd']));
  points = points.filter(p => Number(p.tier) > 0);
  console.log(`${kind}: ${allTiers.length} US price points, fetching equalizations for ${points.length}`);

  const dir = path.join(CACHE, kind);
  fs.mkdirSync(dir, { recursive: true });
  const rows = {}; // tier -> { a3: {price, proceeds, proceedsYear2} }
  const failed = []; // { tier, error }
  let done = 0, streak = 0, stop = false;
  await pool(points, async pt => {
    if (stop) return;
    const file = path.join(dir, `${pt.tier}.json`);
    let data;
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      try {
        data = (await getAll(ladder.equalizations(pt.id))).data.map(x => ({ t: territoryOf(x), ...x.attributes }));
      } catch (e) {
        failed.push({ tier: pt.tier, error: e.message });
        if (++streak >= 6) stop = true;   // Apple is refusing everything: stop asking
        return;
      }
      streak = 0;
      fs.writeFileSync(file, JSON.stringify(data));
    }
    const map = { [BASE]: { price: toNum(pt.attrs.customerPrice), proceeds: toNum(pt.attrs.proceeds), proceedsYear2: toNum(pt.attrs.proceedsYear2) } };
    for (const x of data) if (x.t) map[x.t] = { price: toNum(x.customerPrice), proceeds: toNum(x.proceeds), proceedsYear2: toNum(x.proceedsYear2) };
    rows[pt.tier] = map;
    if (++done % 25 === 0 || done === points.length) process.stdout.write(`\r${kind}: ${done}/${points.length} price points`);
  });
  process.stdout.write('\n');
  const skipped = points.length - done - failed.length;
  if (failed.length) {
    console.warn(`${kind}: ${failed.length} price points failed` + (skipped ? `, ${skipped} not attempted after repeated failures` : '') + '.');
    console.warn(`  First error ($${failed[0].tier}): ${failed[0].error}`);
  }
  return { allTiers, rows, missing: failed.length + skipped };
}

/* ---------------------------------------------------------------- tax validation */
function validateTax(Engine, DATA, ladders) {
  const SF = Object.fromEntries(DATA.storefronts.map(s => [s.a3, s]));
  const regionalOf = a3 => (DATA.commission.regional || []).find(r => r.storefronts.includes(a3));
  const report = {}; // a3 -> { checked, bad, implied: [] }
  for (const { rows } of ladders) {
    const tiers = Object.keys(rows);
    if (!tiers.length) continue;
    const top = rows[tiers.reduce((a, b) => (Number(a) > Number(b) ? a : b))][BASE];
    const globalRates = { proceeds: Math.round((1 - top.proceeds / top.price) * 100) / 100 };
    if (top.proceedsYear2 != null) globalRates.proceedsYear2 = Math.round((1 - top.proceedsYear2 / top.price) * 100) / 100;
    for (const tier of tiers) for (const [a3, v] of Object.entries(rows[tier])) {
      const sf = SF[a3];
      if (!sf || v.price == null) continue;
      const unit = Math.pow(10, -sf.decimals);
      for (const field of Object.keys(globalRates)) {
        if (v[field] == null) continue;
        const reg = regionalOf(a3);
        const candidates = [globalRates[field]].concat(reg ? [reg.standard, reg.reduced] : []);
        const ok = candidates.some(rate => Math.abs(Engine.compute(sf, v.price, rate).developerProceeds - v[field]) <= unit * 1.001);
        const r = report[a3] || (report[a3] = { checked: 0, bad: 0, implied: [], obs: [], regional: !!reg });
        r.checked++;
        r.obs.push({ price: v.price, want: v[field], rate: globalRates[field] });
        if (!ok) { r.bad++; r.implied.push({ price: v.price, t: v.price * (1 - globalRates[field]) / v[field] - 1 }); }
      }
    }
  }
  return report;
}
function refit(Engine, DATA, report) {
  const tax = DATA.tax, changed = [];
  const SF = Object.fromEntries(DATA.storefronts.map(s => [s.a3, s]));
  for (const [a3, r] of Object.entries(report)) {
    const rule = tax.rules[a3], sf = SF[a3];
    if (!r.bad || r.bad < r.checked * 0.5 || !rule || rule.d || r.regional) continue;
    const top = r.implied.sort((a, b) => b.price - a.price).slice(0, 5).map(x => x.t).sort((a, b) => a - b);
    const raw = top[Math.floor(top.length / 2)];
    const before = { ...rule };
    /* prefer a round rate, but only if it reproduces Apple's numbers at least as well */
    const misses = t => {
      Object.assign(rule, t > 0.0005 ? { mode: 'included', t } : { mode: 'none', t: 0 });
      delete rule.round30;
      const unit = Math.pow(10, -sf.decimals) * 1.001;
      return r.obs.filter(o => Math.abs(Engine.compute(sf, o.price, o.rate).developerProceeds - o.want) > unit).length;
    };
    const candidates = [Math.round(raw * 2000) / 2000, Math.round(raw * 1e4) / 1e4, Math.round(raw * 1e6) / 1e6];
    const t = candidates.map(c => [c, misses(c)]).sort((a, b) => a[1] - b[1])[0][0];
    const left = misses(t);
    if (rule.mode === 'included') rule.label = before.label || 'Taxes'; else delete rule.label;
    rule.note = `Effective rate refit from the proceeds App Store Connect reported for your account on ${TODAY}.`;
    changed.push(`${a3}: ${((before.t || 0) * 100).toFixed(2)}% -> ${(t * 100).toFixed(2)}%` + (left ? ` (${left}/${r.checked} values still differ)` : ''));
  }
  if (changed.length) tax.updated = TODAY;
  return changed;
}

/* ---------------------------------------------------------------- main */
let html = fs.readFileSync(OUT, 'utf8');
const DATA = {
  storefronts: readBlock(html, 'data-storefronts'),
  prices: readBlock(html, 'data-prices'),
  tax: readBlock(html, 'data-tax'),
  commission: readBlock(html, 'data-commission'),
};
const Engine = loadEngine(html, DATA);

console.log('Reading storefronts …');
const territories = (await getAll('/v1/territories?limit=200')).data;
const known = new Set(DATA.storefronts.map(s => s.a3));
for (const t of territories) {
  const sf = DATA.storefronts.find(s => s.a3 === t.id);
  if (!sf) { console.warn(`  New storefront ${t.id} is not in #data-storefronts. Add it there (name, region, alpha-2 code) to show it.`); continue; }
  if (t.attributes && t.attributes.currency && sf.currency !== t.attributes.currency) {
    console.log(`  ${t.id}: currency ${sf.currency} -> ${t.attributes.currency}`);
    sf.currency = t.attributes.currency;
  }
}
console.log(`${territories.length} storefronts from Apple, ${known.size} in index.html`);

const ids = await discover();
const fetched = [];
for (const kind of MODELS) {
  let ladder = LADDERS[kind], productId = ids[kind];
  if (kind === 'iap' && !productId) { ladder = LADDERS.app; productId = ids.app; console.log('\nNo In-App Purchase found; using paid-app price points.'); }
  if (!productId) { console.warn(`\nNo ${kind} product found in this account, skipping. Pass --${kind}=ID to choose one.`); continue; }
  fetched.push({ kind, ...(await fetchLadder(kind, ladder, productId)) });
}
if (!fetched.length) fail('Nothing was fetched.');

/* merge into the prices block */
const prices = DATA.prices;
const order = [...new Set([...(prices.order || []), ...DATA.storefronts.map(s => s.a3)])].sort();
const reindex = old => order.map(a3 => { const i = (prices.order || []).indexOf(a3); return i < 0 ? null : old[i]; });
prices.sources = prices.sources || [];
const src = prices.sources.push({ label: 'App Store Connect API, fetched with your own API key', url: 'https://developer.apple.com/documentation/appstoreconnectapi', asOf: TODAY }) - 1;
for (const kind of ['iap', 'subscription']) {
  const block = prices[kind] || (prices[kind] = { tiers: [], sets: {} });
  for (const set of Object.values(block.sets)) set.p = reindex(set.p);
  const f = fetched.find(x => x.kind === kind);
  if (!f) continue;
  block.tiers = f.allTiers;
  for (const tier of Object.keys(block.sets)) if (!f.allTiers.includes(tier)) delete block.sets[tier];
  for (const [tier, map] of Object.entries(f.rows)) {
    block.sets[tier] = { src, p: order.map(a3 => (map[a3] && map[a3].price != null ? map[a3].price : null)) };
  }
}
prices.order = order;
/* drop sources no price set refers to any more */
const allSets = ['iap', 'subscription'].flatMap(k => Object.values(prices[k].sets));
const usedSources = [...new Set(allSets.map(s => s.src))].sort((a, b) => a - b);
for (const set of allSets) set.src = usedSources.indexOf(set.src);
prices.sources = usedSources.map(i => prices.sources[i]);
const complete = usedSources.length === 1 && usedSources[0] === src;
prices.meta = {
  updated: TODAY,
  kind: complete ? 'asc-api' : 'mixed',
  note: complete
    ? `All embedded prices were fetched from the App Store Connect API on ${TODAY}.`
    : `Some price points were fetched from the App Store Connect API on ${TODAY}; the rest are from older public snapshots.`,
};

/* check the tax rules against the proceeds Apple just reported */
const report = validateTax(Engine, DATA, fetched);
const off = Object.entries(report).filter(([, r]) => r.bad);
console.log(`\nTax rules: ${Object.keys(report).length - off.length} storefronts reproduce Apple's proceeds, ${off.length} do not.`);
for (const [a3, r] of off) {
  const t = r.implied.sort((a, b) => b.price - a.price)[0].t;
  console.log(`  ${a3}: ${r.bad}/${r.checked} values differ; implied effective tax ${(t * 100).toFixed(2)}% (rule says ${((DATA.tax.rules[a3] || {}).t * 100 || 0).toFixed(2)}%)${r.regional ? ' [regional commission storefront, check the rate]' : ''}`);
}
let taxChanged = [];
if (args['update-tax']) {
  taxChanged = refit(Engine, DATA, report);
  console.log(taxChanged.length ? `Updated tax rules:\n  ${taxChanged.join('\n  ')}` : 'No tax rules needed updating.');
} else if (off.length) {
  console.log('  Re-run with --update-tax to rewrite simple rules from these proceeds, or edit #data-tax by hand.');
}

if (args['dry-run']) {
  console.log(`\nDry run: ${requests} requests, index.html not modified.`);
} else {
  html = writeBlock(html, 'data-storefronts', DATA.storefronts);
  html = writeBlock(html, 'data-prices', prices);
  if (taxChanged.length) html = writeBlock(html, 'data-tax', DATA.tax);
  fs.writeFileSync(OUT, html);
  const n = k => Object.keys(prices[k].sets).length;
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)} (${(html.length / 1e6).toFixed(2)} MB, ${requests} requests).`);
  console.log(`In-App Purchase: ${prices.iap.tiers.length} price points, ${n('iap')} with localized prices.`);
  console.log(`Subscription: ${prices.subscription.tiers.length} price points, ${n('subscription')} with localized prices.`);
}
const missing = fetched.reduce((sum, f) => sum + f.missing, 0);
if (missing) {
  console.warn(`\n${missing} price points are still missing. Everything fetched so far is cached, so run the same command again to get only the missing ones. If the same ones keep failing, wait a few minutes or use --concurrency=1.`);
  process.exitCode = 2;
}
