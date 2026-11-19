/**
 * ELKing POS - Mobile PWA Supabase REST Client
 * اتصال مباشر وآمن بخادم Supabase الحقيقي دون وسيط
 */

(function (window) {
  'use strict';

  const STORAGE_KEYS = {
    CONFIG: 'elking_pwa_config',
    SESSION: 'elking_pwa_session',
    ACTIVE_BRANCH: 'elking_pwa_active_branch',
    THEME: 'elking_pwa_theme',
    LAST_STORE_CODE: 'elking_pwa_last_store_code',
  };

  /**
   * قراءة المبلغ الفعلي للفاتورة بترتيب الأولوية الصحيح وحماية تلقائية من القيم الصفرية
   * الأولوية: net_total -> total_amount / total -> (subtotal - discount + tax) -> subtotal -> paid_amount -> 0
   */
  function getSaleAmount(sale) {
    if (!sale) return 0;
    const net = Number(sale.net_total);
    if (!isNaN(net) && net > 0) return net;

    const total = Number(sale.total_amount !== undefined && sale.total_amount !== null && Number(sale.total_amount) > 0 ? sale.total_amount : sale.total);
    if (!isNaN(total) && total > 0) return total;

    const sub = Number(sale.subtotal || 0);
    const disc = Number(sale.discount || 0) + Number(sale.coupon_discount || 0) + Number(sale.points_discount || 0);
    const tax = Number(sale.tax_amount || 0);
    const calc = sub - disc + tax;
    if (!isNaN(calc) && calc > 0) return calc;

    if (!isNaN(sub) && sub > 0) return sub;

    const paid = Number(sale.paid_amount || 0);
    if (!isNaN(paid) && paid > 0) return paid;

    return 0;
  }

  /**
   * توحيد وتصنيف طريقة الدفع عبر مختلف المسميات باللغتين العربية والإنجليزية
   */
  function categorizePayment(methodStr) {
    if (!methodStr) return 'other';
    const m = String(methodStr).toLowerCase().trim();
    if (m.includes('card') || m.includes('فيزا') || m.includes('شبكة') || m.includes('بطاقة') || m.includes('visa') || m.includes('mada') || m.includes('master')) return 'card';
    if (m.includes('insta') || m.includes('انستا') || m.includes('إنستا')) return 'instapay';
    if (m.includes('wallet') || m.includes('محفظة') || m.includes('فودافون') || m.includes('vodafone') || m.includes('اورنج') || m.includes('orange') || m.includes('we pay')) return 'wallet';
    if (m.includes('cash') || m.includes('نقدي') || m.includes('كاش')) return 'cash';
    if (m.includes('credit') || m.includes('آجل') || m.includes('اجل')) return 'credit';
    return 'other';
  }

  /**
   * التحقق مما إذا كانت الفاتورة ملغاة أو مرتجعة لاستبعادها من إجماليات المبيعات
   */
  function isSaleExcluded(sale) {
    if (!sale) return true;
    const st = String(sale.status || '').toLowerCase().trim();
    const invNo = String(sale.invoice_no || '').trim().toUpperCase();
    return (
      st === 'cancelled' ||
      st === 'voided' ||
      st === 'ملغاة' ||
      st === 'ملغي' ||
      st === 'مرتجع' ||
      sale.is_returned === true ||
      sale.is_deleted === true ||
      invNo.startsWith('RET-') ||
      (sale.net_total !== undefined && sale.net_total !== null && Number(sale.net_total) < 0)
    );
  }

  /**
   * دوال التوقيت الموحد لمصر (Africa/Cairo) وحساب النطاق نصف المفتوح [start, next_day_start) بـ UTC
   */
  const CAIRO_TZ = 'Africa/Cairo';

  function _formatYmdInCairo(dateObj) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: CAIRO_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(dateObj);
      const map = {};
      for (const p of parts) {
        if (p.type !== 'literal') map[p.type] = p.value;
      }
      if (map.year && map.month && map.day) {
        return `${map.year}-${map.month}-${map.day}`;
      }
    } catch (_) {}
    // احتياطي UTC+2 في البيئات التي لا تدعم ICU
    const shifted = new Date(dateObj.getTime() + 2 * 3600 * 1000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getCairoDateStr(dateObj = new Date()) {
    return _formatYmdInCairo(dateObj instanceof Date ? dateObj : new Date(dateObj));
  }

  function _addDaysToYmd(ymdStr, days) {
    const [y, m, d] = String(ymdStr).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0), 0, 0, 0, 0));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  function getCairoOffsetDateStr(daysOffset = 0) {
    const todayCairo = getCairoDateStr(new Date());
    return _addDaysToYmd(todayCairo, daysOffset);
  }

  function _getCairoOffsetMs(utcDate) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: CAIRO_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(utcDate);
      const map = {};
      for (const p of parts) {
        if (p.type !== 'literal') map[p.type] = p.value;
      }
      const hr = map.hour === '24' ? '00' : map.hour;
      const wallAsUtc = Date.UTC(
        Number(map.year),
        Number(map.month) - 1,
        Number(map.day),
        Number(hr),
        Number(map.minute),
        Number(map.second),
        0
      );
      return wallAsUtc - utcDate.getTime();
    } catch (_) {
      return 2 * 3600 * 1000;
    }
  }

  function cairoMidnightToUtcDate(ymdStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || '').trim());
    if (!match) {
      throw new Error(`صيغة التاريخ غير صالحة: ${ymdStr}`);
    }
    const nominalUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
    const off1 = _getCairoOffsetMs(new Date(nominalUtc));
    const cand1 = nominalUtc - off1;
    const off2 = _getCairoOffsetMs(new Date(cand1));
    return new Date(nominalUtc - off2);
  }

  function getCairoRangeUtc(dateFrom, dateTo) {
    const cleanFrom = dateFrom ? String(dateFrom).trim() : null;
    const cleanTo = dateTo ? String(dateTo).trim() : null;
    if (cleanFrom && cleanTo && cleanFrom > cleanTo) {
      throw new Error('تاريخ البداية يجب أن يكون قبل أو مساوياً لتاريخ النهاية');
    }
    const startIso = cleanFrom ? cairoMidnightToUtcDate(cleanFrom).toISOString() : null;
    const endExclusiveIso = cleanTo ? cairoMidnightToUtcDate(_addDaysToYmd(cleanTo, 1)).toISOString() : null;
    return { startIso, endExclusiveIso };
  }

  /**
   * استخراج الجزء النقدي (الكاش) من الفاتورة بما في ذلك الفواتير ذات الدفع المتعدد (split_details)
   */
  function getSaleCashAmount(sale) {
    if (!sale || isSaleExcluded(sale)) return 0;
    let splitObj = null;
    if (sale.split_details) {
      if (typeof sale.split_details === 'object') {
        splitObj = sale.split_details;
      } else if (typeof sale.split_details === 'string') {
        try { splitObj = JSON.parse(sale.split_details); } catch (_) {}
      }
    }
    if (splitObj && typeof splitObj === 'object' && Object.keys(splitObj).length > 0) {
      let cashPart = 0;
      for (const [k, v] of Object.entries(splitObj)) {
        const splitAmt = Number(v || 0);
        if (splitAmt > 0 && categorizePayment(k) === 'cash') {
          cashPart += splitAmt;
        }
      }
      return cashPart;
    }
    const cat = categorizePayment(sale.payment_method);
    return cat === 'cash' ? getSaleAmount(sale) : 0;
  }

  /**
   * التحقق مما إذا كانت حركة الخزينة مصروفاً تشغيلياً فعلياً فقط
   * (يستبعد توريد_للخزينة وتغذية_وردية والإيداعات)
   */
  function isActualExpense(log) {
    if (!log) return false;
    const type = String(log.trans_type || log.type || '').trim();
    const cat = String(log.category || '').trim();
    const notes = String(log.notes || log.note || '').trim();
    const combined = `${type} ${cat} ${notes}`.toLowerCase();

    if (
      type === 'توريد_للخزينة' ||
      type === 'توريد للخزينة' ||
      type === 'تغذية_وردية' ||
      type === 'تغذية وردية' ||
      combined.includes('توريد_للخزينة') ||
      combined.includes('توريد للخزينة') ||
      combined.includes('تغذية_وردية') ||
      combined.includes('تغذية وردية') ||
      type === 'إيداع' ||
      type === 'ايداع' ||
      type === 'وارد'
    ) {
      return false;
    }

    const allowedExpenseTypes = ['مصروف', 'مصروفات', 'مصروف عام', 'مصروفات وردية', 'صرف', 'expense'];
    const typeLower = type.toLowerCase();
    const catLower = cat.toLowerCase();
    return (
      allowedExpenseTypes.includes(typeLower) ||
      allowedExpenseTypes.includes(catLower) ||
      typeLower.includes('مصروف') ||
      catLower.includes('مصروف')
    );
  }

  /**
   * التحقق مما إذا كانت حركة الخزينة تغذية وردية (صادر من الخزينة للدرج وليست مصروفاً)
   */
  function isShiftFeed(log) {
    if (!log) return false;
    const type = String(log.trans_type || log.type || '').trim();
    const cat = String(log.category || '').trim();
    const combined = `${type} ${cat}`.toLowerCase();
    return (
      type === 'تغذية_وردية' ||
      type === 'تغذية وردية' ||
      combined.includes('تغذية_وردية') ||
      combined.includes('تغذية وردية')
    );
  }

  const storage = {
    getItem(key) {
      try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      } catch (_) {
        return null;
      }
    },
    setItem(key, val) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, val);
      } catch (_) {}
    },
    removeItem(key) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
      } catch (_) {}
    },
  };

  const DEFAULT_SUPABASE_URL = 'https://ohhfnbjzwpntzkawgwbk.supabase.co';
  const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_bu8eKSNTAr_OjpxNRNkBoA_s71lo9Xf';

  const DEFAULT_CONFIG = {
    url: DEFAULT_SUPABASE_URL,
    anonKey: DEFAULT_SUPABASE_ANON_KEY,
    storeId: '',
    storeCode: '',
    storeName: 'إلكينج POS',
  };

  class SupabaseClient {
    constructor() {
      this.config = this._loadConfig();
      this.session = this._loadSession();
      this.activeBranchId = storage.getItem(STORAGE_KEYS.ACTIVE_BRANCH) || 'ALL';
      this._branchesCache = null;
      this._activeRealtimeUnsubs = new Set();
    }

    _loadConfig() {
      try {
        const saved = storage.getItem(STORAGE_KEYS.CONFIG);
        const parsed = saved ? JSON.parse(saved) : {};
        return {
          ...DEFAULT_CONFIG,
          ...parsed,
          url: DEFAULT_SUPABASE_URL,
          anonKey: DEFAULT_SUPABASE_ANON_KEY,
        };
      } catch (e) {
        return { ...DEFAULT_CONFIG };
      }
    }

    saveConfig(newConfig) {
      const sanitized = {
        ...newConfig,
        url: DEFAULT_SUPABASE_URL,
        anonKey: DEFAULT_SUPABASE_ANON_KEY,
      };
      this.config = { ...this.config, ...sanitized };
      this._branchesCache = null;
      storage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(this.config));
    }

    _loadSession() {
      try {
        const saved = storage.getItem(STORAGE_KEYS.SESSION);
        return saved ? JSON.parse(saved) : null;
      } catch (e) {
        return null;
      }
    }

    getSession() {
      return this.session;
    }

    saveSession(userData) {
      this.session = userData;
      storage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(userData));
    }

    clearSession() {
      this.session = null;
      this._branchesCache = null;
      storage.removeItem(STORAGE_KEYS.SESSION);
    }

    removeAllChannels() {
      if (this._activeRealtimeUnsubs && this._activeRealtimeUnsubs.size > 0) {
        for (const unsub of Array.from(this._activeRealtimeUnsubs)) {
          try { unsub(); } catch (_) {}
        }
        this._activeRealtimeUnsubs.clear();
      }
    }

    logout() {
      this.removeAllChannels();
      this.clearSession();
      this.setActiveBranch('ALL');
      this.config = { ...DEFAULT_CONFIG };
      storage.removeItem(STORAGE_KEYS.CONFIG);
      storage.removeItem(STORAGE_KEYS.ACTIVE_BRANCH);
      storage.removeItem('elking_pwa_store_id');
      storage.removeItem('elking_pwa_store_name');
      storage.removeItem('elking_pwa_last_sync');
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
      } catch (_) {}
    }

    isLoggedIn() {
      return Boolean(this.session && this.session.username && this.session.store_id);
    }

    setActiveBranch(branchId) {
      this.activeBranchId = branchId || 'ALL';
      storage.setItem(STORAGE_KEYS.ACTIVE_BRANCH, this.activeBranchId);
    }

    getActiveBranch() {
      return this.activeBranchId;
    }

    /**
     * التحقق الإلزامي من وجود store_id صالح في الجلسة النشطة قبل أي استعلام أو تعديل
     */
    _requireSessionStoreId() {
      const sessionSid = (this.session && this.session.store_id)
        ? String(this.session.store_id).trim()
        : '';
      if (!sessionSid) {
        throw new Error('غير مصرح: معرّف المتجر (store_id) مفقود من الجلسة النشطة — يرجى تسجيل الدخول');
      }
      const cfgSid = (this.config && this.config.storeId)
        ? String(this.config.storeId).trim()
        : '';
      if (cfgSid && cfgSid !== sessionSid) {
        throw new Error('تعارض عزل المتاجر: الجلسة لا تخص المتجر الحالي');
      }
      return encodeURIComponent(sessionSid);
    }

    /**
     * واجهة الحراسة الموحّدة — تفوّض دائماً إلى _requireSessionStoreId()
     */
    _requireStoreId() {
      return this._requireSessionStoreId();
    }

    async _publicAuthRequest(endpoint, options = {}) {
      const url = `${this.config.url.replace(/\/+$/, '')}/rest/v1${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
      const headers = {
        'apikey': this.config.anonKey,
        'Authorization': `Bearer ${this.config.anonKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      };
      const fetchOptions = {
        method: options.method || 'GET',
        headers,
      };
      if (options.body !== undefined && options.body !== null) {
        if (typeof options.body === 'string') {
          const trimmed = options.body.trim();
          fetchOptions.body = trimmed === '' ? '{}' : options.body;
        } else {
          fetchOptions.body = JSON.stringify(options.body);
        }
      }
      const response = await fetch(url, fetchOptions);
      if (!response.ok) {
        let errBody;
        try {
          errBody = await response.json();
        } catch (_) {
          errBody = { message: await response.text() };
        }
        const err = new Error(errBody.message || `خطأ HTTP ${response.status}`);
        err.status = response.status;
        err.details = errBody;
        throw err;
      }
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }

    /**
     * تنفيذ طلب HTTP موحد ضد Supabase PostgREST — محروس إجبارياً بـ store_id الجلسة
     */
    async request(endpoint, options = {}) {
      // منع تماماً إرسال أي طلب جلب أو تعديل بيانات إذا غاب store_id عن الجلسة
      this._requireStoreId();
      return await this._publicAuthRequest(endpoint, options);
    }

    // =========================================================================
    // تسجيل الدخول المعزول بكود المتجر (Store Code) والتحقق من كلمة المرور
    // =========================================================================
    async resolveStoreCodeById(storeId) {
      const cleanId = String(storeId || '').trim();
      if (!cleanId) return null;
      const rows = await this._publicAuthRequest(
        `/stores?id=eq.${encodeURIComponent(cleanId)}&select=id,name,store_code&limit=1`
      );
      return rows && rows.length > 0 ? rows[0] : null;
    }

    async resolveStoreByCode(storeCode) {
      const cleanCode = String(storeCode || '').trim().toUpperCase();
      if (!cleanCode) return null;
      const rows = await this._publicAuthRequest(
        `/stores?store_code=eq.${encodeURIComponent(cleanCode)}&select=id,name,store_code&limit=1`
      );
      return rows && rows.length > 0 ? rows[0] : null;
    }

    async login(username, password, { storeCode = '', storeId = '' } = {}) {
      const cleanUser = (username || '').trim();
      const cleanCode = String(storeCode || '').trim().toUpperCase();
      const cleanStoreId = String(storeId || (this.config && this.config.storeId) || '').trim();

      if (!cleanCode && !cleanStoreId) {
        throw new Error('يرجى إدخال كود المتجر (Store Code) أولاً');
      }
      if (!cleanUser || !password) {
        throw new Error('يرجى إدخال اسم المستخدم وكلمة المرور');
      }

      let users = null;
      let resolvedStoreId = cleanStoreId;
      let resolvedStoreName = (this.config && this.config.storeName) || 'متجر إلكينج';
      let resolvedStoreCode = cleanCode;

      if (cleanCode) {
        // 1. الدخول المعزول عبر RPC verify_staff_login_by_code(p_store_code, p_username, p_password)
        try {
          const rpcRes = await this._publicAuthRequest('/rpc/verify_staff_login_by_code', {
            method: 'POST',
            body: {
              p_store_code: cleanCode,
              p_username: cleanUser,
              p_password: '',
            },
          });
          if (Array.isArray(rpcRes) && rpcRes.length > 0) {
            users = rpcRes;
          } else if (rpcRes && typeof rpcRes === 'object' && rpcRes.username) {
            users = [rpcRes];
          }
        } catch (rpcErr) {
          // التراجع فقط عند 404 (RPC غير منشورة بعد)، مع العزل الصارم بـ store_code -> store_id
          if (rpcErr && rpcErr.status !== 404 && !String(rpcErr.message || '').includes('PGRST202')) {
            throw rpcErr;
          }
        }

        if (!users || users.length === 0) {
          const stores = await this._publicAuthRequest(
            `/stores?store_code=eq.${encodeURIComponent(cleanCode)}&select=id,name,store_code&limit=1`
          );
          if (!stores || stores.length === 0 || !stores[0].id) {
            throw new Error('كود المتجر غير صحيح أو غير مسجل');
          }
          resolvedStoreId = String(stores[0].id).trim();
          resolvedStoreName = stores[0].name || resolvedStoreName;
          resolvedStoreCode = String(stores[0].store_code || cleanCode).trim().toUpperCase();

          const query = `/staff_users?store_id=eq.${encodeURIComponent(resolvedStoreId)}&username=eq.${encodeURIComponent(cleanUser)}&is_deleted=eq.false&limit=1`;
          users = await this._publicAuthRequest(query);
        }
      } else {
        // دخول من رابط QR يحتوي store_id صريح
        try {
          const rpcRes = await this._publicAuthRequest('/rpc/verify_staff_login', {
            method: 'POST',
            body: {
              p_store_id: cleanStoreId,
              p_username: cleanUser,
              p_password_hash: '',
            },
          });
          if (Array.isArray(rpcRes) && rpcRes.length > 0) {
            users = rpcRes;
          } else if (rpcRes && typeof rpcRes === 'object' && rpcRes.username) {
            users = [rpcRes];
          }
        } catch (_) {}

        if (!users || users.length === 0) {
          const query = `/staff_users?store_id=eq.${encodeURIComponent(cleanStoreId)}&username=eq.${encodeURIComponent(cleanUser)}&is_deleted=eq.false&limit=1`;
          users = await this._publicAuthRequest(query);
        }
      }

      if (!users || users.length === 0) {
        throw new Error('اسم المستخدم غير مسجل في هذا المتجر أو كود المتجر غير صحيح');
      }

      const user = users[0];
      const finalStoreId = String(user.store_id || resolvedStoreId || '').trim();
      if (!finalStoreId) {
        throw new Error('فشل التحقق من هوية المتجر للجلسة');
      }
      if (resolvedStoreId && finalStoreId !== resolvedStoreId) {
        throw new Error('خطأ عزل المستأجرين: بيانات المستخدم لا تطابق المتجر المحدد');
      }
      resolvedStoreName = user.store_name || resolvedStoreName;
      resolvedStoreCode = String(user.store_code || resolvedStoreCode || '').trim().toUpperCase();

      if (!user.is_active) {
        throw new Error('هذا الحساب معطّل من قِبل إدارة النظام');
      }

      const roleNormalized = (user.role || '').trim().toLowerCase();
      const allowedRoles = ['admin', 'manager', 'owner', 'مدير', 'ادمن', 'مسؤول', 'صاحب المحل', 'صاحب العمل', 'المدير'];
      const hasPrivilegedRole = allowedRoles.includes(roleNormalized)
        || roleNormalized.includes('admin')
        || roleNormalized.includes('manage')
        || roleNormalized.includes('owner')
        || roleNormalized.includes('مدير')
        || roleNormalized.includes('ادمن');

      if (!hasPrivilegedRole) {
        throw new Error('تطبيق صاحب المحل مخصص للمديرين والمسؤولين فقط (دورك الحالي: ' + (user.role || 'غير محدد') + ')');
      }

      const cryptoLib = (typeof window !== 'undefined' && window.CryptoUtils) || (typeof globalThis !== 'undefined' && globalThis.CryptoUtils) || (typeof CryptoUtils !== 'undefined' && CryptoUtils);
      const isMatch = await cryptoLib.verifyPassword(password, user.password_hash);
      if (!isMatch) {
        throw new Error('كلمة المرور غير صحيحة');
      }

      // تصفير أي بقايا جلسة سابقة وتثبيت إعدادات المتجر الجديد حصراً
      this.removeAllChannels();
      this.setActiveBranch('ALL');
      this.saveConfig({
        storeId: finalStoreId,
        storeName: resolvedStoreName,
        storeCode: resolvedStoreCode,
      });
      if (resolvedStoreCode) {
        storage.setItem(STORAGE_KEYS.LAST_STORE_CODE, resolvedStoreCode);
      }

      const session = {
        id: user.id,
        username: user.username,
        full_name: user.full_name || user.username,
        role: user.role,
        branch_id: user.branch_id,
        store_id: finalStoreId,
        store_code: resolvedStoreCode,
        store_name: resolvedStoreName,
        session_token: user.session_token || '',
        loggedInAt: new Date().toISOString(),
      };

      this.saveSession(session);
      return session;
    }

    // =========================================================================
    // الفروع والمتجر
    // =========================================================================
    async getBranches() {
      const sid = this._requireStoreId();
      const query = `/branches?store_id=eq.${sid}&order=is_main.desc,name.asc`;
      const branches = (await this.request(query)) || [];
      this._branchesCache = branches;
      return branches;
    }

    /**
     * بناء فلتر العزل الصارم (store_id + branch_id) لجداول sales, shifts, treasury_logs
     * يفرض دائماً store_id=eq.${storeId} لمنع تسرب أي بيانات لمتجر آخر
     */
    async _resolveBranchFilter(branchId = 'ALL') {
      const sid = this._requireStoreId();
      if (branchId && branchId !== 'ALL') {
        return `store_id=eq.${sid}&branch_id=eq.${encodeURIComponent(branchId)}`;
      }
      try {
        const branches = Array.isArray(this._branchesCache) && this._branchesCache.length > 0
          ? this._branchesCache
          : await this.getBranches();
        const branchIds = (branches || []).map(b => b && b.id).filter(Boolean);
        if (branchIds.length > 0) {
          return `store_id=eq.${sid}&branch_id=in.(${branchIds.join(',')})`;
        }
      } catch (_) {}
      return `store_id=eq.${sid}`;
    }

    async getStoreInfo() {
      const sid = this._requireStoreId();
      const query = `/stores?id=eq.${sid}&limit=1`;
      const stores = await this.request(query);
      return stores && stores.length > 0 ? stores[0] : null;
    }

    // =========================================================================
    // المؤشرات الرئيسية ولوحة المعلومات (Dashboard KPIs)
    // =========================================================================
    async getDashboardKPIs(branchId = 'ALL') {
      // حساب بداية اليوم ونهايته صراحةً بتوقيت مصر (Africa/Cairo) ثم تحويلهما لنطاق نصف مفتوح [start, next_day_start) بـ UTC
      const todayCairo = getCairoDateStr(new Date());
      const { startIso, endExclusiveIso } = getCairoRangeUtc(todayCairo, todayCairo);

      const sid = this._requireStoreId();
      const resolvedBranchClause = await this._resolveBranchFilter(branchId);
      const branchQueryPrefix = resolvedBranchClause ? `${resolvedBranchClause}&` : `store_id=eq.${sid}&`;
      const productBranchFilter = (branchId && branchId !== 'ALL') ? `&branch_id=eq.${encodeURIComponent(branchId)}` : '';

      const salesQuery = `/sales?${branchQueryPrefix}sale_date=gte.${startIso}&sale_date=lt.${endExclusiveIso}&or=(is_deleted.is.null,is_deleted.eq.false)&order=sale_date.desc`;
      const treasuryQuery = `/treasury_logs?${branchQueryPrefix}created_at=gte.${startIso}&created_at=lt.${endExclusiveIso}`;
      const shiftsQuery = `/shifts?${branchQueryPrefix}status=eq.Open&end_time=is.null&order=start_time.desc`;
      const lowStockQuery = `/products?store_id=eq.${sid}${productBranchFilter}&is_active=eq.true&or=(is_deleted.is.null,is_deleted.eq.false)&limit=5000`;

      // جلب كافة بيانات لوحة التحكم على التوازي عبر Promise.allSettled
      const [salesRes, treasuryRes, shiftsRes, productsRes] = await Promise.allSettled([
        this.request(salesQuery),
        this.request(treasuryQuery),
        this.request(shiftsQuery),
        this.request(lowStockQuery),
      ]);

      if (
        salesRes.status === 'rejected' &&
        treasuryRes.status === 'rejected' &&
        shiftsRes.status === 'rejected' &&
        productsRes.status === 'rejected'
      ) {
        throw salesRes.reason || new Error('تعذر الاتصال بالخادم السحابي');
      }

      // 1. مبيعات اليوم بتوقيت مصر (استبعاد الملغاة والمرتجعة بالكامل والمحذوفة)
      const sales = (salesRes.status === 'fulfilled' && salesRes.value) ? salesRes.value : [];
      const validSales = sales.filter(s => !isSaleExcluded(s));

      let totalSales = 0;
      let invoicesCount = validSales.length;
      let cashSales = 0;
      let cardSales = 0;
      let instapaySales = 0;
      let walletSales = 0;

      for (const s of validSales) {
        const amt = getSaleAmount(s);
        totalSales += amt;

        // دعم الدفع المقسم (split_details)
        let splitObj = null;
        if (s.split_details) {
          if (typeof s.split_details === 'object') {
            splitObj = s.split_details;
          } else if (typeof s.split_details === 'string') {
            try { splitObj = JSON.parse(s.split_details); } catch (_) {}
          }
        }

        if (splitObj && typeof splitObj === 'object' && Object.keys(splitObj).length > 0) {
          for (const [k, v] of Object.entries(splitObj)) {
            const splitAmt = Number(v || 0);
            if (splitAmt <= 0) continue;
            const cat = categorizePayment(k);
            if (cat === 'cash') cashSales += splitAmt;
            else if (cat === 'card') cardSales += splitAmt;
            else if (cat === 'instapay') instapaySales += splitAmt;
            else if (cat === 'wallet') walletSales += splitAmt;
          }
        } else {
          const cat = categorizePayment(s.payment_method);
          if (cat === 'cash') cashSales += amt;
          else if (cat === 'card') cardSales += amt;
          else if (cat === 'instapay') instapaySales += amt;
          else if (cat === 'wallet') walletSales += amt;
        }
      }

      // 2. مصروفات اليوم الفعلية فقط (مع استبعاد توريد_للخزينة وتغذية_وردية)
      let totalExpenses = 0;
      const seenExpenseKeys = new Set();
      try {
        const logs = (treasuryRes.status === 'fulfilled' && treasuryRes.value) ? treasuryRes.value : [];
        for (const l of logs) {
          if (isActualExpense(l)) {
            const absAmt = Math.abs(Number(l.amount || 0));
            totalExpenses += absAmt;
            if (l.local_trans_id) seenExpenseKeys.add(String(l.local_trans_id));
            if (l.shift_id) seenExpenseKeys.add(`shift_${l.shift_id}`);
          }
        }
      } catch (_) {}

      // 3. الورديات المفتوحة حالياً (Active Shifts) ونقدية الدرج
      let activeShifts = (shiftsRes.status === 'fulfilled' && shiftsRes.value) ? shiftsRes.value : [];
      let openShiftDrawerCash = 0;
      try {
        for (const sh of activeShifts) {
          const shStart = sh.start_time ? new Date(sh.start_time).getTime() : 0;
          const shUser = String(sh.username || sh.cashier_name || '').toLowerCase().trim();
          const shLocalId = Number(sh.local_shift_id || 0);

          // حساب مبيعات الوردية المفتوحة لحظياً من فواتير اليوم الصادرة بعد وقت البدء (مع دعم split_details للدفع المتعدد)
          let realTimeShiftSales = 0;
          let realTimeShiftCashSales = 0;
          for (const s of validSales) {
            const sDate = new Date(s.sale_date || s.created_at).getTime();
            const sUser = String(s.cashier_username || s.cashier_name || '').toLowerCase().trim();
            const sShiftId = Number(s.local_shift_id || s.shift_id || 0);

            const matchesShift = (shLocalId > 0 && sShiftId === shLocalId) ||
                                 (sDate >= shStart && (!shUser || !sUser || sUser === shUser));
            if (matchesShift) {
              const amt = getSaleAmount(s);
              realTimeShiftSales += amt;
              realTimeShiftCashSales += getSaleCashAmount(s);
            }
          }

          // استخدام القيمة الأكبر بين المحسوب لحظياً والمسجل في الوردية
          const totalShiftSales = Math.max(Number(sh.total_sales || 0), realTimeShiftSales);
          const shiftCashSales = Math.max(Number(sh.cash_sales || 0), realTimeShiftCashSales);
          sh.total_sales = totalShiftSales;
          sh.cash_sales = shiftCashSales;

          // دمج مصروفات الوردية إن وُجدت ولم تُحتسب في logs
          const shExp = Number(sh.expenses || 0);
          if (shExp > 0 && totalExpenses <= 0) {
            totalExpenses += shExp;
          }

          const openingCash = Number(sh.opening_cash ?? sh.starting_cash ?? 0);
          const cashReturns = Number(sh.cash_returns || 0);
          const expToDeduct = shExp > 0 ? shExp : totalExpenses;
          const currentInShift = openingCash + shiftCashSales - cashReturns - expToDeduct;
          openShiftDrawerCash += currentInShift;
        }
      } catch (_) {}

      // نقدية الدرج (كاش) — بعد خصم المصروفات النقدية والمرتجعات
      const netCashInHand = activeShifts.length > 0
        ? Math.max(0, openShiftDrawerCash)
        : Math.max(0, cashSales - totalExpenses);

      // 4. نواقص المخزون عبر كافة أصناف الفرع/المتجر (limit=5000)
      let lowStockCount = 0;
      let lowStockItems = [];
      try {
        const products = (productsRes.status === 'fulfilled' && productsRes.value) ? productsRes.value : [];
        for (const p of products) {
          const qty = Number(p.stock_quantity ?? p.stock_qty ?? 0);
          const min = Number(p.min_stock ?? 5);
          if (qty <= min) {
            lowStockCount++;
            if (lowStockItems.length < 8) {
              lowStockItems.push({
                id: p.id,
                name: p.product_name || p.name,
                stock: qty,
                minStock: min,
                barcode: p.barcode_ean13 || p.barcode || '',
              });
            }
          }
        }
      } catch (_) {}

      return {
        totalSales,
        invoicesCount,
        cashSales,
        cardSales,
        instapaySales,
        walletSales,
        totalExpenses,
        netCashInHand,
        activeShiftsCount: activeShifts.length,
        activeShifts,
        lowStockCount,
        lowStockItems,
      };
    }

    // =========================================================================
    // المبيعات والفواتير (Sales & Invoices)
    // =========================================================================
    async getSales({ branchId = 'ALL', date = null, dateFrom = null, dateTo = null, paymentMethod = null, search = '', limit = 50, offset = 0 } = {}) {
      const filters = [];
      const sid = this._requireStoreId();
      const branchClause = await this._resolveBranchFilter(branchId);
      filters.push(branchClause || `store_id=eq.${sid}`);
      filters.push('or=(is_deleted.is.null,is_deleted.eq.false)');

      const effectiveFrom = dateFrom || date || null;
      const effectiveTo = dateTo || date || null;
      if (effectiveFrom || effectiveTo) {
        const { startIso, endExclusiveIso } = getCairoRangeUtc(effectiveFrom, effectiveTo);
        if (startIso) filters.push(`sale_date=gte.${startIso}`);
        if (endExclusiveIso) filters.push(`sale_date=lt.${endExclusiveIso}`);
      }

      if (paymentMethod && paymentMethod !== 'ALL') {
        const pm = String(paymentMethod).toLowerCase().trim();
        if (pm === 'cash' || pm === 'كاش' || pm === 'نقدي') {
          filters.push(`or=(payment_method.ilike.*كاش*,payment_method.ilike.*نقدي*,payment_method.ilike.*cash*)`);
        } else if (pm === 'card' || pm === 'فيزا' || pm === 'شبكة' || pm === 'بطاقة') {
          filters.push(`or=(payment_method.ilike.*فيزا*,payment_method.ilike.*شبكة*,payment_method.ilike.*card*,payment_method.ilike.*visa*,payment_method.ilike.*بطاقة*)`);
        } else if (pm === 'insta' || pm === 'انستا' || pm === 'إنستا' || pm === 'instapay') {
          filters.push(`or=(payment_method.ilike.*انستا*,payment_method.ilike.*insta*,payment_method.ilike.*إنستا*)`);
        } else if (pm === 'wallet' || pm === 'محفظة' || pm === 'فودافون' || pm === 'vodafone') {
          filters.push(`or=(payment_method.ilike.*محفظة*,payment_method.ilike.*wallet*,payment_method.ilike.*فودافون*,payment_method.ilike.*vodafone*,payment_method.ilike.*اورنج*,payment_method.ilike.*orange*,payment_method.ilike.*we pay*)`);
        } else if (pm === 'credit' || pm === 'آجل' || pm === 'اجل') {
          filters.push(`or=(payment_method.ilike.*آجل*,payment_method.ilike.*اجل*,payment_method.ilike.*credit*)`);
        } else {
          filters.push(`payment_method=ilike.*${encodeURIComponent(paymentMethod)}*`);
        }
      }

      if (search && search.trim()) {
        const s = encodeURIComponent(search.trim());
        filters.push(`or=(invoice_no.ilike.*${s}*,customer_name.ilike.*${s}*,customer_phone.ilike.*${s}*)`);
      }

      const filterPrefix = filters.length > 0 ? `${filters.join('&')}&` : '';
      const query = `/sales?${filterPrefix}order=sale_date.desc&limit=${limit}&offset=${offset}`;
      return (await this.request(query)) || [];
    }

    async getSaleDetails(saleId) {
      if (!saleId) return [];
      const sid = this._requireStoreId();
      const query = `/sale_items?store_id=eq.${sid}&sale_id=eq.${encodeURIComponent(saleId)}&order=id.asc`;
      return (await this.request(query)) || [];
    }

    async getSaleItems(saleId) {
      return await this.getSaleDetails(saleId);
    }

    // =========================================================================
    // المخزون والأصناف (Inventory & Products)
    // =========================================================================
    async getProducts({ branchId = 'ALL', search = '', lowStockOnly = false, limit = 100, offset = 0 } = {}) {
      let filters = [`store_id=eq.${this._requireStoreId()}`, 'is_active=eq.true', 'or=(is_deleted.is.null,is_deleted.eq.false)'];

      if (branchId && branchId !== 'ALL') {
        // جميع الأصناف مرتبطة بفرع محدد (branch_id NOT NULL في المخطط)
        filters.push(`branch_id=eq.${branchId}`);
      }

      if (search && search.trim()) {
        const s = encodeURIComponent(search.trim());
        filters.push(`or=(product_name.ilike.*${s}*,barcode_ean13.ilike.*${s}*)`);
      }

      const effectiveLimit = lowStockOnly ? Math.max(limit, 5000) : limit;
      const query = `/products?${filters.join('&')}&order=product_name.asc&limit=${effectiveLimit}&offset=${offset}`;
      const products = (await this.request(query)) || [];

      if (lowStockOnly) {
        return products.filter(p => {
          const qty = Number(p.stock_quantity ?? p.stock_qty ?? 0);
          const min = Number(p.min_stock ?? 5);
          return qty <= min;
        });
      }

      return products;
    }

    async updateProduct(productId, updates) {
      if (!productId) throw new Error('معرف الصنف مطلوب');
      const payload = {
        ...updates,
        updated_at: new Date().toISOString(),
      };
      return await this.request(`/products?id=eq.${encodeURIComponent(productId)}&store_id=eq.${this._requireStoreId()}`, {
        method: 'PATCH',
        body: payload,
        headers: { 'Prefer': 'return=representation' },
      });
    }

    // =========================================================================
    // الخزينة والورديات (Treasury & Shifts)
    // =========================================================================
    async getTreasuryLogs({ branchId = 'ALL', limit = 50, offset = 0 } = {}) {
      const sid = this._requireStoreId();
      const branchClause = await this._resolveBranchFilter(branchId);
      const scopedClause = branchClause && branchClause.includes('store_id=eq.')
        ? branchClause
        : `store_id=eq.${sid}`;
      const query = `/treasury_logs?${scopedClause}&order=created_at.desc&limit=${limit}&offset=${offset}`;
      return (await this.request(query)) || [];
    }

    async getShifts({ branchId = 'ALL', limit = 30, offset = 0 } = {}) {
      const sid = this._requireStoreId();
      const branchClause = await this._resolveBranchFilter(branchId);
      const scopedClause = branchClause && branchClause.includes('store_id=eq.')
        ? branchClause
        : `store_id=eq.${sid}`;
      const query = `/shifts?${scopedClause}&order=start_time.desc&limit=${limit}&offset=${offset}`;
      return (await this.request(query)) || [];
    }

    // =========================================================================
    // إدارة الموظفين والمستخدمين (Staff Management)
    // =========================================================================
    async getStaffUsers() {
      const query = `/staff_users?store_id=eq.${this._requireStoreId()}&is_deleted=eq.false&order=role.asc,username.asc`;
      return (await this.request(query)) || [];
    }

    async createStaffUser({ username, full_name, password, role, branch_id, permissions = 'الكل' }) {
      if (!username || !password) {
        throw new Error('اسم المستخدم وكلمة المرور مطلوبان');
      }
      const sid = decodeURIComponent(this._requireStoreId());

      // تشفير كلمة المرور بنفس خوارزمية البرنامج المكتبي PBKDF2
      const cryptoLib = (typeof window !== 'undefined' && window.CryptoUtils) || (typeof globalThis !== 'undefined' && globalThis.CryptoUtils) || (typeof CryptoUtils !== 'undefined' && CryptoUtils);
      const hashResult = await cryptoLib.hashPassword(password);

      const payload = {
        store_id: sid,
        branch_id: branch_id || null,
        username: username.trim(),
        full_name: (full_name || username).trim(),
        password_hash: hashResult.combined,
        role: role || 'Cashier',
        permissions: permissions || 'الكل',
        is_active: true,
        is_deleted: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      return await this.request(`/staff_users?store_id=eq.${encodeURIComponent(sid)}`, {
        method: 'POST',
        body: payload,
        headers: { 'Prefer': 'return=representation' },
      });
    }

    async addStaffUser(data) {
      return await this.createStaffUser(data);
    }

    async updateStaffUser(userId, { full_name, role, branch_id, password = null }) {
      if (!userId) throw new Error('معرف المستخدم مطلوب');
      const sid = this._requireStoreId();
      const session = this.getSession ? this.getSession() : null;
      const actorUsername = (session && session.username) ? session.username : '';

      let passwordHash = null;
      if (password && password.trim()) {
        const cryptoLib = (typeof window !== 'undefined' && window.CryptoUtils) || (typeof globalThis !== 'undefined' && globalThis.CryptoUtils) || (typeof CryptoUtils !== 'undefined' && CryptoUtils);
        const hashResult = await cryptoLib.hashPassword(password.trim());
        passwordHash = hashResult.combined;
      }

      if (actorUsername && !passwordHash) {
        try {
          return await this.request('/rpc/admin_update_staff_role', {
            method: 'POST',
            body: {
              p_store_id: sid,
              p_actor_username: actorUsername,
              p_target_user_id: userId,
              p_new_role: role !== undefined ? role : null,
              p_full_name: full_name !== undefined ? full_name : null,
              p_branch_id: branch_id !== undefined ? (branch_id || null) : null,
              p_password_hash: null,
            },
          });
        } catch (err) {
          if (err && err.status !== 404 && !String(err.message || '').includes('PGRST202')) {
            throw err;
          }
        }
      }

      const payload = {
        updated_at: new Date().toISOString(),
      };

      if (full_name !== undefined) payload.full_name = full_name;
      if (role !== undefined) payload.role = role;
      if (branch_id !== undefined) payload.branch_id = branch_id || null;
      if (passwordHash) payload.password_hash = passwordHash;

      return await this.request(`/staff_users?id=eq.${encodeURIComponent(userId)}&store_id=eq.${sid}`, {
        method: 'PATCH',
        body: payload,
        headers: { 'Prefer': 'return=representation' },
      });
    }

    async updateStaffRole(userId, roleOrPayload) {
      const updates = typeof roleOrPayload === 'string'
        ? { role: roleOrPayload }
        : (roleOrPayload || {});
      return await this.updateStaffUser(userId, updates);
    }

    async toggleStaffActive(userId, isActive) {
      return await this.toggleStaffStatus(userId, isActive);
    }

    async toggleStaffStatus(userId, isActive) {
      if (!userId) throw new Error('معرف المستخدم مطلوب');
      const sid = this._requireStoreId();
      const session = this.getSession ? this.getSession() : null;
      const actorUsername = (session && session.username) ? session.username : '';

      if (actorUsername) {
        try {
          return await this.request('/rpc/admin_toggle_staff_active', {
            method: 'POST',
            body: {
              p_store_id: sid,
              p_actor_username: actorUsername,
              p_target_user_id: userId,
              p_is_active: Boolean(isActive),
            },
          });
        } catch (err) {
          if (err && err.status !== 404 && !String(err.message || '').includes('PGRST202')) {
            throw err;
          }
        }
      }

      return await this.request(`/staff_users?id=eq.${encodeURIComponent(userId)}&store_id=eq.${sid}`, {
        method: 'PATCH',
        body: {
          is_active: Boolean(isActive),
          updated_at: new Date().toISOString(),
        },
        headers: { 'Prefer': 'return=representation' },
      });
    }

    async deleteStaffUser(userId) {
      if (!userId) throw new Error('معرف المستخدم مطلوب');
      const sid = this._requireStoreId();
      const session = this.getSession ? this.getSession() : null;
      const actorUsername = (session && session.username) ? session.username : '';

      if (actorUsername) {
        try {
          return await this.request('/rpc/admin_soft_delete_staff', {
            method: 'POST',
            body: {
              p_store_id: sid,
              p_actor_username: actorUsername,
              p_target_user_id: userId,
            },
          });
        } catch (err) {
          if (err && err.status !== 404 && !String(err.message || '').includes('PGRST202')) {
            throw err;
          }
        }
      }

      // التراجع الآمن للحذف المنطقي Soft Delete إذا لم تُفعَّل دوال RPC بعد
      return await this.request(`/staff_users?id=eq.${encodeURIComponent(userId)}&store_id=eq.${sid}`, {
        method: 'PATCH',
        body: {
          is_deleted: true,
          is_active: false,
          updated_at: new Date().toISOString(),
        },
        headers: { 'Prefer': 'return=representation' },
      });
    }

    // =========================================================================
    // Supabase Realtime — اشتراك لحظي عبر WebSocket (postgres_changes)
    // يُحدِّث الواجهة خلال 1-2 ثانية من أي تغيير على الكمبيوتر
    // =========================================================================

    /**
     * تفعيل الاشتراك اللحظي Realtime على جداول:
     *   sales, shifts, treasury_logs, products, staff_users
     * لـ store_id الحالي، مع إعادة الاتصال التلقائي عند انقطاع الشبكة.
     * @param {Function} onChangeCallback - يُستدعى عند كل تغيير: fn(table, eventType, newRecord)
     * @returns {Function} unsubscribe — استدعِها لإلغاء الاشتراك
     */
    subscribeRealtime(onChangeCallback) {
      const storeId = decodeURIComponent(this._requireStoreId());
      if (!storeId || typeof WebSocket === 'undefined') {
        return () => {};
      }

      const baseUrl = this.config.url.replace(/\/+$/, '');
      const wsUrl = baseUrl
        .replace(/^https:\/\//, 'wss://')
        .replace(/^http:\/\//, 'ws://');

      const REALTIME_URL = `${wsUrl}/realtime/v1/websocket?apikey=${this.config.anonKey}&vsn=1.0.0`;
      const TABLES = ['sales', 'shifts', 'treasury_logs', 'products', 'staff_users'];

      let ws = null;
      let heartbeatTimer = null;
      let reconnectTimer = null;
      let _stopped = false;
      let _ref = 1;
      const _subs = {}; // topic → ref

      const _send = (obj) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(obj));
        }
      };

      const _subscribe = (table) => {
        const ref = String(_ref++);
        const topic = `realtime:public:${table}`;
        _subs[table] = ref;
        // فرض فلتر store_id=eq.${storeId} إجبارياً على كافة الجداول الخمسة لمنع تسرب إشعارات أي متجر آخر
        const pgConfig = {
          event: '*',
          schema: 'public',
          table,
          filter: 'store_id=eq.' + storeId,
        };
        _send({
          topic,
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { self: false },
              postgres_changes: [pgConfig],
            },
          },
          ref,
        });
      };

      const _connect = () => {
        if (_stopped) return;
        try {
          ws = new WebSocket(REALTIME_URL);
        } catch (e) {
          reconnectTimer = setTimeout(_connect, 5000);
          return;
        }

        ws.onopen = () => {
          // بث نبضة القلب كل 30 ثانية
          heartbeatTimer = setInterval(() => {
            _send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(_ref++) });
          }, 30000);
          // الاشتراك على جميع الجداول
          TABLES.forEach(_subscribe);
        };

        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.event === 'postgres_changes' && msg.payload && msg.payload.data) {
              const { table, type, record, old_record } = msg.payload.data;
              if (table && onChangeCallback) {
                onChangeCallback(table, type, record || old_record, old_record);
              }
            }
          } catch (_) {}
        };

        ws.onerror = () => {};

        ws.onclose = () => {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          if (!_stopped) {
            // إعادة الاتصال التلقائي بعد 5 ثوانٍ
            reconnectTimer = setTimeout(_connect, 5000);
          }
        };
      };

      _connect();

      // دالة إلغاء الاشتراك وتسجيلها في قائمة القنوات النشطة
      const unsubscribe = () => {
        _stopped = true;
        clearInterval(heartbeatTimer);
        clearTimeout(reconnectTimer);
        if (ws) {
          try { ws.close(); } catch (_) {}
          ws = null;
        }
        if (this._activeRealtimeUnsubs) {
          this._activeRealtimeUnsubs.delete(unsubscribe);
        }
      };
      if (this._activeRealtimeUnsubs) {
        this._activeRealtimeUnsubs.add(unsubscribe);
      }
      return unsubscribe;
    }
  }

  // تصدير الكائن العام للـ Browser و Node.js
  const clientInstance = new SupabaseClient();
  clientInstance.getSaleAmount = getSaleAmount;
  clientInstance.categorizePayment = categorizePayment;
  clientInstance.isSaleExcluded = isSaleExcluded;
  clientInstance.getSaleCashAmount = getSaleCashAmount;
  clientInstance.isActualExpense = isActualExpense;
  clientInstance.isShiftFeed = isShiftFeed;
  clientInstance.getCairoDateStr = getCairoDateStr;
  clientInstance.getCairoOffsetDateStr = getCairoOffsetDateStr;
  clientInstance.getCairoRangeUtc = getCairoRangeUtc;

  if (typeof window !== 'undefined') {
    window.SupabaseClient = clientInstance;
    window.getSaleAmount = getSaleAmount;
    window.categorizePayment = categorizePayment;
    window.isSaleExcluded = isSaleExcluded;
    window.getSaleCashAmount = getSaleCashAmount;
    window.isActualExpense = isActualExpense;
    window.isShiftFeed = isShiftFeed;
    window.getCairoDateStr = getCairoDateStr;
    window.getCairoOffsetDateStr = getCairoOffsetDateStr;
    window.getCairoRangeUtc = getCairoRangeUtc;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = clientInstance;
    module.exports.SupabaseClient = SupabaseClient;
    module.exports.getSaleAmount = getSaleAmount;
    module.exports.categorizePayment = categorizePayment;
    module.exports.isSaleExcluded = isSaleExcluded;
    module.exports.getSaleCashAmount = getSaleCashAmount;
    module.exports.isActualExpense = isActualExpense;
    module.exports.isShiftFeed = isShiftFeed;
    module.exports.getCairoDateStr = getCairoDateStr;
    module.exports.getCairoOffsetDateStr = getCairoOffsetDateStr;
    module.exports.getCairoRangeUtc = getCairoRangeUtc;
  }
})(typeof window !== 'undefined' ? window : globalThis);
