/* ============================================================
   Testing T-Shirt — UPI payment module (customer panel)

   • Needs window._fb (Firestore helpers incl. runTransaction, onSnapshot, deleteDoc)
   • Put this ONE file next to user.html (index.html) in the user folder
   • Settings come from Firestore publicConfig/payments (Admin → Settings → UPI Payments)
   • The order is marked "Paid" ONLY by the Google script (or by you in the admin panel).
     This page just watches the order and shows the result — it can never mark it paid.
   ============================================================ */
(function (global) {
  'use strict';

  const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  const MAX_OFFSET_TRIES = 15;
  // After a payment slot expires, nobody else may reuse the SAME amount for this long.
  // (Keeps a late payer from being matched to a different customer.)  Script grace must be shorter.
  const REUSE_BUFFER_MIN = 15;

  /* ============================================================
     PURE HELPERS (unit-testable)
     ============================================================ */
  const _nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rupees = p => '₹' + _nf.format((p || 0) / 100);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function msOf(ts) {
    if (!ts) return 0;
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    if (ts instanceof Date) return ts.getTime();
    return Number(ts) || 0;
  }

  function isValidUpiId(s) { return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.]{1,63}$/.test(String(s || '').trim()); }

  function normalizeConfig(raw) {
    raw = raw || {};
    const w = Number(raw.windowMinutes);
    const upiId = String(raw.upiId || '').trim();
    return {
      upiEnabled: !!raw.upiEnabled && isValidUpiId(upiId),
      upiId,
      payeeName: String(raw.payeeName || '').trim() || 'Testing T-Shirt',
      windowMinutes: (w >= 5 && w <= 60) ? Math.floor(w) : 15
    };
  }

  // NPCI-style UPI deep link. Amount is always written with exactly two decimals.
  function buildUpiLink(o) {
    const enc = encodeURIComponent;
    return 'upi://pay?pa=' + enc(o.vpa).replace(/%40/g, '@') +
      '&pn=' + enc(o.name) +
      '&am=' + (o.amountPaise / 100).toFixed(2) +
      '&cu=INR' +
      '&tn=' + enc(o.note || '') +
      '&tr=' + enc(o.ref || '');
  }

  // Random order of the reduction amounts 10..99 paise
  function offsetsShuffled() {
    const a = [];
    for (let i = 10; i <= 99; i++) a.push(i);
    const rnd = n => {
      if (global.crypto && global.crypto.getRandomValues) { const u = new Uint32Array(1); global.crypto.getRandomValues(u); return u[0] % n; }
      return Math.floor(Math.random() * n);
    };
    for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function slotIsFree(lockData, nowMs) {
    if (!lockData) return true;
    return msOf(lockData.expiresAt) + REUSE_BUFFER_MIN * 60000 < nowMs;
  }

  /* ============================================================
     FIRESTORE
     ============================================================ */
  function fb() {
    const w = (typeof window !== 'undefined') ? window : global;
    if (!w._fb) throw new Error('Firebase is not ready yet');
    return w._fb;
  }

  let _cfg = null;
  async function loadConfig(force) {
    if (_cfg && !force) return _cfg;
    const { db, doc, getDoc } = fb();
    let raw = {};
    try { const s = await getDoc(doc(db, 'publicConfig', 'payments')); if (s.exists()) raw = s.data(); }
    catch (e) { console.warn('UPI config not readable:', e); }
    _cfg = normalizeConfig(raw);
    return _cfg;
  }

  // Creates the order AND reserves a unique payable amount in ONE transaction.
  // The customer pays (price − 10…99 paise): never more than the listed price, and the
  // order total, the invoice and the money received all stay identical.
  async function createUpiOrder(args) {
    const { orderId, uid, orderData, basePaise } = args;
    const cfg = args.cfg || await loadConfig();
    if (!cfg.upiEnabled) throw new Error('UPI_DISABLED');
    if (!(basePaise >= 200)) throw new Error('AMOUNT_TOO_SMALL');
    const { db, doc, runTransaction, serverTimestamp } = fb();
    const expiresAt = new Date(Date.now() + cfg.windowMinutes * 60000);
    const orderRef = doc(db, 'orders', orderId);
    const offsets = offsetsShuffled().slice(0, MAX_OFFSET_TRIES);
    let chosen = null;

    await runTransaction(db, async tx => {
      chosen = null;
      for (const off of offsets) {
        const payable = basePaise - off;
        if (payable < 100) continue;
        const lockRef = doc(db, 'upiLocks', String(payable));
        const s = await tx.get(lockRef);                      // every read happens before any write
        if (slotIsFree(s.exists() ? s.data() : null, Date.now())) { chosen = { off, payable, lockRef }; break; }
      }
      if (!chosen) throw new Error('NO_FREE_SLOT');
      tx.set(chosen.lockRef, { uid, orderId, payablePaise: chosen.payable, expiresAt, createdAt: serverTimestamp() });
      tx.set(orderRef, Object.assign({}, orderData, {
        orderId, uid,
        paymentMethod: 'UPI', paymentStatus: 'Awaiting Payment', orderStatus: 'Pending',
        subtotal: basePaise / 100, discount: chosen.off / 100, finalTotal: chosen.payable / 100,
        upi: { payablePaise: chosen.payable, basePaise, adjustmentPaise: chosen.off, lockId: String(chosen.payable), expiresAt },
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      }));
    });
    return { orderId, payablePaise: chosen.payable, adjustmentPaise: chosen.off };
  }

  // "Get more time": renews the customer's own slot (or re-takes it if nobody else has).
  async function renewLock(orderId) {
    const cfg = await loadConfig();
    const { db, doc, getDoc, runTransaction, serverTimestamp } = fb();
    const os = await getDoc(doc(db, 'orders', orderId));
    if (!os.exists()) throw new Error('NOT_AWAITING');
    const o = os.data();
    if (o.paymentStatus !== 'Awaiting Payment' || o.orderStatus === 'Cancelled' || !o.upi) throw new Error('NOT_AWAITING');
    const payable = o.upi.payablePaise;
    const lockRef = doc(db, 'upiLocks', String(payable));
    const expiresAt = new Date(Date.now() + cfg.windowMinutes * 60000);
    await runTransaction(db, async tx => {
      const s = await tx.get(lockRef);
      if (s.exists()) {
        const d = s.data();
        const mine = d.uid === o.uid && d.orderId === orderId;
        if (!mine && !slotIsFree(d, Date.now())) throw new Error('SLOT_TAKEN');
      }
      tx.set(lockRef, { uid: o.uid, orderId, payablePaise: payable, expiresAt, createdAt: serverTimestamp() });
    });
    return expiresAt;
  }

  async function cancelUpiOrder(orderId) {
    const { db, doc, getDoc, updateDoc, deleteDoc, serverTimestamp } = fb();
    const os = await getDoc(doc(db, 'orders', orderId));
    const lockId = os.exists() && os.data().upi && os.data().upi.lockId;
    await updateDoc(doc(db, 'orders', orderId), { orderStatus: 'Cancelled', updatedAt: serverTimestamp() });
    if (lockId) { try { await deleteDoc(doc(db, 'upiLocks', lockId)); } catch (e) { /* it simply expires */ } }
  }

  /* ============================================================
     PAYMENT SHEET (browser only)
     ============================================================ */
  const CSS = `
#upiSheet{position:fixed;inset:0;z-index:550;background:rgba(0,0,0,.55);display:none;align-items:flex-end;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111}
#upiSheet.open{display:flex}
#upiSheet *{box-sizing:border-box}
.upi-card{background:#fff;width:100%;max-width:440px;border-radius:24px 24px 0 0;max-height:95vh;overflow:auto;padding:8px 20px calc(22px + env(safe-area-inset-bottom,0px));-webkit-overflow-scrolling:touch}
@media (min-width:640px){#upiSheet{align-items:center}.upi-card{border-radius:24px}}
.upi-handle{width:36px;height:4px;background:#d4d4d4;border-radius:2px;margin:8px auto 12px}
.upi-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.upi-title{font-weight:800;font-size:18px}
.upi-x{width:34px;height:34px;border-radius:50%;border:0;background:#f5f5f5;font-size:17px;cursor:pointer;color:#111}
.upi-amount{text-align:center;font-size:36px;font-weight:800;letter-spacing:-1px;margin:8px 0 2px}
.upi-sub{text-align:center;color:#737373;font-size:12.5px;line-height:1.5;margin:0 6px 12px}
.upi-sub b{color:#111}
.upi-qrwrap{display:flex;justify-content:center;margin:8px 0 12px}
.upi-qr{padding:12px;border:1.5px solid #e8e8e8;border-radius:16px;background:#fff;min-width:110px;min-height:110px;display:flex;align-items:center;justify-content:center;color:#737373;font-size:12px;text-align:center}
.upi-qr.dim{opacity:.2;filter:grayscale(1)}
.upi-btn{display:flex;align-items:center;justify-content:center;width:100%;padding:14px 18px;border-radius:12px;font:700 14px -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;border:1.5px solid #d4d4d4;background:#fff;color:#111;cursor:pointer;text-decoration:none;margin-top:8px}
.upi-btn.primary{background:#111;color:#fff;border-color:#111}
.upi-btn.danger{color:#dc2626;border-color:#fecaca}
.upi-btn:disabled{opacity:.5;cursor:not-allowed}
.upi-vpa{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#f6f6f6;border-radius:12px;padding:10px 14px;margin-top:10px;font-size:13px}
.upi-vpa span{word-break:break-all;font-weight:600}
.upi-copy{border:0;background:none;font-weight:700;color:#111;text-decoration:underline;cursor:pointer;font-size:12.5px;flex-shrink:0}
.upi-status{display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0 4px;font-weight:700;font-size:14px}
.upi-spin{width:18px;height:18px;border:2.5px solid #ddd;border-top-color:#111;border-radius:50%;animation:upispin .8s linear infinite;flex-shrink:0}
@keyframes upispin{to{transform:rotate(360deg)}}
.upi-timer{text-align:center;color:#737373;font-size:12.5px;font-variant-numeric:tabular-nums}
.upi-timer.late{color:#dc2626;font-weight:700}
.upi-note{text-align:center;color:#737373;font-size:11.5px;line-height:1.5;margin:10px 4px 0}
.upi-center{text-align:center;padding:26px 6px 8px}
.upi-tick{width:68px;height:68px;border-radius:50%;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:36px;margin:0 auto 14px}
.upi-ok{color:#16a34a;font-weight:800;font-size:20px}
.upi-order{order:0}
.upi-mobile .upi-appfirst{order:-1}
`;

  let _styled = false;
  function injectStyles() {
    if (_styled || typeof document === 'undefined') return;
    const st = document.createElement('style'); st.id = 'gateway-css'; st.textContent = CSS;
    document.head.appendChild(st); _styled = true;
  }

  const _libs = {};
  function loadScript(src, readyFn) {
    if (readyFn && readyFn()) return Promise.resolve();
    if (_libs[src]) return _libs[src];
    _libs[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => res(); s.onerror = () => { delete _libs[src]; rej(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return _libs[src];
  }

  const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  let sheet = null, S = null, timer = null;

  function ensureSheet() {
    injectStyles();
    if (sheet) return sheet;
    sheet = document.createElement('div');
    sheet.id = 'upiSheet';
    sheet.innerHTML = `<div class="upi-card" id="upiCard">
      <div class="upi-handle"></div>
      <div class="upi-head"><div class="upi-title">Pay with UPI</div><button class="upi-x" id="upiX" aria-label="Close">✕</button></div>
      <div id="upiView"></div></div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('#upiX').onclick = () => closeSheet(true);
    return sheet;
  }

  function teardown() {
    clearInterval(timer); timer = null;
    if (S) { try { S.unsubOrder && S.unsubOrder(); } catch (e) {} try { S.unsubLock && S.unsubLock(); } catch (e) {} }
  }
  function closeSheet(userClosed) {
    const cb = S && S.opts && S.opts.onClose;
    teardown();
    if (sheet) sheet.classList.remove('open');
    document.body.style.overflow = '';
    const wasPaid = S && S.paidFired;
    S = null;
    if (userClosed && cb && !wasPaid) cb();
  }

  const view = html => { sheet.querySelector('#upiView').innerHTML = html; };
  const $u = id => sheet.querySelector('#' + id);

  function showMessage(msg, btnLabel) {
    clearInterval(timer);
    view(`<div class="upi-center"><div class="upi-sub" style="font-size:14px;color:#111;">${esc(msg)}</div></div>
      <button class="upi-btn primary" id="upiDone">${esc(btnLabel || 'Close')}</button>`);
    $u('upiDone').onclick = () => closeSheet(true);
  }

  function openPaymentSheet(orderId, opts) {
    ensureSheet(); teardown();
    S = { orderId, opts: opts || {}, order: null, lockMs: 0, lockLoaded: false, lockFor: null, drawnFor: null, paidFired: false, shownView: null };
    sheet.classList.toggle('upi-mobile', isMobile());
    sheet.classList.add('open'); document.body.style.overflow = 'hidden';
    view('<div class="upi-center"><div class="upi-status"><div class="upi-spin"></div>Loading your payment…</div></div>');
    const mine = S;
    (async () => {
      try {
        S.cfg = await loadConfig();
        const { db, doc, onSnapshot } = fb();
        mine.unsubOrder = onSnapshot(doc(db, 'orders', orderId), snap => {
          if (S !== mine) return;
          if (!snap.exists()) { showMessage('We could not find this order.'); return; }
          mine.order = Object.assign({ id: snap.id }, snap.data());
          watchLock(); render();
        }, err => { console.error(err); if (S === mine) showMessage('Could not load this payment. Please try again from My Orders.'); });
      } catch (e) { console.error(e); showMessage('Could not start the payment. Please try again.'); }
    })();
  }

  function watchLock() {
    const o = S.order, lockId = o.upi && o.upi.lockId;
    if (!lockId || S.lockFor === lockId) return;
    S.lockFor = lockId;
    if (S.unsubLock) S.unsubLock();
    const mine = S, { db, doc, onSnapshot } = fb();
    S.unsubLock = onSnapshot(doc(db, 'upiLocks', lockId), s => {
      if (S !== mine) return;
      const d = s.exists() ? s.data() : null;
      mine.lockMs = (d && d.uid === o.uid && d.orderId === o.id) ? msOf(d.expiresAt) : 0;
      mine.lockLoaded = true; render();
    }, () => { if (S === mine) { mine.lockLoaded = true; render(); } });
  }

  function render() {
    const o = S && S.order;
    if (!o) return;
    if (o.paymentStatus === 'Paid') {
      clearInterval(timer);
      if (S.shownView !== 'paid') {
        S.shownView = 'paid';
        view(`<div class="upi-center"><div class="upi-tick">✓</div><div class="upi-ok">Payment received!</div>
          <div class="upi-sub" style="margin-top:8px;">Thank you — your order is confirmed.</div></div>`);
      }
      if (!S.paidFired) {
        S.paidFired = true;
        const cb = S.opts.onPaid, mine = S;
        setTimeout(() => { if (S !== mine) return; closeSheet(false); if (cb) cb(o); }, 1400);
      }
      return;
    }
    if (o.orderStatus === 'Cancelled') { S.shownView = 'gone'; showMessage('This order was cancelled.'); return; }
    if (!S.lockLoaded) return;

    const payable = o.upi.payablePaise;
    if (S.shownView !== 'await') { S.shownView = 'await'; S.drawnFor = null; buildAwaitView(o); }
    $u('upiAmt').textContent = rupees(payable);
    if (S.drawnFor !== payable) { S.drawnFor = payable; drawQr(o); }
    tick();
    if (!timer) timer = setInterval(tick, 1000);
  }

  function buildAwaitView(o) {
    const cfg = S.cfg, link = buildUpiLink({ vpa: cfg.upiId, name: cfg.payeeName, amountPaise: o.upi.payablePaise, note: 'Order ' + o.id, ref: o.id });
    const adj = o.upi.adjustmentPaise;
    view(`<div class="upi-amount" id="upiAmt"></div>
      <div class="upi-sub"><b>Pay exactly this amount.</b>${adj ? ` It includes a ${rupees(adj)} discount we use to recognise your payment.` : ''} Don't change it — we match your payment by the exact amount.</div>
      <div style="display:flex;flex-direction:column;">
        <a class="upi-btn primary upi-appfirst" id="upiApp" href="${esc(link)}">Open UPI app to pay</a>
        <div class="upi-qrwrap"><div class="upi-qr" id="upiQr">Preparing QR…</div></div>
      </div>
      <div class="upi-sub" style="margin-bottom:0;">Scan the QR with any UPI app (GPay, PhonePe, Paytm, FamPay…), or pay to:</div>
      <div class="upi-vpa"><span id="upiVpa">${esc(cfg.upiId)}</span><button class="upi-copy" id="upiCopy">Copy</button></div>
      <div class="upi-status" id="upiStatus"><div class="upi-spin"></div>Waiting for your payment…</div>
      <div class="upi-timer" id="upiTimer"></div>
      <div id="upiExtra"></div>
      <div class="upi-note">This page confirms automatically, usually within a minute or two of paying. You can close it and find this order in My Orders.</div>
      <button class="upi-btn danger" id="upiCancel">Cancel this order</button>`);
    $u('upiCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(cfg.upiId); $u('upiCopy').textContent = 'Copied'; }
      catch (e) { window.prompt('Copy this UPI ID', cfg.upiId); }
    };
    $u('upiCancel').onclick = async () => {
      if (!confirm('Cancel this order? If you have already paid, do not cancel — wait for confirmation.')) return;
      const id = S.orderId;
      try { await cancelUpiOrder(id); } catch (e) { console.error(e); alert('Could not cancel. Please try again.'); }
    };
  }

  async function drawQr(o) {
    const box = $u('upiQr'), cfg = S.cfg;
    const link = buildUpiLink({ vpa: cfg.upiId, name: cfg.payeeName, amountPaise: o.upi.payablePaise, note: 'Order ' + o.id, ref: o.id });
    $u('upiApp').setAttribute('href', link);
    try {
      await loadScript(QR_LIB, () => global.QRCode);
      box.innerHTML = '';
      new global.QRCode(box, { text: link, width: 200, height: 200, correctLevel: global.QRCode.CorrectLevel.M });
    } catch (e) {
      box.textContent = 'QR could not load. Use the button above or the UPI ID below.';
    }
  }

  function tick() {
    if (!S || !S.order || S.shownView !== 'await') return;
    const left = S.lockMs - Date.now();
    const t = $u('upiTimer'), qr = $u('upiQr'), extra = $u('upiExtra'), st = $u('upiStatus');
    if (left > 0) {
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      t.className = 'upi-timer'; t.textContent = 'Complete payment within ' + m + ':' + String(s).padStart(2, '0');
      qr.classList.remove('dim'); if (extra.innerHTML) extra.innerHTML = '';
      return;
    }
    t.className = 'upi-timer late'; t.textContent = "Time's up";
    qr.classList.add('dim');
    st.innerHTML = 'If you already paid, please wait a few minutes — late payments are still checked.';
    if (!extra.innerHTML) {
      extra.innerHTML = '<button class="upi-btn" id="upiMore">Get more time</button>';
      $u('upiMore').onclick = async () => {
        const b = $u('upiMore'); b.disabled = true; b.textContent = 'Please wait…';
        try {
          await renewLock(S.orderId);
          st.innerHTML = '<div class="upi-spin"></div>Waiting for your payment…';
        } catch (e) {
          if (!String(e.message).includes('SLOT_TAKEN')) console.error(e);   // SLOT_TAKEN is an expected outcome
          if (String(e.message).includes('SLOT_TAKEN')) {
            extra.innerHTML = '<div class="upi-note" style="color:#dc2626;">This payment slot was taken by another order. Please cancel this order and place it again.</div>';
          } else { b.disabled = false; b.textContent = 'Get more time'; alert('Could not extend the time. Please try again.'); }
        }
      };
    }
  }

  global.Gateway = {
    loadConfig, createUpiOrder, renewLock, cancelUpiOrder, openPaymentSheet,
    closeSheet: () => closeSheet(false),
    _t: { buildUpiLink, offsetsShuffled, normalizeConfig, isValidUpiId, slotIsFree, msOf, rupees, REUSE_BUFFER_MIN }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Gateway;
})(typeof window !== 'undefined' ? window : globalThis);