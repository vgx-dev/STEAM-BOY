/* STEAM-BOY Service Worker — オフライン動作（PWA）
   方針: ネットワーク優先（network-first）。
   常にネットワークから最新版を取得し、オフライン時のみキャッシュにフォールバック。
   これにより「1世代遅れ」問題（初回リロードで古いキャッシュが返る）を解消する。 */
'use strict';
const CACHE = 'steamboy-v2';
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
  // ネットワーク優先: 成功したらキャッシュを更新して返す。
  // オフライン等でネットワークが失敗した場合のみキャッシュにフォールバック。
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
