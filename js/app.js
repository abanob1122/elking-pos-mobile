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

  // Client will be resolved after DOM ready (scripts guaranteed loaded by then)
  let client = null;

  // =========================================================================
  // Safe lazy DOM getter — never crashes if element doesn't exist
  // =========================================================================
  function el(id) {
    return document.getElementById(id);
  }

  // =========================================================================
  // Formatting & Utility Helpers
  // =========================================================================
  function formatMoney(amount) {
    const num = Number(amount || 0);
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';
  }

  function formatDateTime(isoString) {
    if (!isoString) return '---';
    try {
      const d = new Date(isoString);
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
  function initTheme() {
    const saved = localStorage.getItem('elking_pwa_theme');
    if (saved === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }

    const themeToggleBtn = el('themeToggleBtn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('elking_pwa_theme', isDark ? 'dark' : 'light');
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

        // حفظ المعرف واسم المتجر فورياً في الإعدادات
        if (client) {
          client.saveConfig({ storeId: cleanStoreId, storeName: decodedName });
        }
        localStorage.setItem('elking_pwa_store_name', decodedName);

        // تنظيف الرابط في المتصفح دون إعادة تحميل الصفحة
        // نستخدم pathname لحفظ المسار الفرعي /elking-pos-mobile/
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

    // ملء حقول إعدادات الخادم من القيم المحفوظة
    const cfgUrl = el('cfgUrl');
    const cfgKey = el('cfgKey');
    const cfgStoreId = el('cfgStoreId');

    if (client) {
      if (cfgUrl) cfgUrl.value = client.config.url || '';
      if (cfgKey) cfgKey.value = client.config.anonKey || '';
      if (cfgStoreId) cfgStoreId.value = client.config.storeId || '';
    }

    // تحديث شارة المتجر المتصل
    const badge = el('connectedStoreBadge');
    const nameEl = el('connectedStoreName');
    const savedStoreName = localStorage.getItem('elking_pwa_store_name')
      || (client && client.config.storeName)
      || 'متجر إلكينج';
    const storeId = client && client.config.storeId;

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

    // تركيز المؤشر مباشرة على خانة اسم المستخدم
    setTimeout(() => {
      const userInp = el('loginUsername');
      if (userInp) userInp.focus();
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
    const panel = el('serverSettingsPanel');
    const chevron = el('chevronSettings');

    if (changeStoreBtn && panel) {
      changeStoreBtn.addEventListener('click', () => {
        panel.classList.remove('hidden');
        if (chevron) {
          chevron.style.transform = 'rotate(180deg)';
        }
        const cfgStoreInp = el('cfgStoreId');
        if (cfgStoreInp) {
          cfgStoreInp.focus();
          cfgStoreInp.select();
        }
      });
    }

    // Accordion for Server Settings in Login
    const toggleBtn = el('toggleServerSettingsBtn');
    if (toggleBtn && panel) {
      toggleBtn.addEventListener('click', () => {
        const isHidden = panel.classList.toggle('hidden');
        if (chevron) {
          chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
        }
      });
    }

    // Save Server Config Button
    const saveCfgBtn = el('saveConfigBtn');
    if (saveCfgBtn) {
      saveCfgBtn.addEventListener('click', () => {
        const url = (el('cfgUrl')?.value || '').trim();
        const anonKey = (el('cfgKey')?.value || '').trim();
        const storeId = (el('cfgStoreId')?.value || '').trim();
        if (!url || !anonKey || !storeId) {
          showToast('يرجى ملء كافة حقول الإعدادات', true);
          return;
        }
        if (client) {
          client.saveConfig({ url, anonKey, storeId });
        }
        showToast('تم حفظ إعدادات الخادم بنجاح');

        // تحديث شارة المتجر
        const nameEl = el('connectedStoreName');
        if (nameEl) {
          nameEl.textContent = `معرف: ${storeId.substring(0, 12)}...`;
        }
      });
    }

    // Login Form Submit
    const loginForm = el('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!client) {
          showToast('تعذّر الاتصال بالخادم — يرجى تحديث الصفحة', true);
          return;
        }
        const username = (el('loginUsername')?.value || '').trim();
        const password = el('loginPassword')?.value || '';
        const submitBtn = el('loginSubmitBtn');

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
      const branchSelect = el('branchSelect');
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
        optionsHtml += `<option value="${b.id}" ${isSelected}>🏢 ${b.name}${mainBadge}</option>`;
      }

      branchSelect.innerHTML = optionsHtml;

      // Populate also in Add Staff Modal
      const staffBranchSelect = el('newStaffBranch');
      if (staffBranchSelect) {
        let staffOpts = `<option value="">بدون تعيين فرع محدد</option>`;
        for (const b of branchesCache) {
          staffOpts += `<option value="${b.id}">${b.name}</option>`;
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
  function setupNavigation() {
    const tabButtons = document.querySelectorAll('.nav-tab-btn');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        if (targetTab === currentTab) return;
        switchTab(targetTab);
      });
    });

    const branchSelect = el('branchSelect');
    if (branchSelect) {
      branchSelect.addEventListener('change', () => {
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
      if (showToastOnDone) {
        showToast('تم تحديث البيانات لحظياً');
      }
    } catch (err) {
      console.error('Refresh error:', err);
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
    const kpis = await client.getDashboardKPIs(branchId);

    // KPI Numbers
    const setEl = (id, val) => { const e = el(id); if (e) e.textContent = val; };
    setEl('kpiTotalSales', formatMoney(kpis.totalSales));
    setEl('kpiInvoicesCount', kpis.invoicesCount);
    setEl('kpiCashInHand', formatMoney(kpis.netCashInHand));
    setEl('kpiTotalExpenses', formatMoney(kpis.totalExpenses));
    setEl('kpiCardSales', formatMoney(kpis.cardSales));
    setEl('kpiInstapaySales', formatMoney(kpis.instapaySales));

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
          <div class="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl border border-slate-200/80 dark:border-slate-700/80 flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center font-bold text-xs">
                <i data-lucide="user-check" class="w-4 h-4"></i>
              </div>
              <div>
                <h4 class="text-xs font-bold text-slate-900 dark:text-white">${s.cashier_name || s.username || 'كاشير'}</h4>
                <p class="text-[10px] text-slate-400">بدأت: ${formatDateTime(s.start_time)} • ${getBranchName(s.branch_id)}</p>
              </div>
            </div>
            <div class="text-left">
              <span class="text-xs font-extrabold text-emerald-600 dark:text-emerald-400 num-ltr">${formatMoney(s.total_sales || 0)}</span>
              <span class="block text-[9px] text-slate-400">مبيعات الوردية</span>
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
          <div class="bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-xl border border-rose-200/50 dark:border-rose-900/40 flex items-center justify-between">
            <div>
              <h5 class="text-xs font-bold text-slate-900 dark:text-white">${item.name}</h5>
              <p class="text-[10px] text-slate-400 num-ltr">${item.barcode || 'بدون باركود'}</p>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-bold text-rose-600 dark:text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-md">
                متبقي ${item.stock} فقط
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
  async function renderSales(branchId) {
    const search = el('salesSearchInput')?.value || '';
    const date = el('salesDateInput')?.value || null;
    const paymentMethod = el('salesPaymentFilter')?.value || 'ALL';

    const sales = await client.getSales({
      branchId,
      date,
      paymentMethod,
      search,
      limit: 50,
    });

    const listEl = el('invoicesList');
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
      const total = Number(s.total ?? s.net_total ?? s.final_amount ?? 0);
      const method = s.payment_method || 'نقدي';
      let methodBadge = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
      if (method.toLowerCase().includes('card') || method.includes('فيزا')) {
        methodBadge = 'bg-purple-500/10 text-purple-600 dark:text-purple-400';
      } else if (method.toLowerCase().includes('insta') || method.includes('انستا')) {
        methodBadge = 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400';
      }

      return `
        <div class="invoice-card bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm hover:border-blue-400 transition cursor-pointer active:scale-[0.99]" data-id="${s.id}">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xs font-black font-mono text-blue-600 dark:text-blue-400 num-ltr">#${s.invoice_no || s.id.substring(0, 8)}</span>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${methodBadge}">${method}</span>
            </div>
            <span class="text-sm font-black text-slate-900 dark:text-white num-ltr">${formatMoney(total)}</span>
          </div>

          <div class="flex items-center justify-between mt-2 pt-2 border-t border-slate-100 dark:border-slate-800/80 text-[11px] text-slate-400">
            <span>الكاشير: <strong class="text-slate-700 dark:text-slate-300">${s.cashier_name || 'كاشير'}</strong></span>
            <span>${formatDateTime(s.sale_date || s.created_at)}</span>
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
    setEl('modalInvoiceNo', `#${sale.invoice_no || sale.id.substring(0, 8)}`);
    setEl('modalInvoiceDate', formatDateTime(sale.sale_date || sale.created_at));
    setEl('modalCashierName', sale.cashier_name || sale.cashier_username || 'كاشير');
    setEl('modalCustomerName', sale.customer_name || 'عميل نقدي');
    setEl('modalPaymentMethod', sale.payment_method || 'نقدي (كاش)');
    setEl('modalBranchName', getBranchName(sale.branch_id));

    const subtotal = Number(sale.subtotal ?? sale.total ?? 0);
    const discount = Number(sale.discount ?? 0);
    const total = Number(sale.total ?? sale.net_total ?? subtotal - discount);
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
              ${item.product_name || 'صنف'}
              <span class="block text-[10px] text-slate-400 num-ltr">${item.barcode_ean13 || item.barcode || ''}</span>
            </td>
            <td class="p-2 text-center font-bold">${item.quantity ?? item.qty ?? 1}</td>
            <td class="p-2 text-center num-ltr">${formatMoney(item.unit_price || 0)}</td>
            <td class="p-2 text-left font-bold num-ltr">${formatMoney(item.total_price || 0)}</td>
          </tr>
        `).join('');
      }
    } catch (err) {
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-3 text-center text-rose-500">تعذر تحميل الأصناف: ${err.message}</td></tr>`;
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
      limit: 100,
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
      const costPrice = Number(p.cost_price ?? p.buy_price ?? 0);
      const isLow = stock <= minStock;

      return `
        <div class="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border ${isLow ? 'border-amber-300 dark:border-amber-900/60' : 'border-slate-200 dark:border-slate-800'} shadow-sm flex flex-col justify-between gap-2.5">
          <div class="flex items-start justify-between gap-2">
            <div>
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">${name}</h4>
              <p class="text-[11px] text-slate-400 num-ltr font-mono mt-0.5">${barcode}</p>
            </div>
            <span class="text-xs font-bold px-2.5 py-0.5 rounded-full ${isLow ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}">
              ${stock} في المخزن
            </span>
          </div>

          <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800/80 text-xs">
            <div class="space-x-3 space-x-reverse">
              <span>سعر البيع: <strong class="text-blue-600 dark:text-blue-400 font-black num-ltr">${formatMoney(salePrice)}</strong></span>
              <span class="text-slate-400 text-[11px]">التكلفة: <strong class="num-ltr">${formatMoney(costPrice)}</strong></span>
            </div>

            <button class="edit-product-btn bg-slate-100 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-bold text-[11px] px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center gap-1 active:scale-95 transition"
              data-id="${p.id}" data-name="${encodeURIComponent(name)}" data-price="${salePrice}" data-min="${minStock}">
              <i data-lucide="edit-2" class="w-3 h-3"></i>
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
        const price = btn.getAttribute('data-price');
        const minStockVal = btn.getAttribute('data-min');

        const eId = el('editProductId'); if (eId) eId.value = id;
        const eName = el('editProductName'); if (eName) eName.value = name;
        const ePrice = el('editProductSalePrice'); if (ePrice) ePrice.value = price;
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
      const type = (l.type || l.trans_type || 'صرف').toLowerCase();
      const isExpense = type.includes('exp') || type.includes('صرف') || type.includes('سحب') || type.includes('مصروف');
      const amount = Number(l.amount || 0);

      return `
        <div class="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl ${isExpense ? 'bg-rose-500/10 text-rose-500' : 'bg-emerald-500/10 text-emerald-500'} flex items-center justify-center font-bold text-xs">
              <i data-lucide="${isExpense ? 'arrow-down-left' : 'arrow-up-right'}" class="w-4 h-4"></i>
            </div>
            <div>
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">${l.notes || l.note || l.category || (isExpense ? 'مصروف عام' : 'إيداع')}</h4>
              <p class="text-[10px] text-slate-400 mt-0.5">
                ${formatDateTime(l.created_at)} • المسؤول: ${l.username || 'كاشير'}
              </p>
            </div>
          </div>
          <div class="text-left">
            <span class="text-xs font-black ${isExpense ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'} num-ltr">
              ${isExpense ? '-' : '+'} ${formatMoney(amount)}
            </span>
            <span class="block text-[9px] text-slate-400 font-medium">${l.payment_method || 'نقدي'}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  async function renderShiftsLogs(branchId) {
    const shifts = await client.getShifts({ branchId, limit: 30 });
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
      const isOpen = !s.end_time;
      const sales = Number(s.total_sales || 0);
      const startingCash = Number(s.starting_cash ?? s.opening_cash ?? 0);
      const actualCash = Number(s.actual_cash ?? s.closing_cash ?? 0);
      const variance = Number(s.handover_variance ?? 0);

      return `
        <div class="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-2.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xs font-black text-slate-900 dark:text-white">${s.cashier_name || s.username || 'كاشير'}</span>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${isOpen ? 'bg-emerald-500/10 text-emerald-600 animate-pulse' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}">
                ${isOpen ? '🟢 جارية حالياً' : 'مغلقة'}
              </span>
            </div>
            <span class="text-xs font-black text-blue-600 dark:text-blue-400 num-ltr">${formatMoney(sales)}</span>
          </div>

          <div class="grid grid-cols-2 gap-2 text-[11px] bg-slate-50 dark:bg-slate-800/40 p-2.5 rounded-xl text-slate-500 dark:text-slate-400">
            <div>البدء: <strong class="text-slate-700 dark:text-slate-300">${formatDateTime(s.start_time)}</strong></div>
            <div>الإغلاق: <strong class="text-slate-700 dark:text-slate-300">${s.end_time ? formatDateTime(s.end_time) : 'مفتوحة'}</strong></div>
            <div>رصيد الافتتاح: <strong class="text-slate-700 dark:text-slate-300 num-ltr">${formatMoney(startingCash)}</strong></div>
            <div>الفعلي بالدرج: <strong class="text-slate-700 dark:text-slate-300 num-ltr">${formatMoney(actualCash)}</strong></div>
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

    listEl.innerHTML = staff.map(u => {
      const isActive = Boolean(u.is_active);
      const role = u.role || 'Cashier';
      const branchName = getBranchName(u.branch_id);

      return `
        <div class="bg-white dark:bg-slate-900 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl ${isActive ? 'bg-blue-500/10 text-blue-500' : 'bg-slate-200 dark:bg-slate-800 text-slate-400'} flex items-center justify-center font-black text-sm">
              ${(u.full_name || u.username || 'م').substring(0, 1)}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h4 class="text-xs font-bold text-slate-900 dark:text-white">${u.full_name || u.username}</h4>
                <span class="text-[9px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold px-1.5 py-0.5 rounded">${role}</span>
              </div>
              <p class="text-[10px] text-slate-400 mt-0.5">
                <span class="font-mono">@${u.username}</span> • ${branchName}
              </p>
            </div>
          </div>

          <!-- Actions & Toggle -->
          <div class="flex items-center gap-2">
            <!-- Active Toggle Button -->
            <button class="toggle-staff-btn text-xs font-bold px-2.5 py-1 rounded-xl transition flex items-center gap-1 active:scale-95 ${isActive ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'}"
              data-id="${u.id}" data-active="${isActive}">
              <span class="w-1.5 h-1.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
              <span>${isActive ? 'نشط' : 'معطّل'}</span>
            </button>

            <!-- Change Password Button -->
            <button class="change-pwd-btn w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 active:scale-95 transition"
              data-id="${u.id}" data-name="${encodeURIComponent(u.full_name || u.username)}" title="تغيير كلمة المرور">
              <i data-lucide="key" class="w-3.5 h-3.5"></i>
            </button>

            <!-- Delete Button -->
            <button class="delete-staff-btn w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 flex items-center justify-center text-rose-500 active:scale-95 transition"
              data-id="${u.id}" data-username="${u.username}" title="حذف الموظف">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
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

    // Product Form Submit
    el('editProductForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = el('editProductId')?.value;
      const sale_price = parseFloat(el('editProductSalePrice')?.value || '0');
      const min_stock = parseInt(el('editProductMinStock')?.value || '0', 10);

      try {
        await client.updateProduct(id, { sale_price, min_stock });
        showToast('تم حفظ ومزامنة سعر وبيانات الصنف فورياً');
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

    // Filter listeners for Sales & Inventory
    el('salesSearchInput')?.addEventListener('input', () => renderSales(client.getActiveBranch()));
    el('salesDateInput')?.addEventListener('change', () => renderSales(client.getActiveBranch()));
    el('salesPaymentFilter')?.addEventListener('change', () => renderSales(client.getActiveBranch()));

    el('inventorySearchInput')?.addEventListener('input', () => renderInventory(client.getActiveBranch()));
    el('lowStockOnlyToggle')?.addEventListener('change', () => renderInventory(client.getActiveBranch()));

    // "عرض الكل" button on Dashboard Low Stock card -> switch to Inventory with low stock on
    el('viewAllLowStockBtn')?.addEventListener('click', () => {
      const toggle = el('lowStockOnlyToggle');
      if (toggle) toggle.checked = true;
      switchTab('inventory');
    });
  }

  // =========================================================================
  // Initial App Load
  // =========================================================================
  async function loadInitialAppData() {
    try {
      await loadBranches();
      const store = await client.getStoreInfo();
      const headerStoreName = el('headerStoreName');
      if (store && headerStoreName) {
        headerStoreName.textContent = store.store_name || 'متجر إلكينج';
      }
      await refreshCurrentTab();
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
    try { setupPwaInstall(); } catch (e) { console.debug('setupPwaInstall error:', e); }
    try { triggerIcons(); } catch (e) { console.debug('triggerIcons error:', e); }
    try { checkAuth(); } catch (e) { console.debug('checkAuth error:', e); }
  });
})();
