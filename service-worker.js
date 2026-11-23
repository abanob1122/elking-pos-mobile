/**
 * ELKing POS - Mobile PWA Service Worker (v4)
 * يدعم التثبيت المباشر والعمل دون اتصال لشيل التطبيق (Offline App Shell)
 * متوافق 100% مع مسارات GitHub Pages والمجلدات الفرعية
 */

const CACHE_NAME = 'elking-pos-v13-3-1';
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css?v=13.3.1',
  './js/crypto-utils.js?v=13.3.1',
  './js/supabase-client.js?v=13.3.1',
  './js/app.js?v=13.3.1',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// تثبيت الـ Service Worker وحفظ ملفات الشيل الأساسية
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// تنشيط الـ Service Worker وحذف أي كاش قديم
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// التعامل مع الطلبات (Fetch)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. طلبات Supabase REST API -> استراتيجية Network-First دائماً للبيانات اللحظية
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'لا يوجد اتصال بالإنترنت حالياً' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // 2. ملفات الخطوط والـ CDNs الخارجية -> Stale-while-revalidate / Cache First
  if (url.origin.includes('fonts.googleapis.com') ||
      url.origin.includes('fonts.gstatic.com') ||
      url.origin.includes('cdn.tailwindcss.com') ||
      url.origin.includes('unpkg.com')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        }).catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 3. طلبات التنقل لصفحة التطبيق (HTML Navigate) -> Network-First لتجنب تقديم نسخة قديمة عند مسح QR
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', responseClone));
        }
        return networkResponse;
      }).catch(() => {
        return caches.match('./index.html') || caches.match('./');
      })
    );
    return;
  }

  // 4. أصول التطبيق المحلية (App Shell) -> Cache First مع Fallback للشبكة
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      });
    }).catch(() => {
      return caches.match('./index.html') || caches.match('./');
    })
  );
});
