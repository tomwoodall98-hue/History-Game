import '@fontsource/im-fell-english/latin-400.css';
import '@fontsource/im-fell-english/latin-400-italic.css';
import '@fontsource/im-fell-english-sc/latin-400.css';
import './styles/main.css';
import baseMapUrl from './data/basemap.topo.json?url';
import { MapView } from './map/MapView';
import type { BaseMap } from './map/tiles';
import { applyPaperTexture } from './map/texture';
import { compassRoseSVG, cartoucheSVG } from './map/ornaments';

// Start the geodata download before anything else.
const basePromise: Promise<BaseMap> = fetch(baseMapUrl).then((r) => {
  if (!r.ok) throw new Error(`Map data failed to load (${r.status})`);
  return r.json();
});

const app = document.getElementById('app')!;
applyPaperTexture(document.documentElement);

const compass = document.createElement('div');
compass.className = 'compass';
compass.setAttribute('aria-hidden', 'true');
compass.innerHTML = compassRoseSVG();
app.appendChild(compass);

const cartouche = document.createElement('div');
cartouche.className = 'cartouche';
cartouche.innerHTML = cartoucheSVG({ title: 'Chronomap', subtitle: 'A Daily Atlas of History' });
app.appendChild(cartouche);

const zoomControls = document.createElement('div');
zoomControls.className = 'zoom-controls';
zoomControls.innerHTML = `
  <button class="ink-button" data-zoom="in" aria-label="Zoom in" title="Zoom in">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14M3 10h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
  </button>
  <button class="ink-button" data-zoom="out" aria-label="Zoom out" title="Zoom out">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
  </button>
  <button class="ink-button" data-zoom="reset" aria-label="Show whole map" title="Show whole map">
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
  </button>`;
app.appendChild(zoomControls);

const tileBaseUrl = new URL(`${import.meta.env.BASE_URL}geo/tiles/`, document.baseURI).href;
const map = new MapView(document.getElementById('map')!, tileBaseUrl);
zoomControls.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>('[data-zoom]');
  if (!btn) return;
  const action = btn.dataset.zoom;
  if (action === 'in') map.zoomBy(1.8);
  else if (action === 'out') map.zoomBy(1 / 1.8);
  else map.resetView();
});

basePromise
  .then((base) => {
    map.render(base);
    map.setPickEnabled(true);
    map.onPick((p) => map.setGuess(p));
    requestAnimationFrame(() => map.svg.classList.add('ready'));
    document.getElementById('loading')?.classList.add('done');
  })
  .catch((err) => {
    console.error(err);
    const loading = document.getElementById('loading');
    if (loading) loading.textContent = 'The map could not be loaded. Please refresh the page.';
  });

// Expose for manual testing in the console.
(window as unknown as { chronomap: unknown }).chronomap = { map };
