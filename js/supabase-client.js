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

  const DEFAULT_CONFIG = {
    url: 'https://ohhfnbjzwpntzkawgwbk.supabase.co',
    anonKey: 'sb_publishable_bu8eKSNTAr_OjpxNRNkBoA_s71lo9Xf',
    storeId: 'bc04f845-d4c8-4786-b655-907adbd2d03e',
    storeName: 'إلكينج POS',
  };

  class SupabaseClient {
    constructor() {
      this.config = this._loadConfig();
      this.session = this._loadSession();
      this.activeBranchId = storage.getItem(STORAGE_KEYS.ACTIVE_BRANCH) || 'ALL';
    }

    _loadConfig() {
      try {
        const saved = storage.getItem(STORAGE_KEYS.CONFIG);
        return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG };
      } catch (e) {
        return { ...DEFAULT_CONFIG };
      }
    }

    saveConfig(newConfig) {
      this.config = { ...this.config, ...newConfig };
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

    saveSession(userData) {
      this.session = userData;
      storage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(userData));
    }

    clearSession() {
      this.session = null;
      storage.removeItem(STORAGE_KEYS.SESSION);
    }

    isLoggedIn() {
      return Boolean(this.session && this.session.username);
    }

    setActiveBranch(branchId) {
      this.activeBranchId = branchId || 'ALL';
      storage.setItem(STORAGE_KEYS.ACTIVE_BRANCH, this.activeBranchId);
    }

    getActiveBranch() {
      return this.activeBranchId;
    }

    /**
     * تنفيذ طلب HTTP موحد ضد Supabase PostgREST
     */
    async request(endpoint, options = {}) {
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

      if (options.body) {
        fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
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

    // =========================================================================
    // تسجيل الدخول والتحقق من كلمة المرور
    // =========================================================================
    async login(username, password) {
      const cleanUser = (username || '').trim();
      if (!cleanUser || !password) {
        throw new Error('يرجى إدخال اسم المستخدم وكلمة المرور');
      }

      const query = `/staff_users?store_id=eq.${this.config.storeId}&username=eq.${encodeURIComponent(cleanUser)}&is_deleted=eq.false&limit=1`;
      const users = await this.request(query);

      if (!users || users.length === 0) {
        throw new Error('اسم المستخدم غير مسجل أو غير موجود');
      }

      const user = users[0];

      if (!user.is_active) {
        throw new Error('هذا الحساب معطّل من قِبل إدارة النظام');
      }

      // التحقق من الدور (صاحب المحل / مدير / مسؤول - Admin / Manager)
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

      // التحقق من كلمة المرور عبر CryptoUtils المشتركة
      const cryptoLib = (typeof window !== 'undefined' && window.CryptoUtils) || (typeof globalThis !== 'undefined' && globalThis.CryptoUtils) || (typeof CryptoUtils !== 'undefined' && CryptoUtils);
      const isMatch = await cryptoLib.verifyPassword(password, user.password_hash);
      if (!isMatch) {
        throw new Error('كلمة المرور غير صحيحة');
      }

      const session = {
        id: user.id,
        username: user.username,
        full_name: user.full_name || user.username,
        role: user.role,
        branch_id: user.branch_id,
        store_id: user.store_id,
        loggedInAt: new Date().toISOString(),
      };

      this.saveSession(session);
      return session;
    }

    // =========================================================================
    // الفروع والمتجر
    // =========================================================================
    async getBranches() {
      const query = `/branches?store_id=eq.${this.config.storeId}&order=is_main.desc,name.asc`;
      return (await this.request(query)) || [];
    }

    async getStoreInfo() {
      const query = `/stores?id=eq.${this.config.storeId}&limit=1`;
      const stores = await this.request(query);
      return stores && stores.length > 0 ? stores[0] : null;
    }

    // =========================================================================
    // المؤشرات الرئيسية ولوحة المعلومات (Dashboard KPIs)
    // =========================================================================
    async getDashboardKPIs(branchId = 'ALL') {
      const now = new Date();
      // حساب بداية ونهاية "اليوم" حسب التوقيت المحلي للمتصفح (وليس UTC لمنع ترحيل اليوم بعد منتصف الليل)
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      let branchFilter = '';
      if (branchId && branchId !== 'ALL') {
        branchFilter = `&branch_id=eq.${branchId}`;
      }

      // 1. مبيعات اليوم
      const salesQuery = `/sales?store_id=eq.${this.config.storeId}${branchFilter}&sale_date=gte.${startOfDay.toISOString()}&sale_date=lte.${endOfDay.toISOString()}&order=sale_date.desc`;
      let sales = (await this.request(salesQuery)) || [];

      // إذا لم توجد فواتير بنطاق ISO الصريح، نجلب أحدث الفواتير ونفلتر حسب تاريخ اليوم المحلي كحماية إضافية
      if (sales.length === 0) {
        try {
          const recent = (await this.request(`/sales?store_id=eq.${this.config.storeId}${branchFilter}&order=sale_date.desc&limit=100`)) || [];
          sales = recent.filter(s => {
            const dtStr = s.sale_date || s.created_at;
            if (!dtStr) return false;
            const d = new Date(dtStr);
            return !isNaN(d.getTime()) &&
                   d.getFullYear() === now.getFullYear() &&
                   d.getMonth() === now.getMonth() &&
                   d.getDate() === now.getDate();
          });
        } catch (_) {}
      }

      let totalSales = 0;
      let invoicesCount = sales.length;
      let cashSales = 0;
      let cardSales = 0;
      let instapaySales = 0;
      let walletSales = 0;

      for (const s of sales) {
        // قراءة المبلغ الفعلي بدقة عبر getSaleAmount لمنع ظهور 0
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

      // 2. مصروفات اليوم من الخزينة والورديات
      const treasuryQuery = `/treasury_logs?store_id=eq.${this.config.storeId}${branchFilter}&created_at=gte.${startOfDay.toISOString()}&created_at=lte.${endOfDay.toISOString()}`;
      let totalExpenses = 0;
      const seenExpenseKeys = new Set();
      try {
        let logs = (await this.request(treasuryQuery)) || [];
        if (logs.length === 0) {
          const recentLogs = (await this.request(`/treasury_logs?store_id=eq.${this.config.storeId}${branchFilter}&order=created_at.desc&limit=100`)) || [];
          logs = recentLogs.filter(l => {
            const dtStr = l.created_at;
            if (!dtStr) return false;
            const d = new Date(dtStr);
            return !isNaN(d.getTime()) &&
                   d.getFullYear() === now.getFullYear() &&
                   d.getMonth() === now.getMonth() &&
                   d.getDate() === now.getDate();
          });
        }
        for (const l of logs) {
          const type = String(l.type || l.trans_type || '').toLowerCase();
          const cat = String(l.category || '').toLowerCase();
          const notes = String(l.notes || l.note || '').toLowerCase();
          const rawAmt = Number(l.amount || 0);
          const isExpense = type.includes('exp') || type.includes('صرف') || type.includes('مصروف') ||
                            type.includes('صادر') || type.includes('سحب') || type.includes('out') ||
                            cat.includes('مصروف') || cat.includes('صرف') || cat.includes('expense') ||
                            notes.includes('مصروف') || rawAmt < 0;
          if (isExpense) {
            const absAmt = Math.abs(rawAmt);
            totalExpenses += absAmt;
            if (l.local_trans_id) seenExpenseKeys.add(String(l.local_trans_id));
            if (l.shift_id) seenExpenseKeys.add(`shift_${l.shift_id}`);
          }
        }
      } catch (_) {}

      // 3. الورديات المفتوحة حالياً (Active Shifts) ونقدية الدرج
      const shiftsQuery = `/shifts?store_id=eq.${this.config.storeId}${branchFilter}&or=(status.eq.Open,status.eq.مفتوحة,end_time.is.null)&order=start_time.desc`;
      let activeShifts = [];
      let openShiftDrawerCash = 0;
      try {
        activeShifts = (await this.request(shiftsQuery)) || [];
        for (const sh of activeShifts) {
          const shStart = sh.start_time ? new Date(sh.start_time).getTime() : 0;
          const shUser = String(sh.username || sh.cashier_name || '').toLowerCase().trim();
          const shLocalId = Number(sh.local_shift_id || 0);

          // حساب مبيعات الوردية المفتوحة لحظياً من فواتير اليوم الصادرة بعد وقت البدء
          let realTimeShiftSales = 0;
          let realTimeShiftCashSales = 0;
          for (const s of sales) {
            const sDate = new Date(s.sale_date || s.created_at).getTime();
            const sUser = String(s.cashier_username || s.cashier_name || '').toLowerCase().trim();
            const sShiftId = Number(s.local_shift_id || s.shift_id || 0);

            const matchesShift = (shLocalId > 0 && sShiftId === shLocalId) ||
                                 (sDate >= shStart && (!shUser || !sUser || sUser === shUser));
            if (matchesShift) {
              const amt = getSaleAmount(s);
              realTimeShiftSales += amt;
              const cat = categorizePayment(s.payment_method);
              if (cat === 'cash') realTimeShiftCashSales += amt;
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

          const startCash = Number(sh.starting_cash ?? sh.opening_cash ?? 0);
          const expToDeduct = shExp > 0 ? shExp : totalExpenses;
          const currentInShift = startCash + shiftCashSales - expToDeduct;
          openShiftDrawerCash += currentInShift;
        }
      } catch (_) {}

      // نقدية الدرج (كاش) — بعد خصم المصروفات النقدية
      const netCashInHand = openShiftDrawerCash > 0
        ? openShiftDrawerCash
        : Math.max(0, cashSales - totalExpenses);

      // 4. نواقص المخزون (Low Stock)
      const lowStockQuery = `/products?store_id=eq.${this.config.storeId}${branchFilter}&is_active=eq.true&limit=100`;
      let lowStockCount = 0;
      let lowStockItems = [];
      try {
        const products = (await this.request(lowStockQuery)) || [];
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
    async getSales({ branchId = 'ALL', date = null, paymentMethod = null, search = '', limit = 50, offset = 0 } = {}) {
      let filters = [`store_id=eq.${this.config.storeId}`];

      if (branchId && branchId !== 'ALL') {
        filters.push(`branch_id=eq.${branchId}`);
      }

      if (date) {
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);
        filters.push(`sale_date=gte.${dayStart.toISOString()}`);
        filters.push(`sale_date=lte.${dayEnd.toISOString()}`);
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

      const query = `/sales?${filters.join('&')}&order=sale_date.desc&limit=${limit}&offset=${offset}`;
      return (await this.request(query)) || [];
    }

    async getSaleDetails(saleId) {
      if (!saleId) return [];
      const query = `/sale_items?sale_id=eq.${saleId}&order=id.asc`;
      return (await this.request(query)) || [];
    }

    // =========================================================================
    // المخزون والأصناف (Inventory & Products)
    // =========================================================================
    async getProducts({ branchId = 'ALL', search = '', lowStockOnly = false, limit = 100, offset = 0 } = {}) {
      let filters = [`store_id=eq.${this.config.storeId}`, 'is_active=eq.true'];

      if (branchId && branchId !== 'ALL') {
        // جميع الأصناف مرتبطة بفرع محدد (branch_id NOT NULL في المخطط)
        filters.push(`branch_id=eq.${branchId}`);
      }

      if (search && search.trim()) {
        const s = encodeURIComponent(search.trim());
        filters.push(`or=(product_name.ilike.*${s}*,name.ilike.*${s}*,barcode_ean13.ilike.*${s}*,barcode.ilike.*${s}*)`);
      }

      const query = `/products?${filters.join('&')}&order=product_name.asc,name.asc&limit=${limit}&offset=${offset}`;
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
      return await this.request(`/products?id=eq.${productId}`, {
        method: 'PATCH',
        body: payload,
        headers: { 'Prefer': 'return=representation' },
      });
    }

    // =========================================================================
    // الخزينة والورديات (Treasury & Shifts)
    // =========================================================================
    async getTreasuryLogs({ branchId = 'ALL', limit = 50, offset = 0 } = {}) {
      let filters = [`store_id=eq.${this.config.storeId}`];
      if (branchId && branchId !== 'ALL') {
        filters.push(`branch_id=eq.${branchId}`);
      }
      const query = `/treasury_logs?${filters.join('&')}&order=created_at.desc&limit=${limit}&offset=${offset}`;
      return (await this.request(query)) || [];
    }

    async getShifts({ branchId = 'ALL', limit = 30, offset = 0 } = {}) {
      let filters = [`store_id=eq.${this.config.storeId}`];
      if (branchId && branchId !== 'ALL') {
        filters.push(`branch_id=eq.${branchId}`);
      }
      const query = `/shifts?${filters.join('&')}&order=start_time.desc&limit=${limit}&offset=${offset}`;
      return (await this.request(query)) || [];
    }

    // =========================================================================
    // إدارة الموظفين والمستخدمين (Staff Management)
    // =========================================================================
    async getStaffUsers() {
      const query = `/staff_users?store_id=eq.${this.config.storeId}&is_deleted=eq.false&order=role.asc,username.asc`;
      return (await this.request(query)) || [];
    }

    async createStaffUser({ username, full_name, password, role, branch_id, permissions = 'الكل' }) {
      if (!username || !password) {
        throw new Error('اسم المستخدم وكلمة المرور مطلوبان');
      }

      // تشفير كلمة المرور بنفس خوارزمية البرنامج المكتبي PBKDF2
      const cryptoLib = (typeof window !== 'undefined' && window.CryptoUtils) || (typeof globalThis !== 'undefined' && globalThis.CryptoUtils) || (typeof CryptoUtils !== 'undefined' && CryptoUtils);
      const hashResult = await cryptoLib.hashPassword(password);

      const payload = {
        store_id: this.config.storeId,
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

      return await this.request('/staff_users', {
        method: 'POST',
        body: payload,
        headers: { 'Prefer': 'return=representation' },
      });
    }

    async updateStaffUser(userId, { full_name, role, branch_id, password = null }) {
      if (!userId) throw new Error('معرف المستخدم مطلوب');

      const payload = {
        updated_at: new Date().toISOString(),
      };

      if (full_name !== undefined) payload.full_name = full_name;
      if (role !== undefined) payload.role = role;
      if (branch_id !== undefined) payload.branch_id = branch_id || null;

      if (password && password.trim()) {
        const cryptoLib = (typeof window !== 'undefined' && window.CryptoUtils) || (typeof globalThis !== 'undefined' && globalThis.CryptoUtils) || (typeof CryptoUtils !== 'undefined' && CryptoUtils);
        const hashResult = await cryptoLib.hashPassword(password.trim());
        payload.password_hash = hashResult.combined;
      }

      return await this.request(`/staff_users?id=eq.${userId}`, {
        method: 'PATCH',
        body: payload,
        headers: { 'Prefer': 'return=representation' },
      });
    }

    async toggleStaffStatus(userId, isActive) {
      if (!userId) throw new Error('معرف المستخدم مطلوب');
      return await this.request(`/staff_users?id=eq.${userId}`, {
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
      // حذف منطقي Soft Delete
      return await this.request(`/staff_users?id=eq.${userId}`, {
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
      const storeId = this.config.storeId;
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
        _send({
          topic,
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { self: false },
              postgres_changes: [{
                event: '*',
                schema: 'public',
                table,
                filter: `store_id=eq.${storeId}`,
              }],
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

      // دالة إلغاء الاشتراك
      return () => {
        _stopped = true;
        clearInterval(heartbeatTimer);
        clearTimeout(reconnectTimer);
        if (ws) {
          try { ws.close(); } catch (_) {}
        }
      };
    }
  }

  // تصدير الكائن العام للـ Browser و Node.js
  const clientInstance = new SupabaseClient();
  clientInstance.getSaleAmount = getSaleAmount;
  clientInstance.categorizePayment = categorizePayment;

  if (typeof window !== 'undefined') {
    window.SupabaseClient = clientInstance;
    window.getSaleAmount = getSaleAmount;
    window.categorizePayment = categorizePayment;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = clientInstance;
    module.exports.SupabaseClient = SupabaseClient;
    module.exports.getSaleAmount = getSaleAmount;
    module.exports.categorizePayment = categorizePayment;
  }
})(typeof window !== 'undefined' ? window : globalThis);
