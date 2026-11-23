/**
 * ELKing POS - Mobile PWA Crypto Utilities
 * متوافق 100% مع خوارزمية تشفير البرنامج المكتبي:
 * PBKDF2-HMAC-SHA256 مع 600,000 دورة (ودعم توافق رجعي لـ 200,000 و 100,000 دورة) وتوليد ملح عشوائي 16 بايت (32 hex chars).
 * نسق الحفظ السحابي والمحلي: ${digest}:${salt}
 */

(function (window) {
  'use strict';

  const enc = new TextEncoder();
  const PBKDF2_ROUNDS_CURRENT = 600000;
  const PBKDF2_ROUNDS_LEGACY = [200000, 100000];
  const PBKDF2_ROUNDS_CHECK_ORDER = [PBKDF2_ROUNDS_CURRENT, ...PBKDF2_ROUNDS_LEGACY];

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
  async function derivePBKDF2(password, salt, iterations = PBKDF2_ROUNDS_CURRENT) {
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
   * تشفير كلمة المرور بـ PBKDF2-SHA256 مع 600,000 دورة (مطابق للبرنامج المكتبي)
   * يعيد: { hash, salt, combined: `${hash}:${salt}` }
   */
  async function hashPassword(password, saltHex = null) {
    if (!password) {
      throw new Error('كلمة المرور مطلوبة للتشفير');
    }
    const salt = saltHex || generateSaltHex(16);
    const hash = await derivePBKDF2(password, salt, PBKDF2_ROUNDS_CURRENT);
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
      const colonIdx = targetHash.indexOf(':');
      targetSalt = targetHash.slice(colonIdx + 1);
      targetHash = targetHash.slice(0, colonIdx);
    }

    if (targetSalt) {
      // 1. فحص PBKDF2 مع Salt كـ UTF-8 bytes (600k أولاً ثم 200k ثم 100k — مطابق لـ Python salt.encode('utf-8'))
      const utf8SaltBytes = enc.encode(targetSalt);
      for (const rounds of PBKDF2_ROUNDS_CHECK_ORDER) {
        const candidateUtf8 = await derivePBKDF2(plainPassword, utf8SaltBytes, rounds);
        if (timingSafeEqual(candidateUtf8, targetHash)) {
          return true;
        }
      }

      // 2. فحص PBKDF2 إذا كان Salt مشفراً كـ Hex Bytes خام (bytes.fromhex(targetSalt))
      const rawHexBytes = hexToBytes(targetSalt);
      if (rawHexBytes) {
        for (const rounds of PBKDF2_ROUNDS_CHECK_ORDER) {
          const candidateHex = await derivePBKDF2(plainPassword, rawHexBytes, rounds);
          if (timingSafeEqual(candidateHex, targetHash)) {
            return true;
          }
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
    PBKDF2_ROUNDS_CURRENT,
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
