// Service worker minimo: rende l'app installabile e mostra l'ultima versione salvata se manca la rete.
// I dati della serata (server Cloudflare) passano sempre dalla rete, mai dalla cache.
const CACHE="bingo-v40";
const SHELL=["./","./index.html","./debug.html","./manifest.webmanifest","./icons/icon-192.png","./icons/icon-512.png","./cloud.js","./vendor/qrcode-1.0.0.min.js","./vendor/fonts/fonts.css"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const r=e.request;if(r.method!=="GET")return;
  const u=new URL(r.url);if(u.origin!==location.origin)return;
  if(u.pathname.startsWith("/api/"))return; // accesso e dati della serata: sempre in rete
  if(u.pathname.endsWith("version.json"))return; // il controllo versione va sempre in rete, mai in cache
  // prima la rete (così ogni aggiornamento arriva subito), la cache solo se si è offline
  e.respondWith(fetch(r).then(res=>{if(res.ok){const c=res.clone();caches.open(CACHE).then(x=>x.put(r,c))}return res}).catch(()=>caches.match(r).then(m=>m||caches.match("./"))));
});
