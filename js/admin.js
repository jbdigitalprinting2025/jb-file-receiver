/* ============================================================
   JB DIGITAL PRINTING — File Receiving Admin Dashboard
   Architecture: Firebase Storage = TEMPORARY transfer buffer
                 Windows PC (D:\JB FILES) = PERMANENT storage
   Admin controls:
     - KEEP CLOUD COPY     (pause the auto-cleanup timer)
     - RESUME AUTO CLEANUP (unpause, restart full window)
     - DELETE CLOUD COPY NOW (owner-email admins only, only after
                              PC transfer SUCCESS + integrity VERIFIED)
   ============================================================ */
(function () {
  'use strict';

  var firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  // ---------- storage provider (abstraction) ----------
  try {
    StorageService.init(APP_CONFIG.storage);
  } catch (e) {
    console.error('storage init failed', e);
  }

  // ---------- state ----------
  var isAdmin = false;
  var isOwner = false;
  var currentUserEmail = '';
  var orders = [];
  var currentOrder = null;
  var currentFiles = [];
  var countdownTimer = null;

  var RETENTION_OPTIONS = [1, 6, 12, 24, 48, 72];
  var SETTINGS = { retentionHours: 24 };

  // ---------- helpers ----------
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtSize(bytes) {
    var mb = bytes / (1024 * 1024);
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
  }
  function fmtDate(t) {
    if (!t) return '—';
    var d = t.toDate ? t.toDate() : new Date(t);
    return d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function toDate(t) {
    return t && t.toDate ? t.toDate() : (t ? new Date(t) : null);
  }
  function fmtRemaining(ms) {
    if (ms <= 0) return '0m';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h + 'h ' + m + 'm';
  }
  function badge(cls, text) {
    return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
  }
  function statusBadge(st) {
    var map = {
      UPLOADING: 'b-UPLOADING', UPLOADED: 'b-UPLOADED', RECEIVED: 'b-UPLOADED',
      DOWNLOADING: 'b-DOWNLOADING', READY: 'b-READY', PRINTING: 'b-PRINTING',
      COMPLETED: 'b-COMPLETED', FAILED: 'b-FAILED', DELETED: 'b-DELETED',
      WAITING: 'b-WAITING', SUCCESS: 'b-SUCCESS', PENDING: 'b-PENDING',
      RETENTION: 'b-RETENTION'
    };
    return badge(map[st] || 'b-WAITING', st || '—');
  }
  function cloudIcon(st, paused) {
    if (st === 'DELETED') return '<span class="st-ok">✓ DELETED</span>';
    if (paused) return '<span class="st-warn">⏸ KEEP (paused)</span>';
    if (st === 'RETENTION') return '<span class="st-warn">⏳ Safety Retention</span>';
    if (st === 'PENDING') return '<span class="st-err">⏳ Pending PC transfer</span>';
    return '<span class="st-err">' + esc(st || '—') + '</span>';
  }
  function pcIcon(st) {
    if (st === 'SUCCESS') return '<span class="st-ok">✓ SUCCESS</span>';
    if (st === 'DOWNLOADING') return '<span class="st-warn">⬇ DOWNLOADING</span>';
    if (st === 'FAILED') return '<span class="st-err">✗ FAILED</span>';
    return '<span class="st-warn">⏳ ' + esc(st || 'WAITING') + '</span>';
  }
  function integrityIcon(ok) {
    return ok ? '<span class="st-ok">✓ VERIFIED</span>' : '<span class="st-err">— PENDING</span>';
  }

  function addLog(entry) {
    // append-only audit/transfer log (rules: admin/agent create, admin read)
    var payload = { message: entry, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (auth.currentUser) payload.userId = auth.currentUser.uid;
    db.collection('qr_logs').add(payload).catch(function () {});
  }

  // ---------- views ----------
  function show(id) {
    $('view-login').classList.add('hidden');
    $('view-denied').classList.add('hidden');
    $('view-dash').classList.add('hidden');
    $(id).classList.remove('hidden');
  }

  // ---------- auth ----------
  auth.onAuthStateChanged(function (user) {
    if (user) {
      currentUserEmail = user.email || '';
      isOwner = APP_CONFIG.adminEmails.indexOf(currentUserEmail) !== -1;
      checkRole(user);
    } else {
      show('view-login');
    }
  });

  function checkRole(user) {
    db.collection('users').doc(user.uid).get().then(function (doc) {
      if (doc.exists && doc.data().role === 'admin') {
        isAdmin = true;
        enterDashboard();
      } else if (isOwner) {
        // owner emails may bootstrap their own admin doc (per rules)
        if (doc.exists) {
          db.collection('users').doc(user.uid).update({ role: 'admin' }).then(function () {
            isAdmin = true; enterDashboard();
          }).catch(function () { showDenied(); });
        } else {
          db.collection('users').doc(user.uid).set({ role: 'admin', email: currentUserEmail, createdAt: firebase.firestore.FieldValue.serverTimestamp() }).then(function () {
            isAdmin = true; enterDashboard();
          }).catch(function () { showDenied(); });
        }
      } else {
        showDenied();
      }
    }).catch(function () { showDenied(); });
  }

  function showDenied() {
    isAdmin = false;
    show('view-denied');
  }

  function enterDashboard() {
    show('view-dash');
    $('whoami').textContent = currentUserEmail + (isOwner ? ' · owner' : '');
    loadSettings();
    loadDevices();
    loadLogs();
    loadOrders();
    setInterval(loadOrders, 20000); // refresh table
  }

  // ---------- login ----------
  $('btn-login').addEventListener('click', function () {
    var email = $('login-email').value.trim();
    var pass = $('login-pass').value;
    if (!email || !pass) { showLoginErr('Enter email and password.'); return; }
    $('btn-login').disabled = true;
    auth.signInWithEmailAndPassword(email, pass)
      .then(function () { $('login-err').classList.add('hidden'); })
      .catch(function (err) {
        var m = err && err.code === 'auth/wrong-password' ? 'Wrong password. Try again.'
          : err && err.code === 'auth/user-not-found' ? 'No account with that email.'
          : err && err.code === 'auth/invalid-email' ? 'Invalid email format.'
          : err && err.code === 'auth/too-many-requests' ? 'Too many attempts. Wait a few minutes.'
          : (err && err.message) || 'Login failed.';
        showLoginErr(m);
      })
      .finally(function () { $('btn-login').disabled = false; });
  });
  function showLoginErr(m) {
    var e = $('login-err');
    e.textContent = m; e.classList.remove('hidden');
  }
  $('btn-forgot').addEventListener('click', function (ev) {
    ev.preventDefault();
    var email = $('login-email').value.trim();
    if (!email) { showLoginErr('Enter your email first.'); return; }
    auth.sendPasswordResetEmail(email)
      .then(function () { $('login-note').textContent = 'Reset link sent to ' + email + '.'; })
      .catch(function (err) { showLoginErr((err && err.message) || 'Could not send reset email.'); });
  });
  $('btn-logout').addEventListener('click', function () { auth.signOut(); });
  $('btn-logout2').addEventListener('click', function () { auth.signOut(); });

  // ---------- settings ----------
  function loadSettings() {
    db.collection('qr_settings').doc('main').get().then(function (doc) {
      if (doc.exists) {
        var d = doc.data();
        SETTINGS.retentionHours = d.retentionHours || 24;
      }
      renderSettings();
    }).catch(function () { renderSettings(); });
  }
  function renderSettings() {
    var opts = RETENTION_OPTIONS.map(function (h) {
      return '<option value="' + h + '"' + (SETTINGS.retentionHours === h ? ' selected' : '') + '>' + h + ' hour' + (h > 1 ? 's' : '') + '</option>';
    }).join('');
    $('settings-body').innerHTML =
      '<div class="kv"><span>Allowed files</span><b>JPG, PNG, PDF, DOCX, ZIP…</b></div>' +
      '<div class="kv"><span>Max file size</span><b>200 MB</b></div>' +
      '<div class="field" style="margin-top:10px">' +
      '  <label>Cloud safety retention (after PC transfer)</label>' +
      '  <select id="retention-select">' + opts + '</select>' +
      '</div>' +
      '<button class="btn btn-primary btn-sm" id="btn-save-settings" style="margin-top:8px">SAVE RETENTION</button>' +
      '<div class="info-note">Firebase copy is auto-deleted after this period when PC transfer is SUCCESS + integrity VERIFIED.</div>';
    $('btn-save-settings').addEventListener('click', function () {
      var h = parseInt($('retention-select').value, 10) || 24;
      db.collection('qr_settings').doc('main').set(
        { retentionHours: h, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      ).then(function () {
        SETTINGS.retentionHours = h;
        $('settings-body').insertAdjacentHTML('beforeend', '<div class="info-note" style="color:var(--jb-green)">✓ Saved — retention is now ' + h + ' hour(s).</div>');
        addLog('Admin set cloud retention to ' + h + 'h');
      }).catch(function (err) {
        $('settings-body').insertAdjacentHTML('beforeend', '<div class="info-note" style="color:var(--jb-red)">Save failed: ' + esc(err.message) + '</div>');
      });
    });
  }

  // ---------- devices ----------
  function loadDevices() {
    db.collection('qr_devices').orderBy('lastSeen', 'desc').get().then(function (snap) {
      var html = '';
      var online = 0;
      snap.forEach(function (d) {
        var dev = d.data();
        var last = toDate(dev.lastSeen);
        var fresh = last && (Date.now() - last.getTime() < 90000);
        if (fresh) online++;
        html += '<div class="file-row2"><span class="fn">' + esc(dev.deviceName || d.id) + '</span>' +
                '<span class="fs">' + (fresh ? '🟢 online' : '⚪ offline') + ' · ' + fmtDate(dev.lastSeen) + '</span></div>';
      });
      if (!html) html = '<div class="muted">No PC agent registered yet.</div>';
      $('devices-list').innerHTML = html;
      $('st-devices').textContent = online;
    }).catch(function () { $('devices-list').innerHTML = '<div class="muted">Cannot load devices.</div>'; });
  }

  // ---------- audit / transfer log ----------
  function loadLogs() {
    db.collection('qr_logs').orderBy('createdAt', 'desc').limit(25).get().then(function (snap) {
      var html = '';
      snap.forEach(function (d) {
        var l = d.data();
        html += '<div class="log-row"><div>' + esc(l.message || '') + '</div><div class="t">' + fmtDate(l.createdAt) + '</div></div>';
      });
      $('log-list').innerHTML = html || '<div class="muted">No events yet.</div>';
    }).catch(function () { $('log-list').innerHTML = '<div class="muted">Cannot load log.</div>'; });
  }

  // ---------- orders ----------
  function loadOrders() {
    db.collection('qr_orders').orderBy('createdAt', 'desc').limit(60).get().then(function (snap) {
      orders = [];
      var counts = { uploaded: 0, ready: 0, printing: 0, failed: 0 };
      snap.forEach(function (d) {
        var o = d.data(); o.id = d.id; orders.push(o);
        if (o.status === 'UPLOADED' || o.status === 'UPLOADING') counts.uploaded++;
        if (o.status === 'READY' || o.status === 'DOWNLOADING') counts.ready++;
        if (o.status === 'PRINTING') counts.printing++;
        if (o.pcTransferStatus === 'FAILED' || o.status === 'FAILED') counts.failed++;
      });
      $('st-new').textContent = counts.uploaded;
      $('st-ready').textContent = counts.ready;
      $('st-printing').textContent = counts.printing;
      $('st-failed').textContent = counts.failed;
      renderOrders();
    }).catch(function () {
      $('orders-body').innerHTML = '';
      $('orders-empty').textContent = 'Cannot load orders. Check connection.';
    });
  }

  function renderOrders() {
    var tbody = $('orders-body');
    tbody.innerHTML = '';
    $('orders-empty').textContent = orders.length ? '' : 'No orders yet.';
    orders.forEach(function (o) {
      var tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.addEventListener('click', function () { openOrder(o.id); });
      var sizeTxt = o.totalSize != null ? fmtSize(o.totalSize) : '—';
      var fb = o.firebaseStatus === 'DELETED' ? '✓' : (o.cleanupPaused ? '⏸' : (o.firebaseStatus === 'RETENTION' ? '⏳' : '—'));
      tr.innerHTML =
        '<td>' + esc(o.customerName || '—') + '</td>' +
        '<td><b>' + esc(o.orderNumber || '—') + '</b></td>' +
        '<td>' + (o.fileCount || 0) + '</td>' +
        '<td>' + sizeTxt + '</td>' +
        '<td>' + statusBadge(o.status) + '</td>' +
        '<td>' + pcIcon(o.pcTransferStatus) + '</td>' +
        '<td>' + fb + '</td>' +
        '<td>' + fmtDate(o.createdAt) + '</td>';
      tbody.appendChild(tr);
    });
  }

  // ---------- order detail ----------
  function openOrder(orderId) {
    currentOrderId = orderId;
    $('order-detail').style.display = '';
    $('od-body').innerHTML = '<div class="muted">Loading…</div>';
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    db.collection('qr_orders').doc(orderId).get().then(function (doc) {
      if (!doc.exists) { $('od-body').innerHTML = '<div class="muted">Order not found.</div>'; return; }
      currentOrder = doc.data(); currentOrder.id = doc.id;
      $('od-title').textContent = currentOrder.orderNumber || 'Order';
      db.collection('qr_files').where('orderId', '==', orderId).get().then(function (fsnap) {
        currentFiles = [];
        fsnap.forEach(function (f) { var fd = f.data(); fd.id = f.id; currentFiles.push(fd); });
        renderOrderDetail();
      }).catch(function () { renderOrderDetail(); });
    }).catch(function () {
      $('od-body').innerHTML = '<div class="muted">Cannot open order.</div>';
    });
  }

  function renderOrderDetail() {
    var o = currentOrder;
    var retentionMs = (o.retentionExpiresAt ? toDate(o.retentionExpiresAt).getTime() : null);
    var now = Date.now();
    var remaining = retentionMs ? Math.max(0, retentionMs - now) : null;

    var filesHtml = currentFiles.map(function (f) {
      var fstate = f.pcStatus === 'TRANSFERRED_TO_PC' ? '<span class="st-ok">✓ on PC</span>'
        : f.pcStatus === 'FAILED' ? '<span class="st-err">✗ ' + esc(f.pcStatus) + '</span>'
        : '<span class="st-warn">' + esc(f.pcStatus || 'PENDING') + '</span>';
      var fcloud = f.firebaseStatus === 'DELETED' ? '✓' : (f.firebaseStatus === 'RETENTION' ? '⏳' : '·');
      return '<div class="file-row2"><span class="fn">' + esc(f.originalName) + '</span>' +
             '<span class="fs">' + fmtSize(f.size || 0) + ' · ' + fstate + ' · cloud ' + fcloud + '</span></div>';
    }).join('') || '<div class="muted">No files.</div>';

    var canDelete = isAdmin && isOwner && o.pcTransferStatus === 'SUCCESS' && o.integrityVerified;
    var deleteBtn = isAdmin && isOwner
      ? (o.pcTransferStatus === 'SUCCESS' && o.integrityVerified
          ? '<button class="btn btn-red btn-sm" id="btn-del-cloud">🗑 DELETE CLOUD COPY NOW</button>'
          : '<button class="btn btn-sm" disabled title="Cloud copy is deleted only after PC transfer SUCCESS + integrity VERIFIED">🗑 DELETE CLOUD COPY NOW (locked)</button>')
      : '';

    var keepBtn = o.cleanupPaused
      ? '<button class="btn btn-blue btn-sm" id="btn-resume-cleanup">▶ RESUME AUTO CLEANUP</button>'
      : '<button class="btn btn-blue btn-sm" id="btn-keep-cloud">⏸ KEEP CLOUD COPY</button>';

    var cleanupLine = o.firebaseStatus === 'DELETED'
      ? '<span class="st-ok val">✓ Deleted</span>'
      : o.cleanupPaused
        ? '<span class="st-warn val">⏸ Paused by admin — no auto-delete</span>'
        : o.firebaseStatus === 'RETENTION' && remaining != null
          ? '<span class="st-warn val">' + fmtRemaining(remaining) + ' remaining</span>'
          : o.firebaseStatus === 'RETENTION'
            ? '<span class="st-warn val">Waiting for expiry…</span>'
            : '<span class="st-err val">Not started (PC transfer not complete)</span>';

    $('od-body').innerHTML =
      '<div class="kv"><span>Customer</span><b>' + esc(o.customerName || '—') + '</b></div>' +
      '<div class="kv"><span>Contact</span><b>' + esc(o.customerContact || '—') + '</b></div>' +
      '<div class="kv"><span>Reference</span><b>' + esc(o.reference || '—') + '</b></div>' +
      '<div class="kv"><span>Date</span><b>' + fmtDate(o.createdAt) + '</b></div>' +
      '<div class="kv"><span>Files / Size</span><b>' + (o.fileCount || 0) + ' · ' + fmtSize(o.totalSize || 0) + '</b></div>' +
      '<div class="kv"><span>Status</span><b>' + statusBadge(o.status) + '</b></div>' +
      '<h3 style="margin-top:14px">💾 STORAGE STATUS</h3>' +
      '<div class="st-grid">' +
      '  <div class="st-row"><span class="lbl">PC Transfer</span>' + pcIcon(o.pcTransferStatus) + '</div>' +
      '  <div class="st-row"><span class="lbl">Integrity (SHA-256)</span>' + integrityIcon(o.integrityVerified) + '</div>' +
      '  <div class="st-row"><span class="lbl">Firebase copy</span>' + cloudIcon(o.firebaseStatus, o.cleanupPaused) + '</div>' +
      '  <div class="st-row"><span class="lbl">Firebase Cleanup</span>' + cleanupLine + '</div>' +
      '  <div class="st-row"><span class="lbl">Local PC (D:\\JB FILES)</span>' +
      (o.pcTransferStatus === 'SUCCESS' ? '<span class="st-ok">✓ AVAILABLE</span>' : '<span class="st-warn">— WAITING</span>') + '</div>' +
      '</div>' +
      '<div class="actions">' +
      '  <button class="btn btn-sm" id="btn-printing">🖨 MARK PRINTING</button>' +
      '  <button class="btn btn-green btn-sm" id="btn-completed">✓ MARK COMPLETED</button>' +
      keepBtn + deleteBtn +
      '</div>' +
      '<h3 style="margin-top:14px">📄 FILES</h3>' + filesHtml;

    $('btn-printing').addEventListener('click', function () { setOrderStatus('PRINTING'); });
    $('btn-completed').addEventListener('click', function () { setOrderStatus('COMPLETED'); });
    var k = $('btn-keep-cloud'); if (k) k.addEventListener('click', keepCloudCopy);
    var r = $('btn-resume-cleanup'); if (r) r.addEventListener('click', resumeCleanup);
    var d = $('btn-del-cloud'); if (d) d.addEventListener('click', deleteCloudNow);

    startCountdown(remaining);
  }

  function startCountdown(remainingMs) {
    if (countdownTimer) clearInterval(countdownTimer);
    if (remainingMs == null) return;
    countdownTimer = setInterval(function () {
      var o = currentOrder;
      if (!o) { clearInterval(countdownTimer); return; }
      var rem = o.retentionExpiresAt ? Math.max(0, toDate(o.retentionExpiresAt).getTime() - Date.now()) : 0;
      var el = $('od-body');
      if (!el) { clearInterval(countdownTimer); return; }
      // refresh detail every 60s is overkill; update only the cleanup line
      var rows = el.querySelectorAll('.st-row');
      if (rows.length >= 4 && o.firebaseStatus === 'RETENTION' && !o.cleanupPaused) {
        rows[3].querySelector('.val') && (rows[3].querySelector('.val').textContent = fmtRemaining(rem) + ' remaining');
      }
    }, 30000);
  }

  // ---------- actions ----------
  function setOrderStatus(st) {
    var o = currentOrder;
    db.collection('qr_orders').doc(o.id).update({
      status: st,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      addLog('Admin marked ' + o.orderNumber + ' as ' + st);
      openOrder(o.id); loadOrders();
    }).catch(function (err) { alert('Failed: ' + err.message); });
  }

  function keepCloudCopy() {
    var o = currentOrder;
    if (o.firebaseStatus === 'DELETED') { alert('Cloud copy is already deleted.'); return; }
    if (o.pcTransferStatus !== 'SUCCESS') { alert('Cannot pause cleanup before the PC transfer is complete.'); return; }
    db.collection('qr_orders').doc(o.id).update({
      cleanupPaused: true,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      addLog('Admin KEPT cloud copy for ' + o.orderNumber + ' (cleanup paused)');
      openOrder(o.id);
    }).catch(function (err) { alert('Failed: ' + err.message); });
  }

  function resumeCleanup() {
    var o = currentOrder;
    var h = SETTINGS.retentionHours || 24;
    db.collection('qr_orders').doc(o.id).update({
      cleanupPaused: false,
      retentionExpiresAt: new Date(Date.now() + h * 3600 * 1000),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      addLog('Admin resumed auto cleanup for ' + o.orderNumber + ' (new ' + h + 'h window)');
      openOrder(o.id);
    }).catch(function (err) { alert('Failed: ' + err.message); });
  }

  function deleteCloudNow() {
    var o = currentOrder;
    if (!confirm('Delete the Firebase cloud copy of ' + o.orderNumber + ' NOW?\n\nOnly the cloud copy is removed — the PC copy (D:\\JB FILES) stays. This cannot be undone.')) return;
    var filesToDelete = currentFiles.filter(function (f) { return f.firebaseStatus !== 'DELETED'; });
    var tasks = filesToDelete.map(function (f) {
      return StorageService.deleteFile(f.storagePath)
        .then(function () { return db.collection('qr_files').doc(f.id).update({ firebaseStatus: 'DELETED', deletedFromCloudAt: firebase.firestore.FieldValue.serverTimestamp() }); })
        .catch(function (err) { console.error('delete failed', f.storagePath, err); throw err; });
    });
    Promise.all(tasks).then(function () {
      return db.collection('qr_orders').doc(o.id).update({
        firebaseStatus: 'DELETED',
        cleanupAt: firebase.firestore.FieldValue.serverTimestamp(),
        cleanupPaused: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }).then(function () {
      addLog('Admin DELETED cloud copy of ' + o.orderNumber + ' (PC copy kept)');
      openOrder(o.id);
    }).catch(function (err) { alert('Some files could not be deleted: ' + err.message); });
  }
})();
