// Abre o sistema sem internet: a página e os arquivos dela ficam guardados no aparelho. Os dados vêm da API, em outro
// endereço, e não passam por aqui; sem rede, o sistema mostra os últimos dados do aparelho e guarda as alterações.
const CACHE = 'praiamar-app';
const PAGE = './';
const PART = /[\w.-]+-[\w-]{8}\.js/g;

/**
 * Guarda os arquivos que a página carrega e as partes que o código só busca quando precisa (PDF da proposta e do
 * recibo), citadas pelo nome dentro dos arquivos de código. Roda na instalação e a cada abertura com internet, porque
 * cada versão nova do sistema traz arquivos com outro nome; o que já está guardado não é baixado de novo.
 */
async function keep(html) {
  const cache = await caches.open(CACHE);
  const files = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1]);
  const parts = files.filter((file) => file.endsWith('.js')).map((file) => file.split('/').pop());
  const seen = new Set(parts);
  for (const file of files) if (!(await cache.match(file))) await cache.add(file);
  while (parts.length) {
    const code = await (await cache.match('./assets/' + parts.shift()))?.text();
    for (const [part] of (code ?? '').matchAll(PART)) {
      if (seen.has(part)) continue;
      seen.add(part);
      parts.push(part);
      if (!(await cache.match('./assets/' + part))) await cache.add('./assets/' + part);
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const page = await fetch(PAGE, { cache: 'no-cache' });
        await (await caches.open(CACHE)).put(PAGE, page.clone());
        await keep(await page.text());
      } catch {}
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  // A página: a mais nova quando há rede; sem rede, a última guardada.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(
              (async () => {
                await (await caches.open(CACHE)).put(PAGE, copy.clone());
                await keep(await copy.text()).catch(() => undefined);
              })(),
            );
          }
          return response;
        })
        .catch(async () => (await caches.match(PAGE)) ?? Response.error()),
    );
    return;
  }
  // Arquivos com código no nome (assets) não mudam: vêm do aparelho. O resto (ícones, manifest) vem do aparelho e é
  // atualizado em seguida.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(request);
      const fresh = fetch(request).then(async (response) => {
        if (response.ok) {
          await cache.put(request, response.clone());
          await trim(cache);
        }
        return response;
      });
      if (!saved) return fresh;
      if (!url.pathname.includes('/assets/')) event.waitUntil(fresh.catch(() => undefined));
      return saved;
    })(),
  );
});

// Só os arquivos mais recentes: os das versões antigas do sistema saem sozinhos.
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - 80))) await cache.delete(key);
}
