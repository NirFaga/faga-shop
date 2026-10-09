/**
 * FAGA shop API — Cloudflare Pages Function at /api (replaces the Apps Script backend).
 *
 * Bindings (Cloudflare → Pages project → Settings):
 *   KV namespace  SHOP                      pending orders, paid orders, sign-ups
 * Secrets / variables (Settings → Variables and secrets) — you enter these yourself:
 *   PAYONEER_MERCHANT_CODE, PAYONEER_API_TOKEN   from the Payoneer Checkout portal
 *   PAYONEER_ENV        "sandbox" while testing, "live" when real (default sandbox)
 *   PAYONEER_DIVISION   optional
 *   PRINTFUL_TOKEN      Printful private token; PRINTFUL_STORE_ID only for an account-level token
 *   RESEND_API_KEY      optional, for order emails (resend.com, free tier); MAIL_FROM e.g. "FAGA <orders@fagamedia.com>"
 *   NOTIFY_EMAIL        where new-order emails go (default nir@fagamedia.com)
 *   ADMIN_KEY           any long random string; lets you open /api?export=orders|signups&key=…
 *
 * Flow: shop → {action:'checkout'} → prices recomputed from /catalog.json → Payoneer LIST (HOSTED) → customer pays
 *       → Payoneer notification to /api → charge verified with Payoneer's API → Printful DRAFT order + emails.
 */
const PN_TYPE = 'application/vnd.optile.payment.enterprise-v1-extensible+json';
const SHOP_PAGE = 'https://www.fagamedia.com/shop';
const TX_RE = /^FAGA-[A-Z0-9]{8}$/;
const DAY = 86400;

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  try {
    const q = Object.fromEntries(url.searchParams);
    if (q.export) return exportData(env, q);
    let form = {}, body = null;
    if (request.method === 'POST') {
      const type = request.headers.get('content-type') || '';
      const raw = await request.text();
      if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/')) form = Object.fromEntries(new URLSearchParams(raw));
      else { try { body = JSON.parse(raw || '{}'); } catch (e) { form = Object.fromEntries(new URLSearchParams(raw)); } }
    }
    const prm = { ...q, ...form };
    if (prm.notificationId || (prm.entity && prm.transactionId && prm.statusCode)) {
      ctx.waitUntil(notify(env, url, prm).catch(e => console.error(e)));
      return new Response('OK');
    }
    if (!body && prm.email) return json(await signup(env, prm, request));
    if (!body) return json({ ok: true, service: 'FAGA shop API' });
    const a = body.action;
    if (a === 'config') return json(config(env));
    if (a === 'checkout') return json(await checkout(env, url, body));
    if (a === 'status') return json(await status(env, url, body));
    if (a === 'signup') return json(await signup(env, body, request));
    if (a === 'estimate') return (env.ADMIN_KEY && body.key === env.ADMIN_KEY) ? json(await estimate(env, url, body)) : json({ error: 'forbidden' }, 403);
    return json({ error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json({ error: 'server', message: String(err && err.message || err).slice(0, 300) });
  }
}

const cors = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...cors() } });
const r2 = n => Math.round(n * 100) / 100;
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const getJ = async (env, k) => { const t = await env.SHOP.get(k); return t ? JSON.parse(t) : null; };

function pnCfg(env) {
  return { code: env.PAYONEER_MERCHANT_CODE || '', token: env.PAYONEER_API_TOKEN || '',
           env: String(env.PAYONEER_ENV || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox', division: env.PAYONEER_DIVISION || '' };
}
function config(env) { const c = pnCfg(env); return { live: !!(c.code && c.token && env.SHOP), env: c.env }; }

// ---------- catalog + prices (same rules as the shop page) ----------
let CAT = null, CAT_AT = 0;
async function catalog(env, url) {
  if (CAT && Date.now() - CAT_AT < 300000) return CAT;
  const req = new Request(new URL('/catalog.json', url.origin).toString());
  const res = env.ASSETS ? await env.ASSETS.fetch(req) : await fetch(req);
  if (!res.ok) throw new Error('Catalog unavailable (' + res.status + ')');
  CAT = await res.json(); CAT_AT = Date.now();
  return CAT;
}
function nice(x, cur) {
  if (cur === 'ILS') return Math.ceil((x + 1) / 10) * 10 - 1;
  if (cur === 'USD') return Math.ceil(x);
  return Math.ceil(x / 5) * 5;
}
function localPrice(cat, c, usd) {
  const fx = c.cur === 'USD' ? 0 : cat.fx;
  return nice(usd * c.rate * (1 + fx) * (c.incl ? 1 + c.vat : 1), c.cur);
}
/** Cart → priced lines + totals. Throws a customer-readable message on anything not sellable. */
export async function priceCart(cat, countryCode, items, code, now = Date.now()) {
  const c = cat.countries[countryCode];
  if (!c) throw new Error('We do not ship to that country yet.');
  if (!Array.isArray(items) || !items.length) throw new Error('Your bag is empty.');
  if (items.length > 20) throw new Error('Too many lines in one order.');
  const useCode = String(code || '').toUpperCase() === 'WELCOME10';
  const lines = [];
  for (const it of items) {
    const d = (cat.designs || []).find(x => x.id === String(it.d));
    const v = d && d.variants.find(x => x.pid === String(it.v));
    if (!d || !v) throw new Error('An item in your bag is no longer available.');
    if (v.status !== 'live') throw new Error(d.name + ' in ' + v.colour + ' is coming soon and cannot be ordered yet.');
    if (d.drop === 2 && now < Date.parse(cat.drop2)) throw new Error(d.name + ' releases with Drop 02.');
    const size = String(it.s), q = Math.floor(Number(it.q));
    if (!v.pf || !(await pfVariantId(v, size))) throw new Error(d.name + ' in ' + v.colour + ' is not available in size ' + size + '.');
    if (!(q >= 1 && q <= 10)) throw new Error('Quantity must be between 1 and 10.');
    const unit = localPrice(cat, c, d.price), unitDisc = useCode ? r2(unit * 0.10) : 0;
    lines.push({ d, v, size, q, unit, unitDisc });
  }
  const sub = lines.reduce((s, l) => s + l.unit * l.q, 0);
  const disc = r2(lines.reduce((s, l) => s + l.unitDisc * l.q, 0));
  const net = sub - disc;
  const ship = net >= c.free ? 0 : c.ship;
  const goodsNet = c.incl ? net / (1 + c.vat) : net;
  let duty = 0;
  if (c.duty === 'il' && goodsNet / c.rate > 500) duty = goodsNet * 0.12;
  if (c.duty === 'uk' && goodsNet > 135) duty = goodsNet * 0.12;
  if (c.duty === 'au' && goodsNet > 1000) duty = goodsNet * 0.05;
  duty = r2(duty);
  return { c, lines, sub, disc, ship, duty, total: r2(net + ship + duty), code: useCode ? 'WELCOME10' : '' };
}
/** Printful variant id: from the catalog, else Printful's public catalog (colour + size match). */
const PF_PRODUCTS = {};
async function pfVariantId(v, size) {
  if (v.pf.variants && v.pf.variants[size]) return v.pf.variants[size];
  let p = PF_PRODUCTS[v.pf.product];
  if (!p) {
    const res = await fetch('https://api.printful.com/products/' + v.pf.product);
    if (!res.ok) return null;
    p = PF_PRODUCTS[v.pf.product] = (await res.json()).result;
  }
  const hit = (p.variants || []).find(x => x.color === v.pf.colour && x.size === size && x.in_stock !== false);
  return hit ? hit.id : null;
}

// ---------- Payoneer Checkout ----------
async function pn(env, method, path, body) {
  const c = pnCfg(env); if (!c.code || !c.token) throw new Error('Payoneer is not configured.');
  const res = await fetch('https://api.' + c.env + '.oscato.com/api' + path, {
    method: method.toUpperCase(),
    headers: { Authorization: 'Basic ' + btoa(c.code + ':' + c.token), Accept: PN_TYPE, 'Content-Type': PN_TYPE },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await res.text(); let j = {};
  try { j = JSON.parse(txt || '{}'); } catch (e) { j = { raw: txt.slice(0, 300) }; }
  if (res.status >= 300) throw new Error('Payoneer ' + res.status + ': ' + String(j.resultInfo || j.raw || txt).slice(0, 300));
  return j;
}

async function checkout(env, url, body) {
  const cfg = pnCfg(env);
  if (!cfg.code || !cfg.token || !env.SHOP) return { error: 'not_live' };
  const cat = await catalog(env, url), country = String(body.country || '');
  let p;
  try { p = await priceCart(cat, country, body.items, body.code); }
  catch (err) { return { error: 'cart', message: String(err.message) }; }
  const c = body.customer || {};
  const cust = { name: clean(c.name, 80), email: clean(c.email, 120), phone: clean(c.phone, 40), address1: clean(c.address1, 120),
                 address2: clean(c.address2, 120), city: clean(c.city, 60), state: clean(c.state, 40), zip: clean(c.zip, 20) };
  if (!cust.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cust.email) || !cust.address1 || !cust.city || !cust.zip)
    return { error: 'cart', message: 'Please fill in your name, email and full shipping address.' };
  if (['US', 'CA', 'AU'].includes(country) && !cust.state) return { error: 'cart', message: 'Please add your state or province.' };
  const tx = 'FAGA-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const parts = cust.name.split(/\s+/), name = { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
  const addr = { street: [cust.address1, cust.address2].filter(Boolean).join(', '), zip: cust.zip, city: cust.city, state: cust.state || undefined, country, name };
  const products = p.lines.map(l => ({ code: l.v.pid + '-' + l.size, name: 'FAGA ' + l.d.name + ' — ' + l.v.colour + ' / ' + l.size, quantity: l.q,
    amount: r2((l.unit - l.unitDisc) * l.q), type: 'PHYSICAL', productImageUrl: l.v.img ? cat.base + l.v.img : undefined }));
  if (p.ship) products.push({ code: 'shipping', name: 'Shipping', quantity: 1, amount: r2(p.ship), type: 'OTHER' });
  if (p.duty) products.push({ code: 'duty', name: 'Import duties (prepaid)', quantity: 1, amount: r2(p.duty), type: 'TAX' });
  const origin = url.origin + '/';
  const list = {
    transactionId: tx, country, integration: 'HOSTED',
    customer: { number: cust.email, email: cust.email, name, addresses: { shipping: addr, billing: addr },
                phones: cust.phone ? { mobile: { unstructuredNumber: cust.phone } } : undefined },
    payment: { amount: p.total, currency: p.c.cur, reference: 'FAGA order ' + tx, invoiceId: tx },
    products,
    callback: { returnUrl: origin + '?tx=' + tx, cancelUrl: SHOP_PAGE, notificationUrl: origin + 'api' },
    style: { language: 'en', hostedVersion: 'v6' },
    preselection: { direction: 'CHARGE' }
  };
  if (cfg.division) list.division = cfg.division;
  const res = await pn(env, 'post', '/lists', list);
  const listId = res.identification && res.identification.longId;
  let link = res.redirect && res.redirect.url;
  if (link && res.redirect.parameters && res.redirect.parameters.length)
    link += (link.includes('?') ? '&' : '?') + res.redirect.parameters.map(x => encodeURIComponent(x.name) + '=' + encodeURIComponent(x.value)).join('&');
  if (!link && listId) link = 'https://resources.' + cfg.env + '.oscato.com/paymentpage/v6/responsive.html?listId=' + encodeURIComponent(listId) + '&lang=en';
  if (!link) return { error: 'server', message: 'Payment page unavailable (' + (res.resultInfo || res.resultCode || 'no redirect') + ').' };
  await env.SHOP.put('PEND_' + tx, JSON.stringify({
    tx, listId, country, code: p.code, total: p.total, cur: p.c.cur, customer: cust, created: Date.now(),
    items: p.lines.map(l => ({ d: l.d.id, v: l.v.pid, s: l.size, q: l.q, paid: r2((l.unit - l.unitDisc) * l.q) })),
    ship: p.ship, duty: p.duty }), { expirationTtl: 7 * DAY });
  return { url: link, id: tx, total: p.total, currency: p.c.cur };
}

/** Payoneer status notification → verify the charge with Payoneer → fulfil. */
async function notify(env, url, prm) {
  const tx = String(prm.transactionId || ''), longId = String(prm.longId || '');
  if (TX_RE.test(tx) && longId && String(prm.entity || 'payment') === 'payment') await verifyAndFulfil(env, url, tx, longId);
}
const PAID = ['charged', 'paid_out'];
/** Paid only if Payoneer's API says this charge is charged/paid out for this transaction. */
async function verifyAndFulfil(env, url, tx, chargeId) {
  if (await env.SHOP.get('DONE_' + tx)) return true;
  const pend = await getJ(env, 'PEND_' + tx); if (!pend) return false;
  let ch;
  try { ch = await pn(env, 'get', '/charges/' + encodeURIComponent(chargeId)); } catch (err) { console.error(err); return false; }
  const st = ch.status && ch.status.code, idt = ch.identification || {};
  if (!PAID.includes(String(st)) || String(idt.transactionId || '') !== tx) return false;
  await fulfil(env, url, pend, chargeId);
  return true;
}
async function status(env, url, body) {
  const tx = String(body.tx || '');
  if (!TX_RE.test(tx)) return { error: 'bad_tx' };
  let paid = !!(await env.SHOP.get('DONE_' + tx));
  if (!paid && body.longId) { try { paid = await verifyAndFulfil(env, url, tx, String(body.longId)); } catch (err) { console.error(err); } }
  const o = (await getJ(env, 'ORDER_' + tx)) || (await getJ(env, 'PEND_' + tx));
  return { paid, ref: tx, email: o ? o.customer.email : '', total: o ? o.total : null, currency: o ? o.cur : '' };
}

// ---------- fulfilment ----------
async function pf(env, method, path, body) {
  const h = { Authorization: 'Bearer ' + env.PRINTFUL_TOKEN, 'Content-Type': 'application/json' };
  if (env.PRINTFUL_STORE_ID) h['X-PF-Store-Id'] = String(env.PRINTFUL_STORE_ID);
  const res = await fetch('https://api.printful.com' + path, { method: method.toUpperCase(), headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Printful ' + res.status + ': ' + String((j.error && j.error.message) || j.result || '').slice(0, 300));
  return j.result;
}
async function fulfil(env, url, pend, chargeId) {
  const key = 'DONE_' + pend.tx;
  if (await env.SHOP.get(key)) return;
  await env.SHOP.put(key, String(Date.now()));   // claim first
  const cat = await catalog(env, url), c = pend.customer;
  const recipient = { name: c.name, email: c.email, phone: c.phone, address1: c.address1, address2: c.address2, city: c.city,
                      state_code: c.state, country_code: pend.country, zip: c.zip };
  const lines = [], pfItems = [];
  for (const it of pend.items) {
    const d = cat.designs.find(x => x.id === it.d), v = d && d.variants.find(x => x.pid === it.v);
    lines.push(it.q + ' × FAGA ' + (d ? d.name : it.d) + ' — ' + (v ? v.colour : it.v) + ' / ' + it.s + ' — ' + it.paid.toFixed(2) + ' ' + pend.cur);
    if (!v || !v.pf) continue;
    pfItems.push({ variant_id: await pfVariantId(v, it.s), quantity: it.q, retail_price: (it.paid / it.q).toFixed(2),
      name: 'FAGA ' + d.name + ' · ' + v.colour + ' · ' + it.s,
      files: v.pf.files.map(f => ({ type: f.type, url: cat.base + f.url })), options: v.pf.options || [] });
  }
  if (pend.ship) lines.push('Shipping — ' + pend.ship.toFixed(2) + ' ' + pend.cur);
  if (pend.duty) lines.push('Import duties (prepaid) — ' + pend.duty.toFixed(2) + ' ' + pend.cur);
  let fstatus, duplicate = false;
  try {
    const o = await pf(env, 'post', '/orders', { external_id: pend.tx, shipping: 'STANDARD', recipient, items: pfItems });
    fstatus = 'Printful draft ' + o.id + ' — confirm it in Printful';
  } catch (err) {
    fstatus = 'NOT sent to Printful: ' + String(err.message || err).slice(0, 300);
    duplicate = /external.?id/i.test(fstatus) && /exist|already|use/i.test(fstatus);   // a second notification for the same order
  }
  if (duplicate) return;
  const total = pend.total.toFixed(2) + ' ' + pend.cur;
  const addr = [c.address1, c.address2, c.city, c.state, c.zip, pend.country].filter(Boolean).join(', ');
  const order = { ...pend, charge: chargeId, paidAt: new Date().toISOString(), fulfilment: fstatus, lines };
  await env.SHOP.put('ORDER_' + pend.tx, JSON.stringify(order));
  await env.SHOP.delete('PEND_' + pend.tx);
  const owner = env.NOTIFY_EMAIL || 'nir@fagamedia.com';
  await mail(env, { to: owner, subject: 'FAGA shop order ' + pend.tx + ' — ' + total + ' — ' + c.name,
    text: 'Paid order ' + pend.tx + ' (Payoneer charge ' + chargeId + ')\n\n' + lines.join('\n') + '\n\nTotal paid: ' + total + '\n\n' +
          c.name + '\n' + c.email + '\n' + c.phone + '\n' + addr + '\n\n' + fstatus + '\nPrintful: https://www.printful.com/dashboard/default/orders' });
  await mail(env, { to: c.email, reply_to: owner, subject: 'Your FAGA order ' + pend.tx,
    text: 'Hi ' + c.name.split(' ')[0] + ',\n\nThanks for your order. It is now being printed and embroidered for you; you will get tracking by email when it ships.\n\n' +
          lines.join('\n') + '\n\nTotal paid: ' + total + '\nShipping to: ' + addr + '\n\nQuestions? Just reply to this email.\n\nFAGA — You can\'t hold it.' });
}
async function mail(env, m) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'FAGA <orders@fagamedia.com>', ...m }) });
    if (!res.ok) console.error('mail', res.status, await res.text());
    return res.ok;
  } catch (e) { console.error(e); return false; }
}

// ---------- sign-ups, exports, estimate ----------
async function signup(env, prm, request) {
  const email = clean(prm.email, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'bad_email' };
  if (!env.SHOP) return { ok: false };
  const row = { email, source: clean(prm.source, 60), country: clean(prm.country, 4), at: new Date().toISOString(),
                ipCountry: (request.cf && request.cf.country) || '' };
  await env.SHOP.put('SIGNUP_' + Date.now() + '_' + crypto.randomUUID().slice(0, 6), JSON.stringify(row));
  return { ok: true };
}
async function exportData(env, q) {
  if (!env.ADMIN_KEY || q.key !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
  const prefix = q.export === 'signups' ? 'SIGNUP_' : q.export === 'orders' ? 'ORDER_' : null;
  if (!prefix) return json({ error: 'unknown_export' }, 400);
  const rows = []; let cursor;
  do {
    const page = await env.SHOP.list({ prefix, cursor });
    for (const k of page.keys) rows.push(await getJ(env, k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const cols = prefix === 'SIGNUP_' ? ['at', 'email', 'source', 'country', 'ipCountry']
    : ['paidAt', 'tx', 'charge', 'name', 'email', 'phone', 'address', 'items', 'total', 'code', 'fulfilment'];
  const flat = r => prefix === 'SIGNUP_' ? r : { ...r, name: r.customer.name, email: r.customer.email, phone: r.customer.phone,
    address: [r.customer.address1, r.customer.address2, r.customer.city, r.customer.state, r.customer.zip, r.country].filter(Boolean).join(', '),
    items: (r.lines || []).join(' | '), total: r.total + ' ' + r.cur };
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [cols.join(',')].concat(rows.filter(Boolean).map(r => cols.map(c => esc(flat(r)[c])).join(','))).join('\n');
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'inline; filename="faga-' + q.export + '.csv"' } });
}
async function estimate(env, url, body) {
  const cat = await catalog(env, url), items = [];
  for (const it of (body.items || []).slice(0, 30)) {
    const d = cat.designs.find(x => x.id === it.d), v = d && d.variants.find(x => x.pid === it.v);
    if (!v || !v.pf) continue;
    items.push({ variant_id: await pfVariantId(v, it.s), quantity: 1, files: v.pf.files.map(f => ({ type: f.type, url: cat.base + f.url })), options: v.pf.options || [] });
  }
  return pf(env, 'post', '/orders/estimate-costs', { recipient: { address1: 'Hazait 74', city: 'Zerufa', country_code: 'IL', zip: '3085000' }, items });
}
