/* STEAM-BOY Service Worker — オフライン動作（PWA）
   方針: stale-while-revalidate。キャッシュを即返しつつ裏で更新する。
   アプリ本体・CDNリソース（pdf.js / フォント）をキャッシュし、
   工場などのオフライン環境でも起動できるようにする。 */
'use strict';
const CACHE = 'steamboy-v1';
const PRECACHE = ['./', './STEAM-BOY.html', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 一部の失敗（オフラインインストール等）は無視して続行
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (!/^https?:$/.test(url.protocol)) return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      // キャッシュがあれば即返し、裏で更新（stale-while-revalidate）
      return hit || refresh;
    })
  );
});
