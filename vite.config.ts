import { defineConfig } from 'vite';

// `base` is relative so the built site works from any sub-path
// (GitHub Pages project sites, Netlify, a local file server...).
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
});
