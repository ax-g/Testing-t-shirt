/* ============================================================
   Testing T-Shirt — Customer Storefront Logic
   Requires: window._fb (set in user.html module script)
   ============================================================ */

let currentUser = null;
let allProducts = [];
let cart = [];              // [{productId,name,image,price,salePrice,saleEnabled,size,color,qty,stock}]
let currentProduct = null;  // product open in detail view
let selectedSize = null;
let selectedColor = null;
let selectedQty = 1;
let currentMediaIndex = 0;
let authMode = 'login';
let selectedPayment = 'COD';
let pendingCheckoutAfterAuth = false;
let unsubOrders = null;

const CURRENCY = "₹";
const CART_KEY = 'tts_cart_v1';

/* ---------------- UTIL ---------------- */
function $(id){ return document.getElementById(id); }
function showLoader(v){ $('globalLoader').classList.toggle('active', v); }
function showToast(msg, type=''){
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  setTimeout(()=> t.classList.remove('show'), 2600);
}
function fmtMoney(n){ return CURRENCY + Number(n||0).toFixed(2); }
function fmtDate(ts){
  if(!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function escapeHtml(s){
  if(s==null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function effectivePrice(p){ return p.saleEnabled && p.salePrice ? p.salePrice : p.price; }
function getStock(p){
  // Handles stock saved as number, numeric string, or missing entirely.
  const raw = p.stock;
  if(raw === undefined || raw === null || raw === '') return 999; // unknown stock = don't block purchase
  const n = Number(raw);
  return isNaN(n) ? 999 : n;
}
function isOutOfStock(p){
  if(p.visibility === 'out_of_stock') return true;
  return getStock(p) <= 0;
}

/* ---------------- CART PERSISTENCE (in-memory + localStorage-free) ---------------- */
// Note: per artifact/browser rules we avoid localStorage in artifacts, but this is a
// standalone hosted site (not a Claude artifact), so we persist cart in-memory for the
// session and re-sync from Firestore on order placement. Guests can shop without login.
function loadCartFromMemory(){ /* cart is already in-memory; kept for clarity */ }

/* ---------------- NAVIGATION ---------------- */
function goTo(page){
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('page-' + page).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-btn[data-nav="${page}"]`);
  if(navBtn) navBtn.classList.add('active');

  if(page === 'cart') renderCartPage();
  if(page === 'orders') renderOrdersPage();
  window.scrollTo(0,0);
}
window.goTo = goTo;

/* ---------------- PRODUCTS: LOAD + RENDER HOME ---------------- */
function initProductsListener(){
  const { onSnapshot, collection, query, orderBy, db } = window._fb;
  try{
    const q = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
    onSnapshot(q, (snap) => {
      allProducts = [];
      snap.forEach(d => {
        const data = d.data();
        if(data.visibility === 'active'){
          allProducts.push({ id: d.id, ...data });
        }
      });
      renderCategoryNav();
      renderHomeProducts();
      renderSaleAndNewSections();
    }, (err) => {
      console.error('Products load error:', err);
      showToast('Failed to load products', 'error');
    });
  }catch(e){ console.error(e); }
}

let activeCategory = '';

function renderCategoryNav(){
  const cats = [...new Set(allProducts.map(p => p.category).filter(Boolean))];
  const wrap = $('categoryNav');
  wrap.innerHTML = `<div class="cat-chip ${activeCategory==='' ? 'active':''}" onclick="filterCategory('')">All</div>` +
    cats.map(c => `<div class="cat-chip ${activeCategory===c?'active':''}" onclick="filterCategory('${escapeHtml(c)}')">${escapeHtml(c)}</div>`).join('');
}

function filterCategory(cat){
  activeCategory = cat;
  renderCategoryNav();
  renderHomeProducts();
}
window.filterCategory = filterCategory;

function renderHomeProducts(){
  const searchVal = ($('searchInput')?.value || '').trim().toLowerCase();
  const isSearching = searchVal.length > 0;

  // While searching, hide the Sale/New curated rows and show one unified result grid
  // so the customer sees search results immediately instead of scrolling past
  // unrelated sections that still show unfiltered items.
  $('saleSection').style.display = isSearching ? 'none' : ($('saleSection').dataset.hasItems === '1' ? 'block' : 'none');
  $('newSection').style.display = isSearching ? 'none' : ($('newSection').dataset.hasItems === '1' ? 'block' : 'none');

  const filtered = allProducts.filter(p => {
    const matchSearch = !isSearching || (p.name||'').trim().toLowerCase().includes(searchVal);
    const matchCat = !activeCategory || p.category === activeCategory;
    return matchSearch && matchCat;
  });

  const grid = $('allGrid');
  const heading = document.querySelector('#allGrid').parentElement.querySelector('.section-title');
  if(heading) heading.textContent = isSearching ? `Results for "${searchVal}"` : 'All T-Shirts';

  if(filtered.length === 0){
    grid.innerHTML = `<div style="grid-column:1/-1;" class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      <div>No products found</div>
    </div>`;
    return;
  }
  grid.innerHTML = filtered.map(productCardHtml).join('');
}
window.renderHomeProducts = renderHomeProducts;

function renderSaleAndNewSections(){
  const saleItems = allProducts.filter(p => p.saleEnabled).slice(0, 6);
  const newItems = [...allProducts].slice(0, 6);

  const saleSection = $('saleSection');
  const newSection = $('newSection');

  if(saleItems.length){
    saleSection.dataset.hasItems = '1';
    saleSection.style.display = 'block';
    $('saleGrid').innerHTML = saleItems.map(productCardHtml).join('');
  } else {
    saleSection.dataset.hasItems = '0';
    saleSection.style.display = 'none';
  }
  if(newItems.length){
    newSection.dataset.hasItems = '1';
    newSection.style.display = 'block';
    $('newGrid').innerHTML = newItems.map(productCardHtml).join('');
  } else {
    newSection.dataset.hasItems = '0';
    newSection.style.display = 'none';
  }
}

function productCardHtml(p){
  const price = effectivePrice(p);
  const hasDiscount = p.saleEnabled && p.originalPrice && p.originalPrice > price;
  const oos = isOutOfStock(p);
  return `
  <div class="product-card" onclick="openProductDetail('${p.id}')">
    <div class="product-img-wrap">
      <img src="${escapeHtml(p.image1)}" alt="${escapeHtml(p.name)}" loading="lazy">
      ${hasDiscount ? `<div class="sale-badge">${p.discountPercent ? p.discountPercent+'% OFF' : 'SALE'}</div>` : ''}
      ${oos ? `<div class="sale-badge" style="background:var(--gray-500);">OUT OF STOCK</div>` : ''}
      ${p.offerText ? `<div class="offer-tag">${escapeHtml(p.offerText)}</div>` : ''}
    </div>
    <div class="product-name">${escapeHtml(p.name)}</div>
    <div class="product-price-row">
      <div class="price-current">${fmtMoney(price)}</div>
      ${hasDiscount ? `<div class="price-original">${fmtMoney(p.originalPrice)}</div>` : ''}
    </div>
  </div>`;
}

/* ---------------- PRODUCT DETAIL ---------------- */
function openProductDetail(productId){
  const p = allProducts.find(x => x.id === productId);
  if(!p){ showToast('Product not found', 'error'); return; }
  currentProduct = p;
  selectedSize = (p.sizes && p.sizes.length) ? null : null;
  selectedColor = (p.colors && p.colors.length) ? null : null;
  selectedQty = 1;
  currentMediaIndex = 0;
  renderProductDetail();
  goTo('detail');
}
window.openProductDetail = openProductDetail;

function collectMedia(p){
  const media = [];
  if(p.image1) media.push({ type:'image', url:p.image1 });
  if(p.image2) media.push({ type:'image', url:p.image2 });
  if(p.image3) media.push({ type:'image', url:p.image3 });
  if(p.image4) media.push({ type:'image', url:p.image4 });
  if(p.videoEnabled && p.videoUrl) media.push({ type:'video', url:p.videoUrl });
  return media;
}

function renderProductDetail(){
  const p = currentProduct;
  const media = collectMedia(p);
  const price = effectivePrice(p);
  const hasDiscount = p.saleEnabled && p.originalPrice && p.originalPrice > price;
  const stock = getStock(p);
  const oos = isOutOfStock(p);

  const mediaHtml = media.map(m => `
    <div class="pd-media-item">
      ${m.type === 'image'
        ? `<img src="${escapeHtml(m.url)}" alt="${escapeHtml(p.name)}">`
        : `<video src="${escapeHtml(m.url)}" controls playsinline></video>`}
    </div>
  `).join('');

  const dotsHtml = media.length > 1 ? `
    <div class="pd-dots">
      ${media.map((_,i) => `<div class="pd-dot ${i===0?'active':''}"></div>`).join('')}
    </div>` : '';

  const colorsHtml = (p.colors && p.colors.length) ? `
    <div class="pd-section">
      <div class="pd-section-title">Color</div>
      <div class="swatch-row">
        ${p.colors.map(c => `<div class="color-swatch" style="background:${colorToCss(c)}" title="${escapeHtml(c)}" onclick="selectColor('${escapeHtml(c)}')" id="swatch-${escapeHtml(c).replace(/\s/g,'')}"></div>`).join('')}
      </div>
    </div>` : '';

  const sizesHtml = (p.sizes && p.sizes.length) ? `
    <div class="pd-section">
      <div class="pd-section-title">Size</div>
      <div class="swatch-row">
        ${p.sizes.map(s => `<div class="size-btn" onclick="selectSize('${escapeHtml(s)}')" id="size-${escapeHtml(s)}">${escapeHtml(s)}</div>`).join('')}
      </div>
    </div>` : '';

  let stockNote = '';
  if(oos) stockNote = `<div class="stock-note stock-out">Out of stock</div>`;
  else if(stock <= 5 && stock < 999) stockNote = `<div class="stock-note stock-low">Only ${stock} left in stock</div>`;
  else stockNote = `<div class="stock-note stock-in">In stock</div>`;

  $('pdContent').innerHTML = `
    <div class="pd-gallery">
      <div class="pd-media-track" id="pdMediaTrack" onscroll="handleGalleryScroll(event)">
        ${mediaHtml}
      </div>
      ${dotsHtml}
    </div>
    <div class="pd-body">
      ${p.category ? `<div class="pd-category">${escapeHtml(p.category)}</div>` : ''}
      <div class="pd-name">${escapeHtml(p.name)}</div>
      <div class="pd-price-row">
        <div class="pd-price">${fmtMoney(price)}</div>
        ${hasDiscount ? `<div class="pd-original">${fmtMoney(p.originalPrice)}</div>` : ''}
        ${p.discountPercent ? `<div class="pd-discount">${p.discountPercent}% OFF</div>` : ''}
      </div>
      ${p.offerText ? `<div class="pd-offer">${escapeHtml(p.offerText)}</div>` : ''}
      ${stockNote}

      ${colorsHtml}
      ${sizesHtml}

      <div class="pd-section">
        <div class="pd-section-title">Quantity</div>
        <div class="qty-selector">
          <button class="qty-btn" onclick="changeQty(-1)">−</button>
          <div class="qty-val" id="qtyVal">1</div>
          <button class="qty-btn" onclick="changeQty(1)">+</button>
        </div>
      </div>

      ${p.description ? `
      <div class="pd-section">
        <div class="pd-section-title">Description</div>
        <div class="pd-desc">${escapeHtml(p.description)}</div>
      </div>` : ''}
    </div>
    <div class="pd-sticky-bar">
      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline" style="flex:1;" id="addToCartBtn" ${oos ? 'disabled' : ''} onclick="addCurrentToCart()">
          ${oos ? 'Out of Stock' : 'Add to Cart'}
        </button>
        <button class="btn btn-primary" style="flex:1;" id="buyNowBtn" ${oos ? 'disabled' : ''} onclick="buyNow()">
          Buy Now
        </button>
      </div>
    </div>
  `;
}

function colorToCss(name){
  const map = { black:'#111',white:'#f5f5f5',navy:'#1e3a5f',blue:'#2563eb',red:'#dc2626',
    green:'#16a34a',olive:'#556b2f',gray:'#737373',grey:'#737373',beige:'#d8c3a5',
    maroon:'#7f1d1d',yellow:'#eab308',pink:'#ec4899',brown:'#7c4a2d',orange:'#ea580c',purple:'#7c3aed' };
  const key = String(name).toLowerCase().trim();
  return map[key] || '#999';
}

function handleGalleryScroll(e){
  const track = e.target;
  const idx = Math.round(track.scrollLeft / track.clientWidth);
  document.querySelectorAll('.pd-dot').forEach((d,i) => d.classList.toggle('active', i===idx));
}
window.handleGalleryScroll = handleGalleryScroll;

function selectColor(c){
  selectedColor = c;
  document.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('selected'));
  const el = $('swatch-' + c.replace(/\s/g,''));
  if(el) el.classList.add('selected');
}
window.selectColor = selectColor;

function selectSize(s){
  selectedSize = s;
  document.querySelectorAll('.size-btn').forEach(el => el.classList.remove('selected'));
  const el = $('size-' + s);
  if(el) el.classList.add('selected');
}
window.selectSize = selectSize;

function changeQty(delta){
  const stock = Number(currentProduct.stock) || 99;
  selectedQty = Math.max(1, Math.min(stock, selectedQty + delta));
  $('qtyVal').textContent = selectedQty;
}
window.changeQty = changeQty;

function addCurrentToCart(){
  const p = currentProduct;
  if(p.colors && p.colors.length && !selectedColor){ showToast('Please select a color', 'error'); return; }
  if(p.sizes && p.sizes.length && !selectedSize){ showToast('Please select a size', 'error'); return; }

  const price = effectivePrice(p);
  const existing = cart.find(item => item.productId === p.id && item.size === selectedSize && item.color === selectedColor);
  if(existing){
    existing.qty += selectedQty;
  } else {
    cart.push({
      productId: p.id,
      name: p.name,
      image: p.image1,
      price: p.price,
      salePrice: p.salePrice || null,
      saleEnabled: !!p.saleEnabled,
      size: selectedSize,
      color: selectedColor,
      qty: selectedQty,
      stock: Number(p.stock) || 0
    });
  }
  updateCartBadge();
  showToast('Added to cart', 'success');
}
window.addCurrentToCart = addCurrentToCart;

function buyNow(){
  const p = currentProduct;
  if(p.colors && p.colors.length && !selectedColor){ showToast('Please select a color', 'error'); return; }
  if(p.sizes && p.sizes.length && !selectedSize){ showToast('Please select a size', 'error'); return; }
  addCurrentToCart();
  goTo('cart');
}
window.buyNow = buyNow;

/* ---------------- CART ---------------- */
function updateCartBadge(){
  const count = cart.reduce((s,i) => s + i.qty, 0);
  const badge1 = $('cartBadge');
  const badge2 = $('navCartBadge');
  if(count > 0){
    badge1.style.display='flex'; badge1.textContent = count;
    badge2.style.display='flex'; badge2.textContent = count;
  } else {
    badge1.style.display='none';
    badge2.style.display='none';
  }
}

function cartItemPrice(item){ return item.saleEnabled && item.salePrice ? item.salePrice : item.price; }

function renderCartPage(){
  const wrap = $('cartContent');
  if(cart.length === 0){
    wrap.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
      <div>Your cart is empty</div>
      <button class="btn btn-outline btn-sm" style="margin-top:16px;" onclick="goTo('home')">Browse Products</button>
    </div>`;
    return;
  }

  const itemsHtml = cart.map((item, idx) => `
    <div class="cart-item">
      <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">
      <div class="cart-item-info">
        <div class="cart-item-name">${escapeHtml(item.name)}</div>
        <div class="cart-item-variant">${item.size ? 'Size: '+escapeHtml(item.size) : ''}${item.size && item.color ? ' · ' : ''}${item.color ? 'Color: '+escapeHtml(item.color) : ''}</div>
        <div class="cart-item-bottom">
          <div class="cart-qty">
            <button onclick="changeCartQty(${idx},-1)">−</button>
            <div class="val">${item.qty}</div>
            <button onclick="changeCartQty(${idx},1)">+</button>
          </div>
          <div class="cart-item-price">${fmtMoney(cartItemPrice(item) * item.qty)}</div>
        </div>
        <button class="remove-btn" onclick="removeCartItem(${idx})">Remove</button>
      </div>
    </div>
  `).join('');

  const subtotal = cart.reduce((s,i) => s + cartItemPrice(i) * i.qty, 0);

  wrap.innerHTML = `
    ${itemsHtml}
    <div style="margin-top:16px;">
      <div class="summary-row"><span class="muted">Subtotal</span><span>${fmtMoney(subtotal)}</span></div>
      <div class="summary-row total"><span>Total</span><span>${fmtMoney(subtotal)}</span></div>
    </div>
    <button class="btn btn-primary" style="margin-top:16px;" onclick="startCheckout()">Proceed to Checkout</button>
  `;
}

function changeCartQty(idx, delta){
  const item = cart[idx];
  const maxStock = item.stock || 99;
  item.qty = Math.max(1, Math.min(maxStock, item.qty + delta));
  renderCartPage();
  updateCartBadge();
}
window.changeCartQty = changeCartQty;

function removeCartItem(idx){
  cart.splice(idx,1);
  renderCartPage();
  updateCartBadge();
}
window.removeCartItem = removeCartItem;

/* ---------------- AUTH ---------------- */
function openAuthSheet(){
  $('authSheet').classList.add('active');
}
function closeAuthSheet(){
  $('authSheet').classList.remove('active');
  $('authError').style.display = 'none';
  pendingCheckoutAfterAuth = false;
}
window.closeAuthSheet = closeAuthSheet;

function switchAuthTab(mode){
  authMode = mode;
  $('tabLogin').classList.toggle('active', mode==='login');
  $('tabSignup').classList.toggle('active', mode==='signup');
  $('signupNameField').style.display = mode==='signup' ? 'block' : 'none';
  $('authSubmitBtn').textContent = mode==='login' ? 'Sign In' : 'Create Account';
  $('authError').style.display = 'none';
}
window.switchAuthTab = switchAuthTab;

async function handleAuthSubmit(){
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  const errBox = $('authError');
  errBox.style.display = 'none';

  if(!email || !password){
    errBox.textContent = 'Please fill in all fields.';
    errBox.style.display = 'block';
    return;
  }
  if(authMode === 'signup' && !$('authName').value.trim()){
    errBox.textContent = 'Please enter your name.';
    errBox.style.display = 'block';
    return;
  }

  const btn = $('authSubmitBtn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';

  try{
    const { auth, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } = window._fb;
    if(authMode === 'login'){
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: $('authName').value.trim() });
    }
    closeAuthSheet();
    if(pendingCheckoutAfterAuth){
      pendingCheckoutAfterAuth = false;
      openCheckoutSheet();
    }
  }catch(err){
    console.error(err);
    errBox.textContent = mapAuthError(err.code);
    errBox.style.display = 'block';
  }finally{
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
window.handleAuthSubmit = handleAuthSubmit;

function mapAuthError(code){
  const map = {
    'auth/invalid-credential':'Incorrect email or password.',
    'auth/user-not-found':'No account found with this email.',
    'auth/wrong-password':'Incorrect password.',
    'auth/email-already-in-use':'An account already exists with this email.',
    'auth/weak-password':'Password should be at least 6 characters.',
    'auth/invalid-email':'Invalid email address.'
  };
  return map[code] || 'Something went wrong. Please try again.';
}

function initAuthListener(){
  const { onAuthStateChanged, auth } = window._fb;
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if(user){
      $('coName').value = user.displayName || '';
      $('coEmail').value = user.email || '';
      initOrdersListener();
    } else {
      if(unsubOrders){ unsubOrders(); unsubOrders = null; }
      renderOrdersPage();
    }
  });
}

/* ---------------- CHECKOUT ---------------- */
function startCheckout(){
  if(cart.length === 0){ showToast('Your cart is empty', 'error'); return; }
  if(!currentUser){
    pendingCheckoutAfterAuth = true;
    switchAuthTab('login');
    openAuthSheet();
    return;
  }
  openCheckoutSheet();
}
window.startCheckout = startCheckout;

function openCheckoutSheet(){
  renderCheckoutSummary();
  $('checkoutSheet').classList.add('active');
}
function closeCheckoutSheet(){
  $('checkoutSheet').classList.remove('active');
}
window.closeCheckoutSheet = closeCheckoutSheet;

function renderCheckoutSummary(){
  const subtotal = cart.reduce((s,i) => s + cartItemPrice(i) * i.qty, 0);
  $('checkoutSummary').innerHTML = `
    ${cart.map(i => `
      <div class="summary-row">
        <span class="muted">${escapeHtml(i.name)} ${i.size?`(${escapeHtml(i.size)})`:''} × ${i.qty}</span>
        <span>${fmtMoney(cartItemPrice(i)*i.qty)}</span>
      </div>
    `).join('')}
    <div class="summary-row total"><span>Total</span><span>${fmtMoney(subtotal)}</span></div>
  `;
}

function selectPayment(method){
  selectedPayment = method;
  $('payOptionCOD').classList.toggle('selected', method==='COD');
  $('payOptionONLINE').classList.toggle('selected', method==='ONLINE');
  document.querySelector('#payOptionCOD input').checked = method==='COD';
  document.querySelector('#payOptionONLINE input').checked = method==='ONLINE';
}
window.selectPayment = selectPayment;

async function placeOrder(){
  const name = $('coName').value.trim();
  const email = $('coEmail').value.trim();
  const phone = $('coPhone').value.trim();
  const address = $('coAddress').value.trim();
  const city = $('coCity').value.trim();
  const state = $('coState').value.trim();
  const pincode = $('coPincode').value.trim();

  if(!name || !email || !phone || !address || !city || !state || !pincode){
    showToast('Please fill in all delivery details', 'error');
    return;
  }
  if(!currentUser){
    showToast('Please sign in to place an order', 'error');
    return;
  }

  const btn = $('placeOrderBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try{
    const subtotal = cart.reduce((s,i) => s + cartItemPrice(i) * i.qty, 0);
    const orderId = 'TTS' + Date.now().toString().slice(-8);

    const orderProducts = cart.map(i => ({
      productId: i.productId,
      name: i.name,
      image: i.image,
      size: i.size,
      color: i.color,
      quantity: i.qty,
      price: cartItemPrice(i)
    }));

    let paymentStatus = 'Unpaid';
    let orderStatus = 'Pending';

    if(selectedPayment === 'ONLINE'){
      // ---------------------------------------------------------
      // IMPORTANT: Online payment must be verified server-side.
      // This is a placeholder hook for a real payment gateway
      // (Razorpay/Stripe/etc). Replace with actual gateway checkout,
      // then confirm payment via a Cloud Function that verifies the
      // signature/webhook BEFORE marking paymentStatus = 'Paid'.
      // We do NOT trust client-side success here.
      // ---------------------------------------------------------
      const confirmed = await runOnlinePaymentFlow(subtotal, orderId);
      if(!confirmed){
        showToast('Payment was not completed', 'error');
        btn.disabled = false;
        btn.textContent = 'Place Order';
        return;
      }
      paymentStatus = 'Pending Verification'; // server verifies & updates to "Paid"
      orderStatus = 'Pending';
    }

    const { db, doc, setDoc, serverTimestamp } = window._fb;
    await setDoc(doc(db, 'orders', orderId), {
      orderId,
      uid: currentUser.uid,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      address, city, state, pincode,
      products: orderProducts,
      subtotal,
      discount: 0,
      finalTotal: subtotal,
      paymentMethod: selectedPayment === 'COD' ? 'COD' : 'Online Payment',
      paymentStatus,
      orderStatus,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    // NOTE: Admin email notification is triggered server-side via a Cloud
    // Function listening on orders/{orderId} onCreate (see functions/index.js).
    // No client-side email sending occurs here — this keeps it secure.

    cart = [];
    updateCartBadge();
    closeCheckoutSheet();
    showToast('Order placed successfully!', 'success');
    goTo('orders');
  }catch(err){
    console.error(err);
    showToast('Failed to place order: ' + err.message, 'error');
  }finally{
    btn.disabled = false;
    btn.textContent = 'Place Order';
  }
}
window.placeOrder = placeOrder;

async function runOnlinePaymentFlow(amount, orderId){
  // Placeholder integration point for a real gateway (Razorpay/Stripe/etc).
  // Replace this function body with the gateway's checkout SDK call.
  // Return true only after the gateway reports success; actual payment
  // confirmation/marking as "Paid" must still happen via secure server-side
  // verification (Cloud Function + webhook), never trusted from the browser alone.
  return new Promise((resolve) => {
    const ok = confirm(`Proceed to pay ${fmtMoney(amount)} via configured payment gateway?\n\n(Connect your real gateway here — Razorpay/Stripe/etc.)`);
    resolve(ok);
  });
}

/* ---------------- ORDERS ---------------- */
let myOrders = [];

function initOrdersListener(){
  if(!currentUser) return;
  const { onSnapshot, collection, query, where, orderBy, db } = window._fb;
  try{
    const q = query(collection(db, 'orders'), where('uid', '==', currentUser.uid), orderBy('createdAt', 'desc'));
    unsubOrders = onSnapshot(q, (snap) => {
      myOrders = [];
      snap.forEach(d => myOrders.push({ id: d.id, ...d.data() }));
      renderOrdersPage();
    }, (err) => {
      console.error('Orders load error:', err);
    });
  }catch(e){ console.error(e); }
}

function renderOrdersPage(){
  const wrap = $('ordersContent');
  if(!currentUser){
    wrap.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/></svg>
      <div>Sign in to view your orders</div>
      <button class="btn btn-outline btn-sm" style="margin-top:16px;" onclick="switchAuthTab('login');openAuthSheet();">Sign In</button>
    </div>`;
    return;
  }
  if(myOrders.length === 0){
    wrap.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/></svg>
      <div>No orders yet</div>
      <button class="btn btn-outline btn-sm" style="margin-top:16px;" onclick="goTo('home')">Start Shopping</button>
    </div>`;
    return;
  }
  wrap.innerHTML = myOrders.map(o => `
    <div class="order-card" onclick="openOrderDetail('${o.id}')">
      <div class="order-card-top">
        <div>
          <div class="order-id">#${escapeHtml(o.orderId||o.id)}</div>
          <div class="order-date">${fmtDate(o.createdAt)}</div>
        </div>
        <span class="badge badge-${(o.orderStatus||'pending').toLowerCase()}">${escapeHtml(o.orderStatus||'Pending')}</span>
      </div>
      <div class="order-thumbs">
        ${(o.products||[]).slice(0,5).map(p => `<img src="${escapeHtml(p.image||'')}" onerror="this.style.opacity=0.3">`).join('')}
      </div>
      <div class="order-total-row">
        <span style="font-size:12px;color:var(--gray-500);">${escapeHtml(o.paymentMethod)} · ${escapeHtml(o.paymentStatus)}</span>
        <span style="font-weight:800;">${fmtMoney(o.finalTotal)}</span>
      </div>
    </div>
  `).join('');
}

function openOrderDetail(orderId){
  const o = myOrders.find(x => x.id === orderId);
  if(!o) return;
  $('orderDetailContent').innerHTML = `
    <div class="order-card-top" style="margin-bottom:14px;">
      <div>
        <div class="order-id">#${escapeHtml(o.orderId||o.id)}</div>
        <div class="order-date">${fmtDate(o.createdAt)}</div>
      </div>
      <span class="badge badge-${(o.orderStatus||'pending').toLowerCase()}">${escapeHtml(o.orderStatus)}</span>
    </div>
    ${(o.products||[]).map(p => `
      <div class="cart-item">
        <img src="${escapeHtml(p.image||'')}" onerror="this.style.opacity=0.3">
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(p.name)}</div>
          <div class="cart-item-variant">${p.size?'Size: '+escapeHtml(p.size):''} ${p.color?'· Color: '+escapeHtml(p.color):''} · Qty: ${p.quantity}</div>
          <div class="cart-item-price">${fmtMoney(p.price * p.quantity)}</div>
        </div>
      </div>
    `).join('')}
    <div style="margin-top:14px;">
      <div class="summary-row"><span class="muted">Subtotal</span><span>${fmtMoney(o.subtotal)}</span></div>
      <div class="summary-row total"><span>Total</span><span>${fmtMoney(o.finalTotal)}</span></div>
    </div>
    <div class="pd-section-title" style="margin-top:16px;">Delivery Address</div>
    <div class="pd-desc">${escapeHtml(o.customerName)}<br>${escapeHtml(o.address)}, ${escapeHtml(o.city)}, ${escapeHtml(o.state)} - ${escapeHtml(o.pincode)}<br>${escapeHtml(o.customerPhone)}</div>
    <div class="pd-section-title" style="margin-top:16px;">Payment</div>
    <div class="pd-desc">${escapeHtml(o.paymentMethod)} · <span class="badge badge-${(o.paymentStatus||'unpaid').toLowerCase().replace(/\s/g,'')}">${escapeHtml(o.paymentStatus)}</span></div>
  `;
  $('orderDetailSheet').classList.add('active');
}
window.openOrderDetail = openOrderDetail;

function closeOrderDetailSheet(){
  $('orderDetailSheet').classList.remove('active');
}
window.closeOrderDetailSheet = closeOrderDetailSheet;

/* ---------------- INIT ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  const waitForFb = setInterval(() => {
    if(window._fb){
      clearInterval(waitForFb);
      initAuthListener();
      initProductsListener();
    }
  }, 50);
});