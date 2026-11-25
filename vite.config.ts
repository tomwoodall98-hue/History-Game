import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// `base` is relative so the built site works from any sub-path
// (GitHub Pages project sites, Netlify, a local file server...).
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    reportCompressedSize: true,
    rolldownOptions: {
      // glyphs.html is a development specimen sheet for the map decorations.
      // It is built so it can be viewed on deploy previews, but nothing links to it.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        glyphs: resolve(import.meta.dirname, 'glyphs.html'),
      },
    },
  },
});
