// app.js - Core application logic

// --- Firebase Configuration ---
// REPLACE THESE PLACEHOLDERS WITH YOUR ACTUAL FIREBASE CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyBy9A21IJUv8qVKUD91KHanj1CSkVdKJvU",
  authDomain: "warehouse-stock-app-b9e92.firebaseapp.com",
  projectId: "warehouse-stock-app-b9e92",
  storageBucket: "warehouse-stock-app-b9e92.firebasestorage.app",
  messagingSenderId: "699350588129",
  appId: "1:699350588129:web:3d4bc2f5b126f29233f5a0",
  measurementId: "G-XN0YDYE40Q"
};

// Initialize Firebase
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();
let storage = null;
try {
  storage = firebase.storage();
} catch (e) {
  console.warn("Storage not initialized: ", e);
}

// Photo Upload Helper
async function uploadPhoto(file, path) {
  if (!storage) throw new Error("Storage not configured");
  const ref = storage.ref(path + '/' + Date.now() + '_' + file.name);
  await ref.put(file);
  return await ref.getDownloadURL();
}

// Enable offline persistence
db.enablePersistence()
  .catch((err) => {
    if (err.code == 'failed-precondition') {
      console.warn("Multiple tabs open, persistence can only be enabled in one tab at a a time.");
    } else if (err.code == 'unimplemented') {
      console.warn("The current browser does not support all of the features required to enable persistence.");
    }
  });


// State Management
const STATE = {
  currentUser: null,
  currentScreen: 'screen-login',
  selectedItem: null, // Currently viewing item
  editingCountId: null,
  currentLiveBalance: 0
};

// --- Service Worker Registration ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(registration => {
        console.log('ServiceWorker registration successful with scope: ', registration.scope);
      }, err => {
        console.log('ServiceWorker registration failed: ', err);
      });
  });
}

// --- Barcode Scanner Logic ---
let html5QrcodeScanner = null;

function onScanSuccess(decodedText, decodedResult) {
  document.getElementById('search-input').value = decodedText;
  document.getElementById('scanner-modal').style.display = 'none';
  if (html5QrcodeScanner) {
    html5QrcodeScanner.clear();
  }
  showToast("Barcode scanned!");
  
  // performSearch might not be hoisted depending on scope, check for elements
  const q = decodedText.trim();
  if (q.length >= 2) {
      document.getElementById('search-input').dispatchEvent(new Event('input'));
  }
}

function startScanner() {
  document.getElementById('scanner-modal').style.display = 'flex';
  html5QrcodeScanner = new Html5QrcodeScanner(
    "qr-reader", { fps: 10, qrbox: 250 }, false);
  html5QrcodeScanner.render(onScanSuccess);
}

document.addEventListener('DOMContentLoaded', () => {
  const btnScan = document.getElementById('btn-scan-barcode');
  if (btnScan) {
    btnScan.addEventListener('click', startScanner);
  }
  const btnCloseScan = document.getElementById('btn-close-scanner');
  if (btnCloseScan) {
    btnCloseScan.addEventListener('click', () => {
      document.getElementById('scanner-modal').style.display = 'none';
      if (html5QrcodeScanner) html5QrcodeScanner.clear();
    });
  }
});

function clearAllData() {
  return new Promise(async (resolve, reject) => {
    try {
      // Deleting a collection from a Web client is NOT recommended by Firebase 
      // because it has negative performance and security implications.
      // However, for this admin function, we manually fetch and delete all documents.
      const sysQuery = await db.collection('systemStock').get();
      const cntQuery = await db.collection('countedStock').get();
      const txQuery  = await db.collection('inventoryTransactions').get();

      const batch = db.batch();
      sysQuery.docs.forEach(doc => batch.delete(doc.ref));
      cntQuery.docs.forEach(doc => batch.delete(doc.ref));
      txQuery.docs.forEach(doc => batch.delete(doc.ref));

      await batch.commit();
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

// System Stock Utilities
async function addSystemStockList(items) {
  try {
    // Note: In a real app with 10k+ items, you should batch these writes 
    // or use a backend function. For this demo, we do individual sets.
    const batch = db.batch();

    // First, clear existing (Optional, depends on business logic if upload replaces or appends)
    const existing = await db.collection('systemStock').get();
    existing.docs.forEach(doc => batch.delete(doc.ref));

    // Commit delete
    await batch.commit();

    // Create new batch for adding
    const addBatch = db.batch();
    items.forEach(item => {
      const itemCode = (item['Item Code'] || '').toString().trim();
      if (itemCode) {
        const docRef = db.collection('systemStock').doc(itemCode);
        addBatch.set(docRef, {
          stockDate: item['Stock Date'] || '',
          itemCode: itemCode,
          itemDesc: item['Item Description'] || '',
          sysQty: parseFloat(item['System Stock Qty']) || 0
        });
      }
    });
    await addBatch.commit();
  } catch (e) {
    throw e;
  }
}

async function searchSystemStock(query) {
  const q = query.toLowerCase();
  // Firestore doesn't have great native text search for substring (e.g. LIKE "%query%").
  // So we fetch all and filter client-side for this small-scale app.
  const snapshot = await db.collection('systemStock').get();
  const results = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    const code = data.itemCode.toLowerCase();
    const desc = data.itemDesc.toLowerCase();

    // Match if it includes the query OR if the item code ends with the query
    if (code.includes(q) || desc.includes(q) || code.endsWith(q)) {
      results.push(data);
    }
  });
  return results;
}

async function getSystemItem(itemCode) {
  const doc = await db.collection('systemStock').doc(itemCode).get();
  if (doc.exists) {
    return doc.data();
  }
  return null;
}

// --- Transaction (IN/OUT) Utilities ---
async function addTransaction(itemCode, type, location, qty, addedBy, itemDesc = '', comments = '', photoUrl = '') {
  try {
    const entry = {
      itemCode,
      type, // 'IN' or 'OUT'
      location,
      qty: parseFloat(qty),
      user: addedBy,
      date: new Date().toISOString(),
      itemDesc: itemDesc,
      comments: comments,
      photoUrl: photoUrl || null
    };
    await db.collection('inventoryTransactions').add(entry);
    return entry;
  } catch (e) {
    throw e;
  }
}

async function getItemTransactions(itemCode) {
  const snapshot = await db.collection('inventoryTransactions')
    .where('itemCode', '==', itemCode)
    .get();

  let results = [];
  snapshot.forEach(doc => {
    let data = doc.data();
    data.id = doc.id;
    results.push(data);
  });
  results.sort((a, b) => new Date(b.date) - new Date(a.date));
  return results;
}

// Counted Stock Utilities
async function addCountEntry(itemCode, location, qty, addedBy, isNewSystemItem = false, itemDesc = '', comments = '', photoUrl = '') {
  try {
    const entry = {
      itemCode,
      location,
      qty: parseFloat(qty),
      user: addedBy,
      date: new Date().toISOString(),
      isNew: isNewSystemItem,
      itemDesc: itemDesc,
      comments: comments,
      photoUrl: photoUrl || null
    };

    await db.collection('countedStock').add(entry);
    return entry;
  } catch (e) {
    throw e;
  }
}

async function getItemCountHistory(itemCode) {
  const snapshot = await db.collection('countedStock')
    .where('itemCode', '==', itemCode)
    .get();

  let results = [];
  snapshot.forEach(doc => {
    let data = doc.data();
    data.id = doc.id;
    results.push(data);
  });

  // Sort client-side to avoid requiring a composite index in Firestore
  results.sort((a, b) => new Date(b.date) - new Date(a.date));
  return results;
}

// For generating the final report. We need to aggregate counts per itemCode
async function getFullReportData() {
  const sysSnapshot = await db.collection('systemStock').get();
  const cntSnapshot = await db.collection('countedStock').get();

  let sysItems = {};
  let reportMap = {};

  sysSnapshot.forEach(doc => {
    const item = doc.data();
    sysItems[item.itemCode] = item;

    reportMap[item.itemCode] = {
      ItemCode: item.itemCode,
      ItemDescription: item.itemDesc,
      SystemStock: item.sysQty,
      TotalPhysicalStock: 0,
      Difference: -item.sysQty,
      CountedBy: new Set(),
      LocationsCounted: new Set(),
      DateAndTime: [],
      AllComments: []
    };
  });

  cntSnapshot.forEach(doc => {
    const c = doc.data();
    if (!reportMap[c.itemCode]) {
      // Unlisted item
      reportMap[c.itemCode] = {
        ItemCode: c.itemCode + " (NOT IN SYS)",
        ItemDescription: c.itemDesc || "N/A",
        SystemStock: 0,
        TotalPhysicalStock: 0,
        Difference: 0,
        CountedBy: new Set(),
        LocationsCounted: new Set(),
        DateAndTime: [],
        AllComments: []
      };
    }
    let rm = reportMap[c.itemCode];
    rm.TotalPhysicalStock += c.qty;
    rm.Difference = rm.TotalPhysicalStock - rm.SystemStock;
    rm.CountedBy.add(c.user);
    rm.LocationsCounted.add(c.location);
    rm.DateAndTime.push(new Date(c.date).toLocaleString());
    if (c.comments && c.comments.trim() !== '') {
      rm.AllComments.push(c.comments);
    }
  });

  // Format for CSV
  return Object.values(reportMap).map(row => ({
    'Item Code': row.ItemCode,
    'Description': row.ItemDescription,
    'System Qty': row.SystemStock,
    'Physical Qty': row.TotalPhysicalStock,
    'Difference': row.Difference,
    'Counter Name': Array.from(row.CountedBy).join(', '),
    'Locations Counted': Array.from(row.LocationsCounted).join(', '),
    'Date and Time': row.DateAndTime.join(' | '),
    'Comments': row.AllComments.join(' | ')
  }));
}

async function exportReport() {
  const data = await getFullReportData();
  console.log("Export Data:", data);
  if (!data || data.length === 0) {
    console.log("Debug: Data is empty for the report.");
    showToast('No data to report!');
    return;
  }
  const csv = Papa.unparse(data);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", `Stock_Report_${new Date().toISOString().slice(0, 10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// User-wise Report logic
async function exportUserReport() {
  const cntSnapshot = await db.collection('countedStock').get();

  // Also get system items just for descriptions if available
  const sysSnapshot = await db.collection('systemStock').get();
  let sysItems = {};
  sysSnapshot.forEach(doc => {
    sysItems[doc.id] = doc.data();
  });

  let reportData = [];

  cntSnapshot.forEach(doc => {
    const c = doc.data();
    reportData.push({
      'Counter Name': c.user || 'Unknown',
      'Item Code': c.itemCode,
      'Item Description': c.itemDesc || (sysItems[c.itemCode] ? sysItems[c.itemCode].itemDesc : 'N/A'),
      'Location Counted': c.location,
      'Quantity Found': c.qty,
      'Comments': c.comments || '',
      'Date and Time': new Date(c.date).toLocaleString(),
      'Is Unlisted': c.isNew ? 'Yes' : 'No'
    });
  });

  if (reportData.length === 0) {
    showToast('No user count data available!');
    return;
  }

  // Sort by user name, then by Date
  reportData.sort((a, b) => {
    if (a['Counter Name'] < b['Counter Name']) return -1;
    if (a['Counter Name'] > b['Counter Name']) return 1;
    return new Date(b['Date and Time']) - new Date(a['Date and Time']);
  });

  const csv = Papa.unparse(reportData);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", `User_Detailed_Report_${new Date().toISOString().slice(0, 10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function exportTransactionReport() {
  const txSnapshot = await db.collection('inventoryTransactions').get();
  const sysSnapshot = await db.collection('systemStock').get();
  let sysItems = {};
  sysSnapshot.forEach(doc => { sysItems[doc.id] = doc.data(); });

  let reportData = [];
  txSnapshot.forEach(doc => {
    const t = doc.data();
    reportData.push({
      'Date and Time': new Date(t.date).toLocaleString(),
      'User': t.user || 'Unknown',
      'Item Code': t.itemCode,
      'Item Description': t.itemDesc || (sysItems[t.itemCode] ? sysItems[t.itemCode].itemDesc : 'N/A'),
      'Type': t.type,
      'Location': t.location,
      'Quantity': t.qty,
      'Comments': t.comments || ''
    });
  });

  if (reportData.length === 0) {
    showToast('No transactions data available!');
    return;
  }

  reportData.sort((a, b) => new Date(b['Date and Time']) - new Date(a['Date and Time']));

  const csv = Papa.unparse(reportData);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", `Transactions_Report_${new Date().toISOString().slice(0, 10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- UI Navigation ---
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  STATE.currentScreen = screenId;

  if (screenId === 'screen-admin') {
    if (typeof renderAdminCharts === 'function') {
      renderAdminCharts().catch(console.error);
    }
  }

  const appBar = document.getElementById('app-bar');
  const btnBack = document.getElementById('btn-back');

  if (screenId === 'screen-login') {
    appBar.style.display = 'none';
  } else {
    appBar.style.display = 'flex';
    document.getElementById('header-user-info').textContent = `User: ${STATE.currentUser}`;

    if (screenId === 'screen-count' || screenId === 'screen-add-item') {
      btnBack.style.display = 'block';
    } else {
      btnBack.style.display = 'none';
    }
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', async () => {
  // Database gets initialized globally synchronously now with Firebase

  // App Bar Setup
  document.getElementById('btn-logout').addEventListener('click', () => {
    STATE.currentUser = null;
    showScreen('screen-login');
  });

  document.getElementById('btn-back').addEventListener('click', () => {
    if (STATE.currentUserRole === 'admin' || STATE.currentUser === 'admin' || STATE.currentUser === 'pramit') {
      showScreen('screen-admin');
    } else {
      showScreen('screen-user');
    }
  });

  // Application User Management Init
  const DEFAULT_ADMIN = 'pramit';
  const DEFAULT_ADMIN_PASS = 'Pmxyz@251983';

  // Initialize Admin user if appUsers collection is empty
  async function initAppUsers() {
    try {
      const snap = await db.collection('appUsers').limit(1).get();
      if (snap.empty) {
        await db.collection('appUsers').doc(DEFAULT_ADMIN).set({
          pass: DEFAULT_ADMIN_PASS,
          role: 'admin'
        });
        console.log("Initialized default admin user");
      }
    } catch(err) {
      console.log("Error initializing users: ", err);
    }
  }

  // Call initialization
  initAppUsers();

  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('login-id').value.trim().toLowerCase();
    const pass = document.getElementById('login-pass').value.trim();

    if (id && pass) {
      try {
        const userDoc = await db.collection('appUsers').doc(id).get();
        if (userDoc.exists && userDoc.data().pass === pass) {
          const role = userDoc.data().role;
          STATE.currentUser = id;
          STATE.currentUserRole = role; // Store role
          
          document.getElementById('login-id').value = '';
          document.getElementById('login-pass').value = '';

          if (role === 'admin') {
            showScreen('screen-admin');
            await loadManageUsersList();
          } else {
            showScreen('screen-user');
          }
          showToast(`Logged in as ${id}`);
        } else {
          showToast('Invalid ID or Password!');
        }
      } catch (err) {
         showToast('Error logging in. Check connection.');
         console.error(err);
      }
    }
  });

  // --- Admin User Management Events ---
  const formAddUser = document.getElementById('form-add-user');
  if (formAddUser) {
    formAddUser.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newId = document.getElementById('new-user-id').value.trim().toLowerCase();
      const newPass = document.getElementById('new-user-pass').value.trim();
      const role = document.getElementById('new-user-role').value;

      if (!newId || !newPass) return;

      try {
        await db.collection('appUsers').doc(newId).set({
          pass: newPass,
          role: role
        });
        showToast('User saved successfully');
        document.getElementById('new-user-id').value = '';
        document.getElementById('new-user-pass').value = '';
        await loadManageUsersList();
      } catch (err) {
        showToast('Error saving user');
        console.error(err);
      }
    });
  }

  async function loadManageUsersList() {
    const listEl = document.getElementById('users-list');
    if (!listEl) return;
    
    listEl.innerHTML = '<p style="text-align:center;color:gray;font-size:14px;">Loading users...</p>';
    
    try {
      const snap = await db.collection('appUsers').get();
      listEl.innerHTML = '';
      
      let usersHTML = '';
      snap.forEach(doc => {
        const u = doc.data();
        const uid = doc.id;
        usersHTML += `
          <div class="list-item" style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #eee;">
            <div>
              <div class="item-primary">${uid} <span class="badge" style="font-size: 10px; background: ${u.role==='admin'?'#E64A19':'#1976D2'};">${u.role.toUpperCase()}</span></div>
              <div class="item-secondary">Password: ${uid === 'pramit' ? '********' : u.pass}</div>
            </div>
            <div>
              ${uid !== 'pramit' ? `<button class="icon-btn delete-user-btn" data-uid="${uid}" style="color: #D32F2F;"><i class="material-icons">delete</i></button>` : '<span style="color:gray; font-size:12px;">Protected</span>'}
            </div>
          </div>
        `;
      });
      listEl.innerHTML = usersHTML;

      // Attach delete listeners
      const deleteBtns = listEl.querySelectorAll('.delete-user-btn');
      deleteBtns.forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const uid = e.currentTarget.getAttribute('data-uid');
          if (uid === 'pramit') return; // Double protection
          if (confirm(`Are you sure you want to delete user: ${uid}?`)) {
            try {
              await db.collection('appUsers').doc(uid).delete();
              showToast('User deleted');
              await loadManageUsersList();
            } catch (err) {
              showToast('Error deleting user');
            }
          }
        });
      });

    } catch (err) {
      listEl.innerHTML = '<p style="text-align:center;color:#D32F2F;font-size:14px;">Failed to load users</p>';
      console.error(err);
    }
  }

  // -- Admin Events --
  const fileUpload = document.getElementById('file-upload');
  fileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async function (results) {
        if (results.data && results.data.length > 0) {
          try {
            await addSystemStockList(results.data);
            showToast(`Imported ${results.data.length} items successfully`);
            fileUpload.value = ''; // reset
          } catch (err) {
            alert("Error saving stock data: " + err);
          }
        }
      }
    });
  });

  document.getElementById('btn-generate-report').addEventListener('click', exportReport);
  document.getElementById('btn-generate-user-report').addEventListener('click', exportUserReport);
  document.getElementById('btn-export-transactions').addEventListener('click', exportTransactionReport);

  document.getElementById('btn-clear-db').addEventListener('click', async () => {
    if (confirm("Are you sure? This deletes ALL system and count data!")) {
      await clearAllData();
      showToast("Database wiped clean.");
    }
  });

  // -- User Events (Search) --
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const notFoundAction = document.getElementById('not-found-action');

  async function performSearch() {
    const q = searchInput.value.trim();
    searchResults.innerHTML = '';

    if (q.length < 2) {
      notFoundAction.style.display = 'none';
      return;
    }

    const res = await searchSystemStock(q);

    if (res.length === 0) {
      notFoundAction.style.display = 'block';
    } else {
      notFoundAction.style.display = 'none';
      res.slice(0, 15).forEach(item => { // Limit to 15 results for performance
        const el = document.createElement('div');
        el.className = 'list-item';
        
        const isLow = (item.sysQty || 0) <= 0;
        const alertBadge = isLow ? `<span class="badge" style="background:#D32F2F; margin-left:10px;">Low/Out</span>` : '';
        
        el.innerHTML = `
           <div>
             <div class="item-primary">${item.itemCode} ${alertBadge}</div>
             <div class="item-secondary">${item.itemDesc} (Sys Qty: ${item.sysQty || 0})</div>
           </div>
           <div>
              <i class="material-icons" style="color:#1976D2;">chevron_right</i>
           </div>
         `;
        if (isLow) el.style.borderLeft = "4px solid #D32F2F";
        el.addEventListener('click', () => openCountScreen(item));
        searchResults.appendChild(el);
      });
    }
  }

  searchInput.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') performSearch();
  });
  searchInput.addEventListener('input', () => {
    // optional debounce here if list is huge
    performSearch();
  });

  document.getElementById('btn-clear-search').addEventListener('click', () => {
    searchInput.value = '';
    searchResults.innerHTML = '';
    notFoundAction.style.display = 'none';
    searchInput.focus();
  });

  document.getElementById('btn-goto-add').addEventListener('click', () => {
    document.getElementById('new-item-code').value = searchInput.value;
    showScreen('screen-add-item');
  });

  // -- Count Detail Screen --
  function resetEditForm() {
    STATE.editingCountId = null;
    document.getElementById('count-location').value = '';
    document.getElementById('count-qty').value = '';
    document.getElementById('count-comments').value = '';
    document.getElementById('form-count-title').textContent = 'Add Count Entry';
    document.getElementById('btn-save-count').textContent = 'SAVE COUNT';
    document.getElementById('btn-cancel-edit').style.display = 'none';
  }

  function startEditCount(id, location, qty, comments) {
    STATE.editingCountId = id;
    document.getElementById('count-location').value = location;
    document.getElementById('count-qty').value = qty;
    document.getElementById('count-comments').value = comments || '';
    document.getElementById('form-count-title').textContent = 'Edit Count Entry';
    document.getElementById('btn-save-count').textContent = 'UPDATE COUNT';
    document.getElementById('btn-cancel-edit').style.display = 'block';

    // Scroll smoothly to form
    document.getElementById('form-add-count').scrollIntoView({ behavior: 'smooth' });
  }

  async function openCountScreen(item) {
    STATE.selectedItem = item;
    document.getElementById('detail-item-code').textContent = item.itemCode;
    document.getElementById('detail-item-desc').textContent = item.itemDesc;

    resetEditForm();

    // Reset Tabs
    document.getElementById('tab-btn-live').click();

    await refreshTransactionStats();
    await refreshCountStats();
    showScreen('screen-count');
  }

  async function refreshTransactionStats() {
    const itemCode = STATE.selectedItem.itemCode;
    const sysQty = STATE.selectedItem.sysQty || 0;

    const txs = await getItemTransactions(itemCode);
    
    let totalIn = 0;
    let totalOut = 0;
    let locBalances = {};

    const txList = document.getElementById('transaction-history-list');
    txList.innerHTML = '';

    txs.forEach(tx => {
      if (tx.type === 'IN') totalIn += tx.qty;
      else if (tx.type === 'OUT') totalOut += tx.qty;
      
      if (!locBalances[tx.location]) locBalances[tx.location] = 0;
      if (tx.type === 'IN') locBalances[tx.location] += tx.qty;
      else if (tx.type === 'OUT') locBalances[tx.location] -= tx.qty;

      const el = document.createElement('div');
      el.className = 'list-item history-item';
      let time = new Date(tx.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      let color = tx.type === 'IN' ? '#4CAF50' : '#E64A19';
      el.innerHTML = `
          <div style="flex: 1;">
            <div class="loc">${tx.type} @ ${tx.location}</div>
            <div style="font-size:12px;color:gray;">${time} | By ${tx.user}</div>
            ${tx.comments ? `<div style="font-size:12px; color:gray; margin-top:2px;">💬 ${tx.comments}</div>` : ''}
            ${tx.photoUrl ? `<a href="${tx.photoUrl}" target="_blank" style="font-size:12px; color:#1976D2; display:block; margin-top:2px;">📷 View Photo</a>` : ''}
         </div>
         <div class="qty" style="color: ${color}; font-weight: bold; margin-right: 15px;">
            ${tx.type === 'IN' ? '+' : '-'}${tx.qty}
         </div>
      `;
      txList.appendChild(el);
    });

    if (txs.length === 0) {
      txList.innerHTML = '<p style="text-align:center;color:gray;font-size:14px;">No transactions yet</p>';
    }

    const locList = document.getElementById('location-balance-list');
    locList.innerHTML = '';
    let hasLocs = false;
    for (let loc in locBalances) {
      if (locBalances[loc] !== 0) {
        hasLocs = true;
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.padding = '8px 0';
        div.style.borderBottom = '1px solid #eee';
        div.innerHTML = `<span><strong>${loc}</strong></span> <span class="qty">${locBalances[loc]}</span>`;
        locList.appendChild(div);
      }
    }
    if (!hasLocs) {
      locList.innerHTML = '<p style="text-align:center;color:gray;font-size:14px; margin: 5px;">No inventory in locations</p>';
    }

    const liveBalance = sysQty + totalIn - totalOut;
    STATE.currentLiveBalance = liveBalance;

    document.getElementById('live-sys-qty').textContent = sysQty;
    document.getElementById('live-in-qty').textContent = totalIn;
    document.getElementById('live-out-qty').textContent = totalOut;
    document.getElementById('live-balance-qty').textContent = liveBalance;
    document.getElementById('count-live-qty').textContent = liveBalance;
  }

  async function refreshCountStats() {
    const itemCode = STATE.selectedItem.itemCode;
    const liveBalance = STATE.currentLiveBalance || 0;

    const history = await getItemCountHistory(itemCode);

    let totalPhys = 0;
    const historyList = document.getElementById('count-history-list');
    historyList.innerHTML = '';

    history.forEach(h => {
      totalPhys += h.qty;
      const el = document.createElement('div');
      el.className = 'list-item history-item';
      let time = new Date(h.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `
          <div style="flex: 1;">
            <div class="loc">${h.location}</div>
            <div style="font-size:12px;color:gray;">${time} | By ${h.user}</div>
            ${h.comments ? `<div style="font-size:12px; color:#E64A19; margin-top:2px;">💬 ${h.comments}</div>` : ''}
            ${h.photoUrl ? `<a href="${h.photoUrl}" target="_blank" style="font-size:12px; color:#1976D2; display:block; margin-top:2px;">📷 View Photo</a>` : ''}
         </div>
         <div class="qty" style="margin-right: 15px;">${h.qty}</div>
         <div style="display: flex; flex-direction: column; gap: 5px;">
           <button class="icon-btn edit-btn" style="padding: 5px;" title="Edit Location/Qty">
              <i class="material-icons" style="font-size: 20px; color: #1976D2;">edit</i>
           </button>
           <button class="icon-btn change-item-btn" style="padding: 5px;" title="Change Item Code">
              <i class="material-icons" style="font-size: 20px; color: #E64A19;">swap_horiz</i>
           </button>
           <button class="icon-btn delete-btn" style="padding: 5px;" title="Delete Entry">
              <i class="material-icons" style="font-size: 20px; color: #D32F2F;">delete</i>
           </button>
         </div>
       `;
      el.querySelector('.edit-btn').addEventListener('click', () => {
        startEditCount(h.id, h.location, h.qty, h.comments);
      });
      el.querySelector('.change-item-btn').addEventListener('click', () => {
        changeItemCodeForCount(h.id, h.itemCode);
      });
      el.querySelector('.delete-btn').addEventListener('click', () => {
        deleteCountEntry(h.id);
      });
      historyList.appendChild(el);
    });

    if (history.length === 0) {
      historyList.innerHTML = '<p style="text-align:center;color:gray;font-size:14px;">No counts yet</p>';
    }

    const diff = totalPhys - liveBalance;

    document.getElementById('detail-phys-qty-tab').textContent = totalPhys;
    const diffEl = document.getElementById('detail-diff-qty-tab');
    const diffBox = document.getElementById('detail-diff-box-tab');

    diffEl.textContent = (diff > 0 ? '+' : '') + diff;

    diffBox.className = 'stat-box'; // reset
    diffBox.style.border = '';
    diffBox.style.background = '';
    
    if (diff > 0) {
       diffBox.classList.add('diff-positive');
    } else if (diff < 0) {
       diffBox.classList.add('diff-negative');
       // Highlight high variance (> 10% or > 5 items diff)
       const sysQty = STATE.selectedItem.sysQty || 0;
       if (Math.abs(diff) >= 5 || Math.abs(diff) >= (sysQty * 0.1)) {
         diffBox.style.border = '2px solid #D32F2F';
         diffBox.style.background = '#ffebee';
       }
    }
  }

  async function deleteCountEntry(countId) {
    if (confirm("Are you sure you want to delete this count entry?")) {
      try {
        await db.collection('countedStock').doc(countId).delete();
        showToast("Count entry deleted.");
        await refreshCountStats();
      } catch (err) {
        alert("Error deleting entry!");
        console.error(err);
      }
    }
  }

  async function changeItemCodeForCount(countId, currentCode) {
    const newCode = prompt(`Enter the CORRECT Item Code to move this count to:\n(Current: ${currentCode})`);
    if (newCode && newCode.trim() !== '' && newCode.trim() !== currentCode) {
      if (confirm(`Move this count from ${currentCode} to ${newCode.trim()}?`)) {
        try {
          await db.collection('countedStock').doc(countId).update({
            itemCode: newCode.trim()
          });
          showToast(`Moved to ${newCode.trim()}`);
          await refreshCountStats();
        } catch (err) {
          alert("Error moving entry!");
          console.error(err);
        }
      }
    }
  }

  document.getElementById('tab-btn-live').addEventListener('click', () => {
    document.getElementById('tab-btn-live').classList.add('active');
    document.getElementById('tab-btn-live').style.background = '#1976D2';
    document.getElementById('tab-btn-live').style.color = 'white';
    document.getElementById('tab-btn-count').classList.remove('active');
    document.getElementById('tab-btn-count').style.background = '#e0e0e0';
    document.getElementById('tab-btn-count').style.color = '#333';
    document.getElementById('tab-content-live').style.display = 'block';
    document.getElementById('tab-content-count').style.display = 'none';
  });

  document.getElementById('tab-btn-count').addEventListener('click', () => {
    document.getElementById('tab-btn-count').classList.add('active');
    document.getElementById('tab-btn-count').style.background = '#1976D2';
    document.getElementById('tab-btn-count').style.color = 'white';
    document.getElementById('tab-btn-live').classList.remove('active');
    document.getElementById('tab-btn-live').style.background = '#e0e0e0';
    document.getElementById('tab-btn-live').style.color = '#333';
    document.getElementById('tab-content-live').style.display = 'none';
    document.getElementById('tab-content-count').style.display = 'block';
  });

  document.getElementById('form-transaction').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('trans-type').value;
    const locEl = document.getElementById('trans-location');
    const loc = locEl.value.trim();
    const qty = document.getElementById('trans-qty').value;
    const comments = document.getElementById('trans-comments').value.trim();
    const stickyLoc = document.getElementById('sticky-trans-loc').checked;
    
    const photoInput = document.getElementById('trans-photo');
    let photoUrl = '';

    if (!loc || qty === '') return;

    try {
      if (photoInput.files && photoInput.files.length > 0) {
        showToast('Uploading photo...');
        photoUrl = await uploadPhoto(photoInput.files[0], 'transactions/' + STATE.selectedItem.itemCode);
      }

      await addTransaction(STATE.selectedItem.itemCode, type, loc, qty, STATE.currentUser, STATE.selectedItem.itemDesc, comments, photoUrl);
      showToast(`${type} transaction saved: ${qty} at ${loc}`);
      
      document.getElementById('trans-qty').value = '';
      document.getElementById('trans-comments').value = '';
      if (photoInput) photoInput.value = '';
      
      if (!stickyLoc) {
        locEl.value = '';
      }
      locEl.focus();
      
      await refreshTransactionStats();
      await refreshCountStats();
    } catch (err) {
      alert("Error saving transaction: " + err.message);
      console.error(err);
    }
  });

  document.getElementById('btn-cancel-edit').addEventListener('click', resetEditForm);

  document.getElementById('form-add-count').addEventListener('submit', async (e) => {
    e.preventDefault();
    const locEl = document.getElementById('count-location');
    const loc = locEl.value.trim();
    const qty = document.getElementById('count-qty').value;
    const comments = document.getElementById('count-comments').value.trim();
    const stickyLoc = document.getElementById('sticky-count-loc').checked;
    
    const photoInput = document.getElementById('count-photo');
    let photoUrl = '';

    if (!loc || qty === '') return;

    try {
      if (photoInput.files && photoInput.files.length > 0) {
         showToast('Uploading photo...');
         photoUrl = await uploadPhoto(photoInput.files[0], 'counts/' + STATE.selectedItem.itemCode);
      }

      if (STATE.editingCountId) {
        // Edit existing entry
        await db.collection('countedStock').doc(STATE.editingCountId).update({
          location: loc,
          qty: parseFloat(qty),
          comments: comments
          // optionally update photo but let's keep it simple
        });
        showToast(`Updated to ${qty} at ${loc}`);
      } else {
        // Add new entry
        await addCountEntry(STATE.selectedItem.itemCode, loc, qty, STATE.currentUser, false, STATE.selectedItem.itemDesc, comments, photoUrl);
        showToast(`Saved ${qty} at ${loc}`);
      }

      resetEditForm();
      if (stickyLoc) {
        locEl.value = loc; // restore location
        document.getElementById('count-qty').focus();
      } else {
        locEl.focus();
      }
      if (photoInput) photoInput.value = '';
      
      await refreshCountStats();
    } catch (err) {
      alert("Error saving/updating count: " + err.message);
      console.error(err);
    }
  });

  document.getElementById('form-new-item').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('new-item-code').value.trim();
    const desc = document.getElementById('new-item-desc').value.trim();
    const loc = document.getElementById('new-item-loc').value.trim();
    const qty = document.getElementById('new-item-qty').value;
    const comments = document.getElementById('new-item-comments').value.trim();

    if (!code || !loc || qty === '') return;

    try {
      await addCountEntry(code, loc, qty, STATE.currentUser, true, desc, comments);
      showToast(`Saved unlisted item ${code}`);
      showScreen('screen-user');
      document.getElementById('form-new-item').reset();
      document.getElementById('search-input').value = '';
      document.getElementById('search-results').innerHTML = '';
      document.getElementById('not-found-action').style.display = 'none';

      // Auto-focus search for next scan
      setTimeout(() => document.getElementById('search-input').focus(), 100);
    } catch (err) {
      alert("Error saving new item count!");
    }
  });
});

// --- Admin Charts Logic ---
let progressChart = null;
let varianceChart = null;

async function renderAdminCharts() {
  const chartSection = document.getElementById('admin-charts-section');
  if (!chartSection) return;
  chartSection.style.display = 'block';
  
  const sysSnapshot = await db.collection('systemStock').get();
  const cntSnapshot = await db.collection('countedStock').get();
  
  const systemItemsCount = sysSnapshot.size;
  let uniqueCountedItems = new Set();
  
  let variances = [];
  let reportMap = {};

  sysSnapshot.forEach(doc => {
    const item = doc.data();
    reportMap[item.itemCode] = { code: item.itemCode, sys: item.sysQty, phys: 0 };
  });

  cntSnapshot.forEach(doc => {
    const c = doc.data();
    uniqueCountedItems.add(c.itemCode);
    if (!reportMap[c.itemCode]) {
      reportMap[c.itemCode] = { code: c.itemCode, sys: 0, phys: 0 };
    }
    reportMap[c.itemCode].phys += c.qty;
  });

  const percentCounted = systemItemsCount === 0 ? (uniqueCountedItems.size > 0 ? 100 : 0) : Math.round((uniqueCountedItems.size / systemItemsCount) * 100);
  
  // Progress Chart
  const ctxProg = document.getElementById('chart-progress').getContext('2d');
  if (progressChart) progressChart.destroy();
  progressChart = new Chart(ctxProg, {
    type: 'doughnut',
    data: {
      labels: ['Counted', 'Pending'],
      datasets: [{
        data: [uniqueCountedItems.size, Math.max(0, systemItemsCount - uniqueCountedItems.size)],
        backgroundColor: ['#4CAF50', '#e0e0e0']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: `Count Progress (${percentCounted}%)` }
      }
    }
  });

  // Variance Chart
  Object.values(reportMap).forEach(r => {
    const v = r.phys - r.sys;
    if (Math.abs(v) > 0) {
      variances.push({ code: r.code, variance: v });
    }
  });
  
  // Sort by highest absolute variance
  variances.sort((a,b) => Math.abs(b.variance) - Math.abs(a.variance));
  const topVariances = variances.slice(0, 5);

  const ctxVar = document.getElementById('chart-variance').getContext('2d');
  if (varianceChart) varianceChart.destroy();
  varianceChart = new Chart(ctxVar, {
    type: 'bar',
    data: {
      labels: topVariances.map(v => v.code),
      datasets: [{
        label: 'Variance',
        data: topVariances.map(v => v.variance),
        backgroundColor: topVariances.map(v => v.variance > 0 ? '#4CAF50' : '#D32F2F')
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Top 5 Discrepancies' }
      }
    }
  });
}

