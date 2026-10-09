/**
 * FAGA public shop (fagamedia.com/shop) — Payoneer Checkout (hosted payment page) + Printful drafts.
 *
 * Script properties you set yourself (Project Settings → Script properties):
 *   PAYONEER_MERCHANT_CODE   your merchant code from the Payoneer Checkout portal
 *   PAYONEER_API_TOKEN       the payment API token from the same portal
 *   PAYONEER_ENV             "sandbox" while testing, "live" when real (default: sandbox)
 *   PAYONEER_DIVISION        optional, only if Payoneer gave you a division id
 *   PRINTFUL_TOKEN           already set for the merch shop
 * Until the merchant code and token are set, the shop shows "orders open soon".
 * Run setupShop() once from the editor: it authorises the script and adds the 10-minute order sweep.
 *
 * Flow: shop (bag + shipping details) → doPost {action:'checkout'} → prices recomputed here from catalog.json
 *       → Payoneer LIST session (HOSTED) → customer pays on Payoneer's page → Payoneer notification (+ thank-you page)
 *       → charge verified with Payoneer's API → "Shop orders" sheet, email to you, Printful DRAFT order.
 */
const SHOP_CATALOG_URL = 'https://nirfaga.github.io/faga-shop/catalog.json';
const SHOP_URL = 'https://www.fagamedia.com/shop';
const SHOP_RETURN_URL = 'https://nirfaga.github.io/faga-shop/';
const SHOP_EXEC_URL = 'https://script.google.com/macros/s/AKfycbywgEqI0Zx70K1KD2pMTz_wpy9B_UDhc6a_CK0c8z7N4UYJGD7J-k7Hg04QKQ5Sqh8-cQ/exec';
const PN_TYPE = 'application/vnd.optile.payment.enterprise-v1-extensible+json';

// ---------- routers (merch login page and signups keep working) ----------
function doGet(e) {
  if (isNotification_(e)) return text_(payoneerNotify_(e));
  return merchGet_();
}
function doPost(e) {
  if (isNotification_(e)) return text_(payoneerNotify_(e));
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
function text_(t) { return ContentService.createTextOutput(String(t)); }
function isNotification_(e) {
  const p = (e && e.parameter) || {};
  return !!(p.notificationId || (p.entity && p.transactionId && p.statusCode));
}

function pnProps_() {
  const p = PropertiesService.getScriptProperties();
  return { code: p.getProperty('PAYONEER_MERCHANT_CODE') || '', token: p.getProperty('PAYONEER_API_TOKEN') || '',
           env: (p.getProperty('PAYONEER_ENV') || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox', division: p.getProperty('PAYONEER_DIVISION') || '' };
}
function shopConfig_() { const c = pnProps_(); return { live: !!(c.code && c.token), env: c.env }; }

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
    if (!v.pf || !pfVariantId_(v, size)) throw new Error(d.name + ' in ' + v.colour + ' is not available in size ' + size + '.');
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

/** Printful variant id for a colourway + size: from the catalog, else looked up in Printful's public catalog. */
function pfVariantId_(v, size) {
  if (v.pf.variants && v.pf.variants[size]) return v.pf.variants[size];
  const hit = findVariant_(v.pf.product, v.pf.colour, size);
  return hit ? hit.id : null;
}

// ---------- Payoneer Checkout ----------
function pn_(method, path, body) {
  const c = pnProps_(); if (!c.code || !c.token) throw new Error('Payoneer is not configured.');
  const res = UrlFetchApp.fetch('https://api.' + c.env + '.oscato.com/api' + path, {
    method: method, muteHttpExceptions: true, contentType: PN_TYPE,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(c.code + ':' + c.token), Accept: PN_TYPE },
    payload: body ? JSON.stringify(body) : undefined
  });
  const txt = res.getContentText() || '{}'; let j = {};
  try { j = JSON.parse(txt); } catch (e) { j = { raw: txt.slice(0, 300) }; }
  if (res.getResponseCode() >= 300) throw new Error('Payoneer ' + res.getResponseCode() + ': ' + (j.resultInfo || j.raw || txt).toString().slice(0, 300));
  return j;
}
const a2_ = function (n) { return Math.round(n * 100) / 100; };
function clean_(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }

function shopCheckout_(body) {
  const cfg = pnProps_();
  if (!cfg.code || !cfg.token) return { error: 'not_live' };
  const cat = catalog_(), country = String(body.country || '');
  let p;
  try { p = priceCart_(cat, country, body.items, body.code); }
  catch (err) { return { error: 'cart', message: String(err.message) }; }
  const c = body.customer || {};
  const cust = { name: clean_(c.name, 80), email: clean_(c.email, 120), phone: clean_(c.phone, 40), address1: clean_(c.address1, 120),
                 address2: clean_(c.address2, 120), city: clean_(c.city, 60), state: clean_(c.state, 40), zip: clean_(c.zip, 20) };
  if (!cust.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cust.email) || !cust.address1 || !cust.city || !cust.zip)
    return { error: 'cart', message: 'Please fill in your name, email and full shipping address.' };
  if (['US', 'CA', 'AU'].indexOf(country) >= 0 && !cust.state) return { error: 'cart', message: 'Please add your state or province.' };
  const tx = 'FAGA-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  const parts = cust.name.split(/\s+/), name = { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
  const addr = { street: [cust.address1, cust.address2].filter(Boolean).join(', '), zip: cust.zip, city: cust.city, state: cust.state || undefined, country: country, name: name };
  const products = p.lines.map(function (l) {
    return { code: l.v.pid + '-' + l.size, name: 'FAGA ' + l.d.name + ' — ' + l.v.colour + ' / ' + l.size, quantity: l.q,
             amount: a2_((l.unit - l.unitDisc) * l.q), type: 'PHYSICAL', productImageUrl: l.v.img ? cat.base + l.v.img : undefined };
  });
  if (p.ship) products.push({ code: 'shipping', name: 'Shipping', quantity: 1, amount: a2_(p.ship), type: 'OTHER' });
  if (p.duty) products.push({ code: 'duty', name: 'Import duties (prepaid)', quantity: 1, amount: a2_(p.duty), type: 'TAX' });
  const list = {
    transactionId: tx, country: country, integration: 'HOSTED',
    customer: { number: cust.email, email: cust.email, name: name, addresses: { shipping: addr, billing: addr },
                phones: cust.phone ? { mobile: { unstructuredNumber: cust.phone } } : undefined },
    payment: { amount: p.total, currency: p.c.cur, reference: 'FAGA order ' + tx, invoiceId: tx },
    products: products,
    callback: { returnUrl: SHOP_RETURN_URL + '?tx=' + tx, cancelUrl: SHOP_URL, notificationUrl: SHOP_EXEC_URL },
    style: { language: 'en', hostedVersion: 'v6' },
    preselection: { direction: 'CHARGE' }
  };
  if (cfg.division) list.division = cfg.division;
  const res = pn_('post', '/lists', list);
  const listId = res.identification && res.identification.longId;
  let url = res.redirect && res.redirect.url;
  if (url && res.redirect.parameters && res.redirect.parameters.length)
    url += (url.indexOf('?') < 0 ? '?' : '&') + res.redirect.parameters.map(function (x) { return encodeURIComponent(x.name) + '=' + encodeURIComponent(x.value); }).join('&');
  if (!url && listId) url = 'https://resources.' + cfg.env + '.oscato.com/paymentpage/v6/responsive.html?listId=' + encodeURIComponent(listId) + '&lang=en';
  if (!url) return { error: 'server', message: 'Payment page unavailable (' + (res.resultInfo || res.resultCode || 'no redirect') + ').' };
  PropertiesService.getScriptProperties().setProperty('PEND_' + tx, JSON.stringify({
    tx: tx, listId: listId, country: country, code: p.code, total: p.total, cur: p.c.cur, customer: cust, created: Date.now(),
    items: p.lines.map(function (l) { return { d: l.d.id, v: l.v.pid, s: l.size, q: l.q, paid: a2_((l.unit - l.unitDisc) * l.q) }; }),
    ship: p.ship, duty: p.duty }));
  return { url: url, id: tx, total: p.total, currency: p.c.cur };
}

/** Payoneer status notification → verify the charge with Payoneer → fulfil. Always answers OK. */
function payoneerNotify_(e) {
  const prm = e.parameter || {};
  try {
    const tx = String(prm.transactionId || ''), longId = String(prm.longId || '');
    if (/^FAGA-[A-Z0-9]{8}$/.test(tx) && longId && String(prm.entity || 'payment') === 'payment') verifyAndFulfil_(tx, longId);
  } catch (err) { console.error(err); }
  return 'OK';
}
const PAID_ = ['charged', 'paid_out'];
/** Paid only if Payoneer's API says this charge is charged/paid out for this transaction and amount. */
function verifyAndFulfil_(tx, chargeId) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('DONE_' + tx)) return true;
  const pend = JSON.parse(props.getProperty('PEND_' + tx) || 'null'); if (!pend) return false;
  let ch = null;
  try { ch = pn_('get', '/charges/' + encodeURIComponent(chargeId)); } catch (err) { console.error(err); return false; }
  const st = ch.status && ch.status.code, idt = ch.identification || {};
  if (PAID_.indexOf(String(st)) < 0 || String(idt.transactionId || '') !== tx) return false;
  fulfil_(pend, chargeId);
  return true;
}
/** Thank-you page / returning shopper: has this order been paid? */
function shopStatus_(body) {
  const tx = String(body.tx || '');
  if (!/^FAGA-[A-Z0-9]{8}$/.test(tx)) return { error: 'bad_tx' };
  const props = PropertiesService.getScriptProperties();
  let paid = !!props.getProperty('DONE_' + tx);
  if (!paid && body.longId) { try { paid = verifyAndFulfil_(tx, String(body.longId)); } catch (err) { console.error(err); } }
  const pend = JSON.parse(props.getProperty('PEND_' + tx) || 'null');
  return { paid: paid, ref: tx, email: pend ? pend.customer.email : '', total: pend ? pend.total : null, currency: pend ? pend.cur : '' };
}
/** Every 10 minutes: forget abandoned checkouts after 3 days. Paid ones arrive by notification. */
function shopSweep_() {
  const props = PropertiesService.getScriptProperties(), all = props.getProperties(), cutoff = Date.now() - 3 * 86400000;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('PEND_') !== 0) return;
    try { const p = JSON.parse(all[k]); if (p.created < cutoff) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

// ---------- fulfilment ----------
function fulfil_(pend, chargeId) {
  const props = PropertiesService.getScriptProperties(), key = 'DONE_' + pend.tx;
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (props.getProperty(key)) return;
    props.setProperty(key, String(Date.now()));            // claim first: never two drafts for one payment
    const cat = catalog_(), c = pend.customer;
    const recipient = { name: c.name, email: c.email, phone: c.phone, address1: c.address1, address2: c.address2, city: c.city,
                        state_code: c.state, country_code: pend.country, zip: c.zip };
    const lines = [], pfItems = [];
    pend.items.forEach(function (it) {
      const d = cat.designs.filter(function (x) { return x.id === it.d; })[0];
      const v = d && d.variants.filter(function (x) { return x.pid === it.v; })[0];
      lines.push(it.q + ' × FAGA ' + (d ? d.name : it.d) + ' — ' + (v ? v.colour : it.v) + ' / ' + it.s + ' — ' + it.paid.toFixed(2) + ' ' + pend.cur);
      if (!v || !v.pf) return;
      pfItems.push({ variant_id: pfVariantId_(v, it.s), quantity: it.q, retail_price: (it.paid / it.q).toFixed(2),
        name: 'FAGA ' + d.name + ' · ' + v.colour + ' · ' + it.s,
        files: v.pf.files.map(function (f) { return { type: f.type, url: cat.base + f.url }; }), options: v.pf.options || [] });
    });
    if (pend.ship) lines.push('Shipping — ' + pend.ship.toFixed(2) + ' ' + pend.cur);
    if (pend.duty) lines.push('Import duties (prepaid) — ' + pend.duty.toFixed(2) + ' ' + pend.cur);
    let status;
    try {
      const o = pf_('post', '/orders', { external_id: pend.tx, shipping: 'STANDARD', recipient: recipient, items: pfItems });
      status = 'Printful draft ' + o.id + ' — confirm it in Printful';
    } catch (err) { status = 'NOT sent to Printful: ' + String(err.message || err).slice(0, 300); }
    const total = pend.total.toFixed(2) + ' ' + pend.cur;
    const addr = [c.address1, c.address2, c.city, c.state, c.zip, pend.country].filter(Boolean).join(', ');
    try {
      const ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID') || setup().sheetId);
      let sh = ss.getSheetByName('Shop orders');
      if (!sh) { sh = ss.insertSheet('Shop orders'); sh.appendRow(['Date', 'Ref', 'Payoneer charge', 'Name', 'Email', 'Phone', 'Address', 'Items', 'Total', 'Code', 'Fulfilment']); }
      sh.appendRow([new Date(), pend.tx, chargeId, c.name, c.email, c.phone, addr, lines.join('\n'), total, pend.code || '', status]);
    } catch (err) { console.error(err); }
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'FAGA shop order ' + pend.tx + ' — ' + total + ' — ' + c.name,
        'Paid order ' + pend.tx + ' (Payoneer charge ' + chargeId + ')\n\n' + lines.join('\n') + '\n\nTotal paid: ' + total + '\n\n' +
        c.name + '\n' + c.email + '\n' + c.phone + '\n' + addr + '\n\n' + status + '\nPrintful: https://www.printful.com/dashboard/default/orders');
    } catch (err) { console.error(err); }
    try {
      MailApp.sendEmail({ to: c.email, name: 'FAGA', replyTo: Session.getEffectiveUser().getEmail(), subject: 'Your FAGA order ' + pend.tx,
        body: 'Hi ' + c.name.split(' ')[0] + ',\n\nThanks for your order. It is now being printed and embroidered for you; you will get tracking by email when it ships.\n\n' +
              lines.join('\n') + '\n\nTotal paid: ' + total + '\nShipping to: ' + addr + '\n\nQuestions? Just reply to this email.\n\nFAGA — You can\'t hold it.' });
    } catch (err) { console.error(err); }
    props.deleteProperty('PEND_' + pend.tx);
    props.setProperty('PEND_' + pend.tx, JSON.stringify({ tx: pend.tx, customer: { email: c.email }, total: pend.total, cur: pend.cur, created: Date.now() }));
  } finally { lock.releaseLock(); }
}

// ---------- one-off helpers ----------
/** Run once from the editor after adding the Payoneer settings: authorises and schedules the cleanup sweep. */
function setupShop() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'shopSweep_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('shopSweep_').timeBased().everyMinutes(10).create();
  catalog_();
  const c = pnProps_();
  return 'Shop ready. Payoneer ' + (c.code && c.token ? 'configured (' + c.env + ')' : 'NOT configured — add PAYONEER_MERCHANT_CODE and PAYONEER_API_TOKEN') + '.';
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
    items.push({ variant_id: pfVariantId_(v, it.s), quantity: 1, files: v.pf.files.map(function (f) { return { type: f.type, url: cat.base + f.url }; }), options: v.pf.options || [] });
  });
  return pf_('post', '/orders/estimate-costs', { recipient: { address1: 'Hazait 74', city: 'Zerufa', country_code: 'IL', zip: '3085000' }, items: items });
}
