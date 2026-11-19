/**
 * ELKing POS - Mobile PWA Main Controller
 * تطبيق الموبايل المتكامل لصاحب المحل
 *
 * FIX v2: Moved ALL DOM access inside DOMContentLoaded to prevent null-refs
 * when scripts load before the DOM is fully parsed (GitHub Pages subpath).
 */

(function () {
  'use strict';

  // =========================================================================
  // Module-level (non-DOM) state — safe to declare here
  // =========================================================================
  let currentTab = 'dashboard';
  let branchesCache = [];
  let isRefreshing = false;
  let deferredPrompt = null;
  let lastSuccessfulSyncTime = null;
  let salesCurrentPage = 0;
  const SALES_PAGE_SIZE = 30;
  let lastVisibilityRefreshAt = 0;
  try {
    lastSuccessfulSyncTime = localStorage.getItem('elking_pwa_last_sync') || null;
  } catch (_) {}

  // Client will be resolved after DOM ready (scripts guaranteed loaded by then)
  let client = null;

  // =========================================================================
  // Safe lazy DOM getter — never crashes if element doesn't exist
  // =========================================================================
  function el(id) {
    return document.getElementById(id);
  }

  // =========================================================================
  // Formatting, Security & Utility Helpers
  // =========================================================================
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, delay = 350) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function formatMoney(amount) {
    const num = Number(amount || 0);
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';
  }

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

  function isSaleExcluded(sale) {
    if (client && typeof client.isSaleExcluded === 'function') {
      return client.isSaleExcluded(sale);
    }
    if (!sale) return true;
    const st = String(sale.status || '').toLowerCase().trim();
    return st === 'cancelled' || st === 'voided' || st === 'ملغاة' || st === 'ملغي' || st === 'مرتجع' || sale.is_returned === true;
  }

  function getSaleCashAmount(sale) {
    if (client && typeof client.getSaleCashAmount === 'function') {
      return client.getSaleCashAmount(sale);
    }
    if (!sale || isSaleExcluded(sale)) return 0;
    let splitObj = null;
    if (sale.split_details) {
      if (typeof sale.split_details === 'object') {
        splitObj = sale.split_details;
      } else if (typeof sale.split_details === 'string') {
        try { splitObj = JSON.parse(sale.split_details); } catch (_) {}
      }
    }
    const catFn = (client && client.categorizePayment) ? client.categorizePayment : (m => String(m || '').toLowerCase().includes('cash') || String(m || '').includes('كاش') || String(m || '').includes('نقدي') ? 'cash' : 'other');
    if (splitObj && typeof splitObj === 'object' && Object.keys(splitObj).length > 0) {
      let cashPart = 0;
      for (const [k, v] of Object.entries(splitObj)) {
        const splitAmt = Number(v || 0);
        if (splitAmt > 0 && catFn(k) === 'cash') {
          cashPart += splitAmt;
        }
      }
      return cashPart;
    }
    return catFn(sale.payment_method) === 'cash' ? getSaleAmount(sale) : 0;
  }

  function isActualExpense(log) {
    if (client && typeof client.isActualExpense === 'function') {
      return client.isActualExpense(log);
    }
    if (!log) return false;
    const type = String(log.trans_type || log.type || '').trim();
    const cat = String(log.category || '').trim();
    const notes = String(log.notes || log.note || '').trim();
    const combined = `${type} ${cat} ${notes}`.toLowerCase();
    if (
      type === 'توريد_للخزينة' || type === 'توريد للخزينة' ||
      type === 'تغذية_وردية' || type === 'تغذية وردية' ||
      combined.includes('توريد_للخزينة') || combined.includes('توريد للخزينة') ||
      combined.includes('تغذية_وردية') || combined.includes('تغذية وردية') ||
      type === 'إيداع' || type === 'ايداع' || type === 'وارد'
    ) {
      return false;
    }
    const allowedExpenseTypes = ['مصروف', 'مصروفات', 'مصروف عام', 'مصروفات وردية', 'صرف', 'expense'];
    const typeLower = type.toLowerCase();
    const catLower = cat.toLowerCase();
    return allowedExpenseTypes.includes(typeLower) ||
           allowedExpenseTypes.includes(catLower) ||
           typeLower.includes('مصروف') ||
           catLower.includes('مصروف');
  }

  function isShiftFeed(log) {
    if (client && typeof client.isShiftFeed === 'function') {
      return client.isShiftFeed(log);
    }
    if (!log) return false;
    const type = String(log.trans_type || log.type || '').trim();
    const cat = String(log.category || '').trim();
    const combined = `${type} ${cat}`.toLowerCase();
    return type === 'تغذية_وردية' || type === 'تغذية وردية' || combined.includes('تغذية_وردية') || combined.includes('تغذية وردية');
  }

  function updateConnectionBanner(isError, errMsg = '') {
    const banner = el('connectionErrorBanner');
    const titleEl = el('connectionErrorTitle');
    const lastSyncEl = el('connectionErrorLastSync');
    const statusText = el('cloudStatusText');

    if (!isError) {
      lastSuccessfulSyncTime = new Date().toISOString();
      try {
        localStorage.setItem('elking_pwa_last_sync', lastSuccessfulSyncTime);
      } catch (_) {}
      if (banner) banner.classList.add('hidden');
      if (statusText) {
        statusText.textContent = 'سحابي متصل';
        statusText.classList.remove('text-rose-600', 'dark:text-rose-400');
        statusText.classList.add('text-emerald-600', 'dark:text-emerald-400');
      }
    } else {
      if (banner) banner.classList.remove('hidden');
      if (titleEl) {
        titleEl.textContent = errMsg ? `تعذر الاتصال بالخادم السحابي (${errMsg})` : 'تعذر الاتصال بالخادم السحابي';
      }
      if (lastSyncEl) {
        const syncFormatted = lastSuccessfulSyncTime ? formatDateTime(lastSuccessfulSyncTime) : 'لم يتم التحديث بعد';
        lastSyncEl.textContent = `آخر تحديث ناجح: ${syncFormatted}`;
      }
      if (statusText) {
        statusText.textContent = 'غير متصل';
        statusText.classList.remove('text-emerald-600', 'dark:text-emerald-400');
        statusText.classList.add('text-rose-600', 'dark:text-rose-400');
      }
    }
  }

  function formatDateTime(isoString) {
    if (!isoString) return '---';
    try {
      let str = String(isoString).trim();
      // تنسيق السلسلة إذا كانت Naive بدون إزاحة زمنية
      if (!str.includes('+') && !str.includes('Z') && !str.match(/-\d{2}:\d{2}$/)) {
        str = str.replace(' ', 'T');
      }
      const d = new Date(str);
      if (isNaN(d.getTime())) return String(isoString).substring(0, 16);
      return d.toLocaleDateString('ar-EG', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch (_) {
      return String(isoString).substring(0, 16);
    }
  }

  function formatTime(isoString) {
    if (!isoString) return '---';
    try {
      let str = String(isoString).trim();
      if (!str.includes('+') && !str.includes('Z') && !str.match(/-\d{2}:\d{2}$/)) {
        str = str.replace(' ', 'T');
      }
      const d = new Date(str);
      if (isNaN(d.getTime())) return String(isoString).substring(11, 16);
      return d.toLocaleTimeString('ar-EG', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch (_) {
      return String(isoString).substring(11, 16);
    }
  }

  function showToast(message, isError = false) {
    const toast = el('toast');
    const toastMsg = el('toastMsg');
    if (!toast || !toastMsg) return;

    toastMsg.textContent = message;
    if (isError) {
      toast.classList.remove('bg-slate-900', 'dark:bg-slate-100', 'text-white', 'dark:text-slate-900');
      toast.classList.add('bg-rose-600', 'text-white');
    } else {
      toast.classList.remove('bg-rose-600');
      toast.classList.add('bg-slate-900', 'dark:bg-slate-100', 'text-white', 'dark:text-slate-900');
    }
    toast.classList.remove('opacity-0', 'pointer-events-none', '-translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');

    setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', 'pointer-events-none', '-translate-y-4');
    }, 3200);
  }

  // Safe Lucide icon trigger — CDN may not have loaded yet
  function triggerIcons() {
    try {
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
      }
    } catch (e) {
      console.debug('Lucide icons not available:', e);
    }
  }

  // =========================================================================
  // Theme Management (Light / Dark)
  // =========================================================================
  function updateThemeUI(isDark) {
    const moon = el('themeIconMoon');
    const sun = el('themeIconSun');
    if (moon) moon.style.display = isDark ? 'block' : 'none';
    if (sun) sun.style.display = isDark ? 'none' : 'block';
    const btn = el('themeToggleBtn');
    if (btn) btn.setAttribute('title', isDark ? 'التبديل إلى المظهر الفاتح' : 'التبديل إلى المظهر الداكن');
  }

  function initTheme() {
    const saved = localStorage.getItem('elking_pwa_theme');
    const isDark = (saved !== 'light');
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    updateThemeUI(isDark);
    triggerIcons();

    const themeToggleBtn = el('themeToggleBtn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const currentlyDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('elking_pwa_theme', currentlyDark ? 'dark' : 'light');
        updateThemeUI(currentlyDark);
        triggerIcons();
      });
    }
  }

  // =========================================================================
  // Smart QR Onboarding & URL Parameters
  // =========================================================================
  function handleUrlOnboarding() {
    try {
      const params = new URLSearchParams(window.location.search);
      const storeId = params.get('store_id');
      const storeName = params.get('store_name');

      if (storeId) {
        const cleanStoreId = storeId.trim();
        let decodedName = 'متجر إلكينج';
        if (storeName) {
          try {
            decodedName = decodeURIComponent(storeName.trim());
          } catch (_) {
            decodedName = storeName.trim();
          }
        }

        // عزل الجلسات: مقارنة الـ store_id الجديد بالمخزن مسبقاً، ومسح الجلسة والكاش فوراً عند الاختلاف
        const prevStoreId = (localStorage.getItem('elking_pwa_store_id') || (client && client.config && client.config.storeId) || '').trim();
        if (prevStoreId && prevStoreId !== cleanStoreId) {
          if (client) {
            client.clearSession();
            client.setActiveBranch('ALL');
          }
          localStorage.removeItem('elking_pwa_session');
          localStorage.removeItem('elking_pwa_active_branch');
          localStorage.removeItem('elking_pwa_last_sync');
          try { sessionStorage.clear(); } catch (_) {}
          branchesCache = [];
          if (typeof caches !== 'undefined' && caches.keys) {
            caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => {});
          }
        }

        // حفظ المعرف واسم المتجر فورياً في الإعدادات والذاكرة
        if (client) {
          client.saveConfig({ storeId: cleanStoreId, storeName: decodedName });
        }
        localStorage.setItem('elking_pwa_store_id', cleanStoreId);
        localStorage.setItem('elking_pwa_store_name', decodedName);

        // ملء خانة معرّف المتجر في واجهة تسجيل الدخول إن وجدت
        const storeInp = el('loginStoreId');
        if (storeInp) storeInp.value = cleanStoreId;

        // تنظيف الرابط في المتصفح فوراً وحذف معلمات الرابط دون إعادة تحميل الصفحة
        window.history.replaceState({}, document.title, window.location.pathname);

        // إشعار فوري
        showToast(`تم ربط المتجر بنجاح: ${decodedName}`);
      }
    } catch (e) {
      console.debug('Error in URL onboarding:', e);
    }
  }

  // =========================================================================
  // Authentication & Session
  // =========================================================================
  function checkAuth() {
    if (!client || !client.isLoggedIn()) {
      showLoginModal();
    } else {
      hideLoginModal();
      loadInitialAppData();
    }
  }

  function showLoginModal() {
    const loginModal = el('loginModal');
    if (!loginModal) return;

    loginModal.classList.remove('hidden');

    const storeId = (client && client.config && client.config.storeId)
      || localStorage.getItem('elking_pwa_store_id')
      || '';
    const storeInp = el('loginStoreId');
    if (storeInp && storeId) {
      storeInp.value = storeId;
    }

    // تحديث شارة المتجر المتصل
    const badge = el('connectedStoreBadge');
    const nameEl = el('connectedStoreName');
    const savedStoreName = localStorage.getItem('elking_pwa_store_name')
      || (client && client.config && client.config.storeName)
      || 'متجر إلكينج';

    if (badge && nameEl) {
      if (storeId) {
        badge.classList.remove('hidden');
        nameEl.textContent = savedStoreName;
        nameEl.title = `معرّف المتجر: ${storeId}`;
      } else {
        badge.classList.add('hidden');
      }
    }

    const headerStoreName = el('headerStoreName');
    if (headerStoreName && savedStoreName) {
      headerStoreName.textContent = savedStoreName;
    }

    triggerIcons();

    // تركيز المؤشر مباشرة
    setTimeout(() => {
      if (storeInp && !storeInp.value) {
        storeInp.focus();
      } else {
        const userInp = el('loginUsername');
        if (userInp) userInp.focus();
      }
    }, 150);
  }

  function hideLoginModal() {
    const loginModal = el('loginModal');
    if (loginModal) {
      loginModal.classList.add('hidden');
    }
  }

  function setupAuthEvents() {
    // زر "تغيير المتجر" في شارة المتجر المتصل
    const changeStoreBtn = el('changeStoreBtn');
    if (changeStoreBtn) {
      changeStoreBtn.addEventListener('click', () => {
        const storeInp = el('loginStoreId');
        if (storeInp) {
          storeInp.value = '';
          storeInp.focus();
        }
        const badge = el('connectedStoreBadge');
        if (badge) badge.classList.add('hidden');
      });
    }

    // Login Form Submit (Store ID, Username, Password)
    const loginForm = el('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!client) {
          showToast('تعذّر الاتصال بالخادم — يرجى تحديث الصفحة', true);
          return;
        }
        const storeId = (el('loginStoreId')?.value || '').trim();
        const username = (el('loginUsername')?.value || '').trim();
        const password = el('loginPassword')?.value || '';
        const submitBtn = el('loginSubmitBtn');

        if (!storeId) {
          showToast('يرجى إدخال معرّف المتجر (Store ID)', true);
          const storeInp = el('loginStoreId');
          if (storeInp) storeInp.focus();
          return;
        }

        if (!username || !password) {
          showToast('يرجى إدخال اسم المستخدم وكلمة المرور', true);
          return;
        }

        // تثبيت معرّف المتجر للعميل السحابي
        client.saveConfig({ storeId: storeId });
        localStorage.setItem('elking_pwa_store_id', storeId);

        const originalBtnHTML = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.innerHTML = `<span>جاري التحقق...</span>`;
        }

        try {
          const session = await client.login(username, password);
          showToast(`مرحباً بك، ${session.full_name || session.username}`);
          hideLoginModal();
          await loadInitialAppData();
        } catch (err) {
          showToast(err.message || 'فشل تسجيل الدخول', true);
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnHTML;
          }
          triggerIcons();
        }
      });
    }

    // User Profile / Logout Button
    const userProfileBtn = el('userProfileBtn');
    if (userProfileBtn) {
      userProfileBtn.addEventListener('click', () => {
        if (!client || !client.isLoggedIn()) {
          showLoginModal();
          return;
        }
        const s = client.session;
        const doLogout = confirm(`المستخدم الحالي: ${s.full_name || s.username} (${s.role})\n\nهل ترغب في تسجيل الخروج؟`);
        if (doLogout) {
          client.clearSession();
          localStorage.removeItem('elking_pwa_session');
          localStorage.removeItem('elking_pwa_store_id');
          localStorage.removeItem('elking_pwa_store_name');
          sessionStorage.clear();

          // تصفير حقول شاشة الدخول للبدء من جديد
          const storeInp = el('loginStoreId');
          if (storeInp) storeInp.value = '';
          const userInp = el('loginUsername');
          if (userInp) userInp.value = '';
          const passInp = el('loginPassword');
          if (passInp) passInp.value = '';
          const badge = el('connectedStoreBadge');
          if (badge) badge.classList.add('hidden');

          showToast('تم تسجيل الخروج بنجاح');
          showLoginModal();
        }
      });
    }
  }

  // =========================================================================
  // Branch Management & Dropdown
  // =========================================================================
  async function loadBranches() {
    try {
      branchesCache = await client.getBranches();
      const branchSelect = el('branchFilter') || el('branchSelect');
      if (!branchSelect) return;

      let activeBranch = client.getActiveBranch();
      const validIds = ['ALL', ...branchesCache.map(b => b.id)];
      if (!validIds.includes(activeBranch)) {
        activeBranch = 'ALL';
        client.setActiveBranch('ALL');
      }
      let optionsHtml = `<option value="ALL" ${activeBranch === 'ALL' ? 'selected' : ''}>🌐 جميع الفروع</option>`;

      for (const b of branchesCache) {
        const isSelected = b.id === activeBranch ? 'selected' : '';
        const mainBadge = b.is_main ? ' (الرئيسي)' : '';
        optionsHtml += `<option value="${escapeHtml(b.id)}" ${isSelected}>🏢 ${escapeHtml(b.name)}${mainBadge}</option>`;
      }

      branchSelect.innerHTML = optionsHtml;

      // Populate also in Add Staff Modal
      const staffBranchSelect = el('newStaffBranch');
      if (staffBranchSelect) {
        let staffOpts = `<option value="">بدون تعيين فرع محدد</option>`;
        for (const b of branchesCache) {
          staffOpts += `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`;
        }
        staffBranchSelect.innerHTML = staffOpts;
      }
    } catch (err) {
      console.debug('Error loading branches:', err);
    }
  }

  function getBranchName(branchId) {
    if (!branchId) return 'غير محدد';
    const found = branchesCache.find(b => b.id === branchId);
    return found ? found.name : 'فرع غير معروف';
  }

  // =========================================================================
  // PWA Installation & Add-to-Home-Screen (Android / iOS / Desktop Chrome)
  // =========================================================================
  function isIos() {
    const ua = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(ua);
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function setupPwaInstall() {
    // إذا كان التطبيق مثبتاً بالفعل ويعمل بوضع standalone، لا نعرض البنرات
    if (isStandalone()) {
      return;
    }

    // 1. حدث beforeinstallprompt لأجهزة Chrome و Edge و Android
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;

      // إظهار بنر التثبيت العلوي إذا لم يقم المستخدم بإغلاقه مؤقتاً
      const banner = el('pwaInstallBanner');
      const loginPrompt = el('loginInstallPrompt');
      if (banner && sessionStorage.getItem('elking_pwa_dismiss_banner') !== 'true') {
        banner.classList.remove('hidden');
      }
      if (loginPrompt) {
        loginPrompt.classList.remove('hidden');
      }
      triggerIcons();
    });

    // 2. معالجة هواتف آيفون (iOS Safari لا يطلق حدث beforeinstallprompt)
    if (isIos() && !isStandalone()) {
      const banner = el('pwaInstallBanner');
      const loginPrompt = el('loginInstallPrompt');
      if (banner && sessionStorage.getItem('elking_pwa_dismiss_banner') !== 'true') {
        banner.classList.remove('hidden');
      }
      if (loginPrompt) {
        loginPrompt.classList.remove('hidden');
      }
      triggerIcons();
    }

    // زر إغلاق البنر العلوي (تجاهل للجلسة الحالية)
    el('pwaDismissBannerBtn')?.addEventListener('click', () => {
      el('pwaInstallBanner')?.classList.add('hidden');
      sessionStorage.setItem('elking_pwa_dismiss_banner', 'true');
    });

    // زر التثبيت المباشر (في البنر أو شاشة الدخول)
    async function triggerInstallFlow() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          showToast('جاري تثبيت تطبيق ELKing POS...');
        }
        deferredPrompt = null;
        el('pwaInstallBanner')?.classList.add('hidden');
        el('loginInstallPrompt')?.classList.add('hidden');
      } else if (isIos()) {
        el('iosInstallModal')?.classList.remove('hidden');
        triggerIcons();
      } else {
        showToast('لتثبيت التطبيق: افتح قائمة خيارات المتصفح (⋮) ثم اضغط "إضافة إلى الشاشة الرئيسية"');
      }
    }

    el('pwaInstallBtn')?.addEventListener('click', triggerInstallFlow);
    el('loginInstallBtn')?.addEventListener('click', triggerInstallFlow);

    // أزرار إغلاق نافذة إرشادات iOS
    el('closeIosInstallModalBtn')?.addEventListener('click', () => {
      el('iosInstallModal')?.classList.add('hidden');
    });
    el('okIosInstallModalBtn')?.addEventListener('click', () => {
      el('iosInstallModal')?.classList.add('hidden');
    });

    // الاستماع لحدث اكتمال التثبيت
    window.addEventListener('appinstalled', () => {
      showToast('تم تثبيت تطبيق الكاشير بنجاح على هاتفك! 🎉');
      deferredPrompt = null;
      el('pwaInstallBanner')?.classList.add('hidden');
      el('loginInstallPrompt')?.classList.add('hidden');
    });
  }

  // =========================================================================
  // Navigation & Tab Switching
  // =========================================================================
  function updateStaffTabVisibility() {
    const staffBtn = document.querySelector('.nav-tab-btn[data-tab="staff"]');
    if (!staffBtn) return;
    const session = client && client.session;
    const role = ((session && session.role) || '').toLowerCase();
    // إتاحة تبويب المستخدمين للأدوار الإدارية: owner, admin, manager ومثيلاتها بالعربية
    const isAllowed = !role || ['owner', 'admin', 'manager', 'مدير', 'ادمن', 'مسؤول', 'صاحب'].some(r => role.includes(r));
    if (isAllowed) {
      staffBtn.classList.remove('hidden');
      staffBtn.style.display = 'flex';
      staffBtn.removeAttribute('aria-hidden');
    } else {
      staffBtn.classList.add('hidden');
      staffBtn.style.display = 'none';
      staffBtn.setAttribute('aria-hidden', 'true');
      if (currentTab === 'staff') {
        switchTab('dashboard');
      }
    }
  }

  function setupNavigation() {
    updateStaffTabVisibility();
    const tabButtons = document.querySelectorAll('.nav-tab-btn');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        if (targetTab === currentTab) return;
        switchTab(targetTab);
      });
    });

    const branchSelect = el('branchFilter') || el('branchSelect');
    if (branchSelect) {
      branchSelect.addEventListener('change', () => {
        salesCurrentPage = 0;
        if (client) client.setActiveBranch(branchSelect.value);
        refreshCurrentTab();
      });
    }

    const refreshBtn = el('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshCurrentTab(true);
      });
    }

    const retryConnectionBtn = el('retryConnectionBtn');
    if (retryConnectionBtn) {
      retryConnectionBtn.addEventListener('click', () => {
        refreshCurrentTab(true);
      });
    }
  }

  function switchTab(tabId) {
    currentTab = tabId;

    // Update bottom nav styles
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      const isTarget = btn.getAttribute('data-tab') === tabId;
      if (isTarget) {
        btn.classList.add('text-blue-600', 'dark:text-blue-400', 'active');
        btn.classList.remove('text-slate-400');
      } else {
        btn.classList.remove('text-blue-600', 'dark:text-blue-400', 'active');
        btn.classList.add('text-slate-400');
      }
    });

    // Update view sections
    document.querySelectorAll('.tab-content').forEach(section => {
      section.classList.remove('active');
    });

    const activeSection = el(`tab-${tabId}`);
    if (activeSection) {
      activeSection.classList.add('active');
    }

    refreshCurrentTab();
    triggerIcons();
  }

  async function refreshCurrentTab(showToastOnDone = false) {
    if (isRefreshing) return;
    isRefreshing = true;

    const refreshIcon = el('refreshIcon');
    if (refreshIcon) {
      refreshIcon.classList.add('animate-spin');
    }

    try {
      const branchId = client ? client.getActiveBranch() : 'ALL';
      switch (currentTab) {
        case 'dashboard':
          await renderDashboard(branchId);
          break;
        case 'sales':
          await renderSales(branchId);
          break;
        case 'inventory':
          await renderInventory(branchId);
          break;
        case 'treasury':
          await renderTreasury(branchId);
          break;
        case 'staff':
          await renderStaff();
          break;
      }
      updateConnectionBanner(false);
      if (showToastOnDone) {
        showToast('تم تحديث البيانات لحظياً');
      }
    } catch (err) {
      console.error('Refresh error:', err);
      updateConnectionBanner(true, err.message || 'خطأ في الشبكة');
      showToast(err.message || 'حدث خطأ أثناء جلب البيانات', true);
    } finally {
      isRefreshing = false;
      if (refreshIcon) {
        refreshIcon.classList.remove('animate-spin');
      }
      triggerIcons();
    }
  }

  // =========================================================================
  // VIEW 1: DASHBOARD
  // =========================================================================
  async function renderDashboard(branchId) {
    let kpis;
    try {
      kpis = await client.getDashboardKPIs(branchId);
      updateConnectionBanner(false);
    } catch (err) {
      updateConnectionBanner(true, err.message || 'انقطاع الاتصال');
      throw err;
    }

    // KPI Numbers
    const setEl = (id, val) => { const e = el(id); if (e) e.textContent = val; };
    setEl('kpiTotalSales', formatMoney(kpis.totalSales));
    setEl('kpiInvoicesCount', kpis.invoicesCount);
    setEl('kpiCashInHand', formatMoney(kpis.netCashInHand));
    setEl('kpiTotalExpenses', formatMoney(kpis.totalExpenses));
    setEl('kpiCardSales', formatMoney(kpis.cardSales));
    setEl('kpiInstapaySales', formatMoney(kpis.instapaySales + (kpis.walletSales || 0)));

    // Active Shifts
    const shiftsListEl = el('activeShiftsList');
    const shiftsBadgeEl = el('activeShiftsBadge');
    if (shiftsBadgeEl) {
      shiftsBadgeEl.textContent = `${kpis.activeShiftsCount} جارية`;
    }

    if (shiftsListEl) {
      if (kpis.activeShifts.length === 0) {
        shiftsListEl.innerHTML = `<p class="text-xs text-slate-400 text-center py-2">لا توجد ورديات مفتوحة حالياً في هذا الفرع.</p>`;
      } else {
        shiftsListEl.innerHTML = kpis.activeShifts.map(s => `
          <div class="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl border border-slate-200/80 dark:border-slate-700/80 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center font-bold text-xs shrink-0">
                <i data-lucide="user-check" class="w-4 h-4"></i>
              </div>
              <div class="min-w-0">
                <h4 class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(s.cashier_name || s.username || 'كاشير')}</h4>
                <p class="text-xs text-slate-500 dark:text-slate-400 truncate">بدأت: ${escapeHtml(formatDateTime(s.start_time))} • ${escapeHtml(getBranchName(s.branch_id))}</p>
              </div>
            </div>
            <div class="text-left shrink-0">
              <span class="text-xs font-extrabold text-emerald-600 dark:text-emerald-400 num-ltr">${formatMoney(s.total_sales || 0)}</span>
              <span class="block text-xs text-slate-400">مبيعات الوردية</span>
            </div>
          </div>
        `).join('');
      }
    }

    // Low Stock Items
    const lowStockListEl = el('lowStockList');
    if (lowStockListEl) {
      if (kpis.lowStockItems.length === 0) {
        lowStockListEl.innerHTML = `<p class="text-xs text-slate-400 text-center py-2">المخزون في حالة ممتازة ولا توجد نواقص.</p>`;
      } else {
        lowStockListEl.innerHTML = kpis.lowStockItems.map(item => `
          <div class="bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-xl border border-rose-200/50 dark:border-rose-900/40 flex items-center justify-between gap-2">
            <div class="min-w-0">
              <h5 class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(item.product_name || item.name || 'صنف')}</h5>
              <p class="text-xs text-slate-400 num-ltr font-mono truncate" dir="ltr">${escapeHtml(item.barcode || 'بدون باركود')}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-xs font-bold text-rose-600 dark:text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-md">
                متبقي ${escapeHtml(item.stock)} فقط
              </span>
            </div>
          </div>
        `).join('');
      }
    }
  }

  // =========================================================================
  // VIEW 2: SALES & INVOICES
  // =========================================================================
  function _getSalesDateFilterRange() {
    const mode = el('salesDateFilter')?.value || 'ALL';
    const cairoOffset = (days) => {
      if (client && typeof client.getCairoOffsetDateStr === 'function') {
        return client.getCairoOffsetDateStr(days);
      }
      const d = new Date(Date.now() + Number(days || 0) * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    if (mode === 'today') {
      const t = cairoOffset(0);
      return { dateFrom: t, dateTo: t };
    }
    if (mode === 'yesterday') {
      const y = cairoOffset(-1);
      return { dateFrom: y, dateTo: y };
    }
    if (mode === 'DAY') {
      const picked = (el('salesDateInput')?.value || '').trim();
      return picked ? { dateFrom: picked, dateTo: picked } : { dateFrom: null, dateTo: null };
    }
    if (mode === 'RANGE') {
      const f = (el('salesDateFrom')?.value || '').trim() || null;
      const t = (el('salesDateTo')?.value || '').trim() || null;
      return { dateFrom: f, dateTo: t };
    }
    return { dateFrom: null, dateTo: null };
  }

  async function renderSales(branchId) {
    const search = el('salesSearchInput')?.value || '';
    const { dateFrom, dateTo } = _getSalesDateFilterRange();
    if (dateFrom && dateTo && dateFrom > dateTo) {
      showToast('تاريخ البداية يجب أن يكون قبل أو مساوياً لتاريخ النهاية', true);
      return;
    }
    const paymentMethod = el('salesPaymentFilter')?.value || 'ALL';

    const rawSales = await client.getSales({
      branchId,
      dateFrom,
      dateTo,
      paymentMethod,
      search,
      limit: SALES_PAGE_SIZE + 1,
      offset: salesCurrentPage * SALES_PAGE_SIZE,
    });

    const hasNext = rawSales.length > SALES_PAGE_SIZE;
    const sales = hasNext ? rawSales.slice(0, SALES_PAGE_SIZE) : rawSales;

    const listEl = el('invoicesList');
    const pagBar = el('salesPaginationBar');
    const prevBtn = el('salesPrevPageBtn');
    const nextBtn = el('salesNextPageBtn');
    const pageLbl = el('salesPageIndicator');

    if (pagBar) {
      if (salesCurrentPage === 0 && !hasNext) {
        pagBar.classList.add('hidden');
      } else {
        pagBar.classList.remove('hidden');
        if (prevBtn) prevBtn.disabled = salesCurrentPage <= 0;
        if (nextBtn) nextBtn.disabled = !hasNext;
        if (pageLbl) pageLbl.textContent = `صفحة ${salesCurrentPage + 1} (${sales.length} فاتورة)`;
      }
    }

    if (!listEl) return;

    if (sales.length === 0) {
      listEl.innerHTML = `
        <div class="bg-white dark:bg-slate-900 p-8 rounded-2xl border border-slate-200 dark:border-slate-800 text-center">
          <i data-lucide="receipt" class="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2"></i>
          <p class="text-xs text-slate-500 font-medium">لا توجد فواتير مطابقة لخيارات البحث</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = sales.map(s => {
      const total = getSaleAmount(s);
      const method = s.payment_method || 'نقدي';
      const excluded = isSaleExcluded(s);
      let methodBadge = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
      if (method.toLowerCase().includes('card') || method.includes('فيزا')) {
        methodBadge = 'bg-purple-500/10 text-purple-600 dark:text-purple-400';
      } else if (method.toLowerCase().includes('insta') || method.includes('انستا')) {
        methodBadge = 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400';
      }

      const rawId = String(s.id || '');
      const invoiceLabel = s.invoice_no || rawId.substring(0, 8);

      return `
        <div class="invoice-card bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm hover:border-blue-400 transition cursor-pointer active:scale-[0.99]" data-id="${escapeHtml(rawId)}">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0 flex-wrap">
              <span class="text-xs font-black font-mono text-blue-600 dark:text-blue-400 num-ltr" dir="ltr">#${escapeHtml(invoiceLabel)}</span>
              <span class="text-xs font-bold px-2 py-0.5 rounded-full ${methodBadge}">${escapeHtml(method)}</span>
              ${excluded ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">مرتجع/ملغاة</span>` : ''}
            </div>
            <span class="text-sm font-black shrink-0 ${excluded ? 'line-through text-slate-400' : 'text-slate-900 dark:text-white'} num-ltr">${formatMoney(total)}</span>
          </div>

          <div class="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-slate-100 dark:border-slate-800/80 text-xs text-slate-400">
            <span class="truncate min-w-0">الكاشير: <strong class="text-slate-700 dark:text-slate-300">${escapeHtml(s.cashier_username || s.cashier_name || 'كاشير')}</strong></span>
            <span class="shrink-0">${escapeHtml(formatDateTime(s.sale_date || s.created_at))}</span>
          </div>
        </div>
      `;
    }).join('');

    // Attach click listeners to open detail modal
    listEl.querySelectorAll('.invoice-card').forEach(card => {
      card.addEventListener('click', async () => {
        const saleId = card.getAttribute('data-id');
        const sale = sales.find(x => String(x.id) === String(saleId));
        if (sale) {
          await openInvoiceModal(sale);
        }
      });
    });
  }

  async function openInvoiceModal(sale) {
    const invoiceModal = el('invoiceModal');
    if (!invoiceModal) return;

    const setEl = (id, val) => { const e = el(id); if (e) e.textContent = val; };
    setEl('modalInvoiceNo', `#${sale.invoice_no || String(sale.id || '').substring(0, 8)}`);
    setEl('modalInvoiceDate', formatDateTime(sale.sale_date || sale.created_at));
    setEl('modalCashierName', sale.cashier_username || sale.cashier_name || 'كاشير');
    setEl('modalCustomerName', sale.customer_name || 'عميل نقدي');
    setEl('modalPaymentMethod', sale.payment_method || 'نقدي (كاش)');
    setEl('modalBranchName', getBranchName(sale.branch_id));

    const total = getSaleAmount(sale);
    const subtotal = Number(sale.subtotal) > 0 ? Number(sale.subtotal) : total;
    const discount = Number(sale.discount ?? 0);
    const paid = Number(sale.paid_amount ?? total);

    setEl('modalSubtotal', formatMoney(subtotal));
    setEl('modalDiscount', `- ${formatMoney(discount)}`);
    setEl('modalTotal', formatMoney(total));
    setEl('modalPaid', formatMoney(paid));

    const tbody = el('modalItemsTbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-3 text-center text-slate-400">جاري تحميل أصناف الفاتورة...</td></tr>`;
    }

    invoiceModal.classList.remove('hidden');
    triggerIcons();

    try {
      const items = await client.getSaleDetails(sale.id);
      if (!tbody) return;
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-3 text-center text-slate-400">لا توجد تفاصيل أصناف محفوظة لهذه الفاتورة</td></tr>`;
      } else {
        tbody.innerHTML = items.map(item => `
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40">
            <td class="p-2 font-semibold text-slate-800 dark:text-slate-200">
              ${escapeHtml(item.product_name || item.name || 'صنف')}
              <span class="block text-[10px] text-slate-400 num-ltr">${escapeHtml(item.barcode_ean13 || item.barcode || '')}</span>
            </td>
            <td class="p-2 text-center font-bold">${escapeHtml(item.quantity ?? item.qty ?? 1)}</td>
            <td class="p-2 text-center num-ltr">${formatMoney(item.unit_price || 0)}</td>
            <td class="p-2 text-left font-bold num-ltr">${formatMoney(item.total_price || 0)}</td>
          </tr>
        `).join('');
      }
    } catch (err) {
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-3 text-center text-rose-500">تعذر تحميل الأصناف: ${escapeHtml(err.message)}</td></tr>`;
      }
    }
  }

  // =========================================================================
  // VIEW 3: INVENTORY (PRODUCTS)
  // =========================================================================
  async function renderInventory(branchId) {
    const search = el('inventorySearchInput')?.value || '';
    const lowStockOnly = el('lowStockOnlyToggle')?.checked || false;

    const products = await client.getProducts({
      branchId,
      search,
      lowStockOnly,
      limit: lowStockOnly ? 5000 : 100,
    });

    const badgeEl = el('inventoryCountBadge');
    if (badgeEl) {
      badgeEl.textContent = `${products.length} صنف`;
    }

    const listEl = el('productsList');
    if (!listEl) return;

    if (products.length === 0) {
      listEl.innerHTML = `
        <div class="bg-white dark:bg-slate-900 p-8 rounded-2xl border border-slate-200 dark:border-slate-800 text-center">
          <i data-lucide="package" class="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2"></i>
          <p class="text-xs text-slate-500 font-medium">لا توجد أصناف مطابقة للبحث</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = products.map(p => {
      const name = p.product_name || p.name || 'بدون اسم';
      const barcode = p.barcode_ean13 || p.barcode || 'بدون باركود';
      const stock = Number(p.stock_quantity ?? p.stock_qty ?? 0);
      const minStock = Number(p.min_stock ?? 5);
      const salePrice = Number(p.sale_price ?? p.sell_price ?? 0);
      const minSalePrice = Number(p.min_sale_price ?? 0);
      const maxSalePrice = Number(p.max_sale_price ?? 0);
      const costPrice = Number(p.cost_price ?? p.buy_price ?? 0);
      const isLow = stock <= minStock;

      return `
        <div class="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border ${isLow ? 'border-amber-300 dark:border-amber-900/60' : 'border-slate-200 dark:border-slate-800'} shadow-sm flex flex-col justify-between gap-2.5">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h4 class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(name)}</h4>
              <p class="text-xs text-slate-400 num-ltr font-mono mt-0.5 truncate" dir="ltr">${escapeHtml(barcode)}</p>
            </div>
            <span class="text-xs font-bold px-2.5 py-0.5 rounded-full shrink-0 ${isLow ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}">
              ${escapeHtml(stock)} في المخزن
            </span>
          </div>

          <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80 text-xs">
            <div class="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>سعر البيع: <strong class="text-blue-600 dark:text-blue-400 font-black num-ltr">${formatMoney(salePrice)}</strong></span>
              <span class="text-slate-400 text-xs">التكلفة: <strong class="num-ltr">${formatMoney(costPrice)}</strong></span>
              ${(minSalePrice > 0 || maxSalePrice > 0) ? `<span class="text-xs text-slate-500 dark:text-slate-400 num-ltr">(${minSalePrice > 0 ? 'أدنى: ' + minSalePrice : ''}${minSalePrice > 0 && maxSalePrice > 0 ? ' / ' : ''}${maxSalePrice > 0 ? 'أقصى: ' + maxSalePrice : ''})</span>` : ''}
            </div>

            <button type="button" class="edit-product-btn min-h-[44px] min-w-[44px] bg-slate-100 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-bold text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center gap-1 active:scale-95 transition shrink-0"
              data-id="${escapeHtml(p.id)}" data-name="${encodeURIComponent(name)}" data-price="${escapeHtml(salePrice)}" data-min-sale="${escapeHtml(minSalePrice)}" data-max-sale="${escapeHtml(maxSalePrice)}" data-min="${escapeHtml(minStock)}">
              <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
              <span>تعديل السعر</span>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Attach Edit button listeners
    listEl.querySelectorAll('.edit-product-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const name = decodeURIComponent(btn.getAttribute('data-name') || '');
        const price = btn.getAttribute('data-price') || '0';
        const minSale = btn.getAttribute('data-min-sale') || '0';
        const maxSale = btn.getAttribute('data-max-sale') || '0';
        const minStockVal = btn.getAttribute('data-min') || '5';

        const eId = el('editProductId'); if (eId) eId.value = id;
        const eName = el('editProductName'); if (eName) eName.value = name;
        const ePrice = el('editProductSalePrice'); if (ePrice) ePrice.value = price;
        const eMinSale = el('editProductMinSalePrice'); if (eMinSale) eMinSale.value = minSale;
        const eMaxSale = el('editProductMaxSalePrice'); if (eMaxSale) eMaxSale.value = maxSale;
        const eMin = el('editProductMinStock'); if (eMin) eMin.value = minStockVal;

        const productModal = el('productModal');
        if (productModal) {
          productModal.classList.remove('hidden');
        }
      });
    });
  }

  // =========================================================================
  // VIEW 4: TREASURY & SHIFTS
  // =========================================================================
  async function renderTreasury(branchId) {
    const isShiftsActive = !el('subtabShiftsContent')?.classList.contains('hidden');

    if (isShiftsActive) {
      await renderShiftsLogs(branchId);
    } else {
      await renderTreasuryLogs(branchId);
    }
  }

  async function renderTreasuryLogs(branchId) {
    const logs = await client.getTreasuryLogs({ branchId, limit: 50 });
    const listEl = el('treasuryLogsList');
    if (!listEl) return;

    if (logs.length === 0) {
      listEl.innerHTML = `
        <div class="bg-white dark:bg-slate-900 p-8 rounded-2xl border border-slate-200 dark:border-slate-800 text-center">
          <i data-lucide="coins" class="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2"></i>
          <p class="text-xs text-slate-500 font-medium">لا توجد حركات مسجلة في الخزينة</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = logs.map(l => {
      const shiftFeed = isShiftFeed(l);
      const actualExpense = isActualExpense(l);
      const isOutflow = actualExpense || shiftFeed;
      const amount = Math.abs(Number(l.amount || 0));

      let defaultTitle = 'توريد للخزينة';
      let badgeLabel = 'وارد';
      let colorClasses = 'bg-emerald-500/10 text-emerald-500';
      let amountColor = 'text-emerald-600 dark:text-emerald-400';

      if (shiftFeed) {
        defaultTitle = 'تغذية وردية (صادر من الخزينة)';
        badgeLabel = 'صادر - تغذية وردية';
        colorClasses = 'bg-amber-500/10 text-amber-500';
        amountColor = 'text-amber-600 dark:text-amber-400';
      } else if (actualExpense) {
        defaultTitle = 'مصروف عام';
        badgeLabel = 'مصروف';
        colorClasses = 'bg-rose-500/10 text-rose-500';
        amountColor = 'text-rose-600 dark:text-rose-400';
      }

      const titleText = l.notes || l.note || l.category || defaultTitle;

      return `
        <div class="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl ${colorClasses} flex items-center justify-center font-bold text-xs">
              <i data-lucide="${isOutflow ? 'arrow-down-left' : 'arrow-up-right'}" class="w-4 h-4"></i>
            </div>
            <div>
              <div class="flex items-center gap-1.5">
                <h4 class="text-xs font-bold text-slate-900 dark:text-white">${escapeHtml(titleText)}</h4>
                <span class="text-[9px] font-bold px-1.5 py-0.5 rounded ${colorClasses}">${escapeHtml(badgeLabel)}</span>
              </div>
              <p class="text-[10px] text-slate-400 mt-0.5">
                ${escapeHtml(formatDateTime(l.created_at))} • المسؤول: ${escapeHtml(l.username || 'كاشير')}
              </p>
            </div>
          </div>
          <div class="text-left">
            <span class="text-xs font-black ${amountColor} num-ltr">
              ${isOutflow ? '-' : '+'} ${formatMoney(amount)}
            </span>
            <span class="block text-[9px] text-slate-400 font-medium">${escapeHtml(l.payment_method || 'نقدي')}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  async function renderShiftsLogs(branchId) {
    const [shiftsRes, salesRes, logsRes] = await Promise.allSettled([
      client.getShifts({ branchId, limit: 30 }),
      client.getSales({ branchId, limit: 100 }),
      client.getTreasuryLogs({ branchId, limit: 100 }),
    ]);

    if (shiftsRes.status === 'rejected') {
      throw shiftsRes.reason;
    }

    const shifts = shiftsRes.value || [];
    const recentSales = salesRes.status === 'fulfilled' ? (salesRes.value || []) : [];
    const todayLogs = logsRes.status === 'fulfilled' ? (logsRes.value || []) : [];

    const listEl = el('shiftsLogsList');
    if (!listEl) return;

    if (shifts.length === 0) {
      listEl.innerHTML = `
        <div class="bg-white dark:bg-slate-900 p-8 rounded-2xl border border-slate-200 dark:border-slate-800 text-center">
          <i data-lucide="clock" class="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2"></i>
          <p class="text-xs text-slate-500 font-medium">لا توجد ورديات مسجلة</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = shifts.map(s => {
      const stNorm = String(s.status || '').trim().toLowerCase();
      const isOpen = (stNorm === 'open' || stNorm.includes('مفتوح')) && !s.end_time;
      const openingCash = Number(s.opening_cash ?? s.starting_cash ?? 0);
      const cashReturns = Number(s.cash_returns || 0);
      let sales = Number(s.total_sales || 0);
      let cashSales = Number(s.cash_sales || 0);
      let expenses = Number(s.expenses || 0);

      // حساب لحظي لمبيعات الوردية ونقدية الدرج إن كانت مفتوحة
      if (isOpen) {
        const sStart = s.start_time ? new Date(s.start_time).getTime() : 0;
        const sUser = String(s.username || s.cashier_name || '').toLowerCase().trim();
        const sLocalId = Number(s.local_shift_id || 0);

        let realTimeSales = 0;
        let realTimeCash = 0;
        for (const sale of (recentSales || [])) {
          if (isSaleExcluded(sale)) continue;
          const saleTime = new Date(sale.sale_date || sale.created_at).getTime();
          const saleUser = String(sale.cashier_username || sale.cashier_name || '').toLowerCase().trim();
          const saleShiftId = Number(sale.local_shift_id || sale.shift_id || 0);

          const matches = (sLocalId > 0 && saleShiftId === sLocalId) ||
                          (saleTime >= sStart && (!sUser || !saleUser || sUser === saleUser));
          if (matches) {
            const amt = getSaleAmount(sale);
            realTimeSales += amt;
            realTimeCash += getSaleCashAmount(sale);
          }
        }
        sales = Math.max(sales, realTimeSales);
        cashSales = Math.max(cashSales, realTimeCash);

        // حساب مصروفات الوردية الفعلية فقط (استبعاد توريد_للخزينة وتغذية_وردية) إن لم تكن مسجلة بالسحابة
        if (expenses <= 0 && todayLogs && todayLogs.length > 0) {
          for (const exp of todayLogs) {
            if (!isActualExpense(exp)) continue;
            const expTime = new Date(exp.created_at).getTime();
            const expShift = Number(exp.shift_id || 0);
            if ((sLocalId > 0 && expShift === sLocalId) || (expTime >= sStart)) {
              expenses += Math.abs(Number(exp.amount || 0));
            }
          }
        }
      }

      const drawerCashLabel = isOpen ? 'المتوقع بالدرج:' : 'الفعلي بالدرج:';
      const drawerCashVal = isOpen
        ? (openingCash + cashSales - cashReturns - expenses)
        : Number(s.actual_cash ?? s.closing_cash ?? 0);
      const variance = Number(s.handover_variance ?? 0);

      return `
        <div class="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-2.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xs font-black text-slate-900 dark:text-white">${escapeHtml(s.cashier_name || s.username || 'كاشير')}</span>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${isOpen ? 'bg-emerald-500/10 text-emerald-600 animate-pulse' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}">
                ${isOpen ? '🟢 جارية حالياً' : 'مغلقة'}
              </span>
            </div>
            <span class="text-xs font-black text-blue-600 dark:text-blue-400 num-ltr">${formatMoney(sales)}</span>
          </div>

          <div class="grid grid-cols-2 gap-2 text-[11px] bg-slate-50 dark:bg-slate-800/40 p-2.5 rounded-xl text-slate-500 dark:text-slate-400">
            <div>البدء: <strong class="text-slate-700 dark:text-slate-300">${escapeHtml(formatDateTime(s.start_time))}</strong></div>
            <div>الإغلاق: <strong class="text-slate-700 dark:text-slate-300">${escapeHtml(s.end_time ? formatDateTime(s.end_time) : 'مفتوحة')}</strong></div>
            <div>رصيد الافتتاح: <strong class="text-slate-700 dark:text-slate-300 num-ltr">${formatMoney(openingCash)}</strong></div>
            <div>${drawerCashLabel} <strong class="text-slate-700 dark:text-slate-300 num-ltr">${formatMoney(drawerCashVal)}</strong></div>
          </div>

          ${!isOpen && variance !== 0 ? `
            <div class="text-[11px] font-bold flex justify-between ${variance < 0 ? 'text-rose-500' : 'text-emerald-500'}">
              <span>${variance < 0 ? 'عجز في الدرج:' : 'زيادة في الدرج:'}</span>
              <span class="num-ltr">${formatMoney(Math.abs(variance))}</span>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  // =========================================================================
  // VIEW 5: STAFF MANAGEMENT
  // =========================================================================
  async function renderStaff() {
    const staff = await client.getStaffUsers();
    const listEl = el('staffList');
    if (!listEl) return;

    if (staff.length === 0) {
      listEl.innerHTML = `
        <div class="bg-white dark:bg-slate-900 p-8 rounded-2xl border border-slate-200 dark:border-slate-800 text-center">
          <i data-lucide="users" class="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2"></i>
          <p class="text-xs text-slate-500 font-medium">لا يوجد موظفون مسجلون</p>
        </div>
      `;
      return;
    }

    const isAdminRoleStr = (r) => {
      const n = String(r || '').trim().toLowerCase();
      return ['admin', 'manager', 'owner', 'مدير', 'ادمن', 'صاحب المحل', 'المسؤول'].includes(n);
    };
    const activeAdminsCount = staff.filter(u => Boolean(u.is_active) && !Boolean(u.is_deleted) && isAdminRoleStr(u.role)).length;

    listEl.innerHTML = staff.map(u => {
      const isActive = Boolean(u.is_active);
      const role = u.role || 'Cashier';
      const isProtected = Boolean(u.is_protected_admin);
      const isLastAdmin = isActive && !Boolean(u.is_deleted) && isAdminRoleStr(role) && activeAdminsCount <= 1;
      const lockProtectedUi = isProtected || isLastAdmin;
      const branchName = getBranchName(u.branch_id);
      const initialChar = (u.full_name || u.username || 'م').substring(0, 1);

      return `
        <div class="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl shrink-0 ${isActive ? 'bg-blue-500/10 text-blue-500' : 'bg-slate-200 dark:bg-slate-800 text-slate-400'} flex items-center justify-center font-black text-sm">
              ${escapeHtml(initialChar)}
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <h4 class="text-xs font-bold text-slate-900 dark:text-white truncate">${escapeHtml(u.full_name || u.username)}</h4>
                <span class="text-xs bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold px-1.5 py-0.5 rounded shrink-0">${escapeHtml(role)}</span>
                ${lockProtectedUi ? `<span class="text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold px-1.5 py-0.5 rounded shrink-0">🛡️ ${isProtected ? 'رئيسي محمي' : 'آخر مدير'}</span>` : ''}
              </div>
              <p class="text-xs text-slate-400 mt-0.5 truncate">
                <span class="font-mono" dir="ltr">@${escapeHtml(u.username)}</span> • ${escapeHtml(branchName)}
              </p>
            </div>
          </div>

          <!-- Actions & Toggle (gap-3 = 12px touch spacing, min 44x44px targets) -->
          <div class="flex items-center gap-3 shrink-0">
            <!-- Active Toggle Button (معطّل للمدير المحمي وآخر Admin نشط) -->
            ${lockProtectedUi && isActive ? `
              <button type="button" disabled title="لا يمكن تعطيل حساب المدير المحمي أو آخر مدير نشط"
                class="min-h-[44px] min-w-[44px] text-xs font-bold px-3 py-2 rounded-xl flex items-center gap-1.5 bg-emerald-500/10 text-emerald-600/60 dark:text-emerald-400/60 border border-emerald-500/20 opacity-60 cursor-not-allowed">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                <span>محمي</span>
              </button>
            ` : `
              <button class="toggle-staff-btn min-h-[44px] min-w-[44px] text-xs font-bold px-3 py-2 rounded-xl transition flex items-center gap-1.5 active:scale-95 ${isActive ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'}"
                data-id="${escapeHtml(u.id)}" data-active="${isActive}">
                <span class="w-1.5 h-1.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
                <span>${isActive ? 'نشط' : 'معطّل'}</span>
              </button>
            `}

            <!-- Change Password Button -->
            <button class="change-pwd-btn min-h-[44px] min-w-[44px] w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 active:scale-95 transition"
              data-id="${escapeHtml(u.id)}" data-name="${encodeURIComponent(u.full_name || u.username)}" title="تغيير كلمة المرور">
              <i data-lucide="key" class="w-4 h-4"></i>
            </button>

            <!-- Delete Button (مخفي/معطّل للمدير المحمي وآخر Admin نشط) -->
            ${lockProtectedUi ? '' : `
              <button class="delete-staff-btn min-h-[44px] min-w-[44px] w-11 h-11 rounded-xl bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 flex items-center justify-center text-rose-500 active:scale-95 transition"
                data-id="${escapeHtml(u.id)}" data-username="${escapeHtml(u.username)}" title="حذف الموظف">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            `}
          </div>
        </div>
      `;
    }).join('');

    // Toggle Status Click
    listEl.querySelectorAll('.toggle-staff-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const currentlyActive = btn.getAttribute('data-active') === 'true';
        const newStatus = !currentlyActive;

        try {
          await client.toggleStaffStatus(id, newStatus);
          showToast(newStatus ? 'تم تفعيل حساب الموظف فورياً' : 'تم تعطيل حساب الموظف ومنعه من الدخول');
          await renderStaff();
        } catch (err) {
          showToast(err.message || 'فشل تعديل حالة الموظف', true);
        }
      });
    });

    // Change Password Click
    listEl.querySelectorAll('.change-pwd-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const name = decodeURIComponent(btn.getAttribute('data-name') || '');
        const cpId = el('changePasswordUserId'); if (cpId) cpId.value = id;
        const cpName = el('changePasswordStaffName'); if (cpName) cpName.value = name;
        const cpPwd = el('newStaffPasswordInput'); if (cpPwd) cpPwd.value = '';

        const changePasswordModal = el('changePasswordModal');
        if (changePasswordModal) {
          changePasswordModal.classList.remove('hidden');
        }
      });
    });

    // Delete Staff Click
    listEl.querySelectorAll('.delete-staff-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const username = btn.getAttribute('data-username');
        const confirmed = confirm(`هل أنت متأكد من حذف الموظف (@${username}) نهائياً؟\nسيتم تعطيل حسابه وإزالته من شاشات الكاشير.`);
        if (confirmed) {
          try {
            await client.deleteStaffUser(id);
            showToast(`تم حذف الموظف (@${username}) بنجاح`);
            await renderStaff();
          } catch (err) {
            showToast(err.message || 'فشل حذف الموظف', true);
          }
        }
      });
    });
  }

  // =========================================================================
  // Forms & Modal Handlers Setup
  // =========================================================================
  function setupModalsAndForms() {
    // 1. Invoice Modal Close
    el('closeInvoiceModalBtn')?.addEventListener('click', () => {
      el('invoiceModal')?.classList.add('hidden');
    });

    // 2. Product Modal Close / Cancel
    el('closeProductModalBtn')?.addEventListener('click', () => {
      el('productModal')?.classList.add('hidden');
    });
    el('cancelProductModalBtn')?.addEventListener('click', () => {
      el('productModal')?.classList.add('hidden');
    });

    // Product Form Submit (تعديل السعر الطبيعي + الأدنى + الأقصى + حد الطلب مع التحقق الصارم)
    el('editProductForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = el('editProductId')?.value;
      const sale_price = parseFloat(el('editProductSalePrice')?.value ?? '');
      const min_sale_price = parseFloat(el('editProductMinSalePrice')?.value ?? '0');
      const max_sale_price = parseFloat(el('editProductMaxSalePrice')?.value ?? '0');
      const min_stock = parseInt(el('editProductMinStock')?.value ?? '0', 10);

      if (isNaN(sale_price) || isNaN(min_sale_price) || isNaN(max_sale_price) || isNaN(min_stock)) {
        showToast('يرجى إدخال أرقام صحيحة في جميع الحقول', true);
        return;
      }
      if (sale_price < 0 || min_sale_price < 0 || max_sale_price < 0 || min_stock < 0) {
        showToast('القيم السالبة غير مسموحة', true);
        return;
      }
      if (sale_price <= 0) {
        showToast('سعر البيع الطبيعي يجب أن يكون أكبر من صفر', true);
        return;
      }
      if (min_sale_price > 0 && min_sale_price > sale_price) {
        showToast('الحد الأدنى للبيع لا يمكن أن يتجاوز سعر البيع الطبيعي', true);
        return;
      }
      if (max_sale_price > 0 && sale_price > max_sale_price) {
        showToast('سعر البيع الطبيعي لا يمكن أن يتجاوز الحد الأقصى للبيع', true);
        return;
      }
      if (min_sale_price > 0 && max_sale_price > 0 && min_sale_price > max_sale_price) {
        showToast('الحد الأدنى للبيع لا يمكن أن يكون أكبر من الحد الأقصى للبيع', true);
        return;
      }

      try {
        await client.updateProduct(id, { sale_price, min_sale_price, max_sale_price, min_stock });
        showToast('تم حفظ ومزامنة أسعار وبيانات الصنف فورياً');
        el('productModal')?.classList.add('hidden');
        await renderInventory(client.getActiveBranch());
      } catch (err) {
        showToast(err.message || 'فشل تحديث الصنف', true);
      }
    });

    // 3. Add Staff Modal Open / Close
    el('openAddStaffModalBtn')?.addEventListener('click', () => {
      const u = el('newStaffUsername'); if (u) u.value = '';
      const f = el('newStaffFullName'); if (f) f.value = '';
      const p = el('newStaffPassword'); if (p) p.value = '';
      el('addStaffModal')?.classList.remove('hidden');
    });
    el('closeAddStaffModalBtn')?.addEventListener('click', () => {
      el('addStaffModal')?.classList.add('hidden');
    });
    el('cancelAddStaffModalBtn')?.addEventListener('click', () => {
      el('addStaffModal')?.classList.add('hidden');
    });

    // Add Staff Form Submit
    el('addStaffForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (el('newStaffUsername')?.value || '').trim();
      const full_name = (el('newStaffFullName')?.value || '').trim();
      const password = el('newStaffPassword')?.value || '';
      const role = el('newStaffRole')?.value || 'Cashier';
      const branch_id = el('newStaffBranch')?.value || null;

      if (password.length < 6) {
        showToast('كلمة المرور يجب أن تحتوي على 6 خانات على الأقل', true);
        return;
      }

      try {
        await client.createStaffUser({ username, full_name, password, role, branch_id });
        showToast(`تم إنشاء وتشفير حساب الموظف (@${username}) بنجاح`);
        el('addStaffModal')?.classList.add('hidden');
        await renderStaff();
      } catch (err) {
        showToast(err.message || 'فشل إنشاء حساب الموظف', true);
      }
    });

    // 4. Change Password Modal Close
    el('closeChangePasswordModalBtn')?.addEventListener('click', () => {
      el('changePasswordModal')?.classList.add('hidden');
    });
    el('cancelChangePasswordModalBtn')?.addEventListener('click', () => {
      el('changePasswordModal')?.classList.add('hidden');
    });

    // Change Password Form Submit
    el('changePasswordForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const userId = el('changePasswordUserId')?.value;
      const newPassword = el('newStaffPasswordInput')?.value || '';

      if (newPassword.length < 6) {
        showToast('كلمة المرور يجب أن تحتوي على 6 خانات على الأقل', true);
        return;
      }

      try {
        await client.updateStaffUser(userId, { password: newPassword });
        showToast('تم تغيير وتشفير كلمة المرور الجديدة بـ PBKDF2 بنجاح');
        el('changePasswordModal')?.classList.add('hidden');
      } catch (err) {
        showToast(err.message || 'فشل تغيير كلمة المرور', true);
      }
    });

    // Subtab Treasury switcher
    const treasuryBtn = el('subtabTreasuryBtn');
    const shiftsBtn = el('subtabShiftsBtn');
    const treasuryContent = el('subtabTreasuryContent');
    const shiftsContent = el('subtabShiftsContent');

    if (treasuryBtn && shiftsBtn) {
      treasuryBtn.addEventListener('click', () => {
        treasuryBtn.classList.add('bg-white', 'dark:bg-slate-900', 'text-blue-600', 'dark:text-blue-400', 'shadow-sm');
        treasuryBtn.classList.remove('text-slate-600', 'dark:text-slate-400');
        shiftsBtn.classList.remove('bg-white', 'dark:bg-slate-900', 'text-blue-600', 'dark:text-blue-400', 'shadow-sm');
        shiftsBtn.classList.add('text-slate-600', 'dark:text-slate-400');

        if (treasuryContent) treasuryContent.classList.remove('hidden');
        if (shiftsContent) shiftsContent.classList.add('hidden');
        renderTreasuryLogs(client.getActiveBranch());
      });

      shiftsBtn.addEventListener('click', () => {
        shiftsBtn.classList.add('bg-white', 'dark:bg-slate-900', 'text-blue-600', 'dark:text-blue-400', 'shadow-sm');
        shiftsBtn.classList.remove('text-slate-600', 'dark:text-slate-400');
        treasuryBtn.classList.remove('bg-white', 'dark:bg-slate-900', 'text-blue-600', 'dark:text-blue-400', 'shadow-sm');
        treasuryBtn.classList.add('text-slate-600', 'dark:text-slate-400');

        if (shiftsContent) shiftsContent.classList.remove('hidden');
        if (treasuryContent) treasuryContent.classList.add('hidden');
        renderShiftsLogs(client.getActiveBranch());
      });
    }

    // Filter listeners for Sales & Inventory with 350ms debounce on search inputs
    const _syncSalesDatePickersVisibility = () => {
      const mode = el('salesDateFilter')?.value || 'ALL';
      const dayBox = el('salesDayContainer');
      const rangeBox = el('salesRangeContainer');
      const todayCairo = (client && typeof client.getCairoDateStr === 'function')
        ? client.getCairoDateStr(new Date())
        : new Date().toISOString().slice(0, 10);

      if (dayBox) {
        if (mode === 'DAY') {
          dayBox.classList.remove('hidden');
          const dInp = el('salesDateInput');
          if (dInp && !dInp.value) dInp.value = todayCairo;
        } else {
          dayBox.classList.add('hidden');
        }
      }
      if (rangeBox) {
        if (mode === 'RANGE') {
          rangeBox.classList.remove('hidden');
          const fInp = el('salesDateFrom');
          const tInp = el('salesDateTo');
          if (fInp && !fInp.value) fInp.value = todayCairo;
          if (tInp && !tInp.value) tInp.value = todayCairo;
        } else {
          rangeBox.classList.add('hidden');
        }
      }
    };

    const debouncedRenderSales = debounce(() => {
      salesCurrentPage = 0;
      renderSales(client.getActiveBranch());
    }, 350);
    const debouncedRenderInventory = debounce(() => renderInventory(client.getActiveBranch()), 350);

    el('salesSearchInput')?.addEventListener('input', debouncedRenderSales);
    el('salesDateFilter')?.addEventListener('change', () => {
      salesCurrentPage = 0;
      _syncSalesDatePickersVisibility();
      renderSales(client.getActiveBranch());
    });
    el('salesDateInput')?.addEventListener('change', () => {
      salesCurrentPage = 0;
      renderSales(client.getActiveBranch());
    });
    el('salesDateFrom')?.addEventListener('change', () => {
      salesCurrentPage = 0;
      renderSales(client.getActiveBranch());
    });
    el('salesDateTo')?.addEventListener('change', () => {
      salesCurrentPage = 0;
      renderSales(client.getActiveBranch());
    });
    el('salesPaymentFilter')?.addEventListener('change', () => {
      salesCurrentPage = 0;
      renderSales(client.getActiveBranch());
    });
    el('salesPrevPageBtn')?.addEventListener('click', () => {
      if (salesCurrentPage > 0) {
        salesCurrentPage -= 1;
        renderSales(client.getActiveBranch());
      }
    });
    el('salesNextPageBtn')?.addEventListener('click', () => {
      salesCurrentPage += 1;
      renderSales(client.getActiveBranch());
    });

    el('inventorySearchInput')?.addEventListener('input', debouncedRenderInventory);
    el('lowStockOnlyToggle')?.addEventListener('change', () => renderInventory(client.getActiveBranch()));

    // "عرض الكل" button on Dashboard Low Stock card -> switch to Inventory with low stock on
    el('viewAllLowStockBtn')?.addEventListener('click', () => {
      const toggle = el('lowStockOnlyToggle');
      if (toggle) toggle.checked = true;
      switchTab('inventory');
    });
  }

  // =========================================================================
  // Virtual Keyboard Focus Handling (scrollIntoView)
  // =========================================================================
  function setupVirtualKeyboardScroll() {
    document.addEventListener('focusin', (e) => {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        setTimeout(() => {
          try {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } catch (_) {}
        }, 250);
      }
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
          setTimeout(() => {
            try {
              active.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch (_) {}
          }, 100);
        }
      });
    }
  }

  // =========================================================================
  // Supabase Realtime — تحديث فوري للواجهة عند أي تغيير على الكمبيوتر
  // =========================================================================
  let _realtimeUnsubscribe = null;
  let _realtimeDebounceTimer = null;
  const _realtimePendingTables = new Set();

  function startRealtimeSync() {
    if (!client || !client.isLoggedIn()) return;
    if (_realtimeUnsubscribe) {
      try { _realtimeUnsubscribe(); } catch (_) {}
      _realtimeUnsubscribe = null;
    }

    _realtimeUnsubscribe = client.subscribeRealtime((table, eventType, record) => {
      // تجميع الجداول المتغيرة مع Debounce 500ms ثم تحديث التبويب المفتوح حالياً فقط عند صلته بالتغيير
      _realtimePendingTables.add(table);
      clearTimeout(_realtimeDebounceTimer);
      _realtimeDebounceTimer = setTimeout(() => {
        const tables = new Set(_realtimePendingTables);
        _realtimePendingTables.clear();

        if (tables.has('staff_users')) {
          _checkCurrentUserStatus();
        }

        const tab = currentTab;
        const shouldRefreshTab =
          (tab === 'dashboard' && (tables.has('sales') || tables.has('shifts') || tables.has('treasury_logs') || tables.has('products'))) ||
          (tab === 'sales' && tables.has('sales')) ||
          (tab === 'inventory' && tables.has('products')) ||
          (tab === 'treasury' && (tables.has('shifts') || tables.has('treasury_logs'))) ||
          (tab === 'staff' && tables.has('staff_users'));

        if (shouldRefreshTab) {
          refreshCurrentTab();
        }
      }, 500);
    });
  }

  function setupVisibilityAutoRefresh() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && client && client.isLoggedIn()) {
        const nowMs = Date.now();
        if (nowMs - lastVisibilityRefreshAt >= 2000) {
          lastVisibilityRefreshAt = nowMs;
          refreshCurrentTab();
        }
      }
    });
  }

  function stopRealtimeSync() {
    if (_realtimeUnsubscribe) {
      try { _realtimeUnsubscribe(); } catch (_) {}
      _realtimeUnsubscribe = null;
    }
    clearTimeout(_realtimeDebounceTimer);
    _realtimePendingTables.clear();
  }

  async function _checkCurrentUserStatus() {
    if (!client || !client.isLoggedIn()) return;
    try {
      const session = client.session;
      if (!session || !session.username) return;
      const rows = await client.request(
        `/staff_users?store_id=eq.${client.config.storeId}&username=eq.${encodeURIComponent(session.username)}&select=is_active,is_deleted`
      );
      if (!rows || rows.length === 0) return;
      const u = rows[0];
      if (!u.is_active || u.is_deleted) {
        // طرد فوري: مسح الجلسة وإظهار رسالة وإعادة شاشة تسجيل الدخول
        client.clearSession();
        stopRealtimeSync();
        showToast('تم إيقاف صلاحية حسابك من قِبل الإدارة', true);
        setTimeout(() => { showLoginModal(); }, 1500);
      }
    } catch (_) {}
  }

  // =========================================================================
  // Initial App Load
  // =========================================================================
  async function loadInitialAppData() {
    try {
      updateStaffTabVisibility();
      const [, storeRes] = await Promise.allSettled([
        loadBranches(),
        client.getStoreInfo(),
      ]);
      const store = storeRes.status === 'fulfilled' ? storeRes.value : null;
      const headerStoreName = el('headerStoreName');
      if (store && headerStoreName) {
        headerStoreName.textContent = store.name || store.store_name || 'متجر إلكينج';
      }
      await refreshCurrentTab();
      // تفعيل الاشتراك اللحظي Realtime بعد تحميل البيانات الأولية
      startRealtimeSync();
    } catch (err) {
      console.debug('Error on initial load:', err);
    }
  }

  // =========================================================================
  // Bootstrap — runs AFTER DOM is fully parsed and scripts loaded
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    // 1. Resolve client AFTER all scripts are loaded (safe here)
    if (window.SupabaseClient) {
      client = window.SupabaseClient;
    } else {
      console.error('SupabaseClient not found — check script load order');
      showToast('تعذّر تحميل مكوّن الاتصال — يرجى تحديث الصفحة', true);
      return;
    }

    // 2. Init in correct order: theme → URL params → events → auth check
    try { initTheme(); } catch (e) { console.debug('initTheme error:', e); }
    try { handleUrlOnboarding(); } catch (e) { console.debug('handleUrlOnboarding error:', e); }
    try { setupAuthEvents(); } catch (e) { console.debug('setupAuthEvents error:', e); }
    try { setupNavigation(); } catch (e) { console.debug('setupNavigation error:', e); }
    try { setupModalsAndForms(); } catch (e) { console.debug('setupModalsAndForms error:', e); }
    try { setupVirtualKeyboardScroll(); } catch (e) { console.debug('setupVirtualKeyboardScroll error:', e); }
    try { setupVisibilityAutoRefresh(); } catch (e) { console.debug('setupVisibilityAutoRefresh error:', e); }
    try { setupPwaInstall(); } catch (e) { console.debug('setupPwaInstall error:', e); }
    try { triggerIcons(); } catch (e) { console.debug('triggerIcons error:', e); }
    try { checkAuth(); } catch (e) { console.debug('checkAuth error:', e); }
  });
})();
