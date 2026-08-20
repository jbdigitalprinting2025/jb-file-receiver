/* ============================================================
   JB DIGITAL PRINTING — Storage Service (provider abstraction)
   ------------------------------------------------------------
   The application talks ONLY to StorageService. The concrete
   provider adapter (currently Cloudflare R2) is selected in
   APP_CONFIG.storage. Swapping providers later = adding a new
   adapter + changing APP_CONFIG — core logic stays untouched.

   R2 flow:
     browser -> POST /presign (Cloudflare Worker) -> presigned URL
     browser -> PUT/GET/DELETE presigned URL -> R2 (private bucket)
   R2 credentials never appear in the frontend.
   ============================================================ */
(function () {
  'use strict';

  var provider = null;

  function StorageService() {}

  // ---------- provider interface ----------
  // uploadFile(file, key, onProgress) -> Promise
  // getDownloadUrl(key)                 -> Promise<string>
  // deleteFile(key)                     -> Promise

  // ---------- Cloudflare R2 adapter ----------
  function R2Adapter(cfg) {
    // strip trailing slash so workerUrl + '/presign' never becomes '//presign'
    var workerUrl = String(cfg.workerUrl || '').replace(/\/+$/, '');
    var token = cfg.uploadToken;
    var maxSizeMB = cfg.maxSizeMB || 200;
    // RACE-FIX (Aug 20, 2026): safe configurable upload timeout. A hung
    // request must never leave the UI stuck on "Uploading..." forever.
    // Default 5 minutes — long enough for a 200MB file on a slow link,
    // well under the worker's 15-min presigned URL expiry.
    var uploadTimeoutMs = cfg.uploadTimeoutMs || 300000;

    function presign(method, key, contentType, size) {
      return fetch(workerUrl + '/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: method,
          key: key,
          contentType: contentType || '',
          size: size || 0,
          token: token
        })
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok || !j.url) {
            throw new Error((j && j.error) || ('Presign failed (HTTP ' + r.status + ')'));
          }
          return j.url;
        });
      });
    }

    return {
      uploadFile: function (file, key, onProgress) {
        if (file.size > maxSizeMB * 1024 * 1024) {
          return Promise.reject(new Error('File bigger than ' + maxSizeMB + 'MB'));
        }
        return presign('PUT', key, file.type, file.size).then(function (url) {
          return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('PUT', url);
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
            // RACE-FIX: abort + reject on timeout so the caller can mark the
            // file FAILED and offer retry instead of hanging forever.
            xhr.timeout = uploadTimeoutMs;
            xhr.ontimeout = function () {
              try { xhr.abort(); } catch (e) {}
              reject(new Error('Upload timed out. Please retry this file.'));
            };
            if (typeof onProgress === 'function') {
              xhr.upload.onprogress = function (e) {
                if (e.lengthComputable) onProgress(e.loaded, e.total);
              };
            }
            xhr.onload = function () {
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else reject(new Error('Upload failed (HTTP ' + xhr.status + ')'));
            };
            xhr.onerror = function () { reject(new Error('Network error during upload')); };
            xhr.send(file);
          });
        });
      },

      getDownloadUrl: function (key) {
        return presign('GET', key, '', 0);
      },

      deleteFile: function (key) {
        return presign('DELETE', key, '', 0).then(function (url) {
          return fetch(url, { method: 'DELETE' }).then(function (r) {
            if (r.status >= 200 && r.status < 300) return;
            throw new Error('Delete failed (HTTP ' + r.status + ')');
          });
        });
      }
    };
  }

  // ---------- public API ----------
  StorageService.prototype.init = function (cfg) {
    if (!cfg || !cfg.provider) throw new Error('No storage provider configured');
    if (cfg.provider === 'r2') {
      if (!cfg.workerUrl || !cfg.uploadToken) throw new Error('R2 worker URL/token missing');
      provider = R2Adapter(cfg);
    } else {
      throw new Error('Unknown storage provider: ' + cfg.provider);
    }
  };

  StorageService.prototype.uploadFile = function (file, key, onProgress) {
    if (!provider) return Promise.reject(new Error('Storage not configured'));
    return provider.uploadFile(file, key, onProgress);
  };

  StorageService.prototype.getDownloadUrl = function (key) {
    if (!provider) return Promise.reject(new Error('Storage not configured'));
    return provider.getDownloadUrl(key);
  };

  StorageService.prototype.deleteFile = function (key) {
    if (!provider) return Promise.reject(new Error('Storage not configured'));
    return provider.deleteFile(key);
  };

  window.StorageService = new StorageService();
})();
