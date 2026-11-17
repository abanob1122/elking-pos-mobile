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
   */
  async function derivePBKDF2(password, saltHex, iterations = 200000) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode(saltHex),
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
      // 1. فحص PBKDF2 مع 200,000 دورة (النسق الحالي المعتمد)
      const candidate200k = await derivePBKDF2(plainPassword, targetSalt, 200000);
      if (timingSafeEqual(candidate200k, targetHash)) {
        return true;
      }

      // 2. فحص PBKDF2 القديم مع 100,000 دورة (V6/V7 توافق رجعي)
      const candidate100k = await derivePBKDF2(plainPassword, targetSalt, 100000);
      if (timingSafeEqual(candidate100k, targetHash)) {
        return true;
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
