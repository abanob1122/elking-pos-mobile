/**
 * ELKing POS - Mobile PWA Crypto Utilities
 * متوافق 100% مع خوارزمية تشفير البرنامج المكتبي:
 * PBKDF2-HMAC-SHA256 مع 200,000 دورة وتوليد ملح عشوائي 16 بايت (32 hex chars).
 * نسق الحفظ السحابي والمحلي: ${digest}:${salt}
 */

(function (window) {
  'use strict';

  const enc = new TextEncoder();

  /**
   * توليد ملح عشوائي مشفر بعدد بايتات محدد (افتراضياً 16 بايت = 32 رمز hex)
   */
  function generateSaltHex(numBytes = 16) {
    const bytes = new Uint8Array(numBytes);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * تحويل بايتات ArrayBuffer إلى نص ست عشري (hex)
   */
  function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * تحويل نص ست عشري (hex) إلى Uint8Array بايتات خام
   */
  function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0) return null;
    try {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        const val = parseInt(hex.substring(i, i + 2), 16);
        if (isNaN(val)) return null;
        bytes[i / 2] = val;
      }
      return bytes;
    } catch (_) {
      return null;
    }
  }

  /**
   * مقارنة آمنة زمنياً (Constant-time string comparison) لمنع هجمات التوقيت
   */
  function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * اشتقاق تجزئة PBKDF2-SHA256
   * يقبل الملح كـ نص (UTF-8 bytes) أو كـ مصفوفة بايتات Uint8Array مباشرة
   */
  async function derivePBKDF2(password, salt, iterations = 200000) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    const saltBuffer = (salt instanceof Uint8Array || salt instanceof ArrayBuffer)
      ? salt
      : enc.encode(String(salt));

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBuffer,
        iterations: iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );

    return bufferToHex(bits);
  }

  /**
   * حساب SHA-256 مباشر (للحسابات القديمة V6/V7 دون ملح)
   */
  async function digestSHA256(str) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(str));
    return bufferToHex(hashBuffer);
  }

  /**
   * تشفير كلمة المرور بـ PBKDF2-SHA256 مع 200,000 دورة
   * يعيد: { hash, salt, combined: `${hash}:${salt}` }
   */
  async function hashPassword(password, saltHex = null) {
    if (!password) {
      throw new Error('كلمة المرور مطلوبة للتشفير');
    }
    const salt = saltHex || generateSaltHex(16);
    const hash = await derivePBKDF2(password, salt, 200000);
    return {
      hash: hash,
      salt: salt,
      combined: `${hash}:${salt}`,
    };
  }

  /**
   * التحقق من صحة كلمة المرور مقابل النص المخزن (يدعم PBKDF2 المدمج hash:salt، والمفصول، وSHA-256 القديم)
   */
  async function verifyPassword(plainPassword, storedHashOrCombined, separateSalt = '') {
    if (!plainPassword || !storedHashOrCombined) return false;

    let targetHash = storedHashOrCombined.trim();
    let targetSalt = (separateSalt || '').trim();

    // فحص إذا كان النسق مدمجاً ${hash}:${salt}
    if (!targetSalt && targetHash.includes(':')) {
      const parts = targetHash.split(':');
      targetHash = parts[0];
      targetSalt = parts[1] || '';
    }

    if (targetSalt) {
      // 1. فحص PBKDF2 مع 200,000 دورة مع Salt كـ UTF-8 bytes (المطابق المعتمد لـ Python salt.encode('utf-8'))
      const candidate200kUtf8 = await derivePBKDF2(plainPassword, enc.encode(targetSalt), 200000);
      if (timingSafeEqual(candidate200kUtf8, targetHash)) {
        return true;
      }

      // 2. فحص PBKDF2 مع 100,000 دورة مع Salt كـ UTF-8 bytes (V6/V7 توافق رجعي)
      const candidate100kUtf8 = await derivePBKDF2(plainPassword, enc.encode(targetSalt), 100000);
      if (timingSafeEqual(candidate100kUtf8, targetHash)) {
        return true;
      }

      // 3. فحص PBKDF2 إذا كان Salt مشفراً كـ Hex Bytes خام (bytes.fromhex(targetSalt))
      const rawHexBytes = hexToBytes(targetSalt);
      if (rawHexBytes) {
        const candidate200kHex = await derivePBKDF2(plainPassword, rawHexBytes, 200000);
        if (timingSafeEqual(candidate200kHex, targetHash)) {
          return true;
        }

        const candidate100kHex = await derivePBKDF2(plainPassword, rawHexBytes, 100000);
        if (timingSafeEqual(candidate100kHex, targetHash)) {
          return true;
        }
      }

      return false;
    }

    // لا يوجد ملح: فحص SHA-256 مباشر (V6 قديم جداً) أو مقارنة نصية مجردة
    const shaCandidate = await digestSHA256(plainPassword);
    if (timingSafeEqual(shaCandidate, targetHash)) {
      return true;
    }

    return timingSafeEqual(plainPassword, targetHash);
  }

  const CryptoUtils = {
    generateSaltHex,
    hexToBytes,
    hashPassword,
    verifyPassword,
    derivePBKDF2,
    digestSHA256,
    timingSafeEqual,
  };

  // دعم المتصفحات وبيئة Node.js للاختبار
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CryptoUtils;
  } else {
    window.CryptoUtils = CryptoUtils;
  }
})(typeof window !== 'undefined' ? window : globalThis);
