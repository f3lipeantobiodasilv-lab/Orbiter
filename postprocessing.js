/**
 * ============================================================================
 *  postprocessing.js — Pipeline de Pós-Processamento, Sombras Suaves e
 *                      Renderizador Unificado do Simulador Orbital
 * ============================================================================
 *  Módulo ES6+ autocontido (zero dependências de runtime), projetado para
 *  consumir — sem reescrever — os módulos do simulador:
 *
 *      physics.js      → posições, órbitas, telemetria (G, velocidade, empuxo)
 *      atmosphere.js   → densidade, calor de reentrada, partículas de plasma
 *      sprites.js      → texturas procedurais, sprites de nave, partículas, HUD
 *      shaders.js      → programas PBR, materiais, malhas e estado de render
 *
 *  Nada é importado: a integração é feita por "duck typing" dos objetos
 *  públicos (engine.getTelemetry, atmo.getTelemetry, SpriteGenerator/HUD,
 *  ShaderProgram/Mesh), exatamente como `atmosphere.js`, `sprites.js` e
 *  `shaders.js` fazem entre si. Basta injetar os namespaces em `options`.
 *
 *  Conteúdo
 *  --------
 *   0. Utilidades ..................... matemática, cor (sRGB⇄linear), canvas
 *                                       offscreen, tone mapping em CPU e LUT.
 *   1. Constantes ..................... operadores de tone mapping, presets de
 *                                       qualidade, defaults de efeitos e o
 *                                       modelo físico de intensidade (stress).
 *   2. Suporte WebGL .................. detecção de contexto, capacidades,
 *                                       estado (pilha save/restore) e timer de
 *                                       GPU.
 *   3. Compilação ..................... GLProgram (link, introspecção de
 *                                       uniforms, envio por tipo, log anotado)
 *                                       e FullscreenQuad.
 *   4. Framebuffer objects ............ RenderTarget (HDR, MSAA, depth
 *                                       texture, mipmaps, resolve) e
 *                                       RenderTargetPool.
 *   5. Biblioteca GLSL ................ chunks: tone mapping (ACES/Reinhard),
 *                                       bloom (down/up/anamórfico), SSAO,
 *                                       SSR, sombras de contato, lente
 *                                       (distorção + aberração cromática),
 *                                       vinheta, grão, dithering, FXAA.
 *   6. Passes ......................... PostPass/FullscreenPass, CopyPass,
 *                                       BrightPass, BloomPass, SSAOPass,
 *                                       ContactShadowPass, SSRPass,
 *                                       DepthEncodePass, ToneMappingPass,
 *                                       CompositePass, FXAAPass, PassChain.
 *                                       Cada passe é um objeto isolado
 *                                       (attach → init, configure, resize,
 *                                       render, dispose) e pode ser ligado,
 *                                       desligado ou reordenado em runtime.
 *   7. Pipeline ....................... PostProcessingPipeline: alvos HDR,
 *                                       auto-exposição (medidor de
 *                                       luminância), resolução adaptativa,
 *                                       ordenação e aplicação dos passes.
 *   8. Intensidade física ............. EffectStressController: converte
 *                                       telemetria (G, velocidade orbital,
 *                                       reentrada, fluxo térmico, densidade)
 *                                       em intensidades suaves de aberração,
 *                                       distorção, bloom, vinheta e grão.
 *   9. Canvas 2D ...................... CanvasSoftShadowRenderer (sombras
 *                                       suaves/penumbra/umbra com filtros
 *                                       nativos) e CanvasPostFX (bloom,
 *                                       aberração, vinheta, grão e tone
 *                                       mapping por LUT) — caminho de fallback
 *                                       quando não há WebGL.
 *  10. GBuffer falso .................. FakeGBuffer: a partir do MESMO draw
 *                                       list 2D gera profundidade linear e
 *                                       normais analíticas de esfera/esquadria
 *                                       em typed arrays — habilita SSAO/SSR/
 *                                       sombras em cena desenhada em Canvas2D.
 *  11. Renderizador ................... Renderer: loop unificado (atualização
 *                                       de câmera/partículas/HUD, camadas de
 *                                       desenho, sombras, pós-processamento,
 *                                       HUD nítido por cima, captura de
 *                                       quadro, resolução adaptativa).
 *  12. Exportações .................... classes, fábricas e namespace
 *                                       `postprocessing`.
 *
 *  Unidades: SI onde há física (m, m/s, m/s², W/m², K); pixels/UV na GPU.
 *
 *  Uso típico (Canvas2D + fallback automático)
 *  -------------------------------------------
 *    import { Renderer } from './postprocessing.js';
 *    import * as sprites from './sprites.js';
 *
 *    const generator = new sprites.SpriteGenerator({ seed: 7 });
 *    const hud = generator.hud({ width: 1280, height: 720 });
 *
 *    const renderer = new Renderer(canvas, {
 *      width: 1280, height: 720, pixelRatio: 1,
 *      postfx: { quality: 'high', bloom: { intensity: 1.1 } },
 *    });
 *    // namespaces injetados (engine/física, atmosfera, sprites, HUD):
 *    renderer.attach({ engine, atmosphere, sprites, generator, hud });
 *    renderer.setScene({ bodies: engine.bodies, spacecraft: engine.spacecraft,
 *                        follow: engine.spacecraft[0] });
 *
 *    function loop(dt) {
 *      renderer.frame(dt);        // cena + sombras + pós + HUD nítido
 *      requestAnimationFrame(loop);
 *    }
 *
 *  Uso típico (pipeline isolado, com cena própria em WebGL)
 *  --------------------------------------------------------
 *    import { PostProcessingPipeline } from './postprocessing.js';
 *
 *    const pipeline = new PostProcessingPipeline(glCanvas, {
 *      quality: 'ultra',
 *      tonemap: { operator: 'aces', exposure: 1.15, autoExposure: true },
 *      bloom: { threshold: 1.0, intensity: 1.2, mips: 6 },
 *      ssao: { radius: 0.6, intensity: 1.4, samples: 16 },
 *      ssr: { steps: 24, intensity: 0.9, thickness: 0.08 },
 *      lens: { aberration: 0.0012, distortion: 0.03, vignette: 0.28 },
 *      grain: { intensity: 0.035 },
 *    });
 *
 *    pipeline.begin();                       // bind do alvo HDR + viewport
 *    drawScene(gl);                          // seus desenhos/shader.js
 *    pipeline.end({ depth: depthTexture });  // passes → tela
 *
 *    // Ou, a partir de um canvas 2D já desenhado (GBuffer falso):
 *    pipeline.renderExternalScene(sceneCanvas, { decodeSRGB: true });
 *
 *  API pública
 *  -----------
 *   Pipeline ..... PostProcessingPipeline, createPostProcessingPipeline
 *   Renderer ..... Renderer, createRenderer
 *   Passes ....... PostPass, FullscreenPass, CopyPass, BrightPass, BloomPass,
 *                  SSAOPass, ContactShadowPass, SSRPass, DepthEncodePass,
 *                  ToneMappingPass, CompositePass, FXAAPass, PassChain
 *                  (acesso direto: pipeline.ssaoPass, .bloomPass.brightPass,
 *                  .compositePass, .presentPass, …)
 *   Buffers ...... RenderTarget (HDR/MSAA/depth), RenderTargetPool,
 *                  createRenderTarget, resolveTextureFormat, FullscreenQuad,
 *                  DynamicTexture, FakeGBuffer (alias DepthNormalBufferBuilder)
 *   Canvas 2D .... CanvasPostFX, CanvasSoftShadowRenderer, SoftShadowLayer
 *   Intensidade .. EffectStressController, createStressController
 *   Utilidades ... detectWebGLSupport, describeGLCapabilities,
 *                  applyToneMapping (CPU), buildToneMapLUT,
 *                  computeBloomThreshold, POST_QUALITY, TONEMAP_OPERATORS,
 *                  POST_SHADERS, postprocessing (namespace)
 * ============================================================================
 */

/* ========================================================================== */
/*  0. Utilidades                                                             */
/* ========================================================================== */

/** 2π. */
export const TAU = Math.PI * 2;
/** π. */
export const PI = Math.PI;
/** Grau em radianos. */
export const DEG = Math.PI / 180;
/** Épsilon numérico usado em divisões seguras. */
export const EPSILON = 1e-6;

/** Restringe `v` ao intervalo [lo, hi]. */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Restringe `v` ao intervalo [0, 1]. */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Alias semântico de `clamp01`. */
export const saturate = clamp01;
/** Interpolação linear. */
export const lerp = (a, b, t) => a + (b - a) * t;
/** Mapeia `v` de [a, b] para [0, 1] (sem clamp). */
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
/** Parte fracionária (sempre positiva). */
export const fract = (v) => v - Math.floor(v);
/** Módulo positivo. */
export const mod = (a, n) => ((a % n) + n) % n;
/** Smoothstep de Hermite. */
export function smoothstep(edge0, edge1, v) {
  if (edge0 === edge1) return v < edge0 ? 0 : 1;
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
/** Smoothstep quíntico (derivadas contínuas nas bordas). */
export function smootherstep(edge0, edge1, v) {
  if (edge0 === edge1) return v < edge0 ? 0 : 1;
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
/** Interpolação exponencial independente de framerate. */
export function damp(current, target, lambda, dt) {
  const k = lambda <= 0 ? 1 : 1 - Math.exp(-lambda * Math.max(0, dt));
  return current + (target - current) * k;
}
/** Hash inteiro determinístico (x, y, z) → uint32. */
export function hashInt(x, y = 0, z = 0) {
  let h = (x | 0) * 0x27d4eb2d ^ (y | 0) * 0x165667b1 ^ (z | 0) * 0x9e3779b1;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}
/** Hash → [0, 1). */
export const hash01 = (x, y = 0, z = 0) => hashInt(x, y, z) / 4294967296;
/** Próxima potência de dois ≥ `n`. */
export function nextPowerOfTwo(n) {
  let v = Math.max(1, Math.ceil(Number(n) || 1));
  v -= 1;
  v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16;
  return v + 1;
}
/** `true` se `n` é potência de dois. */
export const isPowerOfTwo = (n) => (n & (n - 1)) === 0 && n > 0;

/* ---------------------------------- cor ---------------------------------- */

/**
 * Normaliza uma cor para `{ r, g, b, a }` em [0, 1].
 * Aceita `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb[a](...)`, `[r, g, b]`,
 * `{ r, g, b }`, `0xRRGGBB` e números inteiros.
 *
 * @param {string|number[]|object|number} color
 * @returns {{ r:number, g:number, b:number, a:number }}
 */
export function parseColor(color) {
  const out = { r: 1, g: 1, b: 1, a: 1 };
  if (color == null) return out;
  if (Array.isArray(color) || ArrayBuffer.isView(color)) {
    const scale = color.some((c) => Number(c) > 1.0001) ? 1 / 255 : 1;
    out.r = clamp01((Number(color[0]) || 0) * scale);
    out.g = clamp01((Number(color[1]) || 0) * scale);
    out.b = clamp01((Number(color[2]) || 0) * scale);
    out.a = clamp01(color[3] === undefined ? 1 : Number(color[3]));
    return out;
  }
  if (typeof color === 'object') {
    const scale = (color.r > 1.0001 || color.g > 1.0001 || color.b > 1.0001) ? 1 / 255 : 1;
    out.r = clamp01((Number(color.r) || 0) * scale);
    out.g = clamp01((Number(color.g) || 0) * scale);
    out.b = clamp01((Number(color.b) || 0) * scale);
    out.a = clamp01(color.a === undefined ? 1 : Number(color.a));
    return out;
  }
  if (typeof color === 'number') {
    const v = Math.max(0, Math.floor(color));
    out.r = ((v >> 16) & 255) / 255;
    out.g = ((v >> 8) & 255) / 255;
    out.b = (v & 255) / 255;
    return out;
  }
  const str = String(color).trim();
  const hex = str.match(/^#?([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    out.r = parseInt(h.slice(0, 2), 16) / 255;
    out.g = parseInt(h.slice(2, 4), 16) / 255;
    out.b = parseInt(h.slice(4, 6), 16) / 255;
    out.a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return out;
  }
  const fn = str.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    const scale = parts.slice(0, 3).some((c) => c > 1.0001) ? 1 / 255 : 1;
    out.r = clamp01((parts[0] || 0) * scale);
    out.g = clamp01((parts[1] || 0) * scale);
    out.b = clamp01((parts[2] || 0) * scale);
    out.a = clamp01(parts[3] === undefined ? 1 : parts[3]);
    return out;
  }
  return out;
}

/** Cor → `[r, g, b]` em [0, 1]. */
export function colorToArray(color) {
  const c = parseColor(color);
  return [c.r, c.g, c.b];
}

/** `{r,g,b}`/array → string CSS `#rrggbb` (útil para canvas 2D). */
export function toCssHex(color) {
  const c = parseColor(color);
  const hex = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/** `{r,g,b}`/array → string CSS `rgba(...)`. */
export function toCssRgba(color, alpha) {
  const c = parseColor(color);
  const a = alpha === undefined ? c.a : clamp01(alpha);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

/** Converte um canal sRGB [0,1] para linear. */
export function srgbToLinear(c) {
  const v = clamp01(c);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
/** Converte um canal linear [0,1] para sRGB. */
export function linearToSrgb(c) {
  const v = Math.max(0, c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
/** sRGB → linear (array ou objeto de cor). */
export function srgbToLinear3(color) {
  const c = parseColor(color);
  return [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
}
/** Linear → sRGB (array `[r,g,b]`). */
export function linearToSrgb3(rgb) {
  return [linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2])];
}
/** Luminância Rec.709 de uma cor. */
export function luminance(color) {
  const c = parseColor(color);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}
/** Mistura duas cores em espaço sRGB. */
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

/* --------------------------- canvas offscreen ---------------------------- */

let canvasFactory = null;

/**
 * Define uma fábrica de canvas (`(width, height) => canvas`).
 * Útil em workers, testes (Node) e ambientes sem `document`.
 * @param {?((width:number, height:number) => any)} factory
 */
export function setCanvasFactory(factory) {
  canvasFactory = typeof factory === 'function' ? factory : null;
}

/**
 * Cria um canvas offscreen usando, em ordem: a fábrica registrada,
 * `document.createElement('canvas')` ou `OffscreenCanvas`.
 * @returns {?object} canvas ou `null` se o ambiente não suportar
 */
export function createCanvas(width = 1, height = 1) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (canvasFactory) {
    const canvas = canvasFactory(w, h);
    if (canvas) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      return canvas;
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

/** `true` se é possível criar canvas offscreen. */
export function isCanvasAvailable() {
  return !!createCanvas(1, 1);
}

/**
 * Contexto 2D com as opções recomendadas para composição de pós-processamento
 * (`alpha: false` quando a saída é opaca evita blend desnecessário).
 * @returns {?CanvasRenderingContext2D}
 */
export function get2DContext(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  try {
    return canvas.getContext('2d', options.alpha === undefined ? { alpha: true } : options);
  } catch {
    return null;
  }
}

let _filterSupport = null;
/**
 * Detecta suporte real a `ctx.filter` (blur/contraste) no ambiente atual.
 * @param {CanvasRenderingContext2D} [ctx] contexto de teste
 */
export function supportsCanvasFilter(ctx = null) {
  if (!ctx) {
    if (_filterSupport === null) {
      const canvas = createCanvas(16, 16);
      const test = get2DContext(canvas);
      _filterSupport = test ? supportsCanvasFilter(test) : false;
    }
    return _filterSupport;
  }
  if (typeof ctx.filter !== 'string') return false;
  const canvasSize = ctx.canvas;
  // Medir em um canvas grande custaria dois `getImageData` do buffer inteiro:
  // a capacidade é do ambiente, então testamos sempre em 16×16.
  if (!canvasSize || !canvasSize.width || !canvasSize.height
      || canvasSize.width > 128 || canvasSize.height > 128) {
    return supportsCanvasFilter();
  }
  // 1) O setter aceita o valor?
  const previous = ctx.filter;
  try {
    ctx.filter = 'blur(2px)';
    const accepted = ctx.filter === 'blur(2px)';
    ctx.filter = previous;
    if (!accepted) return false;
  } catch {
    return false;
  }
  // 2) O filtro é realmente *aplicado*? (alguns ambientes aceitam o valor e
  //    ignoram o efeito — ex.: canvases acelerados sem suporte a SVG filters).
  try {
    const canvas = ctx.canvas;
    if (!canvas || !canvas.width || !canvas.height) return true;
    const w = canvas.width;
    const h = canvas.height;
    const before = ctx.getImageData ? ctx.getImageData(0, 0, w, h) : null;
    if (!before) return true;
    const snapshot = new Uint8ClampedArray(before.data);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.filter = 'blur(3px)';
    ctx.fillStyle = '#fff';
    ctx.fillRect(w / 2, h / 2, 1, 1);
    ctx.filter = 'none';
    const after = ctx.getImageData(0, 0, w, h).data;
    ctx.restore();
    // Sem filtro, apenas 1 pixel ficaria aceso; com blur o brilho se espalha.
    let lit = 0;
    for (let i = 0; i < after.length; i += 4) {
      if (after[i] > 8) lit += 1;
    }
    ctx.putImageData(before, 0, 0);
    return lit > 6;
  } catch {
    return false;
  }
}

/* ---------------------- tone mapping (CPU + LUT) ------------------------- */

/**
 * Curva ACES Filmic (Narkowicz 2015) para um canal.
 * Espelha `tonemapACES` de `shaders.js` para manter CPU/GPU coerentes.
 * @param {number} x valor linear (pode ser > 1)
 * @returns {number} valor em [0, 1]
 */
export function acesFilmic(x) {
  const v = Math.max(0, x) * 0.6;
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return clamp01(a / b);
}

/** Reinhard simples: `x / (1 + x)`. */
export const reinhard = (x) => (x > 0 ? x / (1 + x) : 0);

/**
 * Reinhard estendido com ponto branco (preserva brancos) —
 * `x (1 + x/W²) / (1 + x)`.
 * @param {number} x
 * @param {number} whitePoint luminância considerada branco puro
 */
export function reinhardExtended(x, whitePoint = 1) {
  const w = Math.max(1, whitePoint);
  const v = Math.max(0, x);
  return clamp01((v * (1 + v / (w * w))) / (1 + v));
}

/**
 * Filmic de Hable (Uncharted 2), normalizado para branco em `x = 11.2`.
 * Mais contrastado que ACES; bom para cenas espaciais escuras.
 */
export function hableFilmic(x) {
  const curve = (v) => (v * (0.15 * v + 0.05) + 0.004) / (v * (0.15 * v + 0.5) + 0.06);
  const white = 11.2;
  return clamp01(curve(Math.max(0, x)) / curve(white));
}

/**
 * Aplica tone mapping a uma cor linear `[r, g, b]`.
 * @param {number[]} rgb
 * @param {object} [options]
 * @param {'aces'|'reinhard'|'reinhard-extended'|'filmic'|'linear'} [options.operator='aces']
 * @param {number} [options.exposure=1]
 * @param {number} [options.whitePoint=1]
 * @param {boolean} [options.srgb=true] converte a saída para sRGB
 * @returns {number[]} `[r, g, b]`
 */
export function applyToneMapping(rgb, options = {}) {
  const operator = options.operator ?? 'aces';
  const exposure = options.exposure ?? 1;
  const white = options.whitePoint ?? 1;
  const fn = TONE_MAP_CPU[operator] ?? TONE_MAP_CPU.aces;
  const out = [
    fn((rgb[0] ?? 0) * exposure, white),
    fn((rgb[1] ?? 0) * exposure, white),
    fn((rgb[2] ?? 0) * exposure, white),
  ];
  if (options.srgb !== false) return linearToSrgb3(out);
  return out;
}

/** @private Tabela de curvas de tone mapping em CPU. */
const TONE_MAP_CPU = Object.freeze({
  aces: (x) => acesFilmic(x),
  filmic: (x) => hableFilmic(x),
  reinhard: (x) => reinhard(x),
  'reinhard-extended': (x, white) => reinhardExtended(x, white),
  linear: (x) => clamp01(x),
});

/**
 * Pré-calcula uma LUT de tone mapping (256 entradas, 8 bits) para uso em
 * canvas 2D / ImageData. A curva é aplicada por canal, como no shader.
 *
 * @param {object} [options] `operator`, `exposure`, `whitePoint`, `srgb`
 * @param {number} [options.size=256]
 * @returns {Uint8ClampedArray} LUT com `size` entradas
 */
export function buildToneMapLUT(options = {}) {
  const size = Math.max(2, Math.round(options.size ?? 256));
  const lut = new Uint8ClampedArray(size);
  const exposure = options.exposure ?? 1;
  const white = options.whitePoint ?? 1;
  const srgb = options.srgb !== false;
  const fn = TONE_MAP_CPU[options.operator ?? 'aces'] ?? TONE_MAP_CPU.aces;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * exposure;
    let v = fn(x, white);
    if (srgb) v = linearToSrgb(v);
    lut[i] = Math.round(clamp01(v) * 255);
  }
  return lut;
}

/**
 * Ajusta o threshold de bloom a partir da luminância do quadro.
 *
 * O limiar físico do "brilho" deve ficar acima do branco difuso da cena
 * (superfícies iluminadas) e abaixo das fontes emissivas (Sol, chamas).
 * A função interpola entre um piso e um teto conforme a exposição para que,
 * em cenas noturnas/escuras, apenas as fontes realmente quentes passem.
 *
 * @param {object} [options]
 * @param {number} [options.base=1] threshold de referência
 * @param {number} [options.exposure=1] exposição atual
 * @param {number} [options.averageLuminance] luminância média medida
 * @param {number} [options.min=0.18] piso
 * @param {number} [options.max=3.5] teto
 * @param {number} [options.adaptation=0.35] peso da luminância medida
 * @returns {number}
 */
export function computeBloomThreshold(options = {}) {
  const base = Math.max(0, options.base ?? 1);
  const exposure = Math.max(1e-4, options.exposure ?? 1);
  const min = options.min ?? 0.18;
  const max = options.max ?? 3.5;
  const adaptation = clamp01(options.adaptation ?? 0.35);
  const avg = Number.isFinite(options.averageLuminance)
    ? Math.max(0, options.averageLuminance)
    : 0.18;
  // Threshold em unidades de cena (divide pela exposição: quanto maior a
  // exposição, menor o valor linear que satura a tela).
  const fromExposure = base / exposure;
  // Cena escura (avg baixa) → threshold mais baixo para as chamas aparecerem.
  const fromLuma = base * lerp(0.55, 1.25, clamp01(avg / 0.35));
  return clamp(lerp(fromExposure, fromLuma, adaptation), min, max);
}

/* ========================================================================== */
/*  1. Constantes e presets                                                   */
/* ========================================================================== */

/** Operadores de tone mapping disponíveis (CPU e GPU). */
export const TONEMAP_OPERATORS = Object.freeze([
  'aces',
  'filmic',
  'reinhard',
  'reinhard-extended',
  'linear',
]);

/** Modos de blend de bloom. */
export const BLOOM_MODES = Object.freeze(['additive', 'screen', 'soft']);

/**
 * Presets de qualidade. Cada preset define resolução relativa, MSAA, número
 * de mips de bloom, amostras de SSAO e passos de SSR. Valores explícitos do
 * usuário sempre têm precedência sobre o preset.
 */
export const POST_QUALITY = Object.freeze({
  low: Object.freeze({
    scale: 0.7,
    msaa: 0,
    hdr: true,
    bloom: { mips: 3, scatter: 0.6, threshold: 1.15, intensity: 0.85, streak: false },
    ssao: { enabled: false, samples: 8, resolution: 0.5, blur: false },
    ssr: { enabled: false, steps: 10, resolution: 0.5 },
    fxaa: { enabled: true },
    grain: { intensity: 0.02 },
  }),
  medium: Object.freeze({
    scale: 1,
    msaa: 0,
    hdr: true,
    bloom: { mips: 4, scatter: 0.68, threshold: 1.05, intensity: 1, streak: false },
    ssao: { enabled: true, samples: 8, resolution: 0.5, blur: true },
    ssr: { enabled: false, steps: 12, resolution: 0.5 },
    fxaa: { enabled: true },
    grain: { intensity: 0.025 },
  }),
  high: Object.freeze({
    scale: 1,
    msaa: 0,
    hdr: true,
    bloom: { mips: 5, scatter: 0.72, threshold: 1, intensity: 1.1, streak: false },
    ssao: { enabled: true, samples: 16, resolution: 0.5, blur: true },
    ssr: { enabled: true, steps: 16, resolution: 0.5 },
    fxaa: { enabled: true },
    grain: { intensity: 0.028 },
  }),
  ultra: Object.freeze({
    scale: 1,
    msaa: 4,
    hdr: true,
    bloom: { mips: 6, scatter: 0.75, threshold: 0.95, intensity: 1.15, streak: true },
    ssao: { enabled: true, samples: 24, resolution: 1, blur: true },
    ssr: { enabled: true, steps: 28, resolution: 1 },
    fxaa: { enabled: true },
    grain: { intensity: 0.03 },
  }),
});

/** Nomes válidos de presets de qualidade. */
export const POST_QUALITY_NAMES = Object.freeze(Object.keys(POST_QUALITY));

/**
 * Configuração padrão do pipeline. `deepMerge` é aplicado com os presets e
 * com as opções do usuário (usuário > pipeline > preset).
 */
export const DEFAULT_POST_OPTIONS = Object.freeze({
  enabled: true,
  quality: 'high',
  /** Resolução relativa do pipeline (afeta custo e nitidez). */
  scale: 1,
  /** Limite de pixels internos (proteção para telas 4K). */
  maxPixels: 3.2e6,
  /** Alvo HDR (RGBA16F) com fallback automático para LDR. */
  hdr: true,
  /** MSAA do alvo de cena (0 = desligado; só WebGL2). */
  msaa: 0,
  /** Aplica o tone mapping dentro do passe composto. */
  tonemapInComposite: true,
  tonemap: {
    operator: 'aces',
    exposure: 1.0,
    whitePoint: 1.6,
    srgb: true,
    autoExposure: false,
    adaptationSpeed: 2.2,
    minExposure: 0.25,
    maxExposure: 4.0,
    keyValue: 0.18,
  },
  bloom: {
    enabled: true,
    /** `additive` (físico) | `screen` (não satura) | `soft` (halo menor). */
    mode: 'additive',
    threshold: 1.0,
    knee: 0.5,
    intensity: 1.05,
    mips: 5,
    scatter: 0.72,
    tint: '#ffae72',
    tintStrength: 0.18,
    flameBoost: 0.35,
    streak: false,
    streakIntensity: 0.35,
    streakTint: '#ff8a55',
    streakSamples: 6,
  },
  ssao: {
    enabled: true,
    samples: 16,
    radius: 0.08,
    bias: 0.002,
    intensity: 1.0,
    power: 1.6,
    blur: true,
    resolution: 0.5,
    contactShadows: false,
    contactStrength: 0.55,
    contactSteps: 12,
    contactRayLength: 0.12,
    contactThickness: 0.0015,
    contactLight: [0.5, 0.5],
  },
  ssr: {
    enabled: false,
    steps: 16,
    maxDistance: 0.35,
    thickness: 0.02,
    intensity: 0.9,
    fresnel: 0.35,
    jitter: 0.5,
    resolution: 0.5,
    edgeFade: 0.18,
    materialMask: false,
  },
  lens: {
    aberration: 0.0009,
    distortion: 0.015,
    zoomCompensation: 1.035,
    heatShimmer: 0,
    speedBlur: 0,
  },
  vignette: {
    intensity: 0.28,
    power: 2.2,
    color: '#000000',
  },
  grain: {
    intensity: 0.028,
    animated: true,
    shadowBoost: 0.6,
  },
  dither: 0.7,
  grade: {
    saturation: 1.02,
    contrast: 1.04,
    temperature: 0,
    lift: 0,
  },
  fxaa: {
    enabled: true,
    edgeThreshold: 0.12,
    edgeMinimum: 0.0312,
  },
  adaptiveResolution: {
    enabled: true,
    minScale: 0.6,
    maxScale: 1,
    targetFps: 58,
    interval: 0.75,
    step: 0.07,
  },
  debug: {
    pass: null,
  },
});

/**
 * Modelo físico de intensidade de efeitos.
 *
 * Cada entrada descreve quando um efeito começa e quando atinge a
 * intensidade máxima. Os valores foram calibrados para o simulador orbital:
 *
 *  - `gForce`     : 3 g (início de desconforto) → 9 g (limite humano ~9 g
 *                   sustentado; a aberração/distorção cresce como leitura
 *                   subjetiva do piloto + vibração estrutural).
 *  - `speedRatio` : v/v_circ. 0.85 → 1.6. A aberração cromática cresce com
 *                   (v/c)² em termos relativísticos; aqui é reescalada para
 *                   um efeito cinematográfico plausível.
 *  - `reentry`    : fluxo térmico de 60 kW/m² (início de plasma visível) a
 *                   1.2 MW/m² (reentrada balística violenta) — ordem de
 *                   grandeza de Sutton–Graves para Ve = 7.8 km/s.
 *  - `heat`       : temperatura de pele 900 K → 2600 K (cor de corpo negro).
 */
export const STRESS_DEFAULTS = Object.freeze({
  gForce: { start: 3.0, full: 9.0 },
  speedRatio: { start: 0.85, full: 1.6 },
  reentry: { start: 6e4, full: 1.2e6 },
  heat: { start: 900, full: 2600 },
  altitude: { start: 120e3, full: 20e3 },
  mach: { start: 3, full: 18 },
  /** Ganhos máximos por efeito (multiplicados pela intensidade 0..1). */
  maxAberration: 0.0065,
  maxDistortion: 0.075,
  maxVignette: 0.5,
  maxGrain: 0.055,
  maxHeatShimmer: 0.014,
  maxSpeedBlur: 0.35,
  bloomBoost: 0.9,
  bloomRadiusBoost: 0.55,
  bloomThresholdDrop: 0.45,
  saturationBoost: 0.12,
  /** Suavização exponencial (1/s): subida rápida, descida lenta. */
  attack: 7,
  release: 1.5,
  /** Escala global de movimento (acessibilidade: 0 = sem efeitos). */
  motionScale: 1,
  /** Reduz efeitos quando `prefers-reduced-motion` está ativo. */
  respectReducedMotion: true,
});

/** IDs de efeitos controláveis em runtime. */
export const EFFECT_NAMES = Object.freeze([
  'bloom',
  'ssao',
  'ssr',
  'contactShadows',
  'aberration',
  'distortion',
  'heatShimmer',
  'speedBlur',
  'vignette',
  'grain',
  'fxaa',
]);

/** @private Deep merge simples (objetos planos, sem arrays/mapas). */
function deepMerge(...sources) {
  const out = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (value === undefined) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)
          && !ArrayBuffer.isView(value)) {
        out[key] = deepMerge(out[key], value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

/** @private Congela profundamente (usado em catálogos exportados). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Mescla um preset de qualidade com opções do usuário.
 * @param {string|object} quality nome do preset ou objeto de opções
 * @param {object} [options] opções explícitas (precedência máxima)
 * @returns {object}
 */
export function resolvePostOptions(quality = 'high', options = {}) {
  const preset = typeof quality === 'string' ? POST_QUALITY[quality] : quality;
  return deepMerge(DEFAULT_POST_OPTIONS, preset ?? POST_QUALITY.high, options);
}

/* ========================================================================== */
/*  2. Suporte WebGL                                                          */
/* ========================================================================== */

/**
 * Lê (e cacheia) uma extensão WebGL.
 * @param {WebGLRenderingContext} gl
 * @param {string} name
 */
export function getGLExtension(gl, name) {
  if (!gl || typeof gl.getExtension !== 'function') return null;
  if (!gl.__ppExtensions) {
    Object.defineProperty(gl, '__ppExtensions', { value: new Map(), configurable: true });
  }
  const cache = gl.__ppExtensions;
  if (cache.has(name)) return cache.get(name);
  let ext = null;
  try { ext = gl.getExtension(name); } catch { ext = null; }
  cache.set(name, ext);
  return ext;
}

const GL_STRING = (gl, key) => {
  try { return gl.getParameter(key); } catch { return null; }
};

/**
 * Descreve as capacidades relevantes do contexto para o pipeline escolher
 * formatos de render target, número de amostras e caminhos de shader.
 *
 * @param {WebGLRenderingContext} gl
 * @returns {object} capacidades normalizadas
 */
export function describeGLCapabilities(gl) {
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
    && gl instanceof WebGL2RenderingContext;
  const ext = (name) => getGLExtension(gl, name);
  const debugInfo = ext('WEBGL_debug_renderer_info');
  const textureFloat = !!ext('OES_texture_float');
  const textureHalfFloat = isWebGL2 || !!ext('OES_texture_half_float');
  const colorBufferFloat = isWebGL2
    ? !!ext('EXT_color_buffer_float')
    : !!ext('WEBGL_color_buffer_float') || !!ext('EXT_color_buffer_float');
  const colorBufferHalfFloat = isWebGL2
    ? !!ext('EXT_color_buffer_float')
    : !!ext('EXT_color_buffer_half_float');
  const depthTexture = isWebGL2 || !!ext('WEBGL_depth_texture');
  const derivatives = isWebGL2 || !!ext('OES_standard_derivatives');
  const timerQuery = isWebGL2 ? !!ext('EXT_disjoint_timer_query_webgl2')
    : !!ext('EXT_disjoint_timer_query');
  const maxSamples = isWebGL2 ? (GL_STRING(gl, gl.MAX_SAMPLES) || 4) : 0;

  return {
    isWebGL2,
    webglVersion: isWebGL2 ? 2 : 1,
    maxTextureSize: GL_STRING(gl, gl.MAX_TEXTURE_SIZE) || 2048,
    maxTextureUnits: GL_STRING(gl, gl.MAX_TEXTURE_IMAGE_UNITS) || 8,
    maxRenderbufferSize: GL_STRING(gl, gl.MAX_RENDERBUFFER_SIZE) || 2048,
    maxSamples,
    textureFloat,
    textureHalfFloat,
    colorBufferFloat,
    colorBufferHalfFloat,
    depthTexture,
    derivatives,
    timerQuery,
    anisotropic: !!ext('EXT_texture_filter_anisotropic'),
    maxAnisotropy: (() => {
      const a = ext('EXT_texture_filter_anisotropic');
      return a ? (GL_STRING(gl, a.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1) : 1;
    })(),
    vendor: debugInfo ? GL_STRING(gl, debugInfo.UNMASKED_VENDOR_WEBGL) : GL_STRING(gl, gl.VENDOR),
    renderer: debugInfo ? GL_STRING(gl, debugInfo.UNMASKED_RENDERER_WEBGL) : GL_STRING(gl, gl.RENDERER),
    /** Melhor formato HDR disponível (null = só LDR). */
    hdrFormat: colorBufferHalfFloat || colorBufferFloat ? 'half-float'
      : (isWebGL2 ? 'float' : null),
    /** Caminho de normais a partir da profundidade (derivadas). */
    normalFromDepth: derivatives,
    /** `blitFramebuffer` disponível (necessário para resolver MSAA). */
    blitFramebuffer: typeof gl.blitFramebuffer === 'function',
    /** `#version` usada pelos programas internos (ES 1.00 é universal). */
    glslVersion: '100',
  };
}

/**
 * Tenta criar um contexto WebGL no canvas informado.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {object} [options]
 * @param {boolean} [options.webgl2=true] preferir WebGL2
 * @param {boolean} [options.alpha=false] canvas opaco (recomendado)
 * @param {boolean} [options.antialias=false] FXAA cuida da borda
 * @param {boolean} [options.preserveDrawingBuffer=false] necessário p/ captura
 * @returns {{ gl: ?WebGLRenderingContext, isWebGL2: boolean, capabilities: ?object }}
 */
export function detectWebGLSupport(canvas = null, options = {}) {
  const attributes = {
    alpha: options.alpha ?? false,
    antialias: options.antialias ?? false,
    depth: options.depth ?? false,
    stencil: false,
    premultipliedAlpha: options.premultipliedAlpha ?? false,
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    powerPreference: options.powerPreference ?? 'high-performance',
    desynchronized: options.desynchronized ?? true,
    failIfMajorPerformanceCaveat: options.failIfMajorPerformanceCaveat ?? false,
  };
  const target = canvas ?? createCanvas(1, 1);
  if (!target || typeof target.getContext !== 'function') {
    return { gl: null, isWebGL2: false, capabilities: null };
  }
  const prefer2 = options.webgl2 !== false;
  if (prefer2) {
    try {
      const gl2 = target.getContext('webgl2', attributes);
      if (gl2) {
        return { gl: gl2, isWebGL2: true, capabilities: describeGLCapabilities(gl2) };
      }
    } catch { /* tenta WebGL1 */ }
  }
  try {
    const gl1 = target.getContext('webgl', attributes)
      ?? target.getContext('experimental-webgl', attributes);
    if (gl1) {
      return { gl: gl1, isWebGL2: false, capabilities: describeGLCapabilities(gl1) };
    }
  } catch { /* sem WebGL */ }
  return { gl: null, isWebGL2: false, capabilities: null };
}

/**
 * Pilha de estado WebGL: guarda e restaura o estado que o pós-processamento
 * altera, para conviver com `shaders.js`/renderizadores externos.
 */
export class GLState {
  /** @param {WebGLRenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    this.stack = [];
    this.maxStack = 8;
  }

  /** @private Fotografa o estado atual. */
  capture() {
    const gl = this.gl;
    const get = (key, fallback) => {
      try {
        const v = gl.getParameter(key);
        return v === undefined ? fallback : v;
      } catch { return fallback; }
    };
    return {
      viewport: Array.from(get(gl.VIEWPORT, [0, 0, 256, 256])),
      scissorTest: !!get(gl.SCISSOR_TEST, false),
      scissorBox: Array.from(get(gl.SCISSOR_BOX, [0, 0, 256, 256])),
      framebuffer: get(gl.FRAMEBUFFER_BINDING, null),
      renderbuffer: get(gl.RENDERBUFFER_BINDING, null),
      program: get(gl.CURRENT_PROGRAM, null),
      activeTexture: get(gl.ACTIVE_TEXTURE, gl.TEXTURE0),
      arrayBuffer: get(gl.ARRAY_BUFFER_BINDING, null),
      vertexArray: get(gl.VERTEX_ARRAY_BINDING, null),
      blend: !!get(gl.BLEND, false),
      blendSrcRGB: get(gl.BLEND_SRC_RGB, gl.ONE),
      blendDstRGB: get(gl.BLEND_DST_RGB, gl.ZERO),
      blendSrcAlpha: get(gl.BLEND_SRC_ALPHA, gl.ONE),
      blendDstAlpha: get(gl.BLEND_DST_ALPHA, gl.ZERO),
      blendEquationRGB: get(gl.BLEND_EQUATION_RGB, gl.FUNC_ADD),
      blendEquationAlpha: get(gl.BLEND_EQUATION_ALPHA, gl.FUNC_ADD),
      depthTest: !!get(gl.DEPTH_TEST, false),
      depthMask: !!get(gl.DEPTH_WRITEMASK, true),
      depthFunc: get(gl.DEPTH_FUNC, gl.LESS),
      cullFace: !!get(gl.CULL_FACE, false),
      colorMask: Array.from(get(gl.COLOR_WRITEMASK, [true, true, true, true])),
      clearColor: Array.from(get(gl.COLOR_CLEAR_VALUE, [0, 0, 0, 0])),
      unpackFlipY: !!get(gl.UNPACK_FLIP_Y_WEBGL, false),
      unpackPremultiply: !!get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false),
    };
  }

  /** @private Restaura um estado fotografado. */
  apply(snapshot) {
    if (!snapshot) return;
    const gl = this.gl;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, snapshot.framebuffer);
      if (gl.bindVertexArray && snapshot.vertexArray !== undefined) {
        gl.bindVertexArray(snapshot.vertexArray);
      }
      gl.viewport(...snapshot.viewport);
      if (snapshot.scissorTest) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(...snapshot.scissorBox);
      } else {
        gl.disable(gl.SCISSOR_TEST);
      }
      gl.useProgram(snapshot.program);
      gl.activeTexture(snapshot.activeTexture);
      gl.bindBuffer(gl.ARRAY_BUFFER, snapshot.arrayBuffer);
      if (snapshot.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      gl.blendFuncSeparate(snapshot.blendSrcRGB, snapshot.blendDstRGB,
        snapshot.blendSrcAlpha, snapshot.blendDstAlpha);
      gl.blendEquationSeparate(snapshot.blendEquationRGB, snapshot.blendEquationAlpha);
      if (snapshot.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      gl.depthMask(snapshot.depthMask);
      gl.depthFunc(snapshot.depthFunc);
      if (snapshot.cullFace) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
      gl.colorMask(...snapshot.colorMask);
      gl.clearColor(...snapshot.clearColor);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, snapshot.unpackFlipY);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, snapshot.unpackPremultiply);
      gl.bindRenderbuffer(gl.RENDERBUFFER, snapshot.renderbuffer);
    } catch { /* contexto perdido */ }
  }

  /** Empilha o estado atual. */
  push() {
    if (this.stack.length >= this.maxStack) this.stack.shift();
    this.stack.push(this.capture());
    return this;
  }

  /** Desempilha e restaura o estado anterior. */
  pop() {
    const snapshot = this.stack.pop();
    if (snapshot) this.apply(snapshot);
    return this;
  }

  /** Restaura o estado "neutro" para desenhar quads de tela cheia. */
  static resetForPost(gl) {
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
  }
}

/**
 * Timer de GPU opcional (`EXT_disjoint_timer_query*`). Quando indisponível,
 * `available` é `false` e todos os métodos são no-ops seguros.
 */
export class TimerQuery {
  /** @param {WebGLRenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    this.ext = null;
    this.webgl2 = false;
    this.active = null;
    this.pending = [];
    this.lastMs = null;
    this.available = false;

    const ext2 = getGLExtension(gl, 'EXT_disjoint_timer_query_webgl2');
    if (ext2 && typeof gl.createQuery === 'function') {
      this.ext = ext2;
      this.webgl2 = true;
      this.available = true;
    } else {
      const ext1 = getGLExtension(gl, 'EXT_disjoint_timer_query');
      if (ext1 && typeof ext1.createQueryEXT === 'function') {
        this.ext = ext1;
        this.available = true;
      }
    }
  }

  /** Inicia a medição (ignorado se indisponível/em uso). */
  begin() {
    if (!this.available || this.active) return false;
    const gl = this.gl;
    try {
      const query = this.webgl2 ? gl.createQuery() : this.ext.createQueryEXT();
      if (this.webgl2) gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
      else this.ext.beginQueryEXT(this.ext.TIME_ELAPSED_EXT, query);
      this.active = query;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  /** Finaliza a medição e enfileira para leitura assíncrona. */
  end() {
    if (!this.available || !this.active) return false;
    const gl = this.gl;
    try {
      if (this.webgl2) gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      else this.ext.endQueryEXT(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
      return true;
    } catch {
      this.available = false;
      this.active = null;
      return false;
    }
  }

  /** Lê resultados prontos e devolve o último tempo em ms (ou `null`). */
  poll() {
    if (!this.available) return null;
    const gl = this.gl;
    const disjointKey = this.ext.GPU_DISJOINT_EXT;
    try {
      while (this.pending.length) {
        const query = this.pending[0];
        const done = this.webgl2
          ? gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
          : this.ext.getQueryObjectEXT(query, this.ext.QUERY_RESULT_AVAILABLE_EXT);
        if (!done) break;
        this.pending.shift();
        const disjoint = gl.getParameter(disjointKey);
        const ns = this.webgl2
          ? gl.getQueryParameter(query, gl.QUERY_RESULT)
          : this.ext.getQueryObjectEXT(query, this.ext.QUERY_RESULT_EXT);
        if (this.webgl2) gl.deleteQuery(query);
        else this.ext.deleteQueryEXT(query);
        if (!disjoint) this.lastMs = ns / 1e6;
      }
      // Não acumula queries indefinidamente.
      while (this.pending.length > 4) {
        const query = this.pending.shift();
        if (this.webgl2) gl.deleteQuery(query);
        else this.ext.deleteQueryEXT(query);
      }
    } catch {
      this.available = false;
    }
    return this.lastMs;
  }

  /** Libera queries pendentes. */
  dispose() {
    const gl = this.gl;
    for (const query of this.pending) {
      try {
        if (this.webgl2) gl.deleteQuery(query);
        else this.ext.deleteQueryEXT(query);
      } catch { /* ignore */ }
    }
    this.pending.length = 0;
    this.active = null;
    this.available = false;
  }
}

/* ========================================================================== */
/*  3. Compilação e geometria de tela cheia                                   */
/* ========================================================================== */

/**
 * Formata o log de compilação do driver com o número das linhas citadas e o
 * trecho correspondente do shader (facilita depurar GLSL sem debugger).
 *
 * @param {string} log saída de `gl.getShaderInfoLog`
 * @param {string} source fonte original
 * @param {string} [label]
 * @returns {string}
 */
export function annotateShaderLog(log, source, label = 'shader') {
  const text = String(log ?? '').trim();
  if (!text) return `${label}: (sem log)`;
  const lines = String(source ?? '').split('\n');
  const annotated = text.split('\n').map((entry) => {
    const match = entry.match(/^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/);
    if (!match) return entry;
    const lineNumber = Number(match[2]);
    const excerpt = lines[lineNumber - 1];
    return excerpt === undefined
      ? entry
      : `${entry}\n    ${lineNumber.toString().padStart(4)} | ${excerpt.trim()}`;
  });
  return `${label}:\n${annotated.join('\n')}`;
}

/** @private Compila um shader e devolve o handle (lança com log anotado). */
function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`postprocessing.js: falha ao criar shader (${label}).`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (!ok) {
    const log = annotateShaderLog(gl.getShaderInfoLog(shader), source, label);
    gl.deleteShader(shader);
    const error = new Error(`postprocessing.js: erro de compilação.\n${log}`);
    error.shaderLog = log;
    error.source = source;
    error.stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw error;
  }
  return shader;
}

/**
 * Programa GLSL de pós-processamento com introspecção de uniforms, envio por
 * tipo e alocação automática de unidades de textura.
 *
 * É deliberadamente independente de `shaders.js` (que continua sendo o dono
 * dos programas PBR). Os dois podem coexistir no mesmo contexto.
 */
export class GLProgram {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {object} options
   * @param {string} options.vertex fonte do vertex shader
   * @param {string} options.fragment fonte do fragment shader
   * @param {string} [options.name]
   * @param {Record<string, string|number|boolean>} [options.defines] injetados no topo
   * @param {string[]} [options.extensions] `#extension ... : enable` antes dos defines
   * @param {boolean} [options.throwOnError=true]
   * @param {(diagnostic:object)=>void} [options.onError]
   */
  constructor(gl, options = {}) {
    if (!gl) throw new Error('postprocessing.js: contexto WebGL ausente.');
    this.gl = gl;
    this.name = options.name ?? 'post-program';
    this.program = null;
    this.uniforms = new Map();
    this.attributes = new Map();
    this.textureUnits = new Map();
    this.nextUnit = 0;
    this.compileError = null;
    this.vertexSource = options.vertex ?? QUAD_VERTEX_SHADER;
    this.fragmentSource = options.fragment ?? '';
    this.defines = { ...(options.defines ?? {}) };
    this.extensions = [...(options.extensions ?? [])];
    this.disposed = false;
    this.throwOnError = options.throwOnError !== false;
    this.onError = typeof options.onError === 'function' ? options.onError : null;

    const vertexSource = withDefines(this.vertexSource, this.defines, this.extensions);
    const fragmentSource = withDefines(this.fragmentSource, this.defines, this.extensions);
    this._finalSources = { vertex: vertexSource, fragment: fragmentSource };

    const gl2 = this.gl;
    let vs = null;
    let fs = null;
    try {
      vs = compileShader(gl2, gl2.VERTEX_SHADER, vertexSource, `${this.name}.vert`);
      fs = compileShader(gl2, gl2.FRAGMENT_SHADER, fragmentSource, `${this.name}.frag`);
      const program = gl2.createProgram();
      if (!program) throw new Error('postprocessing.js: falha ao criar programa.');
      gl2.attachShader(program, vs);
      gl2.attachShader(program, fs);
      gl2.bindAttribLocation?.(program, 0, 'aPosition');
      gl2.bindAttribLocation?.(program, 1, 'aUv');
      gl2.linkProgram(program);
      const linked = gl2.getProgramParameter(program, gl2.LINK_STATUS);
      if (!linked) {
        throw new Error(`postprocessing.js: erro de link.\n${gl2.getProgramInfoLog(program)}`);
      }
      this.program = program;
      this._introspect();
    } catch (error) {
      this.compileError = {
        name: this.name,
        message: error.message,
        log: error.shaderLog ?? String(error.message),
        source: error.source ?? '',
        stage: error.stage ?? 'link',
      };
      if (this.onError) {
        try { this.onError(this.compileError); } catch { /* não mascara o erro */ }
      }
      if (this.throwOnError) throw error;
    } finally {
      if (vs) gl2.deleteShader(vs);
      if (fs) gl2.deleteShader(fs);
    }
  }

  /** @private Lê uniforms e atributos ativos. */
  _introspect() {
    const gl = this.gl;
    if (!this.program || typeof gl.getProgramParameter !== 'function') return;
    const uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < uniformCount; i++) {
      const info = gl.getActiveUniform(this.program, i);
      if (!info) continue;
      const baseName = String(info.name).replace(/\[0\]$/, '');
      let location = gl.getUniformLocation(this.program, info.name);
      if (location === null || location === undefined) {
        location = gl.getUniformLocation(this.program, baseName);
      }
      if (location === null || location === undefined) continue;
      this.uniforms.set(baseName, { name: baseName, type: info.type, size: info.size ?? 1, location });
    }
    const attributeCount = gl.getProgramParameter(this.program, gl.ACTIVE_ATTRIBUTES) || 0;
    for (let i = 0; i < attributeCount; i++) {
      const info = gl.getActiveAttrib(this.program, i);
      if (!info) continue;
      const location = gl.getAttribLocation(this.program, info.name);
      if (location >= 0) this.attributes.set(info.name, location);
    }
  }

  /** Ativa o programa. */
  use() {
    if (this.disposed) throw new Error(`postprocessing.js: programa "${this.name}" liberado.`);
    if (this.program) this.gl.useProgram(this.program);
    return this;
  }

  /** `true` se o uniforme está ativo no programa. */
  has(name) { return this.uniforms.has(name); }

  /** Localização de um atributo (-1 se ausente). */
  getAttribLocation(name) {
    const known = this.attributes.get(name);
    if (known !== undefined) return known;
    if (!this.program) return -1;
    return this.gl.getAttribLocation(this.program, name);
  }

  /**
   * Envia um uniforme. Samplers recebem a textura (ou `null`) e ganham
   * unidade própria; demais tipos são despachados pelo `type` do driver.
   *
   * @returns {boolean} `true` se o valor foi enviado
   */
  set(name, value) {
    const uniform = this.uniforms.get(name);
    if (!uniform || value === undefined) return false;
    const gl = this.gl;
    const { type, location } = uniform;

    if (isSamplerType(type)) return this.bindTexture(name, value);

    switch (type) {
      case gl.FLOAT:
        if (typeof value === 'number') gl.uniform1f(location, value);
        else gl.uniform1fv(location, toFloat32(value));
        return true;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(location, toFloat32(value, 2));
        return true;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(location, toFloat32(value, 3));
        return true;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(location, toFloat32(value, 4));
        return true;
      case gl.INT:
      case gl.BOOL:
        if (typeof value === 'boolean') gl.uniform1i(location, value ? 1 : 0);
        else if (typeof value === 'number') gl.uniform1i(location, value | 0);
        else gl.uniform1iv(location, new Int32Array(value));
        return true;
      case gl.INT_VEC2:
        gl.uniform2iv(location, new Int32Array(value));
        return true;
      case gl.INT_VEC3:
        gl.uniform3iv(location, new Int32Array(value));
        return true;
      case gl.INT_VEC4:
        gl.uniform4iv(location, new Int32Array(value));
        return true;
      case gl.FLOAT_MAT2:
        gl.uniformMatrix2fv(location, false, toFloat32(value, 4));
        return true;
      case gl.FLOAT_MAT3:
        gl.uniformMatrix3fv(location, false, toFloat32(value, 9));
        return true;
      case gl.FLOAT_MAT4:
        gl.uniformMatrix4fv(location, false, toFloat32(value, 16));
        return true;
      default:
        return false;
    }
  }

  /** Envia vários uniforms de uma vez. */
  setUniforms(values = {}) {
    for (const key of Object.keys(values)) {
      if (values[key] === undefined) continue;
      this.set(key, values[key]);
    }
    return this;
  }

  /**
   * Vincula uma textura a um sampler (com unidade estável por nome).
   * Aceita `WebGLTexture`, `RenderTarget`, `{ texture }`, canvas ou `null`.
   */
  bindTexture(name, value) {
    const uniform = this.uniforms.get(name);
    if (!uniform) return false;
    const gl = this.gl;
    let texture = null;
    if (value) {
      if (value.isRenderTarget && value.texture) texture = value.texture;
      else if (value.texture && !value.isRenderTarget) texture = value.texture;
      else if (this._isTexture(value)) texture = value;
    }
    let unit = this.textureUnits.get(name);
    if (unit === undefined) {
      const max = (gl.getParameter?.(gl.MAX_TEXTURE_IMAGE_UNITS) || 16);
      unit = this.nextUnit % Math.max(1, max);
      this.nextUnit += 1;
      this.textureUnits.set(name, unit);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniform.location, unit);
    return true;
  }

  /** @private Heurística de `WebGLTexture`. */
  _isTexture(value) {
    if (!value || typeof value !== 'object') return false;
    if (typeof WebGLTexture !== 'undefined' && value instanceof WebGLTexture) return true;
    // Texturas de canvas/imagem são convertidas em textura pelo chamador.
    return false;
  }

  /** Libera o programa. */
  dispose() {
    if (this.disposed) return;
    if (this.program) {
      try { this.gl.deleteProgram(this.program); } catch { /* ignore */ }
    }
    this.program = null;
    this.uniforms.clear();
    this.attributes.clear();
    this.textureUnits.clear();
    this.disposed = true;
  }
}

/** @private Tipos de sampler em WebGL1/2. */
function isSamplerType(type) {
  return type === 0x8B5E // SAMPLER_2D
    || type === 0x8B5F // SAMPLER_3D
    || type === 0x8B60 // SAMPLER_CUBE
    || type === 0x8DC1 // SAMPLER_2D_ARRAY
    || type === 0x8DC4 // SAMPLER_2D_SHADOW
    || type === 0x8DC5; // SAMPLER_CUBE_SHADOW
}

/** @private Converte arrays/objetos para Float32Array do tamanho pedido. */
function toFloat32(value, size = 0) {
  if (ArrayBuffer.isView(value)) {
    if (size && value.length === size) return value instanceof Float32Array ? value : new Float32Array(value);
    return new Float32Array(value);
  }
  if (Array.isArray(value)) return new Float32Array(value);
  if (size === 1) return new Float32Array([Number(value) || 0]);
  if (value && typeof value === 'object') {
    const keys = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'];
    const out = new Float32Array(size || 4);
    for (let i = 0; i < out.length; i++) {
      const k = keys[i];
      out[i] = Number(value[k] ?? value[i] ?? 0) || 0;
    }
    return out;
  }
  return new Float32Array(size || 1);
}

/**
 * @private Antepõe `#extension` + `#define` à fonte.
 * Diretivas de extensão precisam vir antes de qualquer outro token.
 */
function withDefines(source, defines = {}, extensions = []) {
  const lines = [];
  for (const extension of extensions ?? []) {
    if (extension) lines.push(`#extension ${extension} : enable`);
  }
  for (const [key, value] of Object.entries(defines ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    lines.push(value === true ? `#define ${key}` : `#define ${key} ${value}`);
  }
  if (!lines.length) return source;
  return `${lines.join('\n')}\n${source}`;
}

/**
 * Quad de tela cheia compartilhado por todos os passes. Um único VBO
 * intercalado (`aPosition`, `aUv`) e, em WebGL2, um VAO opcional.
 */
export class FullscreenQuad {
  /** @param {WebGLRenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    this.buffer = gl.createBuffer();
    this.vao = null;
    // 6 vértices (2 triângulos), intercalados: x, y, u, v.
    const data = new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      -1, 1, 0, 1,
      -1, 1, 0, 1,
      1, -1, 1, 0,
      1, 1, 1, 1,
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    if (typeof gl.createVertexArray === 'function') {
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  /**
   * Desenha o quad com o programa informado.
   * @param {GLProgram} program
   */
  draw(program) {
    const gl = this.gl;
    if (!program || !program.program) return;
    program.use();
    if (this.vao && typeof gl.bindVertexArray === 'function') {
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
      return;
    }
    const positionLoc = program.getAttribLocation('aPosition');
    const uvLoc = program.getAttribLocation('aUv');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (positionLoc >= 0) {
      gl.enableVertexAttribArray(positionLoc);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);
    }
    if (uvLoc >= 0) {
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Libera o VBO/VAO. */
  dispose() {
    const gl = this.gl;
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.vao && typeof gl.deleteVertexArray === 'function') gl.deleteVertexArray(this.vao);
    this.buffer = null;
    this.vao = null;
  }
}

/* ========================================================================== */
/*  4. Framebuffer objects                                                    */
/* ========================================================================== */

/** Formatos de render target suportados. */
export const RENDER_TARGET_FORMATS = Object.freeze([
  'rgba8', 'rgba16f', 'rgba32f', 'r16f', 'rg8', 'auto',
]);

/**
 * Resolve o trio `internalFormat / format / type` para o contexto.
 *
 * @param {WebGLRenderingContext} gl
 * @param {object} caps saída de `describeGLCapabilities`
 * @param {string} requested `rgba8`, `rgba16f`, `rgba32f`, `r16f`, `auto`
 * @param {{ hdr?: boolean }} [options]
 * @returns {{ internalFormat:number, format:number, type:number, hdr:boolean, label:string }}
 */
export function resolveTextureFormat(gl, caps, requested = 'auto', options = {}) {
  const wantHdr = options.hdr !== false;
  const is2 = !!caps?.isWebGL2;
  const halfType = is2 ? gl.HALF_FLOAT : getGLExtension(gl, 'OES_texture_half_float')?.HALF_FLOAT_OES;
  const canHalf = !!caps?.colorBufferHalfFloat && halfType !== undefined;
  const canFloat = !!caps?.colorBufferFloat;

  const rgba8 = { internalFormat: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, hdr: false, label: 'rgba8' };
  const rgba16f = (canHalf || (is2 && canFloat))
    ? {
      internalFormat: is2 ? gl.RGBA16F : gl.RGBA,
      format: gl.RGBA,
      type: canHalf ? halfType : gl.FLOAT,
      hdr: true,
      label: 'rgba16f',
    }
    : null;
  const rgba32f = canFloat
    ? { internalFormat: is2 ? gl.RGBA32F : gl.RGBA, format: gl.RGBA, type: gl.FLOAT, hdr: true, label: 'rgba32f' }
    : null;
  const r16f = (canHalf || (is2 && canFloat)) && is2
    ? { internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT, hdr: true, label: 'r16f' }
    : null;
  const rg8 = { internalFormat: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, hdr: false, label: 'rg8' };

  const resolved = requested === 'auto'
    ? (wantHdr && rgba16f ? 'rgba16f' : 'rgba8')
    : requested;

  switch (resolved) {
    case 'rgba16f': return rgba16f ?? rgba8;
    case 'rgba32f': return rgba32f ?? rgba16f ?? rgba8;
    case 'r16f': return r16f ?? rgba16f ?? rgba8;
    case 'rg8': return rg8;
    case 'rgba8':
    default: return rgba8;
  }
}

/**
 * Framebuffer object com textura de cor, profundidade opcional (textura ou
 * renderbuffer), MSAA (WebGL2) e resolução automática.
 *
 * @example
 *   const rt = new RenderTarget(gl, { width: 1280, height: 720, format: 'rgba16f' });
 *   rt.bind(); gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); rt.unbind();
 *   skybox.bindTexture('uScene', rt);
 */
export class RenderTarget {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {object} [options]
   * @param {number} [options.width=1]
   * @param {number} [options.height=1]
   * @param {string} [options.format='auto'] `rgba8|rgba16f|rgba32f|r16f|rg8|auto`
   * @param {boolean|'texture'|'renderbuffer'} [options.depth=false]
   * @param {'linear'|'nearest'} [options.filter='linear']
   * @param {'clamp'|'repeat'} [options.wrap='clamp']
   * @param {number} [options.samples=0] amostras MSAA (WebGL2)
   * @param {boolean} [options.mipmaps=false]
   * @param {string} [options.name='rt']
   * @param {object} [options.capabilities] saída de `describeGLCapabilities`
   */
  constructor(gl, options = {}) {
    if (!gl) throw new Error('postprocessing.js: contexto WebGL ausente para RenderTarget.');
    this.gl = gl;
    this.name = options.name ?? 'rt';
    this.capabilities = options.capabilities ?? describeGLCapabilities(gl);
    this.width = Math.max(1, Math.round(options.width ?? 1));
    this.height = Math.max(1, Math.round(options.height ?? 1));
    this.filter = options.filter ?? 'linear';
    this.wrap = options.wrap ?? 'clamp';
    this.depthMode = options.depth === true ? 'renderbuffer' : (options.depth || false);
    this.samples = Math.max(0, Math.round(options.samples ?? 0));
    this.mipmaps = !!options.mipmaps;
    this.requestedFormat = options.format ?? 'auto';
    this.wantHdr = options.hdr !== false;

    const format = resolveTextureFormat(gl, this.capabilities, this.requestedFormat, { hdr: this.wantHdr });
    this.formatInfo = format;
    this.format = format.label;
    this.isHdr = format.hdr;

    this.framebuffer = null;
    this.texture = null;
    this.depthTexture = null;
    this.depthRenderbuffer = null;
    this.colorRenderbuffer = null;
    this.msaaDepthRenderbuffer = null;
    this.multisampleFramebuffer = null;
    this.disposed = false;

    this._create();
  }

  /** Marca a instância como render target (usado por `GLProgram.bindTexture`). */
  get isRenderTarget() { return true; }

  /** Tamanho em texels (`[1/width, 1/height]`). */
  get texelSize() { return [1 / this.width, 1 / this.height]; }

  /** Proporção largura/altura. */
  get aspect() { return this.width / this.height; }

  /** `true` se o alvo usa MSAA. */
  get multisampled() {
    return this.samples > 0 && !!this.multisampleFramebuffer
      && typeof this.gl.blitFramebuffer === 'function';
  }

  /** @private Cria textura, renderbuffers e FBOs. */
  _create() {
    const gl = this.gl;
    // Em um contexto WebGL real a constante é `gl.TEXTURE_2D` — não existe
    // `gl.GL_TEXTURE_2D`. Com o nome errado, `undefined` é passado como
    // target e bindTexture/texParameteri/texImage2D falham com INVALID_ENUM,
    // deixando o FBO incompleto e a tela preta.
    const GL_TEXTURE_2D = gl.TEXTURE_2D;
    const filter = this.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    const wrap = this.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;

    this.texture = gl.createTexture();
    gl.bindTexture(GL_TEXTURE_2D, this.texture);
    gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.pixelStorei?.(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      GL_TEXTURE_2D, 0,
      this.formatInfo.internalFormat, this.width, this.height, 0,
      this.formatInfo.format, this.formatInfo.type, null,
    );

    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, GL_TEXTURE_2D, this.texture, 0);

    if (this.depthMode === 'texture') {
      this.depthTexture = gl.createTexture();
      gl.bindTexture(GL_TEXTURE_2D, this.depthTexture);
      gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(GL_TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const depthInternal = this.capabilities.isWebGL2 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT;
      gl.texImage2D(GL_TEXTURE_2D, 0, depthInternal, this.width, this.height, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, GL_TEXTURE_2D, this.depthTexture, 0);
    } else if (this.depthMode === 'renderbuffer') {
      this.depthRenderbuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRenderbuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.width, this.height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRenderbuffer);
    }

    this.framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

    // MSAA: renderbuffer colorido + FBO próprio; a textura acima vira o alvo
    // do resolve (blit) em `resolve()`.
    if (this.samples > 0 && this.capabilities.isWebGL2 && this.capabilities.blitFramebuffer
        && typeof gl.renderbufferStorageMultisample === 'function') {
      const maxSamples = Math.min(this.samples, this.capabilities.maxSamples || 4);
      this.colorRenderbuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorRenderbuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, maxSamples, this.formatInfo.internalFormat,
        this.width, this.height);
      this.multisampleFramebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.multisampleFramebuffer);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.colorRenderbuffer);
      // O FBO multisample precisa de um depth com o MESMO número de amostras;
      // o depth single-sample continua no FBO de resolve (usado no blit).
      if (this.depthMode) {
        this.msaaDepthRenderbuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaDepthRenderbuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, maxSamples, gl.DEPTH_COMPONENT16,
          this.width, this.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER,
          this.msaaDepthRenderbuffer);
      }
      this.samples = maxSamples;
      this.multisampleStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (this.multisampleStatus !== gl.FRAMEBUFFER_COMPLETE) {
        // MSAA não suportado para este formato neste driver: desativa em vez
        // de renderizar num FBO incompleto (todos os pixels seriam
        // descartados e a tela ficaria preta).
        gl.deleteFramebuffer(this.multisampleFramebuffer);
        gl.deleteRenderbuffer(this.colorRenderbuffer);
        if (this.msaaDepthRenderbuffer) gl.deleteRenderbuffer(this.msaaDepthRenderbuffer);
        this.multisampleFramebuffer = null;
        this.colorRenderbuffer = null;
        this.msaaDepthRenderbuffer = null;
        this.samples = 0;
      }
    } else {
      this.samples = 0;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(GL_TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.disposed = false;
  }

  /** Vincula o FBO (MSAA quando ativo) e ajusta o viewport. */
  bind({ viewport = true } = {}) {
    const gl = this.gl;
    const target = this.multisampled ? this.multisampleFramebuffer : this.framebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    if (viewport) gl.viewport(0, 0, this.width, this.height);
    return this;
  }

  /** Volta ao framebuffer padrão. */
  unbind(viewport = null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (viewport) gl.viewport(0, 0, viewport[0], viewport[1]);
    return this;
  }

  /** Resolve o MSAA para a textura amostrável. */
  resolve() {
    if (!this.multisampled) return this;
    const gl = this.gl;
    if (typeof gl.blitFramebuffer !== 'function') return this;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.multisampleFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this;
  }

  /** Redimensiona textura/renderbuffers preservando o formato. */
  resize(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return this;
    this.width = w;
    this.height = h;
    this.dispose(false);
    this._create();
    return this;
  }

  /** Limpa o alvo. */
  clear(r = 0, g = 0, b = 0, a = 1) {
    const gl = this.gl;
    this.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT | (this.depthMode ? gl.DEPTH_BUFFER_BIT : 0));
    return this;
  }

  /**
   * Lê um pixel (principalmente para testes/depuração).
   * @returns {Uint8Array|Float32Array|null}
   */
  readPixel(x = 0, y = 0) {
    const gl = this.gl;
    this.bind();
    const isFloat = this.formatInfo.type === gl.FLOAT;
    const buffer = isFloat ? new Float32Array(4) : new Uint8Array(4);
    try {
      gl.readPixels(x, y, 1, 1, gl.RGBA,
        isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, buffer);
    } catch {
      this.unbind();
      return null;
    }
    this.unbind();
    return buffer;
  }

  /**
   * Copia (blit) um alvo para outro, com filtro explícito.
   * @param {RenderTarget} source
   * @param {RenderTarget} destination
   */
  static blit(source, destination, filter = 'linear') {
    const gl = source.gl;
    if (typeof gl.blitFramebuffer !== 'function') return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.multisampled ? source.multisampleFramebuffer : source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, destination.framebuffer);
    gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, destination.width, destination.height,
      gl.COLOR_BUFFER_BIT, filter === 'nearest' ? gl.NEAREST : gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Libera todos os recursos GL. */
  dispose(destroy = true) {
    const gl = this.gl;
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    if (this.multisampleFramebuffer) gl.deleteFramebuffer(this.multisampleFramebuffer);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.depthTexture) gl.deleteTexture(this.depthTexture);
    if (this.depthRenderbuffer) gl.deleteRenderbuffer(this.depthRenderbuffer);
    if (this.colorRenderbuffer) gl.deleteRenderbuffer(this.colorRenderbuffer);
    if (this.msaaDepthRenderbuffer) gl.deleteRenderbuffer(this.msaaDepthRenderbuffer);
    this.framebuffer = null;
    this.multisampleFramebuffer = null;
    this.texture = null;
    this.depthTexture = null;
    this.depthRenderbuffer = null;
    this.colorRenderbuffer = null;
    this.msaaDepthRenderbuffer = null;
    if (destroy) this.disposed = true;
  }
}

/** Atalho para criar um `RenderTarget`. */
export function createRenderTarget(gl, options = {}) {
  return new RenderTarget(gl, options);
}

/**
 * Pool de render targets com reaproveitamento por assinatura
 * (`largura × altura × formato × depth × samples`), evitando realocações por
 * quadro durante o bloom e os passes de meia resolução.
 */
export class RenderTargetPool {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {object} [options]
   * @param {object} [options.capabilities]
   * @param {number} [options.maxEntries=24]
   */
  constructor(gl, options = {}) {
    this.gl = gl;
    this.capabilities = options.capabilities ?? describeGLCapabilities(gl);
    this.maxEntries = options.maxEntries ?? 24;
    this.entries = [];
    this.stats = { acquires: 0, releases: 0, created: 0, reused: 0, disposed: 0 };
  }

  /** @private Chave estável de uma requisição. */
  static keyOf(options = {}) {
    return [
      options.width | 0,
      options.height | 0,
      options.format ?? 'auto',
      options.depth ? 1 : 0,
      options.samples ?? 0,
      options.filter ?? 'linear',
      options.hdr === false ? 0 : 1,
    ].join(':');
  }

  /**
   * Obtém um alvo livre compatível (ou cria um novo).
   * @param {object} options mesmas opções de `RenderTarget`
   */
  acquire(options = {}) {
    const width = Math.max(1, Math.round(options.width ?? 1));
    const height = Math.max(1, Math.round(options.height ?? 1));
    const key = RenderTargetPool.keyOf({ ...options, width, height });
    this.stats.acquires += 1;
    for (const entry of this.entries) {
      if (entry.inUse || entry.key !== key) continue;
      entry.inUse = true;
      this.stats.reused += 1;
      return entry.target;
    }
    const target = new RenderTarget(this.gl, {
      width,
      height,
      format: options.format ?? 'auto',
      depth: options.depth ?? false,
      samples: options.samples ?? 0,
      filter: options.filter ?? 'linear',
      wrap: options.wrap ?? 'clamp',
      hdr: options.hdr,
      name: options.name ?? 'pool',
      capabilities: this.capabilities,
    });
    this.entries.push({ key, target, inUse: true });
    this.stats.created += 1;
    this._trim();
    return target;
  }

  /** Devolve um alvo ao pool. */
  release(target) {
    if (!target) return this;
    for (const entry of this.entries) {
      if (entry.target === target) {
        entry.inUse = false;
        this.stats.releases += 1;
        return this;
      }
    }
    return this;
  }

  /** @private Remove alvos ociosos além de `maxEntries`. */
  _trim() {
    if (this.entries.length <= this.maxEntries) return;
    for (let i = this.entries.length - 1; i >= 0 && this.entries.length > this.maxEntries; i--) {
      if (this.entries[i].inUse) continue;
      this.entries[i].target.dispose();
      this.stats.disposed += 1;
      this.entries.splice(i, 1);
    }
  }

  /** Quantidade de alvos vivos. */
  get size() { return this.entries.length; }

  /** Libera todos os alvos. */
  dispose() {
    for (const entry of this.entries) entry.target.dispose();
    this.entries.length = 0;
  }
}

/* ========================================================================== */
/*  5. Biblioteca GLSL                                                        */
/* ========================================================================== */
/*
 *  Convenções (válidas em GLSL ES 1.00, portanto WebGL1 e WebGL2):
 *   - `vUv` (0,0) no canto inferior esquerdo, igual à origem do framebuffer;
 *   - profundidade linear normalizada [0, 1] empacotada em RG (16 bits);
 *   - normais em espaço de câmera codificadas como `n * 0.5 + 0.5`;
 *   - loops com limites constantes (`#define`) para compatibilidade total;
 *   - nenhuma textura de profundidade nativa é amostrada (evita
 *     WEBGL_depth_texture e diferenças de codificação).
 */

/** Vertex shader comum dos passes (quad de tela cheia). */
export const QUAD_VERTEX_SHADER = `attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/**
 * Chunk comum: precisão, ruído, sRGB, profundidade empacotada e as curvas de
 * tone mapping (idênticas às versões CPU de `applyToneMapping`).
 */
export const GLSL_POST_COMMON = `precision highp float;
varying vec2 vUv;

const float PP_PI = 3.141592653589793;
const float PP_TAU = 6.283185307179586;

float ppLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float ppHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float ppHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// Ruído de gradiente intercalado (Jimenez 2014) — bom para dithering/grão.
float ppIgn(vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

vec3 ppSrgbEncode(vec3 c) {
  vec3 v = max(c, vec3(0.0));
  vec3 lo = v * 12.92;
  vec3 hi = 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), v));
}

vec3 ppSrgbDecode(vec3 c) {
  vec3 v = max(c, vec3(0.0));
  return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v));
}

// Profundidade linear normalizada em 16 bits (R = alto, G = baixo).
vec4 ppPackDepth(float d) {
  float v = clamp(d, 0.0, 1.0) * 255.0;
  return vec4(floor(v) / 255.0, fract(v), 0.0, 1.0);
}

float ppUnpackDepth(vec4 pk) {
  return pk.r + pk.g / 255.0;
}

vec3 ppViewPosition(vec2 uv, float depth, vec2 nearFar, vec2 projection, vec2 orthoSize, float ortho) {
  float dist = mix(nearFar.x, nearFar.y, clamp(depth, 0.0, 1.0));
  vec2 ndc = uv * 2.0 - 1.0;
  if (ortho > 0.5) return vec3(ndc * orthoSize, -dist);
  float z = max(dist, 1e-4);
  return vec3(ndc.x * z / max(projection.x, 1e-4), ndc.y * z / max(projection.y, 1e-4), -z);
}

vec2 ppProjectView(vec3 p, vec2 nearFar, vec2 projection, vec2 orthoSize, float ortho) {
  if (ortho > 0.5) return (p.xy / max(orthoSize, vec2(1e-4))) * 0.5 + 0.5;
  float z = max(-p.z, 1e-4);
  return (p.xy * projection / z) * 0.5 + 0.5;
}

vec3 ppAcesTone(vec3 x) {
  vec3 v = max(x, vec3(0.0)) * 0.6;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.432951) + 0.238081;
  return clamp(a / b, 0.0, 1.0);
}

vec3 ppHableCurve(vec3 x) {
  return (x * (0.15 * x + 0.05) + 0.004) / (x * (0.15 * x + 0.5) + 0.06);
}

vec3 ppHableTone(vec3 x) {
  return clamp(ppHableCurve(max(x, vec3(0.0))) / ppHableCurve(vec3(11.2)), 0.0, 1.0);
}

vec3 ppReinhardTone(vec3 x) {
  vec3 v = max(x, vec3(0.0));
  return v / (vec3(1.0) + v);
}

vec3 ppReinhardExtendedTone(vec3 x, float white) {
  vec3 v = max(x, vec3(0.0));
  float w = max(white, 1.0);
  return clamp((v * (vec3(1.0) + v / (w * w))) / (vec3(1.0) + v), 0.0, 1.0);
}

vec3 ppTonemap(vec3 color, float whitePoint) {
#if TONEMAP_MODE == 1
  return ppHableTone(color);
#elif TONEMAP_MODE == 2
  return ppReinhardTone(color);
#elif TONEMAP_MODE == 3
  return ppReinhardExtendedTone(color, whitePoint);
#elif TONEMAP_MODE == 4
  return clamp(color, 0.0, 1.0);
#else
  return ppAcesTone(color);
#endif
}

vec3 ppNormalFromTexture(vec4 encoded) {
  return normalize(encoded.xyz * 2.0 - 1.0);
}
`;

/** Chunk de normais a partir da profundidade (opcional, via derivadas). */
export const GLSL_NORMAL_FROM_DEPTH = `#ifdef PP_DERIVATIVES
vec3 ppNormalFromDepth(vec2 uv, vec3 viewPos, sampler2D depthTex, vec2 nearFar,
                       vec2 projection, vec2 orthoSize, float ortho) {
  vec2 texel = vec2(dFdx(uv.x), dFdy(uv.y));
  vec3 pR = ppViewPosition(uv + vec2(texel.x, 0.0),
    ppUnpackDepth(texture2D(depthTex, uv + vec2(texel.x, 0.0))), nearFar, projection, orthoSize, ortho);
  vec3 pU = ppViewPosition(uv + vec2(0.0, texel.y),
    ppUnpackDepth(texture2D(depthTex, uv + vec2(0.0, texel.y))), nearFar, projection, orthoSize, ortho);
  vec3 n = normalize(cross(pR - viewPos, pU - viewPos));
  return n.z < 0.0 ? -n : n;
}
#endif
`;

/* ------------------------------- passes ---------------------------------- */

/** Bright pass: threshold com joelho suave + realce de chamas. */
export const BRIGHT_PASS_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uIntensity;
uniform float uFlameBoost;
uniform vec3 uTint;
uniform float uTintStrength;

void main() {
  vec2 h = uTexel * 0.5;
  vec3 color = texture2D(uScene, vUv + vec2(-h.x, -h.y)).rgb;
  color += texture2D(uScene, vUv + vec2(h.x, -h.y)).rgb;
  color += texture2D(uScene, vUv + vec2(-h.x, h.y)).rgb;
  color += texture2D(uScene, vUv + vec2(h.x, h.y)).rgb;
  color *= 0.25;

  float l = ppLuma(color);
  float knee = max(uKnee, 1e-4);
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);
  float weight = max(soft, l - uThreshold) / max(l, 1e-5);
  vec3 result = color * weight;

  // Chamas no vácuo: espectro quente domina e espalha mais que o branco solar.
  float warmth = clamp((color.r - color.b) / max(color.r, 1e-4), 0.0, 1.0);
  result *= 1.0 + warmth * uFlameBoost;
  result = mix(result, result * uTint, uTintStrength * warmth);

  gl_FragColor = vec4(result * uIntensity, 1.0);
}`;

/** Downsample 13 taps (dual filtering — Jimenez/COD). */
export const BLOOM_DOWN_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uSource;
uniform vec2 uTexel;

void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(uSource, vUv + t * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture2D(uSource, vUv + t * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture2D(uSource, vUv + t * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture2D(uSource, vUv + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture2D(uSource, vUv).rgb;
  vec3 f = texture2D(uSource, vUv + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture2D(uSource, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(uSource, vUv + t * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture2D(uSource, vUv + t * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture2D(uSource, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture2D(uSource, vUv + t * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture2D(uSource, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(uSource, vUv + t * vec2( 1.0, -1.0)).rgb;

  vec3 result = (a + b + d + e) * 0.03125;
  result += (b + c + e + f) * 0.03125;
  result += (d + e + g + h) * 0.03125;
  result += (e + f + h + i) * 0.03125;
  result += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(result, 1.0);
}`;

/** Upsample 9 taps (tent) com espalhamento — somado ao nível anterior. */
export const BLOOM_UP_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uScatter;
uniform float uRadius;

void main() {
  vec2 t = uTexel * max(uRadius, 0.5);
  vec3 s = texture2D(uSource, vUv + vec2(-t.x, -t.y)).rgb;
  s += texture2D(uSource, vUv + vec2(0.0, -t.y)).rgb * 2.0;
  s += texture2D(uSource, vUv + vec2(t.x, -t.y)).rgb;
  s += texture2D(uSource, vUv + vec2(-t.x, 0.0)).rgb * 2.0;
  s += texture2D(uSource, vUv).rgb * 4.0;
  s += texture2D(uSource, vUv + vec2(t.x, 0.0)).rgb * 2.0;
  s += texture2D(uSource, vUv + vec2(-t.x, t.y)).rgb;
  s += texture2D(uSource, vUv + vec2(0.0, t.y)).rgb * 2.0;
  s += texture2D(uSource, vUv + vec2(t.x, t.y)).rgb;
  gl_FragColor = vec4((s / 16.0) * uScatter, 1.0);
}`;

/** Streak anamórfico horizontal (chamas/plasma). */
export const BLOOM_STREAK_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uStep;
uniform float uIntensity;
uniform vec3 uTint;
#ifndef STREAK_TAPS
#define STREAK_TAPS 8
#endif

void main() {
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;
  for (int i = -STREAK_TAPS; i <= STREAK_TAPS; i++) {
    float w = 1.0 - abs(float(i)) / float(STREAK_TAPS + 1);
    vec2 offset = vec2(float(i) * uStep * uTexel.x, 0.0);
    sum += texture2D(uSource, vUv + offset).rgb * w;
    weightSum += w;
  }
  gl_FragColor = vec4((sum / max(weightSum, 1e-4)) * uTint * uIntensity, 1.0);
}`;

/** Tone mapping dedicado (HDR → LDR sRGB), com dithering opcional. */
export const TONEMAP_PASS_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uScene;
uniform float uExposure;
uniform float uWhitePoint;
uniform float uDither;
uniform float uTime;

void main() {
  vec3 color = texture2D(uScene, vUv).rgb * uExposure;
  vec3 mapped = ppTonemap(color, uWhitePoint);
  mapped = ppSrgbEncode(clamp(mapped, 0.0, 1.0));
  float dither = (ppIgn(gl_FragCoord.xy + uTime) - 0.5) * uDither / 255.0;
  gl_FragColor = vec4(clamp(mapped + dither, 0.0, 1.0), 1.0);
}`;

/** Cópia com utilitários de depuração (canais/profundidade). */
export const COPY_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uSource;
uniform float uChannel;
uniform float uScale;
uniform float uPackedDepth;
uniform float uDecodeSRGB;

void main() {
  vec4 texel = texture2D(uSource, vUv);
  vec3 color = texel.rgb;
  if (uChannel > 3.5) {
    color = vec3(ppUnpackDepth(texel));
  } else if (uChannel > 2.5) {
    color = vec3(texel.a);
  } else if (uChannel > 1.5) {
    color = vec3(texel.b);
  } else if (uChannel > 0.5) {
    color = vec3(texel.g);
  } else if (uChannel > 0.05 && uPackedDepth > 0.5) {
    color = vec3(ppUnpackDepth(texel));
  } else if (uChannel > 0.05) {
    color = vec3(texel.r);
  }
  color *= uScale;
  if (uDecodeSRGB > 0.5) color = ppSrgbDecode(color);
  gl_FragColor = vec4(color, 1.0);
}`;

/** SSAO por hemisfério (kernel procedural + rotação por pixel). */
export const SSAO_FRAGMENT = `${GLSL_POST_COMMON}${GLSL_NORMAL_FROM_DEPTH}
uniform sampler2D uDepth;
uniform sampler2D uNormals;
uniform vec2 uTexel;
uniform vec2 uNearFar;
uniform vec2 uProjection;
uniform vec2 uOrthoSize;
uniform float uOrtho;
uniform float uRadius;
uniform float uBias;
uniform float uIntensity;
uniform float uPower;
uniform float uFrame;
uniform float uHasNormals;
#ifndef AO_SAMPLES
#define AO_SAMPLES 16
#endif

void main() {
  float depth = ppUnpackDepth(texture2D(uDepth, vUv));
  if (depth >= 0.9995) {
    gl_FragColor = vec4(1.0);
    return;
  }
  vec3 P = ppViewPosition(vUv, depth, uNearFar, uProjection, uOrthoSize, uOrtho);
  vec3 N = vec3(0.0, 0.0, 1.0);
  if (uHasNormals > 0.5) {
    N = ppNormalFromTexture(texture2D(uNormals, vUv));
  }
#ifdef PP_DERIVATIVES
  if (uHasNormals < 0.5) {
    N = ppNormalFromDepth(vUv, P, uDepth, uNearFar, uProjection, uOrthoSize, uOrtho);
  }
#endif

  float angle = ppIgn(gl_FragCoord.xy + uFrame * 17.0) * PP_TAU;
  vec3 randomVec = vec3(cos(angle), sin(angle), 0.0);
  vec3 tangent = normalize(randomVec - N * dot(randomVec, N) + vec3(1e-5));
  vec3 bitangent = cross(N, tangent);

  float occlusion = 0.0;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float fi = (float(i) + 0.5) / float(AO_SAMPLES);
    float phi = float(i) * 2.39996323 + angle;
    float sinTheta = sqrt(fi);
    float cosTheta = sqrt(max(1.0 - fi, 0.0));
    vec3 localDir = vec3(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
    vec3 worldDir = tangent * localDir.x + bitangent * localDir.y + N * localDir.z;
    vec3 samplePos = P + worldDir * (uRadius * (0.25 + 0.75 * fi));
    vec2 suv = ppProjectView(samplePos, uNearFar, uProjection, uOrthoSize, uOrtho);
    float inRange = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
    float sceneDepth = ppUnpackDepth(texture2D(uDepth, clamp(suv, 0.0, 1.0)));
    vec3 scenePos = ppViewPosition(clamp(suv, 0.0, 1.0), sceneDepth, uNearFar, uProjection, uOrthoSize, uOrtho);
    float diff = (-samplePos.z) - (-scenePos.z);
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(abs(diff), 1e-4));
    occlusion += step(uBias, diff) * rangeCheck * inRange;
  }

  float ao = 1.0 - (occlusion / float(AO_SAMPLES)) * uIntensity;
  ao = pow(clamp(ao, 0.0, 1.0), uPower);
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;

/** Blur bilateral (separável) do SSAO, guiado pela profundidade. */
export const SSAO_BLUR_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uAO;
uniform sampler2D uDepth;
uniform vec2 uDirection;
uniform vec2 uTexel;
uniform float uDepthSigma;

void main() {
  float centerDepth = ppUnpackDepth(texture2D(uDepth, vUv));
  float sum = 0.0;
  float weightSum = 0.0;
  for (int i = -2; i <= 2; i++) {
    vec2 uv = vUv + uDirection * uTexel * float(i);
    float d = ppUnpackDepth(texture2D(uDepth, uv));
    float spatial = exp(-float(i * i) / 4.0);
    float range = 1.0 - smoothstep(0.0, max(uDepthSigma, 1e-4), abs(d - centerDepth));
    float w = spatial * range;
    sum += texture2D(uAO, uv).r * w;
    weightSum += w;
  }
  gl_FragColor = vec4(vec3(sum / max(weightSum, 1e-4)), 1.0);
}`;

/**
 * Sombras de contato em espaço de tela: marcha na direção da luz comparando
 * profundidades. Multiplicado sobre o AO (`DST_COLOR, ZERO`) gera penumbra
 * suave sem custo de shadow map.
 */
export const CONTACT_SHADOW_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform vec2 uLightDirection;
uniform float uRayLength;
uniform float uThickness;
uniform float uStrength;
uniform float uFrame;
#ifndef CONTACT_STEPS
#define CONTACT_STEPS 12
#endif

void main() {
  float depth = ppUnpackDepth(texture2D(uDepth, vUv));
  if (depth >= 0.9995) {
    gl_FragColor = vec4(1.0);
    return;
  }
  float jitter = ppIgn(gl_FragCoord.xy + uFrame * 13.0) * 0.5;
  float occlusion = 0.0;
  for (int i = 1; i <= CONTACT_STEPS; i++) {
    float t = (float(i) - jitter) / float(CONTACT_STEPS);
    vec2 uv = vUv + uLightDirection * uRayLength * t;
    float inRange = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    float sceneDepth = ppUnpackDepth(texture2D(uDepth, clamp(uv, 0.0, 1.0)));
    float blocked = step(uThickness, depth - sceneDepth) * inRange;
    occlusion += blocked * (1.0 - 0.7 * t);
  }
  float shade = 1.0 - clamp(occlusion / float(CONTACT_STEPS), 0.0, 1.0) * uStrength;
  gl_FragColor = vec4(vec3(clamp(shade, 0.0, 1.0)), 1.0);
}`;

/** Screen-space reflections com marcha em espaço de câmera e refinamento. */
export const SSR_FRAGMENT = `${GLSL_POST_COMMON}${GLSL_NORMAL_FROM_DEPTH}
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform sampler2D uNormals;
uniform sampler2D uMaterial;
uniform vec2 uTexel;
uniform vec2 uNearFar;
uniform vec2 uProjection;
uniform vec2 uOrthoSize;
uniform float uOrtho;
uniform float uMaxDistance;
uniform float uThickness;
uniform float uIntensity;
uniform float uFresnel;
uniform float uJitter;
uniform float uEdgeFade;
uniform float uFrame;
uniform float uHasNormals;
uniform float uHasMaterial;
#ifndef SSR_STEPS
#define SSR_STEPS 16
#endif

float ppEdge(vec2 uv) {
  vec2 e = vec2(smoothstep(0.0, uEdgeFade, uv.x), smoothstep(0.0, uEdgeFade, 1.0 - uv.x));
  vec2 f = vec2(smoothstep(0.0, uEdgeFade, uv.y), smoothstep(0.0, uEdgeFade, 1.0 - uv.y));
  return min(min(e.x, e.y), min(f.x, f.y));
}

void main() {
  float depth = ppUnpackDepth(texture2D(uDepth, vUv));
  if (depth >= 0.9995) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 P = ppViewPosition(vUv, depth, uNearFar, uProjection, uOrthoSize, uOrtho);
  vec3 N = vec3(0.0, 0.0, 1.0);
  if (uHasNormals > 0.5) {
    N = ppNormalFromTexture(texture2D(uNormals, vUv));
  }
#ifdef PP_DERIVATIVES
  if (uHasNormals < 0.5) {
    N = ppNormalFromDepth(vUv, P, uDepth, uNearFar, uProjection, uOrthoSize, uOrtho);
  }
#endif
  if (N.z < 0.05) N.z = 0.05;

  float mask = 1.0;
  if (uHasMaterial > 0.5) mask = clamp(texture2D(uMaterial, vUv).r, 0.0, 1.0);
  if (mask <= 0.004) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 V = normalize(-P);
  vec3 R = reflect(-V, N);
  if (R.z > 0.0) R.z = -R.z;          // nunca refletir para trás da câmera
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = mix(uFresnel, 1.0, pow(1.0 - ndv, 5.0));

  float stepLength = max(uMaxDistance, 0.01) / float(SSR_STEPS);
  float jitter = (ppIgn(gl_FragCoord.xy + uFrame * 23.0) - 0.5) * uJitter;
  vec3 ray = P + R * (stepLength * (0.5 + jitter));
  float previousDelta = -1.0;
  vec2 hitUv = vec2(0.0);
  float hit = 0.0;

  for (int i = 0; i < SSR_STEPS; i++) {
    vec2 uv = ppProjectView(ray, uNearFar, uProjection, uOrthoSize, uOrtho);
    float inRange = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    float sceneDepth = ppUnpackDepth(texture2D(uDepth, clamp(uv, 0.0, 1.0)));
    float sceneDist = mix(uNearFar.x, uNearFar.y, sceneDepth);
    float rayDist = -ray.z;
    float delta = rayDist - sceneDist;
    float crossed = inRange * step(previousDelta, 0.0) * step(0.0, delta) * (1.0 - hit);
    if (crossed > 0.5) {
      hitUv = uv;
      hit = 1.0;
    }
    previousDelta = delta;
    ray += R * stepLength;
  }

  vec3 reflected = vec3(0.0);
  if (hit > 0.5) {
    // Refinamento por bisseção entre o último ponto fora e o primeiro dentro.
    vec3 lo = ray - R * stepLength * 2.0;
    vec3 hi = ray;
    for (int j = 0; j < 5; j++) {
      vec3 mid = (lo + hi) * 0.5;
      vec2 uvM = ppProjectView(mid, uNearFar, uProjection, uOrthoSize, uOrtho);
      float dM = ppUnpackDepth(texture2D(uDepth, clamp(uvM, 0.0, 1.0)));
      float deltaM = (-mid.z) - mix(uNearFar.x, uNearFar.y, dM);
      if (deltaM < 0.0) lo = mid; else hi = mid;
    }
    hitUv = ppProjectView(hi, uNearFar, uProjection, uOrthoSize, uOrtho);
    reflected = texture2D(uScene, clamp(hitUv, 0.0, 1.0)).rgb;
  }

  float distanceFade = 1.0 - clamp(length(ray - P) / max(uMaxDistance, 0.01), 0.0, 1.0);
  float amount = hit * fresnel * mask * distanceFade * ppEdge(clamp(hitUv, 0.0, 1.0));
  gl_FragColor = vec4(reflected * amount * uIntensity, amount);
}`;

/**
 * Composição final: SSR + AO + bloom + exposição + tone mapping + grade +
 * vinheta + grão + dithering, com aberração cromática e distorção de lente
 * aplicadas na amostragem da cena.
 */
export const COMPOSITE_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uAO;
uniform sampler2D uSSR;
uniform float uBloomIntensity;
uniform float uBloomMode;
uniform float uAOIntensity;
uniform float uSSRIntensity;
uniform float uExposure;
uniform float uWhitePoint;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform float uTemperature;
uniform float uAberration;
uniform float uDistortion;
uniform float uZoom;
uniform float uHeat;
uniform float uSpeedBlur;
uniform float uTime;
uniform float uAspect;
uniform float uVignette;
uniform float uVignettePower;
uniform vec3 uVignetteColor;
uniform float uGrain;
uniform float uGrainShadow;
uniform float uDither;

vec2 ppDistort(vec2 uv, float amount) {
  vec2 c = uv - 0.5;
  c.x *= uAspect;
  float r2 = dot(c, c);
  c *= (1.0 + amount * r2) / max(uZoom, 1e-3);
  c.x /= uAspect;
  return c + 0.5;
}

vec3 ppSampleScene(vec2 uv) {
  vec2 uvR = ppDistort(uv, uDistortion + uAberration);
  vec2 uvG = ppDistort(uv, uDistortion);
  vec2 uvB = ppDistort(uv, uDistortion - uAberration);
  return vec3(
    texture2D(uScene, clamp(uvR, 0.0, 1.0)).r,
    texture2D(uScene, clamp(uvG, 0.0, 1.0)).g,
    texture2D(uScene, clamp(uvB, 0.0, 1.0)).b
  );
}

void main() {
  vec2 uv = vUv;

  // Tremulação térmica: camadas de ar quente subindo (mais forte embaixo).
  if (uHeat > 0.0005) {
    float rise = smoothstep(0.1, 1.0, 1.0 - uv.y);
    vec2 wobble = vec2(
      ppHash12(uv * vec2(70.0, 42.0) + vec2(0.0, uTime * 1.7)),
      ppHash12(uv * vec2(42.0, 70.0) - vec2(uTime * 1.3, 0.0))
    ) - 0.5;
    uv += wobble * uHeat * rise * 0.02;
  }

  vec3 color;
  if (uSpeedBlur > 0.001) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float t = float(i) / 5.0;
      acc += ppSampleScene(mix(uv, vec2(0.5), t * uSpeedBlur));
    }
    color = acc / 6.0;
  } else {
    color = ppSampleScene(uv);
  }

#ifdef PP_SSR
  vec4 ssr = texture2D(uSSR, clamp(uv, 0.0, 1.0));
  color += ssr.rgb * uSSRIntensity;
#endif
#ifdef PP_AO
  float ao = texture2D(uAO, clamp(uv, 0.0, 1.0)).r;
  color *= mix(1.0, ao, clamp(uAOIntensity, 0.0, 1.0));
#endif
#ifdef PP_BLOOM
  vec3 bloom = texture2D(uBloom, clamp(uv, 0.0, 1.0)).rgb * uBloomIntensity;
  // 0 = aditivo (físico), 1 = screen (não satura), 2 = suave (menos halo)
  if (uBloomMode > 1.5) {
    color += bloom * (1.0 - clamp(ppLuma(color) * 0.4, 0.0, 0.85));
  } else if (uBloomMode > 0.5) {
    color = 1.0 - (1.0 - clamp(color, 0.0, 1.0)) * (1.0 - clamp(bloom, 0.0, 1.0))
      + max(color - 1.0, 0.0);
  } else {
    color += bloom;
  }
#endif

  color *= max(uExposure, 0.0);
  vec3 mapped = ppTonemap(color, uWhitePoint);

  // Grade final (pós-tonemap: previsível e estável).
  float l = ppLuma(mapped);
  mapped = mix(vec3(l), mapped, uSaturation);
  mapped = (mapped - 0.5) * uContrast + 0.5 + uLift;
  mapped *= vec3(1.0 + 0.05 * uTemperature, 1.0, 1.0 - 0.05 * uTemperature);
  mapped = clamp(mapped, 0.0, 1.0);
#ifdef PP_OUTPUT_SRGB
  mapped = ppSrgbEncode(mapped);
#endif

  vec2 vc = vUv - 0.5;
  vc.x *= uAspect;
  float vig = 1.0 - smoothstep(0.35, 1.15, length(vc) * 1.15);
  vig = pow(clamp(vig, 0.0, 1.0), max(uVignettePower, 0.01));
  mapped = mix(mapped, uVignetteColor, clamp((1.0 - vig) * uVignette, 0.0, 1.0));

  float grain = ppHash12(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5;
  float grainWeight = uGrain * mix(1.0 + uGrainShadow, 1.0, clamp(ppLuma(mapped), 0.0, 1.0));
  mapped += grain * grainWeight;

  mapped += (ppIgn(gl_FragCoord.xy) - 0.5) * uDither / 255.0;

  gl_FragColor = vec4(clamp(mapped, 0.0, 1.0), 1.0);
}`;

/** FXAA 3.11 (qualidade média) aplicado ao resultado LDR. */
export const FXAA_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uEdgeThreshold;
uniform float uEdgeMinimum;

float ppLumaAt(vec2 uv) {
  return ppLuma(texture2D(uSource, uv).rgb);
}

void main() {
  vec3 rgbM = texture2D(uSource, vUv).rgb;
  float lumaM = ppLuma(rgbM);
  float lumaNW = ppLumaAt(vUv + vec2(-1.0, -1.0) * uTexel);
  float lumaNE = ppLumaAt(vUv + vec2( 1.0, -1.0) * uTexel);
  float lumaSW = ppLumaAt(vUv + vec2(-1.0,  1.0) * uTexel);
  float lumaSE = ppLumaAt(vUv + vec2( 1.0,  1.0) * uTexel);

  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  if (lumaMax - lumaMin < max(uEdgeMinimum, lumaMax * uEdgeThreshold)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  vec2 dir;
  dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
  dir.y = ((lumaNW + lumaSW) - (lumaNE + lumaSE));
  float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 1.0 / 128.0);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D(uSource, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(uSource, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
  );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(uSource, vUv + dir * -0.5).rgb +
    texture2D(uSource, vUv + dir * 0.5).rgb
  );
  float lumaB = ppLuma(rgbB);
  vec3 result = (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;
  gl_FragColor = vec4(result, 1.0);
}`;

/**
 * Medidor de luminância: média logarítmica 4×4 por texel, codificada em
 * [0,1] (`logLuma / 20 + 0.5`). Alimenta a auto-exposição.
 */
export const LUMINANCE_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uScene;
uniform vec2 uTexel;

void main() {
  float sum = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * uTexel;
      vec3 c = texture2D(uScene, clamp(uv, 0.0, 1.0)).rgb;
      sum += log(max(ppLuma(c), 1e-4));
    }
  }
  float logLuma = sum / 16.0;
  gl_FragColor = vec4(vec3(clamp(logLuma / 20.0 + 0.5, 0.0, 1.0)), 1.0);
}`;

/** Adaptação temporal da exposição (1×1, ping-pong). */
export const EXPOSURE_ADAPT_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uMeasure;
uniform sampler2D uPrevious;
uniform float uSpeed;
uniform float uDelta;

void main() {
  float sum = 0.0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      vec2 uv = (vec2(float(x), float(y)) + 0.5) / 8.0;
      sum += texture2D(uMeasure, uv).r;
    }
  }
  float encoded = sum / 64.0;
  float target = exp((encoded - 0.5) * 20.0);
  float previous = exp((texture2D(uPrevious, vec2(0.5)).r - 0.5) * 20.0);
  float k = 1.0 - exp(-max(uDelta, 0.0) * max(uSpeed, 0.01));
  float adapted = previous + (target - previous) * k;
  float outEncoded = clamp(log(max(adapted, 1e-4)) / 20.0 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(vec3(outEncoded), 1.0);
}`;

/**
 * Converte a textura de profundidade nativa em profundidade linear
 * normalizada e empacotada (RG, 16 bits) — formato único lido por SSAO/SSR.
 */
export const DEPTH_ENCODE_FRAGMENT = `${GLSL_POST_COMMON}
uniform sampler2D uDepth;
uniform vec2 uNearFar;
uniform float uMode;

void main() {
  float raw = texture2D(uDepth, vUv).r;
  float linearDepth = raw;
  if (uMode < 0.5) {
    // Profundidade de janela (perspectiva): ndc = 2d - 1, viewZ = 2nf/(f+n-z(f-n)).
    float z = raw * 2.0 - 1.0;
    float n = uNearFar.x;
    float f = uNearFar.y;
    float viewZ = (2.0 * n * f) / max(f + n - z * (f - n), 1e-6);
    linearDepth = (viewZ - n) / max(f - n, 1e-6);
  }
  // Modo 1 (ortográfico ou já linear): [0,1] já é linear em relação ao range.
  gl_FragColor = ppPackDepth(clamp(linearDepth, 0.0, 1.0));
}`;

/* ---------------------------- catálogo ----------------------------------- */

/**
 * Catálogo de programas de pós-processamento. Cada entrada é composta por
 * `QUAD_VERTEX_SHADER` + fragment específico.
 */
export const POST_SHADERS = deepFreeze({
  bright: { fragment: BRIGHT_PASS_FRAGMENT, label: 'bright pass' },
  bloomDown: { fragment: BLOOM_DOWN_FRAGMENT, label: 'bloom downsample 13-tap' },
  bloomUp: { fragment: BLOOM_UP_FRAGMENT, label: 'bloom upsample tent' },
  bloomStreak: { fragment: BLOOM_STREAK_FRAGMENT, label: 'bloom anamorphic streak' },
  ssao: { fragment: SSAO_FRAGMENT, label: 'SSAO' },
  ssaoBlur: { fragment: SSAO_BLUR_FRAGMENT, label: 'SSAO blur' },
  contactShadow: { fragment: CONTACT_SHADOW_FRAGMENT, label: 'contact shadows' },
  ssr: { fragment: SSR_FRAGMENT, label: 'SSR' },
  composite: { fragment: COMPOSITE_FRAGMENT, label: 'composite' },
  tonemap: { fragment: TONEMAP_PASS_FRAGMENT, label: 'tone mapping' },
  fxaa: { fragment: FXAA_FRAGMENT, label: 'FXAA' },
  copy: { fragment: COPY_FRAGMENT, label: 'copy' },
  luminance: { fragment: LUMINANCE_FRAGMENT, label: 'luminance' },
  exposureAdapt: { fragment: EXPOSURE_ADAPT_FRAGMENT, label: 'exposure adaptation' },
  depthEncode: { fragment: DEPTH_ENCODE_FRAGMENT, label: 'depth encode' },
});

/** Nomes de programas disponíveis. */
export const POST_SHADER_NAMES = Object.freeze(Object.keys(POST_SHADERS));

/** Índice do modo de tone mapping usado pelos `#define` do GLSL. */
export function tonemapModeOf(operator = 'aces') {
  switch (operator) {
    case 'filmic': return 1;
    case 'reinhard': return 2;
    case 'reinhard-extended': return 3;
    case 'linear': return 4;
    case 'aces':
    default: return 0;
  }
}

/**
 * Monta a fonte (vertex + fragment + defines) de um programa do catálogo.
 *
 * @param {string} name chave de `POST_SHADERS`
 * @param {object} [options]
 * @param {Record<string, string|number|boolean>} [options.defines]
 * @param {string} [options.operator] atalho que define `TONEMAP_MODE`
 * @param {object} [options.capabilities] para decidir `PP_DERIVATIVES`
 * @returns {{ vertex:string, fragment:string, defines:object, name:string }}
 */
export function buildPostShader(name, options = {}) {
  const entry = POST_SHADERS[name];
  if (!entry) {
    throw new Error(`postprocessing.js: programa "${name}" não existe (${POST_SHADER_NAMES.join(', ')}).`);
  }
  const defines = { ...(options.defines ?? {}) };
  if (options.operator && defines.TONEMAP_MODE === undefined) {
    defines.TONEMAP_MODE = tonemapModeOf(options.operator);
  }
  if (defines.TONEMAP_MODE === undefined) defines.TONEMAP_MODE = 0;
  // Normais a partir da profundidade exigem derivadas (extensão no WebGL1).
  const extensions = [...(options.extensions ?? [])];
  if (defines.PP_DERIVATIVES && options.webgl2 === false
      && !extensions.includes('GL_OES_standard_derivatives')) {
    extensions.push('GL_OES_standard_derivatives');
  }
  return {
    name,
    label: entry.label ?? name,
    vertex: QUAD_VERTEX_SHADER,
    fragment: entry.fragment,
    defines,
    extensions,
  };
}

/* ========================================================================== */
/*  6. Passes de pós-processamento                                            */
/* ========================================================================== */

/** @private Serialização estável (chaves ordenadas) para cache de variantes. */
function stableKey(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (ArrayBuffer.isView(value)) return `[${Array.from(value).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${k}:${stableKey(value[k])}`).join(',')}}`;
  }
  return String(value);
}

/**
 * Textura dinâmica (canvas/imagem → GPU) com atualização por quadro.
 * Usada para injetar a cena Canvas2D e os buffers falsos de profundidade e
 * normais no pipeline WebGL.
 */
export class DynamicTexture {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {object} [options]
   * @param {boolean} [options.flipY=true] alinha a origem do canvas com a do GL
   * @param {'linear'|'nearest'} [options.filter='linear']
   * @param {boolean} [options.colorSpaceNone=true] impede conversão de cor
   */
  constructor(gl, options = {}) {
    this.gl = gl;
    this.flipY = options.flipY !== false;
    this.filter = options.filter ?? 'linear';
    this.colorSpaceNone = options.colorSpaceNone !== false;
    this.texture = gl.createTexture();
    this.width = 0;
    this.height = 0;
    this.hasData = false;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const f = this.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Envia uma fonte de imagem (canvas, ImageData, ImageBitmap...) para a GPU.
   * @param {object} source
   * @param {{ allocate?: boolean }} [options]
   */
  upload(source, options = {}) {
    if (!source) return this;
    const gl = this.gl;
    const width = source.width ?? source.videoWidth ?? 0;
    const height = source.height ?? source.videoHeight ?? 0;
    if (!width || !height) return this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this.flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.colorSpaceNone && gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== undefined) {
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    }
    const mustAllocate = options.allocate !== false
      && (width !== this.width || height !== this.height || !this.hasData);
    if (mustAllocate) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.width = width;
      this.height = height;
      this.hasData = true;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return this;
  }

  /** Libera a textura. */
  dispose() {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.hasData = false;
  }
}

/**
 * Passe base do pipeline. Subclasses sobrescrevem `init`, `resize`, `render`
 * e, opcionalmente, `configure`/`setQuality`.
 */
export class PostPass {
  /**
   * @param {string} name identificador único na cadeia
   * @param {object} [options]
   * @param {boolean} [options.enabled=true]
   * @param {number} [options.order=0]
   */
  constructor(name, options = {}) {
    this.name = name;
    this.enabled = options.enabled !== false;
    this.order = Number(options.order ?? 0);
    this.gl = null;
    this.pipeline = null;
    this.width = 1;
    this.height = 1;
    this.lastError = null;
    this.disposed = false;
    /** Nº de execuções completas do passe (`render`). */
    this.renderCount = 0;
    /** Nº de quads desenhados (um passe pode emitir vários). */
    this.drawCount = 0;
  }

  /** @private Vincula o passe ao pipeline (cria recursos GL). */
  attach(pipeline) {
    this.pipeline = pipeline;
    this.gl = pipeline.gl;
    this.width = pipeline.width;
    this.height = pipeline.height;
    this.init();
    return this;
  }

  /** Cria programas/alvos. */
  init() { return this; }

  /** Atualiza opções em runtime. */
  configure() { return this; }

  /** Aplica parâmetros de um preset de qualidade. */
  setQuality() { return this; }

  /** Redimensiona alvos internos. */
  resize(width, height) {
    this.width = width;
    this.height = height;
    return this;
  }

  /** Executa o passe (subclasses implementam). */
  render() { return this; }

  /**
   * Desenha um quad de tela cheia com um programa arbitrário (utilitário
   * compartilhado por passes que possuem mais de um programa).
   *
   * @param {GLProgram} program
   * @param {object} [options] `target`, `uniforms`, `textures`, `blend`, `clear`
   * @returns {boolean}
   */
  drawWith(program, options = {}) {
    const gl = this.gl;
    if (!gl || !program || !program.program) return false;
    const { target = null, uniforms = {}, textures = {}, blend = null, clear = null } = options;

    if (target) {
      target.bind();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const width = this.pipeline?.drawingWidth ?? this.pipeline?.width ?? this.width;
      const height = this.pipeline?.drawingHeight ?? this.pipeline?.height ?? this.height;
      gl.viewport(0, 0, width, height);
    }
    GLState.resetForPost(gl);
    if (clear) {
      gl.clearColor(clear[0], clear[1], clear[2], clear[3] ?? 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(blend[0], blend[1], blend[2] ?? blend[0], blend[3] ?? blend[1]);
    }
    program.use();
    for (const key of Object.keys(textures)) {
      if (textures[key] === undefined) continue;
      program.bindTexture(key, textures[key]);
    }
    program.setUniforms(uniforms);
    const quad = this.quad ?? this.pipeline?.quad;
    if (quad) quad.draw(program);
    if (blend) gl.disable(gl.BLEND);
    this.drawCount += 1;
    return true;
  }

  /** Libera recursos GL. */
  dispose() { this.disposed = true; return this; }
}

/**
 * Passe de tela cheia: dono de um `GLProgram` (compilado sob demanda por
 * variante de `#define`) e do quad compartilhado do pipeline.
 */
export class FullscreenPass extends PostPass {
  /**
   * @param {string} name
   * @param {object} options
   * @param {string} [options.shader] chave em `POST_SHADERS`
   * @param {Record<string,string|number|boolean>} [options.defines]
   */
  constructor(name, options = {}) {
    super(name, options);
    this.shaderName = options.shader ?? name;
    this.baseDefines = { ...(options.defines ?? {}) };
    this.program = null;
    this.variantKey = null;
    this.operator = options.operator ?? null;
    this.onCompileError = options.onCompileError ?? null;
  }

  /** @private */
  init() {
    this.quad = this.pipeline?.quad ?? this.quad ?? new FullscreenQuad(this.gl);
    return this;
  }

  /**
   * Garante um programa compilado para a variante de defines pedida.
   * Falhas de compilação desativam o passe (o pipeline continua funcionando).
   *
   * @param {Record<string,string|number|boolean>} [defines]
   * @param {{ operator?: string, force?: boolean }} [options]
   */
  ensureProgram(defines = {}, options = {}) {
    const operator = options.operator ?? this.operator ?? undefined;
    const merged = { ...this.baseDefines, ...defines };
    const key = `${stableKey(merged)}|${operator ?? ''}`;
    if (this.program && this.variantKey === key && !options.force) return this.program;

    const built = buildPostShader(this.shaderName, {
      defines: merged,
      operator,
      capabilities: this.pipeline?.capabilities,
      webgl2: this.pipeline?.capabilities?.isWebGL2,
    });
    if (this.program) this.program.dispose();
    this.variantKey = key;
    this.program = new GLProgram(this.gl, {
      vertex: built.vertex,
      fragment: built.fragment,
      defines: built.defines,
      name: `${this.name}:${this.shaderName}`,
      throwOnError: false,
      onError: (diagnostic) => {
        this.lastError = diagnostic;
        this.error = diagnostic;
        this.enabled = false;
        if (!this._errorLogged) {
          this._errorLogged = true;
          console.error(
            `[Orbiter] shader do passe "${this.name}" falhou ao compilar (passe desativado):`,
            diagnostic.log ?? diagnostic.message,
          );
        }
        if (this.onCompileError) this.onCompileError(diagnostic);
        this.pipeline?._handlePassError?.(this, diagnostic);
      },
    });
    return this.program;
  }

  /**
   * Desenha o quad com o programa atual.
   *
   * @param {object} options
   * @param {?RenderTarget} [options.target] `null` = framebuffer padrão
   * @param {object} [options.uniforms]
   * @param {object} [options.textures]
   * @param {?number[]} [options.blend] `[srcRGB, dstRGB, srcAlpha, dstAlpha]`
   * @param {?number[]} [options.clear]
   * @returns {boolean}
   */
  draw(options = {}) {
    return this.drawWith(this.program, options);
  }

  /** @private */
  dispose() {
    if (this.program) this.program.dispose();
    this.program = null;
    return super.dispose();
  }
}

/**
 * Cópia com utilitários de depuração: `channel` (0 = RGB, 1 = R, 2 = G,
 * 3 = B, 4 = A, 5 = profundidade empacotada) e `decodeSRGB` para trazer a
 * cena Canvas2D (sRGB) para o espaço linear do pipeline.
 */
export class CopyPass extends FullscreenPass {
  /**
   * @param {object} [options]
   * @param {number} [options.channel=0] qual canal exibir (0 = RGB)
   * @param {number} [options.scale=1] zoom na amostragem
   * @param {boolean} [options.decodeSRGB=false] sRGB → linear na leitura
   * @param {boolean} [options.packedDepth=false] desempacota RG como profundidade
   */
  constructor(options = {}) {
    super('copy', { shader: 'copy', ...options });
    this.channel = options.channel ?? 0;
    this.scale = options.scale ?? 1;
    this.decodeSRGB = options.decodeSRGB ?? false;
    this.packedDepth = options.packedDepth ?? false;
  }

  /**
   * @param {object} ctx contexto do pipeline
   * @param {object} [options] `texture`, `target`, `channel`, `scale`
   */
  render(ctx, options = {}) {
    const texture = options.texture ?? ctx.source ?? ctx.scene?.texture ?? null;
    if (!texture) return this;
    const target = options.target === undefined ? null : options.target;
    if (!this.ensureProgram({}).program) return this;
    this.draw({
      target,
      textures: { uSource: texture },
      uniforms: {
        uChannel: options.channel ?? this.channel,
        uScale: options.scale ?? this.scale,
        uPackedDepth: (options.packedDepth ?? this.packedDepth) ? 1 : 0,
        uDecodeSRGB: (options.decodeSRGB ?? this.decodeSRGB) ? 1 : 0,
      },
    });
    return this;
  }
}


/**
 * Bright pass isolado: extrai as altas luzes da cena HDR com threshold de
 * joelho suave e realce de tons quentes (chamas/propulsores).
 *
 * Usado internamente pelo {@link BloomPass} na primeira etapa, e exportado
 * para quem quiser montar uma cadeia de bloom própria (HDR → bright → blur)
 * ou inspecionar o que passou pelo limiar (ver `pipeline.debug.pass`).
 */
export class BrightPass extends FullscreenPass {
  /**
   * @param {object} [options]
   * @param {object} [options.config] `threshold`, `knee`, `intensity`,
   *   `flameBoost`, `tint`, `tintStrength`, `resolution`
   */
  constructor(options = {}) {
    super('bright', { shader: 'bright', order: 25, ...options });
    this.config = {
      threshold: 1,
      knee: 0.5,
      intensity: 1,
      flameBoost: 0.35,
      tint: [1, 0.68, 0.45],
      tintStrength: 0.18,
      resolution: 0.5,
      ...(options.config ?? {}),
    };
    /** Alvo próprio (usado quando o passe é incluído na cadeia). */
    this.target = null;
    this.useDerivatives = false;
  }

  /** Atualiza parâmetros. */
  configure(options = {}) {
    Object.assign(this.config, options);
    return this;
  }

  /**
   * @private Desenha em `target` (sem alocar nada).
   * @param {RenderTarget|null} target
   * @param {object|null} ctx contexto do pipeline (opcional)
   * @param {WebGLTexture} texture cena HDR de origem
   * @returns {boolean}
   */
  drawInto(target, ctx, texture) {
    if (!target || !texture) return false;
    this.ensureProgram();
    if (!this.program?.program) return false;
    const width = ctx?.scene?.width ?? target.width;
    const height = ctx?.scene?.height ?? target.height;
    const threshold = ctx?.bloomThreshold ?? this.config.threshold;
    return this.draw({
      target,
      textures: { uScene: texture },
      uniforms: {
        uTexel: [1 / Math.max(1, width), 1 / Math.max(1, height)],
        uThreshold: threshold,
        uKnee: this.config.knee,
        uIntensity: this.config.intensity,
        uFlameBoost: this.config.flameBoost,
        uTint: this.config.tint,
        uTintStrength: this.config.tintStrength,
      },
      clear: [0, 0, 0, 1],
    });
  }

  /** @private Cria o alvo próprio na resolução pedida. */
  _ensureTarget(width, height) {
    const resolution = clamp(this.config.resolution ?? 0.5, 0.1, 1);
    const w = Math.max(1, Math.round(width * resolution));
    const h = Math.max(1, Math.round(height * resolution));
    if (this.target && this.target.width === w && this.target.height === h) return this.target;
    this.target?.dispose();
    this.target = new RenderTarget(this.gl, {
      width: w, height: h, format: 'rgba16f', filter: 'linear', name: 'bright',
      capabilities: this.pipeline?.capabilities,
    });
    return this.target;
  }

  /** @private */
  render(ctx) {
    const scene = ctx.scene;
    if (!scene?.texture) {
      ctx.outputs.bright = null;
      return this;
    }
    if (!this.config.enabled) {
      ctx.outputs.bright = null;
      return this;
    }
    this._ensureTarget(scene.width, scene.height);
    this.drawInto(this.target, ctx, scene.texture);
    ctx.outputs.bright = this.target;
    return this;
  }

  /** @private */
  dispose() {
    this.target?.dispose();
    this.target = null;
    return super.dispose();
  }
}

/**
 * Bloom dinâmico: bright pass com threshold adaptativo (exposição +
 * luminância + intensidade das chamas), cadeia de downsample 13 taps,
 * upsample tent aditivo e streak anamórfico opcional.
 *
 * O espalhamento cresce quando a densidade atmosférica cai: no vácuo a pluma
 * do motor expande sem contrapressão, produzindo halo maior (ver
 * `EffectStressController`).
 */
export class BloomPass extends PostPass {
  /**
   * @param {object} [options]
   * @param {object} [options.config] `threshold`, `knee`, `intensity`,
   *   `mipCount`, `scatter`, `tint`, `flameBoost`, `streak`…
   */
  constructor(options = {}) {
    super('bloom', options);
    this.mips = [];
    this.chain = [];
    this.streakTarget = null;
    this.streakProgram = null;
    this.downProgram = null;
    this.upProgram = null;
    this.config = {
      enabled: true,
      threshold: 1,
      knee: 0.5,
      intensity: 1.05,
      mipCount: 5,
      scatter: 0.72,
      tint: [1, 0.68, 0.45],
      tintStrength: 0.18,
      flameBoost: 0.35,
      streak: false,
      streakIntensity: 0.35,
      streakTint: [1, 0.54, 0.33],
      streakSamples: 6,
      ...(options.config ?? {}),
    };
    /** Último valor de threshold efetivamente usado (telemetria/depuração). */
    this.lastThreshold = this.config.threshold;
  }

  /** @private */
  init() {
    this.quad = this.pipeline?.quad ?? new FullscreenQuad(this.gl);
    const make = (shader, name) => new GLProgram(this.gl, {
      ...buildPostShader(shader, {}),
      name: `bloom:${name}`,
      throwOnError: false,
      onError: (d) => { this.lastError = d; this.enabled = false; },
    });
    // O bright pass é um passe de verdade (exportado): reaproveita programa,
    // quad e uniformes do pipeline em vez de duplicar o código.
    this.brightPass ??= new BrightPass({ config: this.config });
    this.brightPass.gl = this.gl;
    this.brightPass.quad = this.quad;
    this.brightPass.pipeline = this.pipeline;
    this.downProgram = make('bloomDown', 'down');
    this.upProgram = make('bloomUp', 'up');
    this.streakProgram = make('bloomStreak', 'streak');
    this.resize(this.width, this.height);
    return this;
  }

  /** Atualiza parâmetros (aceita o bloco `bloom` das opções). */
  configure(options = {}) {
    Object.assign(this.config, options);
    return this;
  }

  /** @private */
  setQuality(preset) {
    if (preset?.bloom) this.configure({
      mipCount: preset.bloom.mips ?? this.config.mipCount,
      scatter: preset.bloom.scatter ?? this.config.scatter,
      threshold: preset.bloom.threshold ?? this.config.threshold,
      intensity: preset.bloom.intensity ?? this.config.intensity,
      streak: preset.bloom.streak ?? this.config.streak,
    });
    return this;
  }

  /** @private (Re)aloca a cadeia de mips. */
  resize(width, height) {
    super.resize(width, height);
    const gl = this.gl;
    if (!gl) return this;
    const count = clamp(Math.round(this.config.mipCount ?? 5), 1, 8);
    const first = this.mips[0];
    if (first && first.width === Math.max(1, Math.floor(width / 2))
        && first.height === Math.max(1, Math.floor(height / 2))
        && this.mips.length === count && this.streakTarget) {
      return this;
    }
    for (const target of this.mips) target.dispose();
    this.mips = [];
    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    for (let i = 0; i < count && w >= 1 && h >= 1; i++) {
      this.mips.push(new RenderTarget(gl, {
        width: w,
        height: h,
        format: 'rgba16f',
        filter: 'linear',
        name: `bloom-mip-${i}`,
        capabilities: this.pipeline?.capabilities,
      }));
      w = Math.floor(w / 2);
      h = Math.floor(h / 2);
    }
    if (this.streakTarget) this.streakTarget.dispose();
    this.streakTarget = this.mips.length
      ? new RenderTarget(gl, {
        width: Math.max(1, Math.floor(this.mips[0].width / 2)),
        height: Math.max(1, Math.floor(this.mips[0].height / 2)),
        format: 'rgba16f',
        filter: 'linear',
        name: 'bloom-streak',
        capabilities: this.pipeline?.capabilities,
      })
      : null;
    return this;
  }

  /**
   * Renderiza a cadeia. O resultado fica em `this.mips[0]`.
   * @param {object} ctx
   * @param {{ threshold?: number, intensity?: number, scatter?: number }} [overrides]
   */
  render(ctx, overrides = {}) {
    if (!this.config.enabled || !this.mips.length) return this;
    this.brightPass.ensureProgram();
    if (!this.brightPass.program?.program) return this;
    const gl = this.gl;
    const scene = ctx.scene;
    if (!scene?.texture) return this;

    const threshold = overrides.threshold ?? ctx.bloomThreshold ?? this.config.threshold;
    // A intensidade artística é aplicada no compose (o alvo guarda energia
    // pura); standalone, `overrides.intensity` permite escalar na origem.
    const intensity = overrides.intensity ?? 1;
    const scatter = overrides.scatter ?? this.config.scatter;
    this.lastThreshold = threshold;

    // 1) Bright pass → mip 0
    const mip0 = this.mips[0];
    this.brightPass.configure({
      threshold,
      knee: this.config.knee,
      intensity,
      flameBoost: this.config.flameBoost,
      tint: this.config.tint,
      tintStrength: this.config.tintStrength,
    });
    this.brightPass.drawInto(mip0, { ...ctx, bloomThreshold: threshold }, scene.texture);
    ctx.outputs.bright = mip0;

    // 2) Downsamples
    this.downProgram.use();
    for (let i = 1; i < this.mips.length; i++) {
      const source = this.mips[i - 1];
      const destination = this.mips[i];
      this.drawWith(this.downProgram, {
        target: destination,
        textures: { uSource: source.texture },
        uniforms: { uTexel: [1 / source.width, 1 / source.height] },
      });
    }

    // 3) Upsamples aditivos (do menor para o maior)
    for (let i = this.mips.length - 1; i > 0; i--) {
      const source = this.mips[i];
      const destination = this.mips[i - 1];
      this.drawWith(this.upProgram, {
        target: destination,
        textures: { uSource: source.texture },
        uniforms: { uTexel: [1 / source.width, 1 / source.height], uScatter: scatter, uRadius: 1 },
        blend: [gl.ONE, gl.ONE, gl.ONE, gl.ONE],
      });
    }

    // 4) Streak anamórfico (chamas) somado ao mip 0
    if (this.config.streak && this.streakTarget && this.streakProgram?.program) {
      this.drawWith(this.streakProgram, {
        target: this.streakTarget,
        textures: { uSource: mip0.texture },
        uniforms: {
          uTexel: [1 / mip0.width, 1 / mip0.height],
          uStep: 1.5,
          uIntensity: this.config.streakIntensity,
          uTint: this.config.streakTint,
        },
      });
      this.drawWith(this.upProgram, {
        target: mip0,
        textures: { uSource: this.streakTarget.texture },
        uniforms: { uTexel: [1 / this.streakTarget.width, 1 / this.streakTarget.height], uScatter: 1, uRadius: 1 },
        blend: [gl.ONE, gl.ONE, gl.ONE, gl.ONE],
      });
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    ctx.outputs.bloom = mip0;
    ctx.outputs.bloomChain = this.mips;
    return this;
  }

  /** @private */
  dispose() {
    for (const target of this.mips) target.dispose();
    this.mips = [];
    if (this.streakTarget) this.streakTarget.dispose();
    this.streakTarget = null;
    for (const program of [this.downProgram, this.upProgram, this.streakProgram]) {
      program?.dispose();
    }
    this.downProgram = null;
    this.upProgram = null;
    this.streakProgram = null;
    this.brightPass?.dispose();
    this.brightPass = null;
    return super.dispose();
  }
}


/**
 * Sombras de contato em espaço de tela (soft shadows baratas).
 *
 * Marcha a partir de cada pixel na direção da luz comparando profundidades;
 * o resultado é um fator de sombreamento multiplicado sobre o AO (blend
 * `DST_COLOR, ZERO`), gerando penumbra suave — inclusive nas cenas 2D com
 * GBuffer falso, onde substitui shadow maps.
 *
 * Usado internamente pelo {@link SSAOPass} e exportável para quem quiser
 * sombras de contato sem SSAO.
 */
export class ContactShadowPass extends FullscreenPass {
  /**
   * @param {object} [options]
   * @param {object} [options.config] `strength`, `steps`, `rayLength`,
   *   `thickness`
   */
  constructor(options = {}) {
    super('contactShadow', { shader: 'contactShadow', order: 27, ...options });
    this.config = {
      enabled: true,
      strength: 0.55,
      steps: 12,
      rayLength: 0.12,
      thickness: 0.01,
      ...(options.config ?? {}),
    };
    this.target = null;
  }

  /** Atualiza parâmetros. */
  configure(options = {}) {
    Object.assign(this.config, options);
    return this;
  }

  /**
   * @private Desenha as sombras em `target` (já contendo o AO), por
   * multiplicação.
   *
   * @param {RenderTarget} target
   * @param {object} ctx contexto do pipeline
   * @param {WebGLTexture} depth profundidade linear empacotada
   * @returns {boolean}
   */
  drawInto(target, ctx, depth) {
    if (!target || !depth) return false;
    const steps = clamp(Math.round(this.config.steps ?? 12), 4, 32);
    this.ensureProgram({ CONTACT_STEPS: steps });
    if (!this.program?.program) return false;
    const gl = this.gl;
    return this.draw({
      target,
      textures: { uDepth: depth },
      uniforms: {
        uTexel: [1 / target.width, 1 / target.height],
        uLightDirection: ctx.lightDirection ?? [0.6, 0.8],
        uRayLength: clamp(this.config.rayLength ?? 0.12, 0.01, 0.6),
        uThickness: Math.max(1e-5, this.config.thickness ?? 0.01),
        uStrength: clamp01(this.config.strength ?? 0.55),
        uFrame: (ctx.frame ?? 0) % 1024,
      },
      blend: [gl.DST_COLOR, gl.ZERO, gl.DST_COLOR, gl.ZERO],
    });
  }

  /** @private Cria um alvo próprio quando usado na cadeia. */
  render(ctx) {
    const depth = ctx.depthTexture;
    const scene = ctx.scene;
    if (!this.config.enabled || !depth || !scene) {
      ctx.outputs.contact = null;
      return this;
    }
    if (!this.target || this.target.width !== scene.width || this.target.height !== scene.height) {
      this.target?.dispose();
      this.target = new RenderTarget(this.gl, {
        width: scene.width, height: scene.height, format: 'rgba8', filter: 'linear',
        name: 'contact-shadow', capabilities: this.pipeline?.capabilities,
      });
    }
    this.ensureProgram({ CONTACT_STEPS: clamp(Math.round(this.config.steps ?? 12), 4, 32) });
    if (!this.program?.program) {
      ctx.outputs.contact = null;
      return this;
    }
    // Alvo começa branco (fator 1 = sem sombra) e recebe a multiplicação.
    this.target.bind();
    this.gl.clearColor(1, 1, 1, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.drawInto(this.target, ctx, depth);
    ctx.outputs.contact = this.target;
    return this;
  }

  /** @private */
  dispose() {
    this.target?.dispose();
    this.target = null;
    return super.dispose();
  }
}

/**
 * SSAO com kernel hemisférico, blur bilateral separável e sombras de contato
 * opcionais (multiplicadas sobre o AO).
 */
export class SSAOPass extends PostPass {
  /**
   * @param {object} [options]
   * @param {object} [options.config] `samples`, `radius`, `bias`, `intensity`,
   *   `power`, `blur`, `resolution`, `contactShadows`…
   */
  constructor(options = {}) {
    super('ssao', options);
    this.aoProgram = null;
    this.blurProgram = null;
    this.variantKey = null;
    this.aoTarget = null;
    this.blurTarget = null;
    this.contactPass = null;
    this.useDerivatives = false;
    this.config = {
      enabled: true,
      samples: 16,
      radius: 0.08,
      bias: 0.002,
      intensity: 1,
      power: 1.4,
      blur: true,
      resolution: 0.5,
      contactShadows: false,
      contactStrength: 0.55,
      contactSteps: 12,
      ...(options.config ?? {}),
    };
  }

  /** @private */
  init() {
    this.quad = this.pipeline?.quad ?? new FullscreenQuad(this.gl);
    this._ensurePrograms();
    return this;
  }

  /** @private Compila as variantes (amostras/etapas/normais por derivadas). */
  _ensurePrograms() {
    const gl = this.gl;
    const samples = clamp(Math.round(this.config.samples), 4, 64);
    const key = `ao:${samples}|contact:${this.config.contactSteps}|deriv:${this.useDerivatives}`;
    if (this.variantKey === key && this.aoProgram?.program) return;

    const fail = (d) => { this.lastError = d; this.enabled = false; };
    this.aoProgram?.dispose();
    this.blurProgram?.dispose();

    this.aoProgram = new GLProgram(gl, {
      ...buildPostShader('ssao', {
        defines: { AO_SAMPLES: samples, PP_DERIVATIVES: this.useDerivatives },
        webgl2: this.pipeline?.capabilities?.isWebGL2,
      }),
      name: 'ssao:ao', throwOnError: false, onError: fail,
    });
    this.blurProgram = new GLProgram(gl, {
      ...buildPostShader('ssaoBlur'), name: 'ssao:blur', throwOnError: false, onError: fail,
    });
    // O passe de sombras de contato é dono do próprio programa/recompilação.
    this.contactPass ??= new ContactShadowPass();
    this.contactPass.gl = gl;
    this.contactPass.quad = this.pipeline?.quad ?? this.quad ?? null;
    this.contactPass.pipeline = this.pipeline;
    this.variantKey = key;
  }

  /** Atualiza parâmetros. */
  configure(options = {}) {
    Object.assign(this.config, options);
    this._ensurePrograms();
    return this;
  }

  /** @private */
  setQuality(preset) {
    if (preset?.ssao) {
      this.configure({
        enabled: preset.ssao.enabled ?? this.config.enabled,
        samples: preset.ssao.samples ?? this.config.samples,
        resolution: preset.ssao.resolution ?? this.config.resolution,
        blur: preset.ssao.blur ?? this.config.blur,
      });
    }
    return this;
  }

  /** @private */
  resize(width, height) {
    super.resize(width, height);
    if (!this.gl) return this;
    const resolution = clamp(this.config.resolution ?? 0.5, 0.1, 1);
    const w = Math.max(1, Math.round(width * resolution));
    const h = Math.max(1, Math.round(height * resolution));
    if (this.aoTarget && this.aoTarget.width === w && this.aoTarget.height === h) return this;
    this.aoTarget?.dispose();
    this.blurTarget?.dispose();
    const capabilities = this.pipeline?.capabilities;
    this.aoTarget = new RenderTarget(this.gl, {
      width: w, height: h, format: 'rgba8', filter: 'linear', name: 'ssao', capabilities,
    });
    this.blurTarget = new RenderTarget(this.gl, {
      width: w, height: h, format: 'rgba8', filter: 'linear', name: 'ssao-blur', capabilities,
    });
    return this;
  }

  /** @private Uniformes comuns de câmera/profundidade. */
  _cameraUniforms(ctx) {
    const camera = ctx.camera;
    const ortho = camera.mode === 'orthographic';
    return {
      uNearFar: [camera.near, camera.far],
      uProjection: camera.projection,
      uOrthoSize: camera.orthoSize,
      uOrtho: ortho ? 1 : 0,
    };
  }

  /**
   * @param {object} ctx
   */
  render(ctx) {
    const depth = ctx.depthTexture;
    if (!this.config.enabled || !depth || !this.aoProgram?.program) {
      ctx.outputs.ao = null;
      return this;
    }
    const scene = ctx.scene;
    this.resize(scene.width, scene.height);
    // Sem GBuffer de normais, reconstrói-as por derivadas da profundidade
    // (WebGL2 nativo ou `OES_standard_derivatives`).
    const derivatives = !ctx.normalTexture && !!this.pipeline?.capabilities?.normalFromDepth;
    if (derivatives !== this.useDerivatives) {
      this.useDerivatives = derivatives;
      this._ensurePrograms();
    }
    const target = this.aoTarget;
    const hasNormals = !!ctx.normalTexture;
    const scale = ctx.sceneScale ?? 1;

    this.drawWith(this.aoProgram, {
      target,
      textures: {
        uDepth: depth,
        uNormals: ctx.normalTexture ?? depth,
      },
      uniforms: {
        ...this._cameraUniforms(ctx),
        uTexel: [1 / target.width, 1 / target.height],
        uRadius: Math.max(1e-5, this.config.radius * scale),
        uBias: Math.max(1e-6, this.config.bias * (ctx.camera.far - ctx.camera.near)),
        uIntensity: this.config.intensity,
        uPower: this.config.power,
        uFrame: ctx.frame % 1024,
        uHasNormals: hasNormals ? 1 : 0,
      },
      clear: [1, 1, 1, 1],
    });

    if (this.config.contactShadows) {
      this.contactPass.configure({
        strength: this.config.contactStrength,
        steps: this.config.contactSteps,
        rayLength: this.config.contactRayLength,
        thickness: this.config.contactThickness,
      });
      if (this.contactPass.drawInto(target, ctx, depth)) ctx.outputs.contact = target;
    }

    if (this.config.blur && this.blurProgram?.program) {
      const sigma = Math.max(1e-5, (this.config.bias ?? 0.002) * (ctx.camera.far - ctx.camera.near) * 6);
      this.drawWith(this.blurProgram, {
        target: this.blurTarget,
        textures: { uAO: target.texture, uDepth: depth },
        uniforms: {
          uDirection: [1, 0],
          uTexel: [1 / target.width, 1 / target.height],
          uDepthSigma: sigma,
        },
      });
      this.drawWith(this.blurProgram, {
        target,
        textures: { uAO: this.blurTarget.texture, uDepth: depth },
        uniforms: {
          uDirection: [0, 1],
          uTexel: [1 / target.width, 1 / target.height],
          uDepthSigma: sigma,
        },
      });
    }

    ctx.outputs.ao = target;
    return this;
  }

  /** @private */
  dispose() {
    this.aoTarget?.dispose();
    this.blurTarget?.dispose();
    this.aoTarget = null;
    this.blurTarget = null;
    this.aoProgram?.dispose();
    this.blurProgram?.dispose();
    this.contactPass?.dispose();
    this.aoProgram = null;
    this.blurProgram = null;
    this.contactPass = null;
    return super.dispose();
  }
}

/**
 * Screen-space reflections para superfícies de planetas/oceanos. Usa o
 * GBuffer (profundidade + normais + máscara de material) e a cena HDR.
 */
export class SSRPass extends PostPass {
  /**
   * @param {object} [options]
   * @param {object} [options.config] `steps`, `maxDistance`, `thickness`,
   *   `intensity`, `fresnel`, `resolution`, `materialMask`…
   */
  constructor(options = {}) {
    super('ssr', options);
    this.program = null;
    this.variantKey = null;
    this.target = null;
    this.useDerivatives = false;
    this.config = {
      enabled: false,
      steps: 16,
      maxDistance: 0.35,
      thickness: 0.02,
      intensity: 0.9,
      fresnel: 0.35,
      jitter: 0.5,
      resolution: 0.5,
      edgeFade: 0.18,
      materialMask: false,
      ...(options.config ?? {}),
    };
  }

  /** @private */
  init() {
    this.quad = this.pipeline?.quad ?? new FullscreenQuad(this.gl);
    this._ensureProgram();
    return this;
  }

  /** @private */
  _ensureProgram() {
    const steps = clamp(Math.round(this.config.steps), 4, 64);
    const key = `ssr:${steps}|deriv:${this.useDerivatives}`;
    if (this.variantKey === key && this.program?.program) return;
    this.program?.dispose();
    this.program = new GLProgram(this.gl, {
      ...buildPostShader('ssr', {
        defines: { SSR_STEPS: steps, PP_DERIVATIVES: this.useDerivatives },
        webgl2: this.pipeline?.capabilities?.isWebGL2,
      }),
      name: 'ssr',
      throwOnError: false,
      onError: (d) => { this.lastError = d; this.enabled = false; },
    });
    this.variantKey = key;
  }

  /** Atualiza parâmetros. */
  configure(options = {}) {
    Object.assign(this.config, options);
    this._ensureProgram();
    return this;
  }

  /** @private */
  setQuality(preset) {
    if (preset?.ssr) {
      this.configure({
        enabled: preset.ssr.enabled ?? this.config.enabled,
        steps: preset.ssr.steps ?? this.config.steps,
        resolution: preset.ssr.resolution ?? this.config.resolution,
      });
    }
    return this;
  }

  /** @private */
  resize(width, height) {
    super.resize(width, height);
    if (!this.gl) return this;
    const resolution = clamp(this.config.resolution ?? 0.5, 0.1, 1);
    const w = Math.max(1, Math.round(width * resolution));
    const h = Math.max(1, Math.round(height * resolution));
    if (this.target && this.target.width === w && this.target.height === h) return this;
    this.target?.dispose();
    this.target = new RenderTarget(this.gl, {
      width: w,
      height: h,
      format: 'rgba16f',
      filter: 'linear',
      name: 'ssr',
      capabilities: this.pipeline?.capabilities,
    });
    return this;
  }

  /** @private */
  render(ctx) {
    const depth = ctx.depthTexture;
    if (!this.config.enabled || !depth || !this.program?.program) {
      ctx.outputs.ssr = null;
      return this;
    }
    const scene = ctx.scene;
    this.resize(scene.width, scene.height);
    const derivatives = !ctx.normalTexture && !!this.pipeline?.capabilities?.normalFromDepth;
    if (derivatives !== this.useDerivatives) {
      this.useDerivatives = derivatives;
      this._ensureProgram();
    }
    const target = this.target;
    const camera = ctx.camera;
    this.drawWith(this.program, {
      target,
      textures: {
        uScene: scene.texture,
        uDepth: depth,
        uNormals: ctx.normalTexture ?? depth,
        uMaterial: ctx.materialTexture ?? depth,
      },
      uniforms: {
        uTexel: [1 / target.width, 1 / target.height],
        uNearFar: [camera.near, camera.far],
        uProjection: camera.projection,
        uOrthoSize: camera.orthoSize,
        uOrtho: camera.mode === 'orthographic' ? 1 : 0,
        uMaxDistance: Math.max(1e-4, this.config.maxDistance * (ctx.sceneScale ?? 1)),
        uThickness: Math.max(1e-5, this.config.thickness * (camera.far - camera.near)),
        uIntensity: this.config.intensity,
        uFresnel: this.config.fresnel,
        uJitter: this.config.jitter,
        uEdgeFade: this.config.edgeFade,
        uFrame: ctx.frame % 1024,
        uHasNormals: ctx.normalTexture ? 1 : 0,
        uHasMaterial: ctx.materialTexture && this.config.materialMask ? 1 : 0,
      },
      clear: [0, 0, 0, 0],
    });
    ctx.outputs.ssr = target;
    return this;
  }

  /** @private */
  dispose() {
    this.target?.dispose();
    this.target = null;
    this.program?.dispose();
    this.program = null;
    return super.dispose();
  }
}

/**
 * Converte a textura de profundidade nativa (depth buffer) em profundidade
 * linear normalizada e empacotada — formato único consumido por SSAO/SSR.
 */
export class DepthEncodePass extends FullscreenPass {
  /**
   * @param {object} [options]
   * @param {'perspective'|'native'} [options.mode='perspective']
   * @param {number} [options.resolution=1] escala do alvo interno
   */
  constructor(options = {}) {
    super('depthEncode', { shader: 'depthEncode', ...options });
    this.target = null;
    this.resolution = options.resolution ?? 1;
    this.mode = options.mode ?? 'perspective';
  }

  /** @private */
  resize(width, height) {
    super.resize(width, height);
    if (!this.gl) return this;
    const w = Math.max(1, Math.round(width * this.resolution));
    const h = Math.max(1, Math.round(height * this.resolution));
    if (this.target && this.target.width === w && this.target.height === h) return this;
    this.target?.dispose();
    this.target = new RenderTarget(this.gl, {
      width: w, height: h, format: 'rgba8', filter: 'nearest', name: 'depth-encode',
      capabilities: this.pipeline?.capabilities,
    });
    return this;
  }

  /**
   * @param {object} ctx
   * @param {object} [options] `depth` (textura nativa), `near`, `far`
   */
  render(ctx, options = {}) {
    const source = options.depth ?? ctx.nativeDepthTexture;
    if (!source) return this;
    this.resize(ctx.width, ctx.height);
    if (!this.ensureProgram({}).program) return this;
    const camera = ctx.camera;
    this.draw({
      target: this.target,
      textures: { uDepth: source },
      uniforms: {
        uNearFar: [options.near ?? camera.near, options.far ?? camera.far],
        uMode: this.mode === 'linear' || this.mode === 'orthographic' ? 1 : 0,
      },
      clear: [1, 1, 1, 1],
    });
    ctx.outputs.depth = this.target;
    return this;
  }

  /** @private */
  dispose() {
    this.target?.dispose();
    this.target = null;
    return super.dispose();
  }
}

/** Tone mapping isolado (sem bloom/lente) — útil para pipelines próprios. */
export class ToneMappingPass extends FullscreenPass {
  /**
   * @param {object} [options]
   * @param {string} [options.operator='aces']
   * @param {number} [options.whitePoint=1.6]
   * @param {number} [options.exposure=1]
   */
  constructor(options = {}) {
    super('tonemap', { shader: 'tonemap', ...options });
    this.operator = options.operator ?? 'aces';
    this.whitePoint = options.whitePoint ?? 1.6;
    this.exposure = options.exposure ?? 1;
    this.dither = options.dither ?? 0.7;
    this.srgb = options.srgb !== false;
  }

  /** @private */
  render(ctx, options = {}) {
    const source = options.source ?? ctx.source ?? ctx.scene;
    if (!source?.texture) return this;
    this.ensureProgram({ TONEMAP_MODE: tonemapModeOf(this.operator) }, { operator: this.operator });
    this.draw({
      target: options.target ?? ctx.ldrTarget ?? null,
      textures: { uScene: source.texture },
      uniforms: {
        uExposure: options.exposure ?? ctx.exposure ?? this.exposure,
        uWhitePoint: this.whitePoint,
        uDither: this.srgb ? this.dither : 0,
        uTime: ctx.time ?? 0,
      },
    });
    ctx.outputs.ldr = options.target ?? ctx.ldrTarget ?? null;
    return this;
  }
}

/**
 * Composição final: SSR + AO + bloom + exposição + tone mapping + grade +
 * vinheta + grão + dithering, com aberração cromática e distorção de lente.
 */
export class CompositePass extends FullscreenPass {
  /** @param {object} [options] */
  constructor(options = {}) {
    super('composite', { shader: 'composite', ...options });
    this.lastUniforms = null;
  }

  /** @private */
  _defines(ctx) {
    const outputs = ctx.outputs;
    const tonemap = ctx.settings.tonemap;
    return {
      TONEMAP_MODE: tonemapModeOf(tonemap.operator),
      PP_BLOOM: !!outputs.bloom,
      PP_AO: !!outputs.ao,
      PP_SSR: !!outputs.ssr,
      PP_OUTPUT_SRGB: tonemap.srgb !== false,
    };
  }

  /** @private */
  render(ctx) {
    const scene = ctx.scene;
    if (!scene?.texture) return this;
    const settings = ctx.settings;
    const stress = ctx.stress ?? {};
    const lens = settings.lens;
    const grain = settings.grain;
    const vignette = settings.vignette;
    const tonemap = settings.tonemap;

    this.ensureProgram(this._defines(ctx), { operator: tonemap.operator });

    const motion = ctx.motionScale ?? 1;
    const bloomMode = BLOOM_MODES.indexOf(settings.bloom.mode);
    const uniforms = {
      uBloomIntensity: ctx.bloomIntensity ?? 0,
      uBloomMode: bloomMode < 0 ? 0 : bloomMode,
      uAOIntensity: outputsEnabled(ctx.outputs.ao) ? (ctx.aoIntensity ?? settings.ssao.intensity) : 0,
      uSSRIntensity: outputsEnabled(ctx.outputs.ssr) ? (ctx.ssrIntensity ?? settings.ssr.intensity) : 0,
      uExposure: ctx.exposure ?? tonemap.exposure,
      uWhitePoint: tonemap.whitePoint,
      uSaturation: settings.grade.saturation + (stress.saturationBoost ?? 0),
      uContrast: settings.grade.contrast,
      uLift: settings.grade.lift,
      uTemperature: settings.grade.temperature,
      uAberration: lens.aberration + (stress.aberration ?? 0) * motion,
      uDistortion: lens.distortion + (stress.distortion ?? 0) * motion,
      uZoom: lens.zoomCompensation,
      uHeat: lens.heatShimmer + (stress.heatShimmer ?? 0) * motion,
      uSpeedBlur: lens.speedBlur + (stress.speedBlur ?? 0) * motion * 0.35,
      uTime: ctx.time ?? 0,
      uAspect: scene.width / Math.max(1, scene.height),
      uVignette: clamp01(vignette.intensity + (stress.vignette ?? 0) * motion),
      uVignettePower: vignette.power,
      uVignetteColor: parseColorObject(vignette.color),
      uGrain: grain.intensity + (stress.grain ?? 0) * motion,
      uGrainShadow: grain.shadowBoost,
      uDither: settings.dither,
    };
    this.lastUniforms = uniforms;
    this.draw({
      target: ctx.ldrTarget ?? null,
      textures: {
        uScene: scene.texture,
        uBloom: ctx.outputs.bloom?.texture ?? scene.texture,
        uAO: ctx.outputs.ao?.texture ?? scene.texture,
        uSSR: ctx.outputs.ssr?.texture ?? scene.texture,
      },
      uniforms,
      clear: [0, 0, 0, 1],
    });
    ctx.outputs.ldr = ctx.ldrTarget ?? null;
    return this;
  }
}

/** @private `true` se o alvo existe e tem textura. */
function outputsEnabled(target) {
  return !!(target && target.texture);
}

/** @private Cor → `[r, g, b]` linear para uniformes vec3. */
function parseColorObject(color) {
  if (Array.isArray(color) || ArrayBuffer.isView(color)) return Array.from(color);
  const c = parseColor(color);
  return [c.r, c.g, c.b];
}

/**
 * Apresentação final: FXAA 3.11 ou cópia simples, escrevendo no framebuffer
 * padrão (ou em um alvo de saída próprio, para captura de quadro).
 */
export class FXAAPass extends FullscreenPass {
  /**
   * @param {object} [options]
   * @param {'fxaa'|'copy'} [options.mode='fxaa']
   * @param {number} [options.edgeThreshold=0.12]
   * @param {number} [options.edgeMinimum=0.0312]
   */
  constructor(options = {}) {
    super('present', { shader: 'fxaa', ...options });
    this.mode = options.mode ?? 'fxaa';
    this.edgeThreshold = options.edgeThreshold ?? 0.12;
    this.edgeMinimum = options.edgeMinimum ?? 0.0312;
    this.copyProgram = null;
  }

  /** @private */
  init() {
    this.quad = this.pipeline?.quad ?? new FullscreenQuad(this.gl);
    this.copyProgram = new GLProgram(this.gl, {
      ...buildPostShader('copy'), name: 'present:copy', throwOnError: false,
      onError: (d) => { this.lastError = d; },
    });
    return this;
  }

  /** Atualiza parâmetros (`mode: 'fxaa' | 'copy'`). */
  configure(options = {}) {
    if (options.mode) this.mode = options.mode;
    if (options.edgeThreshold !== undefined) this.edgeThreshold = options.edgeThreshold;
    if (options.edgeMinimum !== undefined) this.edgeMinimum = options.edgeMinimum;
    return this;
  }

  /** @private */
  render(ctx) {
    const source = ctx.outputs.ldr?.texture ?? ctx.scene?.texture;
    if (!source) return this;
    const target = ctx.finalTarget ?? null;
    const width = source.width ?? ctx.width;
    const height = source.height ?? ctx.height;

    if (this.mode === 'copy' || !this.ensureProgram({}).program) {
      this.drawWith(this.copyProgram, {
        target,
        textures: { uSource: source },
        uniforms: { uChannel: 0, uScale: 1, uPackedDepth: 0, uDecodeSRGB: 0 },
      });
      return this;
    }
    this.draw({
      target,
      textures: { uSource: source },
      uniforms: {
        uTexel: [1 / width, 1 / height],
        uEdgeThreshold: this.edgeThreshold,
        uEdgeMinimum: this.edgeMinimum,
      },
    });
    return this;
  }

  /** @private */
  dispose() {
    this.copyProgram?.dispose();
    this.copyProgram = null;
    return super.dispose();
  }
}

/**
 * Cadeia ordenada de passes. Permite ligar/desligar, reordenar por `order` e
 * acompanhar estatísticas de erro por passe.
 */
export class PassChain {
  /**
   * @param {PostPass[]} [passes]
   * @param {object} [options]
   * @param {boolean} [options.stopOnError=false] propaga exceções (depuração)
   * @param {(pass:PostPass, error:Error) => void} [options.onError]
   */
  constructor(passes = [], options = {}) {
    this.passes = [];
    this.byName = new Map();
    this.stopOnError = !!options.stopOnError;
    this.onError = options.onError ?? null;
    this.errors = 0;
    this.lastError = null;
    for (const pass of passes) this.add(pass);
  }

  /** Quantidade de passes. */
  get size() { return this.passes.length; }

  /** Nomes na ordem atual. */
  get names() { return this.passes.map((p) => p.name); }

  /** Adiciona (ou substitui, pelo nome) um passe. */
  add(pass) {
    if (!pass || !pass.name) throw new Error('postprocessing.js: passe sem nome.');
    if (this.byName.has(pass.name)) this.remove(pass.name);
    this.passes.push(pass);
    this.byName.set(pass.name, pass);
    this._sort();
    return pass;
  }

  /** Remove um passe pelo nome. */
  remove(name) {
    const pass = this.byName.get(name);
    if (!pass) return null;
    this.byName.delete(name);
    const index = this.passes.indexOf(pass);
    if (index >= 0) this.passes.splice(index, 1);
    return pass;
  }

  /** Obtém um passe pelo nome. */
  get(name) { return this.byName.get(name) ?? null; }

  /** Liga/desliga um passe. */
  setEnabled(name, enabled) {
    const pass = this.byName.get(name);
    if (pass) pass.enabled = !!enabled;
    return this;
  }

  /** `true` se o passe existe e está ativo. */
  isEnabled(name) {
    const pass = this.byName.get(name);
    return !!(pass && pass.enabled);
  }

  /** Vincula todos os passes ao pipeline (cria recursos). */
  attach(pipeline) {
    for (const pass of this.passes) pass.attach(pipeline);
    return this;
  }

  /** Redimensiona todos os passes. */
  resize(width, height) {
    for (const pass of this.passes) pass.resize(width, height);
    return this;
  }

  /** @private Ordena por `order` (estável). */
  _sort() {
    const indexed = this.passes.map((pass, index) => ({ pass, index }));
    indexed.sort((a, b) => (a.pass.order - b.pass.order) || (a.index - b.index));
    this.passes = indexed.map((entry) => entry.pass);
    return this;
  }

  /**
   * Executa a cadeia.
   * @param {object} ctx contexto compartilhado
   * @returns {object} o mesmo contexto (com `outputs` preenchido)
   */
  apply(ctx) {
    for (const pass of this.passes) {
      if (!pass.enabled) continue;
      try {
        pass.render(ctx);
        pass.renderCount += 1;
      } catch (error) {
        this.errors += 1;
        this.lastError = { pass: pass.name, error };
        pass.enabled = false;
        // Loga uma vez por passe: um passe desativado silenciosamente
        // (ex.: shader que não compila no driver) deixa a tela preta sem
        // nenhum sinal no console.
        if (!pass._errorLogged) {
          pass._errorLogged = true;
          console.error(`[Orbiter] passe de pós-processamento "${pass.name}" desativado por erro:`, error);
        }
        if (this.onError) this.onError(pass, error);
        if (this.stopOnError) throw error;
      }
    }
    return ctx;
  }

  /** Libera todos os passes. */
  dispose() {
    for (const pass of this.passes) pass.dispose();
    this.passes.length = 0;
    this.byName.clear();
  }
}

/**
 * Medidor de luminância + adaptação de exposição (eye adaptation).
 * Mede a média logarítmica da cena em 32×32, adapta em 1×1 ao longo do tempo
 * e lê o resultado de volta para a CPU algumas vezes por segundo (barato).
 */
export class LuminanceMeter {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {object} [options]
   * @param {number} [options.readInterval=8] quadros entre leituras da CPU
   */
  constructor(gl, options = {}) {
    this.gl = gl;
    this.readInterval = Math.max(1, options.readInterval ?? 8);
    this.capabilities = options.capabilities ?? describeGLCapabilities(gl);
    this.measureTarget = null;
    this.adaptTargets = [];
    this.current = 0;
    this.measureProgram = null;
    this.adaptProgram = null;
    this.available = false;
    this.averageLuminance = 0.18;
    this.adaptedLuminance = 0.18;
    this.frame = 0;
    this._init(gl);
  }

  /** @private */
  _init(gl) {
    try {
      this.measureTarget = new RenderTarget(gl, {
        width: 32, height: 32, format: 'rgba8', filter: 'linear', name: 'luminance-measure',
        capabilities: this.capabilities,
      });
      for (let i = 0; i < 2; i++) {
        this.adaptTargets.push(new RenderTarget(gl, {
          width: 1, height: 1, format: 'rgba8', filter: 'nearest', name: `exposure-${i}`,
          capabilities: this.capabilities,
        }));
        this.adaptTargets[i].clear(0.5, 0.5, 0.5, 1);
      }
      this.measureProgram = new GLProgram(gl, {
        ...buildPostShader('luminance'), name: 'luminance', throwOnError: false,
      });
      this.adaptProgram = new GLProgram(gl, {
        ...buildPostShader('exposureAdapt'), name: 'exposure', throwOnError: false,
      });
      this.quad = new FullscreenQuad(gl);
      this.available = !!(this.measureProgram.program && this.adaptProgram.program);
    } catch {
      this.available = false;
    }
  }

  /**
   * Atualiza a medição/adaptação.
   * @param {RenderTarget} scene
   * @param {number} delta segundos
   * @param {object} [options] `speed` (1/s)
   */
  update(scene, delta, options = {}) {
    if (!this.available || !scene?.texture) return this;
    const gl = this.gl;
    this.frame += 1;

    this.measureTarget.bind();
    GLState.resetForPost(gl);
    this.measureProgram.use();
    this.measureProgram.bindTexture('uScene', scene.texture);
    this.measureProgram.setUniforms({ uTexel: [1 / scene.width, 1 / scene.height] });
    this.quad.draw(this.measureProgram);

    const previous = this.adaptTargets[this.current];
    const next = this.adaptTargets[1 - this.current];
    next.bind();
    GLState.resetForPost(gl);
    this.adaptProgram.use();
    this.adaptProgram.bindTexture('uMeasure', this.measureTarget.texture);
    this.adaptProgram.bindTexture('uPrevious', previous.texture);
    this.adaptProgram.setUniforms({
      uSpeed: options.speed ?? 2.2,
      uDelta: Math.max(0, delta ?? 0),
    });
    this.quad.draw(this.adaptProgram);
    this.current = 1 - this.current;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this;
  }

  /** @private Decodifica a luminância adaptada do alvo 1×1. */
  _readEncoded() {
    const target = this.adaptTargets[this.current];
    if (!target) return 0.18;
    const gl = this.gl;
    const pixel = new Uint8Array(4);
    target.bind();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const encoded = pixel[0] / 255;
    this.adaptedLuminance = Math.exp((encoded - 0.5) * 20);
    return this.adaptedLuminance;
  }

  /**
   * Lê a luminância adaptada (a cada `readInterval` quadros).
   * @returns {number} luminância média adaptada
   */
  read() {
    if (!this.available) return this.adaptedLuminance;
    if (this.frame > 1 && this.frame % this.readInterval !== 0) return this.adaptedLuminance;
    try {
      this.averageLuminance = this._readEncoded();
    } catch {
      /* readPixels pode falhar com o contexto perdido */
    }
    return this.averageLuminance;
  }

  /** Libera recursos. */
  dispose() {
    this.measureTarget?.dispose();
    for (const target of this.adaptTargets) target.dispose();
    this.adaptTargets = [];
    this.measureProgram?.dispose();
    this.adaptProgram?.dispose();
    this.quad?.dispose();
    this.available = false;
  }
}

/* ========================================================================== */
/*  7. PostProcessingPipeline                                                 */
/* ========================================================================== */

/** @private Estado de intensidade neutro (sem telemetria). */
function neutralStress() {
  return {
    gForce01: 0,
    speed01: 0,
    reentry01: 0,
    heat01: 0,
    mach01: 0,
    vacuum01: 0,
    bloomBoost01: 0,
    aberration: 0,
    distortion: 0,
    heatShimmer: 0,
    speedBlur: 0,
    vignette: 0,
    grain: 0,
    saturationBoost: 0,
  };
}

/** @private Extrai near/far/normalização de uma matriz de projeção 4×4. */
function cameraFromProjectionMatrix(matrix, aspect = 1) {
  if (!matrix || matrix.length < 16) return null;
  const p00 = matrix[0];
  const p11 = matrix[5];
  const p22 = matrix[10];
  const p32 = matrix[14];
  // Perspectiva: P[3][2] = -1 e P[2][3] = -2fn/(f-n).
  const orthographic = Math.abs(matrix[15] - 1) < 1e-6;
  let near = 0.1;
  let far = 1000;
  if (!orthographic) {
    const denom = p22 - 1;
    if (Math.abs(denom) > 1e-9) near = p32 / denom;
    const denom2 = p22 + 1;
    if (Math.abs(denom2) > 1e-9) far = p32 / denom2;
    if (!(near > 0)) near = 0.1;
    if (!(far > near)) far = near + 1000;
  }
  const orthoSize = orthographic
    ? [Math.abs(1 / (p00 || 1)), Math.abs(1 / (p11 || 1))]
    : [1, 1];
  return {
    mode: orthographic ? 'orthographic' : 'perspective',
    near,
    far,
    projection: [Math.abs(p00) || 1, Math.abs(p11) || 1],
    orthoSize,
    aspect,
  };
}

/**
 * Pipeline completo de pós-processamento para WebGL1/WebGL2.
 *
 * Ordem padrão dos passes (todos opcionais em runtime):
 *   depthEncode → SSAO (+ sombras de contato) → SSR → Bloom → Composite →
 *   Present (FXAA).
 *
 * O pipeline aceita cenas próprias em WebGL (`begin`/`end`) ou cenas
 * desenhadas em Canvas2D (`renderExternalScene`), usando o `FakeGBuffer` do
 * `Renderer` para profundidade/normais.
 *
 * @example
 *   const pipeline = new PostProcessingPipeline(glCanvas, { quality: 'high' });
 *   pipeline.setCamera({ mode: 'perspective', near: 0.1, far: 5000, projection: [1.7, 2.4] });
 *   pipeline.begin();
 *   drawEverything(gl);
 *   pipeline.end({ depth: depthTexture, normals: normalTexture });
 */
export class PostProcessingPipeline {
  /**
   * @param {HTMLCanvasElement|WebGLRenderingContext} canvasOrGL
   * @param {object} [options] ver `DEFAULT_POST_OPTIONS`
   */
  constructor(canvasOrGL, options = {}) {
    const isContext = !!canvasOrGL && typeof canvasOrGL.createProgram === 'function'
      && typeof canvasOrGL.getParameter === 'function';
    const canvas = isContext ? (canvasOrGL.canvas ?? null) : canvasOrGL;
    const quality = options.quality ?? 'high';
    this.userOptions = { ...options };
    this.options = resolvePostOptions(quality, options);
    this.qualityName = typeof quality === 'string' ? quality : 'custom';

    let gl = isContext ? canvasOrGL : null;
    if (!gl) {
      const detected = detectWebGLSupport(canvas, this.options.context ?? {});
      gl = detected.gl;
      if (!gl) throw new Error('postprocessing.js: WebGL indisponível neste ambiente.');
    }
    this.gl = gl;
    this.canvas = canvas ?? gl.canvas ?? null;
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
      && gl instanceof WebGL2RenderingContext;
    this.capabilities = describeGLCapabilities(gl);
    this.manageCanvasSize = options.manageCanvasSize !== false;

    const initialWidth = Math.max(1, options.width ?? this.canvas?.width ?? 1);
    const initialHeight = Math.max(1, options.height ?? this.canvas?.height ?? 1);
    this.drawingWidth = initialWidth;
    this.drawingHeight = initialHeight;
    this.width = initialWidth;
    this.height = initialHeight;

    this.pixelRatio = options.pixelRatio ?? 1;
    this.renderScale = 1;
    this.maxPixels = options.maxPixels ?? this.options.maxPixels;
    this.enabled = this.options.enabled !== false;

    this.state = new GLState(gl);
    this.timer = new TimerQuery(gl);
    this.quad = new FullscreenQuad(gl);
    this.pool = new RenderTargetPool(gl, { capabilities: this.capabilities });

    this.sceneRT = null;
    this.ldrRT = null;
    this.sceneTexture = new DynamicTexture(gl, { flipY: true, filter: 'linear' });
    this.depthTexture = null;
    this.normalTexture = null;
    this.materialTexture = null;
    this.nativeDepthTexture = null;
    this.depthSource = options.depthSource ?? 'external';
    this.outputTarget = null;
    this.lightDirection = [0.6, 0.8];

    this.camera = {
      mode: 'orthographic',
      near: 0,
      far: 1,
      projection: [1, 1],
      orthoSize: [0.5, 0.5],
      aspect: initialWidth / initialHeight,
    };

    this.frame = 0;
    this.time = 0;
    this.delta = 0;
    this.exposure = this.options.tonemap.exposure;
    this.averageLuminance = 0.18;
    this.stress = neutralStress();
    this.motionScale = this.options.motionScale ?? 1;
    this._sceneScaleCache = 1;
    this._skipPresent = false;
    this._frameActive = false;

    this.stats = {
      fps: 0,
      frameMs: 0,
      gpuMs: null,
      drawCalls: 0,
      passes: 0,
      bloomThreshold: this.options.bloom.threshold,
      bloomIntensity: this.options.bloom.intensity,
      resolutionScale: this.renderScale,
      width: this.width,
      height: this.height,
      hdr: false,
      msaa: 0,
    };
    this._fpsEma = 60;
    this._lastAdapt = 0;

    this.meter = this.options.tonemap.autoExposure
      ? new LuminanceMeter(gl, { capabilities: this.capabilities })
      : null;

    this._createPasses();
    this.resize(initialWidth, initialHeight, this.pixelRatio);
  }

  /** @private Instancia passes e cadeia. */
  _createPasses() {
    const o = this.options;
    this.copyPass = new CopyPass({ order: 0 });
    this.depthPass = new DepthEncodePass({ order: 5, mode: 'perspective' });
    this.ssaoPass = new SSAOPass({
      order: 10,
      config: {
        ...o.ssao,
        contactRayLength: o.ssao.contactRayLength ?? 0.12,
        contactThickness: o.ssao.contactThickness ?? 0.01,
      },
    });
    this.ssrPass = new SSRPass({ order: 20, config: o.ssr });
    this.bloomPass = new BloomPass({
      order: 30,
      config: {
        ...o.bloom,
        mipCount: o.bloom.mips,
        threshold: o.bloom.threshold,
        tint: parseColorObject(o.bloom.tint),
        streakTint: parseColorObject(o.bloom.streakTint),
      },
    });
    this.compositePass = new CompositePass({ order: 40 });
    this.presentPass = new FXAAPass({
      order: 50,
      mode: o.fxaa.enabled ? 'fxaa' : 'copy',
      edgeThreshold: o.fxaa.edgeThreshold,
      edgeMinimum: o.fxaa.edgeMinimum,
    });

    this.chain = new PassChain(
      [this.depthPass, this.ssaoPass, this.ssrPass, this.bloomPass, this.compositePass, this.presentPass],
      { onError: (pass, error) => { this.lastError = { pass: pass.name, error }; } },
    );
    this.chain.attach(this);
    this.copyPass.attach(this);

    this.ssaoPass.config.enabled = o.ssao.enabled;
    this.ssrPass.config.enabled = o.ssr.enabled;
    this.bloomPass.config.enabled = o.bloom.enabled;
    this.ssaoPass.config.contactShadows = o.ssao.contactShadows;
  }

  /** @private (Re)aloca alvos de cena e LDR conforme resolução/teto de pixels. */
  _allocateTargets() {
    const qualityScale = this.options.scale ?? 1;
    let width = Math.max(1, Math.round(this.drawingWidth * qualityScale * this.renderScale));
    let height = Math.max(1, Math.round(this.drawingHeight * qualityScale * this.renderScale));
    const pixels = width * height;
    if (this.maxPixels > 0 && pixels > this.maxPixels) {
      const k = Math.sqrt(this.maxPixels / pixels);
      width = Math.max(1, Math.round(width * k));
      height = Math.max(1, Math.round(height * k));
    }
    if (this.sceneRT && this.sceneRT.width === width && this.sceneRT.height === height) {
      return this;
    }
    if (this.sceneRT) this.pool.release(this.sceneRT);
    if (this.ldrRT) this.pool.release(this.ldrRT);

    const msaa = this.isWebGL2 ? Math.min(this.options.msaa ?? 0, this.capabilities.maxSamples) : 0;
    this.sceneRT = this.pool.acquire({
      width,
      height,
      format: this.options.hdr ? 'rgba16f' : 'rgba8',
      hdr: this.options.hdr !== false,
      depth: this.depthSource === 'native' ? 'texture' : false,
      samples: msaa,
      filter: 'linear',
      name: 'scene',
    });
    this.ldrRT = this.pool.acquire({
      width,
      height,
      format: 'rgba8',
      filter: 'linear',
      name: 'ldr',
    });

    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.stats.width = width;
    this.stats.height = height;
    this.stats.hdr = this.sceneRT.isHdr;
    this.stats.msaa = this.sceneRT.samples;
    this.chain.resize(width, height);
    return this;
  }

  /**
   * Redimensiona o pipeline.
   * @param {number} width largura CSS/lógica
   * @param {number} height altura CSS/lógica
   * @param {number} [pixelRatio=this.pixelRatio]
   */
  resize(width, height, pixelRatio = this.pixelRatio) {
    this.pixelRatio = Math.max(0.1, pixelRatio || 1);
    this.drawingWidth = Math.max(1, Math.round(width * this.pixelRatio));
    this.drawingHeight = Math.max(1, Math.round(height * this.pixelRatio));
    if (this.canvas && this.manageCanvasSize) {
      if (this.canvas.width !== this.drawingWidth) this.canvas.width = this.drawingWidth;
      if (this.canvas.height !== this.drawingHeight) this.canvas.height = this.drawingHeight;
    }
    this._allocateTargets();
    return this;
  }

  /** Define a câmera usada na reconstrução de posição (SSAO/SSR). */
  setCamera(camera = {}) {
    const c = { ...this.camera };
    if (camera.projectionMatrix) {
      const derived = cameraFromProjectionMatrix(camera.projectionMatrix, camera.aspect ?? c.aspect);
      if (derived) Object.assign(c, derived);
    }
    for (const key of ['mode', 'near', 'far', 'projection', 'orthoSize', 'aspect']) {
      if (camera[key] !== undefined) c[key] = camera[key];
    }
    if (camera.mode === 'perspective' && camera.fov) {
      const f = 1 / Math.tan((camera.fov * Math.PI) / 360);
      c.projection = [f, f];
    }
    this.camera = c;
    this._sceneScaleCache = this._sceneScale();
    return this;
  }

  /** @private Escala de cena usada para converter raios normalizados. */
  _sceneScale() {
    const c = this.camera;
    if (c.mode === 'orthographic') {
      return Math.max(1e-6, Math.min(c.orthoSize[0], c.orthoSize[1]));
    }
    return Math.max(1e-6, (c.far - c.near) * 0.25);
  }

  /** Direção da luz em espaço de tela (UV), usada pelas sombras de contato. */
  setLightDirection(x, y = null) {
    if (Array.isArray(x)) {
      this.lightDirection = [Number(x[0]) || 0, Number(x[1]) || 0];
    } else {
      this.lightDirection = [Number(x) || 0, Number(y) || 0];
    }
    const length = Math.hypot(this.lightDirection[0], this.lightDirection[1]) || 1;
    this.lightDirection = [this.lightDirection[0] / length, this.lightDirection[1] / length];
    return this;
  }

  /**
   * Define a textura de profundidade empacotada (RG, 16 bits) — normalmente
   * produzida pelo `FakeGBuffer` do `Renderer`.
   */
  setDepthTexture(texture, options = {}) {
    this.depthTexture = texture ?? null;
    if (options.source) this.depthSource = options.source;
    return this;
  }

  /** Define o buffer de normais em espaço de câmera (`n * 0.5 + 0.5`). */
  setNormalTexture(texture) {
    this.normalTexture = texture ?? null;
    return this;
  }

  /** Máscara de refletividade (R) para o SSR (oceanos/superfícies polidas). */
  setMaterialTexture(texture) {
    this.materialTexture = texture ?? null;
    return this;
  }

  /**
   * Vincula textura(s) de profundidade nativa, ativando o `DepthEncodePass`.
   * @param {WebGLTexture} texture textura de profundidade do framebuffer
   */
  setNativeDepth(texture) {
    this.nativeDepthTexture = texture ?? null;
    this.depthSource = texture ? 'native' : 'external';
    return this;
  }

  /**
   * Inicia um quadro em WebGL: guarda estado, vincula o alvo HDR e limpa.
   * @returns {RenderTarget} alvo de cena
   */
  begin(options = {}) {
    const gl = this.gl;
    this.state.push();
    const target = options.target ?? this.sceneRT;
    target.bind();
    GLState.resetForPost(gl);
    const clear = options.clearColor ?? this.options.clearColor ?? [0, 0, 0, 1];
    gl.clearColor(clear[0] ?? 0, clear[1] ?? 0, clear[2] ?? 0, clear[3] ?? 1);
    gl.clear(gl.COLOR_BUFFER_BIT | (target.depthMode ? gl.DEPTH_BUFFER_BIT : 0));
    this._frameActive = true;
    return target;
  }

  /**
   * Finaliza o quadro: resolve MSAA, aplica a cadeia e restaura o estado GL.
   * @param {object} [options] `depth`, `normals`, `material`, `finalTarget`
   */
  end(options = {}) {
    if (!this._frameActive) this.begin();
    if (options.depth !== undefined) this.setDepthTexture(options.depth);
    if (options.normals !== undefined) this.setNormalTexture(options.normals);
    if (options.material !== undefined) this.setMaterialTexture(options.material);
    this.applyPasses(options);
    this.state.pop();
    this._frameActive = false;
    return this;
  }

  /** @private Contexto compartilhado entre os passes. */
  _buildContext(options = {}) {
    const outputs = {};
    const ctx = {
      pipeline: this,
      gl: this.gl,
      frame: this.frame,
      time: this.time,
      delta: this.delta,
      width: this.width,
      height: this.height,
      scene: this.sceneRT,
      depthTexture: this.depthTexture,
      nativeDepthTexture: this.nativeDepthTexture,
      normalTexture: this.normalTexture,
      materialTexture: this.materialTexture,
      camera: this.camera,
      sceneScale: this._sceneScaleCache,
      ldrTarget: this.ldrRT,
      finalTarget: options.finalTarget ?? this.outputTarget ?? null,
      settings: this.options,
      stress: this.stress,
      exposure: this.exposure,
      lightDirection: this.lightDirection,
      motionScale: this.motionScale,
      outputs,
      source: options.source ?? null,
      debug: this.options.debug?.pass ?? null,
    };
    ctx.bloomIntensity = this._bloomIntensity();
    ctx.bloomThreshold = this._bloomThreshold();
    ctx.aoIntensity = this.ssaoPass.config.enabled ? this.ssaoPass.config.intensity : 0;
    ctx.ssrIntensity = this.ssrPass.config.enabled ? this.ssrPass.config.intensity : 0;
    return ctx;
  }

  /** @private Intensidade do bloom (config + intensidade física). */
  _bloomIntensity() {
    const bloom = this.options.bloom;
    if (!bloom.enabled) return 0;
    const boost = this.stress?.bloomBoost01 ?? 0;
    return bloom.intensity * (1 + boost * STRESS_DEFAULTS.bloomBoost);
  }

  /** @private Threshold dinâmico do bloom. */
  _bloomThreshold() {
    const bloom = this.options.bloom;
    const base = computeBloomThreshold({
      base: bloom.threshold,
      exposure: this.exposure,
      averageLuminance: this.meter?.averageLuminance ?? this.averageLuminance,
      min: bloom.thresholdMin ?? 0.15,
      max: bloom.thresholdMax ?? 3.5,
      adaptation: bloom.thresholdAdaptation ?? 0.35,
    });
    const drop = (this.stress?.bloomBoost01 ?? 0) * STRESS_DEFAULTS.bloomThresholdDrop;
    return Math.max(0.02, base - drop);
  }

  /**
   * Aplica a cadeia de passes (sem novo `begin`). Útil quando a cena é
   * fornecida externamente (canvas 2D ou textura pronta).
   *
   * @param {object} [options] `finalTarget`, `depth`, `normals`, `material`
   * @returns {object} contexto com `outputs`
   */
  applyPasses(options = {}) {
    if (options.depth !== undefined) this.setDepthTexture(options.depth);
    if (options.normals !== undefined) this.setNormalTexture(options.normals);
    if (options.material !== undefined) this.setMaterialTexture(options.material);
    if (this.sceneRT?.multisampled) this.sceneRT.resolve();

    this.frame += 1;
    this.stats.passes = 0;
    this.timer.begin();

    const ctx = this._buildContext(options);

    if (!this.enabled) {
      const texture = this.sceneRT?.texture;
      if (texture) {
        this.copyPass.render(ctx, { texture, target: ctx.finalTarget, scale: 1 });
      }
      this.timer.end();
      this.stats.gpuMs = this.timer.poll();
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      this.lastContext = ctx;
      return ctx;
    }

    if (this.depthSource === 'native' && this.sceneRT?.depthTexture) {
      this.depthPass.render(ctx, { depth: this.sceneRT.depthTexture });
      ctx.depthTexture = ctx.outputs.depth?.texture ?? null;
    }

    this.bloomPass.configure({ scatter: this._bloomScatter() });
    const debugPass = ctx.debug;
    const presentEnabled = this.presentPass.enabled;
    if (debugPass) this.presentPass.enabled = false;

    this.chain.apply(ctx);
    this.stats.passes = this.chain.passes.filter((p) => p.enabled).length;

    if (debugPass) {
      this.presentPass.enabled = presentEnabled;
      const output = ctx.outputs[debugPass] ?? ctx.outputs[debugPass === 'depth' ? 'depth' : debugPass];
      const texture = output?.texture ?? (debugPass === 'scene' ? ctx.scene?.texture : null);
      if (texture) {
        this.copyPass.render(ctx, {
          texture,
          target: ctx.finalTarget,
          channel: this.options.debug?.channel ?? 0,
          scale: this.options.debug?.scale ?? 1,
          packedDepth: debugPass === 'depth',
        });
      }
    }

    this.timer.end();
    this.stats.gpuMs = this.timer.poll();
    this.stats.bloomThreshold = ctx.bloomThreshold;
    this.stats.bloomIntensity = ctx.bloomIntensity;
    this.stats.drawCalls = this.chain.passes
      .filter((pass) => pass.enabled && pass.renderCount > 0)
      .length;
    this.lastContext = ctx;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    return ctx;
  }

  /** @private Espalhamento do bloom (cresce no vácuo — pluma sem contrapressão). */
  _bloomScatter() {
    const base = this.options.bloom.scatter;
    const vacuum = clamp01(this.stress?.vacuum01 ?? 0);
    return clamp(base + vacuum * STRESS_DEFAULTS.bloomRadiusBoost * 0.2, 0.3, 1);
  }

  /**
   * Renderiza uma cena vinda de um canvas 2D (ou textura) e apresenta.
   *
   * @param {HTMLCanvasElement|WebGLTexture} source
   * @param {object} [options] `depth`, `normals`, `material`, `decodeSRGB`,
   *   `finalTarget`
   * @returns {PostProcessingPipeline}
   */
  renderExternalScene(source, options = {}) {
    if (!source) return this;
    this.state.push();
    let texture = source;
    if (!(typeof WebGLTexture !== 'undefined' && source instanceof WebGLTexture)) {
      this.sceneTexture.upload(source);
      texture = this.sceneTexture.texture;
    }
    this.sceneRT.bind();
    GLState.resetForPost(this.gl);
    this.copyPass.render({ scene: this.sceneRT, source: texture }, {
      texture,
      target: this.sceneRT,
      decodeSRGB: options.decodeSRGB !== false,
      scale: options.scale ?? 1,
    });
    this.applyPasses(options);
    this.state.pop();
    return this;
  }

  /**
   * Atualiza exposição/resolução adaptativa e estatísticas.
   * @param {number} dt segundos
   * @param {object} [telemetry] telemetria de física/atmosfera (opcional)
   */
  update(dt = 0, telemetry = null) {
    const delta = Math.max(0, Math.min(Number(dt) || 0, 0.25));
    this.delta = delta;
    this.time += delta;
    if (delta > 0) {
      this._fpsEma = this._fpsEma * 0.9 + (1 / delta) * 0.1;
      this.stats.fps = this._fpsEma;
      this.stats.frameMs = 1000 / Math.max(1, this._fpsEma);
    }
    if (telemetry) this.setTelemetry(telemetry);

    const tonemap = this.options.tonemap;
    if (tonemap.autoExposure && !this.meter) {
      this.meter = new LuminanceMeter(this.gl, { capabilities: this.capabilities });
    }
    if (this.meter && tonemap.autoExposure) {
      this.meter.update(this.sceneRT, delta, { speed: tonemap.adaptationSpeed });
      const luma = this.meter.read();
      this.averageLuminance = luma;
      const target = clamp(tonemap.keyValue / Math.max(luma, 1e-4), tonemap.minExposure, tonemap.maxExposure);
      this.exposure = damp(this.exposure, target, 3.5, delta);
    } else {
      this.exposure = tonemap.exposure;
    }

    this._updateResolution(delta);
    this.stats.resolutionScale = this.renderScale;
    return this;
  }

  /** @private Resolução adaptativa (mantém a taxa de quadros alvo). */
  _updateResolution(dt) {
    const cfg = this.options.adaptiveResolution;
    if (!cfg?.enabled || dt <= 0) return;
    this._lastAdapt += dt;
    if (this._lastAdapt < cfg.interval) return;
    this._lastAdapt = 0;
    const fps = this._fpsEma;
    const min = cfg.minScale ?? 0.6;
    const max = Math.min(cfg.maxScale ?? 1, 1);
    let next = this.renderScale;
    if (fps < cfg.targetFps - 4 && this.renderScale > min) {
      next = Math.max(min, this.renderScale - cfg.step);
    } else if (fps > cfg.targetFps + 6 && this.renderScale < max) {
      next = Math.min(max, this.renderScale + cfg.step);
    }
    if (Math.abs(next - this.renderScale) > 1e-4) {
      this.renderScale = next;
      this._allocateTargets();
    }
  }

  /** Aceita telemetria crua (`engine.getTelemetry` + `atmo.getTelemetry`). */
  setTelemetry(telemetry) {
    this._telemetry = telemetry;
    return this;
  }

  /** Atualiza o estado de intensidade dos efeitos (valores 0..1). */
  setStress(state = {}) {
    this.stress = { ...neutralStress(), ...state };
    return this;
  }

  /** Liga/desliga um efeito por nome (`EFFECT_NAMES`). */
  setEffect(name, value = true) {
    const o = this.options;
    switch (name) {
      case 'bloom': this.bloomPass.config.enabled = !!value; o.bloom.enabled = !!value; break;
      case 'ssao': this.ssaoPass.config.enabled = !!value; o.ssao.enabled = !!value; break;
      case 'ssr': this.ssrPass.config.enabled = !!value; o.ssr.enabled = !!value; break;
      case 'contactShadows':
        this.ssaoPass.config.contactShadows = !!value; o.ssao.contactShadows = !!value; break;
      case 'aberration': o.lens.aberration = Number(value); break;
      case 'distortion': o.lens.distortion = Number(value); break;
      case 'heatShimmer': o.lens.heatShimmer = Number(value); break;
      case 'speedBlur': o.lens.speedBlur = Number(value); break;
      case 'vignette': o.vignette.intensity = Number(value); break;
      case 'grain': o.grain.intensity = Number(value); break;
      case 'fxaa':
        o.fxaa.enabled = !!value;
        this.presentPass.configure({ mode: value ? 'fxaa' : 'copy' });
        break;
      default: return this;
    }
    return this;
  }

  /** Liga/desliga um efeito booleano (alias de `setEffect`). */
  enable(name, enabled = true) { return this.setEffect(name, enabled); }

  /** Aplica um preset de qualidade (recompila variantes se necessário). */
  setQuality(quality) {
    const preset = typeof quality === 'string' ? POST_QUALITY[quality] : quality;
    if (!preset) return this;
    this.qualityName = typeof quality === 'string' ? quality : 'custom';
    this.options = resolvePostOptions(quality, this.userOptions ?? {});
    this.ssaoPass.setQuality(preset);
    this.ssrPass.setQuality(preset);
    this.bloomPass.setQuality(preset);
    this.presentPass.configure({ mode: this.options.fxaa.enabled ? 'fxaa' : 'copy' });
    this._allocateTargets();
    return this;
  }

  /** Liga/desliga o pipeline inteiro (quando desligado, `end()` só blita). */
  setEnabled(enabled) {
    this.enabled = !!enabled;
    return this;
  }

  /** Captura o framebuffer padrão como data URL (requer `preserveDrawingBuffer`). */
  capture(type = 'image/png') {
    if (!this.canvas || typeof this.canvas.toDataURL !== 'function') return null;
    try { return this.canvas.toDataURL(type); } catch { return null; }
  }

  /** Resumo de estado para HUD/depuração. */
  toJSON() {
    return {
      quality: this.qualityName,
      width: this.width,
      height: this.height,
      drawingWidth: this.drawingWidth,
      drawingHeight: this.drawingHeight,
      renderScale: this.renderScale,
      hdr: this.stats.hdr,
      msaa: this.stats.msaa,
      exposure: this.exposure,
      averageLuminance: this.averageLuminance,
      bloomThreshold: this.stats.bloomThreshold,
      bloomIntensity: this.stats.bloomIntensity,
      gpuMs: this.stats.gpuMs,
      passes: this.chain.names,
      enabled: this.chain.passes.filter((p) => p.enabled).map((p) => p.name),
      errors: this.chain.errors,
      stress: this.stress,
    };
  }

  /** Libera todos os recursos GL. */
  dispose() {
    // Passes auxiliares (ex.: `copyPass`, usado por debug/captura) podem não
    // estar na cadeia — sem isso o programa deles vazaria.
    const chained = new Set(this.chain?.passes ?? []);
    for (const pass of [
      this.copyPass, this.depthPass, this.ssaoPass, this.ssrPass,
      this.bloomPass, this.compositePass, this.presentPass,
    ]) {
      if (pass && !chained.has(pass)) pass.dispose();
    }
    this.chain.dispose();
    this.sceneTexture.dispose();
    if (this.sceneRT) this.pool.release(this.sceneRT);
    if (this.ldrRT) this.pool.release(this.ldrRT);
    this.pool.dispose();
    this.meter?.dispose();
    this.timer.dispose();
    this.quad.dispose();
    this.sceneRT = null;
    this.ldrRT = null;
    this.meter = null;
  }
}

/** Atalho para criar o pipeline. */
export function createPostProcessingPipeline(canvasOrGL, options = {}) {
  return new PostProcessingPipeline(canvasOrGL, options);
}

/* ========================================================================== */
/*  8. Intensidade física dos efeitos                                         */
/* ========================================================================== */

/**
 * Converte telemetria física em intensidades de efeitos de pós-processamento.
 *
 * Modelo (documentado em `STRESS_DEFAULTS`):
 *  - G sustentado alto → visão em túnel: vinheta cresce, saturação cai
 *    (efeito de "greyout"), leve aberração por vibração estrutural;
 *  - velocidade orbital relativa à circular → aberração cromática e
 *    distorção de lente (leitura subjetiva de compressão do espaço);
 *  - reentrada (fluxo térmico) → tremulação de calor, grão e bloom extra;
 *  - alto Mach na atmosfera → tremulação e vinheta;
 *  - vácuo + empuxo → pluma expande sem contrapressão: bloom maior e mais
 *    espalhado (via `vacuum01`/`bloomBoost01`).
 *
 * A suavização usa ataque rápido e liberação lenta, evitando "pulos" quando a
 * telemetria oscila (ex.: colisões e manobras).
 *
 * @example
 *   const stress = new EffectStressController();
 *   stress.update(dt, stress.fromTelemetry(engine.getTelemetry(sc), atmo.getTelemetry(sc)));
 *   pipeline.setStress(stress.state);
 */
export class EffectStressController {
  /**
   * @param {object} [options]
   * @param {object} [options.model] sobrescreve `STRESS_DEFAULTS`
   * @param {number} [options.motionScale=1] 0..1 (acessibilidade)
   * @param {boolean} [options.enabled=true]
   */
  constructor(options = {}) {
    this.model = { ...STRESS_DEFAULTS, ...(options.model ?? {}) };
    this.enabled = options.enabled !== false;
    this.motionScale = clamp01(options.motionScale ?? 1);
    if (this.model.respectReducedMotion && typeof matchMedia === 'function') {
      try {
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
          this.motionScale *= 0.25;
          this.reducedMotion = true;
        }
      } catch { /* ambiente sem matchMedia */ }
    }
    this.raw = {
      gForce: 0,
      speedRatio: 1,
      heatFlux: 0,
      hullTemperature: 0,
      mach: 0,
      density: null,
      altitude: null,
      throttle: 0,
      reentry: false,
    };
    this.channels = {
      gForce01: 0, speed01: 0, reentry01: 0, heat01: 0, mach01: 0, vacuum01: 0, bloomBoost01: 0,
    };
    this.intensities = {
      aberration: 0,
      distortion: 0,
      heatShimmer: 0,
      speedBlur: 0,
      vignette: 0,
      grain: 0,
      saturationBoost: 0,
      bloomBoost01: 0,
      vacuum01: 0,
    };
    this.time = 0;
  }

  /** Ajusta a escala global de movimento (0 = sem efeitos). */
  setMotionScale(scale) {
    this.motionScale = clamp01(scale);
    return this;
  }

  /** Zera canais e intensidades. */
  reset() {
    for (const key of Object.keys(this.channels)) this.channels[key] = 0;
    for (const key of Object.keys(this.intensities)) this.intensities[key] = 0;
    return this;
  }

  /**
   * Normaliza a telemetria do simulador.
   * @param {object} [physics] `engine.getTelemetry(sc)` ou `{ gForce, speed, ... }`
   * @param {object} [atmosphere] `atmo.getTelemetry(sc)` ou `{ density, heatFlux, ... }`
   * @returns {object} entrada normalizada
   */
  fromTelemetry(physics = {}, atmosphere = {}) {
    const p = physics ?? {};
    const a = atmosphere ?? {};
    const orbitalVelocity = p.orbitalVelocity ?? p.speed ?? 0;
    const circularVelocity = p.circularVelocity ?? null;
    return {
      gForce: p.gForceNet ?? p.gForce ?? 0,
      orbitalVelocity,
      circularVelocity,
      speedRatio: circularVelocity > 0 ? orbitalVelocity / circularVelocity : (p.speedRatio ?? 1),
      heatFlux: a.heatFlux ?? 0,
      hullTemperature: a.hullTemperature ?? a.temperature ?? 0,
      mach: a.mach ?? 0,
      dynamicPressure: a.dynamicPressure ?? 0,
      density: a.density ?? null,
      altitude: p.altitude ?? a.altitude ?? null,
      throttle: p.throttle ?? 0,
      reentry: !!(a.reentry ?? false),
    };
  }

  /**
   * Calcula os canais normalizados (0..1) para uma entrada.
   * @returns {object} canais normalizados
   */
  evaluate(input = {}) {
    const m = this.model;
    const gForce = Math.max(0, Number(input.gForce ?? 0));
    const speedRatio = Number.isFinite(input.speedRatio)
      ? input.speedRatio
      : (input.circularVelocity > 0
        ? (input.orbitalVelocity ?? 0) / input.circularVelocity
        : 1);
    const heatFlux = Math.max(0, Number(input.heatFlux ?? 0));
    const hull = Math.max(0, Number(input.hullTemperature ?? 0));
    const mach = Math.max(0, Number(input.mach ?? 0));
    const density = Number.isFinite(input.density) ? input.density : null;
    const throttle = clamp01(input.throttle ?? 0);

    this.raw = {
      gForce,
      speedRatio,
      heatFlux,
      hullTemperature: hull,
      mach,
      density,
      altitude: input.altitude ?? null,
      throttle,
      reentry: !!input.reentry,
    };

    const channels = this.channels;
    channels.gForce01 = smoothstep(m.gForce.start, m.gForce.full, gForce);
    channels.speed01 = smoothstep(m.speedRatio.start, m.speedRatio.full, speedRatio);
    channels.reentry01 = smoothstep(m.reentry.start, m.reentry.full, heatFlux);
    channels.heat01 = smoothstep(m.heat.start, m.heat.full, hull);
    channels.mach01 = smoothstep(m.mach.start, m.mach.full, mach);
    channels.vacuum01 = density === null
      ? 0
      : 1 - smoothstep(1e-6, 1e-3, Math.max(0, density));
    channels.bloomBoost01 = clamp01(
      throttle * channels.vacuum01 * 1.15
      + channels.heat01 * 0.8
      + channels.reentry01 * 0.5,
    );
    return channels;
  }

  /**
   * Atualiza as intensidades com suavização assimétrica.
   * @param {number} dt segundos
   * @param {object} [input] saída de `fromTelemetry` (ou valores crus)
   * @returns {object} intensidades prontas para o pipeline
   */
  update(dt = 0, input = null) {
    const delta = Math.max(0, Math.min(Number(dt) || 0, 0.25));
    this.time += delta;
    if (!this.enabled) {
      this.reset();
      return this.state;
    }
    if (input) this.evaluate(input);
    const target = this._targets();
    const k = this.model;
    for (const key of Object.keys(this.intensities)) {
      if (key === 'bloomBoost01' || key === 'vacuum01') continue;
      const current = this.intensities[key];
      const goal = target[key] ?? 0;
      const lambda = goal > current ? k.attack : k.release;
      this.intensities[key] = damp(current, goal, lambda, delta || 1 / 60);
    }
    this.intensities.bloomBoost01 = damp(
      this.intensities.bloomBoost01, target.bloomBoost01, k.attack, delta || 1 / 60,
    );
    this.intensities.vacuum01 = damp(
      this.intensities.vacuum01, target.vacuum01, k.release, delta || 1 / 60,
    );
    return this.state;
  }

  /** @private Intensidades alvo a partir dos canais. */
  _targets() {
    const k = this.channels;
    const m = this.model;
    const motion = this.motionScale;
    const speed = Math.pow(k.speed01, 1.25);
    return {
      aberration: (speed * 0.62 + k.gForce01 * 0.26 + k.reentry01 * 0.5) * m.maxAberration * motion,
      distortion: (k.speed01 * 0.55 + k.gForce01 * 0.22) * m.maxDistortion * motion,
      heatShimmer: (k.heat01 * 0.8 + k.reentry01 * 0.4) * m.maxHeatShimmer * motion,
      speedBlur: k.speed01 * m.maxSpeedBlur * motion,
      vignette: (k.gForce01 * 0.6 + k.reentry01 * 0.5) * m.maxVignette * motion,
      grain: (k.reentry01 * 0.8 + k.heat01 * 0.2) * m.maxGrain * motion,
      // G alto reduz a saturação (visão em túnel / greyout).
      saturationBoost: -k.gForce01 * m.saturationBoost * motion,
      bloomBoost01: k.bloomBoost01,
      vacuum01: k.vacuum01,
    };
  }

  /** Estado plano (canais + intensidades) para `pipeline.setStress`. */
  get state() {
    return {
      ...this.channels,
      ...this.intensities,
    };
  }

  /** Resumo para HUD/depuração. */
  toJSON() {
    return {
      raw: { ...this.raw },
      channels: { ...this.channels },
      intensities: { ...this.intensities },
      motionScale: this.motionScale,
    };
  }
}

/** Atalho para criar o controlador de intensidade. */
export function createStressController(options = {}) {
  return new EffectStressController(options);
}

/* ========================================================================== */
/*  9. Caminho Canvas 2D (sombras suaves + pós-processamento)                 */
/* ========================================================================== */

/** Presets de qualidade do caminho Canvas2D. */
export const CANVAS_FX_QUALITY = deepFreeze({
  fast: { bloomScale: 0.2, blurPasses: 1, aberration: false, distortion: false, lut: false },
  balanced: { bloomScale: 0.25, blurPasses: 2, aberration: true, distortion: false, lut: false },
  full: { bloomScale: 0.3, blurPasses: 3, aberration: true, distortion: true, lut: true },
});

/** @private Cria um tile de ruído (RGBA) para grão cinematográfico. */
function createNoiseTile(size = 256, seed = 1234) {
  const canvas = createCanvas(size, size);
  const ctx = get2DContext(canvas, { willReadFrequently: true });
  if (!ctx) return canvas;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const value = hash01(p, seed) * 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** @private Redimensiona um canvas mantendo a referência (economiza GC). */
function sizeCanvas(canvas, width, height) {
  if (!canvas) return null;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}

/**
 * Sombras suaves para o renderizador 2D: umbra + penumbra com geometria
 * física (raio angular do Sol), recortadas nos corpos receptores.
 *
 * A penumbra cresce com a distância entre o oclusor e o receptor e com o
 * tamanho angular da fonte:
 *
 *     penumbra ≈ distância · tan(raio_angular_do_Sol) + raio_do_oclusor · k
 *
 * @example
 *   const shadows = new CanvasSoftShadowRenderer({ quality: 'high', opacity: 0.6 });
 *   shadows.render(ctx, {
 *     sun: { x: 0, y: 0, radius: 6.96e8 },
 *     occluders: [lua],
 *     receivers: [terra],
 *     camera,
 *   });
 */
export class CanvasSoftShadowRenderer {
  /**
   * @param {object} [options]
   * @param {'low'|'medium'|'high'} [options.quality='high']
   * @param {number} [options.opacity=0.62]
   * @param {string} [options.color='#000000']
   * @param {number} [options.scale=1] resolução do buffer de sombra
   * @param {number} [options.blur=10] raio do blur (px) quando há filtros
   * @param {boolean} [options.clipToReceivers=true]
   * @param {boolean} [options.umbra=true]
   * @param {number} [options.penumbraGain=1]
   * @param {boolean} [options.dropShadows=false] sombras de naves em planetas
   */
  constructor(options = {}) {
    this.options = {
      quality: 'high',
      opacity: 0.62,
      color: '#000000',
      scale: 1,
      blur: 10,
      clipToReceivers: true,
      umbra: true,
      penumbraGain: 1,
      dropShadows: false,
      ...options,
    };
    this.canvas = createCanvas(1, 1);
    this.ctx = get2DContext(this.canvas);
    this.supportsFilter = supportsCanvasFilter(this.ctx);
    this.stats = { occluders: 0, receivers: 0, drawn: 0 };
  }

  /** Ajusta opções em runtime. */
  configure(options = {}) {
    Object.assign(this.options, options);
    return this;
  }

  /** @private Prepara o buffer no tamanho do alvo. */
  _prepare(width, height) {
    const scale = clamp(this.options.scale ?? 1, 0.25, 1);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      sizeCanvas(this.canvas, w, h);
    }
    this.ctx = get2DContext(this.canvas) ?? this.ctx;
    this._scale = scale;
    return this.ctx;
  }

  /**
   * Desenha o passe de sombras diretamente no contexto informado.
   *
   * @param {CanvasRenderingContext2D} ctx contexto de destino
   * @param {object} params
   * @param {{x:number,y:number,radius?:number}} params.sun
   * @param {Array<object>} [params.occluders] corpos/naves que projetam sombra
   * @param {Array<object>} [params.receivers] corpos que recebem sombra
   * @param {object} params.camera câmera (`x`, `y`, `scale`, `width`, `height`)
   * @param {number} [params.time]
   */
  render(ctx, params = {}) {
    const { sun, camera } = params;
    const occluders = params.occluders ?? [];
    const receivers = params.receivers ?? [];
    if (!ctx || !sun || !camera || (!occluders.length && !receivers.length)) return this;
    const width = camera.width ?? ctx.canvas?.width ?? 0;
    const height = camera.height ?? ctx.canvas?.height ?? 0;
    if (!width || !height) return this;

    const shadowCtx = this._prepare(width, height);
    const k = 1 / this._scale;
    shadowCtx.setTransform(1, 0, 0, 1, 0, 0);
    shadowCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    shadowCtx.scale(this._scale, this._scale);

    const sunPos = projectPoint2D(camera, sun.x, sun.y);
    const sunRadiusPx = Math.max(0, (sun.radius ?? 0) * (camera.scale ?? 1));
    this.stats.occluders = occluders.length;
    this.stats.receivers = receivers.length;
    this.stats.drawn = 0;

    const shadowColor = parseColor(this.options.color);
    const opacity = clamp01(this.options.opacity);

    const paintOccluder = (occluder, clipCenter, clipRadius) => {
      const x = (occluder.x ?? 0);
      const y = (occluder.y ?? 0);
      const radiusWorld = Math.max(1e-6, occluder.radius ?? occluder.shadowRadius ?? 0);
      let dx = x - (sun.x ?? 0);
      let dy = y - (sun.y ?? 0);
      let distance = Math.hypot(dx, dy);
      if (distance < 1e-9) { dx = 0; dy = 1; distance = 1e-9; }
      const ux = dx / distance;
      const uy = dy / distance;

      // Penumbra = cone da fonte extensa (altura × tan θ) + difusão do limbo.
      // `height` é a distância do oclusor ao plano do receptor, em metros.
      const height = Math.max(0, occluder.height ?? 0);
      const sunAngular = Math.atan2(sunRadiusPx / Math.max(1e-6, camera.scale ?? 1), distance);
      const offsetWorld = Math.max(0, occluder.shadowOffset ?? 0);
      const penumbraWorld = (occluder.penumbra ?? radiusWorld * 0.35) * this.options.penumbraGain
        + height * Math.tan(sunAngular);

      const centerWorldX = x + ux * offsetWorld;
      const centerWorldY = y + uy * offsetWorld;
      const center = projectPoint2D(camera, centerWorldX, centerWorldY);
      const radiusPx = Math.max(1, (radiusWorld + penumbraWorld) * (camera.scale ?? 1));
      const umbraPx = Math.max(0.5, radiusWorld * (camera.scale ?? 1) * (this.options.umbra ? 1 : 0.001));
      if (radiusPx < 0.8) return;

      if (clipCenter && clipRadius) {
        // Só desenha se projetar sobre o receptor.
        const d = Math.hypot(center.x - clipCenter.x, center.y - clipCenter.y);
        if (d > clipRadius + radiusPx) return;
      }

      const angle = Math.atan2(uy, ux);
      const squash = clamp(1 - 0.35 * clamp01(radiusPx / Math.max(1, (camera.height ?? 720))), 0.55, 1);

      shadowCtx.save();
      if (this.supportsFilter && this.options.blur > 0) {
        shadowCtx.filter = `blur(${(this.options.blur * this._scale * 0.5).toFixed(2)}px)`;
      }
      shadowCtx.translate(center.x, center.y);
      shadowCtx.rotate(angle);
      shadowCtx.scale(1, squash);
      const gradient = shadowCtx.createRadialGradient(0, 0, 0, 0, 0, radiusPx);
      const core = opacity;
      const umbraStop = clamp(umbraPx / radiusPx, 0.02, 0.95);
      gradient.addColorStop(0, toCssRgba(shadowColor, core));
      gradient.addColorStop(umbraStop, toCssRgba(shadowColor, core * 0.82));
      gradient.addColorStop(Math.min(1, umbraStop + (1 - umbraStop) * 0.55), toCssRgba(shadowColor, core * 0.32));
      gradient.addColorStop(1, toCssRgba(shadowColor, 0));
      shadowCtx.fillStyle = gradient;
      shadowCtx.beginPath();
      shadowCtx.arc(0, 0, radiusPx, 0, TAU);
      shadowCtx.fill();
      shadowCtx.restore();
      this.stats.drawn += 1;
    };

    if (this.options.clipToReceivers && receivers.length) {
      for (const receiver of receivers) {
        const center = projectPoint2D(camera, receiver.x ?? 0, receiver.y ?? 0);
        const radius = Math.max(1, (receiver.radius ?? 0) * (camera.scale ?? 1));
        if (center.x + radius < 0 || center.x - radius > width
          || center.y + radius < 0 || center.y - radius > height) continue;
        shadowCtx.save();
        shadowCtx.beginPath();
        shadowCtx.arc(center.x, center.y, radius, 0, TAU);
        shadowCtx.clip();
        for (const occluder of occluders) {
          if (occluder === receiver) continue;
          paintOccluder(occluder, center, radius);
        }
        shadowCtx.restore();
      }
    } else {
      for (const occluder of occluders) paintOccluder(occluder, null, 0);
    }

    shadowCtx.setTransform(1, 0, 0, 1, 0, 0);
    shadowCtx.filter = 'none';

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.canvas, 0, 0, width, height);
    ctx.restore();
    return this;
  }

  /** Libera o buffer interno. */
  dispose() {
    this.canvas = null;
    this.ctx = null;
  }
}

/**
 * Sombras suaves de objetos (naves, estações, detritos) — mancha elíptica
 * deslocada na direção oposta ao Sol, com penumbra por blur nativo.
 */
export class SoftShadowLayer {
  /**
   * @param {object} [options]
   * @param {number} [options.blur=8]
   * @param {number} [options.opacity=0.45]
   * @param {string} [options.color='#000000']
   * @param {number} [options.spread=1.6] quanto a sombra se afasta do objeto
   */
  constructor(options = {}) {
    this.options = { blur: 8, opacity: 0.45, color: '#000000', spread: 1.6, ...options };
    this.supportsFilter = supportsCanvasFilter();
  }

  /**
   * Desenha a sombra de um objeto sobre a cena.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} object `{ x, y, radius, angle?, height? }` em unidades de tela
   * @param {object} [options] `sunDirection` (vetor unitário em tela), `alpha`
   */
  draw(ctx, object, options = {}) {
    if (!ctx || !object) return this;
    const radius = Math.max(0.5, object.radius ?? 6);
    const dir = options.sunDirection ?? { x: 0.6, y: 0.8 };
    const spread = (options.spread ?? this.options.spread)
      * (object.height ?? radius * 0.6);
    const x = (object.x ?? 0) + dir.x * spread;
    const y = (object.y ?? 0) + dir.y * spread;
    const alpha = clamp01((options.alpha ?? 1) * this.options.opacity);
    const stretch = clamp(1 + (options.velocity ?? 0) * 0.02, 1, 2.6);
    const angle = Math.atan2(dir.y, dir.x);

    ctx.save();
    if (this.supportsFilter) ctx.filter = `blur(${this.options.blur}px)`;
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(stretch, 1);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStop(0, toCssRgba(this.options.color, 0.9));
    gradient.addColorStop(0.55, toCssRgba(this.options.color, 0.45));
    gradient.addColorStop(1, toCssRgba(this.options.color, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fill();
    ctx.restore();
    return this;
  }
}

/** @private Projeção mundo → tela (mesma convenção de `sprites.js`). */
export function projectPoint2D(camera, x, y) {
  const scale = camera?.scale ?? 1;
  const cx = camera?.cx ?? (camera?.width ?? 0) / 2;
  const cy = camera?.cy ?? (camera?.height ?? 0) / 2;
  return {
    x: (x - (camera?.x ?? 0)) * scale + cx,
    y: (y - (camera?.y ?? 0)) * scale + cy,
  };
}

/** @private Tela → mundo (inverso de `projectPoint2D`). */
export function unprojectPoint2D(camera, x, y) {
  const scale = camera?.scale ?? 1;
  const cx = camera?.cx ?? (camera?.width ?? 0) / 2;
  const cy = camera?.cy ?? (camera?.height ?? 0) / 2;
  return {
    x: (x - cx) / scale + (camera?.x ?? 0),
    y: (y - cy) / scale + (camera?.y ?? 0),
  };
}

/**
 * Câmera 2D do renderizador: acompanhamento suave, zoom ancorado e conversões.
 * Compatível com `sprites.js` (`projectPoint`) e com `FakeGBuffer`.
 *
 * @param {object} [options] `x`, `y`, `scale`, `width`, `height`
 */
export function createRenderCamera(options = {}) {
  return {
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
    centerOn(x, y) { this.x = x; this.y = y; return this; },
    follow(target, dt = 0, smoothing = 6) {
      if (!target) return this;
      const k = smoothing <= 0 ? 1 : 1 - Math.exp(-smoothing * Math.max(0, dt));
      this.x += ((target.x ?? 0) - this.x) * k;
      this.y += ((target.y ?? 0) - this.y) * k;
      return this;
    },
    zoomAt(factor, screenX = this.width / 2, screenY = this.height / 2) {
      const before = unprojectPoint2D(this, screenX, screenY);
      this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
      const after = unprojectPoint2D(this, screenX, screenY);
      this.x += before.x - after.x;
      this.y += before.y - after.y;
      return this;
    },
    frameRadius(radius, margin = 1.25) {
      const half = Math.min(this.width, this.height) / 2;
      if (radius > 0) this.scale = half / (radius * margin);
      return this;
    },
    toScreen(x, y) { return projectPoint2D(this, x, y); },
    toWorld(x, y) { return unprojectPoint2D(this, x, y); },
  };
}

/**
 * Pós-processamento em Canvas 2D — fallback completo quando WebGL não está
 * disponível (ou quando a cena já é 2D e não se quer pagar o custo de upload).
 *
 * Efeitos implementados:
 *  - bloom com threshold (aproximado por contraste ou exato por luminância),
 *    blur multi-passe e tint de chamas;
 *  - aberração cromática radial real (três passes de canal com escalas
 *    distintas, compostos por `lighter`);
 *  - distorção de lente (remapeamento bilinear);
 *  - vinheta multiplicativa e grão animado por tile de ruído;
 *  - tone mapping por LUT (ACES/Reinhard) ou por filtro nativo;
 *  - grade final (brightness/contrast/saturation).
 *
 * @example
 *   const fx = new CanvasPostFX({ quality: 'balanced' });
 *   fx.setStress(stress.state);
 *   fx.render(sceneCanvas, displayCtx, { time });
 */
export class CanvasPostFX {
  /**
   * @param {object} [options]
   * @param {'fast'|'balanced'|'full'} [options.quality='balanced']
   * @param {object} [options.bloom] `enabled`, `threshold`, `intensity`, `radius`, `scale`, `tint`, `accurateThreshold`
   * @param {object} [options.vignette] `intensity`, `power`, `color`
   * @param {object} [options.grain] `intensity`
   * @param {object} [options.tonemap] `mode` (`filter|lut|off`), `operator`, `exposure`, `whitePoint`
   * @param {object} [options.grade] `contrast`, `saturation`, `brightness`
   * @param {number} [options.aberration=0] aberração base (fração da diagonal)
   * @param {number} [options.distortion=0] distorção base (barrel)
   * @param {number} [options.distortionScale=0.5] resolução do remapeamento
   * @param {number} [options.lutScale=0.5] resolução do tone mapping por LUT
   * @param {number} [options.channelScale=1] resolução dos canais RGB
   *   (menor = mais barato e levemente mais suave)
   */
  constructor(options = {}) {
    // Blocos aninhados são mesclados sobre os defaults (um `{ bloom: {...} }`
    // parcial não pode zerar `enabled`, `tint` etc.).
    const {
      bloom = {}, vignette = {}, grain = {}, tonemap = {}, grade = {}, ...flat
    } = options;
    const defaults = {
      quality: 'balanced',
      enabled: true,
      bloom: {
        enabled: true,
        threshold: 0.62,
        intensity: 0.85,
        radius: 12,
        scale: 0.25,
        tint: '#ffc08a',
        tintStrength: 0.35,
        accurateThreshold: false,
      },
      vignette: { intensity: 0.35, power: 2.2, color: '#000000' },
      grain: { intensity: 0.03, animated: true },
      tonemap: { mode: 'filter', operator: 'aces', exposure: 1.05, whitePoint: 1.6 },
      grade: { contrast: 1.04, saturation: 1.02, brightness: 1 },
      aberration: 0,
      distortion: 0,
      distortionScale: 0.5,
      lutScale: 0.5,
      channelScale: 1,
    };
    this.options = {
      ...defaults,
      ...flat,
      bloom: { ...defaults.bloom, ...bloom },
      vignette: { ...defaults.vignette, ...vignette },
      grain: { ...defaults.grain, ...grain },
      tonemap: { ...defaults.tonemap, ...tonemap },
      grade: { ...defaults.grade, ...grade },
    };

    this.qualityName = this.options.quality;
    this.preset = CANVAS_FX_QUALITY[this.qualityName] ?? CANVAS_FX_QUALITY.balanced;
    this.stress = neutralStress();
    this.time = 0;
    this.enabled = this.options.enabled !== false;
    this.buffers = {};
    this.contexts = {};
    this.noiseTile = createNoiseTile(256, 9173);
    this.noisePatterns = new WeakMap();
    this.toneLUT = null;
    this.toneLUTKey = null;
    this.supportsFilter = supportsCanvasFilter();
    this.stats = { frames: 0, bloomPasses: 0, aberration: false, distortion: false, lut: false };
  }

  /** Atualiza opções (mescla profunda nos blocos conhecidos). */
  configure(options = {}) {
    for (const key of ['bloom', 'vignette', 'grain', 'grade', 'tonemap']) {
      if (options[key]) this.options[key] = { ...this.options[key], ...options[key] };
    }
    for (const key of Object.keys(options)) {
      if (['bloom', 'vignette', 'grain', 'grade', 'tonemap'].includes(key)) continue;
      this.options[key] = options[key];
    }
    if (options.quality) this.setQuality(options.quality);
    return this;
  }

  /** Aplica um preset de qualidade do caminho 2D. */
  setQuality(name) {
    this.qualityName = CANVAS_FX_QUALITY[name] ? name : 'balanced';
    this.preset = CANVAS_FX_QUALITY[this.qualityName];
    return this;
  }

  /** Atualiza o estado de intensidade física (mesmo formato do pipeline). */
  setStress(state = {}) {
    this.stress = { ...neutralStress(), ...state };
    return this;
  }

  /** Avança o tempo interno (grão/tremulação). */
  update(dt = 0) {
    this.time += Math.max(0, Math.min(Number(dt) || 0, 0.25));
    return this;
  }

  /** @private Cria/redimensiona buffers internos. */
  _ensureBuffers(width, height) {
    const ensure = (name, w, h, alpha = false) => {
      let canvas = this.buffers[name];
      if (!canvas) {
        canvas = createCanvas(w, h);
        this.buffers[name] = canvas;
        this.contexts[name] = canvas ? get2DContext(canvas, { alpha, willReadFrequently: true }) : null;
      } else {
        const resized = canvas.width !== w || canvas.height !== h;
        sizeCanvas(canvas, w, h);
        if (resized || !this.contexts[name]) {
          this.contexts[name] = get2DContext(canvas, { alpha, willReadFrequently: true });
        }
      }
      return this.contexts[name];
    };
    const bloomScale = clamp(this.options.bloom.scale ?? 0.25, 0.1, 0.6);
    const bw = Math.max(1, Math.round(width * bloomScale));
    const bh = Math.max(1, Math.round(height * bloomScale));
    this.composeCtx = ensure('compose', width, height);
    const channelScale = clamp(this.options.channelScale ?? 1, 0.25, 1);
    this.channelCtx = ensure('channel',
      Math.max(1, Math.round(width * channelScale)),
      Math.max(1, Math.round(height * channelScale)));
    this.bloomCtxA = ensure('bloomA', bw, bh);
    this.bloomCtxB = ensure('bloomB', bw, bh);
    this.distortCtx = ensure('distort', Math.max(1, Math.round(width * this.options.distortionScale)),
      Math.max(1, Math.round(height * this.options.distortionScale)));
    this.lutCtx = ensure('lut', Math.max(1, Math.round(width * this.options.lutScale)),
      Math.max(1, Math.round(height * this.options.lutScale)));
    return this.composeCtx;
  }

  /** @private Resolve os parâmetros efetivos (config + intensidade física). */
  _effects() {
    const o = this.options;
    const s = this.stress;
    const exposure = Math.max(0.01, (o.tonemap.exposure ?? 1)) * (1 + (s.gForce01 ?? 0) * 0.03);
    return {
      bloomIntensity: o.bloom.enabled ? o.bloom.intensity * (1 + (s.bloomBoost01 ?? 0) * 0.9) : 0,
      bloomThreshold: clamp(o.bloom.threshold - (s.bloomBoost01 ?? 0) * 0.28, 0.02, 1),
      bloomRadius: o.bloom.radius * (1 + (s.vacuum01 ?? 0) * 0.6),
      aberration: (o.aberration ?? 0) + (s.aberration ?? 0),
      distortion: (o.distortion ?? 0) + (s.distortion ?? 0),
      vignette: clamp01((o.vignette.intensity ?? 0) + (s.vignette ?? 0)),
      grain: Math.max(0, (o.grain.intensity ?? 0) + (s.grain ?? 0)),
      exposure,
      contrast: (o.grade.contrast ?? 1) + (s.gForce01 ?? 0) * 0.05,
      saturation: Math.max(0, (o.grade.saturation ?? 1) + (s.saturationBoost ?? 0)),
      brightness: o.grade.brightness ?? 1,
    };
  }

  /** @private Padrão de ruído por contexto (patterns são por contexto). */
  _noisePattern(ctx) {
    if (!this.noiseTile) return null;
    let pattern = this.noisePatterns.get(ctx);
    if (!pattern) {
      pattern = ctx.createPattern(this.noiseTile, 'repeat');
      this.noisePatterns.set(ctx, pattern);
    }
    return pattern;
  }

  /**
   * Renderiza o pós-processamento.
   *
   * @param {HTMLCanvasElement} source cena já desenhada
   * @param {CanvasRenderingContext2D|HTMLCanvasElement} destination destino
   * @param {object} [options] `time`, `viewport` (para desenhar em área menor)
   */
  render(source, destination, options = {}) {
    if (!source || !destination || !this.enabled) return this;
    const destCtx = typeof destination.getContext === 'function'
      ? get2DContext(destination)
      : destination;
    if (!destCtx) return this;

    const width = source.width;
    const height = source.height;
    if (!width || !height) return this;
    const composeCtx = this._ensureBuffers(width, height);
    if (!composeCtx) return this;
    const fx = this._effects();
    const time = options.time ?? this.time;

    // 1) Cena (com aberração cromática opcional)
    composeCtx.setTransform(1, 0, 0, 1, 0, 0);
    composeCtx.globalAlpha = 1;
    composeCtx.globalCompositeOperation = 'source-over';
    composeCtx.filter = 'none';
    composeCtx.fillStyle = '#000';
    composeCtx.fillRect(0, 0, width, height);

    const aberrationPx = this.preset.aberration ? fx.aberration * Math.hypot(width, height) * 1.6 : 0;
    if (aberrationPx > 0.35) {
      this._drawChromatic(source, composeCtx, width, height, aberrationPx);
      this.stats.aberration = true;
    } else {
      composeCtx.drawImage(source, 0, 0, width, height);
      this.stats.aberration = false;
    }

    // 2) Bloom aditivo
    if (fx.bloomIntensity > 0.002) {
      const bloom = this._renderBloom(source, width, height, fx);
      if (bloom) {
        composeCtx.save();
        composeCtx.globalCompositeOperation = 'lighter';
        composeCtx.globalAlpha = clamp01(fx.bloomIntensity);
        composeCtx.drawImage(bloom, 0, 0, width, height);
        composeCtx.restore();
      }
    }

    // 3) Vinheta multiplicativa
    if (fx.vignette > 0.002) this._drawVignette(composeCtx, width, height, fx.vignette);

    // 4) Grão animado
    if (fx.grain > 0.0015) this._drawGrain(composeCtx, width, height, fx.grain, time);

    // 5) Distorção de lente (full) e tone mapping por LUT (full)
    let outputCanvas = this.buffers.compose;
    let needsUpscale = false;
    if (this.preset.distortion && Math.abs(fx.distortion) > 0.002) {
      const warped = this._applyDistortion(outputCanvas, fx.distortion);
      if (warped) {
        outputCanvas = warped;
        needsUpscale = outputCanvas !== this.buffers.compose;
      }
      this.stats.distortion =!! this.stats.distortion || !!warped;
    } else {
      this.stats.distortion = false;
    }
    if (this.preset.lut && this.options.tonemap.mode === 'lut') {
      const mapped = this._applyToneLUT(outputCanvas, fx);
      if (mapped) {
        outputCanvas = mapped;
        needsUpscale = false;
      }
      this.stats.lut = !!mapped;
    } else {
      this.stats.lut = false;
    }
    if (needsUpscale) {
      outputCanvas = this._upscaleToCompose(outputCanvas);
    }

    // 6) Saída com grade (usa filtros nativos quando disponíveis)
    const destWidth = options.width ?? destCtx.canvas?.width ?? width;
    const destHeight = options.height ?? destCtx.canvas?.height ?? height;
    destCtx.save();
    destCtx.globalCompositeOperation = 'source-over';
    destCtx.globalAlpha = 1;
    const filt = this._gradeFilter(fx);
    if (filt && this.supportsFilter && this.options.tonemap.mode !== 'lut') {
      destCtx.filter = filt;
    }
    destCtx.imageSmoothingEnabled = true;
    destCtx.imageSmoothingQuality = 'high';
    destCtx.drawImage(outputCanvas, 0, 0, destWidth, destHeight);
    destCtx.restore();
    this.stats.frames += 1;
    return this;
  }

  /** @private String de filtro CSS para grade/exposição. */
  _gradeFilter(fx) {
    const parts = [];
    if (Math.abs(fx.brightness * fx.exposure - 1) > 0.001) {
      parts.push(`brightness(${(fx.brightness * fx.exposure).toFixed(3)})`);
    }
    if (Math.abs(fx.contrast - 1) > 0.001) parts.push(`contrast(${fx.contrast.toFixed(3)})`);
    if (Math.abs(fx.saturation - 1) > 0.001) parts.push(`saturate(${fx.saturation.toFixed(3)})`);
    return parts.length ? parts.join(' ') : '';
  }

  /** @private Bloom: threshold + blur multi-passe + tint. */
  _renderBloom(source, width, height, fx) {
    const bloomA = this.bloomCtxA;
    const bloomB = this.bloomCtxB;
    if (!bloomA || !bloomB) return null;
    const bw = bloomA.canvas.width;
    const bh = bloomA.canvas.height;
    const threshold = fx.bloomThreshold;

    bloomA.setTransform(1, 0, 0, 1, 0, 0);
    bloomA.globalCompositeOperation = 'source-over';
    bloomA.globalAlpha = 1;
    bloomA.filter = 'none';
    bloomA.clearRect(0, 0, bw, bh);
    bloomA.fillStyle = '#000';
    bloomA.fillRect(0, 0, bw, bh);
    // Downsample por vizinho-mais-próximo: preserva a intensidade de fontes
    // pequenas (chamas, propulsores) que a média bilinear diluiria abaixo do
    // limiar de bloom.
    bloomA.imageSmoothingEnabled = false;

    // Sem `ctx.filter` não há como aproximar o limiar por contraste: nesse
    // caminho o limiar por luminância é obrigatório (senão a cena inteira
    // viraria brilho difuso).
    if (this.options.bloom.accurateThreshold || !this.supportsFilter) {
      // Limiar exato por luminância (4× menor: barato e preciso).
      bloomA.drawImage(source, 0, 0, bw, bh);
      const image = bloomA.getImageData(0, 0, bw, bh);
      const data = image.data;
      const t = threshold * 255;
      const span = Math.max(1, 255 - t);
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        let weight = (luma - t) / span;
        if (weight <= 0) {
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
        } else {
          // Joelho suave (smoothstep): altas luzes entram gradualmente.
          weight = weight > 1 ? 1 : weight;
          weight = weight * weight * (3 - 2 * weight);
          data[i] *= weight; data[i + 1] *= weight; data[i + 2] *= weight;
        }
      }
      bloomA.putImageData(image, 0, 0);
    } else if (this.supportsFilter) {
      // Aproximação por contraste (GPU): realça altas luzes antes do blur.
      const contrast = 1 + (1 - threshold) * 3.2;
      bloomA.filter = `brightness(${(0.55 + threshold * 0.35).toFixed(3)}) contrast(${contrast.toFixed(2)})`;
      bloomA.drawImage(source, 0, 0, bw, bh);
      bloomA.filter = 'none';
    } else {
      bloomA.drawImage(source, 0, 0, bw, bh);
    }
    bloomA.imageSmoothingEnabled = true;

    // Blur separável multi-passe (ping-pong)
    const passes = Math.max(1, this.preset.blurPasses);
    const radius = Math.max(0.5, fx.bloomRadius * (bw / Math.max(1, width)));
    let from = bloomA;
    let to = bloomB;
    for (let i = 0; i < passes; i++) {
      to.setTransform(1, 0, 0, 1, 0, 0);
      to.clearRect(0, 0, bw, bh);
      to.fillStyle = '#000';
      to.fillRect(0, 0, bw, bh);
      const passRadius = radius * (1 + i * 0.8);
      if (this.supportsFilter) {
        to.filter = `blur(${passRadius.toFixed(2)}px)`;
        to.drawImage(from.canvas, 0, 0);
        to.filter = 'none';
        const swap = from;
        from = to;
        to = swap;
      } else {
        this._resampleBlur(from, to, passRadius);
      }
      this.stats.bloomPasses += 1;
    }

    // Tint quente (chamas) por multiplicação
    const tint = parseColor(this.options.bloom.tint);
    const tintStrength = clamp01(this.options.bloom.tintStrength ?? 0.35);
    if (tintStrength > 0.002) {
      const ctx = from;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = toCssRgba(mixColor('#ffffff', tint, tintStrength), 1);
      ctx.fillRect(0, 0, bw, bh);
      ctx.restore();
    }
    return from.canvas;
  }

  /**
   * @private Blur por reamostragem (sem `ctx.filter`).
   *
   * Reduz o buffer com interpolação bilinear (o que já espalha o brilho) e o
   * amplia de volta. Duas reamostragens custam O(1) por pixel — muito mais
   * barato que uma convolução em JS — e preservam o pico das fontes pequenas
   * melhor que uma box blur normalizada, que diluiria o brilho em área.
   *
   * @param {CanvasRenderingContext2D} sourceCtx
   * @param {CanvasRenderingContext2D} auxCtx buffer auxiliar (mesmo tamanho)
   * @param {number} radius raio desejado em pixels do buffer
   */
  _resampleBlur(sourceCtx, auxCtx, radius) {
    const canvas = sourceCtx.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const factor = 1 + Math.max(0, radius) * 0.35;
    const sw = Math.max(1, Math.round(w / factor));
    const sh = Math.max(1, Math.round(h / factor));
    auxCtx.setTransform(1, 0, 0, 1, 0, 0);
    auxCtx.globalCompositeOperation = 'source-over';
    auxCtx.globalAlpha = 1;
    auxCtx.filter = 'none';
    auxCtx.imageSmoothingEnabled = true;
    auxCtx.clearRect(0, 0, w, h);
    auxCtx.drawImage(canvas, 0, 0, sw, sh);
    sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
    sourceCtx.globalCompositeOperation = 'source-over';
    sourceCtx.globalAlpha = 1;
    sourceCtx.filter = 'none';
    sourceCtx.imageSmoothingEnabled = true;
    sourceCtx.clearRect(0, 0, w, h);
    sourceCtx.drawImage(auxCtx.canvas, 0, 0, sw, sh, 0, 0, w, h);
    this.stats.bloomPasses += 0;
    return sourceCtx;
  }

  /**
   * @private Aberração cromática radial (3 passes de canal).
   *
   * Cada canal é desenhado em um buffer de trabalho menor
   * (`channelScale`) e ampliado: a separação é um deslocamento suave, então
   * a perda de nitidez é imperceptível — e o custo cai ~4× — enquanto a
   * cena base continua em resolução cheia.
   */
  _drawChromatic(source, ctx, width, height, pixels) {
    const channelCtx = this.channelCtx;
    if (!channelCtx) {
      ctx.drawImage(source, 0, 0, width, height);
      return;
    }
    const k = pixels / Math.max(1, Math.max(width, height));
    const passes = [
      [1 + k, '#ff0000'],
      [1, '#00ff00'],
      [1 - k, '#0000ff'],
    ];
    const cw = channelCtx.canvas.width;
    const ch = channelCtx.canvas.height;
    ctx.globalCompositeOperation = 'lighter';
    for (const [scale, tint] of passes) {
      channelCtx.setTransform(1, 0, 0, 1, 0, 0);
      channelCtx.globalCompositeOperation = 'source-over';
      channelCtx.filter = 'none';
      channelCtx.clearRect(0, 0, cw, ch);
      channelCtx.fillStyle = '#000';
      channelCtx.fillRect(0, 0, cw, ch);
      channelCtx.save();
      channelCtx.translate(cw / 2, ch / 2);
      channelCtx.scale(scale, scale);
      channelCtx.drawImage(source, -cw / 2, -ch / 2, cw, ch);
      channelCtx.restore();
      channelCtx.globalCompositeOperation = 'multiply';
      channelCtx.fillStyle = tint;
      channelCtx.fillRect(0, 0, cw, ch);
      channelCtx.globalCompositeOperation = 'source-over';
      ctx.drawImage(channelCtx.canvas, 0, 0, width, height);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** @private Vinheta multiplicativa com correção de aspecto. */
  _drawVignette(ctx, width, height, intensity) {
    const color = parseColor(this.options.vignette.color ?? '#000000');
    const power = Math.max(0.2, this.options.vignette.power ?? 2.2);
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.hypot(cx, cy);
    const gradient = ctx.createRadialGradient(cx, cy, radius * 0.25, cx, cy, radius);
    const edge = Math.pow(clamp01(intensity), 1 / power);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.55, toCssRgba(mixColor('#ffffff', color, edge * 0.35), 1));
    gradient.addColorStop(1, toCssRgba(mixColor('#ffffff', color, edge), 1));
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  /** @private Grão de filme animado (tile de ruído). */
  _drawGrain(ctx, width, height, intensity, time) {
    const pattern = this._noisePattern(ctx);
    if (!pattern) return;
    const offsetX = this.options.grain.animated === false ? 0 : (hash01(Math.floor(time * 24), 3) * 256) | 0;
    const offsetY = this.options.grain.animated === false ? 0 : (hash01(Math.floor(time * 24), 7) * 256) | 0;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = clamp01(intensity * 2);
    ctx.translate(-offsetX, -offsetY);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width + offsetX, height + offsetY);
    ctx.restore();
  }

  /** @private Remapeamento bilinear para distorção de lente (barrel). */
  _applyDistortion(sourceCanvas, amount) {
    const ctx = this.distortCtx;
    if (!ctx) return null;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const srcCtx = sourceCanvas.getContext('2d');
    if (!srcCtx) return null;
    srcCtx.setTransform(1, 0, 0, 1, 0, 0);
    let image;
    try {
      image = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    } catch {
      return null;
    }
    const srcW = image.width;
    const srcH = image.height;
    const out = ctx.createImageData(w, h);
    const src = image.data;
    const dst = out.data;
    const k = amount * 2.2;
    const zoom = 1 / (1 + Math.abs(k) * 0.75);
    for (let y = 0; y < h; y++) {
      const ny = (y / (h - 1)) * 2 - 1;
      for (let x = 0; x < w; x++) {
        const nx = (x / (w - 1)) * 2 - 1;
        const r2 = nx * nx + ny * ny;
        const factor = (1 + k * r2) * zoom;
        const sx = (nx * factor * 0.5 + 0.5) * (srcW - 1);
        const sy = (ny * factor * 0.5 + 0.5) * (srcH - 1);
        const index = (y * w + x) * 4;
        if (sx < 0 || sx > srcW - 1 || sy < 0 || sy > srcH - 1) {
          dst[index] = 0; dst[index + 1] = 0; dst[index + 2] = 0; dst[index + 3] = 255;
          continue;
        }
        const x0 = sx | 0;
        const y0 = sy | 0;
        const x1 = Math.min(srcW - 1, x0 + 1);
        const y1 = Math.min(srcH - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const i00 = (y0 * srcW + x0) * 4;
        const i10 = (y0 * srcW + x1) * 4;
        const i01 = (y1 * srcW + x0) * 4;
        const i11 = (y1 * srcW + x1) * 4;
        for (let c = 0; c < 3; c++) {
          const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
          const bottom = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
          dst[index + c] = top * (1 - fy) + bottom * fy;
        }
        dst[index + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    // Devolve o buffer reduzido: o upscale acontece uma única vez, no fim
    // (depois do LUT, quando ele estiver ativo).
    return ctx.canvas;
  }

  /** @private Amplia um buffer auxiliar para o `compose` (resolução cheia). */
  _upscaleToCompose(sourceCanvas) {
    const compose = this.buffers.compose;
    const composeCtx = this.composeCtx;
    if (!compose || !composeCtx) return sourceCanvas;
    composeCtx.setTransform(1, 0, 0, 1, 0, 0);
    composeCtx.globalAlpha = 1;
    composeCtx.globalCompositeOperation = 'source-over';
    composeCtx.filter = 'none';
    composeCtx.clearRect(0, 0, compose.width, compose.height);
    composeCtx.imageSmoothingEnabled = true;
    composeCtx.imageSmoothingQuality = 'high';
    composeCtx.drawImage(sourceCanvas, 0, 0, compose.width, compose.height);
    return compose;
  }

  /** @private Tone mapping por LUT (half-res + upscale). */
  _applyToneLUT(sourceCanvas, fx) {
    const ctx = this.lutCtx;
    if (!ctx) return null;
    const key = `${this.options.tonemap.operator}|${fx.exposure.toFixed(3)}|${this.options.tonemap.whitePoint}`;
    if (!this.toneLUT || this.toneLUTKey !== key) {
      // LUT de *exibição*: o buffer já está em sRGB 8 bits, então cada entrada
      // decodifica → aplica a curva (com exposição) → recodifica. Assim a
      // curva 2D reproduz exatamente o shader (mesma ordem do composite).
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        const linear = srgbToLinear(i / 255);
        const mapped = applyToneMapping([linear, linear, linear], {
          operator: this.options.tonemap.operator,
          exposure: fx.exposure,
          whitePoint: this.options.tonemap.whitePoint,
          srgb: true,
        });
        lut[i] = Math.round(clamp01(mapped[0]) * 255);
      }
      this.toneLUT = lut;
      this.toneLUTKey = key;
    }
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(sourceCanvas, 0, 0, w, h);
    let image;
    try {
      image = ctx.getImageData(0, 0, w, h);
    } catch {
      return null;
    }
    const data = image.data;
    const lut = this.toneLUT;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lut[data[i]];
      data[i + 1] = lut[data[i + 1]];
      data[i + 2] = lut[data[i + 2]];
    }
    ctx.putImageData(image, 0, 0);
    return this._upscaleToCompose(ctx.canvas);
  }

  /** Resumo de estado (depuração). */
  toJSON() {
    return {
      quality: this.qualityName,
      enabled: this.enabled,
      supportsFilter: this.supportsFilter,
      effects: this._effects(),
      stats: { ...this.stats },
    };
  }

  /** Libera buffers. */
  dispose() {
    this.buffers = {};
    this.contexts = {};
    this.noiseTile = null;
    this.toneLUT = null;
  }
}

/* ========================================================================== */
/*  10. GBuffer falso (2D → profundidade + normais)                           */
/* ========================================================================== */

/**
 * Gera, a partir do MESMO conjunto de primitivas 2D usado para desenhar a
 * cena, dois buffers auxiliares:
 *
 *  - **profundidade linear** empacotada em RG (16 bits);
 *  - **normais em espaço de câmera** codificadas em RGB (`n * 0.5 + 0.5`),
 *    analíticas para esferas (corpos) e planas para naves/partículas;
 *  - **máscara de material** (R = refletividade) para o SSR.
 *
 * Isso permite SSAO, SSR e sombras de contato em uma cena desenhada em
 * Canvas2D, sem um renderizador 3D completo.
 *
 * Convenções:
 *  - `item.z` é a distância sintética do observador (metros), usada apenas
 *    para ordenar/quantizar profundidade;
 *  - esferas variam de `z - raio` (centro, mais perto) a `z` (limbo);
 *  - pixels sem geometria recebem profundidade 1 (fundo).
 */
export class FakeGBuffer {
  /**
   * @param {object} [options]
   * @param {number} [options.scale=0.5] resolução relativa à cena
   * @param {number} [options.near=1e-3]
   * @param {number} [options.far=1]
   * @param {number} [options.curvature=1] intensidade da curvatura das esferas
   */
  constructor(options = {}) {
    this.scale = clamp(options.scale ?? 0.5, 0.15, 1);
    this.near = options.near ?? 1e-3;
    this.far = options.far ?? 1;
    this.curvature = options.curvature ?? 1;
    this.width = 1;
    this.height = 1;
    this.depthCanvas = createCanvas(1, 1);
    this.normalCanvas = createCanvas(1, 1);
    this.materialCanvas = createCanvas(1, 1);
    this.depthCtx = get2DContext(this.depthCanvas, { willReadFrequently: true });
    this.normalCtx = get2DContext(this.normalCanvas, { willReadFrequently: true });
    this.materialCtx = get2DContext(this.materialCanvas, { willReadFrequently: true });
    this.stats = { pixels: 0, items: 0, spheres: 0, flats: 0, ms: 0 };
    this.resize(options.width ?? 1, options.height ?? 1);
  }

  /** Ajusta a resolução interna (proporcional à cena). */
  resize(width, height) {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    if (w === this.width && h === this.height && this.depthImage) return this;
    this.width = w;
    this.height = h;
    sizeCanvas(this.depthCanvas, w, h);
    sizeCanvas(this.normalCanvas, w, h);
    sizeCanvas(this.materialCanvas, w, h);
    this.depthCtx = get2DContext(this.depthCanvas, { willReadFrequently: true });
    this.normalCtx = get2DContext(this.normalCanvas, { willReadFrequently: true });
    this.materialCtx = get2DContext(this.materialCanvas, { willReadFrequently: true });
    if (!this.depthCtx || !this.normalCtx) return this;
    this.depthImage = this.depthCtx.createImageData(w, h);
    this.normalImage = this.normalCtx.createImageData(w, h);
    this.materialImage = this.materialCtx.createImageData(w, h);
    this.stats.pixels = w * h;
    return this;
  }

  /**
   * @private Preenche os buffers com os valores de "sem geometria"
   * (profundidade 1, normal +Z, refletividade 0).
   *
   * Usa `Uint32Array.fill` quando o tipo de array permite: em vez de
   * 4 escritas por pixel, 1 por pixel (a ordem dos bytes é resolvida uma
   * única vez, com detecção de endianness).
   */
  clear() {
    if (!this.depthImage) return this;
    const depth = this.depthImage.data;
    const normal = this.normalImage.data;
    const material = this.materialImage.data;
    const fill = (data, rgba) => {
      if (!(data instanceof Uint8ClampedArray) || data.byteOffset % 4 !== 0) return false;
      if (_littleEndian === null) {
        _littleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
      }
      const [r, g, b, a] = rgba;
      const packed = _littleEndian
        ? (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
        : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2).fill(packed);
      return true;
    };
    if (!fill(depth, [255, 0, 0, 255])) {
      for (let i = 0; i < depth.length; i += 4) {
        depth[i] = 255; depth[i + 1] = 0; depth[i + 2] = 0; depth[i + 3] = 255;
      }
    }
    if (!fill(normal, [128, 128, 255, 255])) {
      for (let i = 0; i < normal.length; i += 4) {
        normal[i] = 128; normal[i + 1] = 128; normal[i + 2] = 255; normal[i + 3] = 255;
      }
    }
    if (!fill(material, [0, 0, 0, 255])) {
      for (let i = 0; i < material.length; i += 4) {
        material[i] = 0; material[i + 1] = 0; material[i + 2] = 0; material[i + 3] = 255;
      }
    }
    return this;
  }

  /**
   * Escreve um pixel nos três buffers (índice em bytes).
   *
   * O laço de `update()` embute esta lógica para evitar uma chamada por
   * pixel; este método fica para integrações externas que queiram semear
   * geometria manualmente.
   *
   * @param {number} index deslocamento em bytes (x + y·largura) · 4
   * @param {number} depth profundidade absoluta (m)
   * @param {number} nx normal X em espaço de câmera
   * @param {number} ny normal Y em espaço de câmera
   * @param {number} nz normal Z em espaço de câmera
   * @param {number} reflectivity 0..1 para a máscara de material
   */
  writePixel(index, depth, nx, ny, nz, reflectivity) {
    const depthData = this.depthImage.data;
    const normalData = this.normalImage.data;
    const materialData = this.materialImage.data;
    const t = clamp01((depth - this.near) / Math.max(1e-9, this.far - this.near));
    const scaled = t * 255;
    const high = Math.min(255, Math.floor(scaled));
    depthData[index] = high;
    depthData[index + 1] = Math.round((scaled - high) * 255);
    depthData[index + 2] = 0;
    depthData[index + 3] = 255;
    normalData[index] = Math.round(clamp01(nx * 0.5 + 0.5) * 255);
    normalData[index + 1] = Math.round(clamp01(ny * 0.5 + 0.5) * 255);
    normalData[index + 2] = Math.round(clamp01(nz * 0.5 + 0.5) * 255);
    normalData[index + 3] = 255;
    materialData[index] = Math.round(clamp01(reflectivity) * 255);
    materialData[index + 1] = 0;
    materialData[index + 2] = 0;
    materialData[index + 3] = 255;
  }

  /**
   * Rasteriza a lista de primitivas.
   *
   * @param {Array<object>} items `{ x, y, radius, z, type?, reflectivity? }`
   * @param {object} camera câmera 2D (`x`, `y`, `scale`, `width`, `height`)
   * @param {object} [options] `near`, `far`, `curvature`
   * @returns {FakeGBuffer}
   */
  update(items = [], camera = {}, options = {}) {
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (options.near !== undefined) this.near = options.near;
    if (options.far !== undefined) this.far = options.far;
    if (!this.depthImage) return this;
    this.clear();
    this.stats.items = items.length;
    this.stats.spheres = 0;
    this.stats.flats = 0;

    const scale = camera.scale ?? 1;
    const w = this.width;
    const h = this.height;
    const centerX = camera.cx ?? (camera.width ?? 0) / 2;
    const centerY = camera.cy ?? (camera.height ?? 0) / 2;
    const resample = (camera.width ?? w) ? w / Math.max(1, camera.width ?? w) : 1;
    const resampleY = (camera.height ?? h) ? h / Math.max(1, camera.height ?? h) : resample;

    // Ordena do mais distante para o mais próximo (pintor).
    const sorted = [...items].sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
    const depthImage = this.depthImage.data;
    const normalImage = this.normalImage.data;
    const materialImage = this.materialImage.data;

    for (const item of sorted) {
      if (!item || item.radius === undefined) continue;
      const px = ((item.x - (camera.x ?? 0)) * scale + centerX) * resample;
      const py = ((item.y - (camera.y ?? 0)) * scale + centerY) * resampleY;
      const radius = Math.max(0.5, item.radius * scale * resample);
      const z = Math.max(this.near, item.z ?? this.far);
      const reflectivity = item.reflectivity ?? 0.15;
      const sphere = (item.type ?? 'sphere') === 'sphere';
      const curvature = (item.curvature ?? this.curvature);

      const minX = Math.max(0, Math.floor(px - radius));
      const maxX = Math.min(w - 1, Math.ceil(px + radius));
      const minY = Math.max(0, Math.floor(py - radius));
      const maxY = Math.min(h - 1, Math.ceil(py + radius));
      if (maxX < minX || maxY < minY) continue;

      // Laço quente: escreve direto nos typed arrays (sem chamadas, sem
      // reprocessar limites por pixel) — isto roda a cada quadro.
      const depthData = depthImage;
      const normalData = normalImage;
      const materialData = materialImage;
      const invRadius = 1 / radius;
      const depthRange = 1 / Math.max(1e-9, this.far - this.near);
      const near = this.near;
      const materialByte = (clamp01(reflectivity) * 255 + 0.5) | 0;
      const curvatureRadius = item.radius * curvature;
      for (let y = minY; y <= maxY; y++) {
        const dy = (y + 0.5 - py) * invRadius;
        const dy2 = dy * dy;
        if (dy2 > 1) continue;
        const span = Math.sqrt(1 - dy2) * radius;
        const startX = Math.max(minX, Math.floor(px - span));
        const endX = Math.min(maxX, Math.ceil(px + span));
        const rowIndex = y * w;
        for (let x = startX; x <= endX; x++) {
          const dx = (x + 0.5 - px) * invRadius;
          const r2 = dx * dx + dy2;
          if (r2 > 1) continue;
          const nz = sphere ? Math.sqrt(1 - r2) : 1;
          const depth = sphere ? z - curvatureRadius * nz : z;
          const t = (depth > near ? depth - near : 0) * depthRange;
          const scaled = t > 1 ? 255 : t * 255;
          const high = scaled | 0;
          const index = (rowIndex + x) << 2;
          depthData[index] = high;
          depthData[index + 1] = ((scaled - high) * 255 + 0.5) | 0;
          depthData[index + 2] = 0;
          depthData[index + 3] = 255;
          // Normal em espaço de câmera: +y para cima (canvas tem y para baixo).
          normalData[index] = ((sphere ? dx : 0) * 127.5 + 127.5 + 0.5) | 0;
          normalData[index + 1] = ((sphere ? -dy : 0) * 127.5 + 127.5 + 0.5) | 0;
          normalData[index + 2] = (nz * 127.5 + 127.5 + 0.5) | 0;
          normalData[index + 3] = 255;
          materialData[index] = materialByte;
          materialData[index + 1] = 0;
          materialData[index + 2] = 0;
          materialData[index + 3] = 255;
        }
      }
      if (sphere) this.stats.spheres += 1;
      else this.stats.flats += 1;
    }

    this.depthCtx.putImageData(this.depthImage, 0, 0);
    this.normalCtx.putImageData(this.normalImage, 0, 0);
    this.materialCtx.putImageData(this.materialImage, 0, 0);
    this.stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
    return this;
  }

  /** Texturas/canvas prontos para upload. */
  get buffers() {
    return {
      depth: this.depthCanvas,
      normals: this.normalCanvas,
      material: this.materialCanvas,
    };
  }

  /** Libera buffers. */
  dispose() {
    this.depthCanvas = null;
    this.normalCanvas = null;
    this.materialCanvas = null;
    this.depthImage = null;
    this.normalImage = null;
    this.materialImage = null;
  }
}

/** @private Endianness detectada uma vez (para preencher buffers como RGBA). */
let _littleEndian = null;

/** Alias descritivo (o mesmo builder também é chamado de "profundidade/normais"). */
export const DepthNormalBufferBuilder = FakeGBuffer;

/* ========================================================================== */
/*  11. Renderer — loop unificado                                             */
/* ========================================================================== */

/**
 * Configuração padrão do renderizador.
 */
export const DEFAULT_RENDERER_OPTIONS = Object.freeze({
  mode: 'auto',
  quality: 'high',
  pixelRatio: null,
  maxPixelRatio: 2,
  autoResize: true,
  background: {
    color: '#03050a',
    gradient: true,
    nebula: true,
    nebulaColor: '#12213f',
    stars: 900,
    starSeed: 2026,
    twinkle: true,
    parallax: 0.25,
  },
  shadows: {
    enabled: true,
    quality: 'high',
    opacity: 0.62,
    blur: 10,
    dropShadows: true,
    clipToReceivers: true,
  },
  postfx: {},
  canvasfx: {},
  camera: { follow: true, smoothing: 4, scale: null },
  trails: { mode: 'orbit', length: 240, refresh: 0.4, color: 'rgba(95,212,255,0.5)', orbitSteps: 320 },
  particles: { enabled: true, maxParticles: 2400, create: true },
  hud: { enabled: true },
  stress: { enabled: true },
  depth: { base: 1e7, body: 1, ship: 0.86, particle: 0.78, scale: 0.5 },
  maxDevicePixelRatio: 2,
});

/**
 * Renderizador unificado do simulador orbital.
 *
 * Responsabilidades:
 *  - loop de desenho em camadas (fundo → corpos → órbitas → sombras →
 *    partículas → naves → overlays), com culling e ordenação;
 *  - câmera com acompanhamento suave e zoom ancorado (compatível com
 *    `sprites.js`);
 *  - sombras suaves em Canvas2D (umbra/penumbra) recortadas nos corpos;
 *  - pós-processamento WebGL (pipeline completo) ou Canvas2D (fallback),
 *    escolhido automaticamente, com HUD nítido desenhado por cima;
 *  - telemetria → intensidade de efeitos (EffectStressController);
 *  - captura de quadro, estatísticas e descarte de recursos.
 *
 * @example
 *   import { Renderer } from './postprocessing.js';
 *   const renderer = new Renderer(canvas, { width: 1280, height: 720 });
 *   renderer.attach({ engine, atmosphere, sprites, generator: gfx, hud });
 *   renderer.setScene({ bodies: engine.bodies, spacecraft: engine.spacecraft });
 *   renderer.frame(1 / 60);
 */
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas canvas de destino (contexto 2D)
   * @param {object} [options] ver `DEFAULT_RENDERER_OPTIONS`
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = get2DContext(canvas, { alpha: false, desynchronized: true });
    if (!this.ctx) {
      throw new Error('postprocessing.js: canvas de destino sem contexto 2D.');
    }
    this.options = deepMerge(DEFAULT_RENDERER_OPTIONS, options);
    this.mode = 'canvas';
    this.time = 0;
    this.frameIndex = 0;
    this.playing = true;

    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    this.pixelRatio = clamp(
      options.pixelRatio ?? Math.min(dpr, this.options.maxDevicePixelRatio),
      0.5,
      4,
    );
    this.width = Math.max(1, options.width ?? canvas.width ?? 1280);
    this.height = Math.max(1, options.height ?? canvas.height ?? 720);

    this.camera = options.cameraInstance ?? createRenderCamera({
      width: this.width,
      height: this.height,
      ...(this.options.camera.scale != null ? { scale: this.options.camera.scale } : {}),
    });
    this.followTarget = null;
    this.sun = null;

    this.scene = { bodies: [], spacecraft: [], particles: [], overlays: [], orbit: null };
    this.dependencies = {
      engine: null, atmosphere: null, sprites: null, generator: null, hud: null,
    };
    this._textures = new Map();
    this._orbitCache = { points: [], age: Infinity };
    this._lastDt = 1 / 60;
    this._trails = new Map();
    this._telemetry = null;
    this._aeroTelemetry = null;
    this._lastFrame = 0;
    this._fpsEma = 60;

    this.sceneCanvas = createCanvas(this.width, this.height);
    this.sceneCtx = get2DContext(this.sceneCanvas, { alpha: false });
    if (!this.sceneCtx) {
      throw new Error('postprocessing.js: não foi possível criar o canvas interno da cena.');
    }

    this.gbuffer = new FakeGBuffer({
      scale: this.options.depth.scale,
      width: this.width,
      height: this.height,
    });
    this.shadows = new CanvasSoftShadowRenderer({ ...this.options.shadows });
    this.stressController = new EffectStressController(this.options.stress);
    this.particles = null;

    this._ownsParticles = false;
    this.postfx = null;
    this.pipeline = null;
    this.glDepth = null;
    this.glNormal = null;
    this.glMaterial = null;
    this.lightScreen = [0.6, 0.8];

    this.stats = {
      fps: 0,
      frameMs: 0,
      sceneMs: 0,
      postMs: 0,
      gbufferMs: 0,
      frames: 0,
      mode: 'canvas',
      bodies: 0,
      spacecraft: 0,
      particles: 0,
    };

    this._initPostProcessing(this.options.postfx);
    if (this.options.particles?.create !== false) {
      this.particles = options.particleSystem ?? this._createParticleSystem();
      this._ownsParticles = !options.particleSystem;
    }
    this.resize(this.width, this.height, this.pixelRatio);
    this.setScene(options.scene ?? this.scene);
  }

  /* ----------------------------- inicialização --------------------------- */

  /** @private Escolhe WebGL (se possível) ou Canvas2D. */
  _initPostProcessing(postfxOptions = {}) {
    const mode = this.options.mode;
    if (mode !== 'canvas') {
      const glCanvas = createCanvas(this.width, this.height);
      const detected = detectWebGLSupport(glCanvas, this.options.context ?? {});
      if (detected.gl) {
        try {
          this.pipeline = new PostProcessingPipeline(detected.gl, {
            quality: this.options.quality,
            ...postfxOptions,
            width: this.width,
            height: this.height,
            pixelRatio: this.pixelRatio,
          });
          this.glCanvas = glCanvas;
          this.mode = 'webgl';
          this.glDepth = new DynamicTexture(detected.gl, { flipY: true, filter: 'nearest' });
          this.glNormal = new DynamicTexture(detected.gl, { flipY: true, filter: 'linear' });
          this.glMaterial = new DynamicTexture(detected.gl, { flipY: true, filter: 'linear' });
          this.stats.mode = 'webgl';
          return;
        } catch (error) {
          this.lastError = error;
          if (mode === 'webgl') throw error;
          this.pipeline = null;
        }
      } else if (mode === 'webgl') {
        throw new Error('postprocessing.js: WebGL solicitado, mas indisponível.');
      }
    }
    this.postfx = new CanvasPostFX({
      quality: this.options.quality === 'low' ? 'fast' : (this.options.quality === 'ultra' ? 'full' : 'balanced'),
      ...this.options.canvasfx,
      ...postfxOptions.canvas,
    });
    this.mode = 'canvas';
    this.stats.mode = 'canvas';
  }

  /** @private Sistema de partículas próprio (quando `sprites.js` não é injetado). */
  _createParticleSystem() {
    const spritesNs = this.dependencies.sprites;
    if (spritesNs?.ParticleSystem) {
      return new spritesNs.ParticleSystem({ maxParticles: this.options.particles.maxParticles });
    }
    return new SimpleParticleSystem({ maxParticles: this.options.particles.maxParticles });
  }

  /* ------------------------------ dependências --------------------------- */

  /**
   * Injeta os módulos do simulador (todos opcionais).
   * @param {object} deps `engine`, `atmosphere`, `sprites`, `generator`, `hud`, `particles`
   */
  attach(deps = {}) {
    Object.assign(this.dependencies, deps);
    if (deps.sprites) this._textures.clear();
    if (deps.generator) this._textures.clear();
    if (deps.particles) {
      this.particles = deps.particles;
      this._ownsParticles = false;
    } else if (deps.sprites?.ParticleSystem && this._ownsParticles
      && !(this.particles instanceof deps.sprites.ParticleSystem)) {
      this.particles = new deps.sprites.ParticleSystem({
        maxParticles: this.options.particles.maxParticles,
      });
    }
    if (deps.engine) {
      this.sun = this.sun ?? findSun(deps.engine.bodies ?? []);
    }
    return this;
  }

  /** Define a cena desenhada (arrays vivos são suportados). */
  setScene(scene = {}) {
    this.scene = {
      bodies: scene.bodies ?? this.scene.bodies ?? [],
      spacecraft: scene.spacecraft ?? this.scene.spacecraft ?? [],
      particles: scene.particles ?? this.scene.particles ?? [],
      overlays: scene.overlays ?? this.scene.overlays ?? [],
      orbit: scene.orbit ?? null,
    };
    if (scene.sun) this.sun = scene.sun;
    if (scene.follow) this.followTarget = scene.follow;
    return this;
  }

  /** Define a câmera (opcionalmente uma instância externa). */
  setCamera(camera) {
    this.camera = camera;
    this.camera.resize?.(this.width, this.height);
    return this;
  }

  /** Define o Sol usado em iluminação/sombras. */
  setSun(sun) {
    this.sun = sun;
    return this;
  }

  /* ------------------------------- dimensões ----------------------------- */

  /**
   * Redimensiona canvas, câmera, GBuffer e pipeline.
   * @param {number} [width]
   * @param {number} [height]
   * @param {number} [pixelRatio]
   */
  resize(width = this.width, height = this.height, pixelRatio = this.pixelRatio) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.pixelRatio = clamp(pixelRatio ?? this.pixelRatio, 0.5, 4);
    const pixelWidth = Math.max(1, Math.round(this.width * this.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(this.height * this.pixelRatio));
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    sizeCanvas(this.sceneCanvas, pixelWidth, pixelHeight);
    this.sceneCtx = get2DContext(this.sceneCanvas, { alpha: false }) ?? this.sceneCtx;
    this.camera.resize?.(pixelWidth, pixelHeight);
    this.gbuffer.resize(pixelWidth, pixelHeight);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    if (this.pipeline) this.pipeline.resize(this.width, this.height, this.pixelRatio);
    this.camera.width = pixelWidth;
    this.camera.height = pixelHeight;
    return this;
  }

  /** @private Redimensiona automaticamente quando o canvas muda no DOM. */
  _autoResize() {
    if (!this.options.autoResize || !this.canvas) return;
    const targetW = this.canvas.clientWidth || this.canvas.width;
    const targetH = this.canvas.clientHeight || this.canvas.height;
    const dpr = clamp(this.pixelRatio, 0.5, 4);
    if (Math.round(targetW * dpr) !== this.canvas.width
      || Math.round(targetH * dpr) !== this.canvas.height) {
      this.resize(targetW, targetH, dpr);
    }
  }

  /* -------------------------------- loop -------------------------------- */

  /**
   * Atualiza estado (câmera, partículas, telemetria, efeitos) e desenha o
   * quadro completo.
   *
   * @param {number} [dt] segundos desde o último quadro
   * @returns {Renderer}
   */
  frame(dt = 1 / 60) {
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const delta = Math.max(0, Math.min(Number(dt) || 0, 0.25));
    this._lastDt = delta;
    this._autoResize();
    this.update(delta);

    const ctx = this.sceneCtx;
    const width = this.sceneCanvas.width;
    const height = this.sceneCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';

    const sceneStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.drawBackground(ctx, width, height);
    this.drawBodies(ctx);
    this.drawOrbits(ctx);
    if (this.options.shadows.enabled) this.drawShadows(ctx);
    this.drawParticles(ctx);
    this.drawSpacecraft(ctx);
    this.drawOverlays(ctx);
    const sceneEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this.present();
    this.drawHUD();

    const end = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.sceneMs = sceneEnd - sceneStart;
    this.stats.postMs = end - sceneEnd;
    this.stats.frameMs = end - start;
    this.stats.frames += 1;
    this.frameIndex += 1;
    if (delta > 0) {
      this._fpsEma = this._fpsEma * 0.9 + (1 / delta) * 0.1;
      this.stats.fps = this._fpsEma;
    }
    this.stats.bodies = this.scene.bodies.length;
    this.stats.spacecraft = this.scene.spacecraft.length;
    this.stats.particles = this.particles?.count ?? 0;
    return this;
  }

  /** Atualiza câmera, partículas, telemetria e intensidade de efeitos. */
  update(dt = 0) {
    this.time += dt;
    const follow = this.followTarget
      ?? (this.options.camera.follow ? this.scene.spacecraft[0] : null);
    if (follow) this.camera.follow?.(follow, dt, this.options.camera.smoothing);

    this.particles?.update?.(dt, this.camera);

    const ship = this.scene.spacecraft[0] ?? null;
    this._telemetry = this.dependencies.engine?.getTelemetry?.(ship) ?? null;
    this._aeroTelemetry = this.dependencies.atmosphere?.getTelemetry?.(ship) ?? null;

    const stress = this.stressController.update(
      dt,
      this.stressController.fromTelemetry(this._telemetry ?? {}, this._aeroTelemetry ?? {}),
    );
    this._updateLightDirection();

    if (this.pipeline) {
      this.pipeline.setStress(stress);
      this.pipeline.update(dt, this._telemetry);
    } else if (this.postfx) {
      this.postfx.setStress(stress);
      this.postfx.update(dt);
    }
    this._updateTrails(dt);
    return this;
  }

  /** @private Direção da luz em espaço de tela (UV, +y para cima). */
  _updateLightDirection() {
    const sun = this.sun;
    if (!sun) return;
    const point = projectPoint2D(this.camera, sun.x ?? 0, sun.y ?? 0);
    const cx = this.camera.cx ?? this.width / 2;
    const cy = this.camera.cy ?? this.height / 2;
    let dx = point.x - cx;
    let dy = -(point.y - cy);
    const length = Math.hypot(dx, dy);
    if (length < 1e-3) {
      // Sol exatamente atrás da câmera: assume luz vinda de cima/direita.
      dx = 0.5; dy = 0.8;
    } else {
      dx /= length; dy /= length;
    }
    this.lightScreen = [dx, dy];
    this.pipeline?.setLightDirection(dx, dy);
  }

  /* ------------------------------ desenho ------------------------------- */

  /** @private Fundo espacial: gradiente, nebulosa e campo de estrelas. */
  drawBackground(ctx, width, height) {
    const bg = this.options.background;
    if (bg.gradient) {
      const gradient = ctx.createRadialGradient(width * 0.5, height * 0.45, 0, width * 0.5, height * 0.45,
        Math.hypot(width, height) * 0.75);
      gradient.addColorStop(0, bg.nebula ? (bg.nebulaColor ?? '#12213f') : (bg.color ?? '#03050a'));
      gradient.addColorStop(0.55, bg.color ?? '#03050a');
      gradient.addColorStop(1, '#000000');
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = bg.color ?? '#03050a';
    }
    ctx.fillRect(0, 0, width, height);

    if (!this._stars) this._stars = createStarField(bg.stars, bg.starSeed ?? 2026);
    const stars = this._stars;
    const parallax = bg.parallax ?? 0.25;
    const offsetX = (-this.camera.x * (this.camera.scale ?? 1) * 0.000001 * parallax) % width;
    const offsetY = (-this.camera.y * (this.camera.scale ?? 1) * 0.000001 * parallax) % height;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const star of stars) {
      let x = star.x * width + offsetX;
      let y = star.y * height + offsetY;
      if (x < 0) x += width;
      if (y < 0) y += height;
      const twinkle = bg.twinkle
        ? 0.65 + 0.35 * Math.sin(this.time * star.speed + star.phase)
        : 1;
      ctx.globalAlpha = star.alpha * twinkle;
      ctx.fillStyle = star.color;
      const size = star.size;
      ctx.fillRect(x, y, size, size);
    }
    ctx.restore();
  }

  /** @private Corpos celestes com textura procedural (sprites.js) ou fallback. */
  drawBodies(ctx) {
    const spritesNs = this.dependencies.sprites;
    const camera = this.camera;
    for (const body of this.scene.bodies) {
      if (!body || body.visible === false) continue;
      const radiusPx = (body.radius ?? 0) * (camera.scale ?? 1);
      if (radiusPx > 0.4 && !this._isVisible(body.x, body.y, radiusPx)) continue;
      const texture = this._textureFor(body);
      if (spritesNs?.drawBody && texture) {
        spritesNs.drawBody(ctx, body, camera, texture, {
          sun: this.sun ?? undefined,
          time: this.time,
          rings: body.rings !== false,
          clouds: body.clouds !== false,
        });
      } else {
        this._drawBodyFallback(ctx, body, radiusPx);
      }
    }
  }

  /** @private Desenho de corpo sem texturas (gradiente iluminado + limbo). */
  _drawBodyFallback(ctx, body, radiusPx) {
    const position = projectPoint2D(this.camera, body.x ?? 0, body.y ?? 0);
    const radius = Math.max(0.6, radiusPx);
    const sun = this.sun;
    const sunAngle = sun
      ? Math.atan2((sun.y ?? 0) - (body.y ?? 0), (sun.x ?? 0) - (body.x ?? 0))
      : -Math.PI * 0.75;
    const baseColor = toCssHex(body.color ?? '#8fa6c4');
    const litColor = toCssHex(mixColor(baseColor, '#ffffff', 0.25));
    const shadowColor = toCssHex(mixColor(baseColor, '#05070d', 0.82));

    ctx.save();
    if (radius < 3) {
      ctx.fillStyle = litColor;
      ctx.beginPath();
      ctx.arc(position.x, position.y, Math.max(1, radius), 0, TAU);
      ctx.fill();
      ctx.restore();
      return;
    }
    const gradient = ctx.createLinearGradient(
      position.x - Math.cos(sunAngle) * radius,
      position.y - Math.sin(sunAngle) * radius,
      position.x + Math.cos(sunAngle) * radius,
      position.y + Math.sin(sunAngle) * radius,
    );
    gradient.addColorStop(0, litColor);
    gradient.addColorStop(0.45, baseColor);
    gradient.addColorStop(0.62, toCssHex(mixColor(baseColor, '#0a0f18', 0.55)));
    gradient.addColorStop(1, shadowColor);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(position.x, position.y, radius, 0, TAU);
    ctx.fill();

    // Limbo atmosférico.
    if (body.atmosphere) {
      const glow = ctx.createRadialGradient(position.x, position.y, radius * 0.92,
        position.x, position.y, radius * 1.06);
      glow.addColorStop(0, 'rgba(120,190,255,0)');
      glow.addColorStop(0.6, 'rgba(120,190,255,0.28)');
      glow.addColorStop(1, 'rgba(120,190,255,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(position.x, position.y, radius * 1.07, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** @private Órbitas/rastros das naves. */
  drawOrbits(ctx) {
    const trails = this.options.trails;
    if (!trails || trails.mode === 'none') return;
    const camera = this.camera;
    const color = trails.color ?? 'rgba(95,212,255,0.5)';

    const drawPolyline = (points) => {
      if (!points || points.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, 1.2 * (this.pixelRatio ?? 1) * 0.75);
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      let started = false;
      for (const point of points) {
        const p = projectPoint2D(camera, point.x, point.y);
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    };

    if (trails.mode === 'orbit') {
      const engine = this.dependencies.engine;
      const ship = this.scene.spacecraft[0];
      if (engine?.predictTrajectory && ship) {
        if (this._orbitCache.age > (trails.refresh ?? 0.4)
            || !this._orbitCache.points.length) {
          try {
            const prediction = engine.predictTrajectory(ship, trails.orbitSteps ?? 320);
            this._orbitCache = { points: prediction?.points ?? [], age: 0 };
          } catch {
            this._orbitCache = { points: [], age: 0 };
          }
        }
        drawPolyline(this._orbitCache.points);
      } else if (this.scene.orbit) {
        drawPolyline(this.scene.orbit);
      }
    } else {
      for (const points of this._trails.values()) drawPolyline(points);
    }
  }

  /** @private Atualiza rastros (modo `trail`) e a idade do cache de órbita. */
  _updateTrails(dt) {
    this._orbitCache.age += dt;
    const trails = this.options.trails;
    if (!trails || trails.mode !== 'trail') return;
    const max = Math.max(2, trails.length ?? 240);
    for (const ship of this.scene.spacecraft) {
      let list = this._trails.get(ship);
      if (!list) {
        list = [];
        this._trails.set(ship, list);
      }
      list.push({ x: ship.x, y: ship.y });
      if (list.length > max) list.splice(0, list.length - max);
    }
  }

  /** @private Sombras suaves: eclipses em corpos e sombras de naves. */
  drawShadows(ctx) {
    if (!this.options.shadows.enabled || !this.sun) return;
    const receivers = this.scene.bodies.filter((body) => (body.radius ?? 0) > 0 && body !== this.sun);
    const occluders = [...receivers];
    if (this.options.shadows.dropShadows) {
      const worldHeight = (this.camera.height ?? this.height) / Math.max(1e-9, this.camera.scale ?? 1);
      const maxRadius = worldHeight * 0.02;
      for (const ship of this.scene.spacecraft) {
        const radius = Math.min(
          maxRadius,
          Math.max(
            ship.radius ?? 0,
            (ship.spriteLength ?? 34) / Math.max(1e-6, this.camera.scale ?? 1) * 0.25,
          ),
        );
        occluders.push({
          x: ship.x,
          y: ship.y,
          radius,
          height: radius * 2,
        });
      }
    }
    this.shadows.configure({
      opacity: this.options.shadows.opacity,
      blur: this.options.shadows.blur,
      clipToReceivers: this.options.shadows.clipToReceivers,
    });
    this.shadows.render(ctx, {
      sun: this.sun,
      occluders,
      receivers,
      camera: this.camera,
      time: this.time,
    });
  }

  /** @private Partículas térmicas (atmosphere.js) + sistema próprio. */
  drawParticles(ctx) {
    if (this.options.particles.enabled === false) return;
    const spritesNs = this.dependencies.sprites;
    const atmosphere = this.dependencies.atmosphere;
    if (spritesNs?.drawThermalParticles && atmosphere?.particles?.length) {
      spritesNs.drawThermalParticles(ctx, atmosphere.particles, { camera: this.camera });
    }
    if (this.particles) {
      this.particles.draw?.(ctx, { camera: this.camera });
    } else if (this.scene.particles.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const particle of this.scene.particles) {
        const p = projectPoint2D(this.camera, particle.x ?? 0, particle.y ?? 0);
        const size = Math.max(1, (particle.size ?? 2) * (this.camera.scale ?? 1) * 0.001);
        ctx.fillStyle = particle.color ?? 'rgba(255,190,120,0.8)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /** @private Naves com sprite (sprites.js) ou desenho vetorial próprio. */
  drawSpacecraft(ctx) {
    const spritesNs = this.dependencies.sprites;
    for (const ship of this.scene.spacecraft) {
      if (!ship || ship.visible === false) continue;
      const sprite = this._spriteFor(ship);
      if (spritesNs?.drawSpacecraft && sprite) {
        spritesNs.drawSpacecraft(ctx, sprite, this.camera, ship, {
          telemetry: this._telemetry ?? ship,
          time: this.time,
          throttle: ship.throttle ?? 0,
          length: ship.spriteLength ?? 34,
        });
      } else {
        this._drawSpacecraftFallback(ctx, ship);
      }
    }
  }

  /** @private Nave minimalista (casco + pluma proporcional ao empuxo). */
  _drawSpacecraftFallback(ctx, ship) {
    const p = projectPoint2D(this.camera, ship.x ?? 0, ship.y ?? 0);
    const angle = ship.angle ?? 0;
    const size = Math.max(6, (ship.spriteLength ?? 34) * 0.5);
    const throttle = clamp01(ship.throttle ?? 0);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(angle);
    if (throttle > 0.01) {
      const plume = size * (1.4 + throttle * 2.6) * (0.9 + 0.1 * Math.sin(this.time * 40));
      const gradient = ctx.createLinearGradient(-size, 0, -size - plume, 0);
      gradient.addColorStop(0, `rgba(255,240,200,${0.85 * throttle})`);
      gradient.addColorStop(0.35, `rgba(255,150,70,${0.6 * throttle})`);
      gradient.addColorStop(1, 'rgba(255,80,40,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(-size * 0.8, -size * 0.32);
      ctx.lineTo(-size - plume, 0);
      ctx.lineTo(-size * 0.8, size * 0.32);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#d7e6f5';
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.8, -size * 0.42);
    ctx.lineTo(-size * 0.55, 0);
    ctx.lineTo(-size * 0.8, size * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(95,212,255,0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /** @private Overlays customizados (`{ draw(ctx, renderer) }`). */
  drawOverlays(ctx) {
    for (const overlay of this.scene.overlays) {
      if (!overlay) continue;
      if (typeof overlay === 'function') overlay(ctx, this);
      else if (typeof overlay.draw === 'function') overlay.draw(ctx, this);
    }
  }

  /** @private Pós-processamento e apresentação no canvas de destino. */
  present() {
    if (this.pipeline) {
      this._presentWebGL();
      return;
    }
    const fx = this.postfx;
    if (!fx) {
      this.ctx.drawImage(this.sceneCanvas, 0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    fx.render(this.sceneCanvas, this.ctx, { time: this.time });
  }

  /** @private Cena Canvas2D → pipeline WebGL (com GBuffer falso) → canvas. */
  _presentWebGL() {
    const pipeline = this.pipeline;
    if (!pipeline) return;
    const width = this.sceneCanvas.width;
    const height = this.sceneCanvas.height;
    const camera = this.camera;
    const scale = camera.scale ?? 1;

    // Escala de cena e faixa de profundidade a partir das primitivas visíveis.
    const items = this._collectGBufferItems();
    let near = Infinity;
    let far = -Infinity;
    for (const item of items) {
      near = Math.min(near, (item.z ?? 0) - (item.radius ?? 0));
      far = Math.max(far, item.z ?? 0);
    }
    const base = this.options.depth.base;
    if (!Number.isFinite(near) || !Number.isFinite(far) || far <= near) {
      near = base * 0.5;
      far = base * 1.2;
    }

    const gbufferStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.gbuffer.update(items, camera, { near, far });
    this.stats.gbufferMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - gbufferStart;

    const buffers = this.gbuffer.buffers;
    this.glDepth.upload(buffers.depth);
    this.glNormal.upload(buffers.normals);
    this.glMaterial.upload(buffers.material);

    pipeline.setCamera({
      mode: 'orthographic',
      near: Math.max(1e-3, near),
      far,
      orthoSize: [width / (2 * scale), height / (2 * scale)],
      aspect: width / Math.max(1, height),
    });
    pipeline.setDepthTexture(this.glDepth.texture);
    pipeline.setNormalTexture(this.glNormal.texture);
    pipeline.setMaterialTexture(this.glMaterial.texture);
    pipeline.setLightDirection(this.lightScreen[0], this.lightScreen[1]);
    pipeline.renderExternalScene(this.sceneCanvas, { decodeSRGB: true });

    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
    this.ctx.filter = 'none';
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(this.glCanvas, 0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }

  /** @private Primitivas para o GBuffer falso. */
  _collectGBufferItems() {
    const items = [];
    const base = this.options.depth.base;
    const depth = this.options.depth;
    const camera = this.camera;
    for (const body of this.scene.bodies) {
      if (!body || body.visible === false) continue;
      const radius = Math.max(1e-3, body.radius ?? 0);
      const factor = body.depthFactor ?? depth.body ?? 1;
      const z = Math.max(radius * 1.05, (body.z ?? base * factor));
      items.push({
        x: body.x ?? 0,
        y: body.y ?? 0,
        radius,
        z,
        type: 'sphere',
        reflectivity: body.reflectivity ?? this._reflectivityFor(body),
      });
    }
    for (const ship of this.scene.spacecraft) {
      if (!ship || ship.visible === false) continue;
      const radiusWorld = Math.max(
        1e-3,
        (ship.spriteLength ?? 34) / Math.max(1e-6, camera.scale ?? 1) * 0.35,
      );
      items.push({
        x: ship.x ?? 0,
        y: ship.y ?? 0,
        radius: radiusWorld,
        z: base * (depth.ship ?? 0.86),
        type: 'flat',
        reflectivity: ship.reflectivity ?? 0.65,
      });
    }
    return items;
  }

  /** @private Refletividade estimada do corpo (oceanos refletem mais). */
  _reflectivityFor(body) {
    if (Number.isFinite(body.reflectivity)) return body.reflectivity;
    const name = String(body.preset ?? body.name ?? '').toLowerCase();
    if (/earth|terra|ocean|oceano|water|aqua|kerbin/.test(name)) return 0.85;
    if (/ice|gelo|europa|encelad|titan/.test(name)) return 0.55;
    if (/gas|jupiter|saturn|neptun|uran/.test(name)) return 0.25;
    if (/sun|sol|star|estrela/.test(name)) return 0;
    return 0.18;
  }

  /** @private HUD nítido por cima do pós-processamento. */
  drawHUD() {
    if (this.options.hud.enabled === false) return;
    const ctx = this.ctx;
    const deps = this.dependencies;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const telemetry = this._telemetry;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    if (typeof this.options.hud.render === 'function') {
      this.options.hud.render(ctx, this, telemetry);
    } else if (deps.hud?.draw && telemetry) {
      deps.hud.draw(ctx, telemetry, {
        camera: this.camera,
        spacecraft: this.scene.spacecraft[0],
        primary: this.sun ?? this.scene.bodies[0],
        atmosphere: this._aeroTelemetry ?? undefined,
        width,
        height,
        dt: this._lastDt,
      });
    }
    ctx.restore();
  }

  /* ----------------------------- cache/utilitários ----------------------- */

  /** @private Textura de um corpo (cacheada). */
  _textureFor(body) {
    const generator = this.dependencies.generator;
    if (!generator?.planet) return null;
    const key = body.preset ?? body.name ?? `body-${this.scene.bodies.indexOf(body)}`;
    if (this._textures.has(key)) return this._textures.get(key);
    const preset = body.preset ?? inferPlanetPreset(body);
    if (!preset) {
      this._textures.set(key, null);
      return null;
    }
    let texture = null;
    try {
      texture = generator.planet(preset, body.textureOptions ?? {});
    } catch {
      texture = null;
    }
    this._textures.set(key, texture);
    return texture;
  }

  /** @private Sprite de uma nave (cacheado por configuração). */
  _spriteFor(ship) {
    const generator = this.dependencies.generator;
    if (!generator?.spaceship) return null;
    const config = ship.spriteConfig ?? {};
    const key = `ship:${stableKey(config)}`;
    if (this._textures.has(key)) return this._textures.get(key);
    let sprite = null;
    try {
      sprite = generator.spaceship(config);
    } catch {
      sprite = null;
    }
    this._textures.set(key, sprite);
    return sprite;
  }

  /** @private Culling circular simples. */
  _isVisible(x, y, radiusPx) {
    const p = projectPoint2D(this.camera, x ?? 0, y ?? 0);
    const width = this.camera.width ?? this.width;
    const height = this.camera.height ?? this.height;
    return !(p.x + radiusPx < 0 || p.x - radiusPx > width || p.y + radiusPx < 0 || p.y - radiusPx > height);
  }

  /** Aplica preset de qualidade em todos os subsistemas. */
  setQuality(quality) {
    this.options.quality = quality;
    this.pipeline?.setQuality(quality);
    this.postfx?.setQuality(quality === 'low' ? 'fast' : (quality === 'ultra' ? 'full' : 'balanced'));
    this.shadows.configure({ quality });
    return this;
  }

  /** Estado resumido para HUD/depuração. */
  toJSON() {
    return {
      mode: this.mode,
      width: this.width,
      height: this.height,
      pixelRatio: this.pixelRatio,
      time: this.time,
      frames: this.stats.frames,
      camera: { x: this.camera.x, y: this.camera.y, scale: this.camera.scale },
      stress: this.stressController.toJSON(),
      postprocessing: this.pipeline?.toJSON() ?? this.postfx?.toJSON() ?? null,
      gbuffer: { ...this.gbuffer.stats },
      stats: { ...this.stats },
    };
  }

  /** Captura o quadro atual como data URL (PNG por padrão). */
  capture(type = 'image/png') {
    try {
      return this.canvas.toDataURL(type);
    } catch {
      return null;
    }
  }

  /** Libera recursos GL/Canvas. */
  dispose() {
    this.pipeline?.dispose();
    this.postfx?.dispose();
    this.glDepth?.dispose();
    this.glNormal?.dispose();
    this.glMaterial?.dispose();
    this.gbuffer.dispose();
    this.shadows.dispose();
    this.particles?.clear?.();
    this._textures.clear();
    this._trails.clear();
    this.pipeline = null;
    this.postfx = null;
    this.glDepth = null;
    this.glNormal = null;
    this.glMaterial = null;
  }
}

/* ------------------------- utilitários do renderizador -------------------- */

/**
 * Sistema de partículas mínimo (usado apenas quando `sprites.js` não é
 * injetado). Mantém o mesmo contrato: `emit`, `update`, `draw`, `clear`.
 */
export class SimpleParticleSystem {
  /** @param {object} [options] @param {number} [options.maxParticles=1200] */
  constructor(options = {}) {
    this.maxParticles = Math.max(16, options.maxParticles ?? 1200);
    this.particles = [];
    this.count = 0;
    this.time = 0;
  }

  /** Emite uma partícula `{ x, y, vx, vy, life, size, color }`. */
  emit(particle = {}) {
    if (this.particles.length >= this.maxParticles) this.particles.shift();
    this.particles.push({
      x: particle.x ?? 0,
      y: particle.y ?? 0,
      vx: particle.vx ?? 0,
      vy: particle.vy ?? 0,
      life: Math.max(0.01, particle.life ?? 1),
      maxLife: Math.max(0.01, particle.life ?? 1),
      size: particle.size ?? 2,
      color: particle.color ?? 'rgba(255,190,120,0.85)',
      drag: particle.drag ?? 0.4,
      growth: particle.growth ?? 0,
    });
    this.count = this.particles.length;
    return this;
  }

  /** Integra as partículas. */
  update(dt = 0) {
    const step = Math.max(0, Number(dt) || 0);
    this.time += step;
    const alive = [];
    for (const particle of this.particles) {
      particle.life -= step;
      if (particle.life <= 0) continue;
      const damping = Math.exp(-particle.drag * step);
      particle.vx *= damping;
      particle.vy *= damping;
      particle.x += particle.vx * step;
      particle.y += particle.vy * step;
      particle.size += particle.growth * step;
      alive.push(particle);
    }
    this.particles = alive;
    this.count = alive.length;
    return this;
  }

  /** Desenha com projeção de câmera. */
  draw(ctx, options = {}) {
    const camera = options.camera;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const particle of this.particles) {
      const ratio = clamp01(particle.life / particle.maxLife);
      const p = camera ? projectPoint2D(camera, particle.x, particle.y)
        : { x: particle.x, y: particle.y };
      const size = Math.max(0.5, particle.size * (camera?.scale ?? 1) * 0.002);
      ctx.globalAlpha = ratio;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    return this;
  }

  /** Remove todas as partículas. */
  clear() {
    this.particles = [];
    this.count = 0;
    return this;
  }
}

/** @private Campo de estrelas determinístico (uma vez por renderizador). */
function createStarField(count = 900, seed = 2026) {
  const stars = [];
  const total = clamp(Math.round(count), 0, 6000);
  for (let i = 0; i < total; i++) {
    const brightness = 0.25 + hash01(i, seed, 1) * 0.75;
    const hue = hash01(i, seed, 2);
    stars.push({
      x: hash01(i, seed, 3),
      y: hash01(i, seed, 4),
      alpha: brightness,
      size: hash01(i, seed, 5) > 0.94 ? 2 : 1,
      speed: 0.4 + hash01(i, seed, 6) * 2.4,
      phase: hash01(i, seed, 7) * TAU,
      color: hue > 0.82 ? '#ffd9a8' : hue > 0.62 ? '#cfe4ff' : '#ffffff',
    });
  }
  return stars;
}

/** @private Estima o preset de planeta a partir do corpo (nome/atributos). */
function inferPlanetPreset(body) {
  if (body?.preset) return body.preset;
  const name = String(body?.name ?? '').toLowerCase();
  if (/merc|mercur/.test(name)) return 'mercury';
  if (/venus|v[eê]nus/.test(name)) return 'venus';
  if (/marte|mars/.test(name)) return 'mars';
  if (/jupiter|j[uú]piter/.test(name)) return 'jupiter';
  if (/saturn|saturno/.test(name)) return 'saturn';
  if (/urano|uranus/.test(name)) return 'uranus';
  if (/netuno|neptune/.test(name)) return 'neptune';
  if (/lua|moon|luna/.test(name)) return 'moon';
  if (/sol|sun|estrela|star/.test(name)) return null;
  if (/terra|earth/.test(name)) return 'earth';
  const radius = body?.radius ?? 0;
  if (radius > 5e7) return 'jupiter';
  if (radius > 4e6 && radius < 8e6) return 'earth';
  if (radius < 2e6) return 'moon';
  return 'earth';
}

/**
 * @private Localiza a fonte de luz: corpo marcado como estrela
 * (`isStar`/`type === 'star'`) ou o de maior massa acima de ~0.05 M☉.
 * Sem estrela na cena, devolve `null` (iluminação neutra, sem sombras).
 */
function findSun(bodies = []) {
  let best = null;
  for (const body of bodies) {
    if (!body) continue;
    const isStar = body.isStar || body.type === 'star' || body.star === true;
    if (!isStar) continue;
    if (!best || (body.mass ?? 0) > (best.mass ?? 0)) best = body;
  }
  if (best) return best;
  for (const body of bodies) {
    if ((body.mass ?? 0) > 1e28) return body;
  }
  return null;
}

/** Atalho para criar o renderizador. */
export function createRenderer(canvas, options = {}) {
  return new Renderer(canvas, options);
}

/* ========================================================================== */
/*  12. Exportações consolidadas                                              */
/* ========================================================================== */

/**
 * Namespace da API pública (útil para descoberta em runtime, plugins e
 * depuração no console).
 */
export const postprocessing = Object.freeze({
  // pipeline / renderizador
  PostProcessingPipeline,
  Renderer,
  PassChain,
  createPostProcessingPipeline,
  createRenderer,
  // passes
  PostPass,
  FullscreenPass,
  CopyPass,
  BrightPass,
  BloomPass,
  SSAOPass,
  ContactShadowPass,
  SSRPass,
  DepthEncodePass,
  ToneMappingPass,
  CompositePass,
  FXAAPass,
  LuminanceMeter,
  // buffers
  RenderTarget,
  RenderTargetPool,
  createRenderTarget,
  resolveTextureFormat,
  FullscreenQuad,
  DynamicTexture,
  FakeGBuffer,
  DepthNormalBufferBuilder,
  // canvas 2D
  CanvasPostFX,
  CanvasSoftShadowRenderer,
  SoftShadowLayer,
  createRenderCamera,
  projectPoint2D,
  unprojectPoint2D,
  // intensidade/efeitos
  EffectStressController,
  createStressController,
  // utilitários
  setCanvasFactory,
  get2DContext,
  detectWebGLSupport,
  describeGLCapabilities,
  applyToneMapping,
  buildToneMapLUT,
  computeBloomThreshold,
  resolvePostOptions,
  POST_QUALITY,
  POST_SHADERS,
  buildPostShader,
  DEFAULT_POST_OPTIONS,
  DEFAULT_RENDERER_OPTIONS,
  STRESS_DEFAULTS,
  EFFECT_NAMES,
  TONEMAP_OPERATORS,
  SimpleParticleSystem,
});

/** Exportação padrão: o renderizador unificado. */
export default Renderer;
