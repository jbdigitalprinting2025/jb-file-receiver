/* ============================================================
   JB DIGITAL PRINTING — Customer Upload Logic
   Flow: anon sign-in → create order → hash files → resumable
   upload → mark RECEIVED → completion screen
   ============================================================ */
(function () {
  'use strict';

  var firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  // ---------- settings (with safe defaults) ----------
  var SETTINGS = {
    allowedExtensions: ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'psd', 'ai', 'svg', 'zip', 'rar'],
    maxFileSizeMB: 200,
    retentionHours: 24,   // TEMPORARY cloud retention after successful PC transfer
    localRetentionDays: 0
  };

  // ---------- state ----------
  var selectedFiles = [];      // {file, ext, sizeMB}
  var uploading = false;
  var currentOrderId = null;
  var currentOrderNumber = null;
  var fileStates = {};         // fileName -> {status, progress, error}
  var anonReady = false;

  // ---------- elements ----------
  var $ = function (id) { return document.getElementById(id); };
  var viewForm = $('view-form'), viewProgress = $('view-progress'), viewDone = $('view-done');

  function fmtMB(bytes) {
    var mb = bytes / (1024 * 1024);
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
  }
  function fmtSizeShort(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return fmtMB(bytes);
  }
  function extOf(name) {
    var m = /\.([a-zA-Z0-9]+)$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  }
  function esc(s) { return String(s == null ? '' : s); }
  function randHex(n) {
    var arr = new Uint8Array(n);
    crypto.getRandomValues(arr);
    return Array.prototype.map.call(arr, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function sanitizeForStorage(name) {
    // keep base name, strip path separators/unsafe chars, cap length
    var base = name.replace(/^.*[\\/]/, '');
    var ext = extOf(base);
    var stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
    stem = stem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    return (stem || 'file') + '.' + ext;
  }

  // ---------- anonymous sign-in ----------
  function ensureAnon() {
    return new Promise(function (resolve, reject) {
      var cur = auth.currentUser;
      if (cur) { anonReady = true; resolve(cur); return; }
      auth.signInAnonymously()
        .then(function (res) { anonReady = true; resolve(res.user); })
        .catch(function (err) {
          console.error('anon signin failed', err);
          reject(new Error('Cannot connect. Please check your internet and try again.'));
        });
    });
  }

  // ---------- settings load ----------
  function loadSettings() {
    return db.collection('qr_settings').doc('main').get()
      .then(function (doc) {
        if (doc.exists) {
          var d = doc.data();
          if (Array.isArray(d.allowedExtensions) && d.allowedExtensions.length) SETTINGS.allowedExtensions = d.allowedExtensions;
          if (d.maxFileSizeMB > 0) SETTINGS.maxFileSizeMB = d.maxFileSizeMB;
          if (d.retentionHours > 0) SETTINGS.retentionHours = d.retentionHours;
          if (d.localRetentionDays >= 0) SETTINGS.localRetentionDays = d.localRetentionDays;
        }
        $('allowed-hint').textContent = SETTINGS.allowedExtensions.map(function (e) { return e.toUpperCase(); }).join(', ') + ' · max ' + SETTINGS.maxFileSizeMB + 'MB per file';
      })
      .catch(function () { /* defaults */ });
  }

  // ---------- storage provider ----------
  try {
    StorageService.init(APP_CONFIG.storage);
  } catch (e) {
    console.error('storage init failed', e);
  }

  // ---------- init ----------
  ensureAnon()
    .then(function () { $('conn-note').textContent = 'Ready ✓'; enableUploadIfValid(); })
    .catch(function (e) { $('conn-note').textContent = e.message; });
  loadSettings();

  // ---------- file picker ----------
  var picker = $('file-picker'), input = $('file-input');
  // native overlay input opens the dialog; keep a JS fallback for clicks that
  // land on the picker itself (not the overlay), guarded against double-open
  picker.addEventListener('click', function (e) { if (!uploading && e.target !== input) input.click(); });
  ['dragover', 'dragenter'].forEach(function (ev) {
    picker.addEventListener(ev, function (e) { e.preventDefault(); picker.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    picker.addEventListener(ev, function (e) { e.preventDefault(); picker.classList.remove('drag'); });
  });
  picker.addEventListener('drop', function (e) {
    if (uploading) return;
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', function () {
    if (input.files && input.files.length) addFiles(input.files);
    input.value = '';
  });

  function addFiles(fileList) {
    var errors = [];
    Array.prototype.forEach.call(fileList, function (f) {
      var ext = extOf(f.name);
      if (SETTINGS.allowedExtensions.indexOf(ext) === -1) {
        errors.push(f.name + ' — type .' + ext + ' not allowed');
        return;
      }
      if (f.size > SETTINGS.maxFileSizeMB * 1024 * 1024) {
        errors.push(f.name + ' — bigger than ' + SETTINGS.maxFileSizeMB + 'MB');
        return;
      }
      if (!selectedFiles.some(function (s) { return s.file.name === f.name && s.file.size === f.size; })) {
        selectedFiles.push({ file: f, ext: ext });
      }
    });
    renderFileList();
    if (errors.length) showError(errors.join('. '));
  }

  function renderFileList() {
    var list = $('file-list');
    list.innerHTML = '';
    selectedFiles.forEach(function (s, i) {
      var row = document.createElement('div');
      row.className = 'file-row';
      var ic = document.createElement('div');
      ic.className = 'ficon';
      ic.textContent = s.ext.slice(0, 4);
      var meta = document.createElement('div');
      meta.className = 'fmeta';
      var nm = document.createElement('div');
      nm.className = 'fname';
      nm.textContent = s.file.name;
      nm.title = s.file.name;
      var sz = document.createElement('div');
      sz.className = 'fsize';
      sz.textContent = fmtSizeShort(s.file.size);
      meta.appendChild(nm); meta.appendChild(sz);
      var x = document.createElement('button');
      x.className = 'remove-x';
      x.textContent = '✕';
      x.title = 'Remove';
      x.addEventListener('click', function () { if (!uploading) { selectedFiles.splice(i, 1); renderFileList(); } });
      row.appendChild(ic); row.appendChild(meta); row.appendChild(x);
      list.appendChild(row);
    });
    var count = selectedFiles.length;
    var total = selectedFiles.reduce(function (a, s) { return a + s.file.size; }, 0);
    $('totals').classList.toggle('hidden', count === 0);
    $('total-count').textContent = count;
    $('total-size').textContent = fmtMB(total);
    enableUploadIfValid();
  }

  function enableUploadIfValid() {
    $('btn-upload').disabled = !(anonReady && selectedFiles.length > 0 && !uploading);
  }

  function showError(msg) {
    var box = $('errbox');
    box.textContent = msg;
    box.classList.remove('hidden');
  }
  function hideError() { $('errbox').classList.add('hidden'); }

  // ---------- order creation (counter + order, atomic retry) ----------
  function createOrder(name, contact, ref, totalSize) {
    var counterRef = db.collection('qr_counter').doc('main');
    function attempt(n) {
      return counterRef.get().then(function (snap) {
        var next = (snap.exists ? snap.data().value : 0) + 1;
        var orderNumber = 'JB-' + new Date().getFullYear() + '-' + ('000000' + next).slice(-6);
        var orderRef = db.collection('qr_orders').doc();
        var batch = db.batch();
        batch.set(counterRef, { value: next });
        batch.set(orderRef, {
          orderNumber: orderNumber,
          customerName: name,
          customerContact: contact,
          reference: ref,
          status: 'UPLOADING',
          pcStatus: 'WAITING',
          pcTransferStatus: 'WAITING',
          firebaseStatus: 'PENDING',
          integrityVerified: false,
          cleanupPaused: false,
          fileCount: 0,
          totalSize: totalSize,
          creatorUid: auth.currentUser.uid,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return batch.commit().then(function () {
          return { orderId: orderRef.id, orderNumber: orderNumber };
        }).catch(function (err) {
          // counter conflict or transient — retry a few times
          if (n < 6 && err && (err.code === 'permission-denied' || err.code === 'aborted' || err.code === 'resource-exhausted')) {
            return new Promise(function (res) { setTimeout(function () { res(attempt(n + 1)); }, 400 * (n + 1)); });
          }
          throw err;
        });
      });
    }
    return attempt(0);
  }

  // ---------- upload flow ----------
  $('btn-upload').addEventListener('click', function () {
    var name = $('cust-name').value.trim();
    if (!name) { showError('Please enter your name.'); $('cust-name').focus(); return; }
    if (!selectedFiles.length) { showError('Please select at least one file.'); return; }
    if (!anonReady) { showError('Still connecting… please wait a moment and try again.'); return; }
    hideError();
    startUpload(name, $('cust-contact').value.trim(), $('cust-ref').value.trim());
  });

  var beforeUnloadHandler = function (e) { e.preventDefault(); e.returnValue = ''; };

  function startUpload(name, contact, ref) {
    uploading = true;
    var totalSize = selectedFiles.reduce(function (a, s) { return a + s.file.size; }, 0);
    viewForm.classList.add('hidden');
    viewProgress.classList.remove('hidden');
    viewDone.classList.add('hidden');

    createOrder(name, contact, ref, totalSize)
      .then(function (ord) {
        currentOrderId = ord.orderId;
        currentOrderNumber = ord.orderNumber;
        $('total-count-p').textContent = selectedFiles.length;
        $('size-total-p').textContent = fmtMB(totalSize);
        window.addEventListener('beforeunload', beforeUnloadHandler);
        return uploadAllFiles(ord.orderId);
      })
      .then(function (result) {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
        if (result.allDone) {
          return finishOrder(result.uploadedCount, result.uploadedSize);
        } else {
          // some failed — keep UPLOADING, offer retry
          $('btn-retry-failed').classList.remove('hidden');
          showProgressNote('Some files failed. Tap RETRY FAILED FILES.');
          return null;
        }
      })
      .catch(function (err) {
        console.error('upload flow error', err);
        uploading = false;
        viewProgress.classList.add('hidden');
        viewForm.classList.remove('hidden');
        showError('Upload failed: ' + (err && err.message ? err.message : 'unknown error') + '. Please try again.');
        enableUploadIfValid();
      });
  }

  function uploadAllFiles(orderId) {
    var results = { allDone: true, uploadedCount: 0, uploadedSize: 0 };
    var seq = Promise.resolve();
    selectedFiles.forEach(function (s, idx) {
      seq = seq.then(function () { return uploadOneFile(orderId, s, idx); }).then(function (ok) {
        if (ok) { results.uploadedCount++; results.uploadedSize += s.file.size; }
        else results.allDone = false;
      });
    });
    return seq.then(function () { return results; });
  }

  function uploadOneFile(orderId, s, idx) {
    var f = s.file;
    var storagePath = 'qrupload/orders/' + orderId + '/' + randHex(8) + '_' + sanitizeForStorage(f.name);
    var fileRef = db.collection('qr_files').doc();
    var rowEl = addProgressRow(f, s.ext, idx);
    var stateEl = rowEl.querySelector('.fstate');
    var fillEl = rowEl.querySelector('.mini-fill');

    setRowState(stateEl, 'Hashing…', 'wait');
    return sha256File(f, function (done, total) {
      if (fillEl) fillEl.style.width = (done / total * 100).toFixed(1) + '%';
    }).then(function (hash) {
      return fileRef.set({
        orderId: orderId,
        originalName: f.name,
        storagePath: storagePath,
        size: f.size,
        mime: f.type || ('application/' + s.ext),
        sha256: hash,
        uploadStatus: 'UPLOADING',
        pcStatus: 'PENDING',
        firebaseStatus: 'PENDING',
        creatorUid: auth.currentUser.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }).then(function () {
      setRowState(stateEl, 'Uploading… 0%', 'wait');
      return StorageService.uploadFile(f, storagePath, function (loaded, total) {
        var pct = total ? (loaded / total * 100).toFixed(0) : 0;
        if (fillEl) fillEl.style.width = pct + '%';
        setRowState(stateEl, 'Uploading… ' + pct + '%', 'wait');
        updateGlobalProgress();
      }).then(function () {
        return fileRef.update({ uploadStatus: 'DONE' }).catch(function () {});
      }).then(function () {
        setRowState(stateEl, 'DONE ✓', 'done');
        if (fillEl) fillEl.style.width = '100%';
        updateGlobalProgress();
        return true;
      }).catch(function (err) {
        console.error('upload error', f.name, err);
        fileRef.update({ uploadStatus: 'FAILED' }).catch(function () {});
        setRowState(stateEl, 'FAILED', 'err');
        return false;
      });
    }).catch(function (err) {
      console.error('file prep error', f.name, err);
      setRowState(stateEl, 'FAILED', 'err');
      return false;
    });
  }

  function updateGlobalProgress() {
    var done = 0, total = 0;
    var list = $('progress-list').children;
    for (var i = 0; i < list.length; i++) {
      var st = list[i].querySelector('.fstate');
      if (st && st.textContent.indexOf('DONE') === 0) done++;
      total++;
    }
    var pct = total ? Math.round(done / total * 100) : 0;
    $('progress-fill').style.width = pct + '%';
    $('progress-note').textContent = pct + '%';
    $('done-count').textContent = done;
  }

  function addProgressRow(f, ext, idx) {
    var list = $('progress-list');
    var row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.idx = idx;
    var ic = document.createElement('div');
    ic.className = 'ficon';
    ic.textContent = ext.slice(0, 4);
    var meta = document.createElement('div');
    meta.className = 'fmeta';
    var nm = document.createElement('div');
    nm.className = 'fname';
    nm.textContent = f.name;
    var bar = document.createElement('div');
    bar.className = 'progress-track';
    bar.style.height = '6px';
    bar.style.margin = '4px 0 2px';
    var fill = document.createElement('div');
    fill.className = 'progress-fill mini-fill';
    fill.style.transition = 'width .2s';
    bar.appendChild(fill);
    meta.appendChild(nm); meta.appendChild(bar);
    var st = document.createElement('div');
    st.className = 'fstate wait';
    st.textContent = 'Waiting…';
    row.appendChild(ic); row.appendChild(meta); row.appendChild(st);
    list.appendChild(row);
    return row;
  }

  function setRowState(el, text, cls) {
    if (!el) return;
    el.textContent = text;
    el.className = 'fstate ' + cls;
  }

  function showProgressNote(t) { $('progress-note').textContent = t; }

  // retry failed files: re-run only rows marked FAILED
  $('btn-retry-failed').addEventListener('click', function () {
    $('btn-retry-failed').classList.add('hidden');
    var failed = [];
    selectedFiles.forEach(function (s) { failed.push(s); });
    // simplest robust retry: restart the whole batch for FAILED ones
    var rows = $('progress-list').children;
    var toRetry = [];
    for (var i = 0; i < rows.length; i++) {
      var st = rows[i].querySelector('.fstate');
      if (st && st.textContent.indexOf('FAILED') === 0) {
        toRetry.push(selectedFiles[parseInt(rows[i].dataset.idx, 10)]);
        rows[i].remove();
      }
    }
    if (!toRetry.length) return;
    var results = { allDone: true, uploadedCount: 0, uploadedSize: 0 };
    var seq = Promise.resolve();
    toRetry.forEach(function (s, idx) {
      seq = seq.then(function () { return uploadOneFile(currentOrderId, s, idx); }).then(function (ok) {
        if (ok) { results.uploadedCount++; results.uploadedSize += s.file.size; }
        else results.allDone = false;
      });
    });
    seq.then(function () {
      if (results.allDone) {
        finishOrder(selectedFiles.length, selectedFiles.reduce(function (a, s) { return a + s.file.size; }, 0));
      } else {
        $('btn-retry-failed').classList.remove('hidden');
        showProgressNote('Some files still failed.');
      }
    });
  });

  // ---------- finish ----------
  function finishOrder(fileCount, totalSize) {
    return db.collection('qr_orders').doc(currentOrderId).update({
      status: 'UPLOADED',
      pcStatus: 'WAITING',
      fileCount: fileCount,
      totalSize: totalSize,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      uploading = false;
      viewProgress.classList.add('hidden');
      viewDone.classList.remove('hidden');
      $('done-order-no').textContent = currentOrderNumber;
      $('done-files').textContent = fileCount;
      $('done-size').textContent = fmtMB(totalSize);
    }).catch(function (err) {
      console.error('finish failed', err);
      uploading = false;
      showProgressNote('Uploads done but could not finalize order. Please screenshot this page.');
    });
  }

  $('btn-new-upload').addEventListener('click', function () {
    currentOrderId = null;
    selectedFiles = [];
    $('file-list').innerHTML = '';
    $('progress-list').innerHTML = '';
    $('progress-fill').style.width = '0%';
    $('cust-name').value = '';
    $('cust-contact').value = '';
    $('cust-ref').value = '';
    viewDone.classList.add('hidden');
    viewForm.classList.remove('hidden');
    renderFileList();
  });
})();
