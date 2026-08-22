/* ============================================================
   Testing T-Shirt — Admin Panel Logic
   Requires: window._fb (set in admin.html module script)
   ============================================================ */

let currentUser = null;
let allProducts = [];
let allOrders = [];
let editingColors = [];
let editingSizes = [];
let unsubProducts = null;
let unsubOrders = null;

const CURRENCY = "₹";

/* ---------------- UTIL ---------------- */
function $(id){ return document.getElementById(id); }
function showLoader(v){ $('globalLoader').classList.toggle('active', v); }
function showToast(msg, type=''){
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  setTimeout(()=> t.classList.remove('show'), 3000);
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

/* ---------------- SIDEBAR / NAV ---------------- */
function toggleSidebar(open){
  $('sidebar').classList.toggle('open', open);
  $('sidebarBackdrop').classList.toggle('active', open);
}
function navigate(page){
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('page-' + page).classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`).classList.add('active');
  toggleSidebar(false);
}
window.navigate = navigate;
window.toggleSidebar = toggleSidebar;

/* ---------------- AUTH ---------------- */
async function handleLogin(){
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  const errBox = $('loginError');
  errBox.style.display = 'none';

  if(!email || !password){
    errBox.textContent = 'Please enter both email and password.';
    errBox.style.display = 'block';
    return;
  }

  $('loginBtn').disabled = true;
  $('loginBtnText').innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:middle;"></span>';

  try{
    const { signInWithEmailAndPassword, auth } = window._fb;
    const cred = await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged will handle admin verification + UI switch
  }catch(err){
    console.error(err);
    errBox.textContent = mapAuthError(err.code);
    errBox.style.display = 'block';
    $('loginBtn').disabled = false;
    $('loginBtnText').textContent = 'Sign In';
  }
}
window.handleLogin = handleLogin;

function mapAuthError(code){
  const map = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-email': 'Invalid email address.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.'
  };
  return map[code] || 'Sign in failed. Please try again.';
}

async function handleLogout(){
  const { signOut, auth } = window._fb;
  if(unsubProducts) unsubProducts();
  if(unsubOrders) unsubOrders();
  await signOut(auth);
}
window.handleLogout = handleLogout;

function initAuthListener(){
  const { onAuthStateChanged, auth, doc, getDoc, db } = window._fb;
  onAuthStateChanged(auth, async (user) => {
    if(user){
      // SECURITY: verify this user is an authorized admin via Firestore /admins/{uid}
      showLoader(true);
      try{
        const adminDoc = await getDoc(doc(db, 'admins', user.uid));
        if(adminDoc.exists() && adminDoc.data().active !== false){
          currentUser = user;
          $('loginScreen').style.display = 'none';
          $('adminApp').style.display = 'block';
          $('adminEmailDisplay').textContent = user.email;
          $('loginBtn').disabled = false;
          $('loginBtnText').textContent = 'Sign In';
          initDashboard();
          initProductsListener();
          initOrdersListener();
          loadSettings();
        } else {
          // Not an authorized admin — sign out immediately
          const { signOut } = window._fb;
          await signOut(auth);
          $('loginError').textContent = 'This account is not authorized for admin access.';
          $('loginError').style.display = 'block';
          $('loginScreen').style.display = 'flex';
          $('adminApp').style.display = 'none';
        }
      }catch(e){
        console.error('Admin verification failed:', e);
        const { signOut } = window._fb;
        await signOut(auth);
        $('loginError').textContent = 'Access verification failed. Contact store owner.';
        $('loginError').style.display = 'block';
      }
      showLoader(false);
    } else {
      currentUser = null;
      $('loginScreen').style.display = 'flex';
      $('adminApp').style.display = 'none';
    }
  });
}

/* ---------------- DASHBOARD ---------------- */
function initDashboard(){
  // Stats derived from live product/order listeners; refreshed in their callbacks
  refreshStats();
}

function refreshStats(){
  $('statProducts').textContent = allProducts.length;
  $('statOrders').textContent = allOrders.length;
  const pending = allOrders.filter(o => o.orderStatus === 'Pending').length;
  $('statPending').textContent = pending;
  const totalSales = allOrders
    .filter(o => o.paymentStatus === 'Paid' || o.paymentMethod === 'COD')
    .reduce((sum,o) => sum + Number(o.finalTotal||0), 0);
  $('statSales').textContent = fmtMoney(totalSales);

  // Recent orders table (top 5)
  const recent = [...allOrders].sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0)).slice(0,5);
  const body = $('recentOrdersBody');
  if(recent.length === 0){
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:30px;">No orders yet</td></tr>`;
    return;
  }
  body.innerHTML = recent.map(o => `
    <tr>
      <td style="font-weight:600;">#${escapeHtml(o.orderId||o.id)}</td>
      <td>${escapeHtml(o.customerName||'—')}</td>
      <td>${fmtDate(o.createdAt)}</td>
      <td style="font-weight:600;">${fmtMoney(o.finalTotal)}</td>
      <td>${escapeHtml(o.paymentMethod||'—')}</td>
      <td><span class="badge badge-${(o.orderStatus||'pending').toLowerCase()}">${escapeHtml(o.orderStatus||'Pending')}</span></td>
    </tr>
  `).join('');
}

/* ---------------- PRODUCTS: LISTENER + RENDER ---------------- */
function initProductsListener(){
  const { onSnapshot, collection, query, orderBy, db } = window._fb;
  try{
    const q = query(collection(db, 'products'), orderBy('createdAt', 'desc'));
    unsubProducts = onSnapshot(q, (snap) => {
      allProducts = [];
      snap.forEach(d => allProducts.push({ id: d.id, ...d.data() }));
      renderProductsTable();
      refreshStats();
    }, (err) => {
      console.error('Products listener error:', err);
      showToast('Failed to load products: ' + err.message, 'error');
    });
  }catch(e){ console.error(e); }
}

function renderProductsTable(){
  const searchVal = ($('productSearch')?.value || '').toLowerCase();
  const filtered = allProducts.filter(p =>
    (p.name||'').toLowerCase().includes(searchVal) ||
    (p.category||'').toLowerCase().includes(searchVal)
  );
  const body = $('productsTableBody');
  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:40px;">No products found. Click "+ Add Product" to create one.</td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(p => {
    const visClass = p.visibility === 'active' ? 'badge-active' : (p.visibility === 'out_of_stock' ? 'badge-oos' : 'badge-hidden');
    const visLabel = p.visibility === 'active' ? 'Active' : (p.visibility === 'out_of_stock' ? 'Out of Stock' : 'Hidden');
    return `
    <tr>
      <td>
        <div class="row-flex">
          <img class="product-thumb" src="${escapeHtml(p.image1||'')}" onerror="this.style.opacity=0.3" alt="">
          <div>
            <div style="font-weight:600;">${escapeHtml(p.name||'Untitled')}</div>
            <div style="color:var(--gray-500);font-size:12px;">${(p.sizes||[]).length} sizes · ${(p.colors||[]).length} colors</div>
          </div>
        </div>
      </td>
      <td>${escapeHtml(p.category||'—')}</td>
      <td>
        <div style="font-weight:600;">${fmtMoney(p.saleEnabled ? p.salePrice : p.price)}</div>
        ${p.saleEnabled ? `<div style="color:var(--gray-500);text-decoration:line-through;font-size:12px;">${fmtMoney(p.originalPrice||p.price)}</div>` : ''}
      </td>
      <td>${p.stock ?? 0}</td>
      <td><span class="badge ${visClass}">${visLabel}</span></td>
      <td>
        <div class="row-flex">
          <button class="icon-btn" title="Edit" onclick="openProductModal('${p.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
          </button>
          <button class="icon-btn" title="${p.visibility==='hidden' ? 'Show' : 'Hide'}" onclick="toggleProductVisibility('${p.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="icon-btn" title="Delete" onclick="deleteProduct('${p.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}
window.renderProductsTable = renderProductsTable;

/* ---------------- PRODUCT MODAL ---------------- */
function openProductModal(productId){
  editingColors = [];
  editingSizes = [];
  $('productId').value = productId || '';
  $('productModalTitle').textContent = productId ? 'Edit Product' : 'Add Product';

  if(productId){
    const p = allProducts.find(x => x.id === productId);
    if(!p){ showToast('Product not found', 'error'); return; }
    $('pName').value = p.name || '';
    $('pDescription').value = p.description || '';
    $('pCategory').value = p.category || '';
    $('pPrice').value = p.price ?? '';
    $('pOriginalPrice').value = p.originalPrice ?? '';
    $('pSaleEnabled').checked = !!p.saleEnabled;
    $('pSalePrice').value = p.salePrice ?? '';
    $('pDiscountPercent').value = p.discountPercent ?? '';
    $('pOfferText').value = p.offerText || '';
    $('pImage1').value = p.image1 || '';
    $('pImage2').value = p.image2 || '';
    $('pImage3').value = p.image3 || '';
    $('pImage4').value = p.image4 || '';
    $('pVideoUrl').value = p.videoUrl || '';
    $('pStock').value = p.stock ?? '';
    $('pVisibility').value = p.visibility || 'active';
    editingColors = [...(p.colors || [])];
    editingSizes = [...(p.sizes || [])];
  } else {
    ['pName','pDescription','pCategory','pPrice','pOriginalPrice','pSalePrice',
     'pDiscountPercent','pOfferText','pImage1','pImage2','pImage3','pImage4',
     'pVideoUrl','pStock'].forEach(id => $(id).value = '');
    $('pSaleEnabled').checked = false;
    $('pVisibility').value = 'active';
  }
  toggleSaleFields();
  renderChips('color');
  renderChips('size');
  $('productModalOverlay').classList.add('active');
}
window.openProductModal = openProductModal;

function closeProductModal(){
  $('productModalOverlay').classList.remove('active');
}
window.closeProductModal = closeProductModal;

function toggleSaleFields(){
  const on = $('pSaleEnabled').checked;
  $('saleFieldsWrap1').style.display = on ? 'block' : 'none';
  $('saleFieldsWrap2').style.display = on ? 'block' : 'none';
}
window.toggleSaleFields = toggleSaleFields;

function handleChipInput(e, type){
  if(e.key === 'Enter'){
    e.preventDefault();
    const input = type === 'color' ? $('colorInput') : $('sizeInput');
    const val = input.value.trim();
    if(val){
      const arr = type === 'color' ? editingColors : editingSizes;
      if(!arr.includes(val)) arr.push(val);
      input.value = '';
      renderChips(type);
    }
  }
}
window.handleChipInput = handleChipInput;

function renderChips(type){
  const arr = type === 'color' ? editingColors : editingSizes;
  const wrap = type === 'color' ? $('colorChipInput') : $('sizeChipInput');
  const input = type === 'color' ? $('colorInput') : $('sizeInput');
  wrap.querySelectorAll('.chip').forEach(c => c.remove());
  arr.forEach((val, idx) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(val)} <button onclick="removeChip('${type}',${idx})">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>`;
    wrap.insertBefore(chip, input);
  });
}

function removeChip(type, idx){
  const arr = type === 'color' ? editingColors : editingSizes;
  arr.splice(idx, 1);
  renderChips(type);
}
window.removeChip = removeChip;

async function saveProduct(){
  const id = $('productId').value;
  const name = $('pName').value.trim();
  const price = parseFloat($('pPrice').value);
  const image1 = $('pImage1').value.trim();

  if(!name){ showToast('Product name is required', 'error'); return; }
  if(!price || price <= 0){ showToast('Valid price is required', 'error'); return; }
  if(!image1){ showToast('Image 1 is required', 'error'); return; }

  const saleEnabled = $('pSaleEnabled').checked;

  const data = {
    name,
    description: $('pDescription').value.trim(),
    category: $('pCategory').value.trim(),
    price,
    originalPrice: parseFloat($('pOriginalPrice').value) || price,
    saleEnabled,
    salePrice: saleEnabled ? (parseFloat($('pSalePrice').value) || price) : null,
    discountPercent: saleEnabled ? (parseFloat($('pDiscountPercent').value) || null) : null,
    offerText: $('pOfferText').value.trim() || null,
    image1,
    image2: $('pImage2').value.trim() || null,
    image3: $('pImage3').value.trim() || null,
    image4: $('pImage4').value.trim() || null,
    videoUrl: $('pVideoUrl').value.trim() || null,
    videoEnabled: !!$('pVideoUrl').value.trim(),
    colors: editingColors,
    sizes: editingSizes,
    stock: $('pStock').value.trim() === '' ? 999 : (parseInt($('pStock').value) || 0),
    visibility: $('pVisibility').value,
    updatedAt: window._fb.serverTimestamp()
  };

  const btn = $('saveProductBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try{
    const { db, doc, addDoc, updateDoc, collection, serverTimestamp } = window._fb;
    if(id){
      await updateDoc(doc(db, 'products', id), data);
      showToast('Product updated successfully', 'success');
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, 'products'), data);
      showToast('Product added successfully', 'success');
    }
    closeProductModal();
  }catch(err){
    console.error(err);
    showToast('Failed to save product: ' + err.message, 'error');
  }finally{
    btn.disabled = false;
    btn.textContent = 'Save Product';
  }
}
window.saveProduct = saveProduct;

async function toggleProductVisibility(id){
  const p = allProducts.find(x => x.id === id);
  if(!p) return;
  const newVis = p.visibility === 'hidden' ? 'active' : 'hidden';
  try{
    const { db, doc, updateDoc, serverTimestamp } = window._fb;
    await updateDoc(doc(db, 'products', id), { visibility: newVis, updatedAt: serverTimestamp() });
    showToast(`Product ${newVis === 'active' ? 'shown' : 'hidden'}`, 'success');
  }catch(err){
    showToast('Failed: ' + err.message, 'error');
  }
}
window.toggleProductVisibility = toggleProductVisibility;

async function deleteProduct(id){
  if(!confirm('Delete this product permanently? This cannot be undone.')) return;
  try{
    const { db, doc, deleteDoc } = window._fb;
    await deleteDoc(doc(db, 'products', id));
    showToast('Product deleted', 'success');
  }catch(err){
    showToast('Failed to delete: ' + err.message, 'error');
  }
}
window.deleteProduct = deleteProduct;

/* ---------------- ORDERS: LISTENER + RENDER ---------------- */
function initOrdersListener(){
  const { onSnapshot, collection, query, orderBy, db } = window._fb;
  try{
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
    unsubOrders = onSnapshot(q, (snap) => {
      allOrders = [];
      snap.forEach(d => allOrders.push({ id: d.id, ...d.data() }));
      renderOrdersTable();
      refreshStats();
    }, (err) => {
      console.error('Orders listener error:', err);
      showToast('Failed to load orders: ' + err.message, 'error');
    });
  }catch(e){ console.error(e); }
}

function renderOrdersTable(){
  const searchVal = ($('orderSearch')?.value || '').toLowerCase();
  const statusVal = $('orderStatusFilter')?.value || '';
  const filtered = allOrders.filter(o => {
    const matchSearch = (o.orderId||o.id||'').toLowerCase().includes(searchVal) ||
                         (o.customerName||'').toLowerCase().includes(searchVal);
    const matchStatus = !statusVal || o.orderStatus === statusVal;
    return matchSearch && matchStatus;
  });
  const body = $('ordersTableBody');
  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--gray-500);padding:40px;">No orders found</td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(o => `
    <tr>
      <td style="font-weight:600;">#${escapeHtml(o.orderId||o.id)}</td>
      <td>${escapeHtml(o.customerName||'—')}</td>
      <td>${fmtDate(o.createdAt)}</td>
      <td style="font-weight:600;">${fmtMoney(o.finalTotal)}</td>
      <td>${escapeHtml(o.paymentMethod||'—')}<br><span class="badge badge-${(o.paymentStatus||'unpaid').toLowerCase()}" style="margin-top:4px;">${escapeHtml(o.paymentStatus||'Unpaid')}</span></td>
      <td><span class="badge badge-${(o.orderStatus||'pending').toLowerCase()}">${escapeHtml(o.orderStatus||'Pending')}</span>
        ${o.returnStatus ? `<br><span class="badge badge-${o.returnStatus==='Approved'?'delivered':(o.returnStatus==='Rejected'?'cancelled':'pending')}" style="margin-top:4px;">Return: ${escapeHtml(o.returnStatus)}</span>` : ''}
      </td>
      <td><button class="btn btn-outline btn-sm" onclick="openOrderModal('${o.id}')">View</button></td>
    </tr>
  `).join('');
}
window.renderOrdersTable = renderOrdersTable;

function openOrderModal(orderId){
  const o = allOrders.find(x => x.id === orderId);
  if(!o){ showToast('Order not found', 'error'); return; }

  const itemsHtml = (o.products || []).map(item => `
    <div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--gray-100);">
      <img src="${escapeHtml(item.image||'')}" style="width:56px;height:56px;border-radius:8px;object-fit:cover;background:var(--gray-100);" onerror="this.style.opacity=0.3">
      <div style="flex:1;">
        <div style="font-weight:600;">${escapeHtml(item.name)}</div>
        <div style="color:var(--gray-500);font-size:12px;">Size: ${escapeHtml(item.size||'—')} · Color: ${escapeHtml(item.color||'—')} · Qty: ${item.quantity}</div>
      </div>
      <div style="font-weight:600;">${fmtMoney(item.price * item.quantity)}</div>
    </div>
  `).join('');

  $('orderModalBody').innerHTML = `
    <div class="form-section">
      <div class="form-section-title">Customer</div>
      <div class="form-grid">
        <div><strong>Name:</strong> ${escapeHtml(o.customerName)}</div>
        <div><strong>Email:</strong> ${escapeHtml(o.customerEmail)}</div>
        <div><strong>Phone:</strong> ${escapeHtml(o.customerPhone)}</div>
        <div><strong>Address:</strong> ${escapeHtml(o.address)}, ${escapeHtml(o.city)}, ${escapeHtml(o.state)} - ${escapeHtml(o.pincode)}</div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Products</div>
      ${itemsHtml}
    </div>
    <div class="form-section">
      <div class="form-section-title">Payment</div>
      <div class="form-grid">
        <div><strong>Subtotal:</strong> ${fmtMoney(o.subtotal)}</div>
        <div><strong>Discount:</strong> ${fmtMoney(o.discount||0)}</div>
        <div><strong>Final Total:</strong> ${fmtMoney(o.finalTotal)}</div>
        <div><strong>Method:</strong> ${escapeHtml(o.paymentMethod)}</div>
        <div><strong>Payment Status:</strong> <span class="badge badge-${(o.paymentStatus||'unpaid').toLowerCase()}">${escapeHtml(o.paymentStatus)}</span></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Order Status</div>
      <select id="orderStatusSelect">
        ${['Pending','Confirmed','Processing','Shipped','Delivered','Cancelled'].map(s =>
          `<option value="${s}" ${o.orderStatus===s?'selected':''}>${s}</option>`
        ).join('')}
      </select>
      <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="updateOrderStatus('${o.id}')">Update Status</button>
    </div>
    ${o.returnStatus ? `
    <div class="form-section">
      <div class="form-section-title">Return / Refund Request</div>
      <div style="background:var(--gray-50);border-radius:10px;padding:14px;margin-bottom:12px;">
        <div style="font-size:12px;color:var(--gray-500);margin-bottom:6px;">Customer's reason:</div>
        <div style="font-size:13.5px;">${escapeHtml(o.returnReason||'—')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="font-size:13px;font-weight:600;">Current status:</span>
        <span class="badge badge-${o.returnStatus==='Approved'?'delivered':(o.returnStatus==='Rejected'?'cancelled':'pending')}">${escapeHtml(o.returnStatus)}</span>
      </div>
      ${o.returnStatus === 'Requested' ? `
        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary btn-sm" style="flex:1;background:var(--success);" onclick="resolveReturn('${o.id}','Approved')">Approve Return</button>
          <button class="btn btn-danger btn-sm" style="flex:1;" onclick="resolveReturn('${o.id}','Rejected')">Reject Return</button>
        </div>
      ` : ''}
    </div>` : ''}
  `;
  $('orderModalOverlay').classList.add('active');
}
window.openOrderModal = openOrderModal;

function closeOrderModal(){
  $('orderModalOverlay').classList.remove('active');
}
window.closeOrderModal = closeOrderModal;

async function updateOrderStatus(orderId){
  const newStatus = $('orderStatusSelect').value;
  try{
    const { db, doc, updateDoc, serverTimestamp } = window._fb;
    await updateDoc(doc(db, 'orders', orderId), { orderStatus: newStatus, updatedAt: serverTimestamp() });
    showToast('Order status updated', 'success');
    closeOrderModal();
  }catch(err){
    showToast('Failed to update: ' + err.message, 'error');
  }
}
window.updateOrderStatus = updateOrderStatus;

async function resolveReturn(orderId, decision){
  if(!confirm(`Mark this return as ${decision}?`)) return;
  try{
    const { db, doc, updateDoc, serverTimestamp } = window._fb;
    await updateDoc(doc(db, 'orders', orderId), {
      returnStatus: decision,
      returnResolvedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    showToast(`Return ${decision.toLowerCase()}`, 'success');
    closeOrderModal();
  }catch(err){
    showToast('Failed to update return: ' + err.message, 'error');
  }
}
window.resolveReturn = resolveReturn;

/* ---------------- SETTINGS ---------------- */
async function loadSettings(){
  try{
    const { db, doc, getDoc } = window._fb;
    const snap = await getDoc(doc(db, 'config', 'store'));
    if(snap.exists()){
      const data = snap.data();
      $('notifyEmail').value = data.notifyEmail || '';
      $('storeName').value = data.storeName || 'Testing T-Shirt';
      $('storeCurrency').value = data.currency || CURRENCY;
    }
  }catch(e){ console.error('Settings load failed:', e); }
}

async function saveSettings(){
  try{
    const { db, doc, setDoc } = window._fb;
    await setDoc(doc(db, 'config', 'store'), {
      notifyEmail: $('notifyEmail').value.trim(),
      storeName: $('storeName').value.trim(),
      currency: $('storeCurrency').value.trim() || CURRENCY
    }, { merge: true });
    showToast('Settings saved', 'success');
  }catch(err){
    showToast('Failed to save settings: ' + err.message, 'error');
  }
}
window.saveSettings = saveSettings;

/* ---------------- INIT ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  // Wait a tick for the module script to attach window._fb
  const waitForFb = setInterval(() => {
    if(window._fb){
      clearInterval(waitForFb);
      initAuthListener();
    }
  }, 50);
});