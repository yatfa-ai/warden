// Ambient declarations for prismjs grammar component side-effect imports.
//
// @types/prismjs declares the core `prismjs` module but NOT the per-language
// component files under `prismjs/components/*`, which register grammars onto the
// global Prism instance at import time (they have no exports). Without this shim
// tsc errors on the bare side-effect imports src/lib/highlight.ts uses to load
// grammars in dependency order. (WARDEN-281)
declare module 'prismjs/components/*.js';
