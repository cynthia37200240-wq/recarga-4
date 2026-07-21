const CACHE = 'recarga-v5';
const ASSETS = [
  '/',
  '/css/style.css?v=2',
  '/js/script.js?v=4',
  '/imagens/brand-d.svg',
  '/imagens/logo2-d.webp',
  '/imagens/vivo-d.webp',
  '/imagens/claro-d.webp',
  '/imagens/tim-d.webp',
  '/imagens/algar-d.webp',
  '/imagens/correios-d.webp',
  '/imagens/icon-tempo-d.png',
];

// Instala: pré-carrega todos os assets estáticos
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Ativa: limpa caches antigos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: Cache First para assets, Network First para HTML e API
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API: sempre vai na rede (nunca usa cache)
  if (url.pathname.startsWith('/api/')) return;

  // HTML: Network First — pega versão nova, fallback para cache
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => { caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Assets estáticos: Cache First — instantâneo na 2ª visita
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      });
    })
  );
});
