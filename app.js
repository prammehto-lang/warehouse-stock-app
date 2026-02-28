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
  editingCountId: null
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

function clearAllData() {
  return new Promise(async (resolve, reject) => {
    try {
      // Deleting a collection from a Web client is NOT recommended by Firebase 
      // because it has negative performance and security implications.
      // However, for this admin function, we manually fetch and delete all documents.
      const sysQuery = await db.collection('systemStock').get();
      const cntQuery = await db.collection('countedStock').get();

      const batch = db.batch();
      sysQuery.docs.forEach(doc => batch.delete(doc.ref));
      cntQuery.docs.forEach(doc => batch.delete(doc.ref));

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
    if (data.itemCode.toLowerCase().includes(q) || data.itemDesc.toLowerCase().includes(q)) {
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

// Counted Stock Utilities
async function addCountEntry(itemCode, location, qty, addedBy, isNewSystemItem = false, itemDesc = '') {
  try {
    const entry = {
      itemCode,
      location,
      qty: parseFloat(qty),
      user: addedBy,
      date: new Date().toISOString(),
      isNew: isNewSystemItem,
      itemDesc: itemDesc
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
      DateAndTime: []
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
        DateAndTime: []
      };
    }
    let rm = reportMap[c.itemCode];
    rm.TotalPhysicalStock += c.qty;
    rm.Difference = rm.TotalPhysicalStock - rm.SystemStock;
    rm.CountedBy.add(c.user);
    rm.LocationsCounted.add(c.location);
    rm.DateAndTime.push(new Date(c.date).toLocaleString());
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
    'Date and Time': row.DateAndTime.join(' | ')
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

// --- UI Navigation ---
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  STATE.currentScreen = screenId;

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
    if (STATE.currentUser === 'admin') {
      showScreen('screen-admin');
    } else {
      showScreen('screen-user');
    }
  });

  // Login Form
  // DEFINE YOUR TEAM MEMBERS AND PASSWORDS HERE
  const ALLOWED_USERS = {
    'pramit': 'Pmxyz@123',   // Admin
    'anuj': 'anuj123',       // User
    'ranjeet': 'ranj123',    // User
    'monu': 'monu123',       // User
    'rshri': 'rshri123',     // User
    'lav': 'lov123',         // User
    'shahil': 'shah123',     // User
    'faizal': 'faiz123',     // User
    'dhram': 'dharm123',     // User
    'murshid': 'mursh123',   // User
    'fhaizan': 'fhaiz123'    // User
  };

  document.getElementById('form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('login-id').value.trim().toLowerCase();
    const pass = document.getElementById('login-pass').value.trim();

    if (id && pass) {
      // Check if user exists and password matches
      if (ALLOWED_USERS[id] && ALLOWED_USERS[id] === pass) {
        STATE.currentUser = id;
        document.getElementById('login-id').value = '';
        document.getElementById('login-pass').value = '';

        if (id === 'pramit') {
          showScreen('screen-admin');
        } else {
          showScreen('screen-user');
        }
        showToast(`Logged in as ${id}`);
      } else {
        showToast('Invalid ID or Password!');
      }
    }
  });

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
        el.innerHTML = `
           <div>
             <div class="item-primary">${item.itemCode}</div>
             <div class="item-secondary">${item.itemDesc}</div>
           </div>
           <div>
              <i class="material-icons" style="color:#1976D2;">chevron_right</i>
           </div>
         `;
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
    document.getElementById('form-count-title').textContent = 'Add Count Entry';
    document.getElementById('btn-save-count').textContent = 'SAVE COUNT';
    document.getElementById('btn-cancel-edit').style.display = 'none';
  }

  function startEditCount(id, location, qty) {
    STATE.editingCountId = id;
    document.getElementById('count-location').value = location;
    document.getElementById('count-qty').value = qty;
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

    await refreshCountStats();
    showScreen('screen-count');
  }

  async function refreshCountStats() {
    const itemCode = STATE.selectedItem.itemCode;
    const sysQty = STATE.selectedItem.sysQty || 0;

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
        startEditCount(h.id, h.location, h.qty);
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

    const diff = totalPhys - sysQty;

    document.getElementById('detail-sys-qty').textContent = sysQty;
    document.getElementById('detail-phys-qty').textContent = totalPhys;
    const diffEl = document.getElementById('detail-diff-qty');
    const diffBox = document.getElementById('detail-diff-box');

    diffEl.textContent = (diff > 0 ? '+' : '') + diff;

    diffBox.className = 'stat-box'; // reset
    if (diff > 0) diffBox.classList.add('diff-positive');
    else if (diff < 0) diffBox.classList.add('diff-negative');
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

  document.getElementById('btn-cancel-edit').addEventListener('click', resetEditForm);

  document.getElementById('form-add-count').addEventListener('submit', async (e) => {
    e.preventDefault();
    const loc = document.getElementById('count-location').value.trim();
    const qty = document.getElementById('count-qty').value;

    if (!loc || qty === '') return;

    try {
      if (STATE.editingCountId) {
        // Edit existing entry
        await db.collection('countedStock').doc(STATE.editingCountId).update({
          location: loc,
          qty: parseFloat(qty)
        });
        showToast(`Updated to ${qty} at ${loc}`);
      } else {
        // Add new entry
        await addCountEntry(STATE.selectedItem.itemCode, loc, qty, STATE.currentUser, false, STATE.selectedItem.itemDesc);
        showToast(`Saved ${qty} at ${loc}`);
      }

      resetEditForm();
      document.getElementById('count-location').focus();
      await refreshCountStats();
    } catch (err) {
      alert("Error saving/updating count!");
      console.error(err);
    }
  });

  // -- Add New Item (Not in system) --
  document.getElementById('form-new-item').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('new-item-code').value.trim();
    const desc = document.getElementById('new-item-desc').value.trim();
    const loc = document.getElementById('new-item-loc').value.trim();
    const qty = document.getElementById('new-item-qty').value;

    if (!code || !loc || qty === '') return;

    try {
      await addCountEntry(code, loc, qty, STATE.currentUser, true, desc);
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
