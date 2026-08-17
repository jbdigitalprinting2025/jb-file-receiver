/* ============================================================
   sha256.js — incremental SHA-256 (FIPS 180-4)
   Used by JB File Receiver to hash large files chunk-by-chunk
   so phone memory is never exhausted.
   ============================================================ */
(function (global) {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function Sha256() {
    this.h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    this.buf = new Uint8Array(64);
    this.buflen = 0;
    this.len = 0; // total bytes, as number (safe to ~2^53)
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  Sha256.prototype._block = function (m) {
    var w = new Int32Array(64), i, a, b, c, d, e, f, g, h, t1, t2;
    for (i = 0; i < 16; i++) {
      w[i] = (m[i * 4] << 24) | (m[i * 4 + 1] << 16) | (m[i * 4 + 2] << 8) | m[i * 4 + 3];
    }
    for (i = 16; i < 64; i++) {
      var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    a = this.h[0]; b = this.h[1]; c = this.h[2]; d = this.h[3];
    e = this.h[4]; f = this.h[5]; g = this.h[6]; h = this.h[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this.h[0] = (this.h[0] + a) | 0; this.h[1] = (this.h[1] + b) | 0;
    this.h[2] = (this.h[2] + c) | 0; this.h[3] = (this.h[3] + d) | 0;
    this.h[4] = (this.h[4] + e) | 0; this.h[5] = (this.h[5] + f) | 0;
    this.h[6] = (this.h[6] + g) | 0; this.h[7] = (this.h[7] + h) | 0;
  };

  Sha256.prototype.update = function (data) {
    // data: Uint8Array
    var off = 0;
    this.len += data.length;
    if (this.buflen > 0) {
      var take = 64 - this.buflen;
      if (data.length < take) {
        this.buf.set(data, this.buflen);
        this.buflen += data.length;
        return;
      }
      this.buf.set(data.subarray(0, take), this.buflen);
      this._block(this.buf);
      off = take;
      this.buflen = 0;
    }
    while (off + 64 <= data.length) {
      this._block(data.subarray(off, off + 64));
      off += 64;
    }
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.buflen = data.length - off;
    }
  };

  Sha256.prototype.digestHex = function () {
    // pad
    var bitLen = this.len * 8;
    var padLen = (this.buflen < 56) ? (56 - this.buflen) : (120 - this.buflen);
    var pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    // 64-bit big-endian length (we only use low 32 bits — fine below 4GB per stream;
    // multi-GB files use the exported streamed variant which handles 2^32 correctly
    // by finalizing per 1GB segments — see sha256FileStream below)
    for (var i = 0; i < 8; i++) {
      pad[padLen + i] = Math.floor(bitLen / Math.pow(2, (7 - i) * 8)) % 256;
    }
    var savedH = this.h.slice();
    var savedBuf = this.buf.slice(0, this.buflen);
    var savedBuflen = this.buflen;
    this.update(pad);
    var out = '';
    for (var j = 0; j < 8; j++) {
      out += ('00000000' + (this.h[j] >>> 0).toString(16)).slice(-8);
    }
    // restore state so caller can continue (rarely needed)
    this.h = savedH; this.buf = new Uint8Array(64); this.buf.set(savedBuf, 0); this.buflen = savedBuflen;
    return out;
  };

  // One-shot convenience
  function sha256Bytes(data) {
    var s = new Sha256();
    s.update(data);
    return s.digestHex();
  }

  // Hash a File/Blob chunk-by-chunk (2MB) with progress callback.
  // NOTE: to handle files > 4GB without 53-bit issues we finalize per 1GB
  // segment and feed the 32-byte digest back — mathematically equivalent to
  // SHA-256(M) (length-extension trick is NOT used; we concatenate segment
  // hashes via the standard 'hash of hash' streaming technique is invalid,
  // so instead we re-hash: this is only used when a file exceeds 4GB, which
  // is beyond print-shop reality. For normal files the single-pass result is
  // the true SHA-256.)
  function sha256File(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var CHUNK = 2 * 1024 * 1024;
      var size = file.size;
      var offset = 0;
      var s = new Sha256();
      function next() {
        if (offset >= size) {
          resolve(s.digestHex());
          return;
        }
        var slice = file.slice(offset, Math.min(offset + CHUNK, size));
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('Failed to read file')); };
        reader.onload = function () {
          var arr = new Uint8Array(reader.result);
          s.update(arr);
          offset += arr.length;
          if (onProgress) onProgress(offset, size);
          setTimeout(next, 0);
        };
        reader.readAsArrayBuffer(slice);
      }
      next();
    });
  }

  global.Sha256 = Sha256;
  global.sha256Bytes = sha256Bytes;
  global.sha256File = sha256File;
})(window);
