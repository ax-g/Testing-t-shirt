/* ============================================================
   Testing T-Shirt — Invoice module (shared by user + admin panels)

   • Needs window._fb with Firestore helpers, including runTransaction
   • Copy this ONE file into BOTH the user and admin folders
   • Business / GST details come from Firestore: publicConfig/invoice
     (edited in Admin → Settings → Invoice & GST)
   • Invoice data is saved on the order document as `order.invoice`
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- CONFIG (easy to change) ---------------- */
  const CONFIG_COLLECTION = 'publicConfig';
  const CONFIG_DOC = 'invoice';
  const LOGO_PATH = 'logo.png';                  // same file the site header uses
  const DEFAULT_STORE_NAME = 'Testing T-Shirt';
  const CURRENCY = '₹';
  const LIB_HTML2CANVAS = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  const LIB_JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  /* ============================================================
     PURE HELPERS (no DOM / Firebase — unit-testable in Node)
     ============================================================ */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // All money maths is done in integer paise to avoid floating-point drift.
  function toPaise(n) {
    const v = Number(n);
    return isFinite(v) ? Math.round(v * 100) : 0;
  }

  const _nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money(paise) { return CURRENCY + _nf.format((paise || 0) / 100); }

  function fmtRate(n) { return String(Number(Number(n).toFixed(2))); }

  // Indian financial year: 1 April → 31 March. Returns e.g. "2025-26".
  function financialYear(d) {
    const y = d.getFullYear(), m = d.getMonth();
    const start = m >= 3 ? y : y - 1;
    return start + '-' + String((start + 1) % 100).padStart(2, '0');
  }

  function sanitizePrefix(p) {
    return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'TTS';
  }

  // e.g. TTS/25-26/00001  (≤ 16 chars, only letters, digits, "/" and "-")
  function formatInvoiceNumber(prefix, fy, seq) {
    return sanitizePrefix(prefix) + '/' + fy.slice(2) + '/' + String(seq).padStart(5, '0');
  }

  // Format check only — this does NOT verify the GSTIN exists or is yours.
  function isValidGSTIN(s) {
    return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(String(s || '').trim().toUpperCase());
  }

  function normState(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  function toDateSafe(ts) {
    if (!ts) return null;
    if (typeof ts.toDate === 'function') return ts.toDate();
    if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000);
    if (ts instanceof Date) return ts;
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(d) {
    return d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  }

  /* ---- amount in words (Indian numbering) ---- */
  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function below100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
  function below1000(n) {
    const h = Math.floor(n / 100), r = n % 100;
    return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? below100(r) : '');
  }
  function words(n) {
    if (n === 0) return 'Zero';
    const parts = [];
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thou = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(words(crore) + ' Crore');
    if (lakh) parts.push(below100(lakh) + ' Lakh');
    if (thou) parts.push(below100(thou) + ' Thousand');
    if (n) parts.push(below1000(n));
    return parts.join(' ');
  }
  function amountInWords(paise) {
    paise = Math.max(0, Math.round(paise || 0));
    const r = Math.floor(paise / 100), p = paise % 100;
    return 'Indian Rupees ' + words(r) + (p ? ' and ' + words(p) + ' Paise' : '') + ' Only';
  }

  /* ---- business / GST configuration ---- */
  function normalizeConfig(raw) {
    raw = raw || {};
    const rateRaw = (raw.defaultGstRate === '' || raw.defaultGstRate === null || raw.defaultGstRate === undefined)
      ? NaN : Number(raw.defaultGstRate);
    const str = v => String(v || '').trim();
    return {
      sellerName: str(raw.sellerName) || DEFAULT_STORE_NAME,
      address: str(raw.address), city: str(raw.city), state: str(raw.state), pincode: str(raw.pincode),
      phone: str(raw.phone), email: str(raw.email),
      prefix: sanitizePrefix(raw.prefix),
      gstEnabled: !!raw.gstEnabled,
      gstin: str(raw.gstin).toUpperCase(),
      defaultGstRate: (isFinite(rateRaw) && rateRaw >= 0) ? rateRaw : null,
      defaultHsn: str(raw.defaultHsn),
      footerNote: str(raw.footerNote)
    };
  }

  // A GST ("Tax Invoice") is only produced when ALL required details are present
  // and valid. Otherwise a plain invoice with no tax lines is produced.
  function gstActive(cfg) {
    return !!(cfg.gstEnabled && isValidGSTIN(cfg.gstin) && cfg.state && cfg.address && cfg.defaultGstRate !== null);
  }

  function pickRate(productRate, defaultRate) {
    const n = (productRate === null || productRate === undefined || productRate === '') ? NaN : Number(productRate);
    return (isFinite(n) && n >= 0) ? n : defaultRate;
  }

  // Prices in this store are tax-INCLUSIVE (the customer pays exactly the listed price),
  // so GST is carved out of the amount: taxable = amount / (1 + rate).
  function makeLine(o) {
    let taxable = o.net, tax = 0;
    if (o.gst && o.rate > 0) {
      taxable = Math.round(o.net * 100 / (100 + o.rate));
      tax = o.net - taxable;
    }
    let cgst = 0, sgst = 0, igst = 0;
    if (tax > 0) {
      if (o.supply === 'intra') { cgst = Math.floor(tax / 2); sgst = tax - cgst; } else { igst = tax; }
    }
    return {
      name: String(o.name || 'Item'), size: String(o.size || ''), color: String(o.color || ''),
      qty: o.qty, unitPaise: o.unit, discountPaise: o.disc || 0,
      taxablePaise: taxable, ratePct: o.gst ? o.rate : 0, hsn: String(o.hsn || ''),
      cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, totalPaise: o.net,
      isDelivery: !!o.isDelivery
    };
  }

  // Builds the invoice snapshot saved on the order. Contains no `undefined` (Firestore rejects it).
  function buildInvoice(order, cfg, productTax, ids) {
    const gst = gstActive(cfg);
    const supply = gst ? (normState(cfg.state) && normState(cfg.state) === normState(order.state) ? 'intra' : 'inter') : null;
    productTax = productTax || {};

    const items = (order.products || []).map(p => {
      const qty = Math.max(1, Math.floor(Number(p.quantity) || 1));
      const unit = toPaise(p.price);
      return { p, qty, unit, gross: unit * qty, disc: 0, net: unit * qty };
    });
    const itemsGross = items.reduce((s, i) => s + i.gross, 0);
    const discount = Math.min(Math.max(toPaise(order.discount), 0), itemsGross);
    if (discount > 0 && itemsGross > 0) {            // spread any discount across lines proportionally
      let remaining = discount;
      items.forEach((it, idx) => {
        const share = idx === items.length - 1 ? remaining : Math.floor(discount * it.gross / itemsGross);
        it.disc = share; it.net = it.gross - share; remaining -= share;
      });
    }
    const delivery = Math.max(toPaise(order.deliveryCharge), 0);

    const lines = items.map(it => {
      const info = productTax[it.p.productId] || {};
      return makeLine({
        name: it.p.name, size: it.p.size, color: it.p.color, qty: it.qty, unit: it.unit, disc: it.disc, net: it.net,
        rate: gst ? pickRate(info.gstRate, cfg.defaultGstRate) : 0, hsn: info.hsn || cfg.defaultHsn, gst, supply
      });
    });
    if (delivery > 0) {
      lines.push(makeLine({
        name: 'Delivery charge', qty: 1, unit: delivery, disc: 0, net: delivery,
        rate: gst ? cfg.defaultGstRate : 0, hsn: '', gst, supply, isDelivery: true
      }));
    }

    const sum = k => lines.reduce((s, l) => s + l[k], 0);
    const goodsNet = items.reduce((s, i) => s + i.net, 0);
    return {
      number: ids.number, seq: ids.seq, fy: ids.fy,
      gst, supplyType: supply, placeOfSupply: String(order.state || ''),
      seller: {
        name: cfg.sellerName, address: cfg.address, city: cfg.city, state: cfg.state, pincode: cfg.pincode,
        phone: cfg.phone, email: cfg.email, gstin: gst ? cfg.gstin : ''
      },
      lines,
      itemsPaise: itemsGross, discountPaise: discount, deliveryPaise: delivery,
      taxablePaise: sum('taxablePaise'), cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'), igstPaise: sum('igstPaise'),
      taxPaise: sum('cgstPaise') + sum('sgstPaise') + sum('igstPaise'),
      totalPaise: goodsNet + delivery,
      pricesIncludeTax: true,
      footerNote: cfg.footerNote
    };
  }

  /* ============================================================
     INVOICE HTML (one template, used for screen, print and PDF)
     ============================================================ */
  function renderInvoiceHTML(order, opts) {
    opts = opts || {};
    const inv = order.invoice;
    const s = inv.seller || {};
    const gst = !!inv.gst;
    const intra = inv.supplyType === 'intra';
    const cancelled = String(order.orderStatus || '') === 'Cancelled';
    const hasDisc = (inv.discountPaise || 0) > 0;
    const paid = String(order.paymentStatus || '').toLowerCase() === 'paid';
    const orderDate = toDateSafe(order.createdAt);
    const invDate = toDateSafe(inv.date) || orderDate;

    const td = (label, html, cls) => `<td data-label="${esc(label)}"${cls ? ` class="${cls}"` : ''}>${html}</td>`;
    const taxCell = l => {
      if (!(l.ratePct > 0)) return '<span class="inv-taxv">GST 0%</span>';
      return '<span class="inv-taxv">' + (intra
        ? `<span>CGST ${fmtRate(l.ratePct / 2)}% · ${money(l.cgstPaise)}</span><span>SGST ${fmtRate(l.ratePct / 2)}% · ${money(l.sgstPaise)}</span>`
        : `<span>IGST ${fmtRate(l.ratePct)}% · ${money(l.igstPaise)}</span>`) + '</span>';
    };

    const head = ['#', 'Item'].concat(gst ? ['HSN'] : [], ['Qty', 'Unit price'], hasDisc ? ['Discount'] : [],
      gst ? ['Taxable value', 'GST'] : [], [gst ? 'Amount (incl. GST)' : 'Amount']);
    const rows = (inv.lines || []).map((l, i) => {
      const variant = [l.size ? 'Size: ' + l.size : '', l.color ? 'Color: ' + l.color : ''].filter(Boolean).join(' · ');
      return '<tr>' +
        td('#', String(i + 1), 'inv-td-idx') +
        td('Item', `<div class="inv-item-name">${esc(l.name)}</div>${variant ? `<div class="inv-item-sub">${esc(variant)}</div>` : ''}`, 'inv-td-item') +
        (gst ? td('HSN', esc(l.hsn) || '—') : '') +
        td('Qty', String(l.qty)) +
        td('Unit price', money(l.unitPaise)) +
        (hasDisc ? td('Discount', l.discountPaise ? '−' + money(l.discountPaise) : '—') : '') +
        (gst ? td('Taxable value', money(l.taxablePaise)) + td('GST', taxCell(l), 'inv-td-tax') : '') +
        td(gst ? 'Amount (incl. GST)' : 'Amount', `<strong>${money(l.totalPaise)}</strong>`, 'inv-td-amt') +
        '</tr>';
    }).join('');

    const sellerLines = [
      s.address,
      [s.city, [s.state, s.pincode].filter(Boolean).join(' - ')].filter(Boolean).join(', '),
      s.phone ? 'Phone: ' + s.phone : '',
      s.email ? 'Email: ' + s.email : '',
      gst && s.gstin ? 'GSTIN: ' + s.gstin : ''
    ].filter(Boolean).map(esc).join('<br>');

    const buyerLines = [
      order.address,
      [order.city, [order.state, order.pincode].filter(Boolean).join(' - ')].filter(Boolean).join(', '),
      order.customerPhone ? 'Phone: ' + order.customerPhone : '',
      order.customerEmail ? 'Email: ' + order.customerEmail : ''
    ].filter(Boolean).map(esc).join('<br>');

    const tot = [];
    tot.push(['Subtotal', money(inv.itemsPaise)]);
    if (hasDisc) tot.push(['Discount', '−' + money(inv.discountPaise)]);
    tot.push(['Delivery charge', money(inv.deliveryPaise)]);
    if (gst) {
      tot.push(['Taxable value', money(inv.taxablePaise)]);
      if (intra) { tot.push(['CGST', money(inv.cgstPaise)]); tot.push(['SGST', money(inv.sgstPaise)]); }
      else { tot.push(['IGST', money(inv.igstPaise)]); }
    }
    const totHtml = tot.map(r => `<div class="inv-trow"><span>${esc(r[0])}</span><span>${r[1]}</span></div>`).join('');

    const meta = [
      ['Invoice no.', inv.number], ['Invoice date', fmtDate(invDate)],
      ['Order ID', order.orderId || order.id], ['Order date', fmtDate(orderDate)],
      ['Payment method', order.paymentMethod || '—'], ['Payment status', order.paymentStatus || '—']
    ];
    if (gst) meta.push(['Place of supply', inv.placeOfSupply || '—']);
    const metaHtml = meta.map(m => `<div><div class="k">${esc(m[0])}</div><div class="v">${esc(m[1])}</div></div>`).join('');

    const footer = [];
    if (gst || inv.pricesIncludeTax) footer.push(gst ? 'All prices are inclusive of GST.' : '');
    const custom = inv.footerNote ? esc(inv.footerNote).replace(/\n/g, '<br>') : '';

    return `<div class="inv${opts.a4 ? ' inv-a4' : ''}">
  <div class="inv-head">
    <div class="inv-brand">
      <img class="inv-logo" src="${esc(LOGO_PATH)}" alt="${esc(s.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='block';">
      <div class="inv-brand-fallback" style="display:none;">${esc(s.name)}</div>
    </div>
    <div class="inv-title-block">
      <div class="inv-title">${gst ? 'TAX INVOICE' : 'INVOICE'}</div>
      <div><span class="inv-num">${esc(inv.number)}</span>${cancelled ? '<span class="inv-chip cancelled">Order cancelled</span>' : ''}</div>
    </div>
  </div>
  <div class="inv-meta">${metaHtml}</div>
  <div class="inv-parties">
    <div class="inv-box"><h4>Sold by</h4><div class="nm">${esc(s.name)}</div><div class="ad">${sellerLines || '—'}</div></div>
    <div class="inv-box"><h4>Bill to / Ship to</h4><div class="nm">${esc(order.customerName || 'Customer')}</div><div class="ad">${buyerLines || '—'}</div></div>
  </div>
  <table class="inv-table">
    <thead><tr>${head.map((h, i) => `<th${i === 0 ? ' class="inv-td-idx"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="inv-totals">
    ${totHtml}
    <div class="inv-grand"><span>Total</span><span>${money(inv.totalPaise)}</span></div>
    ${!paid && !cancelled ? `<div class="inv-due"><span>Amount due</span><span>${money(inv.totalPaise)}</span></div>` : ''}
  </div>
  <div class="inv-words"><span class="k">Amount in words</span> ${esc(amountInWords(inv.totalPaise))}</div>
  <div class="inv-foot">
    ${footer.filter(Boolean).map(f => `<div>${esc(f)}</div>`).join('')}
    ${custom ? `<div>${custom}</div>` : ''}
    <div>Thank you for shopping with ${esc(s.name)}.</div>
    <div class="inv-muted">This is a computer-generated invoice.</div>
  </div>
</div>`;
  }

  /* ============================================================
     FIRESTORE: config, numbering, saving   (browser only)
     ============================================================ */
  function fb() {
    const w = (typeof window !== 'undefined') ? window : global;
    if (!w._fb) throw new Error('Firebase is not ready yet');
    return w._fb;
  }

  let _cfgCache = null;
  async function loadConfig(force) {
    if (_cfgCache && !force) return _cfgCache;
    const { db, doc, getDoc } = fb();
    let raw = {};
    try {
      const snap = await getDoc(doc(db, CONFIG_COLLECTION, CONFIG_DOC));
      if (snap.exists()) raw = snap.data();
    } catch (e) { console.warn('Invoice config not readable, using defaults:', e); }
    _cfgCache = normalizeConfig(raw);
    return _cfgCache;
  }

  async function loadProductTax(order, cfg) {
    const out = {};
    if (!gstActive(cfg)) return out;                       // only needed for GST invoices
    const { db, doc, getDoc } = fb();
    const ids = [...new Set((order.products || []).map(p => p.productId).filter(Boolean))];
    await Promise.all(ids.map(async id => {
      try {
        const s = await getDoc(doc(db, 'products', id));
        if (s.exists()) out[id] = { gstRate: s.data().gstRate, hsn: s.data().hsn };
      } catch (e) { /* product deleted/unreadable → store default rate is used */ }
    }));
    return out;
  }

  const _inflight = new Map();
  // Returns the order (with order.invoice). Creates the invoice only if it doesn't exist yet.
  // Safe to call repeatedly / concurrently / after a refresh: numbers are never duplicated.
  function ensure(orderId, opts) {
    opts = opts || {};
    const key = orderId + (opts.refresh ? ':refresh' : '');
    if (_inflight.has(key)) return _inflight.get(key);
    const p = _ensure(orderId, opts).finally(() => _inflight.delete(key));
    _inflight.set(key, p);
    return p;
  }

  async function _ensure(orderId, opts) {
    const { db, doc, getDoc, runTransaction, serverTimestamp } = fb();
    const orderRef = doc(db, 'orders', orderId);

    const first = await getDoc(orderRef);
    if (!first.exists()) throw new Error('Order not found');
    const order0 = { id: first.id, ...first.data() };
    if (order0.invoice && order0.invoice.number && !opts.refresh) return order0;   // already has one
    if (!order0.invoice && String(order0.paymentStatus) === 'Awaiting Payment') throw new Error('NOT_PAID');
    if (!order0.invoice && String(order0.orderStatus) === 'Cancelled' && !opts.admin) {
      throw new Error('NO_INVOICE_CANCELLED');
    }

    const cfg = await loadConfig(!!opts.refresh);
    const productTax = await loadProductTax(order0, cfg);
    const fy = financialYear(new Date());
    const counterRef = doc(db, 'counters', 'invoice-' + fy);

    await runTransaction(db, async tx => {
      const oSnap = await tx.get(orderRef);
      if (!oSnap.exists()) throw new Error('Order not found');
      const cur = oSnap.data();

      if (cur.invoice && cur.invoice.number) {
        if (!opts.refresh) return;                         // created meanwhile by another request → reuse it
        // Admin refresh: keep number / sequence / date, re-snapshot business + tax details
        const kept = { number: cur.invoice.number, seq: cur.invoice.seq, fy: cur.invoice.fy };
        const refreshed = buildInvoice({ ...cur, id: orderId }, cfg, productTax, kept);
        refreshed.date = cur.invoice.date;
        tx.update(orderRef, { invoice: refreshed });
        return;
      }

      const cSnap = await tx.get(counterRef);              // all reads happen before any write
      const next = cSnap.exists() ? (Number(cSnap.data().last) || 0) + 1 : 1;
      if (cSnap.exists()) tx.update(counterRef, { last: next }); else tx.set(counterRef, { last: next });

      const invoice = buildInvoice({ ...cur, id: orderId }, cfg, productTax,
        { number: formatInvoiceNumber(cfg.prefix, fy, next), seq: next, fy });
      invoice.date = serverTimestamp();
      tx.update(orderRef, { invoice });
    });

    const final = await getDoc(orderRef);                  // re-read so server timestamps are resolved
    return { id: final.id, ...final.data() };
  }

  /* ============================================================
     UI: styles, viewer, busy overlay, toast   (browser only)
     ============================================================ */
  const CSS = `
.inv{--ink:#111;--muted:#737373;--line:#e8e8e8;--soft:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);font-size:13px;line-height:1.5;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.inv,.inv *{box-sizing:border-box}
.inv-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:18px;border-bottom:2px solid var(--ink)}
.inv-logo{height:46px;max-width:190px;object-fit:contain;display:block}
.inv-brand-fallback{font-weight:800;font-size:18px;letter-spacing:-.4px}
.inv-title-block{text-align:right}
.inv-title{font-size:20px;font-weight:800;letter-spacing:1px}
.inv-num{display:inline-block;margin-top:6px;background:var(--soft);border-radius:8px;padding:4px 10px;font-weight:700;font-size:12.5px}
.inv-chip{display:inline-block;margin:6px 0 0 6px;border-radius:20px;padding:3px 10px;font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase}
.inv-chip.cancelled{background:#fee2e2;color:#991b1b}
.inv-meta{display:grid;grid-template-columns:repeat(4,1fr);gap:12px 16px;padding:16px 0;border-bottom:1px solid var(--line)}
.inv-meta .k,.inv-words .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);font-weight:700}
.inv-meta .v{font-weight:600;word-break:break-word}
.inv-parties{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 0}
.inv-box{background:var(--soft);border-radius:14px;padding:14px 16px}
.inv-box h4{margin:0 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}
.inv-box .nm{font-weight:700;font-size:14px;margin-bottom:2px}
.inv-box .ad{color:#404040;word-break:break-word}
.inv-table{width:100%;border-collapse:collapse}
.inv-table th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--muted);padding:8px 8px;border-bottom:1.5px solid var(--ink);white-space:nowrap}
.inv-table td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.inv-table th:nth-child(n+3),.inv-table td:nth-child(n+3){text-align:right}
.inv-table th.inv-td-idx,.inv-table td.inv-td-idx{width:28px;text-align:left;color:var(--muted)}
.inv-table th:nth-child(2),.inv-table td.inv-td-item{text-align:left}
.inv-td-tax{white-space:nowrap}
.inv-taxv{display:block;text-align:right}
.inv-taxv>span{display:block}
.inv-table tr,.inv-totals,.inv-words,.inv-foot,.inv-parties,.inv-head,.inv-meta{break-inside:avoid;page-break-inside:avoid}
.inv-item-name{font-weight:700}
.inv-item-sub{color:var(--muted);font-size:11.5px}
.inv-totals{margin:16px 0 0 auto;width:100%;max-width:340px}
.inv-trow{display:flex;justify-content:space-between;gap:12px;padding:5px 2px;color:#404040}
.inv-grand{display:flex;justify-content:space-between;gap:12px;margin-top:8px;background:#111;color:#fff;border-radius:12px;padding:12px 16px;font-weight:800;font-size:15px}
.inv-due{display:flex;justify-content:space-between;gap:12px;margin-top:8px;padding:8px 14px;border:1.5px dashed #d4d4d4;border-radius:12px;font-weight:700}
.inv-words{margin-top:16px;padding:12px 14px;background:var(--soft);border-radius:12px;font-weight:600}
.inv-words .k{display:block;margin-bottom:2px}
.inv-foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);color:#404040;font-size:12px;text-align:center}
.inv-foot>div{margin-top:3px}
.inv-muted{color:var(--muted)}
.inv-a4{width:794px;min-height:1120px;padding:24px 36px;font-size:12px;line-height:1.45}
.inv-a4 .inv-head{padding-bottom:12px}
.inv-a4 .inv-logo{height:42px}
.inv-a4 .inv-meta{padding:12px 0;gap:10px 16px}
.inv-a4 .inv-parties{padding:12px 0;gap:14px}
.inv-a4 .inv-box{padding:12px 14px}
.inv-a4 .inv-table td{padding:6px 8px}
.inv-a4 .inv-totals{margin-top:12px}
.inv-a4 .inv-words{margin-top:12px;padding:10px 14px}
.inv-a4 .inv-foot{margin-top:12px;padding-top:10px}
@media (max-width:640px){
  .inv:not(.inv-a4) .inv-head{flex-direction:column}
  .inv:not(.inv-a4) .inv-title-block{text-align:left}
  .inv:not(.inv-a4) .inv-meta{grid-template-columns:1fr 1fr}
  .inv:not(.inv-a4) .inv-parties{grid-template-columns:1fr}
  .inv:not(.inv-a4) .inv-table thead{display:none}
  .inv:not(.inv-a4) .inv-table,.inv:not(.inv-a4) .inv-table tbody,.inv:not(.inv-a4) .inv-table tr,.inv:not(.inv-a4) .inv-table td{display:block;width:100%}
  .inv:not(.inv-a4) .inv-table tr{border:1px solid var(--line);border-radius:12px;padding:8px 12px;margin-bottom:10px}
  .inv:not(.inv-a4) .inv-table td{display:flex;justify-content:space-between;gap:14px;border:0;padding:3px 0;text-align:right !important}
  .inv:not(.inv-a4) .inv-table td::before{content:attr(data-label);color:var(--muted);font-weight:600;text-align:left;flex-shrink:0}
  .inv:not(.inv-a4) .inv-table td.inv-td-item{display:block;text-align:left !important;padding-bottom:6px}
  .inv:not(.inv-a4) .inv-table td.inv-td-item::before,.inv:not(.inv-a4) .inv-table td.inv-td-idx{display:none}
  .inv:not(.inv-a4) .inv-totals{max-width:none}
}
#invViewer{position:fixed;inset:0;z-index:700;background:#f2f2f2;display:none;flex-direction:column}
#invViewer.open{display:flex}
.inv-bar{background:#fff;border-bottom:1px solid #e8e8e8;padding:10px 14px;padding-top:calc(10px + env(safe-area-inset-top,0px))}
.inv-bar-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.inv-bar-title{font:800 15px -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;color:#111}
.inv-x{width:36px;height:36px;border-radius:50%;border:0;background:#f5f5f5;font-size:18px;cursor:pointer;color:#111}
.inv-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.inv-btn{flex:1;min-width:104px;padding:11px 12px;border-radius:12px;font:700 13px -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;border:1.5px solid #d4d4d4;background:#fff;color:#111;cursor:pointer}
.inv-btn.primary{background:#111;color:#fff;border-color:#111}
.inv-btn:disabled{opacity:.5;cursor:not-allowed}
.inv-scroll{flex:1;overflow:auto;padding:14px 10px calc(40px + env(safe-area-inset-bottom,0px));-webkit-overflow-scrolling:touch}
.inv-paper{max-width:860px;margin:0 auto;background:#fff;border-radius:16px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.inv-loading{padding:60px 0;text-align:center;color:#737373;font:600 14px -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif}
@media (max-width:640px){.inv-paper{padding:16px;border-radius:14px}}
#invBusy{position:fixed;inset:0;z-index:800;background:rgba(255,255,255,.8);display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;font:700 14px -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;color:#111}
#invBusy.open{display:flex}
.inv-spin{width:26px;height:26px;border:3px solid #ddd;border-top-color:#111;border-radius:50%;animation:invspin .7s linear infinite}
@keyframes invspin{to{transform:rotate(360deg)}}
#invToast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%) translateY(30px);opacity:0;pointer-events:none;z-index:900;background:#111;color:#fff;padding:12px 20px;border-radius:12px;font:600 13px -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;max-width:90%;text-align:center;transition:transform .25s ease,opacity .25s ease}
#invToast.show{transform:translateX(-50%) translateY(0);opacity:1}
#invToast.error{background:#dc2626}#invToast.success{background:#16a34a}
#invPrintRoot{display:none}
@page{size:A4;margin:10mm}
@media print{
  body.inv-printing>*:not(#invPrintRoot){display:none !important}
  body.inv-printing #invPrintRoot{display:block !important}
  #invPrintRoot .inv-a4{width:100%;min-height:0;padding:0}
}`;

  let _styled = false;
  function injectStyles() {
    if (_styled || typeof document === 'undefined') return;
    const st = document.createElement('style');
    st.id = 'invoice-css';
    st.textContent = CSS;
    document.head.appendChild(st);
    _styled = true;
  }

  let _toastTimer = null;
  function toast(msg, type) {
    injectStyles();
    let t = document.getElementById('invToast');
    if (!t) { t = document.createElement('div'); t.id = 'invToast'; document.body.appendChild(t); }
    clearTimeout(_toastTimer);
    t.className = '';
    void t.offsetWidth;
    t.textContent = msg;
    t.className = 'show' + (type ? ' ' + type : '');
    _toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
  }

  function busy(on, msg) {
    injectStyles();
    let b = document.getElementById('invBusy');
    if (!b) {
      b = document.createElement('div'); b.id = 'invBusy';
      b.innerHTML = '<div class="inv-spin"></div><div id="invBusyMsg"></div>';
      document.body.appendChild(b);
    }
    if (on) document.getElementById('invBusyMsg').textContent = msg || 'Please wait…';
    b.classList.toggle('open', !!on);
  }

  /* ---- viewer ---- */
  const state = { order: null, orderId: null, admin: false };
  let viewer = null;

  function ensureViewer() {
    injectStyles();
    if (viewer) return viewer;
    viewer = document.createElement('div');
    viewer.id = 'invViewer';
    viewer.innerHTML = `
      <div class="inv-bar">
        <div class="inv-bar-top"><div class="inv-bar-title" id="invBarTitle">Invoice</div>
          <button class="inv-x" id="invClose" aria-label="Close">✕</button></div>
        <div class="inv-actions">
          <button class="inv-btn primary" id="invDl">Download PDF</button>
          <button class="inv-btn" id="invPr">Print Invoice</button>
          <button class="inv-btn" id="invRefresh" style="display:none;">Refresh business details</button>
        </div>
      </div>
      <div class="inv-scroll"><div class="inv-paper" id="invPaper"></div></div>`;
    document.body.appendChild(viewer);
    viewer.querySelector('#invClose').onclick = closeViewer;
    viewer.querySelector('#invDl').onclick = async () => {
      if (!state.order) return;
      const b = viewer.querySelector('#invDl'); const old = b.textContent;
      b.disabled = true; b.textContent = 'Preparing PDF…';
      try { await downloadPdf(state.order); } finally { b.disabled = false; b.textContent = old; }
    };
    viewer.querySelector('#invPr').onclick = () => { if (state.order) printInvoice(state.order); };
    viewer.querySelector('#invRefresh').onclick = async () => {
      if (!confirm('Re-read your business / GST settings and update this invoice? The invoice number and date stay the same.')) return;
      busy(true, 'Updating invoice…');
      try {
        const order = await ensure(state.orderId, { refresh: true, admin: true });
        renderViewer(order);
        toast('Invoice details updated', 'success');
      } catch (e) { console.error(e); toast(friendlyError(e), 'error'); }
      finally { busy(false); }
    };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && viewer.classList.contains('open')) closeViewer(); });
    return viewer;
  }

  function showViewerLoading() {
    ensureViewer();
    viewer.querySelector('#invPaper').innerHTML = '<div class="inv-loading">Preparing your invoice…</div>';
    viewer.querySelector('#invBarTitle').textContent = 'Invoice';
    viewer.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeViewer() {
    if (!viewer) return;
    viewer.classList.remove('open');
    document.body.style.overflow = '';
  }
  function renderViewer(order) {
    state.order = order;
    viewer.querySelector('#invBarTitle').textContent = 'Invoice ' + order.invoice.number;
    viewer.querySelector('#invPaper').innerHTML = renderInvoiceHTML(order, { a4: false });
    viewer.querySelector('#invRefresh').style.display = state.admin ? '' : 'none';
    viewer.querySelector('.inv-scroll').scrollTop = 0;
  }

  /* ---- print ---- */
  function printInvoice(order) {
    injectStyles();
    let root = document.getElementById('invPrintRoot');
    if (!root) { root = document.createElement('div'); root.id = 'invPrintRoot'; document.body.appendChild(root); }
    root.innerHTML = renderInvoiceHTML(order, { a4: true });
    document.body.classList.add('inv-printing');
    const done = () => { document.body.classList.remove('inv-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    // Short delay so the browser lays out the print copy (and logo) before the dialog opens
    setTimeout(() => window.print(), 150);
  }


  // Decides where each PDF page starts/ends (all values in canvas pixels).
  // Pages only break BEFORE an element listed in `breaks`, so a row is never cut in half.
  // Pages after the first get a small top margin; every page that must break keeps a small bottom margin.
  function planPages(totalH, width, breaks) {
    const pxPerMm = width / 210;
    const pages = [];
    let y = 0;
    while (y < totalH - 4) {
      const topMm = pages.length === 0 ? 0 : 12;
      const usable = Math.floor((297 - topMm) * pxPerMm);
      let end;
      if (y + usable >= totalH - 4) {
        end = totalH;                                        // the rest fits on this page
      } else {
        end = y + usable - Math.floor(8 * pxPerMm);           // leave a bottom margin when breaking
        let best = -1;
        for (const b of breaks) if (b > y + 40 && b <= end && b > best) best = b;
        if (best > 0) end = best;                            // otherwise (a single huge block) cut at the limit
      }
      pages.push({ y, h: end - y, topMm });
      y = end;
    }
    return pages;
  }

  /* ---- PDF ---- */
  const _libs = {};
  function loadScript(src, readyFn) {
    if (readyFn && readyFn()) return Promise.resolve();
    if (_libs[src]) return _libs[src];
    _libs[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { delete _libs[src]; reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
    return _libs[src];
  }

  function waitForImages(root) {
    const imgs = Array.from(root.querySelectorAll('img'));
    const all = Promise.all(imgs.map(img => (img.complete && img.naturalWidth !== 0) || img.style.display === 'none'
      ? Promise.resolve()
      : new Promise(res => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); })));
    return Promise.race([all, new Promise(res => setTimeout(res, 4000))]);
  }

  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(isIOS() ? "PDF ready. If it didn't download, tap Print Invoice → Share → Save to Files." : 'Invoice PDF downloaded', 'success');
  }

  async function downloadPdf(order) {
    injectStyles();
    try {
      await Promise.all([
        loadScript(LIB_HTML2CANVAS, () => global.html2canvas),
        loadScript(LIB_JSPDF, () => global.jspdf && global.jspdf.jsPDF)
      ]);
    } catch (e) {
      console.error(e);
      toast('PDF tools could not load. Opening print instead — choose "Save as PDF".', 'error');
      return printInvoice(order);
    }

    // Render a fixed-width A4 copy off-screen so the PDF looks the same on every phone and screen size
    const host = document.createElement('div');
    host.id = 'invPdfHost';
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;';
    host.innerHTML = renderInvoiceHTML(order, { a4: true });
    document.body.appendChild(host);

    try {
      await waitForImages(host);
      const canvas = await global.html2canvas(host, {
        scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false,
        windowWidth: 794, scrollX: 0, scrollY: 0,
        onclone: doc => { const h = doc.getElementById('invPdfHost'); if (h) { h.style.left = '0'; h.style.position = 'absolute'; } }
      });

      const pdf = new global.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
      const pageW = 210;
      const k = canvas.width / host.offsetWidth;            // canvas pixels per CSS pixel
      const hostTop = host.getBoundingClientRect().top;
      const breaks = Array.from(host.querySelectorAll('.inv-parties,.inv-table tbody tr,.inv-totals,.inv-words,.inv-foot'))
        .map(el => Math.round((el.getBoundingClientRect().top - hostTop) * k));
      planPages(canvas.height, canvas.width, breaks).forEach((pg, i) => {
        const slice = document.createElement('canvas');
        slice.width = canvas.width; slice.height = pg.h;
        const ctx = slice.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, pg.y, canvas.width, pg.h, 0, 0, canvas.width, pg.h);
        if (i > 0) pdf.addPage();
        pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, pg.topMm, pageW, pg.h * pageW / canvas.width);
      });
      saveBlob(pdf.output('blob'), 'Invoice-' + order.invoice.number.replace(/[^A-Za-z0-9-]/g, '-') + '.pdf');
    } catch (e) {
      console.error('PDF generation failed:', e);
      toast('Could not create the PDF. Opening print instead — choose "Save as PDF".', 'error');
      printInvoice(order);
    } finally {
      host.remove();
    }
  }

  /* ---- public entry point ---- */
  function friendlyError(e) {
    const msg = String((e && (e.code || e.message)) || e);
    if (msg.includes('NOT_PAID')) return 'Your invoice will be available once your payment is confirmed.';
    if (msg.includes('NO_INVOICE_CANCELLED')) return 'No invoice was issued for this cancelled order.';
    if (msg.includes('permission-denied') || msg.includes('insufficient permissions')) return "You don't have permission to access this invoice.";
    if (msg.includes('Order not found')) return 'Order not found.';
    return 'Could not prepare the invoice. Please check your connection and try again.';
  }

  // mode: 'view' (default) | 'download' | 'print'.  opts.admin enables admin-only extras.
  async function open(orderId, opts) {
    opts = opts || {};
    const mode = opts.mode || 'view';
    state.admin = !!opts.admin;
    state.orderId = orderId;
    try {
      if (mode === 'view') showViewerLoading(); else busy(true, mode === 'download' ? 'Preparing PDF…' : 'Preparing invoice…');
      const order = await ensure(orderId, { admin: !!opts.admin });
      if (mode === 'view') { renderViewer(order); }
      else if (mode === 'download') { busy(false); await downloadPdf(order); }
      else if (mode === 'print') { busy(false); printInvoice(order); }
    } catch (e) {
      console.error('Invoice error:', e);
      if (mode === 'view') closeViewer();
      toast(friendlyError(e), 'error');
    } finally {
      busy(false);
    }
  }

  const Invoice = {
    open, ensure, loadConfig,
    clearConfigCache() { _cfgCache = null; },
    // exposed for unit tests / admin settings validation
    _t: {
      esc, toPaise, money, financialYear, formatInvoiceNumber, sanitizePrefix, isValidGSTIN, normalizeConfig, gstActive,
      buildInvoice, renderInvoiceHTML, amountInWords, makeLine, pickRate, normState, planPages
    },
    isValidGSTIN, sanitizePrefix
  };

  global.Invoice = Invoice;
  if (typeof module !== 'undefined' && module.exports) module.exports = Invoice;
})(typeof window !== 'undefined' ? window : globalThis);