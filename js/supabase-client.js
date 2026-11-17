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
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayISO = today.toISOString();

      let branchFilter = '';
      if (branchId && branchId !== 'ALL') {
        branchFilter = `&branch_id=eq.${branchId}`;
      }

      // 1. مبيعات اليوم
      const salesQuery = `/sales?store_id=eq.${this.config.storeId}${branchFilter}&sale_date=gte.${todayISO}&order=sale_date.desc`;
      const sales = (await this.request(salesQuery)) || [];

      let totalSales = 0;
      let invoicesCount = sales.length;
      let cashSales = 0;
      let cardSales = 0;
      let instapaySales = 0;

      for (const s of sales) {
        const amt = Number(s.total ?? s.net_total ?? s.final_amount ?? 0);
        totalSales += amt;
        const method = (s.payment_method || '').toLowerCase();
        if (method.includes('cash') || method.includes('نقدي') || method.includes('كاش')) {
          cashSales += amt;
        } else if (method.includes('card') || method.includes('فيزا') || method.includes('شبكة')) {
          cardSales += amt;
        } else if (method.includes('insta') || method.includes('انستا') || method.includes('محفظة') || method.includes('wallet')) {
          instapaySales += amt;
        }
      }

      // 2. مصروفات اليوم من الخزينة
      const treasuryQuery = `/treasury_logs?store_id=eq.${this.config.storeId}${branchFilter}&created_at=gte.${todayISO}`;
      let totalExpenses = 0;
      try {
        const logs = (await this.request(treasuryQuery)) || [];
        for (const l of logs) {
          const type = (l.type || l.trans_type || '').toLowerCase();
          if (type.includes('exp') || type.includes('صرف') || type.includes('مصروف')) {
            totalExpenses += Number(l.amount || 0);
          }
        }
      } catch (_) {}

      // 3. الورديات المفتوحة حالياً (Active Shifts)
      const shiftsQuery = `/shifts?store_id=eq.${this.config.storeId}${branchFilter}&end_time=is.null&order=start_time.desc`;
      let activeShifts = [];
      try {
        activeShifts = (await this.request(shiftsQuery)) || [];
      } catch (_) {}

      // 4. نواقص المخزون (Low Stock)
      const lowStockQuery = `/products?store_id=eq.${this.config.storeId}${branchFilter}&is_active=eq.true&is_deleted=eq.false&limit=100`;
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
        totalExpenses,
        netCashInHand: Math.max(0, cashSales - totalExpenses),
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
        filters.push(`payment_method=ilike.*${encodeURIComponent(paymentMethod)}*`);
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
      let filters = [`store_id=eq.${this.config.storeId}`, 'is_deleted=eq.false', 'is_active=eq.true'];

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
  }

  // تصدير الكائن العام للـ Browser و Node.js
  const clientInstance = new SupabaseClient();
  if (typeof window !== 'undefined') {
    window.SupabaseClient = clientInstance;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = clientInstance;
    module.exports.SupabaseClient = SupabaseClient;
  }
})(typeof window !== 'undefined' ? window : globalThis);
