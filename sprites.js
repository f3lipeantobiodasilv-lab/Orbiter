/**
 * ============================================================================
 *  sprites.js — Geração Procedural de Sprites, Texturas e HUD
 * ============================================================================
 *  Módulo ES6+ autocontido (zero dependências), projetado para desenhar o
 *  mundo de `physics.js` + `atmosphere.js` sem conhecer suas classes: tudo é
 *  consumido por "duck typing" a partir da telemetria pública.
 *
 *  Conteúdo
 *  --------
 *   0. Utilitários ............... math, hash, RNG determinístico, cores,
 *                                  canvas/ImageData (browser, worker, Node).
 *   1. Ruído ..................... Perlin 2D/3D periódico, fBm, ridged,
 *                                  turbulência, Worley/cellular e domínio
 *                                  deformado (domain warp).
 *   2. Planetas e luas ........... texturas equirretangulares proceduralmente
 *                                  geradas: continentes, oceanos, calotas,
 *                                  nuvens, crateras, mares de lava, bandas
 *                                  gasosas (Júpiter/Titã), tempestades ovais.
 *                                  Normais simuladas (Sobel), máscaras de
 *                                  brilho especular, emissivo e nuvens.
 *   3. WebGL ..................... gerador GPU equivalente (GLSL ES 1.00,
 *                                  multipassagem albedo/normal/máscaras),
 *                                  readback para canvas e upload de texturas
 *                                  com mipmap e anisotropia.
 *   4. Espaçonaves ............... desenho vetorial em múltiplas fases (stack,
 *                                  boosters, upper, capsule, satellite,
 *                                  lander), tubeiras, carenagens, chamas
 *                                  dinâmicas com cor por throttle e por
 *                                  propelente (hidrogênio/querosene/metano).
 *   5. Partículas ................ atlas de fogo, fumaça, plasma, faíscas,
 *                                  poeira, gelo, detritos e anel de choque;
 *                                  sistema de partículas com arrasto,
 *                                  empuxo e resfriamento + adaptador para as
 *                                  partículas térmicas de `atmosphere.js`.
 *   6. HUD ....................... bússola de heading, marcos de apogeu e
 *                                  perigeu (vetor de excentricidade real),
 *                                  barras de combustível/delta-v, indicadores
 *                                  de velocidade orbital e força G, fitas de
 *                                  altitude, painel de telemetria completo.
 *   7. Fábrica ................... SpriteGenerator (cache LRU, seed, qualidade),
 *                                  drawBody / drawSpacecraft (integração com
 *                                  physics.js e atmosphere.js).
 *
 *  Unidades
 *  --------
 *   O módulo não assume unidades: as texturas e sprites são adimensionais.
 *   Os helpers de HUD recebem metros, m/s, kg, segundos e newtons — as mesmas
 *   unidades SI de `physics.js` — e apenas formatam para exibição.
 *
 *  Uso típico (Canvas 2D)
 *  ----------------------
 *    import { SpriteGenerator } from './sprites.js';
 *
 *    const gfx = new SpriteGenerator({ seed: 2026, quality: 1 });
 *    const terra = gfx.planet({ preset: 'earth', width: 1024 });
 *    const nave  = gfx.spaceship({ accent: '#ffb454', boosters: 2 });
 *    const hud   = gfx.hud();
 *
 *    // dentro do loop de render:
 *    gfx.drawBody(ctx, terraBody, camera, { sun: sunBody, time });
 *    gfx.drawSpacecraft(ctx, nave, camera, telemetry);
 *    hud.draw(ctx, telemetry, { atmosphere: atmo.getTelemetry(nave) });
 *
 *  Uso direto (funções puras, sem cache)
 *  -------------------------------------
 *    import {
 *      createPlanetTexture, createSpaceshipSprite, createParticleSprites,
 *      computeApsisMarkers, HUD,
 *    } from './sprites.js';
 *
 *    const lua   = createPlanetTexture({ preset: 'moon', width: 512 });
 *    const atlas = createParticleSprites({ size: 64, frames: 8 });
 *    const sprite = createSpaceshipSprite({ length: 160, accent: '#5fd4ff' });
 *    sprite.draw(ctx, { x, y, angle, throttle: 0.8, time });
 *
 *  API pública (resumo)
 *  --------------------
 *   Fábrica ....... SpriteGenerator, createSpriteGenerator, preloadSprites
 *   Planetas ...... createPlanetTexture, generatePlanetSurface,
 *                   createGLPlanetTexture, PLANET_PRESETS, PLANET_PRESET_NAMES,
 *                   resolvePlanetPreset, inferPlanetPreset, heightToNormalMap,
 *                   QUALITY_LEVELS
 *   WebGL ......... uploadTexture, uploadPlanetTexture, createHeadlessGL, isWebGL2
 *   Naves ......... createSpaceshipSprite, SPACESHIP_DEFAULTS, SPACECRAFT_PHASES,
 *                   drawExhaustPlume, createExhaustSpriteSheet, flameColor,
 *                   FLAME_SPECTRA
 *   Partículas .... createParticleSprites, ParticleSystem, PARTICLE_KINDS,
 *                   drawThermalParticles, drawSpacecraftPlasma, drawReentryGlow
 *   Mundo ......... drawBody, drawSpacecraft, createCamera, projectPoint,
 *                   unprojectPoint, autoSpacecraftPhase
 *   HUD ........... HUD, HUD_STYLE, drawHeadingCompass, drawApsisMarkers,
 *                   computeApsisMarkers, drawSpeedGauge, drawGForceGauge,
 *                   drawFuelBar, drawThrottleBar, drawAltitudeTape,
 *                   drawOrbitPanel, drawStatusStrip, drawArcGauge,
 *                   drawHUDPanel, drawHUDValue, createHUDGlyphs,
 *                   formatNumber, formatSI, formatDistance, formatSpeed,
 *                   formatMass, formatTime, formatAngle, formatPercent
 *   Utilidades .... Noise, createNoise, noise1, noise3, fbm3, createRNG,
 *                   parseColor, mixColor, shade, luminance, blackbodyRGB,
 *                   thermalRamp, sampleGradient, hslToRgb, rgba, cssColor,
 *                   setCanvasFactory, createCanvas, get2D, createImageData,
 *                   bufferToCanvas, resizeCanvas, packAtlas, ensureCanvas,
 *                   isCanvasAvailable, stableKey, clamp, clamp01, lerp,
 *                   invLerp, smoothstep, smoothCurve, mod, fract, wrapPi,
 *                   wrapTau, normalizeDegrees, dist, step, mixVec3,
 *                   normalize3, cross3, dot3, sphereDirection, hashInt,
 *                   hashString, hash01
 *
 *  Determinismo e desempenho
 *  -------------------------
 *   • Toda geração é determinística a partir de `seed` (nenhum Math.random no
 *     caminho de criação): o mesmo seed produz exatamente a mesma textura.
 *   • A geração é feita uma única vez e cacheada (LRU por chave estável).
 *     Perfis de `quality` ('low' 0.5× / 'medium' 0.75× / 'high' 1× /
 *     'ultra' 1.4×) escalam resolução e orçamento de oitavas.
 *   • O caminho WebGL é opcional e cai automaticamente para CPU em qualquer
 *     falha (contexto ausente, shader rejeitado, readPixels bloqueado).
 *   • Nenhum gradiente ou objeto é criado por partícula no loop de desenho
 *     além do estritamente necessário; os atlas são pré-renderizados.
 *
 *  Compatibilidade
 *  ---------------
 *   Browser (OffscreenCanvas ou <canvas>), Web Worker (OffscreenCanvas) e
 *   Node/bundlers headless via `setCanvasFactory` (ver utilitários).
 * ============================================================================
 */

/* ========================================================================== */
/*  0. Constantes e utilitários                                               */
/* ========================================================================== */

/** Volta completa em radianos. */
export const TAU = Math.PI * 2;
/** Um grau em radianos. */
export const DEG = Math.PI / 180;
/** Meia volta em radianos. */
export const PI = Math.PI;

/** Limita `v` ao intervalo [lo, hi]. */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Limita `v` ao intervalo [0, 1]. */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Interpolação linear. */
export const lerp = (a, b, t) => a + (b - a) * t;
/** Interpolação linear inversa (0 em a, 1 em b). */
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
/** Restringe `v` a [0,1] e aplica a curva suave 3t² − 2t³. */
export const smoothstep = (edge0, edge1, v) => {
  if (edge0 === edge1) return v < edge0 ? 0 : 1;
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
/** Curva smoothstep com `v` já em [0,1]. */
export const smoothCurve = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** Módulo sempre positivo (diferente de `%` para negativos). */
export const mod = (a, n) => ((a % n) + n) % n;
/** Parte fracionária (sempre positiva). */
export const fract = (v) => v - Math.floor(v);
/** Envolve um ângulo em (−π, π]. */
export const wrapPi = (a) => {
  const x = mod(a + Math.PI, TAU) - Math.PI;
  return x <= -Math.PI ? x + TAU : x;
};
/** Envolve um ângulo em [0, 2π). */
export const wrapTau = (a) => mod(a, TAU);
/** Converte graus em graus decimais normalizados para (−180, 180]. */
export const normalizeDegrees = (d) => mod(d + 180, 360) - 180;
/** Distância euclidiana. */
export const dist = (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0);
/** Passo discreto: 1 se v ≥ edge. */
export const step = (edge, v) => (v < edge ? 0 : 1);

/** `mix` de vetores (evita dependência de THREE). */
export function mixVec3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * Hash inteiro de 32 bits (estilo Wang/Murmur) — base do RNG e dos ruídos.
 * @param {number} x
 * @param {number} [y]
 * @param {number} [z]
 * @returns {number} inteiro sem sinal em [0, 2³²)
 */
export function hashInt(x, y = 0, z = 0) {
  let h = (x | 0) * 0x27d4eb2d ^ (y | 0) * 0x165667b1 ^ (z | 0) * 0x9e3779b1;
  h = (h ^ (h >>> 15)) * 0x85ebca6b;
  h = (h ^ (h >>> 13)) * 0xc2b2ae35;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash de string → inteiro 32 bits determinístico (para seeds por nome). */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hash normalizado em [0, 1). */
export function hash01(x, y = 0, z = 0) {
  return hashInt(x, y, z) / 4294967296;
}

/**
 * PRNG determinístico rápido (mulberry32).
 * @param {number} seed
 * @returns {(() => number) & {seed:number, int:(n:number)=>number, range:(a:number,b:number)=>number, pick:(arr:any[])=>any}}
 */
export function createRNG(seed = 1) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.seed = seed >>> 0;
  next.int = (n) => Math.floor(next() * n);
  next.range = (a, b) => a + next() * (b - a);
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  /** Amostra normal (Box–Muller) — útil para dispersão de partículas. */
  next.gaussian = () => {
    const u = Math.max(next(), 1e-9);
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  return next;
}

/* ------------------------------- vetores ---------------------------------- */

/** Normaliza um vetor 3D; vetor nulo retorna [0,0,1]. */
export function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}
/** Produto vetorial 3D. */
export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
/** Produto escalar 3D. */
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Direção unitária sobre a esfera a partir de coordenadas equirretangulares.
 * (u, v) em [0,1]: u = longitude, v = latitude (0 = polo norte, 1 = sul).
 */
export function sphereDirection(u, v, out = [0, 0, 0]) {
  const lon = u * TAU;
  const lat = (0.5 - v) * Math.PI;
  const cosLat = Math.cos(lat);
  out[0] = cosLat * Math.cos(lon);
  out[1] = Math.sin(lat);
  out[2] = cosLat * Math.sin(lon);
  return out;
}

/* ------------------------------- cores ------------------------------------ */

const NAMED_COLORS = Object.freeze({
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0],
  green: [0, 128, 0], blue: [0, 0, 255], cyan: [0, 255, 255],
  magenta: [255, 0, 255], yellow: [255, 255, 0], orange: [255, 165, 0],
  gray: [128, 128, 128], grey: [128, 128, 128], transparent: [0, 0, 0, 0],
});

/**
 * Converte qualquer cor suportada em `{ r, g, b, a }` (0..255, a em 0..1).
 * Aceita '#rgb', '#rgba', '#rrggbb', '#rrggbbaa', 'rgb()', 'rgba()', 'hsl()',
 * nomes CSS básicos, arrays [r,g,b(,a)] e objetos {r,g,b,a}.
 * @param {string|number[]|object} color
 * @param {{r:number,g:number,b:number,a:number}} [out] objeto reaproveitável
 */
export function parseColor(color, out = { r: 0, g: 0, b: 0, a: 1 }) {
  if (color == null) { out.r = 0; out.g = 0; out.b = 0; out.a = 0; return out; }
  if (Array.isArray(color)) {
    out.r = color[0]; out.g = color[1]; out.b = color[2];
    out.a = color.length > 3 ? color[3] : 1;
    return out;
  }
  if (typeof color === 'object') {
    out.r = color.r ?? 0; out.g = color.g ?? 0; out.b = color.b ?? 0;
    out.a = color.a ?? 1;
    return out;
  }
  if (typeof color === 'number') { out.r = out.g = out.b = color; out.a = 1; return out; }

  const s = String(color).trim().toLowerCase();
  if (s.charCodeAt(0) === 35 /* # */) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      out.r = parseInt(hex[0] + hex[0], 16);
      out.g = parseInt(hex[1] + hex[1], 16);
      out.b = parseInt(hex[2] + hex[2], 16);
      out.a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
    } else {
      out.r = parseInt(hex.slice(0, 2), 16) || 0;
      out.g = parseInt(hex.slice(2, 4), 16) || 0;
      out.b = parseInt(hex.slice(4, 6), 16) || 0;
      out.a = hex.length >= 8 ? (parseInt(hex.slice(6, 8), 16) || 0) / 255 : 1;
    }
    return out;
  }
  if (s.startsWith('rgb')) {
    const nums = s.match(/-?\d*\.?\d+%?/g) || [];
    const chan = (i) => {
      const raw = nums[i] ?? '0';
      return raw.endsWith('%') ? (parseFloat(raw) / 100) * 255 : parseFloat(raw) || 0;
    };
    out.r = clamp(chan(0), 0, 255);
    out.g = clamp(chan(1), 0, 255);
    out.b = clamp(chan(2), 0, 255);
    out.a = nums.length > 3 ? clamp(parseFloat(nums[3]), 0, 1) : 1;
    return out;
  }
  if (s.startsWith('hsl')) {
    const nums = s.match(/-?\d*\.?\d+%?/g) || [];
    const h = parseFloat(nums[0] ?? '0') / 360;
    const sat = clamp((parseFloat(nums[1] ?? '0') || 0) / 100, 0, 1);
    const lig = clamp((parseFloat(nums[2] ?? '0') || 0) / 100, 0, 1);
    const rgb = hslToRgb(h, sat, lig);
    out.r = rgb[0]; out.g = rgb[1]; out.b = rgb[2];
    out.a = nums.length > 3 ? clamp(parseFloat(nums[3]), 0, 1) : 1;
    return out;
  }
  const named = NAMED_COLORS[s];
  if (named) {
    out.r = named[0]; out.g = named[1]; out.b = named[2];
    out.a = named.length > 3 ? named[3] : 1;
    return out;
  }
  out.r = 0; out.g = 0; out.b = 0; out.a = 1;
  return out;
}

/** HSL (h, s, l em 0..1) → [r, g, b] 0..255. */
export function hslToRgb(h, s, l) {
  const hue = mod(h, 1) * 6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  let r = 0; let g = 0; let b = 0;
  if (hue < 1) { r = c; g = x; }
  else if (hue < 2) { r = x; g = c; }
  else if (hue < 3) { g = c; b = x; }
  else if (hue < 4) { g = x; b = c; }
  else if (hue < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Monta uma string CSS rgba() a partir de canais 0..255 e alfa 0..1. */
export function rgba(r, g, b, a = 1) {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.round(a * 1000) / 1000})`;
}

/** Monta string CSS a partir de `{r,g,b,a}`. */
export function cssColor(c, alpha = c.a ?? 1) {
  return rgba(c.r, c.g, c.b, alpha);
}

/** Mistura duas cores (aceita qualquer formato de `parseColor`). */
export function mixColor(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const k = clamp01(t);
  return {
    r: lerp(ca.r, cb.r, k),
    g: lerp(ca.g, cb.g, k),
    b: lerp(ca.b, cb.b, k),
    a: lerp(ca.a, cb.a, k),
  };
}

/** Clareia/escurece: amount > 0 mistura com branco, < 0 com preto. */
export function shade(color, amount) {
  const c = parseColor(color);
  const target = amount >= 0 ? 255 : 0;
  const t = clamp01(Math.abs(amount));
  return { r: lerp(c.r, target, t), g: lerp(c.g, target, t), b: lerp(c.b, target, t), a: c.a };
}

/** Luminância relativa sRGB (0..1) — usada para contraste automático de texto. */
export function luminance(color) {
  const c = parseColor(color);
  const f = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/**
 * Cor de corpo negro aproximada (Tanner Helland) → {r,g,b} 0..255.
 * Usada para fogo, plasma e reentrada; coerente com `atmosphere.js`.
 */
export function blackbodyRGB(temperature) {
  const t = clamp(Number(temperature) || 0, 1000, 40000) / 100;
  let r; let g; let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) };
}

/**
 * Rampa térmica normalizada (0 = frio/escuro, 1 = incandescente).
 * @returns {{r:number,g:number,b:number}} 0..255
 */
export function thermalRamp(t) {
  const k = clamp01(t);
  if (k < 0.35) return mixColor('#2b0d06', '#b33a12', k / 0.35);
  if (k < 0.7) return mixColor('#b33a12', '#ffb03a', (k - 0.35) / 0.35);
  return mixColor('#ffb03a', '#fff6e0', (k - 0.7) / 0.3);
}

/**
 * Interpola uma lista de paradas `[{ pos, color }, …]` (pos 0..1 ordenado).
 * @param {Array<{pos:number,color:any}>} stops
 * @param {number} t
 * @returns {{r:number,g:number,b:number,a:number}}
 */
export function sampleGradient(stops, t) {
  if (!stops || stops.length === 0) return { r: 0, g: 0, b: 0, a: 1 };
  const k = clamp01(t);
  if (k <= stops[0].pos) return parseColor(stops[0].color);
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (k <= b.pos) {
      const a = stops[i - 1];
      const span = b.pos - a.pos;
      return mixColor(a.color, b.color, span > 1e-9 ? (k - a.pos) / span : 0);
    }
  }
  return parseColor(stops[stops.length - 1].color);
}

/* --------------------------- canvas e imagens ----------------------------- */

/** @type {null | ((w:number, h:number) => any)} */
let _canvasFactory = null;

/**
 * Registra uma fábrica de canvas (Node headless, jsdom, worker customizado).
 * @param {null | ((w:number,h:number)=>any)} factory
 * @example
 *   import { createCanvas as napiCanvas } from '@napi-rs/canvas';
 *   setCanvasFactory((w, h) => napiCanvas(w, h));
 */
export function setCanvasFactory(factory) {
  _canvasFactory = typeof factory === 'function' ? factory : null;
}

/** Detecta suporte a canvas no ambiente atual. */
export function isCanvasAvailable() {
  if (_canvasFactory) return true;
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return !!new OffscreenCanvas(1, 1).getContext('2d'); } catch { /* ignore */ }
  }
  return typeof document !== 'undefined' && !!document.createElement;
}

/**
 * Cria um canvas offscreen com o contexto 2D já inicializado.
 * Prioriza OffscreenCanvas (workers) e recorre a <canvas>.
 * @param {number} width
 * @param {number} height
 * @param {{ willReadFrequently?: boolean, alpha?: boolean }} [options]
 * @returns {any} canvas
 * @throws {Error} se o ambiente não fornecer canvas.
 */
export function createCanvas(width, height, options = {}) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (_canvasFactory) {
    const canvas = _canvasFactory(w, h);
    if (!canvas) throw new Error('sprites.js: setCanvasFactory retornou um canvas inválido.');
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(w, h);
      if (canvas.getContext('2d', options)) return canvas;
    } catch { /* segue para <canvas> */ }
  }
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  throw new Error(
    'sprites.js: nenhum canvas disponível. Use setCanvasFactory() em ambientes headless.',
  );
}

/**
 * Obtém (ou cria) o contexto 2D de um canvas.
 * @param {any} canvas
 * @param {{ willReadFrequently?: boolean, alpha?: boolean }} [options]
 * @returns {CanvasRenderingContext2D}
 */
export function get2D(canvas, options = {}) {
  if (canvas.__ctx2d) return canvas.__ctx2d;
  const ctx = canvas.getContext('2d', { alpha: options.alpha !== false, ...options });
  if (!ctx) throw new Error('sprites.js: contexto 2D indisponível para o canvas informado.');
  try { canvas.__ctx2d = ctx; } catch { /* canvas hostil — segue sem cache */ }
  return ctx;
}

/** Cria um ImageData compatível com o contexto informado. */
export function createImageData(ctx, width, height) {
  if (typeof ImageData === 'function') {
    try { return new ImageData(width, height); } catch { /* fallback */ }
  }
  return ctx.createImageData(width, height);
}

/**
 * Converte um buffer RGBA (Uint8ClampedArray) em canvas.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 */
export function bufferToCanvas(rgba, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = get2D(canvas, { willReadFrequently: true });
  const image = createImageData(ctx, width, height);
  image.data.set(rgba);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Redimensiona um canvas com suavização (downscale de supersampling).
 * @param {any} source
 * @param {number} width
 * @param {number} height
 * @param {boolean} [smooth=true]
 */
export function resizeCanvas(source, width, height, smooth = true) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const canvas = createCanvas(w, h);
  const ctx = get2D(canvas);
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = smooth ? 'high' : 'low';
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

/**
 * Empacota buffers em um atlas horizontal (útil para WebGL / drawImage).
 * @param {any[]} canvases
 * @param {{ padding?: number }} [options]
 * @returns {{ canvas:any, frames:Array<{x:number,y:number,w:number,h:number}> }}
 */
export function packAtlas(canvases, options = {}) {
  const pad = Math.max(0, options.padding ?? 0);
  const w = canvases.reduce((acc, c) => Math.max(acc, c.width), 1);
  const h = canvases.reduce((acc, c) => acc + c.height + pad, 0) || 1;
  const canvas = createCanvas(w, h);
  const ctx = get2D(canvas);
  const frames = [];
  let y = 0;
  for (const c of canvases) {
    ctx.drawImage(c, 0, y);
    frames.push({ x: 0, y, w: c.width, h: c.height });
    y += c.height + pad;
  }
  return { canvas, frames };
}

/** Chave estável (ordem de chaves) para cache — ignora funções e canvas. */
export function stableKey(value, depth = 0) {
  if (value == null) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return String(value);
  if (t === 'string') return value;
  if (t === 'function') return 'fn';
  if (t !== 'object') return String(value);
  if (depth > 6) return '…';
  if (typeof value.getContext === 'function') return 'canvas';
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableKey(v, depth + 1)).join(',')}]`;
  }
  // Objetos simples entram recursivamente na chave (ex.: flame.spectrum),
  // garantindo que configurações diferentes não colidam no cache.
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (typeof v === 'function') continue;
    parts.push(`${k}:${stableKey(v, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Converte qualquer coisa parecida com canvas em um canvas de verdade.
 * Aceita canvas, OffscreenCanvas, ImageBitmap e HTMLImageElement.
 */
export function ensureCanvas(source, width, height) {
  if (!source) return createCanvas(width || 1, height || 1);
  const w = width || source.width || 1;
  const h = height || source.height || 1;
  if (typeof source.getContext === 'function') return source;
  const canvas = createCanvas(w, h);
  get2D(canvas).drawImage(source, 0, 0, w, h);
  return canvas;
}

/* ========================================================================== */
/*  1. Ruído procedural                                                       */
/* ========================================================================== */

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Ruído de Perlin com tabela de permutação determinística.
 *
 * `noise2` aceita período por eixo (`periodX`, `periodY`) para texturas que
 * precisam ser contínuas nas bordas — ex.: equirretangular do planeta, onde a
 * coluna final precisa casar com a primeira (0° ≡ 360°).
 */
export class Noise {
  /**
   * @param {number} [seed=1337]
   */
  constructor(seed = 1337) {
    const rng = createRNG(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    this.seed = seed >>> 0;
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /**
   * Perlin 2D com período opcional por eixo (vincula a 0..period).
   * @param {number} x
   * @param {number} y
   * @param {number} [periodX=0] 0 = sem período
   * @param {number} [periodY=0]
   * @returns {number} aproximadamente (−1, 1)
   */
  noise2(x, y, periodX = 0, periodY = 0) {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const X = xf & 255;
    const Y = yf & 255;
    const xf2 = x - xf;
    const yf2 = y - yf;
    const u = fade(xf2);
    const v = fade(yf2);
    const perm = this.perm;

    let x0 = X; let x1 = (X + 1) & 255;
    let y0 = Y; let y1 = (Y + 1) & 255;
    if (periodX > 0) {
      const px = periodX | 0;
      x0 = mod(xf, px) & 255;
      x1 = mod(xf + 1, px) & 255;
    }
    if (periodY > 0) {
      const py = periodY | 0;
      y0 = mod(yf, py) & 255;
      y1 = mod(yf + 1, py) & 255;
    }

    // Gradientes resolvidos inline: evitar uma closure por chamada de ruído
    // é decisivo em texturas grandes (milhões de amostras).
    let gi = (perm[perm[x0] + y0] % 12) * 3;
    const n00 = GRAD3[gi] * xf2 + GRAD3[gi + 1] * yf2;
    gi = (perm[perm[x1] + y0] % 12) * 3;
    const n10 = GRAD3[gi] * (xf2 - 1) + GRAD3[gi + 1] * yf2;
    gi = (perm[perm[x0] + y1] % 12) * 3;
    const n01 = GRAD3[gi] * xf2 + GRAD3[gi + 1] * (yf2 - 1);
    gi = (perm[perm[x1] + y1] % 12) * 3;
    const n11 = GRAD3[gi] * (xf2 - 1) + GRAD3[gi + 1] * (yf2 - 1);
    const nx0 = n00 + (n10 - n00) * u;
    const nx1 = n01 + (n11 - n01) * u;
    return nx0 + (nx1 - nx0) * v;
  }

  /**
   * Perlin 3D clássico — a base do sampling sobre a esfera (sem costura).
   * @returns {number} aproximadamente (−1, 1)
   */
  noise3(x, y, z) {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const zf = Math.floor(z);
    const X = xf & 255;
    const Y = yf & 255;
    const Z = zf & 255;
    const fx = x - xf;
    const fy = y - yf;
    const fz = z - zf;
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const perm = this.perm;

    const x0 = X; const x1 = (x0 + 1) & 255;
    const y0 = Y; const y1 = (y0 + 1) & 255;
    const z0 = Z; const z1 = (z0 + 1) & 255;

    const A = perm[x0] + y0; const B = perm[x1] + y0;
    const AA = perm[A] + z0; const AB = perm[A] + z1;
    const BA = perm[B] + z0; const BB = perm[B] + z1;
    // A tabela tem 12 gradientes (36 floats): índice módulo 12, inline.
    const fx1 = fx - 1; const fy1 = fy - 1; const fz1 = fz - 1;
    let i = (perm[AA] % 12) * 3;
    const n000 = GRAD3[i] * fx + GRAD3[i + 1] * fy + GRAD3[i + 2] * fz;
    i = (perm[BA] % 12) * 3;
    const n100 = GRAD3[i] * fx1 + GRAD3[i + 1] * fy + GRAD3[i + 2] * fz;
    i = (perm[AB] % 12) * 3;
    const n010 = GRAD3[i] * fx + GRAD3[i + 1] * fy1 + GRAD3[i + 2] * fz;
    i = (perm[BB] % 12) * 3;
    const n110 = GRAD3[i] * fx1 + GRAD3[i + 1] * fy1 + GRAD3[i + 2] * fz;
    i = (perm[AA + 1] % 12) * 3;
    const n001 = GRAD3[i] * fx + GRAD3[i + 1] * fy + GRAD3[i + 2] * fz1;
    i = (perm[BA + 1] % 12) * 3;
    const n101 = GRAD3[i] * fx1 + GRAD3[i + 1] * fy + GRAD3[i + 2] * fz1;
    i = (perm[AB + 1] % 12) * 3;
    const n011 = GRAD3[i] * fx + GRAD3[i + 1] * fy1 + GRAD3[i + 2] * fz1;
    i = (perm[BB + 1] % 12) * 3;
    const n111 = GRAD3[i] * fx1 + GRAD3[i + 1] * fy1 + GRAD3[i + 2] * fz1;

    const x00 = n000 + (n100 - n000) * u;
    const x10 = n010 + (n110 - n010) * u;
    const x01 = n001 + (n101 - n001) * u;
    const x11 = n011 + (n111 - n011) * u;
    const y0i = x00 + (x10 - x00) * v;
    const y1i = x01 + (x11 - x01) * v;
    return y0i + (y1i - y0i) * w;
  }

  /**
   * fBm 3D (soma de oitavas). Retorna aproximadamente (−1, 1).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {{octaves?:number, lacunarity?:number, gain?:number, ridged?:boolean, frequency?:number}} [options]
   */
  fbm3(x, y, z, options = {}) {
    const octaves = Math.max(1, options.octaves ?? 5);
    const lacunarity = options.lacunarity ?? 2.02;
    const gain = options.gain ?? 0.5;
    const ridged = options.ridged === true;
    const frequency = options.frequency ?? 1;
    let amp = 1;
    let fx = x * frequency;
    let fy = y * frequency;
    let fz = z * frequency;
    let sum = 0;
    let norm = 0;
    if (ridged) {
      for (let i = 0; i < octaves; i++) {
        sum += (1 - Math.abs(this.noise3(fx, fy, fz))) * amp;
        norm += amp;
        amp *= gain;
        fx *= lacunarity; fy *= lacunarity; fz *= lacunarity;
      }
    } else {
      for (let i = 0; i < octaves; i++) {
        sum += this.noise3(fx, fy, fz) * amp;
        norm += amp;
        amp *= gain;
        fx *= lacunarity; fy *= lacunarity; fz *= lacunarity;
      }
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * fBm 2D com período opcional (texturas cilíndricas: lon/lat).
   * @param {number} x
   * @param {number} y
   * @param {{octaves?:number, lacunarity?:number, gain?:number, ridged?:boolean, periodX?:number, periodY?:number, frequency?:number}} [options]
   */
  fbm2(x, y, options = {}) {
    const octaves = Math.max(1, options.octaves ?? 4);
    const lacunarity = options.lacunarity ?? 2.03;
    const gain = options.gain ?? 0.5;
    const ridged = options.ridged === true;
    const periodX = options.periodX ?? 0;
    const periodY = options.periodY ?? 0;
    let amp = 1;
    let freq = options.frequency ?? 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      let n = this.noise2(
        x * freq, y * freq,
        periodX > 0 ? Math.max(1, Math.round(periodX * freq)) : 0,
        periodY > 0 ? Math.max(1, Math.round(periodY * freq)) : 0,
      );
      if (ridged) n = 1 - Math.abs(n);
      sum += n * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Turbulência |fBm| — bom para nuvens, poeira e gases.
   * @param {number} x
   * @param {number} y
   * @param {{octaves?:number, periodX?:number, periodY?:number, frequency?:number}} [options]
   */
  turbulence2(x, y, options = {}) {
    const octaves = Math.max(1, options.octaves ?? 4);
    const periodX = options.periodX ?? 0;
    const periodY = options.periodY ?? 0;
    let amp = 1;
    let freq = options.frequency ?? 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = this.noise2(
        x * freq, y * freq,
        periodX > 0 ? Math.max(1, Math.round(periodX * freq)) : 0,
        periodY > 0 ? Math.max(1, Math.round(periodY * freq)) : 0,
      );
      sum += Math.abs(n) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.01;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Domínio deformado 3D: desloca a amostra por um ruído de baixa frequência.
   * Produz continentes e bandas com bordas orgânicas.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} [amount=0.35]
   * @param {number} [scale=1.8]
   */
  warp3(x, y, z, amount = 0.35, scale = 1.8) {
    const wx = this.noise3(x * scale + 11.3, y * scale + 5.7, z * scale + 21.1);
    const wy = this.noise3(x * scale + 41.7, y * scale + 17.3, z * scale + 3.9);
    const wz = this.noise3(x * scale + 7.1, y * scale + 31.9, z * scale + 14.3);
    return [x + wx * amount, y + wy * amount, z + wz * amount];
  }

  /**
   * Worley / cellular noise 3D — retorna F1, F2 e um id de célula em [0,1).
   * Usado para crateras, rachaduras de gelo e detritos rochosos.
   * @returns {{ f1:number, f2:number, id:number }}
   */
  worley3(x, y, z) {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const zf = Math.floor(z);
    let f1 = 9;
    let f2 = 9;
    let id = 0;
    for (let k = -1; k <= 1; k++) {
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const cx = xf + i;
          const cy = yf + j;
          const cz = zf + k;
          const h = hashInt(cx, cy, cz);
          const px = cx + ((h & 1023) / 1023);
          const py = cy + (((h >>> 10) & 1023) / 1023);
          const pz = cz + (((h >>> 20) & 1023) / 1023);
          const d = Math.hypot(px - x, py - y, pz - z);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            id = (h >>> 8) / 16777216;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
    }
    return { f1, f2, id };
  }
}

/** Ruído global compartilhado (determinístico) para utilitários avulsos. */
const defaultNoise = new Noise(0x5eed);

/**
 * Turbulência de fBm 3D pronta para uso — atalho sobre o ruído global.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [octaves=4]
 */
export function fbm3(x, y, z, octaves = 4) {
  return defaultNoise.fbm3(x, y, z, { octaves });
}

/** Ruído 3D pronto para uso (mesmo campo determinístico global). */
export function noise3(x, y, z) {
  return defaultNoise.noise3(x, y, z);
}

/**
 * Ruído 1D suave e determinístico — animações de flicker (chama, agulhas).
 * @param {number} t
 * @param {number} [seed=0]
 */
export function noise1(t, seed = 0) {
  return defaultNoise.noise3(t, seed * 13.37, 4.2);
}

/** Cria um gerador de ruído isolado e determinístico. */
export function createNoise(seed = 1337) {
  return new Noise(seed);
}

/* ========================================================================== */
/*  2. Planetas e luas — texturas procedurais                                 */
/* ========================================================================== */

/** Perfis de qualidade: escala de resolução e orçamento de oitavas. */
export const QUALITY_LEVELS = Object.freeze({
  low: { scale: 0.5, octaveDelta: -2, craterScale: 0.45 },
  medium: { scale: 0.75, octaveDelta: -1, craterScale: 0.7 },
  high: { scale: 1, octaveDelta: 0, craterScale: 1 },
  ultra: { scale: 1.4, octaveDelta: 1, craterScale: 1.5 },
});

/** @private Normaliza o perfil de qualidade (nome ou número 0.1..3). */
function resolveQuality(quality) {
  if (typeof quality === 'number' && Number.isFinite(quality)) {
    const scale = clamp(quality, 0.1, 3);
    return {
      scale,
      octaveDelta: scale < 0.6 ? -2 : scale < 0.85 ? -1 : scale > 1.2 ? 1 : 0,
      craterScale: scale,
    };
  }
  return QUALITY_LEVELS[quality] ?? QUALITY_LEVELS.high;
}

/** @private Cria uma LUT RGBA de um gradiente de paradas. */
function gradientLUT(stops, size = 512) {
  const lut = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    const c = sampleGradient(stops, i / (size - 1));
    const o = i * 4;
    lut[o] = c.r;
    lut[o + 1] = c.g;
    lut[o + 2] = c.b;
    lut[o + 3] = 255;
  }
  return lut;
}

/** @private Amostra a LUT criada por `gradientLUT` em [0,1] sem alocar. */
function lutColor(lut, t, out) {
  const size = (lut.length >> 2) - 1;
  const i = clamp01(t) * size;
  const i0 = i | 0;
  const i1 = i0 >= size ? size : i0 + 1;
  const f = i - i0;
  const a = i0 * 4;
  const b = i1 * 4;
  out.r = lut[a] + (lut[b] - lut[a]) * f;
  out.g = lut[a + 1] + (lut[b + 1] - lut[a + 1]) * f;
  out.b = lut[a + 2] + (lut[b + 2] - lut[a + 2]) * f;
  out.a = 255;
  return out;
}

/**
 * @typedef {object} PlanetPreset
 * @property {string} name
 * @property {'terrestrial'|'gasGiant'} type
 * @property {object} palette
 * @property {object} height   parâmetros de fBm do relevo
 * @property {?object} craters campo de crateras
 * @property {?object} iceCaps calotas polares
 * @property {?object} clouds  camada de nuvens
 * @property {?object} bands   bandas gasosas (gigantes)
 * @property {?object} emissive emissão (lava, luzes noturnas)
 * @property {object} atmosphere cor/opacidade do halo
 * @property {object} specular  intensidade especular por material
 * @property {?object} rings    anéis
 */

/** @private Base comum a todos os presets terrestres. */
function terrestrialPreset(overrides = {}) {
  return {
    type: 'terrestrial',
    palette: {
      ocean: [
        { pos: 0, color: '#061a2b' },
        { pos: 0.4, color: '#0a2f4a' },
        { pos: 0.72, color: '#0f4d66' },
        { pos: 0.9, color: '#17708a' },
        { pos: 1, color: '#2a9bb0' },
      ],
      land: [
        { pos: 0, color: '#b3a37c' },
        { pos: 0.06, color: '#8d9a5e' },
        { pos: 0.18, color: '#5d8446' },
        { pos: 0.36, color: '#3f6b39' },
        { pos: 0.56, color: '#5c6b48' },
        { pos: 0.74, color: '#7d7a6c' },
        { pos: 0.88, color: '#a8a49b' },
        { pos: 1, color: '#e6ebf0' },
      ],
      ice: '#e8f3ff',
      snow: '#f8fbff',
      desert: '#c2a878',
      rock: '#7d7a6c',
      tundra: '#8a9070',
    },
    height: {
      frequency: 1.55, octaves: 6, lacunarity: 2.03, gain: 0.52,
      warp: 0.55, warpScale: 1.45, ridge: 0.5, contrast: 1, seaLevel: 0.55,
      detail: 0.035,
    },
    craters: null,
    iceCaps: { start: 0.8, softness: 0.09, color: '#eef6ff', noise: 0.05 },
    clouds: {
      coverage: 0.48, scale: 2.6, octaves: 5, opacity: 0.9,
      color: '#ffffff', shade: '#c3d8ec', banding: 0.3, warp: 0.4,
    },
    atmosphere: { color: '#5fa8ff', halo: 1, inner: 0.55 },
    specular: { ocean: 0.95, ice: 0.5, land: 0.07 },
    emissive: null,
    maria: null,
    rings: null,
    bands: null,
    nightLights: false,
    roughness: 0.55,
    ...overrides,
  };
}

/** @private Base comum aos gigantes gasosos. */
function gasGiantPreset(overrides = {}) {
  return {
    type: 'gasGiant',
    palette: {
      bands: [
        { pos: 0, color: '#8a6647' },
        { pos: 0.12, color: '#c9a97e' },
        { pos: 0.24, color: '#efe0c2' },
        { pos: 0.36, color: '#b98a5c' },
        { pos: 0.48, color: '#f4e8cf' },
        { pos: 0.6, color: '#a8794f' },
        { pos: 0.72, color: '#ead7b4' },
        { pos: 0.84, color: '#c1935f' },
        { pos: 1, color: '#8a6647' },
      ],
      storm: '#c76a4a',
      polar: '#7f8fa6',
    },
    bands: {
      frequency: 7, turbulence: 0.045, detail: 0.05, detailFrequency: 26,
      shear: 0.6, latitudeWarp: 0.35, storms: [], polarHood: 0.86,
      differential: 0.02, sharpness: 0.12,
    },
    atmosphere: { color: '#e8c79a', halo: 0.85, inner: 0.7 },
    specular: { ocean: 0.18, ice: 0.2, land: 0.12 },
    craters: null,
    iceCaps: null,
    clouds: null,
    emissive: null,
    maria: null,
    rings: null,
    height: { frequency: 2.4, octaves: 4 },
    nightLights: false,
    roughness: 0.75,
    ...overrides,
  };
}

/**
 * Catálogo de presets prontos. Cada item é imutável e pode ser clonado pelo
 * usuário; `createPlanetTexture` aceita o nome ou um objeto derivado.
 */
export const PLANET_PRESETS = Object.freeze({
  /* ------------------------------ rochosos ------------------------------- */
  earth: terrestrialPreset({ name: 'Terra', nightLights: true }),
  ocean: terrestrialPreset({
    name: 'Mundo Oceânico',
    palette: {
      ocean: [
        { pos: 0, color: '#031726' },
        { pos: 0.45, color: '#06405f' },
        { pos: 0.8, color: '#127f96' },
        { pos: 1, color: '#41c0cd' },
      ],
      land: [
        { pos: 0, color: '#c3b58e' },
        { pos: 0.12, color: '#69985c' },
        { pos: 0.34, color: '#3d7346' },
        { pos: 0.62, color: '#6d7a62' },
        { pos: 0.84, color: '#b4bcb4' },
        { pos: 1, color: '#f2f7ff' },
      ],
      ice: '#eaf6ff', snow: '#ffffff', desert: '#cdb47a', rock: '#7c7f6a',
      tundra: '#8f9c85',
    },
    height: {
      frequency: 1.7, octaves: 6, lacunarity: 2.03, gain: 0.52,
      warp: 0.6, warpScale: 1.4, ridge: 0.32, contrast: 0.95, seaLevel: 0.66,
      detail: 0.03,
    },
    clouds: {
      coverage: 0.44, scale: 2.3, octaves: 5, opacity: 0.85,
      color: '#ffffff', shade: '#c8dcee', banding: 0.28, warp: 0.35,
    },
    iceCaps: { start: 0.88, softness: 0.05, color: '#eef8ff', noise: 0.03 },
    atmosphere: { color: '#63c7ff', halo: 1.15, inner: 0.65 },
  }),
  desert: terrestrialPreset({
    name: 'Mundo Árido',
    palette: {
      ocean: [
        { pos: 0, color: '#2a1608' },
        { pos: 0.6, color: '#6b3f16' },
        { pos: 1, color: '#a8702f' },
      ],
      land: [
        { pos: 0, color: '#dcc08f' },
        { pos: 0.14, color: '#c99a5c' },
        { pos: 0.32, color: '#b98450' },
        { pos: 0.5, color: '#a9713d' },
        { pos: 0.68, color: '#8b5834' },
        { pos: 0.84, color: '#9c6b45' },
        { pos: 1, color: '#e4d3b4' },
      ],
      ice: '#f2e8d8', snow: '#fff6e6', desert: '#d9b273', rock: '#7a4c2b',
      tundra: '#b08a5e',
    },
    height: {
      frequency: 1.9, octaves: 5, lacunarity: 2.05, gain: 0.5,
      warp: 0.62, warpScale: 1.9, ridge: 0.55, contrast: 1.05, seaLevel: 0.36,
      detail: 0.03,
    },
    iceCaps: { start: 0.92, softness: 0.04, color: '#f6ecd9', noise: 0.04 },
    clouds: {
      coverage: 0.12, scale: 3.4, octaves: 4, opacity: 0.35,
      color: '#f3dcc0', shade: '#d3b795', banding: 0.2, warp: 0.3,
    },
    atmosphere: { color: '#ffb466', halo: 0.8, inner: 0.5 },
    specular: { ocean: 0.5, ice: 0.3, land: 0.05 },
    roughness: 0.8,
  }),
  mars: terrestrialPreset({
    name: 'Marte',
    palette: {
      ocean: [
        { pos: 0, color: '#2a1108' },
        { pos: 0.7, color: '#6b2f18' },
        { pos: 1, color: '#94452a' },
      ],
      land: [
        { pos: 0, color: '#bd7a52' },
        { pos: 0.16, color: '#ab6238' },
        { pos: 0.34, color: '#9a5330' },
        { pos: 0.52, color: '#86422a' },
        { pos: 0.7, color: '#743726' },
        { pos: 0.86, color: '#8d5238' },
        { pos: 1, color: '#c9a184' },
      ],
      ice: '#f4e9e0', snow: '#fff2e6', desert: '#c07a4c', rock: '#6b3520',
      tundra: '#a86a4a',
    },
    height: {
      frequency: 1.9, octaves: 6, lacunarity: 2.04, gain: 0.5,
      warp: 0.5, warpScale: 1.9, ridge: 0.62, contrast: 1, seaLevel: 0.34,
      detail: 0.03,
    },
    craters: {
      count: 300, minRadius: 0.0022, maxRadius: 0.03,
      depth: 0.075, rim: 0.045, ejecta: 0.45, albedo: 0.42,
    },
    maria: { color: '#6b3520', threshold: 0.6, scale: 1.5, softness: 0.08 },
    iceCaps: { start: 0.9, softness: 0.05, color: '#f7f0ea', noise: 0.06 },
    clouds: {
      coverage: 0.08, scale: 3.8, octaves: 4, opacity: 0.25,
      color: '#ecd4c2', shade: '#c0a08a', banding: 0.12, warp: 0.25,
    },
    atmosphere: { color: '#d98a5c', halo: 0.6, inner: 0.4 },
    specular: { ocean: 0.35, ice: 0.35, land: 0.03 },
    roughness: 0.85,
  }),
  moon: terrestrialPreset({
    name: 'Lua',
    palette: {
      ocean: [
        { pos: 0, color: '#1c1d21' },
        { pos: 1, color: '#33353a' },
      ],
      land: [
        { pos: 0, color: '#5f6268' },
        { pos: 0.22, color: '#7d8087' },
        { pos: 0.46, color: '#999ca3' },
        { pos: 0.68, color: '#b0b3b9' },
        { pos: 0.86, color: '#c6c9ce' },
        { pos: 1, color: '#dfe2e6' },
      ],
      ice: '#dfe4ea', snow: '#f2f5f8', desert: '#9a9da2', rock: '#5c5f64',
      tundra: '#8b8e94',
    },
    height: {
      frequency: 2.2, octaves: 5, lacunarity: 2.06, gain: 0.48,
      warp: 0.32, warpScale: 2.2, ridge: 0.2, contrast: 0.85, seaLevel: -1,
      detail: 0.02,
    },
    craters: {
      count: 560, minRadius: 0.0015, maxRadius: 0.085,
      depth: 0.13, rim: 0.075, ejecta: 0.6, albedo: 1,
    },
    iceCaps: null,
    clouds: null,
    atmosphere: { color: '#96a6bb', halo: 0.25, inner: 0.15 },
    specular: { ocean: 0.05, ice: 0.06, land: 0.04 },
    maria: { color: '#383c43', threshold: 0.58, scale: 0.95, softness: 0.06 },
    roughness: 0.95,
  }),
  mercury: terrestrialPreset({
    name: 'Mercúrio',
    palette: {
      ocean: [
        { pos: 0, color: '#141312' },
        { pos: 1, color: '#2f2c29' },
      ],
      land: [
        { pos: 0, color: '#544d46' },
        { pos: 0.22, color: '#6f675e' },
        { pos: 0.45, color: '#8a8178' },
        { pos: 0.66, color: '#a1978c' },
        { pos: 0.84, color: '#b6ac9f' },
        { pos: 1, color: '#cec5b8' },
      ],
      ice: '#d8d4cc', snow: '#efeae1', desert: '#8e867b', rock: '#4f4941',
      tundra: '#7c746a',
    },
    height: {
      frequency: 2.5, octaves: 5, lacunarity: 2.05, gain: 0.48,
      warp: 0.3, warpScale: 2.4, ridge: 0.3, contrast: 0.9, seaLevel: -1,
      detail: 0.022,
    },
    craters: {
      count: 760, minRadius: 0.0014, maxRadius: 0.065,
      depth: 0.11, rim: 0.065, ejecta: 0.55, albedo: 0.9,
    },
    iceCaps: null,
    clouds: null,
    atmosphere: { color: '#8d8a84', halo: 0.18, inner: 0.1 },
    specular: { ocean: 0.03, ice: 0.03, land: 0.03 },
    roughness: 0.98,
  }),
  venus: terrestrialPreset({
    name: 'Vênus',
    palette: {
      ocean: [
        { pos: 0, color: '#6b4a1e' },
        { pos: 1, color: '#a8792f' },
      ],
      land: [
        { pos: 0, color: '#a87c3c' },
        { pos: 0.2, color: '#c1964e' },
        { pos: 0.42, color: '#d8ae62' },
        { pos: 0.62, color: '#e6c37c' },
        { pos: 0.8, color: '#efd39a' },
        { pos: 1, color: '#f8ecc8' },
      ],
      ice: '#f4e6c2', snow: '#fff3d4', desert: '#d8ab5f', rock: '#9c7838',
      tundra: '#c9a35c',
    },
    height: {
      frequency: 1.4, octaves: 5, lacunarity: 2.02, gain: 0.52,
      warp: 0.75, warpScale: 1.3, ridge: 0.34, contrast: 0.8, seaLevel: -1,
      detail: 0.025,
    },
    craters: {
      count: 90, minRadius: 0.004, maxRadius: 0.018,
      depth: 0.045, rim: 0.026, ejecta: 0.2, albedo: 0.3,
    },
    clouds: {
      coverage: 0.82, scale: 1.6, octaves: 5, opacity: 0.96,
      color: '#f8e7bd', shade: '#d6b273', banding: 0.55, warp: 0.9,
    },
    atmosphere: { color: '#f7d79b', halo: 1.25, inner: 0.85 },
    specular: { ocean: 0.12, ice: 0.1, land: 0.1 },
    roughness: 0.7,
  }),
  io: terrestrialPreset({
    name: 'Io',
    palette: {
      ocean: [
        { pos: 0, color: '#3a1f06' },
        { pos: 1, color: '#7d4a12' },
      ],
      land: [
        { pos: 0, color: '#c9a53d' },
        { pos: 0.18, color: '#dcc45e' },
        { pos: 0.36, color: '#c08a30' },
        { pos: 0.54, color: '#a3671f' },
        { pos: 0.72, color: '#8a4f18' },
        { pos: 0.88, color: '#d8bf7a' },
        { pos: 1, color: '#efe2b4' },
      ],
      ice: '#efe4b8', snow: '#fff3cc', desert: '#d9bb5c', rock: '#6b3a16',
      tundra: '#b8944a',
    },
    height: {
      frequency: 2.3, octaves: 5, lacunarity: 2.07, gain: 0.5,
      warp: 0.5, warpScale: 2, ridge: 0.55, contrast: 1, seaLevel: -1,
      detail: 0.03,
    },
    craters: {
      count: 140, minRadius: 0.003, maxRadius: 0.02,
      depth: 0.05, rim: 0.03, ejecta: 0.25, albedo: 0.35,
    },
    clouds: null,
    emissive: { kind: 'lava', threshold: 0.52, color: '#ff6a1a', glow: '#ffd27a', intensity: 1, scale: 3.2 },
    atmosphere: { color: '#d9c26a', halo: 0.35, inner: 0.25 },
    specular: { ocean: 0.08, ice: 0.08, land: 0.06 },
    roughness: 0.9,
  }),
  europa: terrestrialPreset({
    name: 'Europa',
    palette: {
      ocean: [
        { pos: 0, color: '#0d2230' },
        { pos: 1, color: '#2a5f76' },
      ],
      land: [
        { pos: 0, color: '#c6d4dc' },
        { pos: 0.24, color: '#dde9ef' },
        { pos: 0.5, color: '#eef6fa' },
        { pos: 0.72, color: '#d8cfc2' },
        { pos: 0.88, color: '#b9a48c' },
        { pos: 1, color: '#9c8368' },
      ],
      ice: '#f4fbff', snow: '#ffffff', desert: '#c8b39a', rock: '#8a6f52',
      tundra: '#cfc3b2',
    },
    height: {
      frequency: 2.8, octaves: 4, lacunarity: 2.1, gain: 0.45,
      warp: 0.28, warpScale: 3, ridge: 0.2, contrast: 0.55, seaLevel: -1,
      detail: 0.02,
    },
    craters: {
      count: 60, minRadius: 0.003, maxRadius: 0.012,
      depth: 0.025, rim: 0.018, ejecta: 0.15, albedo: 0.3,
    },
    iceCaps: null,
    clouds: null,
    atmosphere: { color: '#a8d8f0', halo: 0.2, inner: 0.12 },
    specular: { ocean: 0.5, ice: 0.75, land: 0.6 },
    cracks: { color: '#a06a3c', density: 0.75, width: 0.004, scale: 1.4 },
    roughness: 0.35,
  }),
  titan: terrestrialPreset({
    name: 'Titã',
    palette: {
      ocean: [
        { pos: 0, color: '#2a1a08' },
        { pos: 1, color: '#4a2f10' },
      ],
      land: [
        { pos: 0, color: '#a8712a' },
        { pos: 0.22, color: '#bd8838' },
        { pos: 0.45, color: '#d09a48' },
        { pos: 0.66, color: '#dcaf58' },
        { pos: 0.84, color: '#e8c273' },
        { pos: 1, color: '#f2d79b' },
      ],
      ice: '#e8c07a', snow: '#f6d79b', desert: '#c08a3c', rock: '#8a5a20',
      tundra: '#c79a52',
    },
    height: {
      frequency: 1.6, octaves: 5, lacunarity: 2.02, gain: 0.5,
      warp: 0.55, warpScale: 1.7, ridge: 0.22, contrast: 0.7, seaLevel: 0.3,
      detail: 0.025,
    },
    clouds: {
      coverage: 0.9, scale: 1.4, octaves: 5, opacity: 0.92,
      color: '#eec477', shade: '#c99a55', banding: 0.4, warp: 0.75,
    },
    atmosphere: { color: '#f2c477', halo: 1.45, inner: 1 },
    specular: { ocean: 0.15, ice: 0.1, land: 0.08 },
    roughness: 0.8,
  }),

  /* ---------------------------- gigantes gasosos -------------------------- */
  jupiter: gasGiantPreset({
    name: 'Júpiter',
    bands: {
      frequency: 6.5, turbulence: 0.048, detail: 0.07, detailFrequency: 11,
      shear: 0.7, latitudeWarp: 0.4, polarHood: 0.9, differential: 0.025, sharpness: 0.1, luminance: 2.2,
      storms: [
        { lon: 2.1, lat: -0.3, rx: 0.42, ry: 0.13, color: '#b04a34', core: '#e08a5e', swap: 0.62 },
        { lon: 4.6, lat: 0.42, rx: 0.16, ry: 0.05, color: '#f2e6cc', core: '#fffaf0', swap: 0.3 },
        { lon: 0.7, lat: -0.62, rx: 0.12, ry: 0.04, color: '#f4e6ca', core: '#fffcf4', swap: 0.25 },
        { lon: 5.4, lat: -0.12, rx: 0.2, ry: 0.06, color: '#c9a882', core: '#e8d3b2', swap: 0.25 },
      ],
    },
    atmosphere: { color: '#f0d7a8', halo: 0.9, inner: 0.75 },
    rings: { inner: 1.35, outer: 1.6, color: '#8b7a63', opacity: 0.18, tilt: 0.32 },
  }),
  saturn: gasGiantPreset({
    name: 'Saturno',
    palette: {
      bands: [
        { pos: 0, color: '#8a7355' },
        { pos: 0.12, color: '#cbb894' },
        { pos: 0.26, color: '#efe4c9' },
        { pos: 0.4, color: '#c3ab84' },
        { pos: 0.52, color: '#f6eeda' },
        { pos: 0.64, color: '#ccb58c' },
        { pos: 0.78, color: '#e8d9b8' },
        { pos: 0.9, color: '#c2a87e' },
        { pos: 1, color: '#94805e' },
      ],
      storm: '#d9b389',
      polar: '#9aa6b5',
    },
    bands: {
      frequency: 5.5, turbulence: 0.026, detail: 0.04, detailFrequency: 10,
      shear: 0.42, latitudeWarp: 0.22, polarHood: 0.93, differential: 0.015, sharpness: 0.14,
      luminance: 0.9,
      storms: [{ lon: 3.4, lat: 0.58, rx: 0.15, ry: 0.045, color: '#f6ecd8', core: '#fffef8', swap: 0.22 }],
    },
    atmosphere: { color: '#f6e6c4', halo: 1, inner: 0.8 },
    rings: {
      inner: 1.3, outer: 2.25, color: '#d9c9a6', opacity: 0.75, tilt: 0.42,
      gaps: [{ pos: 0.52, width: 0.035, opacity: 0.15 }, { pos: 0.78, width: 0.02, opacity: 0.25 }],
    },
  }),
  uranus: gasGiantPreset({
    name: 'Urano',
    palette: {
      bands: [
        { pos: 0, color: '#7fbcbf' },
        { pos: 0.2, color: '#a2d3d4' },
        { pos: 0.42, color: '#c3e6e5' },
        { pos: 0.62, color: '#a8d8d8' },
        { pos: 0.82, color: '#bfe2e2' },
        { pos: 1, color: '#82b8bc' },
      ],
      storm: '#dcf4f2',
      polar: '#6fa3ab',
    },
    bands: {
      frequency: 4.5, turbulence: 0.012, detail: 0.014, detailFrequency: 5,
      shear: 0.22, latitudeWarp: 0.1, polarHood: 0.96, differential: 0.008, sharpness: 0.05,
      storms: [],
    },
    atmosphere: { color: '#a8e6ea', halo: 0.9, inner: 0.8 },
    rings: { inner: 1.45, outer: 1.75, color: '#9fb6bd', opacity: 0.28, tilt: 1.35, vertical: true },
  }),
  neptune: gasGiantPreset({
    name: 'Netuno',
    palette: {
      bands: [
        { pos: 0, color: '#1c3f8c' },
        { pos: 0.18, color: '#2f5fbf' },
        { pos: 0.36, color: '#4a7fe0' },
        { pos: 0.52, color: '#2c58b0' },
        { pos: 0.68, color: '#3d6fd0' },
        { pos: 0.84, color: '#2a54a8' },
        { pos: 1, color: '#1e4288' },
      ],
      storm: '#0d2a5e',
      polar: '#173a7a',
    },
    bands: {
      frequency: 5, turbulence: 0.035, detail: 0.04, detailFrequency: 8,
      shear: 0.4, latitudeWarp: 0.3, polarHood: 0.92, differential: 0.02, sharpness: 0.1,
      storms: [
        { lon: 1.2, lat: -0.22, rx: 0.3, ry: 0.09, color: '#0b2450', core: '#1b3f7a', swap: 0.55 },
        { lon: 4.1, lat: 0.3, rx: 0.13, ry: 0.04, color: '#dbeaff', core: '#ffffff', swap: 0.3 },
      ],
    },
    atmosphere: { color: '#6fa0ff', halo: 1.05, inner: 0.85 },
  }),
  gasGiant: gasGiantPreset({ name: 'Gigante Gasoso' }),
});

/** Lista dos nomes de preset disponíveis (para UI / seleção). */
export const PLANET_PRESET_NAMES = Object.freeze(Object.keys(PLANET_PRESETS));

/**
 * Resolve um preset por nome, objeto parcial ou função.
 * @param {string|object|null} preset
 * @returns {PlanetPreset}
 */
export function resolvePlanetPreset(preset) {
  if (preset == null) return PLANET_PRESETS.earth;
  if (typeof preset === 'string') {
    const key = preset.toLowerCase();
    if (PLANET_PRESETS[key]) return PLANET_PRESETS[key];
    const found = Object.keys(PLANET_PRESETS).find((k) => k.toLowerCase() === key);
    if (found) return PLANET_PRESETS[found];
    throw new Error(`sprites.js: preset de planeta desconhecido "${preset}".`);
  }
  if (typeof preset === 'function') return resolvePlanetPreset(preset());
  if (typeof preset === 'object') {
    const base = preset.type === 'gasGiant'
      ? PLANET_PRESETS.gasGiant
      : (preset.base ? resolvePlanetPreset(preset.base) : PLANET_PRESETS.earth);
    return {
      ...base,
      ...preset,
      palette: { ...base.palette, ...(preset.palette ?? {}) },
      height: { ...base.height, ...(preset.height ?? {}) },
      atmosphere: { ...base.atmosphere, ...(preset.atmosphere ?? {}) },
      specular: { ...base.specular, ...(preset.specular ?? {}) },
      bands: preset.bands === null ? null
        : (preset.bands ? { ...base.bands, ...preset.bands } : base.bands),
      clouds: preset.clouds === undefined ? base.clouds : preset.clouds,
      iceCaps: preset.iceCaps === undefined ? base.iceCaps : preset.iceCaps,
      craters: preset.craters === undefined ? base.craters : preset.craters,
      emissive: preset.emissive === undefined ? base.emissive : preset.emissive,
      maria: preset.maria === undefined ? base.maria : preset.maria,
      rings: preset.rings === undefined ? base.rings : preset.rings,
    };
  }
  return PLANET_PRESETS.earth;
}

/* --------------------------- relevo e crateras ---------------------------- */

/**
 * Estampa um campo de crateras em um heightfield equirretangular e acumula
 * uma modulação de albedo (fundos escuros, bordas/ejeção claros).
 *
 * Perfil radial: bacia (0 → 0,76 r), parede+elevação (0,76 → 1 r) e ejeção
 * (1 → 1,45 r). A região é elíptica em longitude (compensação de cos(lat)) e
 * envolve na emenda 0°/360°.
 *
 * @private
 * @param {Float32Array} height campo em [0,1] (modificado no lugar)
 * @param {Float32Array|null} shade modulação de albedo em [−1,1]
 * @param {number} w
 * @param {number} h
 * @param {object} cfg { count, minRadius, maxRadius, depth, rim, ejecta, albedo }
 * @param {() => number} rng
 * @param {number} [scale=1]
 * @returns {{ count: number, area: number }}
 */
function stampCraters(height, shade, w, h, cfg, rng, scale = 1) {
  const areaPx = w * h;
  const count = Math.max(1, Math.round((cfg.count ?? 120) * scale * (areaPx / (512 * 256))));
  const minR = Math.max(0.7, (cfg.minRadius ?? 0.006) * w);
  const maxR = Math.max(minR + 0.3, (cfg.maxRadius ?? 0.05) * w);
  const depth = cfg.depth ?? 0.1;
  const rim = cfg.rim ?? 0.06;
  const ejecta = cfg.ejecta ?? 0.3;
  const albedoAmount = cfg.albedo ?? 0.5;
  let stamped = 0;

  for (let c = 0; c < count; c++) {
    // Distribuição uniforme na esfera: sin(lat) uniforme.
    const sinLat = rng() * 2 - 1;
    const lat = Math.asin(sinLat);
    const lon = rng() * TAU;
    const cosLat = Math.max(0.22, Math.cos(lat));
    // Lei de potência N(>D) ∝ D⁻² → inversa: r = rmin / sqrt(1 − u(1 − (rmin/rmax)²)).
    const ratio = minR / maxR;
    const r = minR / Math.sqrt(1 - rng() * (1 - ratio * ratio));
    const cx = mod((lon / TAU) * w, w);
    const cy = (0.5 - lat / Math.PI) * h;
    const rx = Math.min(w * 0.5, r / cosLat);
    const ry = r;
    const d = depth * (0.5 + rng() * 0.9);
    const rimH = rim * (0.5 + rng());
    const phase = rng() * TAU;
    const phase2 = rng() * TAU;
    const wobbleA = 0.05 + rng() * 0.09;
    const wobbleB = 0.02 + rng() * 0.05;

    const half = Math.ceil(rx * 1.5);
    const startX = Math.floor(cx) - half;
    const spanX = half * 2 + 1;
    const y0 = Math.max(1, Math.floor(cy - ry * 1.5));
    const y1 = Math.min(h - 2, Math.ceil(cy + ry * 1.5));

    for (let y = y0; y <= y1; y++) {
      const dyN = (y - cy) / ry;
      const row = y * w;
      for (let k = 0; k < spanX; k++) {
        const x = ((((startX + k) % w) + w) % w);
        const dxw = (startX + k - cx) / rx;
        const theta = Math.atan2(dyN, dxw);
        const wob = 1 + wobbleA * Math.sin(3 * theta + phase) + wobbleB * Math.sin(7 * theta + phase2);
        const rr = Math.hypot(dxw, dyN) / wob;
        if (rr > 1.45) continue;
        let dh = 0;
        let ds = 0;
        if (rr < 0.72) {
          // Bacia: fundo côncavo, um pouco mais escuro que a planície.
          const q = rr / 0.72;
          dh = -d * (1 - 0.18 * q * q);
          ds = -albedoAmount * 0.3 * (1 - 0.55 * q * q);
        } else if (rr < 1) {
          // Parede íngreme e borda elevada (a parte mais clara da cratera).
          const t = smoothCurve((rr - 0.72) / 0.28);
          dh = lerp(-d * 0.82, rimH, Math.pow(t, 0.7));
          ds = lerp(-albedoAmount * 0.18, albedoAmount * 0.55, Math.pow(t, 1.4));
        } else {
          // Ejeção: manto curtíssimo e claro (raio jovem).
          const fall = Math.exp(-(rr - 1) * 11);
          dh = rimH * (1 - ejecta) * fall;
          ds = albedoAmount * 0.3 * fall;
        }
        const idx = row + x;
        const v = height[idx] + dh;
        height[idx] = v < 0 ? 0 : v > 1 ? 1 : v;
        if (shade) {
          const s = shade[idx] + ds;
          shade[idx] = s < -1 ? -1 : s > 1 ? 1 : s;
        }
      }
    }
    stamped++;
  }
  return { count: stamped, area: areaPx };
}

/* ------------------------------ superfície -------------------------------- */

const _colorTmp = { r: 0, g: 0, b: 0, a: 255 };

/**
 * Renderiza albedo/normais/máscaras de um planeta terrestre.
 * Passagem 1: relevo (fBm hierárquico + crateras) e campos auxiliares.
 * Passagem 2: cor (oceano, bioma, gelo, modulação de crateras).
 * Passagem 3: nuvens em canvas separado.
 * @private
 */
function renderTerrestrial(w, h, preset, noise, rng, quality, features) {
  const total = w * h;
  const albedo = new Uint8ClampedArray(total * 4);
  const height = new Float32Array(total);
  const ridgeField = new Float32Array(total);
  // Parâmetros de umidade reutilizados no passo de cor (só onde é terra).
  const warpX = new Float32Array(total);
  const warpY = new Float32Array(total);
  const warpZ = new Float32Array(total);
  const craterShade = preset.craters ? new Float32Array(total) : null;
  const specular = features.specular ? new Uint8ClampedArray(total * 4) : null;
  const emissive = features.emissive ? new Uint8ClampedArray(total * 4) : null;
  const cloud = features.clouds && preset.clouds ? new Uint8ClampedArray(total * 4) : null;

  const pal = preset.palette;
  const oceanLUT = gradientLUT(pal.ocean);
  const landLUT = gradientLUT(pal.land);
  const iceColor = parseColor(pal.ice ?? '#eaf4ff');
  const snowColor = parseColor(pal.snow ?? '#ffffff');
  const desertColor = parseColor(pal.desert ?? '#c8a86a');
  const rockColor = parseColor(pal.rock ?? '#8a8378');
  const tundraColor = parseColor(pal.tundra ?? pal.rock ?? '#8a9070');
  const mariaColor = preset.maria ? parseColor(preset.maria.color ?? '#4e5259') : null;

  const cfg = preset.height;
  const octaves = Math.max(2, (cfg.octaves ?? 6) + quality.octaveDelta);
  const sea = cfg.seaLevel ?? 0.55;
  const hasSea = sea > 0 && sea < 1;
  const contrast = cfg.contrast ?? 1;
  const warpAmount = cfg.warp ?? 0.4;
  const warpScale = cfg.warpScale ?? 1.8;
  const ridgeStrength = cfg.ridge ?? 0.4;
  const detailAmount = cfg.detail ?? 0.03;
  const freq = cfg.frequency ?? 1.8;

  const fbmOpts = { octaves, lacunarity: cfg.lacunarity ?? 2.03, gain: cfg.gain ?? 0.52 };
  const detailOpts = { octaves: Math.max(2, Math.min(3, octaves - 2)), lacunarity: 2.11, gain: 0.55 };
  const ridgeOpts = { octaves: Math.max(2, octaves - 1), lacunarity: 2.07, gain: 0.55, ridged: true };
  const iceCaps = preset.iceCaps;
  const maria = preset.maria;

  // Pré-cálculo de senos/cossenos (ganho relevante em texturas grandes).
  const cosLon = new Float32Array(w);
  const sinLon = new Float32Array(w);
  for (let i = 0; i < w; i++) {
    const lon = ((i + 0.5) / w) * TAU;
    cosLon[i] = Math.cos(lon);
    sinLon[i] = Math.sin(lon);
  }
  const cosLatRow = new Float32Array(h);
  const sinLatRow = new Float32Array(h);
  const latNRow = new Float32Array(h);
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    const lat = (0.5 - v) * Math.PI;
    cosLatRow[j] = Math.cos(lat);
    sinLatRow[j] = Math.sin(lat);
    latNRow[j] = Math.abs(lat) / (Math.PI / 2);
  }

  /* ---------- Passagem 1: relevo, umidade, cristas ---------- */
  for (let j = 0; j < h; j++) {
    const cl = cosLatRow[j];
    const sl = sinLatRow[j];
    for (let i = 0; i < w; i++) {
      const idx = j * w + i;
      const dx = cl * cosLon[i];
      const dy = sl;
      const dz = cl * sinLon[i];

      let px = dx * freq;
      let py = dy * freq;
      let pz = dz * freq;
      if (warpAmount > 0) {
        // Domínio deformado: costas e cadeias montanhosas orgânicas.
        const wx = noise.noise3(px * warpScale + 11.3, py * warpScale + 5.7, pz * warpScale + 21.1);
        const wy = noise.noise3(px * warpScale + 41.7, py * warpScale + 17.3, pz * warpScale + 3.9);
        const wz = noise.noise3(px * warpScale + 7.1, py * warpScale + 31.9, pz * warpScale + 14.3);
        px += wx * warpAmount;
        py += wy * warpAmount;
        pz += wz * warpAmount;
      }
      // Continentes (baixa frequência) + cristas + detalhe fino.
      const base = noise.fbm3(px, py, pz, fbmOpts);
      const ridge = noise.fbm3(px * 2.4, py * 2.4, pz * 2.4, ridgeOpts);
      const detail = noise.fbm3(px * 8.5, py * 8.5, pz * 8.5, detailOpts);

      let elev = 0.5 + base * 0.46;
      const uplift = smoothstep(sea - 0.06, sea + 0.18, elev);
      elev += (ridge - 0.5) * ridgeStrength * uplift * 0.42;
      elev += detail * detailAmount;
      elev = clamp01((elev - 0.5) * contrast + 0.5);
      height[idx] = elev;
      ridgeField[idx] = ridge;
      // Guarda a posição deformada para o passo de cor (evita recomputar o
      // domínio e permite amostrar umidade apenas em terra).
      warpX[idx] = px;
      warpY[idx] = py;
      warpZ[idx] = pz;
    }
  }

  /* ---------------------- Passagem 2: crateras --------------------- */
  let craterCount = 0;
  if (preset.craters) {
    const stats = stampCraters(height, craterShade, w, h, preset.craters, rng,
      quality.craterScale * (features.craters === false ? 0 : 1));
    craterCount = stats.count;
  }

  /* ------------------- Passagem 3: cor e máscaras ------------------ */
  const color = _colorTmp;
  let sumR = 0; let sumG = 0; let sumB = 0;
  let landCount = 0;

  for (let j = 0; j < h; j++) {
    const cl = cosLatRow[j];
    const sl = sinLatRow[j];
    const latN = latNRow[j];
    for (let i = 0; i < w; i++) {
      const idx = j * w + i;
      const o = idx * 4;
      const dx = cl * cosLon[i];
      const dy = sl;
      const dz = cl * sinLon[i];
      const elev = height[idx];
      const ridge = ridgeField[idx];

      let r; let g; let b;
      let isLand = false;
      let depth = 0;

      if (hasSea && elev < sea) {
        depth = clamp01((sea - elev) / Math.max(0.06, sea));
        lutColor(oceanLUT, Math.pow(depth, 0.85), color);
        r = color.r; g = color.g; b = color.b;
      } else {
        isLand = true;
        landCount++;
        const t = hasSea ? clamp01((elev - sea) / Math.max(1e-4, 1 - sea)) : elev;
        lutColor(landLUT, t, color);
        r = color.r; g = color.g; b = color.b;
        // Desertos em baixas altitudes e baixa umidade (amostrado só em terra).
        const moist = 0.5 + 0.5 * noise.fbm3(
          warpX[idx] * 1.35 + 31.7, warpY[idx] * 1.35 + 7.3, warpZ[idx] * 1.35 + 17.9,
          { octaves: 3, lacunarity: 2.04, gain: 0.5 },
        );
        const arid = smoothstep(0.55, 0.28, moist) * (1 - smoothstep(0.12, 0.42, t));
        if (arid > 0.01) {
          const k = arid * 0.55;
          r = lerp(r, desertColor.r, k);
          g = lerp(g, desertColor.g, k);
          b = lerp(b, desertColor.b, k);
        }
        // Tundra em latitudes altas e terras baixas.
        const tundra = smoothstep(0.6, 0.85, latN) * (1 - smoothstep(0.3, 0.6, t));
        if (tundra > 0.01) {
          const k = tundra * 0.5;
          r = lerp(r, tundraColor.r, k);
          g = lerp(g, tundraColor.g, k);
          b = lerp(b, tundraColor.b, k);
        }
        // Rocha exposta em cristas e encostas.
        const rocky = smoothstep(0.55, 0.85, ridge) * smoothstep(0.45, 0.8, t) * 0.6;
        if (rocky > 0.01) {
          r = lerp(r, rockColor.r, rocky);
          g = lerp(g, rockColor.g, rocky);
          b = lerp(b, rockColor.b, rocky);
        }
        // Neve de altitude (só em mundos com calotas).
        if (iceCaps) {
          const snowLine = 0.9 - latN * 0.24
            + noise.noise3(dx * 6, dy * 6, dz * 6) * 0.03;
          const snowK = smoothstep(snowLine, snowLine + 0.08, elev) * 0.8;
          if (snowK > 0.01) {
            r = lerp(r, snowColor.r, snowK);
            g = lerp(g, snowColor.g, snowK);
            b = lerp(b, snowColor.b, snowK);
          }
        }
      }

      // Grandes planícies basálticas (maria) — Lua/Mercúrio.
      if (maria) {
        const m = noise.fbm3(dx * maria.scale, dy * maria.scale, dz * maria.scale,
          { octaves: 3, lacunarity: 2.1, gain: 0.55 });
        const mask = smoothstep(maria.threshold, maria.threshold + (maria.softness ?? 0.08),
          0.5 + 0.5 * m);
        if (mask > 0.01) {
          const k = mask * 0.8;
          r = lerp(r, mariaColor.r, k);
          g = lerp(g, mariaColor.g, k);
          b = lerp(b, mariaColor.b, k);
        }
      }

      // Calotas polares.
      let iceAmount = 0;
      if (iceCaps) {
        const wob = iceCaps.noise
          ? noise.noise3(dx * 3.1, dy * 9.0, dz * 3.1) * iceCaps.noise : 0;
        const edge = (iceCaps.start ?? 0.8) + wob;
        const soft = iceCaps.softness ?? 0.06;
        iceAmount = smoothstep(edge - soft, edge + soft, latN);
        if (iceAmount > 0.01) {
          const col = iceAmount > 0.6 ? snowColor : iceColor;
          r = lerp(r, col.r, iceAmount);
          g = lerp(g, col.g, iceAmount);
          b = lerp(b, col.b, iceAmount);
        }
      }

      // Rachaduras de gelo (Europa): rede linear anisotrópica.
      if (preset.cracks) {
        const ck = preset.cracks;
        const sc = ck.scale;
        // Três famílias de lineamentos em direções diferentes (crosta jovem).
        // Linhas = curvas de nível zero de um fBm anisotrópico (|n| pequeno).
        // Cada família é esticada em uma direção → lineamentos tectônicos.
        const l1 = noise.fbm3(dx * sc * 1.6, dy * sc * 0.25, dz * sc * 1.6,
          { octaves: 5, lacunarity: 2.2, gain: 0.55 });
        const l2 = noise.fbm3(dx * sc * 0.35 + 7.1, dy * sc * 1.5, dz * sc * 0.35 + 3.3,
          { octaves: 4, lacunarity: 2.15, gain: 0.55 });
        const l3 = noise.fbm3((dx + dz) * sc * 0.8 + 2.7, dy * sc * 0.7, (dz - dx) * sc * 0.8,
          { octaves: 4, lacunarity: 2.25, gain: 0.55 });
        const w1 = Math.max(0.004, ck.width * 4);
        const line = Math.max(
          1 - smoothstep(0, w1, Math.abs(l1)),
          (1 - smoothstep(0, w1 * 1.4, Math.abs(l2))) * 0.8,
          (1 - smoothstep(0, w1 * 1.8, Math.abs(l3))) * 0.65,
        );
        if (line > 0.02) {
          const cc = parseColor(ck.color);
          const k = line * (0.3 + 0.35 * ck.density);
          r = lerp(r, cc.r, k);
          g = lerp(g, cc.g, k);
          b = lerp(b, cc.b, k);
        }
      }

      // Modulação de albedo das crateras (bordas claras, fundos escuros).
      if (craterShade) {
        const s = craterShade[idx];
        if (s > 0) {
          r += (255 - r) * s * 0.7;
          g += (250 - g) * s * 0.7;
          b += (245 - b) * s * 0.7;
        } else if (s < 0) {
          const k = 1 + s * 0.55;
          r *= k; g *= k; b *= k;
        }
      }

      // Grão fino de superfície: quebra o aspecto "pintado" em close-up.
      const grain = noise.noise3(dx * 190, dy * 190, dz * 190) * 5.5;
      r = clamp(r + grain, 0, 255);
      g = clamp(g + grain, 0, 255);
      b = clamp(b + grain * 0.9, 0, 255);

      albedo[o] = r;
      albedo[o + 1] = g;
      albedo[o + 2] = b;
      albedo[o + 3] = 255;
      sumR += r; sumG += g; sumB += b;

      // Máscara especular: oceano liso > gelo > terra.
      if (specular) {
        let sp;
        if (isLand) sp = lerp(preset.specular.land, preset.specular.ice, iceAmount);
        else sp = lerp(preset.specular.ocean * (1 - 0.3 * depth), preset.specular.ice, iceAmount);
        const v = clamp01(sp) * 255;
        specular[o] = v; specular[o + 1] = v; specular[o + 2] = v; specular[o + 3] = 255;
      }

      // Emissão: lava (Io) ou luzes noturnas (Terra).
      if (emissive) {
        const em = preset.emissive;
        if (em && em.kind === 'lava') {
          const cell = noise.worley3(dx * em.scale * 2.2, dy * em.scale * 2.2, dz * em.scale * 2.2);
          const crack = 1 - smoothstep(0, 0.09, cell.f1);
          const hot = smoothstep(em.threshold ?? 0.5, 0.9,
            crack * 0.7 + (ridge - 0.5) * 0.5 + 0.25);
          if (hot > 0.02) {
            const glowC = parseColor(em.glow ?? '#ffd27a');
            const hotC = parseColor(em.color ?? '#ff6a1a');
            const k = smoothstep(0.4, 1, hot);
            emissive[o] = lerp(glowC.r, hotC.r, k);
            emissive[o + 1] = lerp(glowC.g, hotC.g, k);
            emissive[o + 2] = lerp(glowC.b, hotC.b, k);
            emissive[o + 3] = clamp01(hot) * 235 * (em.intensity ?? 1);
          }
        } else if (preset.nightLights && isLand) {
          const cluster = noise.fbm3(dx * 24 + 3.1, dy * 30 + 8.7, dz * 24 + 1.3,
            { octaves: 3, lacunarity: 2.1, gain: 0.55 });
          const coastal = 1 - smoothstep(0.04, 0.2, (elev - sea) / Math.max(1e-4, 1 - sea));
          const pop = smoothstep(0.24, 0.55, cluster) * coastal * smoothstep(0.92, 0.6, latN);
          if (pop > 0.02) {
            emissive[o] = 255;
            emissive[o + 1] = 205 + 35 * pop;
            emissive[o + 2] = 135 + 70 * pop;
            emissive[o + 3] = clamp01(pop) * 210;
          }
        }
      }
    }
  }

  /* ---------------------- Passagem 4: nuvens (alpha) -------------------- */
  let cloudMeta = null;
  if (cloud) {
    const cc = preset.clouds;
    const cScale = cc.scale ?? 2.6;
    const cOct = Math.max(2, (cc.octaves ?? 5) + quality.octaveDelta);
    const cColor = parseColor(cc.color ?? '#ffffff');
    const cShade = parseColor(cc.shade ?? '#c3d8ec');
    const threshold = 1 - clamp01(cc.coverage ?? 0.5);
    const banding = cc.banding ?? 0.3;
    const cloudWarp = cc.warp ?? 0.35;
    const cOpts = { octaves: cOct, lacunarity: 2.05, gain: 0.52 };
    const bandRow = new Float32Array(h);
    for (let j = 0; j < h; j++) {
      const lat = (0.5 - (j + 0.5) / h) * Math.PI;
      // Cinturões: ITCZ no equador, seco em ±30°, úmido em ±55°.
      bandRow[j] = 0.5 + 0.28 * Math.cos(lat * 2) + 0.18 * Math.cos(lat * 4 + 0.8) - 0.12;
    }
    for (let j = 0; j < h; j++) {
      const cl = cosLatRow[j];
      const sl = sinLatRow[j];
      for (let i = 0; i < w; i++) {
        const idx = j * w + i;
        const o = idx * 4;
        const dx = cl * cosLon[i];
        const dy = sl;
        const dz = cl * sinLon[i];
        const wx = noise.noise3(dx * cScale + 5.1, dy * cScale + 2.3, dz * cScale + 9.7) * cloudWarp;
        // Nuvens achatadas em latitude (cinturões zonais).
        const n = noise.fbm3(dx * cScale + wx, dy * cScale * 1.7 + wx, dz * cScale + wx, cOpts);
        const value = 0.5 + 0.5 * n + (bandRow[j] - 0.5) * banding;
        const a = smoothstep(threshold, threshold + 0.26, value) * (cc.opacity ?? 0.9);
        if (a > 0.004) {
          const thick = 0.35 + 0.65 * smoothstep(threshold, 1, value);
          cloud[o] = lerp(cShade.r, cColor.r, thick);
          cloud[o + 1] = lerp(cShade.g, cColor.g, thick);
          cloud[o + 2] = lerp(cShade.b, cColor.b, thick);
          cloud[o + 3] = clamp01(a) * 255;
        }
      }
    }
    cloudMeta = { coverage: cc.coverage ?? 0.5, opacity: cc.opacity ?? 0.9 };
  }

  return {
    albedo, height, specular, emissive, cloud, cloudMeta,
    stats: {
      landFraction: landCount / (w * h),
      craters: craterCount,
      averageColor: { r: sumR / total, g: sumG / total, b: sumB / total },
    },
  };
}

/**
 * Renderiza um gigante gasoso: bandas zonais com cisalhamento turbulento,
 * filamentos anisótropos alongados em longitude, tempestades ovais
 * (Grande Mancha Vermelha) e escurecimento polar.
 *
 * O campo de bandas é obtido por uma soma harmônica em latitude seguida de
 * "sharpening" (bordas de cinturão definidas), com a turbulência deslocando
 * apenas a coordenada de latitude — isso preserva a leitura zonal (leste-oeste)
 * que caracteriza Júpiter e Saturno em vez de produzir mármore diagonal.
 *
 * @private
 */
function renderGasGiant(w, h, preset, noise, rng, quality, features) {
  const total = w * h;
  const albedo = new Uint8ClampedArray(total * 4);
  const height = new Float32Array(total);
  const specular = features.specular ? new Uint8ClampedArray(total * 4) : null;
  const emissive = features.emissive ? new Uint8ClampedArray(total * 4) : null;

  const pal = preset.palette;
  const bandLUT = gradientLUT(pal.bands);
  const bcfg = preset.bands;
  const freq = bcfg.frequency ?? 7;
  const turbulence = bcfg.turbulence ?? 0.05;
  const detail = bcfg.detail ?? 0.05;
  const detailFreq = bcfg.detailFrequency ?? 9;
  const differential = bcfg.differential ?? 0.02;
  const sharpness = clamp(bcfg.sharpness ?? 0.1, 0.001, 0.45);
  const polarHood = bcfg.polarHood ?? 0.9;
  const storms = (bcfg.storms ?? []).map((s) => {
    const lat = s.lat ?? 0;
    return {
      ...s,
      lat,
      cosLat: Math.cos((s.lon ?? 0) * 0 + lat * Math.PI * 0.5),
      color: parseColor(s.color ?? pal.storm ?? '#c76a4a'),
      core: parseColor(s.core ?? s.color ?? pal.storm ?? '#e08a60'),
    };
  });
  const polar = parseColor(pal.polar ?? '#7f8fa6');
  const octaves = Math.max(2, 4 + quality.octaveDelta);

  // Ruído periódico em longitude (u ∈ [0,1)) → emenda 0°/360° perfeita.
  const uNoise = (u, lat, fx, fy, oct = 3) => noise.fbm2(
    u * fx, lat * fy,
    { octaves: oct, periodX: Math.max(1, Math.round(fx)), gain: 0.5, lacunarity: 2.03 },
  );

  const color = { r: 0, g: 0, b: 0, a: 255 };
  let sumR = 0; let sumG = 0; let sumB = 0;

  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    const latN = (0.5 - v) * 2;          // +1 polo norte, −1 polo sul
    for (let i = 0; i < w; i++) {
      const idx = j * w + i;
      const o = idx * 4;
      const u = (i + 0.5) / w;
      const lon = u * TAU;

      // Rotação diferencial: deslocamento máximo de ~differential em longitude.
      const uEff = mod(u + differential * Math.sin(latN * Math.PI), 1);

      // Turbulência de baixa frequência desloca a latitude (não a longitude),
      // mantendo as bandas horizontais e onduladas.
      const turb = (uNoise(uEff, latN, 3, 7, octaves) - 0.5) * 2;
      const l = clamp(latN + turb * turbulence * 3.4, -1, 1);

      // Perfil harmônico de bandas (assimetria entre hemisférios).
      const ph = l * Math.PI * freq * 0.5;
      let band = 0.5
        + 0.30 * Math.sin(ph)
        + 0.14 * Math.sin(ph * 2.31 + 1.3)
        + 0.16 * Math.sin(ph * 0.47 + 2.2);
      band = smoothstep(sharpness, 1 - sharpness, clamp01(band));

      // Filamentos finos alinhados ao equador (variação de luminância, não de
      // matiz): jatos de alta velocidade dentro de cada cinturão.
      const filament = uNoise(uEff, latN, 2, detailFreq * 7, 3) - 0.5;
      const eddy = uNoise(uEff, latN, 9, detailFreq * 22, 2) - 0.5;

      let stormMask = 0;
      let stormRim = 0;
      let stormCol = null;
      let bandDisplace = 0;
      for (let s = 0; s < storms.length; s++) {
        const st = storms[s];
        // Coordenadas normalizadas: 1.0 = 90° de longitude / polo→equador.
        const dLon = (wrapPi(lon - st.lon) * Math.max(0.3, st.cosLat)) / (Math.PI / 2);
        const dLat = latN - st.lat;
        const rx = st.rx ?? 0.25;
        const ry = st.ry ?? 0.1;
        const q = Math.hypot(dLon / rx, dLat / ry);
        if (q < 1.35) {
          const ang = Math.atan2(dLat / ry, dLon / rx);
          // O vórtice arrasta as bandas em volta de si (efeito de "olho").
          bandDisplace += Math.sin(ang + q * 2.6) * (1 - smoothstep(0.4, 1.3, q)) * 0.16;
          // Miolo preenchido: 1 no centro, 0 na borda externa da oval.
          const mask = 1 - smoothstep(0.25, 1.0, q);
          if (mask > stormMask) { stormMask = mask; stormCol = st; }
          // Colarinho: apenas uma faixa fina logo após a borda (não um anel).
          stormRim = Math.max(stormRim,
            smoothstep(0.95, 1.02, q) * (1 - smoothstep(1.06, 1.2, q)));
        }
      }
      if (bandDisplace !== 0) {
        band = clamp01(band + bandDisplace * (stormCol?.swap ?? 0.5));
      }

      lutColor(bandLUT, band, color);
      let r = color.r; let g = color.g; let b = color.b;

      // Luminância dos filamentos (só clareia/escurece a cor da banda).
      const lum = 1 + filament * detail * (bcfg.luminance ?? 2.4) + eddy * detail * 0.85;
      r *= lum; g *= lum; b *= lum;

      // Tempestade: oval colorida com colarinho claro e miolo mais quente.
      if (stormCol && stormMask > 0.005) {
        const k = stormMask * (stormCol.swap ?? 0.45);
        r = lerp(r, stormCol.color.r, k);
        g = lerp(g, stormCol.color.g, k);
        b = lerp(b, stormCol.color.b, k);
        const coreK = smoothstep(0.35, 1, stormMask) * 0.45;
        r = lerp(r, stormCol.core.r, coreK);
        g = lerp(g, stormCol.core.g, coreK);
        b = lerp(b, stormCol.core.b, coreK);
        const rimK = stormRim * 0.22;
        r = lerp(r, 246, rimK);
        g = lerp(g, 240, rimK);
        b = lerp(b, 224, rimK);
      }

      // Névoa polar (desatura e escurece em direção aos polos).
      const polarMask = smoothstep(polarHood, 1, Math.abs(latN));
      if (polarMask > 0) {
        const k = polarMask * 0.55;
        r = lerp(r, polar.r, k);
        g = lerp(g, polar.g, k);
        b = lerp(b, polar.b, k);
      }

      albedo[o] = clamp(r, 0, 255);
      albedo[o + 1] = clamp(g, 0, 255);
      albedo[o + 2] = clamp(b, 0, 255);
      albedo[o + 3] = 255;
      sumR += albedo[o]; sumG += albedo[o + 1]; sumB += albedo[o + 2];

      // Altura suave para normais (bandas + turbulência + tempestades).
      height[idx] = clamp01(0.5 + (band - 0.5) * 0.35 + turb * 0.12 + stormMask * 0.12);

      if (specular) {
        const v255 = clamp01(preset.specular.ocean * (0.85 + filament * 0.6)) * 255;
        specular[o] = v255; specular[o + 1] = v255; specular[o + 2] = v255; specular[o + 3] = 255;
      }
      if (emissive) emissive[o + 3] = 0;
    }
  }

  return {
    albedo, height, specular, emissive, cloud: null, cloudMeta: null,
    stats: {
      landFraction: 1,
      craters: 0,
      averageColor: { r: sumR / total, g: sumG / total, b: sumB / total },
    },
  };
}


/* ------------------------------- normais ---------------------------------- */

/**
 * Deriva um mapa de normais tangente-espaço a partir de um heightfield
 * equirretangular (Sobel com envolvimento em X e correção de cos(latitude)).
 *
 * @param {Float32Array} height
 * @param {number} w
 * @param {number} h
 * @param {{ strength?: number, flipGreen?: boolean }} [options]
 * @returns {Uint8ClampedArray} RGBA (normal codificada)
 */
export function heightToNormalMap(height, w, h, options = {}) {
  const strength = options.strength ?? 2.2;
  const flipGreen = options.flipGreen === true;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    const cosLat = Math.max(0.12, Math.abs(Math.cos((0.5 - v) * Math.PI)));
    const jU = j > 0 ? j - 1 : 0;
    const jD = j < h - 1 ? j + 1 : h - 1;
    for (let i = 0; i < w; i++) {
      const iL = i > 0 ? i - 1 : w - 1;
      const iR = i < w - 1 ? i + 1 : 0;
      const gx = ((height[j * w + iR] - height[j * w + iL]) * 0.5 * strength) / cosLat;
      const gy = (height[jD * w + i] - height[jU * w + i]) * 0.5 * strength;
      const len = Math.hypot(gx, gy, 1);
      const nx = -gx / len;
      const ny = (flipGreen ? gy : -gy) / len;
      const nz = 1 / len;
      const o = (j * w + i) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * 0.5 + 0.5) * 255;
      out[o + 2] = (nz * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** @private Verifica se um buffer RGBA tem algum pixel realmente visível. */
function bufferHasContent(rgba) {
  if (!rgba) return false;
  // Amostragem em degraus: rápido e suficiente para decidir se vale desenhar.
  const step = 4 * 17;
  for (let i = 3; i < rgba.length; i += step) {
    if (rgba[i] > 8) return true;
  }
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] > 8) return true;
  }
  return false;
}

/** @private Heightfield → canvas em tons de cinza. */
function heightToCanvas(height, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const v = clamp01(height[i]) * 255;
    const o = i * 4;
    rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
  }
  return bufferToCanvas(rgba, w, h);
}

/* ----------------------------- API principal ------------------------------ */

/** @private Valida e normaliza opções de geração de planeta. */
function normalizePlanetOptions(options) {
  const opts = typeof options === 'string' ? { preset: options } : { ...(options ?? {}) };
  const preset = resolvePlanetPreset(opts.preset ?? opts.name ?? 'earth');
  const quality = resolveQuality(opts.quality ?? 'high');
  let width = Math.round((opts.width ?? 512) * (opts.scale ?? 1) * quality.scale);
  width = clamp(width, 32, 4096);
  let height = Math.round(opts.height ?? width / 2);
  height = clamp(height, 16, 2048);
  const seed = (opts.seed ?? hashString(preset.name ?? 'planeta')) >>> 0;
  const features = {
    craters: opts.craters !== false,
    specular: opts.specular !== false,
    emissive: opts.emissive !== false,
    clouds: opts.clouds !== false,
    normals: opts.normals !== false,
    heightMap: opts.heightMap === true,
  };
  return {
    preset, quality, width, height, seed, features,
    normalStrength: opts.normalStrength ?? (preset.type === 'gasGiant' ? 0.5 : 2.6),
    flipGreen: opts.flipGreen === true,
    renderer: opts.renderer ?? 'auto',
    gl: opts.gl ?? null,
    readback: opts.readback !== false,
  };
}

/**
 * Gera os buffers brutos de um planeta (albedo, altura, normal, especular,
 * emissivo, nuvens). É a base de `createPlanetTexture` e também pode ser
 * enviada diretamente para uma textura WebGL.
 *
 * @param {object|string} options
 * @param {string|object} [options.preset='earth'] nome do preset ou objeto
 * @param {number} [options.width=512]       largura equirretangular
 * @param {number} [options.height=width/2]  altura (padrão 2:1)
 * @param {number} [options.seed]            seed determinística
 * @param {'low'|'medium'|'high'|'ultra'|number} [options.quality='high']
 * @param {boolean} [options.normals=true]   gera mapa de normais
 * @param {boolean} [options.specular=true]  gera máscara especular
 * @param {boolean} [options.emissive=true]  gera mapa emissivo
 * @param {boolean} [options.clouds=true]    gera camada de nuvens
 * @param {boolean} [options.heightMap=false] expõe o heightfield
 * @param {boolean} [options.flipGreen=false] inverte o canal G das normais
 * @param {number}  [options.normalStrength]  intensidade do relevo nas normais
 * @returns {{width:number,height:number,albedo:Uint8ClampedArray,normal:?Uint8ClampedArray,specular:?Uint8ClampedArray,emissive:?Uint8ClampedArray,cloud:?Uint8ClampedArray,heightField:Float32Array,preset:PlanetPreset,seed:number,stats:object}}
 */
export function generatePlanetSurface(options = {}) {
  const cfg = normalizePlanetOptions(options);
  const { preset, width: w, height: h, seed, quality, features } = cfg;
  const noise = new Noise(seed ^ 0x9e3779b9);
  const rng = createRNG(seed);

  const result = preset.type === 'gasGiant'
    ? renderGasGiant(w, h, preset, noise, rng, quality, features)
    : renderTerrestrial(w, h, preset, noise, rng, quality, features);

  let normal = null;
  if (features.normals) {
    normal = heightToNormalMap(result.height, w, h, {
      strength: cfg.normalStrength,
      flipGreen: cfg.flipGreen,
    });
  }

  return {
    width: w,
    height: h,
    albedo: result.albedo,
    normal,
    specular: result.specular,
    emissive: result.emissive,
    cloud: result.cloud,
    heightField: result.height,
    preset,
    seed,
    quality,
    stats: result.stats,
    meta: {
      type: preset.type,
      name: preset.name,
      atmosphere: preset.atmosphere,
      rings: preset.rings,
      cloud: result.cloudMeta,
      seaLevel: preset.height?.seaLevel ?? null,
      renderer: 'cpu',
    },
  };
}

/**
 * Gera a textura completa de um planeta ou lua e devolve canvases prontos
 * para `drawImage`/WebGL, mais metadados de renderização.
 *
 * @param {object|string|number} options preset, nome ou objeto de opções
 * @param {string|object} [options.preset='earth']
 * @param {number} [options.width=512]
 * @param {number} [options.height=width/2]
 * @param {number} [options.seed]
 * @param {string|number} [options.quality='high']
 * @param {'auto'|'cpu'|'webgl'} [options.renderer='auto']
 * @param {WebGLRenderingContext} [options.gl] contexto para o caminho GPU
 * @param {boolean} [options.readback=true] copia o resultado GPU para canvas
 * @param {boolean} [options.normals=true]
 * @param {boolean} [options.specular=true]
 * @param {boolean} [options.emissive=true]
 * @param {boolean} [options.clouds=true]
 * @param {boolean} [options.heightMap=false]
 * @param {number} [options.normalStrength]
 * @param {boolean} [options.flipGreen=false]
 * @returns {object} textura com `canvas`, `normalMap`, `specularMap`,
 *   `emissiveMap`, `cloudMap`, `heightMap`, `averageColor`, `atmosphere` etc.
 *
 * @example
 *   const jupiter = createPlanetTexture({ preset: 'jupiter', width: 1024 });
 *   ctx.drawImage(jupiter.canvas, 0, 0);
 *   ctx.drawImage(jupiter.normalMap, 0, 0);       // normais para shaders
 *   ctx.drawImage(jupiter.cloudMap, 0, 0);        // nuvens translúcidas
 */
export function createPlanetTexture(options = {}) {
  const cfg = normalizePlanetOptions(options);
  const { preset, width: w, height: h } = cfg;

  // Caminho GPU: explícito ('webgl') ou automático com contexto já fornecido
  // ('auto' + options.gl). Em 'auto' sem contexto, o padrão é CPU — mantém o
  // resultado determinístico e independente do driver.
  const wantsGPU = cfg.renderer === 'webgl' || (cfg.renderer === 'auto' && !!cfg.gl);
  if (wantsGPU) {
    const gl = cfg.gl ?? createHeadlessGL(w, h);
    if (gl) {
      try {
        return createGLPlanetTexture(gl, { ...options, ...cfg, width: w, height: h });
      } catch (err) {
        if (options.strict) throw err;
        // Queda silenciosa para o caminho CPU (driver, shader, framebuffer…).
      }
    } else if (cfg.renderer === 'webgl' && options.strict) {
      throw new Error('sprites.js: WebGL indisponível neste ambiente.');
    }
  }

  const surface = generatePlanetSurface({ ...options, ...cfg, width: w, height: h });
  const canvas = bufferToCanvas(surface.albedo, w, h);
  const normalMap = surface.normal ? bufferToCanvas(surface.normal, w, h) : null;
  const specularMap = surface.specular ? bufferToCanvas(surface.specular, w, h) : null;
  const emissiveMap = surface.emissive ? bufferToCanvas(surface.emissive, w, h) : null;
  const cloudMap = surface.cloud ? bufferToCanvas(surface.cloud, w, h) : null;
  const heightMap = cfg.features.heightMap ? heightToCanvas(surface.heightField, w, h) : null;

  const avg = surface.stats.averageColor;
  // Flags de camada: permite pular blends de disco inteiro quando a máscara
  // está vazia (ex.: planeta sem luzes noturnas).
  const cloudActive = !!surface.cloud && bufferHasContent(surface.cloud);
  const emissiveActive = !!surface.emissive && bufferHasContent(surface.emissive);
  const tex = {
    preset,
    name: preset.name,
    type: preset.type,
    width: w,
    height: h,
    canvas,
    ctx: get2D(canvas, { willReadFrequently: true }),
    imageData: null,
    normalMap,
    specularMap,
    emissiveMap,
    cloudMap,
    heightMap,
    heightField: cfg.features.heightMap ? surface.heightField : null,
    averageColor: { r: Math.round(avg.r), g: Math.round(avg.g), b: Math.round(avg.b) },
    atmosphere: preset.atmosphere,
    rings: preset.rings,
    cloudInfo: surface.meta.cloud,
    seaLevel: surface.meta.seaLevel,
    stats: surface.stats,
    cloudActive,
    emissiveActive,
    seed: cfg.seed,
    quality: cfg.quality,
    renderer: 'cpu',
    glTexture: null,
    gl: null,
    dispose() {
      for (const c of [canvas, normalMap, specularMap, emissiveMap, cloudMap, heightMap]) {
        if (c) { c.width = 1; c.height = 1; }
      }
      if (tex.glTexture && tex.gl) {
        try { tex.gl.deleteTexture(tex.glTexture); } catch { /* ignore */ }
      }
      tex.disposed = true;
    },
    disposed: false,
  };
  return tex;
}

/**
 * Cria (quando possível) um contexto WebGL offscreen sem canvas visível.
 * Retorna `null` se o ambiente não suportar — o chamador cai para CPU.
 * @param {number} width
 * @param {number} height
 * @returns {?WebGLRenderingContext}
 */
export function createHeadlessGL(width = 512, height = 512) {
  try {
    const canvas = createCanvas(width, height);
    const attrs = {
      alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
      failIfMajorPerformanceCaveat: false,
    };
    return canvas.getContext('webgl', attrs)
      ?? canvas.getContext('experimental-webgl', attrs)
      ?? null;
  } catch {
    return null;
  }
}

/* ========================================================================== */
/*  3. WebGL — geração em GPU e upload de texturas                            */
/* ========================================================================== */

/** Vertex shader comum: quad de tela cheia em clip space. */
const QUAD_VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Fragment shader de planeta (GLSL ES 1.00).
 * Três passagens via `uPass`: 0 = albedo, 1 = normais, 2 = máscaras
 * (R especular, G nuvens, B emissivo). O caminho GPU é uma aproximação
 * determinística do caminho CPU — mesma linguagem visual, menos camadas
 * (tempestades nomeadas, rachaduras e luzes noturnas são exclusivas da CPU).
 */
const PLANET_FRAGMENT_SHADER = `
precision highp float;

varying vec2 vUv;

uniform float uPass;            // 0 albedo | 1 normal | 2 máscaras
uniform float uType;            // 0 terrestre | 1 gigante gasoso
uniform float uSeed;
uniform vec2  uResolution;
uniform float uSeaLevel;
uniform float uCraters;
uniform float uIceStart;
uniform float uCloudCover;
uniform float uNormalStrength;
uniform float uWarp;
uniform float uRidge;
uniform float uBandFreq;
uniform float uTurbulence;
uniform float uDetail;
uniform float uFrequency;

uniform vec3 uOcean0;
uniform vec3 uOcean1;
uniform vec3 uLand0;
uniform vec3 uLand1;
uniform vec3 uLand2;
uniform vec3 uLand3;
uniform vec3 uIceColor;
uniform vec3 uBand0;
uniform vec3 uBand1;
uniform vec3 uBand2;
uniform vec3 uBand3;
uniform vec3 uStorm;
uniform vec3 uPolar;
uniform vec3 uAtmosphere;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

/* ------------------------------- ruído ---------------------------------- */

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    sum += vnoise(p) * amp;
    norm += amp;
    p *= 2.03;
    amp *= 0.5;
  }
  return sum / max(norm, 0.0001);
}

float ridged(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    sum += n * amp;
    norm += amp;
    p *= 2.07;
    amp *= 0.55;
  }
  return sum / max(norm, 0.0001);
}

/* ----------------------------- geometria -------------------------------- */

vec3 sphereDir(vec2 uv) {
  float lon = uv.x * TAU;
  float lat = (0.5 - uv.y) * PI;
  float cosLat = cos(lat);
  return vec3(cosLat * cos(lon), sin(lat), cosLat * sin(lon));
}

/* ------------------------------ crateras -------------------------------- */

float craterProfile(float rr, float rim, float depth) {
  if (rr > 1.45) return 0.0;
  if (rr < 0.76) {
    return -depth * (1.0 - 0.22 * (rr / 0.76) * (rr / 0.76));
  } else if (rr < 1.0) {
    float t = smoothstep(0.0, 1.0, (rr - 0.76) / 0.24);
    return mix(-depth * 0.78, rim, t);
  }
  return rim * 0.5 * exp(-(rr - 1.0) * 8.0);
}

float craters(vec3 dir) {
  // Grade em lon/lat com envolvimento em longitude; raio em células.
  float lon = atan(dir.z, dir.x) / TAU + 0.5;
  float lat = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;
  vec2 grid = vec2(22.0, 11.0);
  vec2 g = vec2(lon, lat) * grid;
  vec2 base = floor(g);
  float acc = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = base + vec2(float(i), float(j));
      vec2 key = vec2(mod(cell.x, grid.x), cell.y) + uSeed;
      vec2 rnd = hash22(key);
      vec2 center = cell + vec2(0.2) + rnd * 0.6;
      float radius = mix(0.1, 0.42, rnd.y * rnd.y);
      float d = length(g - center);
      float rr = d / radius;
      if (rr < 1.45) {
        float depth = mix(0.05, 0.16, rnd.x);
        float rim = depth * 0.7;
        acc += craterProfile(rr, rim, depth);
      }
    }
  }
  return acc;
}

/* ------------------------------ relevo ---------------------------------- */

float terrainHeight(vec3 dir) {
  vec3 p = dir * uFrequency;
  vec3 w = vec3(
    vnoise(p * 1.7 + vec3(11.3, 5.7, 21.1)),
    vnoise(p * 1.7 + vec3(41.7, 17.3, 3.9)),
    vnoise(p * 1.7 + vec3(7.1, 31.9, 14.3))
  );
  p += (w - 0.5) * uWarp;
  float base = fbm(p);
  float detail = fbm(p * 4.3);
  float ridgeN = ridged(p * 2.6);
  float uplift = smoothstep(uSeaLevel - 0.05, uSeaLevel + 0.22, base);
  float elev = base * 0.8 + detail * 0.12 + ridgeN * ridgeN * uplift * uRidge;
  return clamp(elev, 0.0, 1.0);
}

float heightAt(vec3 dir) {
  float h = terrainHeight(dir);
  h += craters(dir) * uCraters;
  return clamp(h, 0.0, 1.0);
}

float latOf(vec3 dir) {
  return asin(clamp(dir.y, -1.0, 1.0));
}

/* ------------------------------ albedo ---------------------------------- */

vec3 landColor(float t) {
  vec3 c = mix(uLand0, uLand1, smoothstep(0.0, 0.3, t));
  c = mix(c, uLand2, smoothstep(0.3, 0.62, t));
  c = mix(c, uLand3, smoothstep(0.62, 0.95, t));
  return c;
}

vec3 iceTint(vec3 c, float latAbs, vec3 dir) {
  float wob = (vnoise(dir * 7.0) - 0.5) * 0.08;
  float ice = smoothstep(uIceStart - 0.07, uIceStart + 0.07, latAbs + wob);
  return mix(c, uIceColor, ice);
}

vec3 terrestrialAlbedo(vec3 dir, float h) {
  vec3 c;
  float sea = clamp(uSeaLevel, 0.01, 0.99);
  if (h < sea) {
    float d = (sea - h) / sea;
    c = mix(uOcean1, uOcean0, smoothstep(0.0, 1.0, d));
  } else {
    float t = (h - sea) / max(1.0 - sea, 0.001);
    c = landColor(t);
  }
  c = iceTint(c, abs(dir.y), dir);
  return c;
}

vec3 gasGiantAlbedo(vec3 dir) {
  float lat = asin(clamp(dir.y, -1.0, 1.0)) / PI;
  vec3 p = dir * vec3(4.0, 14.0, 4.0) + vec3(uSeed);
  float warp = (fbm(p) - 0.5) * uTurbulence * 9.0;
  float latW = lat + warp * (1.0 - lat * lat);
  float band = 0.5 + 0.5 * sin(latW * PI * uBandFreq * 2.0);
  float band2 = 0.5 + 0.5 * sin(latW * PI * uBandFreq * 3.7 + 1.7);
  float value = clamp(band * 0.7 + band2 * 0.3 + (fbm(p * 9.0) - 0.5) * uDetail, 0.0, 1.0);

  vec3 c = mix(uBand0, uBand1, smoothstep(0.0, 0.34, value));
  c = mix(c, uBand2, smoothstep(0.34, 0.66, value));
  c = mix(c, uBand3, smoothstep(0.66, 1.0, value));

  // Tempestade oval fixa, eco da Grande Mancha Vermelha.
  float lon = atan(dir.z, dir.x);
  float dLon = abs(lon - 2.1) * 0.6;
  float dLat = lat * 2.0 + 0.31;
  float q = length(vec2(dLon / 0.11, dLat / 0.035));
  c = mix(c, uStorm, (1.0 - smoothstep(0.4, 1.0, q)) * 0.55);

  float polar = smoothstep(0.82, 1.0, abs(dir.y));
  c = mix(c, uPolar, polar * 0.55);
  return c;
}

vec3 albedoAt(vec2 uv) {
  vec3 dir = sphereDir(uv);
  if (uType < 0.5) {
    return terrestrialAlbedo(dir, heightAt(dir));
  }
  return gasGiantAlbedo(dir);
}

/* ------------------------------ normais --------------------------------- */

float heightForNormal(vec3 dir) {
  if (uType < 0.5) return heightAt(dir);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec3 p = dir * vec3(4.0, 14.0, 4.0) + vec3(uSeed);
  float warp = (fbm(p) - 0.5) * uTurbulence * 9.0;
  float latW = lat / PI + warp * (1.0 - lat * lat) * 0.15;
  return 0.5 + 0.5 * sin(latW * PI * uBandFreq * 2.0) * 0.3;
}

vec3 normalAt(vec2 uv) {
  vec2 texel = 1.0 / max(uResolution, vec2(1.0));
  float hL = heightForNormal(sphereDir(vec2(mod(uv.x - texel.x, 1.0), uv.y)));
  float hR = heightForNormal(sphereDir(vec2(mod(uv.x + texel.x, 1.0), uv.y)));
  float hU = heightForNormal(sphereDir(vec2(uv.x, clamp(uv.y - texel.y, 0.0, 1.0))));
  float hD = heightForNormal(sphereDir(vec2(uv.x, clamp(uv.y + texel.y, 0.0, 1.0))));
  float cosLat = max(0.18, abs(cos((uv.y - 0.5) * PI)));
  float gx = (hR - hL) * 0.5 * uNormalStrength / cosLat;
  float gy = (hD - hU) * 0.5 * uNormalStrength;
  vec3 n = normalize(vec3(-gx, -gy, 1.0));
  return n * 0.5 + 0.5;
}

/* ------------------------------ máscaras -------------------------------- */

vec3 maskAt(vec2 uv, vec3 dir, float h) {
  float spec = 0.0;
  if (uType < 0.5) {
    float sea = clamp(uSeaLevel, 0.01, 0.99);
    float ocean = 1.0 - smoothstep(sea - 0.01, sea + 0.01, h);
    float ice = smoothstep(uIceStart - 0.07, uIceStart + 0.07, abs(dir.y));
    spec = clamp(mix(0.12, 0.92, ocean) + ice * 0.25, 0.0, 1.0);
  } else {
    spec = 0.18;
  }
  float cloud = 0.0;
  if (uCloudCover > 0.001) {
    vec3 p = dir * 2.9 + vec3(uSeed * 3.1);
    float n = fbm(p) + (vnoise(dir * 12.0) - 0.5) * 0.25;
    cloud = smoothstep(1.0 - uCloudCover, 1.15 - uCloudCover, n) * 0.92;
  }
  return vec3(spec, cloud, 0.0);
}

/* -------------------------------- main ---------------------------------- */

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 dir = sphereDir(uv);
  if (uPass < 0.5) {
    vec3 c = albedoAt(uv);
    gl_FragColor = vec4(c, 1.0);
  } else if (uPass < 1.5) {
    gl_FragColor = vec4(normalAt(uv), 1.0);
  } else {
    float h = heightForNormal(dir);
    gl_FragColor = vec4(maskAt(uv, dir, h), 1.0);
  }
}
`;

/** @private Compila um shader e lança erro com o log do driver. */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('sprites.js: falha ao criar shader WebGL.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'sem log';
    gl.deleteShader(shader);
    throw new Error(`sprites.js: shader rejeitado pelo driver — ${log}`);
  }
  return shader;
}

/** @private Linka um programa a partir de dois shaders. */
function linkProgram(gl, vertexSource, fragmentSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('sprites.js: falha ao criar programa WebGL.');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'sem log';
    gl.deleteProgram(program);
    throw new Error(`sprites.js: programa WebGL não linkou — ${log}`);
  }
  return program;
}

/** @private Cache de localizações de uniform por programa. */
function uniformLocations(gl, program) {
  const cache = new Map();
  return (name) => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
    return cache.get(name);
  };
}

/** @private Define um uniform vec3 a partir de uma cor. */
function setVec3(gl, loc, color) {
  if (!loc) return;
  const c = parseColor(color);
  gl.uniform3f(loc, c.r / 255, c.g / 255, c.b / 255);
}

/** @private Preenche o quad de tela cheia e retorna o buffer. */
function createQuadBuffer(gl) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW);
  return buffer;
}

/** @private Inverte as linhas de um buffer RGBA (readPixels é bottom-up). */
function flipRows(src, width, height) {
  const out = new Uint8ClampedArray(src.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const srcOff = (height - 1 - y) * stride;
    out.set(src.subarray(srcOff, srcOff + stride), y * stride);
  }
  return out;
}

/**
 * Gera uma textura planetária na GPU e devolve o mesmo formato de
 * `createPlanetTexture` (canvas + mapas auxiliares), com `renderer: 'webgl'`.
 *
 * @param {WebGLRenderingContext} gl
 * @param {object|string} options mesmas opções de `createPlanetTexture`
 * @param {boolean} [options.readback=true] copia o resultado para canvases
 * @returns {object} textura com `glTexture`, `glTextures` e metadados
 * @throws {Error} se o shader/programa/framebuffer falharem (o chamador com
 *   `renderer:'auto'` cai automaticamente para CPU).
 */
export function createGLPlanetTexture(gl, options = {}) {
  if (!gl) throw new Error('sprites.js: contexto WebGL ausente.');
  const cfg = normalizePlanetOptions(options);
  const { preset, width: w, height: h } = cfg;
  if (w > (gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048)) {
    throw new Error('sprites.js: resolução acima do MAX_TEXTURE_SIZE do dispositivo.');
  }

  const program = linkProgram(gl, QUAD_VERTEX_SHADER, PLANET_FRAGMENT_SHADER);
  const quad = createQuadBuffer(gl);
  const loc = uniformLocations(gl, program);

  gl.useProgram(program);
  const attrib = gl.getAttribLocation(program, 'aPosition');
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(attrib);
  gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0);

  const pal = preset.palette;
  const sampleAt = (stops, t) => sampleGradient(stops, t);
  const isGas = preset.type === 'gasGiant';
  const o0 = sampleAt(pal.ocean ?? pal.bands, 0);
  const o1 = sampleAt(pal.ocean ?? pal.bands, 1);
  const l0 = sampleAt(pal.land ?? pal.bands, 0);
  const l1 = sampleAt(pal.land ?? pal.bands, 0.3);
  const l2 = sampleAt(pal.land ?? pal.bands, 0.66);
  const l3 = sampleAt(pal.land ?? pal.bands, 1);
  const bands = pal.bands ?? pal.land;
  const b0 = sampleAt(bands, 0.05);
  const b1 = sampleAt(bands, 0.35);
  const b2 = sampleAt(bands, 0.68);
  const b3 = sampleAt(bands, 0.95);

  gl.uniform1f(loc('uType'), isGas ? 1 : 0);
  gl.uniform1f(loc('uSeed'), (cfg.seed % 997) / 97);
  gl.uniform2f(loc('uResolution'), w, h);
  gl.uniform1f(loc('uSeaLevel'), isGas ? 0.5 : clamp(preset.height?.seaLevel ?? 0.55, 0.01, 0.99));
  gl.uniform1f(loc('uCraters'), preset.craters ? clamp((preset.craters.depth ?? 0.1) * 6, 0, 1.2) : 0);
  gl.uniform1f(loc('uIceStart'), preset.iceCaps ? clamp(preset.iceCaps.start ?? 0.8, 0, 1) : 2);
  gl.uniform1f(loc('uCloudCover'), preset.clouds ? clamp(preset.clouds.coverage ?? 0.5, 0, 1) : 0);
  gl.uniform1f(loc('uNormalStrength'), (cfg.normalStrength ?? 2.4) * 0.5);
  gl.uniform1f(loc('uWarp'), preset.height?.warp ?? 0.4);
  gl.uniform1f(loc('uRidge'), preset.height?.ridge ?? 0.3);
  gl.uniform1f(loc('uFrequency'), preset.height?.frequency ?? 1.8);
  gl.uniform1f(loc('uBandFreq'), preset.bands?.frequency ?? 9);
  gl.uniform1f(loc('uTurbulence'), preset.bands?.turbulence ?? 0.05);
  gl.uniform1f(loc('uDetail'), preset.bands?.detail ?? 0.04);
  setVec3(gl, loc('uOcean0'), o0);
  setVec3(gl, loc('uOcean1'), o1);
  setVec3(gl, loc('uLand0'), l0);
  setVec3(gl, loc('uLand1'), l1);
  setVec3(gl, loc('uLand2'), l2);
  setVec3(gl, loc('uLand3'), l3);
  setVec3(gl, loc('uIceColor'), pal.ice ?? '#eaf4ff');
  setVec3(gl, loc('uBand0'), b0);
  setVec3(gl, loc('uBand1'), b1);
  setVec3(gl, loc('uBand2'), b2);
  setVec3(gl, loc('uBand3'), b3);
  setVec3(gl, loc('uStorm'), pal.storm ?? '#c76a4a');
  setVec3(gl, loc('uPolar'), pal.polar ?? '#7f8fa6');
  setVec3(gl, loc('uAtmosphere'), preset.atmosphere?.color ?? '#5fa8ff');

  // Framebuffer com textura RGBA.
  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    throw new Error('sprites.js: framebuffer WebGL incompleto.');
  }
  gl.viewport(0, 0, w, h);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  const passes = [
    { pass: 0, name: 'albedo' },
    { pass: 1, name: 'normal' },
    { pass: 2, name: 'masks' },
  ];
  const buffers = {};
  const pixels = new Uint8Array(w * h * 4);
  for (const p of passes) {
    gl.uniform1f(loc('uPass'), p.pass);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    buffers[p.name] = flipRows(pixels, w, h);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteBuffer(quad);
  gl.deleteProgram(program);
  gl.deleteTexture(target);

  const readback = cfg.readback !== false;
  const upload = options.uploadToGPU === true;
  const canvas = readback ? bufferToCanvas(buffers.albedo, w, h) : null;
  const normalMap = readback && cfg.features.normals ? bufferToCanvas(buffers.normal, w, h) : null;
  const specularMap = readback && cfg.features.specular
    ? bufferToCanvas(masksToSpecular(buffers.masks, w, h), w, h) : null;
  const cloudMap = readback && cfg.features.clouds && preset.clouds
    ? bufferToCanvas(masksToCloud(buffers.masks, w, h), w, h) : null;

  // Cálculo da cor média do albedo (para HUD/halo).
  let sr = 0; let sg = 0; let sb = 0;
  for (let i = 0; i < buffers.albedo.length; i += 4) {
    sr += buffers.albedo[i]; sg += buffers.albedo[i + 1]; sb += buffers.albedo[i + 2];
  }
  const n = w * h;

  const glTexture = upload && canvas ? uploadTexture(gl, canvas, { repeatX: true }) : null;

  return {
    preset,
    name: preset.name,
    type: preset.type,
    width: w,
    height: h,
    canvas,
    ctx: canvas ? get2D(canvas, { willReadFrequently: true }) : null,
    imageData: null,
    normalMap,
    specularMap,
    emissiveMap: null,
    cloudMap,
    heightMap: null,
    heightField: null,
    buffers,
    averageColor: { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) },
    atmosphere: preset.atmosphere,
    rings: preset.rings,
    cloudInfo: preset.clouds ? { coverage: preset.clouds.coverage, opacity: preset.clouds.opacity } : null,
    cloudActive: !!cloudMap,
    emissiveActive: false,
    seaLevel: preset.height?.seaLevel ?? null,
    stats: { landFraction: NaN, craters: 0, averageColor: { r: sr / n, g: sg / n, b: sb / n } },
    seed: cfg.seed,
    quality: cfg.quality,
    renderer: 'webgl',
    gl,
    glTexture,
    glTextures: null,
    /** Sobe (uma vez) todos os mapas desta textura para a GPU. */
    uploadToGPU(glCtx = gl) {
      this.glTextures = uploadPlanetTexture(glCtx, this);
      return this.glTextures;
    },
    dispose() {
      for (const c of [canvas, normalMap, specularMap, cloudMap]) {
        if (c) { c.width = 1; c.height = 1; }
      }
      if (this.glTextures?.dispose) this.glTextures.dispose();
      this.disposed = true;
    },
    disposed: false,
  };
}

/** @private Extrai o canal especular da passagem de máscaras. */
function masksToSpecular(masks, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = masks[i * 4];
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return out;
}

/** @private Extrai o canal de nuvens (alpha) da passagem de máscaras. */
function masksToCloud(masks, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255;
    out[i * 4 + 3] = masks[i * 4 + 1];
  }
  return out;
}

/**
 * Faz upload de um canvas/imagem para uma textura WebGL com parâmetros
 * adequados (mipmap quando POT, clamp/REPEAT para texturas equirretangulares).
 *
 * @param {WebGLRenderingContext} gl
 * @param {any} source canvas, OffscreenCanvas, ImageBitmap ou ImageData
 * @param {object} [options]
 * @param {boolean} [options.mipmaps=true]
 * @param {boolean} [options.repeatX=true]  envolve em longitude
 * @param {boolean} [options.flipY=false]
 * @param {boolean} [options.linear=true]
 * @param {number}  [options.anisotropy=4]
 * @param {number}  [options.premultiplyAlpha=0] 0/1
 * @returns {WebGLTexture}
 */
export function uploadTexture(gl, source, options = {}) {
  if (!gl) throw new Error('sprites.js: contexto WebGL ausente.');
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, options.flipY ? 1 : 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, options.premultiplyAlpha ? 1 : 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

  const w = source.width ?? 0;
  const h = source.height ?? 0;
  const pot = (w & (w - 1)) === 0 && (h & (h - 1)) === 0;
  const mipmaps = options.mipmaps !== false && pot;
  const linear = options.linear !== false;
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  const wrapX = options.repeatX === false ? gl.CLAMP_TO_EDGE : gl.REPEAT;

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapX);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  if (mipmaps) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear
      ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  }

  // Anisotropia (opcional, se a extensão existir).
  const anisotropy = options.anisotropy ?? 4;
  const ext = gl.getExtension?.('EXT_texture_filter_anisotropic')
    ?? gl.getExtension?.('WEBKIT_EXT_texture_filter_anisotropic');
  if (ext && anisotropy > 0) {
    const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
    gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(anisotropy, max));
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/**
 * Sobe todos os mapas de uma textura de planeta para a GPU.
 * @param {WebGLRenderingContext} gl
 * @param {object} texture saída de `createPlanetTexture`/`generatePlanetSurface`
 * @param {object} [options] repassado a `uploadTexture`
 * @returns {{ albedo:WebGLTexture, normal:?WebGLTexture, specular:?WebGLTexture, emissive:?WebGLTexture, cloud:?WebGLTexture, dispose:() => void }}
 */
export function uploadPlanetTexture(gl, texture, options = {}) {
  const make = (source) => (source ? uploadTexture(gl, source, options) : null);
  const set = {
    albedo: make(texture.canvas),
    normal: make(texture.normalMap),
    specular: make(texture.specularMap),
    emissive: make(texture.emissiveMap),
    cloud: make(texture.cloudMap),
    dispose() {
      for (const t of [set.albedo, set.normal, set.specular, set.emissive, set.cloud]) {
        if (t) gl.deleteTexture(t);
      }
    },
  };
  return set;
}

/** Indica se o contexto é WebGL2 (habilita MRT, VAOs e texturas não-POT). */
export function isWebGL2(gl) {
  return !!gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
}

/* ========================================================================== */
/*  4. Espaçonaves — desenho vetorial procedural                             */
/* ========================================================================== */

/**
 * Fases de voo suportadas por `createSpaceshipSprite`.
 * @type {ReadonlyArray<string>}
 */
export const SPACECRAFT_PHASES = Object.freeze([
  'stack', 'ascent', 'upper', 'capsule', 'satellite', 'lander',
]);

/** Paletas de chama por propelente. */
export const FLAME_SPECTRA = Object.freeze({
  /** LH2/LOX — azul-claro quase incolor. */
  hydrolox: {
    core: '#f2fbff', mid: '#8ecbff', outer: '#3567ff', fringe: '#ff8a3d',
    glow: '#9ed7ff', smoke: 0.25,
  },
  /** RP-1/LOX — laranja intenso com ponta amarela. */
  kerolox: {
    core: '#fff8dc', mid: '#ffc043', outer: '#ff5b1a', fringe: '#c22a0a',
    glow: '#ffa040', smoke: 0.8,
  },
  /** CH4/LOX — azul-violeta com franja laranja. */
  methalox: {
    core: '#f0f6ff', mid: '#a9c2ff', outer: '#6a5bff', fringe: '#ff9450',
    glow: '#a8b8ff', smoke: 0.35,
  },
  /** Propelente sólido — amarelo-branco com muita fumaça. */
  solid: {
    core: '#fffbe0', mid: '#ffcc3a', outer: '#ff7a12', fringe: '#d1370a',
    glow: '#ffb347', smoke: 1,
  },
  /** Motor iônico/plasma — violeta elétrico. */
  ion: {
    core: '#eaf6ff', mid: '#7fb4ff', outer: '#3f5bff', fringe: '#8a4dff',
    glow: '#7fa8ff', smoke: 0,
  },
});

/** Configuração padrão de espaçonave. */
export const SPACESHIP_DEFAULTS = Object.freeze({
  length: 160,             // px do bico à base (unidade de autoria)
  radiusRatio: 0.095,      // raio do corpo / comprimento
  body: '#e9edf2',
  bodyDark: '#b9c2cc',
  accent: '#d9452b',
  dark: '#2b3139',
  metal: '#a9b5c3',
  window: '#7fe0ff',
  nozzle: '#454b54',
  heatShield: '#3b2d28',
  solar: '#1b2f6b',
  solarLine: '#3f6fd8',
  fins: true,
  boosters: 0,             // 0, 2 ou 4
  fairing: true,
  stripe: true,
  markings: true,
  solarPanels: true,
  supersample: 2,
  seed: 7,
  flame: {
    spectrum: 'kerolox',
    length: 1.05,          // múltiplo do comprimento da nave
    width: 0.55,           // múltiplo do diâmetro
    flicker: 1,
  },
});

/** @private Resolve a configuração final da espaçonave. */
function resolveSpaceshipConfig(config = {}) {
  const cfg = { ...SPACESHIP_DEFAULTS, ...config };
  cfg.flame = { ...SPACESHIP_DEFAULTS.flame, ...(config.flame ?? {}) };
  cfg.length = clamp(cfg.length, 24, 2048);
  cfg.radiusRatio = clamp(cfg.radiusRatio, 0.02, 0.22);
  cfg.supersample = clamp(cfg.supersample, 1, 4);
  cfg.boosters = [0, 2, 4].includes(cfg.boosters) ? cfg.boosters : 0;
  cfg.seed = (cfg.seed ?? 7) >>> 0;
  return cfg;
}

/* --------------------------- primitivas de desenho ------------------------ */

/** @private Traça um corpo de revolução a partir de uma função de raio. */
function traceRevolution(ctx, y0, y1, radiusAt, steps = 18) {
  const N = Math.max(3, steps);
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = lerp(y0, y1, t);
    const r = Math.max(0, radiusAt(y, t));
    if (i === 0) ctx.moveTo(r, y);
    else ctx.lineTo(r, y);
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    const y = lerp(y0, y1, t);
    const r = Math.max(0, radiusAt(y, t));
    ctx.lineTo(-r, y);
  }
  ctx.closePath();
}

/** @private Gradiente metálico cilíndrico (luz vinda da esquerda). */
function metallicGradient(ctx, radius, base, options = {}) {
  const highlight = options.highlight ?? 0.34;
  const g = ctx.createLinearGradient(-radius, 0, radius, 0);
  const c = parseColor(base);
  g.addColorStop(0, cssColor(shade(c, -0.42)));
  g.addColorStop(0.06, cssColor(shade(c, -0.66)));
  g.addColorStop(0.2, cssColor(shade(c, -0.3)));
  g.addColorStop(0.36, cssColor(shade(c, highlight * 1.15)));
  g.addColorStop(0.48, cssColor(shade(c, highlight * 0.85)));
  g.addColorStop(0.66, cssColor(c));
  g.addColorStop(0.86, cssColor(shade(c, -0.42)));
  g.addColorStop(1, cssColor(shade(c, -0.7)));
  return g;
}

/** @private Preenche e contorna uma seção do corpo. */
function paintBody(ctx, radius, base, options = {}) {
  ctx.fillStyle = metallicGradient(ctx, radius, base, options);
  ctx.fill();
  if (options.stroke !== false) {
    ctx.lineWidth = Math.max(0.6, radius * 0.035);
    ctx.strokeStyle = cssColor(shade(parseColor(base), -0.55), 0.65);
    ctx.stroke();
  }
}

/** @private Painéis, costuras e rebites dentro do corpo (com clip). */
function paintPanels(ctx, radius, y0, y1, cfg, rows = 4, cols = 2) {
  if (!cfg.markings) return;
  ctx.save();
  ctx.lineWidth = Math.max(0.35, radius * 0.018);
  ctx.strokeStyle = 'rgba(20,26,34,0.20)';
  for (let i = 1; i < rows; i++) {
    const y = lerp(y0, y1, i / rows);
    ctx.beginPath();
    ctx.moveTo(-radius * 0.94, y);
    ctx.lineTo(radius * 0.94, y);
    ctx.stroke();
  }
  for (let i = 1; i <= cols; i++) {
    const x = -radius + (2 * radius * i) / (cols + 1);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }
  // Rebites discretos.
  ctx.fillStyle = 'rgba(20,26,34,0.28)';
  const step = Math.max(4, radius * 0.45);
  const size = Math.max(0.7, radius * 0.035);
  for (let y = y0 + step; y < y1; y += step) {
    for (let k = -1; k <= 1; k += 2) {
      ctx.fillRect(k * radius * 0.82 - size / 2, y, size, size);
    }
  }
  ctx.restore();
}

/** @private Faixa de rolagem preto/branco (estilo Saturn V). */
function paintRollPattern(ctx, radius, y0, y1, accent) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(-radius, y0, radius * 2, y1 - y0);
  ctx.clip();
  const n = 6;
  const h = (y1 - y0) / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 === 0 ? cssColor(parseColor('#20242b')) : cssColor(parseColor('#f2f4f7'));
    ctx.fillRect(-radius, y0 + i * h, radius * 2, h);
  }
  if (accent) {
    ctx.fillStyle = cssColor(parseColor(accent), 0.9);
    ctx.fillRect(-radius, y1 - h * 0.55, radius * 2, h * 0.3);
  }
  ctx.restore();
}

/** @private Sino de tubeira (bell nozzle). */
function drawNozzle(ctx, cx, y, width, height, cfg) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  ctx.save();
  ctx.translate(cx, y);
  const g = ctx.createLinearGradient(-w * 0.5, 0, w * 0.5, 0);
  g.addColorStop(0, '#1a1d22');
  g.addColorStop(0.25, cssColor(parseColor(cfg.nozzle)));
  g.addColorStop(0.5, '#7d8792');
  g.addColorStop(0.75, cssColor(parseColor(cfg.nozzle)));
  g.addColorStop(1, '#15181c');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-w * 0.34, 0);
  ctx.bezierCurveTo(-w * 0.4, h * 0.42, -w * 0.62, h * 0.78, -w * 0.56, h);
  ctx.lineTo(w * 0.56, h);
  ctx.bezierCurveTo(w * 0.62, h * 0.78, w * 0.4, h * 0.42, w * 0.34, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,12,16,0.85)';
  ctx.lineWidth = Math.max(0.5, w * 0.03);
  ctx.stroke();
  // Interior escuro e lábio inferior.
  ctx.beginPath();
  ctx.ellipse(0, h, w * 0.56, h * 0.1, 0, 0, TAU);
  ctx.fillStyle = 'rgba(8,10,14,0.95)';
  ctx.fill();
  ctx.restore();
}

/** @private Aletas estabilizadoras (par esquerdo/direito). */
function drawFins(ctx, radius, yBase, height, base) {
  const fin = (sign) => {
    ctx.save();
    ctx.scale(sign, 1);
    ctx.beginPath();
    ctx.moveTo(radius * 0.82, yBase - height);
    ctx.bezierCurveTo(radius * 1.7, yBase - height * 0.72, radius * 2.15, yBase - height * 0.22,
      radius * 1.92, yBase + height * 0.1);
    ctx.lineTo(radius * 0.8, yBase + height * 0.04);
    ctx.closePath();
    const g = ctx.createLinearGradient(radius * 0.8, 0, radius * 2, 0);
    g.addColorStop(0, cssColor(shade(parseColor(base), -0.25)));
    g.addColorStop(0.55, cssColor(parseColor(base)));
    g.addColorStop(1, cssColor(shade(parseColor(base), -0.5)));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(14,18,24,0.7)';
    ctx.lineWidth = Math.max(0.5, radius * 0.03);
    ctx.stroke();
    // Linha de estrutura interna.
    ctx.beginPath();
    ctx.moveTo(radius * 1.0, yBase - height * 0.55);
    ctx.lineTo(radius * 1.7, yBase - height * 0.05);
    ctx.strokeStyle = 'rgba(14,18,24,0.35)';
    ctx.stroke();
    ctx.restore();
  };
  fin(1);
  fin(-1);
}

/** @private Estágio cilíndrico com pintura e painéis. */
function drawStage(ctx, cfg, radius, y0, y1, base, options = {}) {
  traceRevolution(ctx, y0, y1, () => radius, 6);
  paintBody(ctx, radius, base);
  ctx.save();
  traceRevolution(ctx, y0, y1, () => radius, 6);
  ctx.clip();
  paintPanels(ctx, radius, y0, y1, cfg, options.rows ?? 4, options.cols ?? 2);
  if (options.roll) paintRollPattern(ctx, radius, y0 + (y1 - y0) * 0.02,
    y0 + (y1 - y0) * 0.24, cfg.accent);
  if (options.band) {
    ctx.fillStyle = cssColor(parseColor(cfg.accent), 0.92);
    ctx.fillRect(-radius, options.band[0], radius * 2, options.band[1] - options.band[0]);
  }
  // Sombreado de contato (ambient occlusion nas extremidades).
  const ao = ctx.createLinearGradient(0, y0, 0, y1);
  ao.addColorStop(0, 'rgba(0,0,0,0.18)');
  ao.addColorStop(0.08, 'rgba(0,0,0,0)');
  ao.addColorStop(0.92, 'rgba(0,0,0,0)');
  ao.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = ao;
  ctx.fillRect(-radius, y0, radius * 2, y1 - y0);
  ctx.restore();
}

/** @private Coifa/carenagem ogival com linha de separação. */
function drawFairing(ctx, cfg, radius, y0, y1) {
  const rad = (y) => {
    const t = clamp01((y - y0) / (y1 - y0));
    // Ogiva: r * sqrt(1 - (1-t)^2) suavizada, com ponta levemente romba.
    return radius * Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2.2)));
  };
  traceRevolution(ctx, y0, y1, rad, 26);
  paintBody(ctx, radius, cfg.body, { highlight: 0.4 });
  ctx.save();
  traceRevolution(ctx, y0, y1, rad, 26);
  ctx.clip();
  // Costura central das duas metades.
  ctx.strokeStyle = 'rgba(24,30,38,0.55)';
  ctx.lineWidth = Math.max(0.6, radius * 0.04);
  ctx.beginPath();
  ctx.moveTo(0, y0);
  ctx.lineTo(0, y1);
  ctx.stroke();
  // Reflexo especular suave.
  const sheen = ctx.createLinearGradient(-radius, 0, radius * 0.2, 0);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(-radius, y0, radius * 2, y1 - y0);
  if (cfg.stripe) {
    ctx.fillStyle = cssColor(parseColor(cfg.accent), 0.75);
    ctx.fillRect(-radius, y1 - radius * 0.55, radius * 2, radius * 0.18);
  }
  ctx.restore();
}

/** @private Propulsor lateral (booster) completo. */
function drawBooster(ctx, cfg, radius, x, yTop, yBottom, base) {
  const r = radius * 0.44;
  ctx.save();
  ctx.translate(x, 0);
  // Corpo.
  traceRevolution(ctx, yTop + r * 1.5, yBottom, () => r, 5);
  paintBody(ctx, r, base);
  ctx.save();
  traceRevolution(ctx, yTop + r * 1.5, yBottom, () => r, 5);
  ctx.clip();
  paintPanels(ctx, r, yTop + r * 1.5, yBottom, cfg, 3, 1);
  ctx.fillStyle = cssColor(parseColor(cfg.accent), 0.85);
  ctx.fillRect(-r, yBottom - r * 0.9, r * 2, r * 0.22);
  ctx.restore();
  // Cone do bico.
  const nose = (y) => {
    const t = clamp01((y - yTop) / (r * 1.8));
    return r * Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2)));
  };
  traceRevolution(ctx, yTop, yTop + r * 1.8, nose, 12);
  paintBody(ctx, r, base, { highlight: 0.45 });
  // Tubeira.
  drawNozzle(ctx, 0, yBottom, r * 1.25, r * 0.85, cfg);
  ctx.restore();
}

/**
 * Desenha uma espaçonave na fase indicada, no espaço local (bico para cima,
 * y = 0 no bico, y = length na base). Retorna os pontos de saída dos motores.
 *
 * @private
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} cfg saída de `resolveSpaceshipConfig`
 * @param {string} phase
 * @returns {{ nozzles: Array<{x:number,y:number,width:number,scale:number}>, body: object }}
 */
function paintSpacecraft(ctx, cfg, phase) {
  const L = cfg.length;
  const r = L * cfg.radiusRatio;
  const nozzles = [];
  const body = { nose: 0, base: L, radius: r };

  if (phase === 'stack' || phase === 'ascent') {
    const fairingEnd = L * 0.24;
    const stage2 = { y0: fairingEnd, y1: L * 0.54, radius: r * 0.92 };
    const interstage = { y0: L * 0.54, y1: L * 0.58 };
    const stage1 = { y0: L * 0.58, y1: L * 0.9, radius: r };
    const skirt = { y0: L * 0.9, y1: L * 0.96 };

    // Estágio 1.
    drawStage(ctx, cfg, stage1.radius, stage1.y0, stage1.y1, cfg.body, {
      rows: 5, cols: 2, roll: true, band: [stage1.y1 - r * 1.1, stage1.y1 - r * 0.75],
    });
    // Interestágio.
    drawStage(ctx, cfg, r * 0.94, interstage.y0, interstage.y1, cfg.dark, { rows: 1, cols: 1 });
    // Estágio 2.
    drawStage(ctx, cfg, stage2.radius, stage2.y0, stage2.y1, cfg.bodyDark, { rows: 3, cols: 2 });
    // Saia do motor.
    traceRevolution(ctx, skirt.y0, skirt.y1, (y) => lerp(stage1.radius, stage1.radius * 0.86,
      clamp01((y - skirt.y0) / (skirt.y1 - skirt.y0))), 4);
    paintBody(ctx, stage1.radius, cfg.dark);
    // Aletas.
    if (cfg.fins) drawFins(ctx, stage1.radius, skirt.y1, L * 0.13, cfg.metal);
    // Coifa.
    if (cfg.fairing) {
      drawFairing(ctx, cfg, r * 0.98, 0, fairingEnd);
    } else {
      traceRevolution(ctx, 0, fairingEnd, (y) => {
        const t = clamp01(y / fairingEnd);
        return r * 0.9 * Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2)));
      }, 20);
      paintBody(ctx, r * 0.9, cfg.bodyDark);
    }
    // Motores principais (1 central + 2 laterais visíveis).
    const engineY = skirt.y1;
    drawNozzle(ctx, 0, engineY, r * 1.1, r * 0.85, cfg);
    drawNozzle(ctx, -r * 0.55, engineY - r * 0.02, r * 0.62, r * 0.5, cfg);
    drawNozzle(ctx, r * 0.55, engineY - r * 0.02, r * 0.62, r * 0.5, cfg);
    nozzles.push({ x: 0, y: engineY + r * 0.85, width: r * 1.0, scale: 1 });
    nozzles.push({ x: -r * 0.55, y: engineY + r * 0.48, width: r * 0.55, scale: 0.62 });
    nozzles.push({ x: r * 0.55, y: engineY + r * 0.48, width: r * 0.55, scale: 0.62 });

    // Propulsores laterais.
    if (cfg.boosters > 0) {
      const offset = r + r * 0.55;
      const yTop = L * 0.36;
      const yBottom = L * 0.94;
      drawBooster(ctx, cfg, r, -offset, yTop, yBottom, cfg.body);
      drawBooster(ctx, cfg, r, offset, yTop, yBottom, cfg.body);
      if (cfg.boosters === 4) {
        drawBooster(ctx, cfg, r, -offset * 0.55, yTop + L * 0.03, yBottom - L * 0.01, cfg.bodyDark);
        drawBooster(ctx, cfg, r, offset * 0.55, yTop + L * 0.03, yBottom - L * 0.01, cfg.bodyDark);
      }
      const by = yBottom + r * 0.38;
      nozzles.push({ x: -offset, y: by, width: r * 0.5, scale: 0.55 });
      nozzles.push({ x: offset, y: by, width: r * 0.5, scale: 0.55 });
      body.base = Math.max(body.base, by);
    }
    body.fairingEnd = fairingEnd;
  } else if (phase === 'upper') {
    // Estágio superior orbital: tanque + motor de vácuo + carga útil.
    const tank = { y0: L * 0.22, y1: L * 0.74, radius: r };
    drawStage(ctx, cfg, tank.radius, tank.y0, tank.y1, cfg.body, {
      rows: 5, cols: 2, band: [L * 0.3, L * 0.32],
    });
    // Adapter + carga útil (coifa curta).
    traceRevolution(ctx, L * 0.1, tank.y0, (y) => {
      const t = clamp01((y - L * 0.1) / (tank.y0 - L * 0.1));
      return lerp(r * 0.55, r, t);
    }, 6);
    paintBody(ctx, r, cfg.bodyDark);
    traceRevolution(ctx, 0, L * 0.1, (y) => {
      const t = clamp01(y / (L * 0.1));
      return r * 0.55 * Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2)));
    }, 14);
    paintBody(ctx, r * 0.55, cfg.body, { highlight: 0.45 });
    // Motor de vácuo (sino grande).
    drawNozzle(ctx, 0, tank.y1, r * 1.5, r * 1.4, cfg);
    nozzles.push({ x: 0, y: tank.y1 + r * 1.4, width: r * 1.25, scale: 1.25 });
    // RCS.
    for (const sy of [L * 0.3, L * 0.66]) {
      for (const sx of [-1, 1]) {
        ctx.fillStyle = cssColor(parseColor(cfg.dark));
        ctx.fillRect(sx * r * 0.92 - r * 0.08, sy, r * 0.16, r * 0.22);
      }
    }
    body.base = tank.y1 + r * 1.4;
  } else if (phase === 'capsule') {
    // Cápsula de reentrada: escudo térmico + cone truncado + paraquedas.
    const top = L * 0.16;
    const bottom = L * 0.66;
    const capR = r * 1.5;
    traceRevolution(ctx, top, bottom, (y) => {
      const t = clamp01((y - top) / (bottom - top));
      return capR * (0.42 + 0.58 * Math.pow(t, 0.85));
    }, 16);
    paintBody(ctx, capR, cfg.body, { highlight: 0.42 });
    ctx.save();
    traceRevolution(ctx, top, bottom, (y) => {
      const t = clamp01((y - top) / (bottom - top));
      return capR * (0.42 + 0.58 * Math.pow(t, 0.85));
    }, 16);
    ctx.clip();
    // Escudo térmico ablativos.
    const shield = ctx.createLinearGradient(0, bottom - capR * 0.5, 0, bottom);
    shield.addColorStop(0, cssColor(parseColor(cfg.heatShield), 0.4));
    shield.addColorStop(1, cssColor(parseColor(cfg.heatShield)));
    ctx.fillStyle = shield;
    ctx.fillRect(-capR, bottom - capR * 0.52, capR * 2, capR * 0.52);
    // Janela de observação.
    ctx.beginPath();
    ctx.ellipse(0, L * 0.3, capR * 0.22, capR * 0.16, 0, 0, TAU);
    const wg = ctx.createRadialGradient(-capR * 0.05, L * 0.29, 0, 0, L * 0.3, capR * 0.24);
    wg.addColorStop(0, '#eaffff');
    wg.addColorStop(0.5, cssColor(parseColor(cfg.window)));
    wg.addColorStop(1, 'rgba(20,40,60,0.9)');
    ctx.fillStyle = wg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,34,0.8)';
    ctx.lineWidth = Math.max(0.6, capR * 0.04);
    ctx.stroke();
    ctx.restore();
    // Módulo de serviço e RCS.
    traceRevolution(ctx, bottom, bottom + L * 0.12, () => capR * 0.78, 4);
    paintBody(ctx, capR * 0.78, cfg.bodyDark);
    for (const sx of [-1, 1]) {
      ctx.fillStyle = cssColor(parseColor(cfg.dark));
      ctx.fillRect(sx * capR * 0.7, top + (bottom - top) * 0.35, capR * 0.16, capR * 0.3);
    }
    nozzles.push({ x: 0, y: bottom + L * 0.12 + capR * 0.3, width: capR * 0.5, scale: 0.5 });
    body.base = bottom + L * 0.12 + capR * 0.3;
  } else if (phase === 'satellite') {
    // Barramento + asas solares + antena parabólica.
    const busY = L * 0.34;
    const busH = L * 0.3;
    const busW = r * 2.1;
    ctx.fillStyle = metallicGradient(ctx, busW / 2, cfg.bodyDark);
    const rr = r * 0.28;
    roundedRectPath(ctx, -busW / 2, busY, busW, busH, rr);
    ctx.fill();
    ctx.strokeStyle = 'rgba(16,20,26,0.75)';
    ctx.lineWidth = Math.max(0.6, r * 0.03);
    ctx.stroke();
    // Painéis solares.
    if (cfg.solarPanels) {
      const panelW = L * 0.42;
      const panelH = busH * 0.72;
      for (const sign of [-1, 1]) {
        const px = sign > 0 ? busW / 2 + r * 0.12 : -busW / 2 - r * 0.12 - panelW;
        const pg = ctx.createLinearGradient(px, busY, px + panelW, busY + panelH);
        pg.addColorStop(0, cssColor(shade(parseColor(cfg.solar), 0.25)));
        pg.addColorStop(0.5, cssColor(parseColor(cfg.solar)));
        pg.addColorStop(1, cssColor(shade(parseColor(cfg.solar), -0.25)));
        ctx.fillStyle = pg;
        ctx.fillRect(px, busY + (busH - panelH) / 2, panelW, panelH);
        ctx.strokeStyle = cssColor(parseColor(cfg.solarLine), 0.55);
        ctx.lineWidth = Math.max(0.4, r * 0.02);
        const cols = 6;
        const rows = 3;
        for (let i = 1; i < cols; i++) {
          const x = px + (panelW * i) / cols;
          ctx.beginPath();
          ctx.moveTo(x, busY + (busH - panelH) / 2);
          ctx.lineTo(x, busY + (busH + panelH) / 2);
          ctx.stroke();
        }
        for (let i = 1; i < rows; i++) {
          const y = busY + (busH - panelH) / 2 + (panelH * i) / rows;
          ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px + panelW, y); ctx.stroke();
        }
        // Haste.
        ctx.fillStyle = cssColor(parseColor(cfg.metal));
        ctx.fillRect(sign > 0 ? busW / 2 : -busW / 2 - r * 0.12, busY + busH / 2 - r * 0.04, r * 0.12, r * 0.08);
      }
    }
    // Antena parabólica.
    const dishR = r * 0.85;
    ctx.beginPath();
    ctx.ellipse(0, busY - dishR * 0.5, dishR, dishR * 0.55, 0, Math.PI, TAU);
    const dg = ctx.createLinearGradient(0, busY - dishR, 0, busY);
    dg.addColorStop(0, '#f2f6fa');
    dg.addColorStop(1, '#8b96a3');
    ctx.fillStyle = dg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(16,20,26,0.6)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, busY);
    ctx.lineTo(0, busY - dishR * 1.15);
    ctx.strokeStyle = cssColor(parseColor(cfg.metal));
    ctx.lineWidth = Math.max(0.8, r * 0.05);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, busY - dishR * 1.15, Math.max(1, r * 0.12), 0, TAU);
    ctx.fillStyle = cssColor(parseColor(cfg.window));
    ctx.fill();
    // Propulsor de apogeu.
    drawNozzle(ctx, 0, busY + busH, r * 0.7, r * 0.45, cfg);
    nozzles.push({ x: 0, y: busY + busH + r * 0.45, width: r * 0.55, scale: 0.5 });
    body.base = busY + busH + r * 0.45;
  } else if (phase === 'lander') {
    // Módulo de pouso: corpo octogonal, pernas e tubeira.
    const bodyY = L * 0.3;
    const bodyH = L * 0.32;
    const bw = r * 2.4;
    const oct = (cx, cy, w, h, cut) => {
      ctx.beginPath();
      ctx.moveTo(cx - w / 2 + cut, cy);
      ctx.lineTo(cx + w / 2 - cut, cy);
      ctx.lineTo(cx + w / 2, cy + cut);
      ctx.lineTo(cx + w / 2, cy + h - cut);
      ctx.lineTo(cx + w / 2 - cut, cy + h);
      ctx.lineTo(cx - w / 2 + cut, cy + h);
      ctx.lineTo(cx - w / 2, cy + h - cut);
      ctx.lineTo(cx - w / 2, cy + cut);
      ctx.closePath();
    };
    oct(0, bodyY, bw, bodyH, r * 0.28);
    ctx.fillStyle = metallicGradient(ctx, bw / 2, cfg.body);
    ctx.fill();
    ctx.strokeStyle = 'rgba(16,20,26,0.8)';
    ctx.lineWidth = Math.max(0.6, r * 0.04);
    ctx.stroke();
    // Pernas de pouso.
    ctx.strokeStyle = cssColor(parseColor(cfg.metal));
    ctx.lineWidth = Math.max(1.2, r * 0.12);
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * bw * 0.4, bodyY + bodyH * 0.75);
      ctx.lineTo(sx * bw * 0.95, bodyY + bodyH + L * 0.16);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(sx * bw * 0.95, bodyY + bodyH + L * 0.17, r * 0.22, r * 0.08, 0, 0, TAU);
      ctx.fillStyle = cssColor(parseColor(cfg.dark));
      ctx.fill();
    }
    drawNozzle(ctx, 0, bodyY + bodyH, bw * 0.5, r * 0.7, cfg);
    nozzles.push({ x: 0, y: bodyY + bodyH + r * 0.7, width: r * 0.5, scale: 0.6 });
    body.base = bodyY + bodyH + L * 0.18;
  }

  return { nozzles, body };
}

/** @private Caminho de retângulo arredondado (sem depender de roundRect). */
function roundedRectPath(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

/* ------------------------------- chama ----------------------------------- */

/**
 * Cor de uma camada da chama para um dado throttle e propelente.
 * Baixo throttle → mais vermelho/laranja; alto → núcleo branco-azulado.
 * @param {string} spectrum chave de `FLAME_SPECTRA`
 * @param {number} throttle 0..1
 * @param {'core'|'mid'|'outer'|'fringe'|'glow'} layer
 */
export function flameColor(spectrum, throttle, layer = 'mid') {
  const spec = FLAME_SPECTRA[spectrum] ?? FLAME_SPECTRA.kerolox;
  const base = parseColor(spec[layer] ?? spec.mid);
  const t = clamp01(throttle);
  // A 0 % a chama é fria (vermelho-escuro); a 100 % tende ao branco.
  const hot = mixColor('#7a1b06', '#ffffff', Math.pow(t, 0.65));
  const mixAmount = layer === 'core' ? 0.55 : layer === 'mid' ? 0.38 : 0.22;
  return mixColor(base, hot, (1 - t) * 0.55 + mixAmount * 0.35 * (0.6 + t * 0.4));
}

/**
 * Desenha a pluma de exaustão procedural no espaço local (para baixo, +Y),
 * com flicker determinístico, expansão em vácuo e diamantes de choque.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {number} options.x           posição X da saída da tubeira
 * @param {number} options.y           posição Y da saída da tubeira
 * @param {number} options.scale       escala em px (comprimento unitário da nave)
 * @param {number} options.throttle    0..1
 * @param {number} [options.time=0]    relógio em segundos (flicker)
 * @param {string} [options.spectrum='kerolox']
 * @param {number} [options.ambient=1] pressão ambiente relativa (0 = vácuo)
 * @param {number} [options.length=1]  comprimento da pluma / comprimento da nave
 * @param {number} [options.width=0.5] largura da pluma / diâmetro da nave
 * @param {number} [options.seed=0]
 * @param {boolean} [options.additive=true]
 * @param {number} [options.alpha=1]
 */
export function drawExhaustPlume(ctx, options) {
  const throttle = clamp01(options.throttle ?? 0);
  if (throttle <= 0.001) return;
  const scale = options.scale ?? 100;
  const spectrum = options.spectrum ?? 'kerolox';
  const spec = FLAME_SPECTRA[spectrum] ?? FLAME_SPECTRA.kerolox;
  const ambient = clamp01(options.ambient ?? 1);
  const time = options.time ?? 0;
  const seed = options.seed ?? 0;
  const flickerAmount = options.flicker ?? 1;
  const alpha = clamp01(options.alpha ?? 1);

  // Vácuo expande a pluma (subexpansão): mais larga e longa.
  const expansion = lerp(1.85, 1, ambient);
  const length = (options.length ?? 0.6) * scale * throttle * expansion
    * (0.85 + 0.25 * throttle);
  const baseWidth = (options.width ?? 0.35) * scale * 0.5 * (0.55 + 0.6 * throttle);
  const width = baseWidth * lerp(1.35, 0.82, ambient);

  // Flicker determinístico (soma de ruídos 1D em frequências distintas).
  const f1 = noise1(time * 13.7 + seed, 1) * flickerAmount;
  const f2 = noise1(time * 27.3 + seed * 3.1, 2) * flickerAmount;
  const f3 = noise1(time * 51.9 + seed * 7.7, 3) * flickerAmount;
  const wobble = (f1 * 0.6 + f2 * 0.3 + f3 * 0.1);
  const len = length * (1 + wobble * 0.12);
  const w = width * (1 + wobble * 0.08);

  const prevComposite = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  if (options.additive !== false) ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = prevAlpha * alpha;

  const x = options.x ?? 0;
  const y = options.y ?? 0;

  // Halo externo (contido: não deve virar uma bola de luz).
  const glowR = Math.max(2, w * 1.5 + len * 0.1);
  const glow = ctx.createRadialGradient(x, y + glowR * 0.22, 0, x, y + glowR * 0.22, glowR);
  const glowCol = flameColor(spectrum, throttle, 'glow');
  glow.addColorStop(0, cssColor(glowCol, 0.42));
  glow.addColorStop(0.4, cssColor(glowCol, 0.16));
  glow.addColorStop(1, cssColor(glowCol, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(x, y + glowR * 0.18, glowR, glowR * 0.9, 0, 0, TAU);
  ctx.fill();

  // Corpo da pluma (3 camadas concêntricas).
  const plume = (widthScale, lengthScale, color, alphaScale) => {
    // Aceita objeto de cor ou string CSS; normaliza uma única vez.
    const col = parseColor(color);
    const fringe = parseColor(spec.fringe);
    const pw = w * widthScale;
    const pl = len * lengthScale;
    ctx.beginPath();
    ctx.moveTo(x - pw, y);
    ctx.bezierCurveTo(
      x - pw * 1.12, y + pl * 0.32,
      x - pw * 0.55, y + pl * 0.74,
      x + (f2 * pw * 0.12), y + pl,
    );
    ctx.bezierCurveTo(
      x + pw * 0.55, y + pl * 0.74,
      x + pw * 1.12, y + pl * 0.32,
      x + pw, y,
    );
    ctx.quadraticCurveTo(x, y - pw * 0.22, x - pw, y);
    ctx.closePath();
    const g = ctx.createLinearGradient(x, y, x, y + pl);
    g.addColorStop(0, cssColor(col, alphaScale));
    g.addColorStop(0.35, cssColor(col, alphaScale * 0.85));
    g.addColorStop(0.75, cssColor(mixColor(col, fringe, 0.6), alphaScale * 0.45));
    g.addColorStop(1, cssColor(fringe, 0));
    ctx.fillStyle = g;
    ctx.fill();
  };

  plume(1, 1, flameColor(spectrum, throttle, 'outer'), 0.75);
  plume(0.66, 0.78, flameColor(spectrum, throttle, 'mid'), 0.85);
  plume(0.34, 0.52, flameColor(spectrum, throttle, 'core'), 0.95);
  plume(0.16, 0.28, '#ffffff', 0.9);

  // Diamantes de choque (Mach) em atmosfera densa.
  if (ambient > 0.15 && throttle > 0.35) {
    const diamonds = 3;
    ctx.save();
    for (let i = 0; i < diamonds; i++) {
      const t = (i + 0.6) / (diamonds + 0.6);
      const dy = y + len * t * 0.55;
      const dw = w * (0.55 - t * 0.3) * (0.85 + f1 * 0.15);
      const dh = len * 0.045 * (0.8 + f3 * 0.4);
      ctx.beginPath();
      ctx.ellipse(x, dy, Math.max(1, dw), Math.max(1, dh), 0, 0, TAU);
      ctx.fillStyle = cssColor(flameColor(spectrum, throttle, 'core'), 0.4 * (1 - t * 0.5));
      ctx.fill();
    }
    ctx.restore();
  }

  // Fumaça/propelente sólido junto à tubeira.
  if (spec.smoke > 0.4 && ambient > 0.4) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const smokeAlpha = spec.smoke * 0.35 * (1 - ambient * 0.5);
    for (let i = 0; i < 3; i++) {
      const sy = y + len * (0.05 + i * 0.05);
      const sr = w * (1.3 + i * 0.5) * (1 + f3 * 0.1);
      const sg = ctx.createRadialGradient(x + (i - 1) * w * 0.4, sy, 0, x + (i - 1) * w * 0.4, sy, sr);
      sg.addColorStop(0, `rgba(215,215,220,${smokeAlpha})`);
      sg.addColorStop(1, 'rgba(160,160,170,0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(x + (i - 1) * w * 0.4, sy, sr, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.globalCompositeOperation = prevComposite;
  ctx.globalAlpha = prevAlpha;
}

/**
 * Cria uma folha de sprites de chama (frames × níveis de throttle) para
 * renderização via `drawImage` ou atlas WebGL.
 *
 * @param {object} [options]
 * @param {number} [options.frames=8]
 * @param {number[]} [options.levels=[0.2,0.45,0.7,1]]
 * @param {string} [options.spectrum='kerolox']
 * @param {number} [options.size=128] altura base de cada célula
 * @returns {{ cellW:number, cellH:number, frames:number, levels:number[],
 *   canvas:any, index:(throttle:number, frame:number)=>number,
 *   draw:(ctx:any, throttle:number, frame:number, x:number, y:number, scale:number)=>void }}
 */
export function createExhaustSpriteSheet(options = {}) {
  const frames = Math.max(2, options.frames ?? 8);
  const levels = options.levels ?? [0.2, 0.45, 0.7, 1];
  const spectrum = options.spectrum ?? 'kerolox';
  const size = Math.max(16, options.size ?? 128);
  const cellW = Math.round(size * 0.7);
  const cellH = Math.round(size * 1.9);
  const canvas = createCanvas(cellW * frames, cellH * levels.length);
  const ctx = get2D(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let l = 0; l < levels.length; l++) {
    for (let f = 0; f < frames; f++) {
      const cx = f * cellW + cellW / 2;
      const cy = l * cellH + size * 0.16;
      drawExhaustPlume(ctx, {
        x: cx,
        y: cy,
        scale: size * 1.15,
        throttle: levels[l],
        time: (f / frames) * 1.7,
        seed: l * 31 + f * 7,
        spectrum,
        ambient: 0.6,
        length: 0.95,
        width: 0.5,
        additive: true,
      });
    }
  }

  const index = (throttle, frame) => {
    const li = Math.min(levels.length - 1, Math.max(0,
      Math.round(clamp01(throttle) * (levels.length - 1))));
    return { li, fi: ((frame % frames) + frames) % frames };
  };

  return {
    canvas, cellW, cellH, frames, levels, spectrum,
    index,
    draw(ctx2, throttle, frame, x, y, scale = 1) {
      const { li, fi } = index(throttle, frame);
      const sx = fi * cellW;
      const sy = li * cellH;
      // Âncora: centro da tubeira (topo da célula).
      const w = cellW * scale;
      const h = cellH * scale;
      ctx2.drawImage(canvas, sx, sy, cellW, cellH, x - w / 2, y - size * 0.16 * scale, w, h);
    },
  };
}

/**
 * Cria o conjunto de sprites vetoriais de uma espaçonave em todas as fases.
 *
 * @param {object} [config] ver `SPACESHIP_DEFAULTS`
 * @param {number} [config.length=160] comprimento em px de autoria
 * @param {number} [config.boosters=0] 0, 2 ou 4 propulsores laterais
 * @param {string} [config.accent='#d9452b'] cor de destaque
 * @param {boolean} [config.fins=true] aletas
 * @param {boolean} [config.solarPanels=true] asas solares (fase satélite)
 * @param {number} [config.supersample=2] fator de antialiasing (downscale)
 * @param {number} [config.seed=7] semente do detalhamento
 * @param {string} [config.flame.spectrum='kerolox'] propelente
 * @param {string[]} [config.phases] subconjunto de fases a gerar
 * @returns {object} sprite com `.phases`, `.draw()`, `.flame`, `.dispose()`
 *
 * @example
 *   const nave = createSpaceshipSprite({ length: 220, boosters: 2, accent: '#ffb454' });
 *   nave.draw(ctx, { x: 400, y: 300, angle: -0.4, phase: 'stack', throttle: 0.9, time });
 *   // depois da separação:
 *   nave.draw(ctx, { x: 400, y: 300, angle: -0.4, phase: 'upper', throttle: 0.4 });
 */
export function createSpaceshipSprite(config = {}) {
  const cfg = resolveSpaceshipConfig(config);
  const L = cfg.length;
  const r = L * cfg.radiusRatio;
  const requested = Array.isArray(config.phases) && config.phases.length
    ? config.phases.filter((p) => SPACECRAFT_PHASES.includes(p))
    : SPACECRAFT_PHASES;
  const phases = {};

  // Largura suficiente para aletas, propulsores e painéis solares.
  const padX = r * (cfg.boosters > 0 ? 3.6 : 2.6);
  const padTop = r * 1.2;
  const padBottom = r * 3.2;

  for (const phase of requested) {
    const isWide = phase === 'satellite';
    const widthUnit = isWide ? L * 1.15 : r * 2 + padX * 2;
    const heightUnit = L + padTop + padBottom;
    const ss = cfg.supersample;
    const big = createCanvas(Math.ceil(widthUnit * ss), Math.ceil(heightUnit * ss));
    const bctx = get2D(big);
    bctx.save();
    bctx.scale(ss, ss);
    bctx.translate(widthUnit / 2, padTop);
    bctx.lineJoin = 'round';
    bctx.lineCap = 'round';
    const { nozzles, body } = paintSpacecraft(bctx, cfg, phase);
    bctx.restore();

    const canvas = resizeCanvas(big, Math.ceil(widthUnit), Math.ceil(heightUnit), true);
    phases[phase] = {
      phase,
      canvas,
      width: canvas.width,
      height: canvas.height,
      // Âncora = centro de massa aproximado (meio do corpo), em px do sprite.
      anchor: { x: widthUnit / 2, y: padTop + body.base * 0.52 },
      nozzles: nozzles.map((n) => ({
        ...n, x: n.x + widthUnit / 2, y: n.y + padTop,
      })),
      length: L,
      radius: r,
      body,
    };
  }

  const sprite = {
    config: cfg,
    phases,
    flame: cfg.flame,
    /** Desenha a nave com rotação/heading, seleção de fase e pluma. */
    draw(ctx, options = {}) {
      const phase = phases[options.phase] ? options.phase : (phases.stack ? 'stack' : Object.keys(phases)[0]);
      const s = phases[phase];
      if (!s) return;
      // `scale=1` desenha a 1 px por unidade de autoria; `length` define o
      // comprimento final em px (escala relativa ao comprimento autoral).
      const scale = options.length != null
        ? options.length / L
        : (options.scale ?? 1);
      const throttle = clamp01(options.throttle ?? 0);
      ctx.save();
      ctx.translate(options.x ?? 0, options.y ?? 0);
      ctx.rotate((options.angle ?? 0) + Math.PI / 2);
      if (options.alpha != null) ctx.globalAlpha *= clamp01(options.alpha);
      ctx.scale(scale, scale);
      if (options.hitFlash > 0) {
        ctx.globalAlpha *= 1 - clamp01(options.hitFlash) * 0.6;
      }
      // Pluma primeiro: fica atrás do casco e a tubeira cobre a origem.
      if (options.plume !== false && throttle > 0.001) {
        const ambient = clamp01(options.ambient ?? 0.5);
        for (const n of s.nozzles) {
          drawExhaustPlume(ctx, {
            x: n.x - s.anchor.x,
            y: n.y - s.anchor.y,
            scale: L,
            throttle: throttle * (n.scale ?? 1),
            time: options.time ?? 0,
            seed: (n.x * 0.11 + n.y * 0.07) + (cfg.seed % 97),
            spectrum: options.spectrum ?? cfg.flame.spectrum,
            ambient,
            length: cfg.flame.length * 0.42,
            // Largura proporcional à saída da tubeira, não ao diâmetro do corpo.
            width: cfg.flame.width * (n.width / (2 * cfg.length * cfg.radiusRatio)) * 0.45,
            flicker: cfg.flame.flicker,
            additive: options.additive !== false,
          });
        }
      }
      ctx.drawImage(s.canvas, -s.anchor.x, -s.anchor.y);
      ctx.restore();
    },
    /** Recupera a fase gerada (ou null). */
    getPhase(phase) {
      return phases[phase] ?? null;
    },
    /** Libera a memória dos canvases. */
    dispose() {
      for (const key of Object.keys(phases)) {
        const p = phases[key];
        p.canvas.width = 1;
        p.canvas.height = 1;
        delete phases[key];
      }
    },
  };
  return sprite;
}

/* ========================================================================== */
/*  5. Partículas — atlas, sistema e adaptador atmosférico                     */
/* ========================================================================== */

/**
 * Tipos de partícula pré-renderizados por `createParticleSprites`.
 * @type {ReadonlyArray<string>}
 */
export const PARTICLE_KINDS = Object.freeze([
  'fire', 'smoke', 'plasma', 'spark', 'dust', 'ice', 'debris', 'shock', 'glow',
]);

/** Configuração visual de cada tipo de partícula. */
const PARTICLE_STYLE = Object.freeze({
  fire: { additive: true, frames: 8, radius: 0.92, growth: 0.85, tint: 'thermal' },
  smoke: { additive: false, frames: 8, radius: 1, growth: 1.25, tint: 'smoke' },
  plasma: { additive: true, frames: 6, radius: 0.92, growth: 0.4, tint: 'plasma', stretch: 1 },
  spark: { additive: true, frames: 4, radius: 0.6, growth: 0.1, tint: 'thermal' },
  dust: { additive: false, frames: 6, radius: 0.95, growth: 1.1, tint: 'dust' },
  ice: { additive: false, frames: 4, radius: 0.6, growth: 0.15, tint: 'ice' },
  debris: { additive: false, frames: 4, radius: 0.6, growth: 0.05, tint: 'debris' },
  shock: { additive: true, frames: 6, radius: 1, growth: 1.8, tint: 'shock' },
  glow: { additive: true, frames: 1, radius: 1, growth: 0, tint: 'glow' },
});

/** @private Constrói um buffer RGBA de "puff" turbulento. */
function renderPuff(size, kind, frame, frames, seed) {
  const style = PARTICLE_STYLE[kind];
  const noise = new Noise(seed);
  const buf = new Uint8ClampedArray(size * size * 4);
  const t = frames > 1 ? frame / (frames - 1) : 0;
  const radius = style.radius * (0.62 + t * 0.38);
  const stretch = style.stretch ?? 1;
  const alphaScale = style.tint === 'smoke' || style.tint === 'dust'
    ? lerp(0.9, 0.35, t)
    : lerp(1, 0.45, t);

  const c0 = { r: 0, g: 0, b: 0 };
  const c1 = { r: 0, g: 0, b: 0 };
  if (style.tint === 'thermal') {
    const hot = mixColor('#fff6d8', '#ffb03a', t * 0.7);
    const cool = mixColor('#ff6a1a', '#8c1c04', t);
    c0.r = hot.r; c0.g = hot.g; c0.b = hot.b;
    c1.r = cool.r; c1.g = cool.g; c1.b = cool.b;
  } else if (style.tint === 'smoke') {
    const light = 190 - t * 30;
    c0.r = light; c0.g = light + 2; c0.b = light + 6;
    c1.r = 70; c1.g = 72; c1.b = 78;
  } else if (style.tint === 'plasma') {
    c0.r = 235; c0.g = 246; c0.b = 255;
    c1.r = 105; c1.g = 90; c1.b = 255;
  } else if (style.tint === 'dust') {
    const v = 160 - t * 40;
    c0.r = v; c0.g = v * 0.82; c0.b = v * 0.6;
    c1.r = 90; c1.g = 68; c1.b = 44;
  } else {
    c0.r = 240; c0.g = 245; c0.b = 255;
    c1.r = 120; c1.g = 160; c1.b = 220;
  }

  const inv = 2 / size;
  for (let y = 0; y < size; y++) {
    const ny = (y + 0.5) * inv - 1;
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) * inv - 1) / stretch;
      const r = Math.hypot(nx, ny);
      if (r > radius * 1.15) continue;
      // Deformação orgânica da borda.
      const wob = noise.fbm3(nx * 2.6 + seed * 0.13, ny * 2.6 - seed * 0.07, frame * 0.55,
        { octaves: 4, lacunarity: 2.1, gain: 0.55 });
      const edge = radius * (1 + wob * 0.32);
      let density = 1 - smoothstep(edge * 0.42, edge, r);
      density = Math.pow(clamp01(density), 0.9);
      // Turbulência interna (nuvens de fumaça).
      const internal = 0.62 + 0.38 * (0.5 + 0.5 * noise.fbm3(
        nx * 5.5 + frame * 0.9, ny * 5.5, frame * 0.7 + seed * 0.3,
        { octaves: 3, lacunarity: 2.2, gain: 0.5 },
      ));
      let alpha = density * internal * alphaScale;
      if (style.tint === 'smoke' || style.tint === 'dust') alpha *= smoothstep(1.0, 0.55, r);
      if (alpha <= 0.004) continue;

      // Gradiente de cor: quente no centro, frio na borda.
      const k = Math.pow(clamp01(r / Math.max(edge, 1e-3)), 0.75);
      let cr = lerp(c0.r, c1.r, k);
      let cg = lerp(c0.g, c1.g, k);
      let cb = lerp(c0.b, c1.b, k);
      // Fogo e plasma têm núcleo incandescente (branco) — sem ele o sprite
      // fica com aspecto de "bolha laranja" em vez de chama.
      if (style.tint === 'thermal' || style.tint === 'plasma') {
        const core = Math.pow(1 - clamp01(r / Math.max(edge * 0.72, 1e-3)), 2.2);
        cr = lerp(cr, 255, core * 0.9);
        cg = lerp(cg, style.tint === 'plasma' ? 250 : 246, core * 0.9);
        cb = lerp(cb, style.tint === 'plasma' ? 255 : 214, core * 0.9);
        alpha *= 0.55 + core * 0.65;
      }

      // Sombreado direcional para fumaça/poeira (luz do alto-esquerda).
      if (style.tint === 'smoke' || style.tint === 'dust') {
        const shadeK = clamp01(0.45 + nx * 0.4 + ny * 0.4);
        cr *= 0.55 + shadeK * 0.75;
        cg *= 0.55 + shadeK * 0.75;
        cb *= 0.55 + shadeK * 0.75;
        // Densidade interna visível (grumos da nuvem).
        alpha *= 0.55 + internal * 0.6;
      }

      const o = (y * size + x) * 4;
      buf[o] = cr;
      buf[o + 1] = cg;
      buf[o + 2] = cb;
      buf[o + 3] = alpha * 255;
    }
  }
  return bufferToCanvas(buf, size, size);
}

/** @private Desenha sprites vetoriais auxiliares (faísca, gelo, detrito, anel). */
function renderVectorParticle(size, kind, frame, frames, rng) {
  const canvas = createCanvas(size, size);
  const ctx = get2D(canvas);
  const c = size / 2;
  const t = frames > 1 ? frame / (frames - 1) : 0;
  ctx.translate(c, c);

  if (kind === 'spark') {
    const len = size * 0.42 * (1 - t * 0.35);
    ctx.globalCompositeOperation = 'lighter';
    for (const [angle, weight] of [[0, 1], [Math.PI / 2, 0.55], [Math.PI / 4, 0.35], [-Math.PI / 4, 0.35]]) {
      ctx.save();
      ctx.rotate(angle);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, `rgba(255,255,240,${0.95 - t * 0.4})`);
      g.addColorStop(0.5, `rgba(255,196,84,${0.5 - t * 0.28})`);
      g.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.035 * weight);
      ctx.lineTo(len * weight, 0);
      ctx.lineTo(0, size * 0.035 * weight);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.16);
    core.addColorStop(0, `rgba(255,255,255,${1 - t * 0.5})`);
    core.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.16, 0, TAU);
    ctx.fill();
  } else if (kind === 'ice') {
    const shards = 5;
    for (let i = 0; i < shards; i++) {
      const a = (i / shards) * TAU + rng() * 0.6;
      const len = size * (0.18 + rng() * 0.22) * (1 - t * 0.2);
      const w = size * 0.035 * (1 + rng() * 0.5);
      ctx.save();
      ctx.rotate(a);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, `rgba(235,248,255,${0.9 - t * 0.5})`);
      g.addColorStop(1, 'rgba(150,200,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -w);
      ctx.lineTo(len, 0);
      ctx.lineTo(0, w);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  } else if (kind === 'debris') {
    const sides = 5 + Math.floor(rng() * 3);
    const rad = size * (0.16 + rng() * 0.1);
    ctx.rotate(rng() * TAU + t * 1.2);
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU;
      const rr = rad * (0.65 + rng() * 0.5);
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(-rad, -rad, rad, rad);
    g.addColorStop(0, `rgba(150,152,158,${0.95 - t * 0.3})`);
    g.addColorStop(0.5, `rgba(96,100,108,${0.95 - t * 0.3})`);
    g.addColorStop(1, `rgba(48,52,60,${0.95 - t * 0.3})`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,22,26,0.7)';
    ctx.lineWidth = Math.max(0.5, size * 0.01);
    ctx.stroke();
  } else if (kind === 'shock') {
    const radius = size * (0.16 + t * 0.34);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, radius * 0.55, 0, 0, radius);
    g.addColorStop(0, 'rgba(180,220,255,0)');
    g.addColorStop(0.65, `rgba(190,225,255,${0.5 * (1 - t)})`);
    g.addColorStop(1, 'rgba(120,180,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fill();
  } else if (kind === 'glow') {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(200,235,255,0.75)');
    g.addColorStop(0.6, 'rgba(120,180,255,0.22)');
    g.addColorStop(1, 'rgba(80,140,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.5, 0, TAU);
    ctx.fill();
  }
  return canvas;
}

/**
 * Gera o atlas de partículas: fogo, fumaça, plasma, faísca, poeira, gelo,
 * detritos, anel de choque e brilho — múltiplos quadros de evolução cada.
 *
 * @param {object} [options]
 * @param {number} [options.size=64] tamanho base de cada sprite
 * @param {number} [options.frames=8] quadros para os tipos "puff"
 * @param {number} [options.seed=99]
 * @param {string[]} [options.kinds] subconjunto de `PARTICLE_KINDS`
 * @returns {object} atlas com `get`, `draw`, `frames`, `dispose`
 *
 * @example
 *   const atlas = createParticleSprites({ size: 48 });
 *   atlas.draw(ctx, 'smoke', x, y, { size: 40, alpha: 0.6, frame: 3 });
 *   atlas.draw(ctx, 'fire', x, y, { size: 28, additive: true });
 */
export function createParticleSprites(options = {}) {
  const size = clamp(Math.round(options.size ?? 64), 8, 512);
  const frames = clamp(Math.round(options.frames ?? 8), 1, 32);
  const seed = options.seed ?? 99;
  const kinds = Array.isArray(options.kinds) && options.kinds.length
    ? options.kinds.filter((k) => PARTICLE_KINDS.includes(k))
    : [...PARTICLE_KINDS];
  const atlas = { size, frames: {}, kinds: {}, additive: {}, disposed: false };

  for (const kind of kinds) {
    const style = PARTICLE_STYLE[kind];
    const nFrames = style.frames ? Math.max(1, Math.round(style.frames * (frames / 8))) : frames;
    const rng = createRNG(hashString(kind) ^ seed);
    const list = [];
    for (let f = 0; f < nFrames; f++) {
      if (kind === 'spark' || kind === 'ice' || kind === 'debris' || kind === 'shock' || kind === 'glow') {
        list.push(renderVectorParticle(size, kind, f, nFrames, rng));
      } else {
        list.push(renderPuff(size, kind, f, nFrames, (seed + hashString(kind) % 1000) >>> 0));
      }
    }
    atlas.kinds[kind] = list;
    atlas.frames[kind] = nFrames;
    atlas.additive[kind] = style.additive;
  }

  atlas.get = (kind, frame = 0) => {
    const list = atlas.kinds[kind] ?? atlas.kinds.glow;
    if (!list) return null;
    const idx = ((Math.round(frame) % list.length) + list.length) % list.length;
    return list[idx];
  };

  atlas.draw = (ctx, kind, x, y, opts = {}) => {
    const canvas = atlas.get(kind, opts.frame ?? 0);
    if (!canvas) return;
    const s = opts.size ?? size;
    const alpha = clamp01(opts.alpha ?? 1);
    if (alpha <= 0.002) return;
    const rotation = opts.rotation ?? 0;
    const additive = opts.additive ?? atlas.additive[kind];
    const prev = ctx.globalCompositeOperation;
    const prevAlpha = ctx.globalAlpha;
    if (additive) ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = prevAlpha * alpha;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    const squashX = opts.squashX ?? 1;
    const squashY = opts.squashY ?? 1;
    ctx.drawImage(canvas, (-s * squashX) / 2, (-s * squashY) / 2, s * squashX, s * squashY);
    ctx.restore();
    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prev;
  };

  atlas.dispose = () => {
    for (const kind of Object.keys(atlas.kinds)) {
      for (const c of atlas.kinds[kind]) { c.width = 1; c.height = 1; }
      delete atlas.kinds[kind];
    }
    atlas.disposed = true;
  };

  return atlas;
}

/* --------------------------- câmera e projeção ---------------------------- */

/**
 * Projeta um ponto do mundo (metros) na tela usando uma câmera simples.
 * A câmera aceita `{ x, y, scale }` + `{ width, height }` ou `{ cx, cy }`.
 *
 * @param {object} camera `{ x, y, scale, width?, height?, cx?, cy? }`
 * @param {number} wx metros
 * @param {number} wy metros
 * @returns {{x:number, y:number}}
 */
export function projectPoint(camera, wx, wy) {
  const scale = camera?.scale ?? 1;
  const cx = camera?.cx ?? (camera?.width ?? 0) / 2;
  const cy = camera?.cy ?? (camera?.height ?? 0) / 2;
  return {
    x: (wx - (camera?.x ?? 0)) * scale + cx,
    y: (wy - (camera?.y ?? 0)) * scale + cy,
  };
}

/** Inverso de `projectPoint` — tela → mundo (metros). */
export function unprojectPoint(camera, sx, sy) {
  const scale = camera?.scale ?? 1;
  const cx = camera?.cx ?? (camera?.width ?? 0) / 2;
  const cy = camera?.cy ?? (camera?.height ?? 0) / 2;
  return {
    x: (sx - cx) / scale + (camera?.x ?? 0),
    y: (sy - cy) / scale + (camera?.y ?? 0),
  };
}

/* --------------------------- sistema de partículas ------------------------ */

/**
 * Sistema de partículas com pooling, arrasto exponencial, empuxo e
 * resfriamento. Determinístico quando o RNG recebe seed.
 *
 * @example
 *   const ps = new ParticleSystem({ atlas, maxParticles: 1500 });
 *   ps.emit({ x, y, vx: 40, vy: -12, kind: 'smoke', life: 1.6, size: 26 });
 *   ps.emitExplosion(x, y, { count: 80, power: 220 });
 *   ps.update(dt);
 *   ps.draw(ctx, { camera });
 */
export class ParticleSystem {
  /**
   * @param {object} options
   * @param {object} [options.atlas] saída de `createParticleSprites`
   * @param {number} [options.maxParticles=2000]
   * @param {number} [options.seed=12345]
   * @param {{x:number,y:number}} [options.wind] vento em m/s
   * @param {number} [options.drag=0.6] 1/s
   * @param {number} [options.buoyancy=0] m/s² (positivo = sobe)
   * @param {number} [options.gravity=0] m/s² (positivo = desce)
   */
  constructor(options = {}) {
    this.atlas = options.atlas ?? createParticleSprites();
    this.maxParticles = Math.max(16, options.maxParticles ?? 2000);
    this.wind = { x: options.wind?.x ?? 0, y: options.wind?.y ?? 0 };
    this.drag = options.drag ?? 0.6;
    this.buoyancy = options.buoyancy ?? 0;
    this.gravity = options.gravity ?? 0;
    this.rng = createRNG(options.seed ?? 12345);
    this.pool = [];
    this.active = [];
    this.time = 0;
    this.emitters = new Map();
  }

  get count() { return this.active.length; }

  /** @private Obtém uma partícula do pool. */
  _acquire() {
    if (this.active.length >= this.maxParticles) {
      // Recicla a mais antiga (menor vida restante).
      let oldest = 0;
      for (let i = 1; i < this.active.length; i++) {
        if (this.active[i].life < this.active[oldest].life) oldest = i;
      }
      return this.active[oldest];
    }
    const p = this.pool.pop() ?? {};
    this.active.push(p);
    return p;
  }

  /**
   * Emite uma partícula.
   * @param {object} p
   * @param {number} p.x
   * @param {number} p.y
   * @param {number} [p.vx=0]
   * @param {number} [p.vy=0]
   * @param {string} [p.kind='fire']
   * @param {number} [p.life=1] segundos
   * @param {number} [p.size=20]
   * @param {number} [p.growth=0] px/s
   * @param {number} [p.alpha=1]
   * @param {number} [p.drag] sobrescreve o arrasto global
   * @param {number} [p.buoyancy]
   * @param {number} [p.rotation=0]
   * @param {number} [p.spin=0]
   * @param {number} [p.squashX=1]
   * @param {number} [p.squashY=1]
   */
  emit(p) {
    const particle = this._acquire();
    const life = Math.max(0.01, p.life ?? 1);
    particle.x = p.x ?? 0;
    particle.y = p.y ?? 0;
    particle.vx = p.vx ?? 0;
    particle.vy = p.vy ?? 0;
    particle.kind = p.kind ?? 'fire';
    particle.life = life;
    particle.maxLife = life;
    particle.size = Math.max(0.5, p.size ?? 20);
    particle.baseSize = particle.size;
    particle.growth = p.growth ?? 0;
    particle.alpha = clamp01(p.alpha ?? 1);
    particle.drag = p.drag ?? this.drag;
    particle.buoyancy = p.buoyancy ?? this.buoyancy;
    particle.rotation = p.rotation ?? this.rng() * TAU;
    particle.spin = p.spin ?? 0;
    particle.squashX = p.squashX ?? 1;
    particle.squashY = p.squashY ?? 1;
    particle.fadeIn = p.fadeIn ?? 0.06;
    particle.dead = false;
    return particle;
  }

  /** Emite uma explosão radial. */
  emitExplosion(x, y, options = {}) {
    const count = Math.max(1, options.count ?? 60);
    const power = options.power ?? 200;
    const kinds = options.kinds ?? ['fire', 'smoke', 'spark'];
    for (let i = 0; i < count; i++) {
      const a = this.rng() * TAU;
      const speed = power * (0.3 + Math.pow(this.rng(), 0.6));
      const kind = kinds[Math.floor(this.rng() * kinds.length)];
      this.emit({
        x, y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        kind,
        life: 0.5 + this.rng() * 1.4,
        size: (options.size ?? 16) * (0.5 + this.rng()),
        growth: kind === 'smoke' ? 26 : 4,
        buoyancy: kind === 'smoke' ? 30 : 0,
        drag: kind === 'smoke' ? 1.4 : 0.8,
      });
    }
    if (options.shock !== false) {
      this.emit({ x, y, kind: 'shock', life: 0.45, size: (options.size ?? 16) * 2.4, growth: 220, alpha: 0.8 });
    }
  }

  /**
   * Emite continuamente a partir de um emissor (ex.: tubeira).
   * @param {string} id identificador do emissor
   * @param {object} source `{ x, y, vx?, vy?, angle?, spread? }` (m/s, rad)
   * @param {object} options `{ rate, kind, speed, life, size, growth, dt, ... }`
   */
  emitFrom(id, source, options = {}) {
    const dt = Math.max(0, options.dt ?? 1 / 60);
    const rate = Math.max(0, options.rate ?? 60);
    const state = this.emitters.get(id) ?? { acc: 0 };
    state.acc += rate * dt;
    let count = Math.min(Math.floor(state.acc), options.maxPerFrame ?? 32);
    state.acc = Math.min(state.acc - count, 8);
    while (count-- > 0) {
      const spread = options.spread ?? 0.35;
      const angle = (source.angle ?? 0) + (this.rng() - 0.5) * spread;
      const speed = (options.speed ?? 80) * (0.6 + this.rng() * 0.8);
      this.emit({
        x: source.x + (this.rng() - 0.5) * (options.jitter ?? 2),
        y: source.y + (this.rng() - 0.5) * (options.jitter ?? 2),
        vx: (source.vx ?? 0) + Math.cos(angle) * speed,
        vy: (source.vy ?? 0) + Math.sin(angle) * speed,
        kind: options.kind ?? 'fire',
        life: (options.life ?? 0.6) * (0.7 + this.rng() * 0.6),
        size: (options.size ?? 12) * (0.6 + this.rng() * 0.8),
        growth: options.growth ?? 8,
        drag: options.drag ?? 0.9,
        buoyancy: options.buoyancy ?? 0,
        emitter: id,
      });
    }
    this.emitters.set(id, state);
  }

  /** Integra todas as partículas ativas. */
  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    const list = this.active;
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) { p.dead = true; this.pool.push(p); continue; }
      const damp = Math.exp(-p.drag * dt);
      p.vx = p.vx * damp + this.wind.x * (1 - damp);
      p.vy = p.vy * damp + this.wind.y * (1 - damp) + (this.gravity - p.buoyancy) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.growth * dt;
      p.rotation += p.spin * dt;
      list[write++] = p;
    }
    list.length = write;
  }

  /**
   * Desenha todas as partículas, opcionalmente projetando pela câmera.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ camera?:object, scale?:number, alpha?:number }} [options]
   */
  draw(ctx, options = {}) {
    const camera = options.camera;
    const globalScale = options.scale ?? 1;
    const globalAlpha = clamp01(options.alpha ?? 1);
    for (let i = 0; i < this.active.length; i++) {
      const p = this.active[i];
      const t = 1 - p.life / p.maxLife;
      const frames = this.atlas.frames[p.kind] ?? 1;
      const frame = Math.min(frames - 1, Math.floor(t * frames));
      // fade-in rápido + fade-out suave
      const fadeIn = p.fadeIn > 0 ? clamp01(t / p.fadeIn) : 1;
      const fadeOut = 1 - smoothCurve(clamp01((t - 0.55) / 0.45));
      const alpha = p.alpha * fadeIn * fadeOut * globalAlpha;
      if (alpha <= 0.003) continue;
      const pos = camera ? projectPoint(camera, p.x, p.y) : { x: p.x, y: p.y };
      const scale = camera ? (camera.scale ?? 1) : 1;
      this.atlas.draw(ctx, p.kind, pos.x, pos.y, {
        size: Math.max(1, p.size * scale * globalScale),
        alpha,
        frame,
        rotation: p.rotation,
        squashX: p.squashX,
        squashY: p.squashY,
      });
    }
  }

  /** Remove todas as partículas. */
  clear() {
    for (const p of this.active) this.pool.push(p);
    this.active.length = 0;
    this.emitters.clear();
  }
}

/* -------------------- integração com atmosphere.js ------------------------ */

/** @private Rampa de brilho térmico pré-renderizada (evita gradientes por quadro). */
function createThermalRamp(size = 32, steps = 16) {
  const list = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const temp = lerp(900, 6200, t);
    const rgb = blackbodyRGB(temp);
    const canvas = createCanvas(size, size);
    const ctx = get2D(canvas);
    const c = size / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, `rgba(255,255,255,${0.35 + t * 0.6})`);
    g.addColorStop(0.25, rgba(rgb.r, rgb.g, rgb.b, 0.7 + t * 0.3));
    g.addColorStop(0.55, rgba(rgb.r, rgb.g, rgb.b, 0.32));
    g.addColorStop(1, rgba(rgb.r, rgb.g, rgb.b, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c, c, c, 0, TAU);
    ctx.fill();
    list.push(canvas);
  }
  return list;
}

const _thermalRamps = new Map();

/** @private Obtém (e cacheia) a rampa térmica. */
function thermalRampSprites(steps = 16, size = 32) {
  const key = `${steps}:${size}`;
  if (!_thermalRamps.has(key)) _thermalRamps.set(key, createThermalRamp(size, steps));
  return _thermalRamps.get(key);
}

/**
 * Desenha as partículas térmicas de `atmosphere.js` (plasma de reentrada)
 * com brilho aditivo e cor de corpo negro. Aceita diretamente
 * `atmo.getTelemetry(sc).particles` não — use `atmo.particles` ou
 * `sc.thermal.particles`.
 *
 * As partículas do módulo atmosférico expõem `{ x, y, size, life, maxLife,
 * intensity, r, g, b, kind }`, com coordenadas em metros no mundo.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<object>} particles lista `atmo.particles`
 * @param {{ camera?:object, scale?:number, alpha?:number, minScale?:number }} [options]
 * @returns {number} quantidade desenhada
 *
 * @example
 *   drawThermalParticles(ctx, atmo.particles, { camera });
 */
export function drawThermalParticles(ctx, particles, options = {}) {
  if (!Array.isArray(particles) || particles.length === 0) return 0;
  const ramp = thermalRampSprites(16, 32);
  const camera = options.camera ?? null;
  const globalAlpha = clamp01(options.alpha ?? 1);
  const prev = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'lighter';
  let drawn = 0;
  for (const p of particles) {
    if (!p) continue;
    const lifeRatio = p.maxLife > 0 ? clamp01(p.life / p.maxLife) : 1;
    const alpha = clamp01(p.intensity ?? 0.8) * lifeRatio * globalAlpha;
    if (alpha <= 0.004) continue;
    const pos = camera ? projectPoint(camera, p.x, p.y) : { x: p.x, y: p.y };
    const camScale = camera?.scale ?? 1;
    const sizePx = Math.max(options.minSize ?? 2.5,
      (p.size ?? 0.2) * camScale * (options.scale ?? 1));
    // Índice da rampa: combina intensidade com a temperatura implícita em r/g/b.
    const warmth = clamp01(((p.r ?? 255) / 255) * 0.6 + ((p.b ?? 0) / 255) * 0.4);
    const idx = Math.min(ramp.length - 1, Math.max(0, Math.round(clamp01(1 - warmth) * (ramp.length - 1))));
    ctx.globalAlpha = prevAlpha * alpha;
    ctx.drawImage(ramp[idx], pos.x - sizePx / 2, pos.y - sizePx / 2, sizePx, sizePx);
    drawn++;
  }
  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prev;
  return drawn;
}

/**
 * Desenha as partículas térmicas convertendo posições relativas a uma nave
 * (útil quando a câmera segue a espaçonave e as partículas estão no mundo).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} spacecraft nave
 * @param {object} camera
 * @param {object} [options]
 */
export function drawSpacecraftPlasma(ctx, spacecraft, camera, options = {}) {
  const list = spacecraft?.thermal?.particles;
  if (!Array.isArray(list)) return 0;
  return drawThermalParticles(ctx, list, { ...options, camera });
}

/**
 * Desenha o brilho de aquecimento da pele da nave (reentrada), usando a
 * temperatura de `atmosphere.js` e a posição projetada pela câmera.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} spacecraft `sc` com `thermal`/`aeroState`
 * @param {object} camera
 * @param {{ radius?:number, scale?:number, time?:number }} [options]
 * @returns {number} intensidade aplicada (0..1)
 */
export function drawReentryGlow(ctx, spacecraft, camera, options = {}) {
  const thermal = spacecraft?.thermal;
  const aero = spacecraft?.aeroState;
  const temperature = thermal?.temperature ?? aero?.hullTemperature ?? 0;
  if (!(temperature > 750)) return 0;
  const rgb = blackbodyRGB(temperature);
  const intensity = clamp01((temperature - 750) / 1700);
  const pos = camera
    ? projectPoint(camera, spacecraft.x, spacecraft.y)
    : { x: spacecraft.x, y: spacecraft.y };
  const radius = Math.max(4, (options.radius ?? 14) * intensity * (options.scale ?? 1));
  const t = options.time ?? 0;
  const flicker = 1 + noise1(t * 9.1, 5) * 0.12;
  const prev = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius * 2.6 * flicker);
  g.addColorStop(0, rgba(255, 255, 240, intensity * 0.7));
  g.addColorStop(0.25, rgba(rgb.r, rgb.g, rgb.b, intensity * 0.55));
  g.addColorStop(0.6, rgba(rgb.r * 0.8, rgb.g * 0.5, rgb.b * 0.3, intensity * 0.22));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, radius * 2.6 * flicker, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prev;
  return intensity;
}

/* ========================================================================== */
/*  6. HUD — instrumentos de telemetria                                       */
/* ========================================================================== */

/** Estilo padrão do HUD (sobrescrevível por instância). */
export const HUD_STYLE = Object.freeze({
  font: '600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSmall: '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontLabel: '700 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontValue: '700 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontBig: '700 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  accent: '#5fd4ff',
  accentSoft: 'rgba(95,212,255,0.32)',
  accentFaint: 'rgba(95,212,255,0.12)',
  text: '#e3f4ff',
  textDim: 'rgba(227,244,255,0.55)',
  panel: 'rgba(5,13,21,0.74)',
  panelEdge: 'rgba(95,212,255,0.34)',
  grid: 'rgba(95,212,255,0.16)',
  ok: '#5ce08a',
  warn: '#ffb454',
  danger: '#ff5a5f',
  shadow: 'rgba(0,0,0,0.6)',
  chamfer: 8,
  padding: 10,
  compassLabels: 'pt',
});

/** @private Define a fonte com tolerância a parsers restritos. */
function setFont(ctx, font) {
  try { ctx.font = font; } catch { ctx.font = '12px monospace'; }
}

/* ------------------------------ formatação -------------------------------- */

/** @private Formata número com separador de milhar e vírgula decimal (pt-BR). */
export function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  const neg = value < 0;
  const abs = Math.abs(value);
  const fixed = abs.toFixed(Math.max(0, digits));
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '−' : ''}${grouped}${decPart ? `,${decPart}` : ''}`;
}

/**
 * Formata grandeza com prefixo SI (k, M, G, m).
 * @param {number} value
 * @param {string} unit
 * @param {{digits?:number, space?:boolean}} [options]
 */
export function formatSI(value, unit = '', options = {}) {
  if (!Number.isFinite(value)) return `—${unit ? ` ${unit}` : ''}`;
  const abs = Math.abs(value);
  const digits = options.digits ?? (abs < 10 ? 2 : abs < 100 ? 1 : 0);
  const prefixes = [
    { limit: 1e9, factor: 1e9, symbol: 'G' },
    { limit: 1e6, factor: 1e6, symbol: 'M' },
    { limit: 1e3, factor: 1e3, symbol: 'k' },
    { limit: 1, factor: 1, symbol: '' },
  ];
  const p = prefixes.find((x) => abs >= x.limit) ?? prefixes[prefixes.length - 1];
  const text = formatNumber(value / p.factor, digits);
  if (!unit) return `${text}${p.symbol}`.trim();
  // O prefixo pertence à unidade: "7,65 km/s" e não "7,65k m/s".
  return `${text}${options.space === false ? '' : ' '}${p.symbol}${unit}`.trim();
}

/** Altitude em metros → texto legível ("412,3 km", "−1,2 Mm"). */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  return formatSI(meters, 'm', { digits: 1 });
}

/** Velocidade em m/s → texto legível ("7,66 km/s"). */
export function formatSpeed(metersPerSecond) {
  if (!Number.isFinite(metersPerSecond)) return '—';
  return formatSI(metersPerSecond, 'm/s', { digits: 2 });
}

/** Massa em kg → texto legível ("1.240 kg", "12,4 t"). */
export function formatMass(kg) {
  if (!Number.isFinite(kg)) return '—';
  if (Math.abs(kg) >= 1000) return `${formatNumber(kg / 1000, 2)} t`;
  return `${formatNumber(kg, 0)} kg`;
}

/** Tempo em segundos → "3d 04:12:33" / "04:12" / "12,4 s". */
export function formatTime(seconds, options = {}) {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '−' : '';
  let t = Math.abs(seconds);
  const days = Math.floor(t / 86400);
  t -= days * 86400;
  const hours = Math.floor(t / 3600);
  t -= hours * 3600;
  const minutes = Math.floor(t / 60);
  const secs = t - minutes * 60;
  const pad = (v) => String(Math.floor(v)).padStart(2, '0');
  if (options.clock) {
    const hh = days * 24 + hours;
    return `${sign}${pad(hh)}:${pad(minutes)}:${pad(secs)}`;
  }
  if (days > 0) return `${sign}${days}d ${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  if (hours > 0) return `${sign}${hours}h ${pad(minutes)}m ${pad(secs)}s`;
  if (minutes > 0) return `${sign}${minutes}m ${pad(secs)}s`;
  return `${sign}${formatNumber(secs, 1)} s`;
}

/** Ângulo em radianos → "312,4°". */
export function formatAngle(radians, digits = 1) {
  if (!Number.isFinite(radians)) return '—';
  return `${formatNumber(mod((radians * 180) / Math.PI, 360), digits)}°`;
}

/** Fração 0..1 → "62,4 %". */
export function formatPercent(fraction, digits = 1) {
  if (!Number.isFinite(fraction)) return '—';
  return `${formatNumber(clamp01(fraction) * 100, digits)} %`;
}

/** Ângulo matemático (rad, 0 = +X) → rumo de bússola em graus (0 = norte). */
export function compassFromAngle(radians) {
  return mod(90 - (radians * 180) / Math.PI, 360);
}

/** Rumo de bússola → ângulo matemático em radianos. */
export function angleFromCompass(degrees) {
  return ((90 - degrees) * Math.PI) / 180;
}

/** Nome cardinal em português para um rumo em graus. */
export function cardinalName(degrees) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'L', 'ESE', 'SE', 'SSE',
    'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  return dirs[Math.round(mod(degrees, 360) / 22.5) % 16];
}

/* ---------------------------- primitivas de HUD --------------------------- */

/** @private Painel com cantos chanfrados e brilho de borda. */
export function drawHUDPanel(ctx, x, y, width, height, style = HUD_STYLE, options = {}) {
  const c = Math.min(style.chamfer ?? 8, Math.min(width, height) / 3);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + width - c, y);
  ctx.lineTo(x + width, y + c);
  ctx.lineTo(x + width, y + height - c);
  ctx.lineTo(x + width - c, y + height);
  ctx.lineTo(x + c, y + height);
  ctx.lineTo(x, y + height - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
  ctx.fillStyle = options.panel ?? style.panel;
  ctx.fill();
  ctx.lineWidth = options.lineWidth ?? 1;
  ctx.strokeStyle = options.edge ?? style.panelEdge;
  ctx.stroke();
  // Cantos realçados.
  if (options.brackets !== false) {
    ctx.strokeStyle = style.accent;
    ctx.lineWidth = Math.max(1, (options.lineWidth ?? 1) * 1.6);
    const b = Math.min(c * 1.25, width * 0.2, height * 0.3);
    ctx.beginPath();
    ctx.moveTo(x + c, y + b * 0.2); ctx.lineTo(x + c, y + 0.5); ctx.lineTo(x + c + b, y + 0.5);
    ctx.moveTo(x + width - c - b, y + 0.5); ctx.lineTo(x + width - c, y + 0.5); ctx.lineTo(x + width - c, y + b * 0.2);
    ctx.stroke();
  }
  ctx.restore();
}

/** @private Rótulo em caixa alta com tracking leve. */
function drawLabel(ctx, text, x, y, style, options = {}) {
  ctx.save();
  setFont(ctx, options.font ?? style.fontLabel);
  ctx.fillStyle = options.color ?? style.textDim;
  ctx.textAlign = options.align ?? 'left';
  ctx.textBaseline = options.baseline ?? 'top';
  ctx.fillText(String(text).toUpperCase(), x, y);
  ctx.restore();
}

/**
 * Desenha um valor numérico grande com a unidade em corpo menor ao lado.
 * Primitiva do HUD, útil para painéis personalizados.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string|number} value
 * @param {string} [unit]
 * @param {number} x
 * @param {number} y linha de base do texto
 * @param {object} [style] tipicamente `HUD_STYLE` (ou derivado)
 * @param {{ font?:string, color?:string, unitColor?:string, align?:'left'|'center'|'right', baseline?:CanvasTextBaseline }} [options]
 */
export function drawHUDValue(ctx, value, unit, x, y, style, options = {}) {
  ctx.save();
  setFont(ctx, options.font ?? style.fontValue);
  ctx.fillStyle = options.color ?? style.text;
  ctx.textAlign = options.align ?? 'left';
  ctx.textBaseline = options.baseline ?? 'alphabetic';
  const text = String(value);
  ctx.fillText(text, x, y);
  if (unit) {
    const width = ctx.measureText(text).width;
    setFont(ctx, style.fontSmall);
    ctx.fillStyle = options.unitColor ?? style.textDim;
    const ux = options.align === 'right' ? x - width - 3
      : options.align === 'center' ? x + width / 2 + 3 : x + width + 3;
    ctx.textAlign = 'left';
    ctx.fillText(unit, ux, y - 1);
  }
  ctx.restore();
}

/* ------------------------------- bússola ---------------------------------- */

const _compassRoses = new Map();

/**
 * Pré-renderiza a rosa dos ventos (ticks + cardinais) uma única vez por
 * raio/estilo. Cada quadro só precisa rotacionar a imagem — evita ~60 traços
 * de caminho por frame em canvas 2D.
 * @private
 */
function compassRose(radius, style) {
  const px = Math.max(8, Math.round(radius));
  const key = [px, style.accent, style.accentSoft, style.grid, style.textDim,
    style.compassLabels, style.fontLabel].join('|');
  const cached = _compassRoses.get(key);
  if (cached) return cached;

  const size = px * 2 + 4;
  const canvas = createCanvas(size, size);
  const ctx = get2D(canvas);
  ctx.translate(size / 2, size / 2);
  ctx.lineCap = 'butt';
  const labels = (style.compassLabels ?? 'pt') === 'pt' ? ['N', 'L', 'S', 'O'] : ['N', 'E', 'S', 'W'];

  for (let i = 0; i < 72; i++) {
    const deg = i * 5;
    const rel = (deg * Math.PI) / 180;
    const major = i % 6 === 0;
    const medium = i % 2 === 0;
    const len = major ? px * 0.16 : medium ? px * 0.1 : px * 0.06;
    const r0 = px * 0.86;
    const sx = Math.sin(rel);
    const cy = -Math.cos(rel);
    ctx.beginPath();
    ctx.moveTo(sx * r0, cy * r0);
    ctx.lineTo(sx * (r0 - len), cy * (r0 - len));
    ctx.strokeStyle = major ? style.accent : medium ? style.accentSoft : style.grid;
    ctx.lineWidth = major ? 1.6 : 1;
    ctx.stroke();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  setFont(ctx, style.fontLabel);
  for (let i = 0; i < 4; i++) {
    const rel = (i * 90 * Math.PI) / 180;
    const rr = px * 0.62;
    ctx.fillStyle = i === 0 ? style.accent : style.textDim;
    ctx.fillText(labels[i], Math.sin(rel) * rr, -Math.cos(rel) * rr);
  }

  const rose = { canvas, size, px };
  if (_compassRoses.size > 16) _compassRoses.clear();
  _compassRoses.set(key, rose);
  return rose;
}

/**
 * Desenha a bússola de heading (rumo) com rosa dos ventos, ticks, marca de
 * proa e leitura digital.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {number} options.x
 * @param {number} options.y
 * @param {number} [options.radius=52]
 * @param {number} [options.heading] rumo em graus (0 = norte, horário)
 * @param {number} [options.angle]  alternativa: ângulo matemático em radianos
 * @param {number} [options.track]  rumo do vetor velocidade (graus), opcional
 * @param {object} [options.style]
 */
export function drawHeadingCompass(ctx, options) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const radius = Math.max(18, options.radius ?? 52);
  const heading = options.angle != null && options.heading == null
    ? compassFromAngle(options.angle)
    : mod(options.heading ?? 0, 360);
  const track = options.track;

  ctx.save();
  ctx.translate(x, y);

  // Disco.
  const disc = ctx.createRadialGradient(0, -radius * 0.3, radius * 0.1, 0, 0, radius);
  disc.addColorStop(0, 'rgba(10,26,38,0.86)');
  disc.addColorStop(1, 'rgba(4,10,16,0.92)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, TAU);
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = style.panelEdge;
  ctx.stroke();

  // Rosa dos ventos pré-renderizada, rotacionada pelo heading.
  const rose = compassRose(radius, style);
  ctx.save();
  ctx.rotate(-heading * DEG);
  ctx.drawImage(rose.canvas, -rose.size / 2, -rose.size / 2, rose.size, rose.size);
  ctx.restore();

  // Marca de proa (triângulo fixo no topo).
  ctx.beginPath();
  ctx.moveTo(0, -radius * 0.94);
  ctx.lineTo(-radius * 0.09, -radius * 0.74);
  ctx.lineTo(radius * 0.09, -radius * 0.74);
  ctx.closePath();
  ctx.fillStyle = style.accent;
  ctx.fill();

  // Marca de rumo do vetor velocidade (bug).
  if (Number.isFinite(track)) {
    const rel = (track - heading) * DEG;
    const rr = radius * 0.8;
    ctx.save();
    ctx.translate(Math.sin(rel) * rr, -Math.cos(rel) * rr);
    ctx.rotate(rel);
    ctx.beginPath();
    ctx.moveTo(0, -radius * 0.07);
    ctx.lineTo(radius * 0.07, radius * 0.05);
    ctx.lineTo(-radius * 0.07, radius * 0.05);
    ctx.closePath();
    ctx.fillStyle = style.warn;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.restore();
  }

  // Leitura central.
  const text = `${formatNumber(heading, 1)}°`;
  setFont(ctx, radius > 40 ? style.fontValue : style.fontSmall);
  ctx.fillStyle = style.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, radius * 0.16);
  setFont(ctx, style.fontLabel);
  ctx.fillStyle = style.textDim;
  ctx.fillText(cardinalName(heading), 0, radius * 0.42);

  ctx.restore();
}

/* ------------------------- marcos de apogeu/perigeu ----------------------- */

/**
 * Calcula as posições dos ápsides (apogeu e perigeu) a partir do vetor de
 * excentricidade — válido para qualquer órbita kepleriana (inclusive
 * hiperbólica, onde só existe o perigeu).
 *
 * @param {object} spacecraft corpo com `{ x, y, vx, vy, mass? }`
 * @param {object} primary corpo central com `{ x, y, vx, vy, mass, radius }`
 * @param {{ G?:number, mu?:number }} [options]
 * @returns {?object} ápsides em coordenadas de mundo (metros)
 *
 * @example
 *   const ap = computeApsisMarkers(nave, terra);
 *   ap.periapsis;          // { x, y }
 *   ap.periapsisAltitude;  // metros acima da superfície
 */
export function computeApsisMarkers(spacecraft, primary, options = {}) {
  if (!spacecraft || !primary) return null;
  const G = options.G ?? 6.67430e-11;
  const mu = options.mu ?? G * ((primary.mass ?? 0) + (spacecraft.mass ?? 0));
  if (!(mu > 0)) return null;
  const rx = spacecraft.x - primary.x;
  const ry = spacecraft.y - primary.y;
  const vx = (spacecraft.vx ?? 0) - (primary.vx ?? 0);
  const vy = (spacecraft.vy ?? 0) - (primary.vy ?? 0);
  const r = Math.hypot(rx, ry);
  if (!(r > 0)) return null;
  const v2 = vx * vx + vy * vy;
  const rv = rx * vx + ry * vy;
  const h = rx * vy - ry * vx;               // momento angular específico
  const energy = v2 / 2 - mu / r;
  const bound = energy < 0;
  const a = bound ? -mu / (2 * energy) : -mu / (2 * energy);

  // Vetor de excentricidade: e = ((v² − μ/r)·r − (r·v)·v) / μ
  const ex = ((v2 - mu / r) * rx - rv * vx) / mu;
  const ey = ((v2 - mu / r) * ry - rv * vy) / mu;
  const e = Math.hypot(ex, ey);

  const p = (h * h) / mu;                    // semi-latus rectum
  const rPeri = p / (1 + e);
  const rApo = e < 1 ? p / (1 - e) : Infinity;
  const dirX = e > 1e-12 ? ex / e : rx / r;
  const dirY = e > 1e-12 ? ey / e : ry / r;

  const periapsis = {
    x: primary.x + dirX * rPeri,
    y: primary.y + dirY * rPeri,
  };
  const apoapsis = Number.isFinite(rApo)
    ? { x: primary.x - dirX * rApo, y: primary.y - dirY * rApo }
    : null;

  const radius = primary.radius ?? 0;
  return {
    mu,
    eccentricity: e,
    semiMajorAxis: a,
    bound,
    circular: e < 1e-4,
    periapsis,
    apoapsis,
    periapsisRadius: rPeri,
    apoapsisRadius: rApo,
    periapsisAltitude: rPeri - radius,
    apoapsisAltitude: Number.isFinite(rApo) ? rApo - radius : Infinity,
    currentRadius: r,
    argument: Math.atan2(dirY, dirX),        // direção do perigeu (rad)
  };
}

/** @private Glifo de ápside (apogeu = triângulo oco para cima). */
function drawApsisGlyph(ctx, kind, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  const s = size;
  if (kind === 'apoapsis') {
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.85, s * 0.6);
    ctx.lineTo(-s * 0.85, s * 0.6);
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, s * 0.15);
    ctx.lineTo(0, s * 2.1);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(0, s);
    ctx.lineTo(s * 0.85, -s * 0.6);
    ctx.lineTo(-s * 0.85, -s * 0.6);
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.15);
    ctx.lineTo(0, -s * 2.1);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Desenha os marcos de apogeu e perigeu sobre a cena, com rótulo e linha
 * guia. Marcos fora da tela são indicados na borda com uma seta.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {object} options.apsides saída de `computeApsisMarkers`
 * @param {object} options.camera   `{ x, y, scale, width, height }`
 * @param {object} [options.style]
 * @param {boolean} [options.labels=true]
 * @param {number} [options.size=9]
 * @returns {{apoapsis:?{x:number,y:number}, periapsis:?{x:number,y:number}}}
 */
export function drawApsisMarkers(ctx, options) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const apsides = options.apsides;
  const camera = options.camera;
  if (!apsides || !camera) return { apoapsis: null, periapsis: null };
  const width = camera.width ?? ctx.canvas?.width ?? 0;
  const height = camera.height ?? ctx.canvas?.height ?? 0;
  const markerSize = options.size ?? 9;
  const out = { apoapsis: null, periapsis: null };

  const drawOne = (kind, worldPoint, altitude, color, label) => {
    if (!worldPoint) return;
    const pos = projectPoint(camera, worldPoint.x, worldPoint.y);
    const inside = pos.x >= 6 && pos.x <= width - 6 && pos.y >= 6 && pos.y <= height - 6;
    out[kind] = pos;

    if (!inside) {
      // Indicador de borda: seta apontando para o ápside fora de quadro.
      const cx = width / 2;
      const cy = height / 2;
      const dx = pos.x - cx;
      const dy = pos.y - cy;
      const margin = 18;
      const scaleX = dx !== 0 ? (width / 2 - margin) / Math.abs(dx) : Infinity;
      const scaleY = dy !== 0 ? (height / 2 - margin) / Math.abs(dy) : Infinity;
      const k = Math.min(scaleX, scaleY, 1);
      const ex = cx + dx * k;
      const ey = cy + dy * k;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-5, 5);
      ctx.lineTo(-5, -5);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.restore();
      ctx.save();
      setFont(ctx, style.fontSmall);
      ctx.fillStyle = color;
      ctx.textAlign = ex > cx ? 'right' : 'left';
      ctx.textBaseline = ey > cy ? 'top' : 'bottom';
      const lx = ex > cx ? ex - 9 : ex + 9;
      const ly = ey > cy ? ey + 6 : ey - 6;
      ctx.globalAlpha = 0.85;
      ctx.fillText(`${label} ${formatDistance(altitude)}`, lx, ly);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(pos.x, pos.y);
    // Halo suave.
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, markerSize * 3.2);
    halo.addColorStop(0, cssColor(parseColor(color), 0.28));
    halo.addColorStop(1, cssColor(parseColor(color), 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, markerSize * 3.2, 0, TAU);
    ctx.fill();
    drawApsisGlyph(ctx, kind, markerSize, color);
    if (options.labels !== false) {
      setFont(ctx, style.fontSmall);
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const text = `${label}  ${formatDistance(altitude)}`;
      const tw = ctx.measureText(text).width;
      const bx = markerSize * 1.6;
      ctx.globalAlpha = 0.9;
      ctx.fillText(text, bx, 0);
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(markerSize * 1.1, 0);
      ctx.lineTo(bx - 4, 0);
      ctx.stroke();
    }
    ctx.restore();
  };

  drawOne('apoapsis', apsides.apoapsis, apsides.apoapsisAltitude, style.warn, 'APOGEU');
  drawOne('periapsis', apsides.periapsis, apsides.periapsisAltitude, style.accent, 'PERIGEU');
  return out;
}

/* -------------------------------- medidores ------------------------------- */

/**
 * Medidor de arco genérico (base de velocidade, G, empuxo…).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {number} options.x
 * @param {number} options.y
 * @param {number} [options.radius=48]
 * @param {number} [options.thickness=6]
 * @param {number} [options.value]
 * @param {number} [options.min=0]
 * @param {number} [options.max=1]
 * @param {number} [options.startAngle=Math.PI*0.75]
 * @param {number} [options.sweep=Math.PI*1.5]
 * @param {string} [options.color]
 * @param {string} [options.label]
 * @param {string} [options.valueText]
 * @param {string} [options.unit]
 * @param {Array<{value:number,color?:string,label?:string}>} [options.markers]
 * @param {number} [options.ticks=10]
 * @param {object} [options.style]
 */
export function drawArcGauge(ctx, options) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const radius = Math.max(12, options.radius ?? 48);
  const thickness = Math.max(2, options.thickness ?? 6);
  const start = options.startAngle ?? Math.PI * 0.75;
  const sweep = options.sweep ?? Math.PI * 1.5;
  const min = options.min ?? 0;
  const max = options.max ?? 1;
  const value = options.value ?? min;
  const t = clamp01(invLerp(min, max, value));
  const color = options.color ?? style.accent;

  ctx.save();
  ctx.translate(x, y);
  ctx.lineCap = 'round';

  // Trilha.
  ctx.beginPath();
  ctx.arc(0, 0, radius, start, start + sweep, false);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = thickness;
  ctx.stroke();

  // Ticks.
  const ticks = Math.max(0, options.ticks ?? 10);
  for (let i = 0; i <= ticks; i++) {
    const a = start + (sweep * i) / ticks;
    const r0 = radius + thickness * 0.9;
    const r1 = r0 + (i % 5 === 0 ? radius * 0.09 : radius * 0.045);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.strokeStyle = i % 5 === 0 ? style.accentSoft : style.grid;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Arco de valor com gradiente de alerta.
  if (t > 0.001) {
    const g = ctx.createLinearGradient(-radius, -radius, radius, radius);
    g.addColorStop(0, color);
    g.addColorStop(1, options.colorEnd ?? color);
    ctx.beginPath();
    ctx.arc(0, 0, radius, start, start + sweep * t, false);
    ctx.strokeStyle = g;
    ctx.lineWidth = thickness;
    ctx.stroke();
    // Agulha na ponta.
    const a = start + sweep * t;
    const nx = Math.cos(a) * radius;
    const ny = Math.sin(a) * radius;
    ctx.beginPath();
    ctx.arc(nx, ny, thickness * 0.62, 0, TAU);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Marcadores externos (velocidade circular, escapatória, limites…).
  if (Array.isArray(options.markers)) {
    for (const m of options.markers) {
      const mt = clamp01(invLerp(min, max, m.value));
      const a = start + sweep * mt;
      const r0 = radius - thickness * 1.4;
      const r1 = radius + thickness * 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.strokeStyle = m.color ?? style.warn;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      if (m.label) {
        // Rótulo dentro do arco (evita sair do canvas quando o medidor está
        // encostado na borda da tela).
        setFont(ctx, style.fontLabel);
        ctx.fillStyle = m.color ?? style.warn;
        const rr = radius - thickness * 2.6;
        ctx.textAlign = Math.cos(a) >= 0 ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = 0.9;
        ctx.fillText(m.label, Math.cos(a) * rr, Math.sin(a) * rr + radius * 0.05);
        ctx.globalAlpha = 1;
      }
    }
  }

  // Leitura central (rótulo acima, valor no meio, unidade abaixo).
  if (options.label) {
    drawLabel(ctx, options.label, 0, -radius * 0.42, style, { align: 'center' });
  }
  if (options.valueText != null) {
    setFont(ctx, radius > 44 ? style.fontValue : style.fontSmall);
    ctx.fillStyle = options.textColor ?? style.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(options.valueText), 0, -radius * 0.02);
  }
  if (options.unit) {
    setFont(ctx, style.fontLabel);
    ctx.fillStyle = style.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(options.unit, 0, radius * 0.26);
  }
  ctx.restore();
}

/**
 * Indicador de velocidade orbital: arco até a velocidade de escape com
 * marcadores de velocidade circular e leitura principal.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options `{ x, y, radius, speed, circularVelocity, escapeVelocity, style }`
 */
export function drawSpeedGauge(ctx, options) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const speed = options.speed ?? 0;
  const escape = Math.max(1, options.escapeVelocity ?? speed * 1.2);
  const circular = options.circularVelocity ?? escape / Math.SQRT2;
  const ratio = speed / escape;
  const color = ratio >= 1 ? style.danger : ratio > 0.92 ? style.warn : style.accent;
  return drawArcGauge(ctx, {
    x: options.x,
    y: options.y,
    radius: options.radius ?? 52,
    thickness: options.thickness ?? 5,
    value: speed,
    min: 0,
    max: escape * 1.06,
    color,
    colorEnd: ratio >= 1 ? style.warn : style.accentSoft,
    label: options.label ?? 'VELOCIDADE',
    valueText: formatNumber(speed / 1000, speed < 10000 ? 2 : 1),
    unit: 'km/s',
    ticks: 10,
    style,
    markers: [
      { value: circular, color: style.accentSoft, label: 'CIRC' },
      { value: escape, color: style.danger, label: 'ESC' },
    ],
  });
}

/**
 * Indicador de força G com pico retido (peak-hold) e limites de alerta.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options `{ x, y, radius, value, peak, limit, style }`
 */
export function drawGForceGauge(ctx, options) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const value = Math.max(0, options.value ?? 0);
  const peak = Math.max(value, options.peak ?? value);
  const limit = options.limit ?? 7;
  const max = Math.max(limit * 1.35, peak * 1.1, 3);
  const color = value >= limit ? style.danger : value >= limit * 0.6 ? style.warn : style.ok;
  return drawArcGauge(ctx, {
    x: options.x,
    y: options.y,
    radius: options.radius ?? 44,
    thickness: options.thickness ?? 5,
    value,
    max,
    color,
    label: options.label ?? 'FORÇA G',
    valueText: formatNumber(value, 2),
    unit: 'g',
    ticks: 8,
    style,
    markers: [
      { value: limit, color: style.danger, label: 'LIM' },
      ...(peak > value + 0.05 ? [{ value: peak, color: style.warn, label: '' }] : []),
    ],
  });
}

/* --------------------------- barras e fitas ------------------------------- */

/**
 * Barra de combustível segmentada com leitura de massa, porcentagem e delta-v.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {number} options.x
 * @param {number} options.y
 * @param {number} [options.width=220]
 * @param {number} [options.height=16]
 * @param {number} [options.fuel] kg restantes
 * @param {number} [options.capacity] kg iniciais
 * @param {number} [options.deltaV] m/s restantes
 * @param {number} [options.throttle] 0..1 (para realce)
 * @param {object} [options.style]
 * @returns {{fraction:number, low:boolean}}
 */
export function drawFuelBar(ctx, options) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const width = Math.max(40, options.width ?? 220);
  const height = Math.max(6, options.height ?? 16);
  const capacity = Math.max(1e-6, options.capacity ?? options.fuel ?? 1);
  const fuel = clamp(options.fuel ?? 0, 0, capacity);
  const fraction = fuel / capacity;
  const low = fraction <= 0.15;
  const pulse = low ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((options.time ?? 0) * 6)) : 1;

  ctx.save();
  // Moldura.
  drawHUDPanel(ctx, x - 6, y - 20, width + 12, height + 54, style, { brackets: false });
  drawLabel(ctx, options.label ?? 'COMBUSTÍVEL', x, y - 14, style);

  // Trilha.
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x, y, width, height);

  // Preenchimento com gradiente por estado.
  if (fraction > 0.001) {
    const g = ctx.createLinearGradient(x, 0, x + width, 0);
    if (low) {
      g.addColorStop(0, style.danger);
      g.addColorStop(1, '#ff8a5f');
    } else if (fraction < 0.35) {
      g.addColorStop(0, style.warn);
      g.addColorStop(1, '#ffd07a');
    } else {
      g.addColorStop(0, '#2fa36b');
      g.addColorStop(1, style.ok);
    }
    ctx.globalAlpha = pulse;
    ctx.fillStyle = g;
    ctx.fillRect(x, y, width * fraction, height);
    ctx.globalAlpha = 1;
    // Brilho superior.
    const gloss = ctx.createLinearGradient(0, y, 0, y + height);
    gloss.addColorStop(0, 'rgba(255,255,255,0.30)');
    gloss.addColorStop(0.5, 'rgba(255,255,255,0.04)');
    gloss.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = gloss;
    ctx.fillRect(x, y, width * fraction, height);
  }

  // Divisórias de segmento (10%).
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const sx = Math.round(x + (width * i) / 10) + 0.5;
    ctx.beginPath();
    ctx.moveTo(sx, y);
    ctx.lineTo(sx, y + height);
    ctx.stroke();
  }
  ctx.strokeStyle = style.panelEdge;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

  // Leituras.
  ctx.textBaseline = 'top';
  setFont(ctx, style.fontSmall);
  ctx.fillStyle = style.text;
  ctx.textAlign = 'left';
  ctx.fillText(`${formatMass(fuel)}`, x, y + height + 4);
  ctx.fillStyle = low ? style.danger : style.textDim;
  ctx.textAlign = 'right';
  ctx.fillText(`${formatPercent(fraction)}`, x + width, y + height + 4);

  if (Number.isFinite(options.deltaV) || (options.throttle > 0.01)) {
    setFont(ctx, style.fontLabel);
    ctx.fillStyle = style.accent;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (Number.isFinite(options.deltaV)) ctx.fillText(`Δv ${formatSpeed(options.deltaV)}`, x, y + height + 17);
    if (Number.isFinite(options.throttle) && options.throttle > 0.01) {
      ctx.fillStyle = style.accentSoft;
      ctx.textAlign = 'right';
      ctx.fillText(`EMPUXO ${Math.round(options.throttle * 100)} %`, x + width, y + height + 17);
    }
  }
  ctx.restore();
  return { fraction, low };
}

/**
 * Fita vertical de altitude com escalas, marcadores de apogeu/perigeu e
 * leitura digital.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {number} options.x
 * @param {number} options.y
 * @param {number} [options.height=180]
 * @param {number} [options.width=64]
 * @param {number} [options.altitude] m
 * @param {number} [options.span=4] fator de zoom da fita (altitudes por altura)
 * @param {number} [options.apoapsisAltitude]
 * @param {number} [options.periapsisAltitude]
 */
export function drawAltitudeTape(ctx, options) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const height = Math.max(80, options.height ?? 190);
  const width = Math.max(62, options.width ?? 78);
  const altitude = options.altitude ?? 0;
  const apo = options.apoapsisAltitude;
  const peri = options.periapsisAltitude;

  // Enquadramento automático: mantém a nave no centro e as apsides visíveis.
  let span = options.span;
  if (!(span > 0)) {
    const reach = Math.max(
      Math.abs(Number.isFinite(apo) ? apo - altitude : 0),
      Math.abs(Number.isFinite(peri) ? peri - altitude : 0),
      Math.abs(altitude) * 0.02,
      30e3,
    );
    span = reach * 1.35;
  }
  const topAlt = altitude + span;
  const bottomAlt = altitude - span;
  const headerH = 40;

  ctx.save();
  drawHUDPanel(ctx, x, y, width, height, style, { brackets: false });

  // Cabeçalho: rótulo + leitura digital (dentro do painel).
  drawLabel(ctx, 'ALTITUDE', x + 8, y + 7, style);
  setFont(ctx, style.fontValue);
  ctx.fillStyle = style.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(formatNumber(altitude / 1000, 1), x + 8, y + 19);
  setFont(ctx, style.fontSmall);
  ctx.fillStyle = style.textDim;
  const vw = ctx.measureText('000,0').width;
  ctx.fillText('km', x + 10 + vw, y + 25);

  // Área da fita.
  const tapeY = y + headerH;
  const tapeH = height - headerH - 2;
  ctx.beginPath();
  ctx.rect(x + 1, tapeY, width - 2, tapeH);
  ctx.clip();

  const toY = (alt) => tapeY + tapeH * (1 - clamp01(invLerp(bottomAlt, topAlt, alt)));

  // Grade em "números redondos" (passo 1/2/5 × 10ⁿ).
  const rawStep = (topAlt - bottomAlt) / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, rawStep))));
  const norm = rawStep / mag;
  // Passos "redondos": 1, 2, 2,5, 5 ou 10 × 10ⁿ.
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;

  ctx.strokeStyle = style.grid;
  ctx.lineWidth = 1;
  setFont(ctx, style.fontLabel);
  ctx.textBaseline = 'middle';
  const firstTick = Math.ceil(bottomAlt / step) * step;
  for (let alt = firstTick; alt <= topAlt; alt += step) {
    const ty = toY(alt);
    if (ty < tapeY + 6 || ty > tapeY + tapeH - 6) continue;
    ctx.beginPath();
    ctx.moveTo(x + width - 7, ty);
    ctx.lineTo(x + width - 1, ty);
    ctx.stroke();
    ctx.fillStyle = style.textDim;
    ctx.textAlign = 'right';
    // Escala sempre legível em km (evita "1 M m").
    ctx.fillText(`${formatNumber(alt / 1000, 0)} km`, x + width - 10, ty);
  }

  // Marcos de apogeu/perigeu.
  const mark = (alt, color, label) => {
    if (!Number.isFinite(alt)) return;
    const clamped = clamp(alt, bottomAlt, topAlt);
    // Mantém a etiqueta dentro da área visível da fita.
    const ty = clamp(toY(clamped), tapeY + 12, tapeY + tapeH - 2);
    const outside = alt > topAlt || alt < bottomAlt;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.setLineDash(outside ? [2, 3] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 2, ty);
    ctx.lineTo(x + width - 2, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    setFont(ctx, style.fontLabel);
    const text = outside ? `${label}${alt > topAlt ? '↑' : '↓'}` : label;
    const tw = ctx.measureText(text).width + 6;
    ctx.fillStyle = 'rgba(4,10,16,0.88)';
    ctx.fillRect(x + 2, ty - 12, tw, 11);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, ty - 6.5);
  };
  mark(peri, style.accent, 'PER');
  mark(apo, style.warn, 'APO');

  // Marcador central (altitude atual).
  const cy = tapeY + tapeH / 2;
  ctx.beginPath();
  ctx.moveTo(x + 2, cy);
  ctx.lineTo(x + 12, cy - 5);
  ctx.lineTo(x + 12, cy + 5);
  ctx.closePath();
  ctx.fillStyle = style.accent;
  ctx.fill();
  ctx.strokeStyle = style.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 12, cy);
  ctx.lineTo(x + width - 1, cy);
  ctx.stroke();
  ctx.restore();
  return { x, y, width, height, span, top: topAlt, bottom: bottomAlt };
}

/**
 * Barra de throttle/empuxo com leitura em newtons.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options `{ x, y, width, height, throttle, thrust, style }`
 */
export function drawThrottleBar(ctx, options) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const width = Math.max(60, options.width ?? 160);
  const height = Math.max(5, options.height ?? 8);
  const throttle = clamp01(options.throttle ?? 0);
  ctx.save();
  drawLabel(ctx, 'EMPUXO', x, y - 12, style);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x, y, width, height);
  if (throttle > 0.001) {
    const g = ctx.createLinearGradient(x, 0, x + width, 0);
    g.addColorStop(0, style.accentSoft);
    g.addColorStop(1, style.accent);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, width * throttle, height);
  }
  ctx.strokeStyle = style.panelEdge;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  setFont(ctx, style.fontSmall);
  ctx.fillStyle = style.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.round(throttle * 100)} %`, x + width, y + height + 3);
  if (Number.isFinite(options.thrust)) {
    ctx.textAlign = 'left';
    ctx.fillStyle = style.textDim;
    ctx.fillText(formatSI(options.thrust, 'N', { digits: 2 }), x, y + height + 3);
  }
  ctx.restore();
}

/* ------------------------------ painéis ---------------------------------- */

/** @private Linha "rótulo: valor" de um painel. */
function drawStatRow(ctx, x, y, width, label, value, style, options = {}) {
  drawLabel(ctx, label, x, y, style, { baseline: 'middle' });
  setFont(ctx, options.font ?? style.fontSmall);
  ctx.fillStyle = options.color ?? style.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(value), x + width, y);
}

/**
 * Painel de elementos orbitais (apogeu, perigeu, excentricidade, período,
 * velocidades) a partir da telemetria de `physics.js`.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} telemetry saída de `engine.getTelemetry(sc)`
 * @param {object} options `{ x, y, width, apogee, perigee, style }`
 */
export function drawOrbitPanel(ctx, telemetry, options = {}) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const width = Math.max(150, options.width ?? 230);
  // `physics.js` devolve apogeu/perigeu como DISTÂNCIA ao foco; altitude =
  // distância − raio do corpo central. O raio é deduzido da telemetria
  // (distance − altitude) quando `primaryRadius` não é informado.
  const primaryRadius = options.primaryRadius
    ?? options.primary?.radius
    ?? (Number.isFinite(telemetry?.distance) && Number.isFinite(telemetry?.altitude)
      ? telemetry.distance - telemetry.altitude : 0);
  const toAltitude = (r) => (Number.isFinite(r) ? r - primaryRadius : NaN);
  const apoAlt = options.apoapsisAltitude ?? toAltitude(telemetry?.apogee ?? options.apogee);
  const periAlt = options.periapsisAltitude ?? toAltitude(telemetry?.perigee ?? options.perigee);
  const rows = [
    ['APOGEU', formatDistance(apoAlt)],
    ['PERIGEU', formatDistance(periAlt)],
    ['EXCENTR.', Number.isFinite(telemetry?.eccentricity) ? formatNumber(telemetry.eccentricity, 4) : '—'],
    ['PERÍODO', formatTime(telemetry?.period)],
    ['V. ORBITAL', formatSpeed(telemetry?.orbitalVelocity)],
    ['V. CIRCULAR', formatSpeed(telemetry?.circularVelocity)],
    ['V. ESCAPE', formatSpeed(telemetry?.escapeVelocity)],
  ];
  const rowH = 17;
  const height = 30 + rows.length * rowH + 6;
  drawHUDPanel(ctx, x, y, width, height, style);
  drawLabel(ctx, options.title ?? 'ÓRBITA', x + 10, y + 9, style, { color: style.accent });
  setFont(ctx, style.fontLabel);
  ctx.fillStyle = style.textDim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  if (telemetry?.referenceBody) {
    ctx.fillText(String(telemetry.referenceBody).toUpperCase(), x + width - 10, y + 9);
  }
  let ry = y + 30;
  for (const [label, value] of rows) {
    drawStatRow(ctx, x + 10, ry, width - 20, label, value, style);
    ry += rowH;
  }
  return { x, y, width, height };
}

/**
 * Tira de status com alertas (combustível, calor, reentrada, destruição).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} alerts `[{ label, level:'info'|'warn'|'danger' }]`
 * @param {{ x:number, y:number, style?:object }} options
 */
export function drawStatusStrip(ctx, alerts, options = {}) {
  const style = { ...HUD_STYLE, ...(options.style ?? {}) };
  const list = (alerts ?? []).filter(Boolean).slice(0, 4);
  if (!list.length) return { width: 0, height: 0 };
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  setFont(ctx, style.fontLabel);
  let width = 0;
  for (const a of list) width = Math.max(width, ctx.measureText(a.label).width + 26);
  const rowH = 20;
  const height = list.length * rowH;
  drawHUDPanel(ctx, x, y, width, height, style, { brackets: false });
  list.forEach((a, i) => {
    const color = a.level === 'danger' ? style.danger : a.level === 'warn' ? style.warn : style.accent;
    const cy = y + rowH * (i + 0.5);
    ctx.beginPath();
    ctx.arc(x + 11, cy, 3, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
    setFont(ctx, style.fontLabel);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(a.label.toUpperCase(), x + 20, cy);
  });
  return { width, height };
}

/* ------------------------------- glifos ---------------------------------- */

/**
 * Gera glifos de HUD como canvases independentes (para atlas WebGL ou
 * `drawImage` rápido). Cada glifo é desenhado com traço vetorial.
 *
 * @param {{size?:number, color?:string}} [options]
 * @returns {Object<string, any>} mapa nome → canvas
 */
export function createHUDGlyphs(options = {}) {
  const size = clamp(options.size ?? 24, 8, 128);
  const color = options.color ?? HUD_STYLE.accent;
  const glyphs = {};
  const make = (name, draw) => {
    const canvas = createCanvas(size, size);
    const ctx = get2D(canvas);
    ctx.translate(size / 2, size / 2);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    draw(ctx, size);
    glyphs[name] = canvas;
  };
  const s = size * 0.3;

  make('apogee', (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0, -s); ctx.lineTo(s * 0.8, s * 0.5); ctx.lineTo(-s * 0.8, s * 0.5); ctx.closePath();
    ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, s * 0.1); ctx.lineTo(0, s * 1.6); ctx.stroke();
  });
  make('perigee', (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0, s); ctx.lineTo(s * 0.8, -s * 0.5); ctx.lineTo(-s * 0.8, -s * 0.5); ctx.closePath();
    ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -s * 0.1); ctx.lineTo(0, -s * 1.6); ctx.stroke();
  });
  make('fuel', (ctx) => {
    ctx.strokeRect(-s * 0.55, -s, s * 1.1, s * 2);
    ctx.beginPath();
    ctx.moveTo(-s * 0.55, s * 0.35); ctx.lineTo(s * 0.55, s * 0.35);
    ctx.stroke();
    ctx.globalAlpha = 0.35; ctx.fillRect(-s * 0.55, s * 0.35, s * 1.1, s * 0.65); ctx.globalAlpha = 1;
  });
  make('gmeter', (ctx) => {
    ctx.beginPath(); ctx.arc(0, 0, s, Math.PI * 0.8, Math.PI * 2.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, s * 0.16, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s * 0.75, -s * 0.45); ctx.stroke();
  });
  make('speed', (ctx) => {
    ctx.beginPath(); ctx.arc(0, 0, s, Math.PI * 0.8, Math.PI * 2.2); ctx.stroke();
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI * 0.8 + (Math.PI * 1.4 * i) / 6;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * s * 0.78, Math.sin(a) * s * 0.78);
      ctx.lineTo(Math.cos(a) * s * 0.95, Math.sin(a) * s * 0.95);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s * 0.5, -s * 0.5); ctx.stroke();
  });
  make('warning', (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.1); ctx.lineTo(s * 1.1, s * 0.85); ctx.lineTo(-s * 1.1, s * 0.85); ctx.closePath();
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -s * 0.35); ctx.lineTo(0, s * 0.25); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, s * 0.55, Math.max(1, size * 0.045), 0, TAU); ctx.fill();
  });
  make('rocket', (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.2);
    ctx.bezierCurveTo(s * 0.55, -s * 0.5, s * 0.5, s * 0.3, s * 0.4, s * 0.7);
    ctx.lineTo(-s * 0.4, s * 0.7);
    ctx.bezierCurveTo(-s * 0.5, s * 0.3, -s * 0.55, -s * 0.5, 0, -s * 1.2);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -s * 0.25, Math.max(1, s * 0.16), 0, TAU); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-s * 0.4, s * 0.45); ctx.lineTo(-s * 0.85, s * 1.0); ctx.lineTo(-s * 0.4, s * 0.9); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.4, s * 0.45); ctx.lineTo(s * 0.85, s * 1.0); ctx.lineTo(s * 0.4, s * 0.9); ctx.stroke();
  });
  return glyphs;
}

/* ------------------------------ overlay ---------------------------------- */

/**
 * Overlay de HUD completo: compõe os instrumentos em uma moldura de canto a
 * canto, consumindo a telemetria de `physics.js` e, opcionalmente, a de
 * `atmosphere.js`.
 *
 * @example
 *   const hud = new HUD({ accent: '#ffb454' });
 *   hud.draw(ctx, engine.getTelemetry(nave), {
 *     spacecraft: nave,
 *     primary: terra,
 *     atmosphere: atmo.getTelemetry(nave),
 *     camera,
 *   });
 */
export class HUD {
  /**
   * @param {object} [style] sobrescritas de `HUD_STYLE`
   * @param {object} [options]
   * @param {'full'|'minimal'} [options.layout='full']
   */
  constructor(style = {}, options = {}) {
    this.style = { ...HUD_STYLE, ...style };
    this.layout = options.layout ?? 'full';
    this.peakG = 0;
    this.time = 0;
    this._fuelMax = new Map();
  }

  /** Atualiza o pico de força G (chamar 1× por quadro). */
  update(telemetry, dt = 0) {
    this.time += dt;
    const g = telemetry?.gForceNet ?? telemetry?.gForce ?? 0;
    if (Number.isFinite(g)) {
      const decay = Math.exp(-Math.max(0, dt) * 0.05);
      this.peakG = Math.max(g, this.peakG * decay);
    }
    return this.peakG;
  }

  /** Reset do pico de G. */
  resetPeak() { this.peakG = 0; }

  /**
   * Desenha o HUD completo.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} telemetry `engine.getTelemetry(sc)`
   * @param {object} [options]
   * @param {object} [options.spacecraft] nave (para ápsides/partículas)
   * @param {object} [options.primary] corpo central
   * @param {object} [options.atmosphere] `atmo.getTelemetry(sc)`
   * @param {object} [options.camera] câmera do mundo (habilita marcos de ápsides)
   * @param {number} [options.width] largura (padrão: canvas)
   * @param {number} [options.height]
   * @param {number} [options.dt=0]
   */
  draw(ctx, telemetry, options = {}) {
    const style = this.style;
    const width = options.width ?? ctx.canvas?.width ?? 0;
    const height = options.height ?? ctx.canvas?.height ?? 0;
    if (!telemetry) return;
    this.update(telemetry, options.dt ?? 0);

    const margin = 18;
    const fuel = telemetry.fuel ?? 0;
    // Capacidade: informada pelo chamador ou o maior valor já observado para
    // esta nave (o tanque só diminui durante a missão).
    const fuelKey = telemetry.name ?? 'default';
    const seenMax = this._fuelMax.get(fuelKey) ?? 0;
    const fuelCapacity = options.fuelCapacity
      ?? Math.max(seenMax, fuel, 1e-6);
    this._fuelMax.set(fuelKey, Math.max(seenMax, fuel));

    // Ápsides sobre a cena (usa o vetor de excentricidade real).
    const primaryRadius = options.primaryRadius ?? options.primary?.radius ?? 0;
    let apsides = options.apsides ?? null;
    if (!apsides && options.spacecraft && options.primary) {
      apsides = computeApsisMarkers(options.spacecraft, options.primary);
    }
    if (apsides && options.camera) {
      drawApsisMarkers(ctx, { apsides, camera: options.camera, style });
    }

    // Canto superior esquerdo: painel orbital.
    drawOrbitPanel(ctx, { ...telemetry, apogee: telemetry.apogee, perigee: telemetry.perigee }, {
      x: margin, y: margin, width: 236, style,
    });

    if (this.layout !== 'minimal') {
      // Canto superior direito: velocidade + G (afastados da borda para que
      // os rótulos dos marcadores caibam dentro do canvas).
      const cx = width - margin - 76;
      drawSpeedGauge(ctx, {
        x: cx, y: margin + 66, radius: 52,
        speed: telemetry.orbitalVelocity ?? telemetry.speed ?? 0,
        circularVelocity: telemetry.circularVelocity,
        escapeVelocity: telemetry.escapeVelocity,
        style,
      });
      drawGForceGauge(ctx, {
        x: cx - 124, y: margin + 66, radius: 46,
        value: telemetry.gForceNet ?? telemetry.gForce ?? 0,
        peak: this.peakG,
        style,
      });
      // Nome do corpo de referência.
      ctx.save();
      setFont(ctx, style.fontLabel);
      ctx.fillStyle = style.textDim;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(String(telemetry.referenceBody ?? '').toUpperCase(), width - margin, margin - 2);
      ctx.restore();

      // Canto inferior esquerdo: combustível + empuxo.
      const fy = height - margin - 96;
      drawFuelBar(ctx, {
        x: margin + 6, y: fy, width: 230,
        fuel, capacity: fuelCapacity,
        deltaV: telemetry.deltaV,
        throttle: telemetry.throttle,
        time: this.time,
        style,
      });
      drawThrottleBar(ctx, {
        x: margin + 6, y: fy + 76, width: 230,
        throttle: telemetry.throttle ?? 0,
        thrust: telemetry.thrust,
        style,
      });

      // Canto inferior direito: bússola + fita de altitude.
      drawHeadingCompass(ctx, {
        x: width - margin - 56, y: height - margin - 56, radius: 50,
        angle: telemetry.angle ?? 0,
        track: compassFromAngle(Math.atan2(telemetry.vy ?? 0, telemetry.vx ?? 0)),
        style,
      });
      drawAltitudeTape(ctx, {
        x: width - margin - 250, y: height - margin - 196,
        height: 176, width: 76,
        altitude: telemetry.altitude ?? 0,
        apoapsisAltitude: apsides ? apsides.apoapsisAltitude
          : (Number.isFinite(telemetry.apogee) ? telemetry.apogee - primaryRadius : undefined),
        periapsisAltitude: apsides ? apsides.periapsisAltitude
          : (Number.isFinite(telemetry.perigee) ? telemetry.perigee - primaryRadius : undefined),
        span: options.tapeSpan,
        style,
      });
    }

    // Alertas.
    const alerts = [];
    const atmo = options.atmosphere;
    // Só alerta se o veículo realmente tem propelente (satélites sem tanque
    // não devem disparar "combustível crítico" para sempre).
    const hasFuelSystem = options.fuelCapacity > 0 || (telemetry.deltaV ?? 0) > 0 || fuel > 0;
    if (hasFuelSystem && fuel / Math.max(fuelCapacity, 1e-6) <= 0.12) {
      alerts.push({ label: 'Combustível crítico', level: 'danger' });
    }
    if (atmo?.reentry) alerts.push({ label: 'Reentrada — plasma', level: 'warn' });
    if (Number.isFinite(atmo?.hullTemperature) && atmo.hullTemperature > 1200) {
      alerts.push({ label: `Temperatura ${Math.round(atmo.hullTemperature)} K`, level: 'danger' });
    }
    if (telemetry.destroyed) alerts.push({ label: 'Veículo destruído', level: 'danger' });
    if (alerts.length) {
      drawStatusStrip(ctx, alerts, { x: margin, y: height - margin - 300, style });
    }
  }
}

/* ========================================================================== */
/*  7. Fábrica de sprites, câmera e integração com o simulador               */
/* ========================================================================== */

/**
 * Câmera 2D simples com acompanhamento suave, zoom ancorado e conversões
 * mundo ↔ tela. Compatível com `projectPoint`/`unprojectPoint`.
 *
 * @param {object} [options]
 * @param {number} [options.x=0]     centro da câmera no mundo (m)
 * @param {number} [options.y=0]
 * @param {number} [options.scale=1] pixels por metro
 * @param {number} [options.width=0]
 * @param {number} [options.height=0]
 * @returns {object} câmera com `follow`, `zoomAt`, `toScreen`, `toWorld`
 */
export function createCamera(options = {}) {
  const camera = {
    x: options.x ?? 0,
    y: options.y ?? 0,
    scale: options.scale ?? 1,
    width: options.width ?? 0,
    height: options.height ?? 0,
    minScale: options.minScale ?? 1e-9,
    maxScale: options.maxScale ?? 1e6,
    get cx() { return this.width / 2; },
    get cy() { return this.height / 2; },
    resize(width, height) {
      this.width = width;
      this.height = height;
      return this;
    },
    /** Centraliza instantaneamente em um ponto do mundo. */
    centerOn(x, y) { this.x = x; this.y = y; return this; },
    /** Acompanha um corpo com suavização exponencial. */
    follow(target, dt = 0, smoothing = 6) {
      if (!target) return this;
      const k = smoothing <= 0 ? 1 : 1 - Math.exp(-smoothing * Math.max(0, dt));
      this.x += (target.x - this.x) * k;
      this.y += (target.y - this.y) * k;
      return this;
    },
    /** Zoom multiplicativo mantendo o ponto sob o cursor fixo. */
    zoomAt(factor, screenX = this.width / 2, screenY = this.height / 2) {
      const before = this.toWorld(screenX, screenY);
      this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
      const after = this.toWorld(screenX, screenY);
      this.x += before.x - after.x;
      this.y += before.y - after.y;
      return this;
    },
    /** Ajusta o zoom para enquadrar um raio (m) com margem. */
    frameRadius(radius, margin = 1.25) {
      const half = Math.min(this.width, this.height) / 2;
      if (radius > 0) this.scale = half / (radius * margin);
      return this;
    },
    toScreen(wx, wy) { return projectPoint(this, wx, wy); },
    toWorld(sx, sy) { return unprojectPoint(this, sx, sy); },
    toJSON() {
      return { x: this.x, y: this.y, scale: this.scale, width: this.width, height: this.height };
    },
  };
  return camera;
}

/* ---------------------- projeção esférica de texturas --------------------- */

const _sphereCache = new WeakMap();
const _projectionLUT = new Map();

/**
 * Precomputa a geometria de remapeamento equirretangular → disco (POM).
 * Para cada coluna de saída guarda a coluna de origem (asin em X) e para cada
 * linha a linha de origem (asin em Y). Reaproveitada por todas as camadas
 * (albedo, nuvens, emissão) de mesma resolução e longitude.
 * @private
 */
function projectionLUT(size, sw, sh, lonOffset) {
  const lonQ = Math.round(mod(lonOffset, 1) * 128) / 128;
  const key = `${size}|${sw}|${sh}|${lonQ}`;
  const cached = _projectionLUT.get(key);
  if (cached) return cached;

  const colX = new Int32Array(size);
  const colX1 = new Int32Array(size);
  const colF = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const u = ((x + 0.5) / size) * 2 - 1;
    const theta = Math.asin(clamp(u, -1, 1));
    const pos = (theta / TAU + lonQ) * sw;
    const x0 = Math.floor(pos);
    colX[x] = ((x0 % sw) + sw) % sw;
    colX1[x] = ((x0 + 1) % sw + sw) % sw;
    colF[x] = pos - x0;
  }
  const rowY = new Int32Array(size);
  const rowY1 = new Int32Array(size);
  const rowF = new Float32Array(size);
  for (let y = 0; y < size; y++) {
    const v = ((y + 0.5) / size) * 2 - 1;
    const phi = Math.asin(clamp(v, -1, 1));
    const pos = (0.5 - phi / Math.PI) * sh;
    const y0 = clamp(Math.floor(pos), 0, sh - 1);
    rowY[y] = y0;
    rowY1[y] = Math.min(sh - 1, y0 + 1);
    rowF[y] = clamp(pos - y0, 0, 1);
  }

  const lut = { colX, colX1, colF, rowY, rowY1, rowF, size, sw, sh, lon: lonQ };
  // Cache pequeno: só a geometria mais recente interessa.
  if (_projectionLUT.size > 24) _projectionLUT.clear();
  _projectionLUT.set(key, lut);
  return lut;
}

/**
 * Projeta uma textura equirretangular em um disco esférico (projeção
 * ortográfica) via remapeamento bilinear em memória — sem `drawImage` por
 * coluna, que é caro em canvas 2D.
 *
 * O resultado é cacheado por (canvas de origem, resolução, longitude
 * quantizada em 1/128 de volta). Como a rotação planetária é lenta, o cache
 * acerta na grande maioria dos quadros; quando erra, o custo é um único
 * laço sobre os pixels do disco.
 *
 * @private
 * @param {any} source textura equirretangular
 * @param {number} size diâmetro desejado em px
 * @param {number} lonOffset longitude em voltas (0..1)
 * @param {number} [maxResolution=512] teto de resolução interna
 * @returns {any} canvas quadrado (size × size) com o disco projetado
 */
function sphericalProjection(source, size, lonOffset, maxResolution = 512) {
  // Potência de 2 mais próxima, limitada pelo teto (o canvas faz o upscale).
  const px = clamp(Math.pow(2, Math.round(Math.log2(Math.max(16, size)))), 16, maxResolution);
  const sw = source.width | 0;
  const sh = source.height | 0;
  if (!(sw > 0 && sh > 0)) return source;

  const lut = projectionLUT(px, sw, sh, lonOffset);
  let entry = _sphereCache.get(source);
  if (entry && entry.size === px && entry.lon === lut.lon && entry.sw === sw && entry.sh === sh) {
    return entry.canvas;
  }

  // Canvas e ImageData são reaproveitados entre reconstruções: alocar um
  // buffer de 1 MB por quadro causaria thrash de GC durante a rotação.
  if (!entry || entry.size !== px || entry.sw !== sw || entry.sh !== sh) {
    const canvas = createCanvas(px, px);
    const ctx = get2D(canvas, { willReadFrequently: true });
    entry = {
      canvas, ctx, size: px, lon: -1, sw, sh, src: null,
      image: ctx.createImageData(px, px),
    };
    _sphereCache.set(source, entry);
  }

  // Pixels de origem (lidos uma única vez por versão do canvas).
  if (!entry.src) {
    try {
      const sctx = get2D(source, { willReadFrequently: true });
      entry.src = sctx.getImageData(0, 0, sw, sh).data;
    } catch {
      return source; // canvas contaminado (tainted) → degrada para o original
    }
  }

  const srcData = entry.src;
  const dst = entry.image.data;
  const { colX, colX1, colF, rowY, rowY1, rowF } = lut;
  const rowStride = sw * 4;

  for (let y = 0; y < px; y++) {
    const r0 = rowY[y] * rowStride;
    const r1 = rowY1[y] * rowStride;
    const fy = rowF[y];
    const dRow = y * px * 4;
    for (let x = 0; x < px; x++) {
      const aX = colX[x] * 4;
      const bX = colX1[x] * 4;
      const fx = colF[x];
      const i00 = r0 + aX;
      const i01 = r0 + bX;
      const i10 = r1 + aX;
      const i11 = r1 + bX;
      const a0 = srcData[i00 + 3];
      const a1 = srcData[i01 + 3];
      const a2 = srcData[i10 + 3];
      const a3 = srcData[i11 + 3];
      const o = dRow + x * 4;
      if ((a0 | a1 | a2 | a3) === 0) { dst[o + 3] = 0; continue; }
      // Bilinear em RGBA (peso aplicado também ao alfa, sem pré-multiplicar).
      const w00 = (1 - fx) * (1 - fy);
      const w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy;
      const w11 = fx * fy;
      dst[o] = srcData[i00] * w00 + srcData[i01] * w01 + srcData[i10] * w10 + srcData[i11] * w11;
      dst[o + 1] = srcData[i00 + 1] * w00 + srcData[i01 + 1] * w01 + srcData[i10 + 1] * w10 + srcData[i11 + 1] * w11;
      dst[o + 2] = srcData[i00 + 2] * w00 + srcData[i01 + 2] * w01 + srcData[i10 + 2] * w10 + srcData[i11 + 2] * w11;
      dst[o + 3] = a0 * w00 + a1 * w01 + a2 * w10 + a3 * w11;
    }
  }
  entry.ctx.putImageData(entry.image, 0, 0);
  entry.lon = lut.lon;
  return entry.canvas;
}

/* -------------------------- renderização de corpos ------------------------ */

/** @private Mapeia nomes de corpos para presets de textura. */
const BODY_PRESET_HINTS = Object.freeze({
  sol: 'venus', sun: 'venus', mercury: 'mercury', mercurio: 'mercury', 'mercúrio': 'mercury',
  venus: 'venus', 'vênus': 'venus', earth: 'earth', terra: 'earth',
  moon: 'moon', lua: 'moon', mars: 'mars', marte: 'mars',
  jupiter: 'jupiter', 'júpiter': 'jupiter', saturn: 'saturn', saturno: 'saturn',
  uranus: 'uranus', urano: 'uranus', neptune: 'neptune', netuno: 'neptune',
  titan: 'titan', tita: 'titan', io: 'io', europa: 'europa',
  ceres: 'moon', pluto: 'mercury', plutao: 'mercury', 'plutão': 'mercury',
});

/**
 * Infere o preset de textura a partir de um corpo de `physics.js`.
 * Prioridade: `body.preset` → `body.texture` → `body.atmosphere` (string) →
 * nome do corpo → 'earth'.
 * @param {object} body
 * @returns {string}
 */
export function inferPlanetPreset(body) {
  if (!body) return 'earth';
  if (typeof body.preset === 'string') return body.preset;
  if (typeof body.texture === 'string') return body.texture;
  if (typeof body.atmosphere === 'string') {
    const key = body.atmosphere.toLowerCase();
    if (PLANET_PRESETS[key]) return key;
    if (key === 'earth' || key === 'terra') return 'earth';
    if (key === 'mars' || key === 'marte') return 'mars';
    if (key === 'venus' || key === 'vênus') return 'venus';
    if (key === 'titan' || key === 'titã') return 'titan';
    if (key === 'jupiter' || key === 'júpiter') return 'jupiter';
  }
  const name = String(body.name ?? '').toLowerCase().trim();
  if (BODY_PRESET_HINTS[name]) return BODY_PRESET_HINTS[name];
  for (const key of Object.keys(BODY_PRESET_HINTS)) {
    if (name.startsWith(key)) return BODY_PRESET_HINTS[key];
  }
  return 'earth';
}

/** @private Desenha a textura de um corpo dentro do disco, com projeção. */
function drawSphereTexture(ctx, source, cx, cy, radius, lonOffset, options, maxResolution) {
  const projection = options.projection ?? 'auto';
  const size = Math.max(4, Math.round(radius * 2));
  // Projeção esférica acima de 48 px de raio; abaixo disso o mapeamento
  // direto é indistinguível e muito mais barato.
  const useSpherical = projection === 'spherical'
    || (projection === 'auto' && radius >= 48);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.clip();
  if (useSpherical) {
    const proj = sphericalProjection(source, size, lonOffset, maxResolution ?? options.sphereResolution);
    ctx.imageSmoothingEnabled = true;
    // 'high' só compensa ao reduzir; em ampliação o bilinear é equivalente e
    // bem mais barato em rasterizadores por software.
    ctx.imageSmoothingQuality = proj.width > size ? 'high' : 'low';
    ctx.drawImage(proj, cx - radius, cy - radius, size, size);
  } else {
    // Mapeamento rápido: 360° → 4R de largura, 180° → 2R de altura.
    const w = 4 * radius;
    const h = 2 * radius;
    const shift = mod(lonOffset, 1) * w;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(source, cx - radius - shift, cy - radius, w, h);
    ctx.drawImage(source, cx - radius - shift + w, cy - radius, w, h);
  }
  ctx.restore();
}

/**
 * Desenha um corpo celeste (planeta, lua, estrela) com textura procedural,
 * terminador solar, limb darkening, nuvens, luzes noturnas, halo atmosférico
 * e anéis.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} body corpo de `physics.js` (usa x, y, radius, name)
 * @param {object} camera câmera `{ x, y, scale, width, height }`
 * @param {object} texture saída de `createPlanetTexture`
 * @param {object} [options]
 * @param {object} [options.sun] corpo solar `{ x, y }` para iluminação
 * @param {number} [options.time=0] segundos (rotação e nuvens)
 * @param {number} [options.spinRate=0.02] voltas/s
 * @param {number} [options.cloudSpeed=1.8] nuvens mais rápidas que a superfície
 * @param {number} [options.rotation] longitude inicial (voltas 0..1)
 * @param {'auto'|'flat'|'spherical'} [options.projection='auto']
 * @param {number} [options.terminator=1] intensidade da sombra noturna (0..1)
 * @param {boolean} [options.halo=true]
 * @param {boolean} [options.rings=true]
 * @param {boolean} [options.nightLights=true]
 * @param {number} [options.sphereResolution=512] teto de resolução da projeção esférica
 * @returns {{x:number,y:number,radius:number}|null} posição em tela
 */
export function drawBody(ctx, body, camera, texture, options = {}) {
  if (!body || !camera || !texture) return null;
  const pos = projectPoint(camera, body.x, body.y);
  const radius = (body.radius ?? 0) * (camera.scale ?? 1);
  if (!(radius > 0.6)) return null;
  if (pos.x + radius < -8 || pos.x - radius > (camera.width ?? Infinity) + 8
    || pos.y + radius < -8 || pos.y - radius > (camera.height ?? Infinity) + 8) {
    return null;
  }
  const time = options.time ?? 0;
  const spinRate = options.spinRate ?? (texture.type === 'gasGiant' ? 0.012 : 0.03);
  const rotation = options.rotation ?? 0;
  const lon = mod(rotation + time * spinRate, 1);
  const sun = options.sun;
  const sunAngle = sun
    ? Math.atan2((sun.y ?? 0) - body.y, (sun.x ?? 0) - body.x)
    : -Math.PI * 0.75;
  const lit = !!sun;
  const tex = texture.canvas;

  // Anéis traseiros.
  const rings = options.rings !== false ? texture.rings : null;
  if (rings) drawPlanetRings(ctx, pos.x, pos.y, radius, rings, sunAngle, 'back');

  if (radius < 3) {
    // Corpo minúsculo: ponto com brilho.
    ctx.fillStyle = cssColor(parseColor(texture.averageColor ?? '#9aa4b0'));
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(1, radius), 0, TAU);
    ctx.fill();
    return pos;
  }

  // Disco texturizado.
  if (tex) drawSphereTexture(ctx, tex, pos.x, pos.y, radius, lon, options,
    options.sphereResolution ?? 512);

  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, radius, 0, TAU);
  ctx.clip();

  // Nuvens (camada independente, giro mais rápido).
  if (texture.cloudMap && options.clouds !== false && texture.cloudActive !== false) {
    const cloudSpeed = options.cloudSpeed ?? 1.8;
    const cloudLon = mod(lon * cloudSpeed + 0.37, 1);
    ctx.globalAlpha = 0.9;
    drawSphereTexture(ctx, texture.cloudMap, pos.x, pos.y, radius, cloudLon, options,
      Math.max(128, (options.sphereResolution ?? 512) / 2));
    ctx.globalAlpha = 1;
  }

  // Luzes noturnas / emissão (lava). Camadas vazias são ignoradas.
  if (texture.emissiveMap && texture.emissiveActive !== false) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = options.emissiveAlpha ?? 0.85;
    drawSphereTexture(ctx, texture.emissiveMap, pos.x, pos.y, radius, lon, options,
      Math.max(128, (options.sphereResolution ?? 512) / 2));
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Terminador (sombra do lado noturno) + limb darkening.
  if (lit && options.terminator !== 0) {
    const strength = clamp01(options.terminator ?? 1);
    const cx0 = pos.x + Math.cos(sunAngle) * radius * 0.35;
    const cy0 = pos.y + Math.sin(sunAngle) * radius * 0.35;
    const cx1 = pos.x - Math.cos(sunAngle) * radius * 1.15;
    const cy1 = pos.y - Math.sin(sunAngle) * radius * 1.15;
    const g = ctx.createLinearGradient(cx0, cy0, cx1, cy1);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.42, 'rgba(0,0,0,0.02)');
    g.addColorStop(0.58, `rgba(2,6,16,${0.42 * strength})`);
    g.addColorStop(0.78, `rgba(1,4,12,${0.72 * strength})`);
    g.addColorStop(1, `rgba(0,2,8,${0.9 * strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(pos.x - radius, pos.y - radius, radius * 2, radius * 2);
    // Limb darkening + brilho de borda em um único passe radial, limitado à
    // coroa externa do disco (evita repintar o miolo já texturizado).
    const rimInner = radius * 0.62;
    const rim = ctx.createRadialGradient(pos.x, pos.y, rimInner, pos.x, pos.y, radius);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(0.75, 'rgba(0,0,0,0.10)');
    rim.addColorStop(1, `rgba(0,0,0,${0.34 * (0.6 + strength * 0.4)})`);
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, TAU);
    ctx.arc(pos.x, pos.y, rimInner, 0, TAU, true);
    ctx.fill('evenodd');
    if (options.rimLight !== false && radius < 620) {
      ctx.globalCompositeOperation = 'lighter';
      const rimLight = ctx.createRadialGradient(
        pos.x + Math.cos(sunAngle) * radius * 0.72,
        pos.y + Math.sin(sunAngle) * radius * 0.72,
        radius * 0.05, pos.x, pos.y, radius,
      );
      rimLight.addColorStop(0, `rgba(255,248,230,${0.16 * strength})`);
      rimLight.addColorStop(0.55, 'rgba(255,248,230,0)');
      ctx.fillStyle = rimLight;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  } else if (!lit) {
    // Sem sol definido: sombreamento de esfera neutro.
    const g = ctx.createRadialGradient(
      pos.x - radius * 0.3, pos.y - radius * 0.3, radius * 0.1,
      pos.x, pos.y, radius,
    );
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.72, 'rgba(0,0,0,0.02)');
    g.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(pos.x - radius, pos.y - radius, radius * 2, radius * 2);
  }
  ctx.restore();

  // Halo atmosférico.
  const atmo = texture.atmosphere;
  if (atmo && options.halo !== false && atmo.halo > 0) {
    const halo = Math.max(0.2, atmo.halo ?? 1);
    const outer = radius * (1 + 0.16 * halo);
    const g = ctx.createRadialGradient(pos.x, pos.y, radius * 0.96, pos.x, pos.y, outer);
    const col = parseColor(atmo.color ?? '#5fa8ff');
    g.addColorStop(0, rgba(col.r, col.g, col.b, 0.42 * clamp01(halo)));
    g.addColorStop(0.35, rgba(col.r, col.g, col.b, 0.18 * clamp01(halo)));
    g.addColorStop(1, rgba(col.r, col.g, col.b, 0));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, outer, 0, TAU);
    // Anel: o disco já está desenhado e não precisa ser iluminado de novo.
    ctx.arc(pos.x, pos.y, radius * 0.94, 0, TAU, true);
    ctx.fill('evenodd');
    // Espalhamento frontal no lado iluminado.
    if (lit) {
      const sg = ctx.createRadialGradient(
        pos.x + Math.cos(sunAngle) * radius, pos.y + Math.sin(sunAngle) * radius,
        radius * 0.02, pos.x, pos.y, radius * 1.1,
      );
      sg.addColorStop(0, rgba(col.r, col.g, col.b, 0.35 * clamp01(halo)));
      sg.addColorStop(1, rgba(col.r, col.g, col.b, 0));
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius * 1.12, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // Anéis frontais.
  if (rings) drawPlanetRings(ctx, pos.x, pos.y, radius, rings, sunAngle, 'front');
  return pos;
}

/** @private Anéis planetários (elipses com lacunas e sombra). */
function drawPlanetRings(ctx, cx, cy, radius, rings, sunAngle, part) {
  const inner = radius * (rings.inner ?? 1.4);
  const outer = radius * (rings.outer ?? 2);
  const tilt = clamp(rings.tilt ?? 0.35, -1, 1);
  const vertical = rings.vertical === true;
  const ry = Math.max(1, Math.abs(tilt) * radius);
  const color = parseColor(rings.color ?? '#d9c9a6');
  const opacity = clamp01(rings.opacity ?? 0.6);

  ctx.save();
  // Metade traseira/frontal via clip de meia-plano.
  ctx.beginPath();
  if (vertical) {
    if (part === 'back') ctx.rect(cx - outer, cy - outer, outer, outer);
    else ctx.rect(cx, cy - outer, outer, outer);
  } else if (part === 'back') {
    ctx.rect(cx - outer, cy - outer, outer * 2, outer);
  } else {
    ctx.rect(cx - outer, cy, outer * 2, outer);
  }
  ctx.clip();
  ctx.globalAlpha = opacity;

  // Anel como caminho par (elipse externa − interna), mesmo-ímpar.
  const path = () => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, outer, Math.max(1, ry * (outer / radius)), 0, 0, TAU);
    ctx.ellipse(cx, cy, inner, Math.max(0.5, ry * (inner / radius)), 0, 0, TAU);
  };
  path();
  const g = ctx.createLinearGradient(cx - outer, cy - outer, cx + outer, cy + outer);
  g.addColorStop(0, rgba(color.r, color.g, color.b, 0.35));
  g.addColorStop(0.35, rgba(color.r, color.g, color.b, 1));
  g.addColorStop(0.65, rgba(color.r * 0.85, color.g * 0.85, color.b * 0.85, 0.85));
  g.addColorStop(1, rgba(color.r, color.g, color.b, 0.25));
  ctx.fillStyle = g;
  ctx.fill('evenodd');

  // Lacunas (divisões de Cassini simplificadas).
  if (Array.isArray(rings.gaps)) {
    for (const gap of rings.gaps) {
      const gr = lerp(inner, outer, clamp01(gap.pos ?? 0.5));
      const gw = Math.max(1, (outer - inner) * (gap.width ?? 0.03));
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.ellipse(cx, cy, gr + gw / 2, Math.max(0.5, ry * ((gr + gw / 2) / radius)), 0, 0, TAU);
      ctx.ellipse(cx, cy, gr - gw / 2, Math.max(0.5, ry * ((gr - gw / 2) / radius)), 0, 0, TAU);
      ctx.fillStyle = `rgba(0,0,0,${clamp01(gap.opacity ?? 0.6)})`;
      ctx.fill('evenodd');
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * Fase visual automática a partir do estado de voo (altitude/throttle).
 * @param {object} spacecraft
 * @param {object} [telemetry]
 * @param {object} [options]
 * @param {number} [options.satelliteAltitude=140e3] m
 * @param {number} [options.upperAltitude=90e3] m
 * @returns {string} uma de `SPACECRAFT_PHASES`
 */
export function autoSpacecraftPhase(spacecraft, telemetry, options = {}) {
  if (telemetry?.destroyed || spacecraft?.destroyed) return 'capsule';
  const altitude = telemetry?.altitude ?? spacecraft?.aeroState?.altitude
    ?? (spacecraft?.x != null ? 0 : 0);
  const throttle = telemetry?.throttle ?? spacecraft?.throttle ?? 0;
  const landed = spacecraft?.landed === true;
  if (landed) return 'lander';
  if (altitude > (options.satelliteAltitude ?? 140e3) && throttle < 0.02) return 'satellite';
  if (altitude > (options.upperAltitude ?? 90e3) && throttle < 0.02) return 'upper';
  if (throttle > 0.02) return 'stack';
  return 'upper';
}

/* ----------------------- renderização da espaçonave ----------------------- */

/**
 * Desenha uma espaçonave usando o sprite e a telemetria de `physics.js`,
 * incluindo pluma de exaustão, brilho de reentrada e partículas de plasma.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} sprite saída de `createSpaceshipSprite`
 * @param {object} camera
 * @param {object} spacecraft nave (x, y, angle, throttle, thermal…)
 * @param {object} [options]
 * @param {object} [options.telemetry] `engine.getTelemetry(sc)`
 * @param {number} [options.length=34] comprimento visual em px
 * @param {string} [options.phase] força uma fase
 * @param {boolean} [options.autoPhase=true]
 * @param {number} [options.time=0]
 * @param {number} [options.ambient] pressão relativa (0 = vácuo, 1 = solo)
 * @param {boolean} [options.reentry=true] desenha brilho térmico
 * @param {boolean} [options.particles=true] desenha plasma de `atmosphere.js`
 * @returns {?{x:number,y:number,length:number}}
 */
export function drawSpacecraft(ctx, sprite, camera, spacecraft, options = {}) {
  if (!sprite || !camera || !spacecraft) return null;
  const pos = projectPoint(camera, spacecraft.x ?? 0, spacecraft.y ?? 0);
  const pxLength = clamp(options.length ?? 34, 6, 4096);
  const telemetry = options.telemetry ?? spacecraft;
  const phase = options.phase
    ?? (options.autoPhase === false ? 'stack' : autoSpacecraftPhase(spacecraft, telemetry, options));
  const throttle = clamp01(options.throttle ?? telemetry?.throttle ?? spacecraft.throttle ?? 0);
  const angle = telemetry?.angle ?? spacecraft.angle ?? 0;
  const ambient = clamp01(options.ambient ?? (telemetry?.altitude != null
    ? (telemetry.altitude < 40e3 ? 1 : telemetry.altitude < 90e3 ? 0.5 : 0)
    : 0.5));

  // Brilho de reentrada antes do sprite (fica atrás).
  if (options.reentry !== false) {
    drawReentryGlow(ctx, spacecraft, camera, {
      radius: pxLength * 0.42,
      time: options.time ?? 0,
    });
  }

  sprite.draw(ctx, {
    x: pos.x,
    y: pos.y,
    angle,
    scale: pxLength / sprite.config.length,
    throttle,
    phase,
    time: options.time ?? 0,
    ambient,
    spectrum: options.spectrum,
    plume: options.plume !== false,
  });

  // Aquecedores/partículas atmosféricas.
  if (options.particles !== false) {
    drawSpacecraftPlasma(ctx, spacecraft, camera, {
      scale: options.particleScale ?? 1,
    });
  }

  return { x: pos.x, y: pos.y, length: pxLength };
}

/* -------------------------- SpriteGenerator ------------------------------- */

/** @private Estima memória de uma textura de planeta em bytes. */
function estimateTextureBytes(tex) {
  const base = (tex.width ?? 0) * (tex.height ?? 0) * 4;
  let count = 1;
  for (const key of ['normalMap', 'specularMap', 'emissiveMap', 'cloudMap', 'heightMap']) {
    if (tex[key]) count++;
  }
  return base * count;
}

/** @private Chave de cache estável para presets (nome + impressão digital). */
function presetCacheKey(preset) {
  if (typeof preset === 'string') return preset;
  if (!preset) return 'earth';
  if (typeof preset === 'function') return presetCacheKey(preset());
  const fingerprint = hashString(JSON.stringify(preset.palette ?? '') + JSON.stringify(preset.height ?? '')
    + JSON.stringify(preset.bands ?? '') + JSON.stringify(preset.craters ?? ''));
  return `${preset.name ?? 'custom'}:${preset.type ?? 'terrestrial'}:${fingerprint}`;
}

/**
 * Fábrica com cache LRU de texturas, sprites e HUDs. É o ponto de entrada
 * recomendado para o simulador: gera uma vez, reutiliza em todos os quadros
 * e libera memória ao descartar.
 *
 * @example
 *   const gfx = new SpriteGenerator({ seed: 2026, quality: 'high' });
 *   const terra = gfx.planet('earth');
 *   const lua = gfx.planet({ preset: 'moon', width: 256, seed: 42 });
 *   const nave = gfx.spaceship({ length: 220, boosters: 2 });
 *   const hud = gfx.hud({ accent: '#ffb454' });
 *
 *   gfx.drawBody(ctx, terraBody, camera, { sun: sol, time });
 *   gfx.drawSpacecraft(ctx, nave, camera, naveSim, { telemetry });
 *   hud.draw(ctx, telemetry, { spacecraft: naveSim, primary: terraBody, camera });
 */
export class SpriteGenerator {
  /**
   * @param {object} [options]
   * @param {number} [options.seed=2026] seed global (usada quando não informada)
   * @param {string|number} [options.quality='high'] perfil de qualidade padrão
   * @param {'auto'|'cpu'|'webgl'} [options.renderer='auto']
   * @param {WebGLRenderingContext} [options.gl] contexto WebGL (habilita GPU)
   * @param {number} [options.planetWidth=512] resolução padrão das texturas
   * @param {number} [options.maxCacheEntries=64]
   * @param {number} [options.maxCacheBytes=192e6]
   * @param {object} [options.particles] opções padrão de `createParticleSprites`
   */
  constructor(options = {}) {
    this.seed = (options.seed ?? 2026) >>> 0;
    this.quality = options.quality ?? 'high';
    this.renderer = options.renderer ?? 'auto';
    this.gl = options.gl ?? null;
    this.planetWidth = options.planetWidth ?? 512;
    this.maxCacheEntries = Math.max(4, options.maxCacheEntries ?? 64);
    this.maxCacheBytes = Math.max(1e6, options.maxCacheBytes ?? 192e6);
    this.particleOptions = options.particles ?? {};
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0, entries: 0, bytes: 0 };
    this._hudInstances = new Map();
  }

  /** @private Consulta/insere no cache LRU. */
  _cached(key, factory, bytesOf = null) {
    const hit = this.cache.get(key);
    this._tick = (this._tick ?? 0) + 1;
    if (hit) {
      this.stats.hits++;
      hit.lastUsed = this._tick;
      // Move para o fim (mais recente) — semântica LRU sobre a ordem do Map.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.value;
    }
    this.stats.misses++;
    const value = factory();
    const bytes = bytesOf ? bytesOf(value) : 0;
    this.cache.set(key, { value, bytes, lastUsed: this._tick });
    this.stats.bytes += bytes;
    this._evict();
    this.stats.entries = this.cache.size;
    return value;
  }

  /** @private Remove entradas antigas até caber no orçamento. */
  _evict() {
    while (this.cache.size > this.maxCacheEntries || this.stats.bytes > this.maxCacheBytes) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.stats.bytes -= entry?.bytes ?? 0;
      this.stats.evictions++;
      // Libera texturas/sprites que possuem dispose.
      if (entry?.value?.dispose) {
        try { entry.value.dispose(); } catch { /* ignore */ }
      }
    }
    this.stats.entries = this.cache.size;
  }

  /**
   * Textura de planeta/lua (cacheada por preset + parâmetros).
   * @param {string|object} [preset='earth'] nome, objeto de opções ou preset
   * @param {object} [options] sobrescreve opções de `createPlanetTexture`
   * @returns {object} textura
   */
  planet(preset = 'earth', options = {}) {
    const opts = typeof preset === 'object' ? { ...preset, ...options } : { ...options, preset };
    const cfg = {
      preset: opts.preset ?? preset,
      width: opts.width ?? this.planetWidth,
      quality: opts.quality ?? this.quality,
      seed: opts.seed ?? (this.seed ^ hashString(presetCacheKey(opts.preset ?? preset))) >>> 0,
      renderer: opts.renderer ?? this.renderer,
      gl: opts.gl ?? this.gl,
      normals: opts.normals !== false,
      specular: opts.specular !== false,
      emissive: opts.emissive !== false,
      clouds: opts.clouds !== false,
      heightMap: opts.heightMap === true,
      normalStrength: opts.normalStrength,
      flipGreen: opts.flipGreen === true,
      readback: opts.readback !== false,
    };
    const key = `planet|${presetCacheKey(cfg.preset)}|${cfg.width}|${cfg.quality}|${cfg.seed}`
      + `|${cfg.renderer}|${cfg.normals}${cfg.specular}${cfg.emissive}${cfg.clouds}${cfg.heightMap}`
      + `|${cfg.normalStrength ?? ''}|${cfg.flipGreen}`;
    return this._cached(key, () => createPlanetTexture(cfg), estimateTextureBytes);
  }

  /**
   * Sprite de espaçonave (cacheado por configuração).
   * @param {object} [config] ver `createSpaceshipSprite`
   * @returns {object} sprite
   */
  spaceship(config = {}) {
    const key = `ship|${stableKey(config)}`;
    return this._cached(key, () => createSpaceshipSprite(config), (sprite) => {
      let bytes = 0;
      for (const p of Object.values(sprite.phases)) bytes += p.width * p.height * 4;
      return bytes;
    });
  }

  /**
   * Atlas de partículas (cacheado).
   * @param {object} [options] ver `createParticleSprites`
   */
  particles(options = {}) {
    const merged = { ...this.particleOptions, ...options };
    const key = `particles|${stableKey(merged)}`;
    return this._cached(key, () => createParticleSprites(merged), (atlas) => {
      let bytes = 0;
      for (const kind of Object.values(atlas.kinds)) {
        for (const c of kind) bytes += c.width * c.height * 4;
      }
      return bytes;
    });
  }

  /**
   * Instância de HUD (mesma instância por chave de estilo).
   * @param {object} [style] sobrescreve `HUD_STYLE`
   * @param {object} [options]
   */
  hud(style = {}, options = {}) {
    const key = `${stableKey(style)}|${options.layout ?? 'full'}`;
    if (!this._hudInstances.has(key)) this._hudInstances.set(key, new HUD(style, options));
    return this._hudInstances.get(key);
  }

  /** Folha de sprites de chama (cacheada). */
  exhaust(options = {}) {
    const key = `exhaust|${stableKey(options)}`;
    return this._cached(key, () => createExhaustSpriteSheet(options), (sheet) => {
      return sheet.canvas.width * sheet.canvas.height * 4;
    });
  }

  /** Glifos de HUD (cacheados). */
  glyphs(options = {}) {
    const key = `glyphs|${stableKey(options)}`;
    return this._cached(key, () => createHUDGlyphs(options));
  }

  /**
   * Desenha um corpo com a textura apropriada (gera/cacheia sob demanda).
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} body
   * @param {object} camera
   * @param {object} [options] repassado a `drawBody` (aceita `preset`, `width`)
   */
  drawBody(ctx, body, camera, options = {}) {
    if (!body) return null;
    const presetName = options.preset ?? inferPlanetPreset(body);
    let size = options.width;
    if (size == null) {
      const radiusPx = Math.max(8, (body.radius ?? 0) * (camera?.scale ?? 1) * 2);
      // Escolhe a potência de dois mais próxima (economia de memória).
      size = clamp(Math.pow(2, Math.round(Math.log2(Math.max(64, Math.min(1024, radiusPx * 1.5))))), 64, 1024);
    }
    const texture = this.planet(presetName, { width: size, ...options.texture });
    return drawBody(ctx, body, camera, texture, options);
  }

  /**
   * Desenha uma espaçonave com sprite cacheado.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} [config] configuração do sprite
   * @param {object} camera
   * @param {object} spacecraft
   * @param {object} [options] repassado a `drawSpacecraft`
   */
  drawSpacecraft(ctx, config, camera, spacecraft, options = {}) {
    const sprite = (config && config.phases) ? config : this.spaceship(config ?? {});
    return drawSpacecraft(ctx, sprite, camera, spacecraft, options);
  }

  /** Limpa todo o cache e libera recursos. */
  clearCache() {
    for (const entry of this.cache.values()) {
      if (entry.value?.dispose) {
        try { entry.value.dispose(); } catch { /* ignore */ }
      }
    }
    this.cache.clear();
    this.stats.entries = 0;
    this.stats.bytes = 0;
  }

  /** Libera tudo (cache + HUDs). */
  dispose() {
    this.clearCache();
    this._hudInstances.clear();
  }
}

/** Atalho para criar um `SpriteGenerator`. */
export function createSpriteGenerator(options = {}) {
  return new SpriteGenerator(options);
}

/**
 * Pré-gera um conjunto de planetas e uma espaçonave (útil para telas de
 * carregamento — evita engasgos no primeiro quadro).
 *
 * @param {SpriteGenerator} generator
 * @param {{ planets?: string[], width?: number, spaceship?: object }} [options]
 * @returns {{ planets: Object<string, object>, spaceship: ?object }}
 */
export function preloadSprites(generator, options = {}) {
  const planets = {};
  const names = options.planets ?? ['earth'];
  const width = options.width ?? generator.planetWidth;
  for (const name of names) planets[name] = generator.planet(name, { width });
  const ship = options.spaceship ? generator.spaceship(options.spaceship) : null;
  return { planets, spaceship: ship };
}

/* ========================================================================== */
/*  Exportações consolidadas                                                  */
/* ========================================================================== */

/** Mapa da API pública (útil para depuração/descoberta em runtime). */
export const sprites = Object.freeze({
  SpriteGenerator,
  HUD,
  ParticleSystem,
  Noise,
  createPlanetTexture,
  generatePlanetSurface,
  createGLPlanetTexture,
  createSpaceshipSprite,
  createParticleSprites,
  createHUDGlyphs,
  createExhaustSpriteSheet,
  createCamera,
  drawBody,
  drawSpacecraft,
  drawThermalParticles,
  drawReentryGlow,
  computeApsisMarkers,
  PLANET_PRESETS,
});

export default SpriteGenerator;
