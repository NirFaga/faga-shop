/**
 * FAGA public shop (fagamedia.com/shop) — Stripe Checkout + Printful drafts.
 *
 * Script properties you set yourself (Project Settings → Script properties):
 *   STRIPE_SECRET_KEY   sk_live_… (or sk_test_… while testing). Until it is set the shop shows "orders open soon".
 *   PRINTFUL_TOKEN      already set for the merch shop.
 * Run setupShop() once from the editor: it authorises the script and adds the 10-minute order sweep.
 *
 * Flow: shop → doPost {action:'checkout'} → prices recomputed here from catalog.json → Stripe Checkout Session
 *       → customer pays on Stripe → shopSweep_() (thank-you page + every 10 min) → "Shop orders" sheet,
 *       email to you, Printful DRAFT order with the customer's address (you confirm it in Printful).
 */
const SHOP_CATALOG_URL = 'https://nirfaga.github.io/faga-shop/catalog.json';
const SHOP_URL = 'https://www.fagamedia.com/shop';
const SHOP_THANKS_URL = 'https://nirfaga.github.io/faga-shop/#thanks?sid={CHECKOUT_SESSION_ID}';
const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_VERSION = '2024-06-20';

// ---------- router (signups keep working) ----------
function doPost(e) {
  const type = (e && e.postData && e.postData.type) || '';
  if (type.indexOf('application/x-www-form-urlencoded') === 0 || !(e && e.postData)) return signupPost_(e);
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ error: 'bad_request' }); }
  try {
    if (body.action === 'config') return json_(shopConfig_());
    if (body.action === 'checkout') return json_(shopCheckout_(body));
    if (body.action === 'status') return json_(shopStatus_(body));
    if (body.action === 'specs') return json_(shopSpecs_(body));
    if (body.action === 'estimate') return json_(shopEstimate_(body));
    return json_({ error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json_({ error: 'server', message: String(err.message || err).slice(0, 300) });
  }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function shopConfig_() { return { live: !!stripeKey_() }; }
function stripeKey_() { return PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY') || ''; }

// ---------- catalog + prices (same rules as the shop page) ----------
function catalog_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('shop_catalog');
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch(SHOP_CATALOG_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Catalog unavailable (' + res.getResponseCode() + ')');
  const txt = res.getContentText();
  try { cache.put('shop_catalog', txt, 600); } catch (e) {}
  return JSON.parse(txt);
}
function nice_(x, cur) {
  if (cur === 'ILS') return Math.ceil((x + 1) / 10) * 10 - 1;
  if (cur === 'USD') return Math.ceil(x);
  return Math.ceil(x / 5) * 5;
}
function localPrice_(cat, c, usd) {
  const fx = c.cur === 'USD' ? 0 : cat.fx;
  return nice_(usd * c.rate * (1 + fx) * (c.incl ? 1 + c.vat : 1), c.cur);
}
const r2_ = function (n) { return Math.round(n * 100) / 100; };
/** Cart → priced lines + totals. Throws a customer-readable message on anything not sellable. */
function priceCart_(cat, countryCode, items, code) {
  const c = cat.countries[countryCode];
  if (!c) throw new Error('We do not ship to that country yet.');
  if (!Array.isArray(items) || !items.length) throw new Error('Your bag is empty.');
  if (items.length > 20) throw new Error('Too many lines in one order.');
  const now = Date.now(), useCode = String(code || '').toUpperCase() === 'WELCOME10';
  const lines = items.map(function (it) {
    const d = (cat.designs || []).filter(function (x) { return x.id === String(it.d); })[0];
    const v = d && d.variants.filter(function (x) { return x.pid === String(it.v); })[0];
    if (!d || !v) throw new Error('An item in your bag is no longer available.');
    if (v.status !== 'live') throw new Error(d.name + ' in ' + v.colour + ' is coming soon and cannot be ordered yet.');
    if (d.drop === 2 && now < Date.parse(cat.drop2)) throw new Error(d.name + ' releases with Drop 02.');
    const size = String(it.s), q = Math.floor(Number(it.q));
    if (!v.pf || !v.pf.variants || !v.pf.variants[size]) throw new Error(d.name + ' in ' + v.colour + ' is not available in size ' + size + '.');
    if (!(q >= 1 && q <= 10)) throw new Error('Quantity must be between 1 and 10.');
    const unit = localPrice_(cat, c, d.price), unitDisc = useCode ? r2_(unit * 0.10) : 0;
    return { d: d, v: v, size: size, q: q, unit: unit, unitDisc: unitDisc };
  });
  const sub = lines.reduce(function (s, l) { return s + l.unit * l.q; }, 0);
  const disc = r2_(lines.reduce(function (s, l) { return s + l.unitDisc * l.q; }, 0));
  const net = sub - disc;
  const ship = net >= c.free ? 0 : c.ship;
  const goodsNet = c.incl ? net / (1 + c.vat) : net;
  let duty = 0;
  if (c.duty === 'il' && goodsNet / c.rate > 500) duty = goodsNet * 0.12;
  if (c.duty === 'uk' && goodsNet > 135) duty = goodsNet * 0.12;
  if (c.duty === 'au' && goodsNet > 1000) duty = goodsNet * 0.05;
  duty = r2_(duty);
  return { c: c, lines: lines, sub: sub, disc: disc, ship: ship, duty: duty, total: r2_(net + ship + duty), code: useCode ? 'WELCOME10' : '' };
}

// ---------- Stripe ----------
function stripe_(method, path, params) {
  const key = stripeKey_(); if (!key) throw new Error('STRIPE_SECRET_KEY is not set.');
  const opts = { method: method, headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': STRIPE_VERSION }, muteHttpExceptions: true };
  if (params) { opts.contentType = 'application/x-www-form-urlencoded'; opts.payload = form_(params); }
  const res = UrlFetchApp.fetch(STRIPE_API + path, opts);
  const j = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) throw new Error('Stripe ' + res.getResponseCode() + ': ' + ((j.error && j.error.message) || res.getContentText()).slice(0, 300));
  return j;
}
/** Nested object → Stripe form encoding (a[b][0][c]=…). */
function form_(o, prefix, out) {
  out = out || [];
  Object.keys(o).forEach(function (k) {
    const v = o[k], key = prefix ? prefix + '[' + k + ']' : k;
    if (v === undefined || v === null) return;
    if (typeof v === 'object') form_(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  });
  return out.join('&');
}
const minor_ = function (n) { return Math.round(n * 100); };

function shopCheckout_(body) {
  if (!stripeKey_()) return { error: 'not_live' };
  const cat = catalog_();
  let p;
  try { p = priceCart_(cat, String(body.country || ''), body.items, body.code); }
  catch (err) { return { error: 'cart', message: String(err.message) }; }
  const cur = p.c.cur.toLowerCase();
  const lineItems = p.lines.map(function (l) {
    const img = l.v.img ? cat.base + l.v.img : null;
    return {
      quantity: l.q,
      price_data: {
        currency: cur, unit_amount: minor_(l.unit - l.unitDisc),
        product_data: {
          name: 'FAGA ' + l.d.name + ' — ' + l.v.colour + ' / ' + l.size,
          description: (l.unitDisc ? 'Includes WELCOME10 (−10%). ' : '') + (p.c.incl ? p.c.vatName + ' included.' : ''),
          images: img ? [img] : undefined,
          metadata: { d: l.d.id, v: l.v.pid, s: l.size }
        }
      }
    };
  });
  if (p.duty > 0) lineItems.push({ quantity: 1, price_data: { currency: cur, unit_amount: minor_(p.duty), product_data: { name: 'Import duties (prepaid)', metadata: { duty: '1' } } } });
  lineItems.forEach(function (li) { if (!li.price_data.product_data.description) delete li.price_data.product_data.description; });
  const params = {
    mode: 'payment',
    line_items: lineItems,
    success_url: SHOP_THANKS_URL,
    cancel_url: SHOP_URL,
    shipping_address_collection: { allowed_countries: [String(body.country)] },
    shipping_options: [{ shipping_rate_data: {
      type: 'fixed_amount', display_name: p.ship ? 'Standard shipping' : 'Free shipping',
      fixed_amount: { amount: minor_(p.ship), currency: cur },
      delivery_estimate: deliveryEstimate_(p.c.eta)
    } }],
    phone_number_collection: { enabled: true },
    billing_address_collection: 'auto',
    locale: 'auto',
    metadata: { faga: 'shop', country: String(body.country), code: p.code, total: String(p.total) },
    payment_intent_data: { description: 'FAGA order', metadata: { faga: 'shop' } }
  };
  if (body.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email))) params.customer_email = String(body.email).slice(0, 200);
  const s = stripe_('post', '/checkout/sessions', params);
  return { url: s.url, id: s.id, total: p.total, currency: p.c.cur };
}
function deliveryEstimate_(eta) {
  const m = String(eta || '').match(/(\d+)\D+(\d+)/);
  if (!m) return undefined;
  return { minimum: { unit: 'business_day', value: Number(m[1]) }, maximum: { unit: 'business_day', value: Number(m[2]) } };
}

/** Thank-you page / returning shopper: is this session paid? Also fulfils it right away. */
function shopStatus_(body) {
  const sid = String(body.sid || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sid)) return { error: 'bad_sid' };
  if (!stripeKey_()) return { error: 'not_live' };
  const s = stripe_('get', '/checkout/sessions/' + sid);
  const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
  if (paid) { try { fulfil_(s); } catch (err) { console.error(err); } }
  return { paid: paid, status: s.status, email: (s.customer_details && s.customer_details.email) || '', total: s.amount_total / 100, currency: String(s.currency || '').toUpperCase(), ref: shopRef_(sid) };
}
const shopRef_ = function (sid) { return 'FAGA-' + sid.slice(-8).toUpperCase(); };

// ---------- fulfilment ----------
/** Every 10 minutes (setupShop): fulfil any paid session from the last 3 days not handled yet. */
function shopSweep_() {
  if (!stripeKey_()) return;
  const since = Math.floor(Date.now() / 1000) - 3 * 86400;
  const list = stripe_('get', '/checkout/sessions?limit=50&status=complete&created[gte]=' + since);
  (list.data || []).forEach(function (s) {
    if (!s.metadata || s.metadata.faga !== 'shop') return;
    if (s.payment_status !== 'paid') return;
    try { fulfil_(s); } catch (err) { console.error(err); }
  });
}
function fulfil_(s) {
  const props = PropertiesService.getScriptProperties(), key = 'DONE_' + s.id;
  if (props.getProperty(key)) return;
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (props.getProperty(key)) return;
    props.setProperty(key, String(Date.now()));          // claim first: never two drafts for one payment
    const cat = catalog_();
    const li = stripe_('get', '/checkout/sessions/' + s.id + '/line_items?limit=100&expand[]=data.price.product');
    const ship = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || {};
    const a = ship.address || {}, cust = s.customer_details || {};
    const recipient = { name: ship.name || cust.name || '', email: cust.email || '', phone: cust.phone || '',
      address1: a.line1 || '', address2: a.line2 || '', city: a.city || '', state_code: a.state || '', country_code: a.country || '', zip: a.postal_code || '' };
    const ref = shopRef_(s.id), lines = [], pfItems = [];
    (li.data || []).forEach(function (row) {
      const md = (row.price && row.price.product && row.price.product.metadata) || {};
      if (md.duty) { lines.push('Import duties (prepaid) — ' + money_(row.amount_total, s.currency)); return; }
      const d = cat.designs.filter(function (x) { return x.id === md.d; })[0];
      const v = d && d.variants.filter(function (x) { return x.pid === md.v; })[0];
      lines.push(row.quantity + ' × ' + (row.description || (d && d.name)) + ' — ' + money_(row.amount_total, s.currency));
      if (!v || !v.pf) return;
      pfItems.push({
        variant_id: v.pf.variants[md.s], quantity: row.quantity,
        retail_price: (row.amount_total / row.quantity / 100).toFixed(2),
        name: 'FAGA ' + d.name + ' · ' + v.colour + ' · ' + md.s,
        files: v.pf.files.map(function (f) { return { type: f.type, url: cat.base + f.url }; }),
        options: v.pf.options || []
      });
    });
    let status;
    try {
      const o = pf_('post', '/orders', { external_id: ref, shipping: 'STANDARD', recipient: recipient, items: pfItems });
      status = 'Printful draft ' + o.id + ' — confirm it in Printful';
    } catch (err) { status = 'NOT sent to Printful: ' + String(err.message || err).slice(0, 300); }
    const total = money_(s.amount_total, s.currency);
    const addr = [recipient.address1, recipient.address2, recipient.city, recipient.state_code, recipient.zip, recipient.country_code].filter(Boolean).join(', ');
    try {
      const ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID') || setup().sheetId);
      let sh = ss.getSheetByName('Shop orders');
      if (!sh) { sh = ss.insertSheet('Shop orders'); sh.appendRow(['Date', 'Ref', 'Stripe session', 'Name', 'Email', 'Phone', 'Address', 'Items', 'Total', 'Code', 'Fulfilment']); }
      sh.appendRow([new Date(), ref, s.id, recipient.name, recipient.email, recipient.phone, addr, lines.join('\n'), total, (s.metadata && s.metadata.code) || '', status]);
    } catch (err) { console.error(err); }
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'FAGA shop order ' + ref + ' — ' + total + ' — ' + recipient.name,
        'Paid order ' + ref + ' (' + s.id + ')\n\n' + lines.join('\n') + '\n\nTotal paid: ' + total + '\n\n' + recipient.name + '\n' + recipient.email + '\n' + recipient.phone + '\n' + addr +
        '\n\n' + status + '\nPrintful: https://www.printful.com/dashboard/default/orders\nStripe: https://dashboard.stripe.com/payments/' + (s.payment_intent || ''));
    } catch (err) { console.error(err); }
  } finally { lock.releaseLock(); }
}
function money_(minor, cur) { return (minor / 100).toFixed(2) + ' ' + String(cur || '').toUpperCase(); }

// ---------- one-off helpers ----------
/** Run once from the editor after adding STRIPE_SECRET_KEY: authorises and schedules the order sweep. */
function setupShop() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'shopSweep_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('shopSweep_').timeBased().everyMinutes(10).create();
  catalog_();
  return 'Shop ready. Stripe key ' + (stripeKey_() ? 'found' : 'MISSING — add STRIPE_SECRET_KEY in Script properties') + '.';
}
/** Printful print-file sizes for the build (no customer data). */
function shopSpecs_(body) {
  const out = {};
  (body.products || []).slice(0, 12).forEach(function (p) {
    const id = Number(p.id), tech = String(p.technique || '').replace(/[^A-Z_]/g, '');
    if (!id || !tech) return;
    const pf = printfiles_(id, tech);
    out[id + '_' + tech] = { printfiles: pf.printfiles, placements: (pf.variant_printfiles || []).slice(0, 1), available: pf.available_placements };
  });
  return out;
}
/** Validate a catalog item against Printful without creating anything (cost estimate). */
function shopEstimate_(body) {
  const cat = catalog_(), items = [];
  (body.items || []).slice(0, 30).forEach(function (it) {
    const d = cat.designs.filter(function (x) { return x.id === it.d; })[0], v = d && d.variants.filter(function (x) { return x.pid === it.v; })[0];
    if (!v || !v.pf) return;
    items.push({ variant_id: v.pf.variants[it.s], quantity: 1, files: v.pf.files.map(function (f) { return { type: f.type, url: cat.base + f.url }; }), options: v.pf.options || [] });
  });
  return pf_('post', '/orders/estimate-costs', { recipient: { address1: 'Hazait 74', city: 'Zerufa', country_code: 'IL', zip: '3085000' }, items: items });
}
