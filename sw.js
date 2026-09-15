// Service worker mínimo do LiveDash: deixa o site instalável como app (Android pede pra instalar; iPhone via Compartilhar).
// Rede PRIMEIRO sempre (o painel muda a cada deploy); o cache só serve se a rede falhar. Nada do Supabase passa aqui (outra origem).
const V = 'livedash-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
