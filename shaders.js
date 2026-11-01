/**
 * ============================================================================
 *  shaders.js — Shaders PBR, Nuvens Volumétricas e Materiais por Bioma
 * ============================================================================
 *  Módulo ES6+ autocontido (zero dependências externas), projetado para ser o
 *  backend de renderização do simulador orbital formado por:
 *
 *      physics.js      → posições, massas, órbitas e telemetria (SI)
 *      atmosphere.js   → densidade, escala de altura, Rayleigh/Mie, calor
 *      sprites.js      → texturas procedurais (albedo, normal, especular,
 *                        emissivo, nuvens e heightfield) e sprites de nave
 *      shaders.js      → ESTE módulo: programas GLSL, materiais, biomas,
 *                        nuvens volumétricas e gestão de uniformes
 *
 *  Nada é importado: a integração é feita por "duck typing" dos objetos
 *  públicos dos outros módulos (textura de sprites, estado de atmosfera,
 *  corpos de physics), exatamente como `atmosphere.js` e `sprites.js` fazem.
 *
 *  Conteúdo
 *  --------
 *   0. Constantes e utilitários ........... matemática, cor (sRGB/linear),
 *                                           vetores, hash, RNG, ruído CPU.
 *   1. BRDF Cook-Torrance ................. espelho CPU do GLSL: GGX
 *                                           (Trowbridge-Reitz), Smith
 *                                           Schlick-GGX, Fresnel Schlick,
 *                                           F0 metal/dielétrico e avaliação
 *                                           direta completa.
 *   2. Biomas e altitude ................. perfil normalizado, pesos por
 *                                           altitude/latitude, materiais e
 *                                           uniformes para o shader.
 *   3. Nuvens multicamadas ............... presets, camadas físicas (metros),
 *                                           perfis de densidade, fase de
 *                                           Henyey-Greenstein e uniformes.
 *   4. Atmosfera ......................... conversão do estado de
 *                                           `atmosphere.js` em coeficientes
 *                                           de espalhamento para a GPU.
 *   5. Materiais PBR prontos ............. tabela de materiais de nave e de
 *                                           superfície planetária (metálicos e
 *                                           dielétricos).
 *   6. Biblioteca GLSL ................... chunks reutilizáveis: comum,
 *                                           ruído (Simplex/Perlin/Worley),
 *                                           PBR, biomas, nuvens e atmosfera.
 *   7. Catálogo de programas ............. `planet` (superfície PBR com
 *                                           biomas, oceanos, calotas, luzes
 *                                           noturnas e sombra de nuvens),
 *                                           `clouds` (raymarch volumétrico
 *                                           multicamada), `atmosphere` (limbo
 *                                           Rayleigh/Mie) e `spacecraft`
 *                                           (casco metálico/dielétrico,
 *                                           painéis procedurais, calor de
 *                                           reentrada e brilho do motor);
 *                                           uniformes padrão e composição de
 *                                           fontes (ES 1.00 / ES 3.00).
 *   8. Compilação e runtime ............. `ShaderProgram`, compilador com log
 *                                           anotado, `UniformBinder`
 *                                           (introspecção + dispatch por tipo
 *                                           + unidades de textura), cache de
 *                                           texturas, estado de renderização,
 *                                           geometria e `Mesh`.
 *   9. Integração ........................ fábricas prontas:
 *                                           `createPlanetMaterial`,
 *                                           `createCloudMaterial`,
 *                                           `createSpacecraftMaterial`,
 *                                           `createAtmosphereMaterial`,
 *                                           `createPlanetRenderSet`.
 *  10. ShaderLibrary ..................... cache de variantes, compilação sob
 *                                           demanda e liberação de recursos.
 *  11. Fachada ........................... `shaders` (namespace congelado) e
 *                                           default export = `ShaderLibrary`.
 *
 *  Modelo de iluminação (Cook-Torrance)
 *  ------------------------------------
 *   f_r = kd·albedo/π + (D·G·F)/(4·(N·V)·(N·L))
 *     D  = GGX / Trowbridge-Reitz
 *     G  = Smith com aproximação Schlick-GGX (k = (r+1)²/8 p/ luz direta)
 *     F  = Fresnel-Schlick; F0 = mix(0.16·reflectance², albedo, metallic)
 *   A luz ambiente é uma aproximação hemisférica analítica (céu/solo) com
 *   Fresnel dependente da rugosidade e oclusão especular — sem IBL externa.
 *   Todas as cores de material são lineares; a saída do fragment shader é
 *   tonemapeada (ACES) e codificada em sRGB.
 *
 *  Nuvens volumétricas
 *  -------------------
 *   • Massa de nuvens entre duas esferas concêntricas (base e topo em metros),
 *     renderizada em um shell esférico com raymarch analítico (sem depth
 *     buffer próprio) e composição premultiplicada.
 *   • Três decks independentes (baixo/médio/alto). Cada deck tem base/topo,
 *     cobertura, frequência, densidade, semente, deriva e "billow".
 *   • Densidade = fBm de simplex/perlin com domain warp + ruído ridged,
 *     janela de altitude (smoothstep) e erosão por detalhe.
 *   • Iluminação: marcha curta em direção ao Sol, Beer–Lambert, atenuação
 *     por altitude, "powder", fase de Henyey-Greenstein (duplo lobo) e
 *     ambiente hemisférico. Passos e oitavas são `#define` (variantes GLSL
 *     compiladas sob demanda e cacheadas).
 *
 *  Biomas e altitude
 *  -----------------
 *   Sete biomas são misturados por altitude normalizada (0 = fundo do oceano,
 *   `seaLevel` = linha d'água, 1 = pico) e latitude:
 *
 *      deepOcean → ocean → beach → plains → hills → mountains → ice
 *
 *   O shader usa os mapas de `sprites.js` (albedo, normal, especular,
 *   emissivo, nuvens e heightfield) e altera cor, rugosidade, refletância e
 *   oceano/geleira por bioma, sem descartar a arte procedural original.
 *
 *  Unidades
 *  --------
 *   • Altitudes de nuvens/atmosfera e raios planetários: metros (SI), como em
 *     physics.js/atmosphere.js. A cena pode usar unidades de jogo; informe
 *     `metersPerUnit` (ex.: 1e-6 se 1 unidade = 1 Mm) e o módulo converte
 *     raios e coeficientes de espalhamento para o shader.
 *   • Biomas: altitude normalizada [0,1] e latitude em |sin(lat)| [0,1].
 *   • Cores: arrays lineares [r,g,b] em [0,1] nos uniformes; strings CSS são
 *     aceitas nas fábricas e convertidas (sRGB → linear).
 *
 *  Uso típico (WebGL 1, GLSL ES 1.00)
 *  ----------------------------------
 *    import { ShaderLibrary, createPlanetRenderSet, applyRenderState,
 *             createSphereMesh } from './shaders.js';
 *    import { createPlanetTexture } from './sprites.js';
 *    import { calculateAtmosphere } from './atmosphere.js';
 *
 *    const lib   = new ShaderLibrary(gl);
 *    const tex   = createPlanetTexture({ preset: 'earth', width: 1024,
 *                                        heightMap: true });
 *    const atmo  = calculateAtmosphere(120e3, 'earth', { scattering: true });
 *    const sun   = sunFromBodies(sunBody, earthBody, { intensity: 4 });
 *    const set   = createPlanetRenderSet(tex, {
 *      body: { radius: 6.371e6 },
 *      atmosphere: atmo,
 *      metersPerUnit: 1e6,        // 1 unidade de cena = 1.000 km
 *      sun,
 *    });
 *    const sphere = createSphereMesh(gl, { radius: 6.371, segments: 128 });
 *
 *    // --- superfície ---
 *    const surface = lib.forMaterial(set.surface);
 *    surface.setMaterial(set.surface, { cameraPosition, model, viewProjection });
 *    applyRenderState(gl, surface.renderState);
 *    sphere.draw(surface);
 *
 *    // --- nuvens (shell ligeiramente maior) ---
 *    const clouds = lib.forMaterial(set.clouds);
 *    clouds.setMaterial(set.clouds, { cameraPosition, model, viewProjection });
 *    applyRenderState(gl, clouds.renderState);
 *    createSphereMesh(gl, { radius: set.clouds.meta.radii.top, segments: 128 }).draw(clouds);
 *
 *    // --- atmosfera (limbo, shell até o topo físico) ---
 *    const air = lib.forMaterial(set.atmosphere);
 *    air.setMaterial(set.atmosphere, { cameraPosition, model, viewProjection });
 *    applyRenderState(gl, air.renderState);
 *    createSphereMesh(gl, { radius: set.atmosphere.uniforms.uAtmosphereRadius, segments: 128 }).draw(air);
 *
 *    // --- por frame ---
 *    surface.setMaterial(set.surface, { cameraPosition, model, viewProjection, time });
 *    updateShellCamera(set.clouds, cameraPosition, planetCenter, set.clouds.meta.radii.top);
 *
 *  API pública (resumo)
 *  --------------------
 *   Constantes ..... TAU, PI, DEG, EPSILON, BIOME_IDS, BIOME_LABELS,
 *                    DEFAULT_BIOME_PROFILE, BIOME_MATERIALS,
 *                    CLOUD_LAYER_COUNT, CLOUD_LAYER_DEFAULTS,
 *                    CLOUD_DECK_DEFAULTS, CLOUD_PRESETS, PBR_MATERIALS,
 *                    MATERIAL_PRESETS, BLEND_MODES, PROGRAM_NAMES,
 *                    GLSL_VERSION_100, GLSL_VERSION_300
 *   Matemática ..... clamp, clamp01, saturate, lerp, invLerp, smoothstep,
 *                    smootherstep, mod, fract, step, pow5, srgbToLinear,
 *                    linearToSrgb, srgbToLinear3, linearToSrgb3, luminance,
 *                    dot3, cross3, length3, normalize3, add3, sub3, scale3,
 *                    mixVec3, reflect3, parseColor, colorToLinear, mixColor,
 *                    samplePalette, hashInt, hashString, hash01, createRNG,
 *                    perlin3, fbm3, ridged3
 *   BRDF ........... ggxDistribution, distributionGGX, geometrySchlickGGX,
 *                    geometrySmith, fresnelSchlick, fresnelSchlickRoughness,
 *                    f0FromMaterial, evaluateCookTorranceBRDF,
 *                    evaluateAmbientBRDF, specularOcclusion
 *   Biomas ......... normalizeBiomeProfile, biomeWeights, biomeMaterial,
 *                    biomeColor, deriveBiomeProfile, buildBiomeUniforms,
 *                    BIOME_PRESETS
 *   Nuvens ......... normalizeCloudLayer, normalizeCloudDeck,
 *                    resolveCloudLayers, cloudLayerDensity,
 *                    cloudDensityProfile, buildCloudUniforms,
 *                    henyeyGreenstein, cloudPhase, beerLambert
 *   Atmosfera ...... atmosphereUniforms, cloudDeckFromAtmosphere,
 *                    atmosphereFromTelemetry, sunFromBodies
 *   GLSL ........... SHADER_CHUNKS, SHADER_PROGRAMS, buildShaderSource,
 *                    buildAllShaderSources, upgradeShaderSource,
 *                    composeShaderSource, SHADER_UNIFORM_DEFAULTS
 *   Compilação ..... compileShaderSource, linkShaderProgram, createProgram,
 *                    deleteProgram, formatShaderLog, annotateShaderSource,
 *                    ShaderProgram, ShaderLibrary, createShaderLibrary
 *   Materiais ...... Material, UniformBinder, TextureCache,
 *                    uploadShaderTexture, uploadMaterialTextures,
 *                    updateMaterialFrame, updateShellCamera,
 *                    applyRenderState, createSphereGeometry, createSphereMesh,
 *                    createQuadGeometry, createQuadMesh, Mesh
 *   Integração ..... createPlanetMaterial, createCloudMaterial,
 *                    createSpacecraftMaterial, createAtmosphereMaterial,
 *                    createPlanetRenderSet, materialFromSprites,
 *                    createDefaultUniforms, resolveUniforms
 *
 *  Compatibilidade e desempenho
 *  ----------------------------
 *   • GLSL ES 1.00 (WebGL 1) por padrão; `upgradeShaderSource` (ou a opção
 *     `version: '300 es'`) gera a variante WebGL 2 automaticamente.
 *   • Programas são compilados sob demanda e cacheados por hash de defines;
 *     `ShaderLibrary` expõe `release`/`dispose` e nunca reaproveita programas
 *     de contextos diferentes.
 *   • O caminho de renderização não aloca por frame: `UniformBinder` mantém
 *     cache de localizações, tipos e unidades de textura; materiais só
 *     reenviam valores alterados quando `material.version` muda.
 *   • Todos os shaders evitam `dFdx/dFdy`, `texture2DLod` e outras extensões:
 *     rodam em WebGL 1 sem `#extension`.
 * ============================================================================
 */

/* ========================================================================== */
/*  0. Constantes e utilitários                                               */
/* ========================================================================== */

/** Volta completa em radianos. */
export const TAU = Math.PI * 2;
/** Meia volta em radianos. */
export const PI = Math.PI;
/** Um grau em radianos. */
export const DEG = Math.PI / 180;
/** Épsilon numérico usado em divisões e comparações. */
export const EPSILON = 1e-6;

/** Versão GLSL do WebGL 1 (sem diretiva `#version`). */
export const GLSL_VERSION_100 = '100';
/** Versão GLSL do WebGL 2. */
export const GLSL_VERSION_300 = '300 es';

/** Estágios de shader reconhecidos pelo compilador. */
export const SHADER_STAGE = Object.freeze({ VERTEX: 'vertex', FRAGMENT: 'fragment' });

/** Limita `v` ao intervalo [lo, hi]. */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Limita `v` a [0,1]. */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Alias de `clamp01` (nomenclatura GLSL). */
export const saturate = clamp01;
/** Interpolação linear sem saturação de `t`. */
export const lerp = (a, b, t) => a + (b - a) * t;
/** Interpolação linear inversa (0 em `a`, 1 em `b`). */
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
/** Smoothstep clássico 3t² − 2t³. */
export const smoothstep = (edge0, edge1, v) => {
  if (edge0 === edge1) return v < edge0 ? 0 : 1;
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
/** Smoothstep quíntico 6t⁵ − 15t⁴ + 10t³ (derivadas segunda contínuas). */
export const smootherstep = (edge0, edge1, v) => {
  if (edge0 === edge1) return v < edge0 ? 0 : 1;
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** Módulo sempre positivo. */
export const mod = (a, n) => ((a % n) + n) % n;
/** Parte fracionária sempre positiva. */
export const fract = (v) => v - Math.floor(v);
/** Passo discreto. */
export const step = (edge, v) => (v < edge ? 0 : 1);
/** x⁵ (Fresnel/roughness). */
export const pow5 = (x) => x * x * x * x * x;

/** Converte um canal sRGB [0,1] em linear. */
export function srgbToLinear(c) {
  const x = clamp01(c);
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}
/** Converte um canal linear [0,1] em sRGB. */
export function linearToSrgb(c) {
  const x = clamp01(c);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
}
/** Converte um RGB sRGB (array) em linear (novo array). */
export function srgbToLinear3(rgb, out = [0, 0, 0]) {
  out[0] = srgbToLinear(rgb[0]);
  out[1] = srgbToLinear(rgb[1]);
  out[2] = srgbToLinear(rgb[2]);
  return out;
}
/** Converte um RGB linear em sRGB (novo array). */
export function linearToSrgb3(rgb, out = [0, 0, 0]) {
  out[0] = linearToSrgb(rgb[0]);
  out[1] = linearToSrgb(rgb[1]);
  out[2] = linearToSrgb(rgb[2]);
  return out;
}
/** Luminância Rec. 709 de um RGB linear. */
export const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

/* ------------------------------- vetores --------------------------------- */

/** Produto escalar de vec3. */
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Norma de vec3. */
export const length3 = (a) => Math.hypot(a[0], a[1], a[2]);

/** Produto vetorial de vec3. */
export function cross3(a, b, out = [0, 0, 0]) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Normaliza vec3 (retorna [0,1,0] se degenerado). */
export function normalize3(a, out = [0, 0, 0]) {
  const len = Math.hypot(a[0], a[1], a[2]);
  if (len < EPSILON) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  out[0] = a[0] / len; out[1] = a[1] / len; out[2] = a[2] / len;
  return out;
}

/** a + b. */
export function add3(a, b, out = [0, 0, 0]) {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}
/** a − b. */
export function sub3(a, b, out = [0, 0, 0]) {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}
/** a · escalar. */
export function scale3(a, k, out = [0, 0, 0]) {
  out[0] = a[0] * k; out[1] = a[1] * k; out[2] = a[2] * k;
  return out;
}
/** Interpolação linear de vec3. */
export function mixVec3(a, b, t, out = [0, 0, 0]) {
  out[0] = lerp(a[0], b[0], t);
  out[1] = lerp(a[1], b[1], t);
  out[2] = lerp(a[2], b[2], t);
  return out;
}
/** Reflexão de I em relação à normal N: I − 2(I·N)N. */
export function reflect3(i, n, out = [0, 0, 0]) {
  const d = 2 * dot3(i, n);
  out[0] = i[0] - d * n[0];
  out[1] = i[1] - d * n[1];
  out[2] = i[2] - d * n[2];
  return out;
}

/* --------------------------------- cores --------------------------------- */

const NAMED_COLORS = Object.freeze({
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', cyan: '#00ffff', magenta: '#ff00ff', yellow: '#ffff00',
  orange: '#ffa500', gray: '#808080', grey: '#808080', transparent: '#00000000',
  gold: '#ffd700', silver: '#c0c0c0', navy: '#000080', teal: '#008080',
  snow: '#fffafa', ice: '#dff2ff', sand: '#e0c08a', rock: '#7d7a6c',
});

const colorCache = new Map();

/** @private Interpreta um canal "0..255" ou "0..1". */
function channel(value, scale) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  return scale === 255 ? clamp(v, 0, 255) / 255 : clamp01(v);
}

/** @private Expande #rgb/#rgba em #rrggbb/#rrggbbaa. */
function expandHex(hex) {
  if (hex.length === 4 || hex.length === 5) {
    return '#' + hex.slice(1).split('').map((c) => c + c).join('');
  }
  return hex;
}

/**
 * Interpreta uma cor e devolve `[r, g, b, a]` normalizados em sRGB [0,1].
 * Aceita strings CSS (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()`, nomes
 * básicos), arrays `[r,g,b(,a)]` (0..1 ou 0..255) e objetos `{r,g,b,a}`.
 * O `out` é reutilizável para evitar alocações em loops.
 *
 * @param {string|number[]|{r:number,g:number,b:number,a?:number}} color
 * @param {number[]} [out=[1,1,1,1]]
 * @returns {number[]} [r,g,b,a] em sRGB [0,1]
 */
export function parseColor(color, out = [1, 1, 1, 1]) {
  if (typeof color === 'string') {
    const key = color.trim().toLowerCase();
    const cached = colorCache.get(key);
    if (cached) {
      out[0] = cached[0]; out[1] = cached[1]; out[2] = cached[2]; out[3] = cached[3];
      return out;
    }
    const resolved = NAMED_COLORS[key] ?? key;
    let result;
    if (resolved.startsWith('#')) {
      const hex = expandHex(resolved.slice(1));
      if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) {
        result = [1, 1, 1, 1];
      } else {
        result = [
          parseInt(hex.slice(0, 2), 16) / 255,
          parseInt(hex.slice(2, 4), 16) / 255,
          parseInt(hex.slice(4, 6), 16) / 255,
          hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        ];
      }
    } else {
      const match = /^rgba?\(([^)]+)\)$/.exec(resolved);
      if (match) {
        const parts = match[1].split(/[,/\s]+/).filter(Boolean);
        result = [
          channel(parts[0], String(parts[0]).includes('%') ? 100 : 255),
          channel(parts[1], String(parts[1]).includes('%') ? 100 : 255),
          channel(parts[2], String(parts[2]).includes('%') ? 100 : 255),
          parts[3] === undefined ? 1 : channel(parts[3], parts[3].includes('%') ? 100 : 1),
        ];
      } else {
        result = [1, 1, 1, 1];
      }
    }
    colorCache.set(key, result);
    out[0] = result[0]; out[1] = result[1]; out[2] = result[2]; out[3] = result[3];
    return out;
  }

  if (Array.isArray(color) || ArrayBuffer.isView(color)) {
    const max = color.length > 3 ? Math.max(color[0], color[1], color[2], 1) : Math.max(color[0], color[1], color[2], 1);
    const scaleTo255 = max > 1.0001;
    out[0] = clamp01(scaleTo255 ? color[0] / 255 : color[0]);
    out[1] = clamp01(scaleTo255 ? color[1] / 255 : color[1]);
    out[2] = clamp01(scaleTo255 ? color[2] / 255 : color[2]);
    out[3] = color.length > 3 ? clamp01(scaleTo255 && color[3] > 1 ? color[3] / 255 : color[3]) : 1;
    return out;
  }

  if (color && typeof color === 'object') {
    const max = Math.max(color.r ?? 0, color.g ?? 0, color.b ?? 0, 1);
    const scaleTo255 = max > 1.0001;
    out[0] = clamp01(scaleTo255 ? (color.r ?? 0) / 255 : (color.r ?? 0));
    out[1] = clamp01(scaleTo255 ? (color.g ?? 0) / 255 : (color.g ?? 0));
    out[2] = clamp01(scaleTo255 ? (color.b ?? 0) / 255 : (color.b ?? 0));
    out[3] = color.a === undefined ? 1 : clamp01(scaleTo255 && color.a > 1 ? color.a / 255 : color.a);
    return out;
  }
  out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1;
  return out;
}

/**
 * Cor sRGB (qualquer formato de `parseColor`) convertida para linear.
 * @returns {number[]} [r,g,b] lineares
 */
export function colorToLinear(color, out = [0, 0, 0]) {
  const c = parseColor(color, [1, 1, 1, 1]);
  out[0] = srgbToLinear(c[0]);
  out[1] = srgbToLinear(c[1]);
  out[2] = srgbToLinear(c[2]);
  return out;
}

/**
 * Mistura duas cores (em espaço sRGB) e devolve um array linear [r,g,b].
 */
export function mixColor(a, b, t, out = [0, 0, 0]) {
  const ca = parseColor(a, [1, 1, 1, 1]);
  const cb = parseColor(b, [1, 1, 1, 1]);
  const k = clamp01(t);
  out[0] = srgbToLinear(lerp(ca[0], cb[0], k));
  out[1] = srgbToLinear(lerp(ca[1], cb[1], k));
  out[2] = srgbToLinear(lerp(ca[2], cb[2], k));
  return out;
}

/** HSL [0..1] → RGB sRGB [0..1]. */
export function hslToRgb(h, s, l, out = [0, 0, 0]) {
  const hue = fract(h) * 6;
  const c = (1 - Math.abs(2 * clamp01(l) - 1)) * clamp01(s);
  const x = c * (1 - Math.abs((hue % 2) - 1));
  let r = 0; let g = 0; let b = 0;
  if (hue < 1) { r = c; g = x; } else if (hue < 2) { r = x; g = c; }
  else if (hue < 3) { g = c; b = x; } else if (hue < 4) { g = x; b = c; }
  else if (hue < 5) { r = x; b = c; } else { r = c; b = x; }
  const m = clamp01(l) - c / 2;
  out[0] = r + m; out[1] = g + m; out[2] = b + m;
  return out;
}

/**
 * Amostra uma rampa de paradas no formato de `sprites.js`
 * (`[{ pos, color }, ...]`) e devolve RGB linear [r,g,b].
 *
 * @param {Array<{pos:number,color:string}>} stops
 * @param {number} t [0,1]
 * @param {number[]} [out]
 */
export function samplePalette(stops, t, out = [0, 0, 0]) {
  if (!Array.isArray(stops) || stops.length === 0) {
    out[0] = 0.5; out[1] = 0.5; out[2] = 0.5;
    return out;
  }
  const x = clamp01(t);
  if (stops.length === 1) return colorToLinear(stops[0].color ?? stops[0], out);
  if (x <= (stops[0].pos ?? 0)) return colorToLinear(stops[0].color ?? stops[0], out);
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const next = stops[i];
    const p0 = prev.pos ?? (i - 1) / (stops.length - 1);
    const p1 = next.pos ?? i / (stops.length - 1);
    if (x <= p1 || i === stops.length - 1) {
      const k = p1 === p0 ? 0 : clamp01((x - p0) / (p1 - p0));
      return mixColor(prev.color ?? prev, next.color ?? next, k, out);
    }
  }
  return colorToLinear(stops[stops.length - 1].color, out);
}

/* -------------------------------- hash/RNG -------------------------------- */

/** Hash inteiro de 32 bits determinístico. */
export function hashInt(x, y = 0, z = 0) {
  let h = (x | 0) * 0x27d4eb2d ^ (y | 0) * 0x165667b1 ^ (z | 0) * 0x9e3779b1;
  h = (h ^ (h >>> 15)) * 0x85ebca6b;
  h = (h ^ (h >>> 13)) * 0xc2b2ae35;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash de string → inteiro 32 bits (seeds por nome). */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hash determinístico em [0,1). */
export function hash01(x, y = 0, z = 0) {
  return hashInt(x, y, z) / 4294967296;
}

/**
 * RNG determinístico (mulberry32) — mesmo gerador de `sprites.js`.
 * @returns {() => number} valores em [0,1)
 */
export function createRNG(seed = 1) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------- ruído (espelho CPU) -------------------------- */

/** @private Gradiente pseudoaleatório em [-1,1]³. */
function gradient3(ix, iy, iz, seed) {
  const h = hashInt(ix, iy, iz ^ seed);
  const a = (h & 0xffff) / 65535 * TAU;
  const z = ((h >>> 16) & 0xffff) / 65535 * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [Math.cos(a) * r, Math.sin(a) * r, z];
}

/**
 * Ruído de Perlin 3D clássico com interpolação quíntica.
 * @returns {number} aproximadamente [-1,1]
 */
export function perlin3(x, y, z, seed = 0) {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z);
  const xf = x - xi; const yf = y - yi; const zf = z - zi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
  let total = 0;
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const g = gradient3(xi + dx, yi + dy, zi + dz, seed);
        const dot = g[0] * (xf - dx) + g[1] * (yf - dy) + g[2] * (zf - dz);
        const wx = dx ? u : 1 - u;
        const wy = dy ? v : 1 - v;
        const wz = dz ? w : 1 - w;
        total += dot * wx * wy * wz;
      }
    }
  }
  return total * 1.15;
}

/**
 * fBm de Perlin 3D (soma de oitavas normalizada).
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{octaves?:number,lacunarity?:number,gain?:number,seed?:number}} [options]
 * @returns {number} aproximadamente [0,1]
 */
export function fbm3(x, y, z, options = {}) {
  const octaves = clamp(Math.round(options.octaves ?? 4), 1, 12);
  const lacunarity = options.lacunarity ?? 2.03;
  const gain = options.gain ?? 0.5;
  const seed = options.seed ?? 0;
  let sum = 0; let amp = 0.5; let norm = 0;
  let px = x; let py = y; let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += (perlin3(px, py, pz, seed + i * 131) * 0.5 + 0.5) * amp;
    norm += amp;
    px *= lacunarity; py *= lacunarity; pz *= lacunarity;
    amp *= gain;
  }
  return clamp01(sum / Math.max(norm, EPSILON));
}

/** Ruído ridged (cristas) 3D, útil para nuvens e montanhas. */
export function ridged3(x, y, z, options = {}) {
  const octaves = clamp(Math.round(options.octaves ?? 4), 1, 12);
  const seed = options.seed ?? 0;
  let sum = 0; let amp = 0.5; let norm = 0;
  let px = x; let py = y; let pz = z;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(perlin3(px, py, pz, seed + i * 71));
    sum += n * amp;
    norm += amp;
    px *= 2.07; py *= 2.07; pz *= 2.07;
    amp *= 0.5;
  }
  return clamp01(sum / Math.max(norm, EPSILON));
}

/* ========================================================================== */
/*  1. BRDF Cook-Torrance — espelho CPU do GLSL                               */
/* ========================================================================== */
/*
 * Estas funções reproduzem exatamente a matemática do chunk `pbr` usado nos
 * shaders. Servem para testes determinísticos, iluminação por software (HUD,
 * miniaturas, thumbnails de planeta) e para validar conservação de energia
 * antes de enviar parâmetros à GPU.
 */

/**
 * Distribuição GGX / Trowbridge-Reitz.
 *   D = a² / (π · ((N·H)²(a² − 1) + 1)²),  a = roughness²
 *
 * @param {number} NdotH cosseno entre normal e meio-vetor
 * @param {number} roughness [0,1]
 * @returns {number} densidade (> 0)
 */
export function ggxDistribution(NdotH, roughness = 0.5) {
  const r = clamp(roughness, 0.02, 1);
  const a = r * r;
  const a2 = a * a;
  const nh = clamp01(Math.abs(NdotH));
  const denom = nh * nh * (a2 - 1) + 1;
  return a2 / Math.max(PI * denom * denom, 1e-7);
}
/** Alias de `ggxDistribution` com nomenclatura GLSL. */
export const distributionGGX = ggxDistribution;

/**
 * Função geométrica de Smith com aproximação Schlick-GGX (luz direta):
 *   k = (r + 1)² / 8,  G₁(v) = (N·v) / ((N·v)(1 − k) + k)
 */
export function geometrySchlickGGX(NdotX, roughness = 0.5) {
  const r = clamp(roughness, 0.02, 1);
  const k = ((r + 1) * (r + 1)) / 8;
  const n = clamp01(NdotX);
  return n / Math.max(n * (1 - k) + k, 1e-5);
}

/** Smith completo (view × light). */
export function geometrySmith(NdotV, NdotL, roughness = 0.5) {
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

/**
 * Fresnel-Schlick: F = F0 + (1 − F0)(1 − cosθ)⁵.
 * Aceita `f0` escalar ou array RGB; devolve o mesmo formato.
 */
export function fresnelSchlick(cosTheta, f0 = 0.04) {
  const f = pow5(1 - clamp01(cosTheta));
  if (Array.isArray(f0) || ArrayBuffer.isView(f0)) {
    return [f0[0] + (1 - f0[0]) * f, f0[1] + (1 - f0[1]) * f, f0[2] + (1 - f0[2]) * f];
  }
  return f0 + (1 - f0) * f;
}

/** Fresnel-Schlick com saturação de rugosidade (aproximação IBL). */
export function fresnelSchlickRoughness(cosTheta, f0, roughness = 0.5) {
  const r = clamp01(roughness);
  const f = pow5(1 - clamp01(cosTheta));
  if (Array.isArray(f0) || ArrayBuffer.isView(f0)) {
    const maxv = [Math.max(1 - r, f0[0]), Math.max(1 - r, f0[1]), Math.max(1 - r, f0[2])];
    return [
      f0[0] + (maxv[0] - f0[0]) * f,
      f0[1] + (maxv[1] - f0[1]) * f,
      f0[2] + (maxv[2] - f0[2]) * f,
    ];
  }
  const maxv = Math.max(1 - r, f0);
  return f0 + (maxv - f0) * f;
}

/**
 * F0 a partir de metalicidade/refletância:
 *   dielétrico = 0.16·reflectance² (≈ 0.04 em reflectance = 0.5)
 *   F0 = mix(dielétrico, albedo, metallic)
 */
export function f0FromMaterial(metallic = 0, reflectance = 0.5, albedo = [1, 1, 1]) {
  const dielectric = 0.16 * reflectance * reflectance;
  const m = clamp01(metallic);
  return [
    lerp(dielectric, albedo[0], m),
    lerp(dielectric, albedo[1], m),
    lerp(dielectric, albedo[2], m),
  ];
}

/** Oclusão especular (Karis) — evita especular em cavidades. */
export function specularOcclusion(NdotV, ao = 1, roughness = 0.5) {
  const v = clamp01(NdotV);
  const a = clamp01(ao);
  const r = clamp01(roughness);
  return clamp01((v + a) ** Math.pow(2, -16 * r - 1) - 1 + a);
}

/**
 * Avalia a BRDF de Cook-Torrance para uma luz direcional e devolve todos os
 * termos intermediários (útil para depuração e testes de energia).
 *
 * @param {object} input
 * @param {number[]} [input.normal=[0,0,1]]
 * @param {number[]} [input.view=[0,0,1]]   direção do ponto para a câmera
 * @param {number[]} [input.light=[0,0,1]]  direção do ponto para a luz
 * @param {number[]} [input.albedo=[1,1,1]] linear
 * @param {number} [input.metallic=0]
 * @param {number} [input.roughness=0.5]
 * @param {number} [input.reflectance=0.5]
 * @param {number[]} [input.radiance=[1,1,1]] linear
 * @returns {{NdotL:number,NdotV:number,NdotH:number,VdotH:number,D:number,G:number,F:number[],diffuse:number[],specular:number[],result:number[]}}
 */
export function evaluateCookTorranceBRDF(input = {}) {
  const N = normalize3(input.normal ?? [0, 0, 1]);
  const V = normalize3(input.view ?? [0, 0, 1]);
  const L = normalize3(input.light ?? [0, 0, 1]);
  const albedo = input.albedo ?? [1, 1, 1];
  const metallic = clamp01(input.metallic ?? 0);
  const roughness = clamp(input.roughness ?? 0.5, 0.02, 1);
  const reflectance = clamp01(input.reflectance ?? 0.5);
  const radiance = input.radiance ?? [1, 1, 1];

  const H = normalize3([V[0] + L[0], V[1] + L[1], V[2] + L[2]]);
  const NdotL = dot3(N, L);
  const NdotV = Math.max(dot3(N, V), 1e-4);
  const NdotH = Math.max(dot3(N, H), 0);
  const VdotH = Math.max(dot3(V, H), 0);

  const D = ggxDistribution(NdotH, roughness);
  const G = geometrySmith(NdotV, Math.max(NdotL, 0), roughness);
  const F = fresnelSchlick(VdotH, f0FromMaterial(metallic, reflectance, albedo));
  const kd = [0, 0, 0];
  for (let i = 0; i < 3; i++) kd[i] = (1 - F[i]) * (1 - metallic);

  const diffuse = [0, 0, 0];
  const specular = [0, 0, 0];
  const result = [0, 0, 0];
  const nl = Math.max(NdotL, 0);
  const specFactor = (D * G) / Math.max(4 * NdotV * nl, 1e-4);
  for (let i = 0; i < 3; i++) {
    diffuse[i] = (kd[i] * albedo[i]) / PI;
    specular[i] = specFactor * F[i];
    result[i] = (diffuse[i] + specular[i]) * radiance[i] * nl;
  }
  return { NdotL, NdotV, NdotH, VdotH, D, G, F, diffuse, specular, result };
}

/**
 * Aproximação analítica de luz ambiente (hemisfério céu/solo), idêntica ao
 * shader. Não usa mapa de ambiente: difusa por irradiância hemisférica e
 * especular por reflexão com Fresnel dependente da rugosidade.
 *
 * @param {object} input
 * @param {number[]} [input.normal]
 * @param {number[]} [input.view]
 * @param {number[]} [input.albedo]
 * @param {number} [input.metallic=0]
 * @param {number} [input.roughness=0.5]
 * @param {number} [input.reflectance=0.5]
 * @param {number[]} [input.skyColor=[0.35,0.5,0.8]]
 * @param {number[]} [input.groundColor=[0.08,0.07,0.06]]
 * @param {number} [input.intensity=0.4]
 * @param {number} [input.ao=1]
 * @returns {{diffuse:number[],specular:number[],result:number[],F:number[]}}
 */
export function evaluateAmbientBRDF(input = {}) {
  const N = normalize3(input.normal ?? [0, 0, 1]);
  const V = normalize3(input.view ?? [0, 0, 1]);
  const albedo = input.albedo ?? [1, 1, 1];
  const metallic = clamp01(input.metallic ?? 0);
  const roughness = clamp(input.roughness ?? 0.5, 0.02, 1);
  const reflectance = clamp01(input.reflectance ?? 0.5);
  const sky = input.skyColor ?? [0.35, 0.5, 0.8];
  const ground = input.groundColor ?? [0.08, 0.07, 0.06];
  const intensity = Math.max(0, input.intensity ?? 0.4);
  const ao = clamp01(input.ao ?? 1);

  const NdotV = Math.max(dot3(N, V), 1e-4);
  const F = fresnelSchlickRoughness(NdotV, f0FromMaterial(metallic, reflectance, albedo), roughness);
  const kd = [0, 0, 0];
  for (let i = 0; i < 3; i++) kd[i] = (1 - F[i]) * (1 - metallic);

  const t = clamp01(N[1] * 0.5 + 0.5);
  const irradiance = [0, 0, 0];
  for (let i = 0; i < 3; i++) irradiance[i] = lerp(ground[i], sky[i], t) * intensity;

  const R = reflect3(scale3(V, -1), N);
  const rt = clamp01(R[1] * 0.5 + 0.5);
  const envSpec = [0, 0, 0];
  for (let i = 0; i < 3; i++) envSpec[i] = lerp(ground[i], sky[i], rt) * intensity;

  const specFade = lerp(0.15, 1, 1 - roughness);
  const diffuse = [0, 0, 0];
  const specular = [0, 0, 0];
  const result = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    diffuse[i] = kd[i] * albedo[i] * irradiance[i];
    specular[i] = F[i] * envSpec[i] * specFade * specularOcclusion(NdotV, ao, roughness);
    result[i] = (diffuse[i] + specular[i]) * ao;
  }
  return { diffuse, specular, result, F };
}

/** Mapeamento tonemap ACES (aproximação de Narkowicz), igual ao GLSL. */
export function tonemapACES(rgb, exposure = 1, out = [0, 0, 0]) {
  for (let i = 0; i < 3; i++) {
    const x = Math.max(0, rgb[i] * exposure);
    out[i] = clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
  }
  return out;
}

/* ========================================================================== */
/*  2. Biomas e altitude                                                      */
/* ========================================================================== */

/** Identificadores de bioma, na ordem de mistura do oceano ao gelo. */
export const BIOME_IDS = Object.freeze([
  'deepOcean', 'ocean', 'beach', 'plains', 'hills', 'mountains', 'ice',
]);

/** Rótulos em português para HUD/legendas. */
export const BIOME_LABELS = Object.freeze({
  deepOcean: 'Oceano profundo',
  ocean: 'Oceano',
  beach: 'Praia',
  plains: 'Planície',
  hills: 'Colinas',
  mountains: 'Cordilheira',
  ice: 'Calota/Neve',
});

/**
 * Parâmetros padrão de mistura. Altitudes normalizadas:
 *   0 = abissal, `seaLevel` = linha d'água, 1 = pico.
 * `polarStart` usa |sin(latitude)| (a mesma coordenada de `iceCaps` em
 * sprites.js), e `polarSoftness` a largura da transição.
 */
export const DEFAULT_BIOME_PROFILE = Object.freeze({
  seaLevel: 0.55,
  beachWidth: 0.035,
  plainsLine: 0.72,
  mountainLine: 0.86,
  snowLine: 0.94,
  polarStart: 0.82,
  polarSoftness: 0.08,
  oceanSoftness: 0.012,
  iceStrength: 1,
  hasOcean: true,
});

/**
 * Aparência física por bioma (rugosidade, refletância, metálicidade e cor de
 * referência). Cores são lineares e reproduzem a linguagem de sprites.js.
 */
export const BIOME_MATERIALS = Object.freeze({
  deepOcean: Object.freeze({ roughness: 0.06, reflectance: 0.62, metallic: 0, color: '#061a2b' }),
  ocean: Object.freeze({ roughness: 0.13, reflectance: 0.55, metallic: 0, color: '#17708a' }),
  beach: Object.freeze({ roughness: 0.88, reflectance: 0.25, metallic: 0, color: '#c2ad7f' }),
  plains: Object.freeze({ roughness: 0.80, reflectance: 0.20, metallic: 0, color: '#5d8446' }),
  hills: Object.freeze({ roughness: 0.86, reflectance: 0.22, metallic: 0, color: '#5c6b48' }),
  mountains: Object.freeze({ roughness: 0.68, reflectance: 0.30, metallic: 0, color: '#7d7a6c' }),
  ice: Object.freeze({ roughness: 0.20, reflectance: 0.52, metallic: 0, color: '#e8f3ff' }),
});

/**
 * Paletas compactas por nome de planeta — usadas quando a fábrica recebe
 * apenas um nome (sem o objeto de textura de sprites). Quando a textura é
 * fornecida, as cores reais de `preset.palette` têm prioridade.
 */
export const BIOME_PRESETS = Object.freeze({
  earth: Object.freeze({
    type: 'terrestrial', seaLevel: 0.55, polarStart: 0.8, polarSoftness: 0.09,
    colors: Object.freeze({ deepOcean: '#061a2b', ocean: '#17708a', beach: '#b3a37c', plains: '#3f6b39', hills: '#5c6b48', mountains: '#7d7a6c', ice: '#e8f3ff' }),
  }),
  ocean: Object.freeze({
    type: 'terrestrial', seaLevel: 0.66, polarStart: 0.88, polarSoftness: 0.05,
    colors: Object.freeze({ deepOcean: '#031726', ocean: '#127f96', beach: '#c3b58e', plains: '#3d7346', hills: '#6d7a62', mountains: '#8f9c85', ice: '#eaf6ff' }),
  }),
  desert: Object.freeze({
    type: 'terrestrial', seaLevel: 0.36, polarStart: 0.92, polarSoftness: 0.04,
    colors: Object.freeze({ deepOcean: '#2a1608', ocean: '#a8702f', beach: '#dcc08f', plains: '#b98450', hills: '#a9713d', mountains: '#7a4c2b', ice: '#f2e8d8' }),
  }),
  mars: Object.freeze({
    type: 'terrestrial', seaLevel: 0, hasOcean: false, polarStart: 0.82, polarSoftness: 0.08,
    colors: Object.freeze({ deepOcean: '#3a1f10', ocean: '#6b3f16', beach: '#c99a5c', plains: '#b98450', hills: '#a9713d', mountains: '#7a4c2b', ice: '#f2e8d8' }),
  }),
  moon: Object.freeze({
    type: 'terrestrial', seaLevel: 0, hasOcean: false, polarStart: 0.94, polarSoftness: 0.05,
    colors: Object.freeze({ deepOcean: '#3c3b39', ocean: '#4c4b48', beach: '#8d8a83', plains: '#9a978f', hills: '#7c7973', mountains: '#c9c6bf', ice: '#e8edf2' }),
  }),
  mercury: Object.freeze({
    type: 'terrestrial', seaLevel: 0, hasOcean: false, polarStart: 0.95, polarSoftness: 0.04,
    colors: Object.freeze({ deepOcean: '#33312f', ocean: '#44423f', beach: '#77736c', plains: '#8a857c', hills: '#6f6b63', mountains: '#b0aaa0', ice: '#e2e7ec' }),
  }),
  venus: Object.freeze({
    type: 'terrestrial', seaLevel: 0, hasOcean: false, polarStart: 0.95, polarSoftness: 0.06,
    colors: Object.freeze({ deepOcean: '#6b4a1e', ocean: '#a8792f', beach: '#c1964e', plains: '#d8ae62', hills: '#e6c37c', mountains: '#f8ecc8', ice: '#f4e6c2' }),
  }),
  io: Object.freeze({
    type: 'terrestrial', seaLevel: 0, hasOcean: false, polarStart: 0.95, polarSoftness: 0.05,
    colors: Object.freeze({ deepOcean: '#3a1f06', ocean: '#7d4a12', beach: '#c9a53d', plains: '#dcc45e', hills: '#c08a30', mountains: '#8a4f18', ice: '#efe4b8' }),
  }),
  europa: Object.freeze({
    type: 'terrestrial', seaLevel: 0, hasOcean: false, polarStart: 0.97, polarSoftness: 0.04,
    colors: Object.freeze({ deepOcean: '#0d2230', ocean: '#2a5f76', beach: '#c6d4dc', plains: '#dde9ef', hills: '#eef6fa', mountains: '#b9a48c', ice: '#f4fbff' }),
  }),
  titan: Object.freeze({
    type: 'terrestrial', seaLevel: 0.3, polarStart: 0.9, polarSoftness: 0.06,
    colors: Object.freeze({ deepOcean: '#2a1a08', ocean: '#4a2f10', beach: '#a8712a', plains: '#bd8838', hills: '#d09a48', mountains: '#8a5a20', ice: '#e8c07a' }),
  }),
  jupiter: Object.freeze({
    type: 'gasGiant', seaLevel: 0, hasOcean: false, polarStart: 0.9,
    colors: Object.freeze({ deepOcean: '#8a6647', ocean: '#c9a97e', beach: '#efe0c2', plains: '#b98a5c', hills: '#ead7b4', mountains: '#a8794f', ice: '#f4e8cf' }),
  }),
  saturn: Object.freeze({
    type: 'gasGiant', seaLevel: 0, hasOcean: false, polarStart: 0.92,
    colors: Object.freeze({ deepOcean: '#a08a5f', ocean: '#cfba8c', beach: '#efe3c0', plains: '#c4a875', hills: '#e8d8ac', mountains: '#b09a6a', ice: '#f6eed6' }),
  }),
  uranus: Object.freeze({
    type: 'gasGiant', seaLevel: 0, hasOcean: false, polarStart: 0.95,
    colors: Object.freeze({ deepOcean: '#3f8f9a', ocean: '#7fc9cf', beach: '#c6eef0', plains: '#9bdde2', hills: '#b6ecef', mountains: '#6bb4bd', ice: '#e6fbff' }),
  }),
  neptune: Object.freeze({
    type: 'gasGiant', seaLevel: 0, hasOcean: false, polarStart: 0.95,
    colors: Object.freeze({ deepOcean: '#122a6b', ocean: '#2f5fc4', beach: '#7fa8f2', plains: '#3f74d8', hills: '#5b8fe8', mountains: '#274b9e', ice: '#dfe9ff' }),
  }),
  gasGiant: Object.freeze({
    type: 'gasGiant', seaLevel: 0, hasOcean: false, polarStart: 0.9,
    colors: Object.freeze({ deepOcean: '#8a6647', ocean: '#c9a97e', beach: '#efe0c2', plains: '#b98a5c', hills: '#ead7b4', mountains: '#a8794f', ice: '#f4e8cf' }),
  }),
});

/** Nomes aceitos → chave canônica de `BIOME_PRESETS`. */
const BIOME_PRESET_ALIASES = Object.freeze({
  terra: 'earth', earth: 'earth', lua: 'moon', moon: 'moon', marte: 'mars', mars: 'mars',
  mercurio: 'mercury', 'mercúrio': 'mercury', mercury: 'mercury',
  venus: 'venus', 'vênus': 'venus', jupiter: 'jupiter', 'júpiter': 'jupiter',
  saturno: 'saturn', saturn: 'saturn', urano: 'uranus', uranus: 'uranus',
  netuno: 'neptune', neptune: 'neptune', tita: 'titan', 'titã': 'titan', titan: 'titan',
  sol: 'venus', sun: 'venus', ceres: 'moon', pluto: 'mercury', plutao: 'mercury', 'plutão': 'mercury',
});

/**
 * Normaliza e ordena um perfil de biomas, garantindo que as faixas de
 * altitude sejam monotônicas e não degeneradas.
 *
 * @param {object} [profile]
 * @returns {object} perfil congelado? (não; retorna cópia mutável simples)
 */
export function normalizeBiomeProfile(profile = {}) {
  const p = profile ?? {};
  const hasOcean = p.hasOcean !== false && (p.seaLevel ?? DEFAULT_BIOME_PROFILE.seaLevel) > 0.001;
  const seaLevel = hasOcean ? clamp(p.seaLevel ?? DEFAULT_BIOME_PROFILE.seaLevel, 0.02, 0.96) : 0;
  const beachWidth = hasOcean
    ? clamp(p.beachWidth ?? DEFAULT_BIOME_PROFILE.beachWidth, 0.001, 0.25)
    : 0;
  const landStart = hasOcean ? seaLevel + beachWidth : 0;
  const plainsLine = clamp(p.plainsLine ?? lerp(landStart, 1, 0.42), landStart + 0.005, 0.985);
  const mountainLine = clamp(p.mountainLine ?? lerp(landStart, 1, 0.78), plainsLine + 0.005, 0.995);
  const snowLine = clamp(p.snowLine ?? lerp(landStart, 1, 0.94), mountainLine, 0.999);
  return {
    seaLevel,
    beachWidth,
    plainsLine,
    mountainLine,
    snowLine,
    polarStart: clamp(p.polarStart ?? DEFAULT_BIOME_PROFILE.polarStart, 0, 1),
    polarSoftness: clamp(p.polarSoftness ?? DEFAULT_BIOME_PROFILE.polarSoftness, 0.001, 0.5),
    oceanSoftness: clamp(p.oceanSoftness ?? DEFAULT_BIOME_PROFILE.oceanSoftness, 0.0005, 0.2),
    iceStrength: clamp01(p.iceStrength ?? DEFAULT_BIOME_PROFILE.iceStrength),
    hasOcean,
  };
}

/**
 * Pesos de mistura por bioma. Espelha `biomeWeights()` do chunk GLSL.
 *
 * @param {number} altitude altitude normalizada [0,1]
 * @param {number} polar |sin(latitude)| [0,1]
 * @param {object} [profile] perfil já normalizado (ver `normalizeBiomeProfile`)
 * @param {object} [out] objeto reutilizável
 * @returns {{deepOcean:number,ocean:number,beach:number,plains:number,hills:number,mountains:number,ice:number}}
 */
export function biomeWeights(altitude, polar = 0, profile = DEFAULT_BIOME_PROFILE, out = {}) {
  const p = profile?.seaLevel === undefined ? normalizeBiomeProfile(profile) : profile;
  const h = clamp01(altitude);
  const sea = p.seaLevel ?? DEFAULT_BIOME_PROFILE.seaLevel;
  const soft = p.oceanSoftness ?? DEFAULT_BIOME_PROFILE.oceanSoftness;

  let ocean = 0;
  let deep = 0;
  if (p.hasOcean !== false && sea > 0) {
    ocean = 1 - smoothstep(sea - soft, sea + soft, h);
    const depth = clamp01((sea - h) / Math.max(sea, EPSILON));
    deep = ocean * smoothstep(0, 0.4, depth);
  }
  const shallow = Math.max(0, ocean - deep);

  const above = 1 - ocean;
  const beachEnd = sea + (p.beachWidth ?? 0);
  const beach = above * (1 - smoothstep(lerp(sea, beachEnd, 0.55), beachEnd, h));
  const inland = Math.max(0, above - beach);

  const plainsLine = p.plainsLine ?? DEFAULT_BIOME_PROFILE.plainsLine;
  const mountainLine = p.mountainLine ?? DEFAULT_BIOME_PROFILE.mountainLine;
  const snowLine = p.snowLine ?? DEFAULT_BIOME_PROFILE.snowLine;

  const mountains = inland * smoothstep(mountainLine - 0.03, mountainLine + 0.02, h);
  const plains = inland * (1 - smoothstep(plainsLine - 0.05, plainsLine + 0.01, h));
  const hills = Math.max(0, inland - plains - mountains);

  const snow = smoothstep(snowLine - 0.025, snowLine + 0.01, h) * (mountains + hills * 0.35);
  const polarMask = smoothstep(
    (p.polarStart ?? DEFAULT_BIOME_PROFILE.polarStart) - (p.polarSoftness ?? 0.08),
    (p.polarStart ?? DEFAULT_BIOME_PROFILE.polarStart) + (p.polarSoftness ?? 0.08),
    clamp01(polar),
  ) * clamp01(p.iceStrength ?? 1);
  const ice = clamp01(1 - (1 - clamp01(snow)) * (1 - polarMask));

  const cover = 1 - ice;
  out.deepOcean = deep * cover;
  out.ocean = shallow * cover;
  out.beach = beach * cover;
  out.plains = plains * cover;
  out.hills = hills * cover;
  out.mountains = mountains * cover;
  out.ice = ice;

  const sum = out.deepOcean + out.ocean + out.beach + out.plains + out.hills + out.mountains + out.ice;
  if (sum > EPSILON) {
    for (const id of BIOME_IDS) out[id] /= sum;
  } else {
    out.plains = 1;
  }
  return out;
}

/**
 * Mistura propriedades físicas (rugosidade, refletância, metálicidade) e cor
 * de referência a partir dos pesos de bioma.
 *
 * @param {object} weights saída de `biomeWeights`
 * @param {object} [options]
 * @param {object} [options.materials=BIOME_MATERIALS] materiais por bioma
 * @param {object} [options.colors] cores lineares por bioma (sobrepõe)
 * @param {number} [options.metallic=0] metálicidade global
 * @returns {{roughness:number,reflectance:number,metallic:number,color:number[]}}
 */
export function biomeMaterial(weights, options = {}) {
  const mats = options.materials ?? BIOME_MATERIALS;
  const colors = options.colors ?? null;
  let roughness = 0;
  let reflectance = 0;
  const color = [0, 0, 0];
  let total = 0;
  for (const id of BIOME_IDS) {
    const w = Math.max(0, weights?.[id] ?? 0);
    if (w <= 0) continue;
    const m = mats[id] ?? BIOME_MATERIALS[id];
    roughness += m.roughness * w;
    reflectance += m.reflectance * w;
    const c = colors?.[id] ?? colorToLinear(m.color, [0, 0, 0]);
    color[0] += c[0] * w; color[1] += c[1] * w; color[2] += c[2] * w;
    total += w;
  }
  if (total > EPSILON) {
    roughness /= total; reflectance /= total;
    color[0] /= total; color[1] /= total; color[2] /= total;
  }
  return {
    roughness: clamp(roughness, 0.02, 1),
    reflectance: clamp01(reflectance),
    metallic: clamp01(options.metallic ?? 0),
    color,
  };
}

/** Mistura apenas as cores dos biomas (linear). */
export function biomeColor(weights, colors, out = [0, 0, 0]) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  let total = 0;
  for (const id of BIOME_IDS) {
    const w = Math.max(0, weights?.[id] ?? 0);
    if (w <= 0) continue;
    const c = parseColor(colors?.[id] ?? BIOME_MATERIALS[id].color, [0, 0, 0, 1]);
    out[0] += srgbToLinear(c[0]) * w;
    out[1] += srgbToLinear(c[1]) * w;
    out[2] += srgbToLinear(c[2]) * w;
    total += w;
  }
  if (total > EPSILON) { out[0] /= total; out[1] /= total; out[2] /= total; }
  return out;
}

/**
 * Deriva um perfil de biomas de um preset de sprites.js (ou de um nome).
 * Se `preset.palette` existir, extrai as cores reais dos gradientes de oceano,
 * terra e gelo — integração direta com o gerador de sprites.
 *
 * @param {object|string} preset preset de sprites / saída de `resolvePlanetPreset`
 * @param {object} [overrides] ajustes finos (mesmos campos do perfil)
 * @returns {{profile:object, colors:object, bodyType:string, paletteSource:boolean}}
 */
export function deriveBiomeProfile(preset = 'earth', overrides = {}) {
  let source = preset;
  if (typeof preset === 'string') {
    const key = BIOME_PRESET_ALIASES[preset.trim().toLowerCase()] ?? preset.trim().toLowerCase();
    source = BIOME_PRESETS[key] ?? BIOME_PRESETS.earth;
  }
  const type = source?.type === 'gasGiant' ? 'gasGiant' : 'terrestrial';
  const palette = source?.palette ?? null;
  const presetKey = typeof preset === 'string' ? preset.trim().toLowerCase() : '';
  const baseKey = presetKey ? (BIOME_PRESET_ALIASES[presetKey] ?? presetKey) : null;
  const fallback = (baseKey && BIOME_PRESETS[baseKey]) || BIOME_PRESETS.earth;
  const fallbackColors = fallback.colors ?? BIOME_PRESETS.earth.colors;

  let colors;
  if (palette) {
    const oceanStops = palette.ocean ?? palette.bands ?? null;
    const landStops = palette.land ?? palette.bands ?? null;
    colors = {
      deepOcean: samplePalette(oceanStops, 0.02, [0, 0, 0]),
      ocean: samplePalette(oceanStops, 0.92, [0, 0, 0]),
      beach: samplePalette(landStops, 0.02, [0, 0, 0]),
      plains: samplePalette(landStops, 0.32, [0, 0, 0]),
      hills: samplePalette(landStops, 0.58, [0, 0, 0]),
      mountains: samplePalette(landStops, 0.8, [0, 0, 0]),
      ice: colorToLinear(palette.ice ?? palette.snow ?? fallbackColors.ice, [0, 0, 0]),
    };
  } else {
    colors = {};
    for (const id of BIOME_IDS) colors[id] = colorToLinear(fallbackColors[id], [0, 0, 0]);
  }

  const seaLevelRaw = source?.height?.seaLevel;
  const explicitOcean = overrides.hasOcean ?? source?.hasOcean;
  const inferredOcean = Number.isFinite(seaLevelRaw)
    ? seaLevelRaw > 0.001 && seaLevelRaw < 0.995
    : (source?.seaLevel ?? fallback.seaLevel) > 0.001;
  const hasOcean = type === 'terrestrial'
    && (explicitOcean !== undefined ? !!explicitOcean : inferredOcean);
  const seaLevel = hasOcean
    ? clamp01(overrides.seaLevel ?? (Number.isFinite(seaLevelRaw) ? seaLevelRaw : (source?.seaLevel ?? fallback.seaLevel)))
    : 0;

  const profile = normalizeBiomeProfile({
    ...DEFAULT_BIOME_PROFILE,
    seaLevel,
    hasOcean,
    beachWidth: overrides.beachWidth ?? (hasOcean ? 0.035 : 0),
    polarStart: overrides.polarStart ?? source?.iceCaps?.start ?? source?.polarStart ?? fallback.polarStart ?? 0.86,
    polarSoftness: overrides.polarSoftness ?? source?.iceCaps?.softness ?? source?.polarSoftness ?? fallback.polarSoftness ?? 0.07,
    iceStrength: overrides.iceStrength ?? (source?.iceCaps ? 1 : (type === 'gasGiant' ? 0.25 : 0.65)),
    ...overrides,
  });

  return { profile, colors, bodyType: type, paletteSource: !!palette, name: source?.name ?? 'planeta' };
}

/**
 * Converte um perfil + cores em uniformes prontos para o programa `planet`.
 *
 * @param {object} profile saída de `normalizeBiomeProfile`
 * @param {object} colors cores lineares ou CSS por bioma
 * @param {object} [options]
 * @param {number} [options.tintStrength=0.42] quanto a cor do bioma substitui o albedo do mapa
 * @param {object} [options.materials] sobrescreve BIOME_MATERIALS
 * @returns {object} mapa nome-do-uniform → valor
 */
export function buildBiomeUniforms(profile, colors, options = {}) {
  const p = normalizeBiomeProfile(profile);
  const c = {};
  for (const id of BIOME_IDS) {
    c[id] = Array.isArray(colors?.[id]) && colors[id].length >= 3
      ? colors[id].slice(0, 3)
      : colorToLinear(colors?.[id] ?? BIOME_MATERIALS[id].color, [0, 0, 0]);
  }
  const mats = options.materials ?? BIOME_MATERIALS;
  return {
    uBiomeParams: [p.seaLevel, p.beachWidth, p.plainsLine, p.mountainLine],
    uBiomeParams2: [p.snowLine, p.polarStart, p.polarSoftness, p.iceStrength],
    uBiomeRoughnessA: [mats.deepOcean.roughness, mats.ocean.roughness, mats.beach.roughness, mats.plains.roughness],
    uBiomeRoughnessB: [mats.hills.roughness, mats.mountains.roughness, mats.ice.roughness, p.oceanSoftness],
    uBiomeReflectanceA: [mats.deepOcean.reflectance, mats.ocean.reflectance, mats.beach.reflectance, mats.plains.reflectance],
    uBiomeReflectanceB: [mats.hills.reflectance, mats.mountains.reflectance, mats.ice.reflectance, 1],
    uBiomeOceanSoftness: p.oceanSoftness,
    uBiomeDeepOceanColor: c.deepOcean,
    uBiomeOceanColor: c.ocean,
    uBiomeBeachColor: c.beach,
    uBiomePlainsColor: c.plains,
    uBiomeHillsColor: c.hills,
    uBiomeRockColor: c.mountains,
    uBiomeIceColor: c.ice,
    uBiomeTintStrength: clamp01(options.tintStrength ?? 0.42),
  };
}

/* ========================================================================== */
/*  3. Nuvens volumétricas multicamadas                                       */
/* ========================================================================== */

/** Número fixo de decks suportado pelo shader (arrays de uniform). */
export const CLOUD_LAYER_COUNT = 3;

/** Valores padrão de uma camada de nuvens (altitudes em metros). */
export const CLOUD_LAYER_DEFAULTS = Object.freeze({
  base: 1200,
  top: 6000,
  coverage: 0.55,
  scale: 2.4,
  density: 1,
  speed: 1,
  billow: 0.35,
  seed: 0,
});

/** Valores padrão do "deck" (massa total de nuvens) e da iluminação. */
export const CLOUD_DECK_DEFAULTS = Object.freeze({
  baseAltitude: 600,
  topAltitude: 14000,
  coverage: 0.55,
  scale: 2.4,
  density: 1,
  extinction: 6,
  scattering: 1,
  phaseG: 0.55,
  phaseBack: -0.22,
  phaseMix: 0.35,
  powder: 0.6,
  lightAbsorption: 6,
  altitudeFalloff: 0.55,
  lightMarchDistance: 0.6,
  warp: 0.45,
  windDirection: [1, 0, 0.25],
  windSpeed: 0.012,
  color: '#ffffff',
  shadeColor: '#c3d8ec',
  ambientIntensity: 0.35,
});

/**
 * Presets de nuvens. Altitudes em metros, calibradas para a Terra, mas
 * utilizáveis em qualquer corpo (o deck é reescalado se `baseAltitude` /
 * `topAltitude` forem informados).
 */
export const CLOUD_PRESETS = Object.freeze({
  earthlike: Object.freeze([
    Object.freeze({ base: 900, top: 4200, coverage: 0.52, scale: 2.3, density: 1.0, speed: 1.0, billow: 0.45, seed: 0.0 }),
    Object.freeze({ base: 3600, top: 8200, coverage: 0.36, scale: 1.7, density: 0.65, speed: 1.35, billow: 0.25, seed: 4.7 }),
    Object.freeze({ base: 7600, top: 13500, coverage: 0.22, scale: 1.15, density: 0.35, speed: 1.9, billow: 0.08, seed: 9.3 }),
  ]),
  cumulus: Object.freeze([
    Object.freeze({ base: 900, top: 4600, coverage: 0.5, scale: 2.6, density: 1.15, speed: 1.0, billow: 0.55, seed: 1.2 }),
  ]),
  stratus: Object.freeze([
    Object.freeze({ base: 600, top: 3200, coverage: 0.74, scale: 1.5, density: 0.95, speed: 0.7, billow: 0.18, seed: 2.4 }),
    Object.freeze({ base: 2800, top: 6200, coverage: 0.42, scale: 2.2, density: 0.45, speed: 1.1, billow: 0.1, seed: 6.1 }),
  ]),
  cirrus: Object.freeze([
    Object.freeze({ base: 6500, top: 12000, coverage: 0.38, scale: 1.1, density: 0.55, speed: 2.2, billow: 0.05, seed: 3.8 }),
    Object.freeze({ base: 10500, top: 15000, coverage: 0.24, scale: 0.8, density: 0.3, speed: 2.8, billow: 0.02, seed: 8.2 }),
  ]),
  storm: Object.freeze([
    Object.freeze({ base: 800, top: 7800, coverage: 0.82, scale: 2.0, density: 1.8, speed: 1.4, billow: 0.65, seed: 5.5 }),
    Object.freeze({ base: 6500, top: 14500, coverage: 0.55, scale: 1.2, density: 0.9, speed: 1.9, billow: 0.2, seed: 11.7 }),
  ]),
  venus: Object.freeze([
    Object.freeze({ base: 18000, top: 46000, coverage: 0.94, scale: 1.4, density: 1.6, speed: 0.35, billow: 0.2, seed: 2.9 }),
    Object.freeze({ base: 42000, top: 68000, coverage: 0.78, scale: 2.1, density: 0.8, speed: 0.7, billow: 0.1, seed: 7.6 }),
  ]),
  titan: Object.freeze([
    Object.freeze({ base: 12000, top: 42000, coverage: 0.9, scale: 1.6, density: 1.4, speed: 0.5, billow: 0.2, seed: 4.1 }),
    Object.freeze({ base: 38000, top: 80000, coverage: 0.7, scale: 2.2, density: 0.7, speed: 0.9, billow: 0.12, seed: 9.8 }),
  ]),
  gasGiant: Object.freeze([
    Object.freeze({ base: 4000, top: 24000, coverage: 0.45, scale: 1.2, density: 0.5, speed: 2.4, billow: 0.05, seed: 1.7 }),
    Object.freeze({ base: 20000, top: 52000, coverage: 0.34, scale: 1.6, density: 0.4, speed: 3.1, billow: 0.03, seed: 6.6 }),
    Object.freeze({ base: 48000, top: 90000, coverage: 0.22, scale: 2.0, density: 0.25, speed: 3.8, billow: 0.02, seed: 12.3 }),
  ]),
  none: Object.freeze([]),
});

/** Nomes alternativos aceitos por `resolveCloudLayers`. */
const CLOUD_PRESET_ALIASES = Object.freeze({
  earth: 'earthlike',
  terra: 'earthlike',
  gasgiant: 'gasGiant',
  gigante: 'gasGiant',
  nublado: 'storm',
  tempestade: 'storm',
});

/**
 * Normaliza uma camada de nuvens (aceita base/top em metros).
 * @param {object} layer
 * @param {number} [index=0] usado como semente padrão
 * @returns {{base:number,top:number,coverage:number,scale:number,density:number,speed:number,billow:number,seed:number}}
 */
export function normalizeCloudLayer(layer = {}, index = 0) {
  const base = Math.max(0, Number.isFinite(layer.base ?? layer.baseAltitude) ? (layer.base ?? layer.baseAltitude) : 1000);
  const topRaw = Number.isFinite(layer.top ?? layer.topAltitude) ? (layer.top ?? layer.topAltitude) : base + 4000;
  const top = Math.max(base + 50, topRaw);
  return {
    base,
    top,
    coverage: clamp01(layer.coverage ?? 0.5),
    scale: clamp(layer.scale ?? 2.2, 0.05, 40),
    density: clamp(layer.density ?? layer.opacity ?? 1, 0, 8),
    speed: clamp(layer.speed ?? 1, -8, 8),
    billow: clamp01(layer.billow ?? 0.3),
    seed: Number.isFinite(layer.seed) ? layer.seed : index * 4.37,
  };
}

/**
 * Normaliza o deck completo (limites, vento, iluminação e cores).
 * @param {object} [deck]
 * @param {Array} [layers] camadas usadas para inferir base/topo
 */
export function normalizeCloudDeck(deck = {}, layers = []) {
  const raw = deck ?? {};
  const d = { ...CLOUD_DECK_DEFAULTS, ...raw };
  const bases = layers.map((layer) => layer.base);
  const tops = layers.map((layer) => layer.top);
  const inferredBase = bases.length ? Math.max(0, Math.min(...bases) - 200) : CLOUD_DECK_DEFAULTS.baseAltitude;
  const baseAltitude = Math.max(0, Number.isFinite(raw.baseAltitude) ? raw.baseAltitude : inferredBase);
  const inferredTop = tops.length
    ? Math.max(...tops) + 400
    : Math.max(baseAltitude + 12000, CLOUD_DECK_DEFAULTS.topAltitude);
  const topAltitude = Math.max(
    baseAltitude + 100,
    Number.isFinite(raw.topAltitude) ? raw.topAltitude : inferredTop,
  );
  const wind = Array.isArray(d.windDirection) ? d.windDirection : [1, 0, 0.25];
  const wind3 = normalize3([wind[0] ?? 1, wind[1] ?? 0, wind[2] ?? 0.25]);
  return {
    baseAltitude,
    topAltitude,
    coverage: clamp01(d.coverage ?? 0.55),
    scale: clamp(d.scale ?? 2.4, 0.05, 40),
    density: clamp(d.density ?? 1, 0, 8),
    extinction: clamp(d.extinction ?? 6, 0.05, 64),
    scattering: clamp(d.scattering ?? 1, 0, 8),
    phaseG: clamp(d.phaseG ?? 0.55, -0.95, 0.95),
    phaseBack: clamp(d.phaseBack ?? -0.22, -0.95, 0.95),
    phaseMix: clamp01(d.phaseMix ?? 0.35),
    powder: clamp01(d.powder ?? 0.6),
    lightAbsorption: clamp(d.lightAbsorption ?? 6, 0, 64),
    altitudeFalloff: clamp01(d.altitudeFalloff ?? 0.55),
    lightMarchDistance: clamp(d.lightMarchDistance ?? 0.6, 0.05, 2),
    warp: clamp(d.warp ?? 0.45, 0, 2),
    windDirection: wind3,
    windSpeed: clamp(d.windSpeed ?? 0.012, -0.5, 0.5),
    color: d.color ?? '#ffffff',
    shadeColor: d.shadeColor ?? '#c3d8ec',
    ambientIntensity: clamp(d.ambientIntensity ?? 0.35, 0, 4),
  };
}

/** @private Converte a config de nuvens de sprites.js em decks físicos. */
function layersFromSpriteClouds(clouds, options = {}) {
  const coverage = clamp01(clouds.coverage ?? 0.5);
  const opacity = clamp01(clouds.opacity ?? 0.9);
  const scale = clamp(clouds.scale ?? 2.4, 0.1, 20);
  const banding = clamp01(clouds.banding ?? 0.3);
  const baseAlt = Math.max(0, options.baseAltitude ?? 700);
  const topAlt = Math.max(baseAlt + 1000, options.topAltitude ?? 14000);
  const span = topAlt - baseAlt;
  return [
    { base: baseAlt + span * 0.04, top: baseAlt + span * 0.34, coverage: coverage * 1.05, scale: scale * 1.1, density: opacity, speed: 1.0, billow: 0.3 + banding * 0.4, seed: 0.0 },
    { base: baseAlt + span * 0.28, top: baseAlt + span * 0.65, coverage: coverage * 0.78, scale: scale * 0.8, density: opacity * 0.62, speed: 1.35, billow: 0.2 + banding * 0.2, seed: 4.7 },
    { base: baseAlt + span * 0.58, top: baseAlt + span * 0.98, coverage: coverage * 0.5, scale: scale * 0.55, density: opacity * 0.32, speed: 1.8, billow: 0.08, seed: 9.3 },
  ].map((layer) => normalizeCloudLayer(layer, layer.seed));
}

/**
 * Resolve camadas a partir de: nome de preset, array de camadas, objeto com
 * `layers`, configuração de nuvens de sprites (`{coverage, scale, ...}`) ou
 * preset de planeta (`{clouds: {...}}`).
 *
 * @param {string|object|Array} [input]
 * @param {object} [options]
 * @returns {{layers:Array, deck:object, colors:{lit:number[],shade:number[]}}}
 */
export function resolveCloudLayers(input = 'earthlike', options = {}) {
  let source = input;
  let colorsFromSource = null;

  if (source && typeof source === 'object' && !Array.isArray(source)) {
    if (source.clouds !== undefined && !source.layers) source = source.clouds ?? [];
    colorsFromSource = source.color ? { color: source.color, shade: source.shade ?? source.shadeColor } : null;
  }

  let rawLayers;
  if (Array.isArray(source)) rawLayers = source;
  else if (typeof source === 'string') {
    const key = source.trim();
    rawLayers = CLOUD_PRESETS[key]
      ?? CLOUD_PRESETS[key.toLowerCase()]
      ?? CLOUD_PRESETS[CLOUD_PRESET_ALIASES[key.toLowerCase()]]
      ?? CLOUD_PRESETS.earthlike;
  }
  else if (source && Array.isArray(source.layers)) rawLayers = source.layers;
  else if (source && (source.coverage !== undefined || source.scale !== undefined)) rawLayers = layersFromSpriteClouds(source, options);
  else rawLayers = CLOUD_PRESETS.earthlike;

  const active = rawLayers.slice(0, CLOUD_LAYER_COUNT).map((layer, i) => normalizeCloudLayer(layer, i));
  const baseFallback = options.baseAltitude ?? CLOUD_DECK_DEFAULTS.baseAltitude;
  const topFallback = options.topAltitude ?? CLOUD_DECK_DEFAULTS.topAltitude;
  const layers = active.slice();
  while (layers.length < CLOUD_LAYER_COUNT) {
    layers.push(normalizeCloudLayer({
      base: baseFallback,
      top: topFallback,
      density: 0,
      coverage: 0,
      seed: 20 + layers.length,
    }, layers.length));
  }

  const deck = normalizeCloudDeck(
    {
      ...options,
      color: options.color ?? source?.color ?? CLOUD_DECK_DEFAULTS.color,
      shadeColor: options.shadeColor ?? source?.shade ?? colorsFromSource?.shade ?? CLOUD_DECK_DEFAULTS.shadeColor,
      warp: options.warp ?? source?.warp ?? CLOUD_DECK_DEFAULTS.warp,
      coverage: options.coverage ?? source?.coverage ?? CLOUD_DECK_DEFAULTS.coverage,
    },
    active,
  );

  return {
    layers,
    deck,
    colors: {
      lit: colorToLinear(deck.color, [0, 0, 0]),
      shade: colorToLinear(deck.shadeColor, [0, 0, 0]),
    },
  };
}

/**
 * Perfil de densidade de uma camada numa altitude física (metros).
 * Espelha a janela de altitude usada no shader.
 *
 * @param {number} altitude metros
 * @param {object} layer camada normalizada
 * @param {object} deck deck normalizado
 * @returns {number} 0..densidade da camada
 */
export function cloudLayerDensity(altitude, layer, deck) {
  const span = Math.max(deck.topAltitude - deck.baseAltitude, EPSILON);
  const h = clamp01((altitude - deck.baseAltitude) / span);
  const a = clamp01((layer.base - deck.baseAltitude) / span);
  const b = clamp01((layer.top - deck.baseAltitude) / span);
  const local = (h - a) / Math.max(b - a, EPSILON);
  if (local <= 0 || local >= 1) return 0;
  const window = smoothstep(0, 0.18, local) * (1 - smoothstep(0.72, 1, local));
  return window * layer.density;
}

/**
 * Densidade relativa total (soma dos decks) para uma altitude física.
 * @param {number} altitude metros
 * @param {Array} layers
 * @param {object} deck
 */
export function cloudDensityProfile(altitude, layers, deck) {
  let total = 0;
  for (const layer of layers) total += cloudLayerDensity(altitude, layer, deck);
  return total;
}

/** Fase de Henyey-Greenstein normalizada (4π). */
export function henyeyGreenstein(cosTheta, g = 0.5) {
  const gg = clamp(g, -0.99, 0.99);
  const g2 = gg * gg;
  const denom = 1 + g2 - 2 * gg * clamp(cosTheta, -1, 1);
  return (1 - g2) / (4 * PI * Math.max(denom, EPSILON) ** 1.5);
}

/** Fase dupla das nuvens (lobo frontal + lobo traseiro). */
export function cloudPhase(cosTheta, g = 0.55, backG = -0.22, mix = 0.35) {
  const forward = henyeyGreenstein(cosTheta, g);
  const back = henyeyGreenstein(cosTheta, backG);
  return lerp(forward, back, clamp01(mix));
}

/** Transmitância de Beer–Lambert. */
export const beerLambert = (opticalDepth) => Math.exp(-Math.max(0, opticalDepth));

/**
 * Converte camadas + deck + raios planetários em uniformes GPU.
 *
 * @param {Array} layers camadas normalizadas
 * @param {object} deck deck normalizado
 * @param {object} [options]
 * @param {number} [options.planetRadius=6.371e6] raio em metros
 * @param {number} [options.metersPerUnit=1] metros por unidade de cena
 * @param {number[]} [options.colors] cores lineares {lit, shade}
 * @param {number[]} [options.center=[0,0,0]] centro do planeta em unidades de cena
 * @param {number} [options.time=0] tempo inicial
 * @param {number} [options.sunDirection] direção normalizada
 * @param {number[]} [options.sunColor=[1,1,1]]
 * @param {number} [options.sunIntensity=3]
 * @returns {{uniforms:object, layers:Array, deck:object, radii:object}}
 */
export function buildCloudUniforms(layers, deck, options = {}) {
  const mpu = Math.max(options.metersPerUnit ?? 1, EPSILON);
  const planetRadiusMeters = Math.max(options.planetRadius ?? 6.371e6, 1);
  const span = Math.max(deck.topAltitude - deck.baseAltitude, 1);
  const A = new Float32Array(CLOUD_LAYER_COUNT * 4);
  const B = new Float32Array(CLOUD_LAYER_COUNT * 4);
  for (let i = 0; i < CLOUD_LAYER_COUNT; i++) {
    const layer = layers[i] ?? normalizeCloudLayer({ density: 0 }, i);
    const a = clamp01((layer.base - deck.baseAltitude) / span);
    const b = Math.max(a + 0.01, clamp01((layer.top - deck.baseAltitude) / span));
    A[i * 4] = a;
    A[i * 4 + 1] = Math.min(1, b);
    A[i * 4 + 2] = layer.coverage;
    A[i * 4 + 3] = layer.scale;
    B[i * 4] = layer.density;
    B[i * 4 + 1] = layer.seed;
    B[i * 4 + 2] = layer.speed;
    B[i * 4 + 3] = layer.billow;
  }
  const baseRadius = (planetRadiusMeters + deck.baseAltitude) / mpu;
  const topRadius = (planetRadiusMeters + deck.topAltitude) / mpu;
  const center = options.center ?? [0, 0, 0];
  const colors = options.colors ?? {
    lit: colorToLinear(deck.color, [0, 0, 0]),
    shade: colorToLinear(deck.shadeColor, [0, 0, 0]),
  };
  const wind = deck.windDirection ?? [1, 0, 0.25];
  const uniforms = {
    uPlanetCenter: center,
    uPlanetRadius: planetRadiusMeters / mpu,
    uCloudBaseRadius: baseRadius,
    uCloudTopRadius: topRadius,
    uCloudLayerA: A,
    uCloudLayerB: B,
    uCloudColor: colors.lit,
    uCloudShadeColor: colors.shade,
    uCloudWind: [wind[0] * deck.windSpeed, wind[1] * deck.windSpeed, wind[2] * deck.windSpeed],
    uCloudWarp: deck.warp,
    uDensityScale: deck.density,
    uExtinction: deck.extinction,
    uScattering: deck.scattering,
    uPhaseG: deck.phaseG,
    uPhaseBack: deck.phaseBack,
    uPhaseMix: deck.phaseMix,
    uPowderStrength: deck.powder,
    uLightAbsorption: deck.lightAbsorption,
    uAltitudeFalloff: deck.altitudeFalloff,
    uLightMarchDistance: deck.lightMarchDistance,
    uAmbientIntensity: deck.ambientIntensity,
    uTime: options.time ?? 0,
    uSunDirection: options.sunDirection ?? normalize3([1, 0.25, 0.4]),
    uSunColor: options.sunColor ?? [1, 1, 1],
    uSunIntensity: options.sunIntensity ?? 3,
    uSkyColor: options.skyColor ?? [0.35, 0.5, 0.8],
    uGroundColor: options.groundColor ?? [0.08, 0.07, 0.06],
    uExposure: options.exposure ?? 1,
    uInsideShell: 0,
  };
  return { uniforms, layers, deck, radii: { base: baseRadius, top: topRadius, planet: planetRadiusMeters / mpu } };
}

/* ========================================================================== */
/*  4. Atmosfera — ponte com atmosphere.js                                    */
/* ========================================================================== */

/** Coeficientes de Rayleigh de referência (m⁻¹), Terra ao nível do mar. */
export const DEFAULT_RAYLEIGH_COEFF = Object.freeze([5.8e-6, 13.5e-6, 33.1e-6]);
/** Coeficiente de Mie de referência (m⁻¹). */
export const DEFAULT_MIE_COEFF = Object.freeze([2.1e-5, 2.1e-5, 2.1e-5]);

/** Parâmetros visuais padrão de atmosfera. */
export const ATMOSPHERE_DEFAULTS = Object.freeze({
  planetRadius: 6.371e6,
  topAltitude: 1e5,
  scaleHeight: 8500,
  mieScaleHeight: 1200,
  mieG: 0.76,
  rayleigh: DEFAULT_RAYLEIGH_COEFF,
  mie: DEFAULT_MIE_COEFF,
  metersPerUnit: 1,
});

/** @private Lê um RGB de um estado (typed array, objeto `{rgb}` ou array). */
function readRGB(value, fallback) {
  if (!value) return [...fallback];
  const rgb = value.rgb ?? value.color ?? value;
  if (Array.isArray(rgb) || ArrayBuffer.isView(rgb)) {
    return [Number(rgb[0]) || 0, Number(rgb[1]) || 0, Number(rgb[2]) || 0];
  }
  return [...fallback];
}

/**
 * Converte um estado de `atmosphere.js` (saída de `calculateAtmosphere` com
 * `scattering: true`, ou o modelo) em uniformes do programa `atmosphere`.
 * Coeficientes permanecem em SI (m⁻¹); o shader converte com `uMetersPerUnit`.
 *
 * @param {object} state estado atmosférico / `AtmosphereModel`
 * @param {object} [options]
 * @param {number} [options.planetRadius] metros (sobrepõe o estado)
 * @param {number} [options.metersPerUnit=1]
 * @param {number} [options.topAltitude] metros
 * @param {number[]} [options.center=[0,0,0]] centro em unidades de cena
 * @param {number[]} [options.sunDirection]
 * @param {number[]} [options.sunColor]
 * @param {number} [options.sunIntensity=4]
 * @param {number} [options.exposure=1]
 * @param {number} [options.scatteringStrength=1]
 * @param {number} [options.mieBoost=0.6]
 * @returns {object} uniformes + metadados
 */
export function atmosphereUniforms(state = null, options = {}) {
  const model = state?.model ?? state ?? {};
  const mpu = Math.max(options.metersPerUnit ?? 1, EPSILON);
  const planetRadius = Math.max(
    1,
    options.planetRadius ?? options.body?.radius ?? state?.planetRadius ?? model.planetRadius ?? ATMOSPHERE_DEFAULTS.planetRadius,
  );
  const topAltitude = Math.max(
    100,
    options.topAltitude ?? state?.topAltitude ?? model.topAltitude ?? ATMOSPHERE_DEFAULTS.topAltitude,
  );
  const scaleHeight = Math.max(
    100,
    state?.scaleHeight ?? model.scaleHeight ?? ATMOSPHERE_DEFAULTS.scaleHeight,
  );
  const mieState = state?.mie ?? null;
  const mieScaleHeight = Math.max(
    50,
    options.mieScaleHeight ?? mieState?.scaleHeight ?? model.mie?.scaleHeight ?? ATMOSPHERE_DEFAULTS.mieScaleHeight,
  );
  const mieG = clamp(
    options.mieG ?? mieState?.anisotropy ?? model.mie?.anisotropy ?? ATMOSPHERE_DEFAULTS.mieG,
    -0.9, 0.95,
  );
  /*
   * O shader aplica a queda exponencial com as scale heights. Portanto os
   * uniformes precisam dos coeficientes de REFERÊNCIA (superfície) — o estado
   * em 120 km, por exemplo, já vem atenuado e tornaria a atmosfera invisível.
   */
  const referenceRayleigh = readRGB(model.rayleighRef, DEFAULT_RAYLEIGH_COEFF);
  const mieSurface = Number.isFinite(model.mie?.surfaceCoefficient)
    ? model.mie.surfaceCoefficient
    : null;
  const referenceMie = mieSurface !== null
    ? [mieSurface, mieSurface, mieSurface]
    : DEFAULT_MIE_COEFF;
  const stateAltitude = Number.isFinite(state?.altitude) ? state.altitude : 0;
  const useStateCoeffs = !!state?.rayleigh && stateAltitude <= 1000;
  const rayleighCoeff = options.rayleigh
    ?? (useStateCoeffs ? readRGB(state.rayleigh, referenceRayleigh) : referenceRayleigh);
  const mieCoeff = options.mie
    ?? (useStateCoeffs ? readRGB(mieState, referenceMie) : referenceMie);
  const density = state?.density ?? null;

  const uniforms = {
    uPlanetCenter: options.center ?? [0, 0, 0],
    uPlanetRadius: planetRadius / mpu,
    uAtmosphereRadius: (planetRadius + topAltitude) / mpu,
    uMetersPerUnit: mpu,
    uRayleighCoeff: rayleighCoeff,
    uMieCoeff: mieCoeff,
    uRayleighScaleHeight: scaleHeight,
    uMieScaleHeight: mieScaleHeight,
    uMieG: mieG,
    uScatteringStrength: options.scatteringStrength ?? 1,
    uMieBoost: options.mieBoost ?? 0.6,
    uSunDirection: options.sunDirection ?? normalize3([1, 0.25, 0.4]),
    uSunColor: options.sunColor ?? [1, 1, 1],
    uSunIntensity: options.sunIntensity ?? 4,
    uExposure: options.exposure ?? 1,
    uInsideShell: 0,
    uTime: options.time ?? 0,
  };
  return {
    uniforms,
    meta: {
      planetRadius, topAltitude, scaleHeight, mieScaleHeight, mieG,
      rayleighCoeff, mieCoeff, density, metersPerUnit: mpu,
      atmosphereScale: (planetRadius + topAltitude) / planetRadius,
    },
  };
}

/**
 * Deriva a base/topo físicos de um deck de nuvens a partir do estado
 * atmosférico (tropopausa aproximada e escala de altura).
 *
 * @param {object} state saída de `calculateAtmosphere`
 * @param {object} [options]
 * @returns {{baseAltitude:number, topAltitude:number}}
 */
export function cloudDeckFromAtmosphere(state = null, options = {}) {
  const model = state?.model ?? state ?? {};
  const H = Math.max(500, state?.scaleHeight ?? model.scaleHeight ?? ATMOSPHERE_DEFAULTS.scaleHeight);
  const baseAltitude = Math.max(100, options.baseAltitude ?? H * 0.12);
  const topAltitude = Math.max(
    baseAltitude + 1000,
    options.topAltitude ?? Math.min(model.topAltitude ?? Infinity, H * 1.65),
  );
  return { baseAltitude, topAltitude };
}

/**
 * Extrai parâmetros visuais da telemetria de `atmosphere.js`
 * (`AtmosphereSystem#getTelemetry`) para materiais de nave (calor, plasma).
 *
 * @param {object} telemetry
 * @param {object} [options]
 * @returns {{altitude:number,density:number,pressure:number,temperature:number,mach:number,heatFlux:number,hullTemperature:number,reentry:boolean,heatGlow:number}}
 */
export function atmosphereFromTelemetry(telemetry = null, options = {}) {
  const t = telemetry ?? {};
  const hull = Number.isFinite(t.hullTemperature) ? t.hullTemperature : (options.temperature ?? 293.15);
  const heatFlux = Number.isFinite(t.heatFlux) ? t.heatFlux : 0;
  const reference = Math.max(1, options.referenceHeatFlux ?? 1.2e6);
  const heatGlow = clamp01(
    Math.max(
      (hull - (options.heatThreshold ?? 700)) / Math.max(1, (options.heatRange ?? 1800)),
      heatFlux / reference,
    ),
  );
  return {
    altitude: t.altitude ?? 0,
    density: t.density ?? 0,
    pressure: t.pressure ?? 0,
    temperature: t.airTemperature ?? t.temperature ?? options.temperature ?? 293.15,
    mach: t.mach ?? 0,
    heatFlux,
    hullTemperature: hull,
    reentry: !!t.reentry || (t.inAtmosphere && heatFlux > reference * 0.1),
    heatGlow,
  };
}

/* ========================================================================== */
/*  5. Materiais PBR prontos                                                  */
/* ========================================================================== */

/**
 * Presets de materiais para naves e superfícies. Cores em sRGB (convertidas
 * para linear nas fábricas); `metallic`, `roughness` e `reflectance` seguem a
 * convenção Cook-Torrance do módulo.
 */
export const PBR_MATERIALS = Object.freeze({
  hullWhite: Object.freeze({
    label: 'Casco branco (tinta cerâmica)', baseColor: '#e9edf2', metallic: 0.08,
    roughness: 0.42, reflectance: 0.5, panelColor: '#b9c2cc', panelScale: 10,
    emissive: '#000000', emissiveIntensity: 0,
  }),
  bareMetal: Object.freeze({
    label: 'Alumínio nu', baseColor: '#c9d2dc', metallic: 1, roughness: 0.28,
    reflectance: 0.6, panelColor: '#a9b5c3', panelScale: 14,
    emissive: '#000000', emissiveIntensity: 0,
  }),
  goldFoil: Object.freeze({
    label: 'Manta térmica dourada', baseColor: '#e0b64f', metallic: 1, roughness: 0.34,
    reflectance: 0.6, panelColor: '#b0842c', panelScale: 22,
    emissive: '#000000', emissiveIntensity: 0,
  }),
  solarPanel: Object.freeze({
    label: 'Painel solar', baseColor: '#12275c', metallic: 0.35, roughness: 0.18,
    reflectance: 0.65, panelColor: '#2b4b9c', panelScale: 20,
    emissive: '#0a1630', emissiveIntensity: 0.08,
  }),
  heatShield: Object.freeze({
    label: 'Escudo térmico (ablativo)', baseColor: '#2b2320', metallic: 0.04, roughness: 0.82,
    reflectance: 0.2, panelColor: '#3b2d28', panelScale: 8,
    emissive: '#000000', emissiveIntensity: 0,
  }),
  ceramic: Object.freeze({
    label: 'Cerâmica branca', baseColor: '#f2f5f7', metallic: 0, roughness: 0.35,
    reflectance: 0.55, panelColor: '#d5dde3', panelScale: 12,
    emissive: '#000000', emissiveIntensity: 0,
  }),
  glass: Object.freeze({
    label: 'Janela/vidro', baseColor: '#8fd8ff', metallic: 0, roughness: 0.06,
    reflectance: 1, panelColor: '#5aa8d8', panelScale: 26,
    emissive: '#123a52', emissiveIntensity: 0.15, alpha: 0.35,
  }),
  engineBell: Object.freeze({
    label: 'Tubeira (liga refratária)', baseColor: '#454b54', metallic: 0.9, roughness: 0.38,
    reflectance: 0.55, panelColor: '#2b3139', panelScale: 16,
    emissive: '#000000', emissiveIntensity: 0,
  }),
  planetOcean: Object.freeze({
    label: 'Oceano (dielétrico polido)', baseColor: '#0e4f6e', metallic: 0, roughness: 0.08,
    reflectance: 0.6, panelColor: '#0e4f6e', panelScale: 1,
    emissive: '#000000', emissiveIntensity: 0,
  }),
  planetIce: Object.freeze({
    label: 'Gelo/neve', baseColor: '#e8f3ff', metallic: 0, roughness: 0.2,
    reflectance: 0.52, panelColor: '#e8f3ff', panelScale: 1,
    emissive: '#000000', emissiveIntensity: 0,
  }),
});

/** Alias semântico de `PBR_MATERIALS`. */
export const MATERIAL_PRESETS = PBR_MATERIALS;

/* ========================================================================== */
/*  6. Biblioteca GLSL — chunks reutilizáveis                                 */
/* ========================================================================== */
/*
 * Todos os chunks são GLSL ES 1.00 puro: sem `#version`, sem extensões, sem
 * derivadas (`dFdx/dFdy`) e sem texturas de lookup para ruído. Isso garante
 * compatibilidade com WebGL 1 em qualquer driver e permite a atualização
 * automática para GLSL ES 3.00 (`upgradeShaderSource`).
 */

/** Utilitários comuns: constantes, saturação, cores, tonemap, interseção. */
export const GLSL_COMMON = `
#ifndef SHADER_PI
#define SHADER_PI 3.141592653589793
#endif
#ifndef SHADER_TAU
#define SHADER_TAU 6.283185307179586
#endif
#ifndef SHADER_INV_PI
#define SHADER_INV_PI 0.3183098861837907
#endif

float saturate(float x) { return clamp(x, 0.0, 1.0); }
float sqr(float x) { return x * x; }
float pow5(float x) { float x2 = x * x; return x2 * x2 * x; }
vec3 pow5(vec3 x) { return x * x * x * x * x; }
float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float safeDiv(float a, float b) { return a / (abs(b) < 1e-6 ? (b < 0.0 ? -1e-6 : 1e-6) : b); }
vec3 safeNormalize(vec3 v, vec3 fallback) { float l = length(v); return l > 1e-6 ? v / l : fallback; }
float remap(float v, float a, float b, float c, float d) {
  return c + (d - c) * saturate((v - a) / max(b - a, 1e-6));
}

/* ------------------------------- hashes --------------------------------- */

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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

/* -------------------------------- cores --------------------------------- */

float srgbToLinear(float c) {
  float x = saturate(c);
  return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4);
}
vec3 srgbToLinear(vec3 c) {
  return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}
float linearToSrgb(float c) {
  float x = saturate(c);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 0.4166666667) - 0.055;
}
vec3 linearToSrgb(vec3 c) {
  return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
}
vec3 tonemapACES(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  vec3 v = max(x, 0.0);
  return clamp((v * (a * v + b)) / (v * (c * v + d) + e), 0.0, 1.0);
}
vec3 tonemapAndEncode(vec3 color, float exposure) {
  return linearToSrgb(tonemapACES(max(color, vec3(0.0)) * max(exposure, 0.0)));
}

/* ----------------------------- geometria -------------------------------- */

vec2 raySphere(vec3 ro, vec3 rd, vec3 center, float radius) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e20, -1e20);
  float s = sqrt(h);
  return vec2(-b - s, -b + s);
}

/* ------------------------------- fases ---------------------------------- */

float henyeyGreenstein(float cosTheta, float g) {
  float gg = clamp(g, -0.95, 0.95);
  float g2 = gg * gg;
  float denom = max(1.0 + g2 - 2.0 * gg * cosTheta, 1e-4);
  return (1.0 - g2) / (4.0 * SHADER_PI * pow(denom, 1.5));
}
float cloudPhaseFunction(float cosTheta, float g, float backG, float mixWeight) {
  return mix(henyeyGreenstein(cosTheta, g), henyeyGreenstein(cosTheta, backG), saturate(mixWeight));
}
float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * SHADER_PI)) * (1.0 + cosTheta * cosTheta);
}
`;

/** Ruído 3D: Simplex (Ashima), Perlin por hash, fBm, ridged e Worley. */
export const GLSL_NOISE = `
#ifndef CLOUD_FBM_OCTAVES
#define CLOUD_FBM_OCTAVES 4
#endif
#ifndef CLOUD_LIGHT_OCTAVES
#define CLOUD_LIGHT_OCTAVES 2
#endif
#ifndef RIDGED_OCTAVES
#define RIDGED_OCTAVES 3
#endif
#ifndef PERLIN_OCTAVES
#define PERLIN_OCTAVES 4
#endif

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

/* Simplex noise 3D (Ken Perlin / Ashima Arts, domínio público). */
float snoise3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/* Perlin 3D por gradientes de hash, interpolação quíntica. */
float perlin3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  vec3 g000 = hash33(i + vec3(0.0, 0.0, 0.0)) * 2.0 - 1.0;
  vec3 g100 = hash33(i + vec3(1.0, 0.0, 0.0)) * 2.0 - 1.0;
  vec3 g010 = hash33(i + vec3(0.0, 1.0, 0.0)) * 2.0 - 1.0;
  vec3 g110 = hash33(i + vec3(1.0, 1.0, 0.0)) * 2.0 - 1.0;
  vec3 g001 = hash33(i + vec3(0.0, 0.0, 1.0)) * 2.0 - 1.0;
  vec3 g101 = hash33(i + vec3(1.0, 0.0, 1.0)) * 2.0 - 1.0;
  vec3 g011 = hash33(i + vec3(0.0, 1.0, 1.0)) * 2.0 - 1.0;
  vec3 g111 = hash33(i + vec3(1.0, 1.0, 1.0)) * 2.0 - 1.0;

  float n000 = dot(g000, f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(g100, f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(g010, f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(g110, f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(g001, f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(g101, f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(g011, f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(g111, f - vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}

/* fBm principal de nuvens (Simplex). Retorna [0,1]. */
float fbmSimplex(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < CLOUD_FBM_OCTAVES; i++) {
    sum += (snoise3(p) * 0.5 + 0.5) * amp;
    norm += amp;
    p = p * 2.03 + vec3(17.1, 9.2, 4.7);
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

/* fBm barato (marcha de luz / domain warp). Retorna [0,1]. */
float fbmLight(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < CLOUD_LIGHT_OCTAVES; i++) {
    sum += (snoise3(p) * 0.5 + 0.5) * amp;
    norm += amp;
    p = p * 2.11 + vec3(7.3, 13.7, 3.1);
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

/* Ruído ridged (cristas) para bordas billowy. Retorna [0,1]. */
float ridgedNoise(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < RIDGED_OCTAVES; i++) {
    float n = 1.0 - abs(snoise3(p));
    sum += n * n * amp;
    norm += amp;
    p = p * 2.07 + vec3(5.3, 1.7, 9.1);
    amp *= 0.55;
  }
  return sum / max(norm, 1e-4);
}

/* fBm de Perlin (detalhe de superfície, calotas, painéis). Retorna [0,1]. */
float fbmPerlin(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < PERLIN_OCTAVES; i++) {
    sum += (perlin3(p) * 0.5 + 0.5) * amp;
    norm += amp;
    p = p * 2.05 + vec3(3.7, 11.3, 6.1);
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

/* Worley/cellular 3D (F1). Disponível para detalhe de erosão de nuvens. */
float worley3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d = 1.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 o = hash33(i + g);
        vec3 r = g + o - f;
        d = min(d, dot(r, r));
      }
    }
  }
  return sqrt(max(d, 0.0));
}
`;

/** PBR Cook-Torrance: GGX, Smith/Schlick-GGX, Fresnel e luz ambiente. */
export const GLSL_PBR = `
struct PbrMaterial {
  vec3 albedo;
  float metallic;
  float roughness;
  float reflectance;
  vec3 emissive;
  float ao;
};

const float PBR_DIELECTRIC_F0 = 0.04;

/* D_GGX / Trowbridge-Reitz. */
float distributionGGX(float NdotH, float roughness) {
  float r = clamp(roughness, 0.02, 1.0);
  float a = r * r;
  float a2 = a * a;
  float nh = saturate(abs(NdotH));
  float denom = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / max(SHADER_PI * denom * denom, 1e-7);
}

/* G1 de Schlick-GGX para luz direta: k = (r + 1)^2 / 8. */
float geometrySchlickGGX(float NdotX, float roughness) {
  float r = clamp(roughness, 0.02, 1.0);
  float k = ((r + 1.0) * (r + 1.0)) / 8.0;
  float n = saturate(NdotX);
  return n / max(n * (1.0 - k) + k, 1e-5);
}

/* Smith completo (view × light). */
float geometrySmith(float NdotV, float NdotL, float roughness) {
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

/* Fresnel-Schlick. */
vec3 fresnelSchlick(float cosTheta, vec3 f0) {
  return f0 + (vec3(1.0) - f0) * pow5(1.0 - saturate(cosTheta));
}

/* Fresnel com saturação de rugosidade (aproximação IBL). */
vec3 fresnelSchlickRoughness(float cosTheta, vec3 f0, float roughness) {
  vec3 maxv = max(vec3(1.0 - roughness), f0);
  return f0 + (maxv - f0) * pow5(1.0 - saturate(cosTheta));
}

/* F0 = mix(dielétrico, albedo, metallic). */
vec3 f0FromMaterial(PbrMaterial m) {
  float dielectric = 0.16 * m.reflectance * m.reflectance;
  return mix(vec3(dielectric), m.albedo, saturate(m.metallic));
}

/* Oclusão especular (Karis) — evita especular em cavidades. */
float specularOcclusion(float NdotV, float ao, float roughness) {
  return saturate(pow(NdotV + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao);
}

/* Cook-Torrance direto para uma luz (radiance já inclui a cor/intensidade). */
vec3 evaluateCookTorrance(PbrMaterial m, vec3 N, vec3 V, vec3 L, vec3 radiance) {
  float NdotL = dot(N, L);
  if (NdotL <= 0.0) return vec3(0.0);

  vec3 H = safeNormalize(V + L, N);
  float NdotV = max(dot(N, V), 1e-4);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);

  float D = distributionGGX(NdotH, m.roughness);
  float G = geometrySmith(NdotV, NdotL, m.roughness);
  vec3 F = fresnelSchlick(VdotH, f0FromMaterial(m));

  vec3 specular = (D * G * F) / max(4.0 * NdotV * NdotL, 1e-4);
  vec3 kd = (vec3(1.0) - F) * (1.0 - saturate(m.metallic));
  vec3 diffuse = kd * m.albedo * SHADER_INV_PI;

  return (diffuse + specular) * radiance * NdotL;
}

/* Luz ambiente hemisférica analítica (céu/solo) com Fresnel por rugosidade. */
vec3 evaluateAmbient(PbrMaterial m, vec3 N, vec3 V, vec3 skyColor, vec3 groundColor, float intensity) {
  float NdotV = max(dot(N, V), 1e-4);
  vec3 F = fresnelSchlickRoughness(NdotV, f0FromMaterial(m), m.roughness);
  vec3 kd = (vec3(1.0) - F) * (1.0 - saturate(m.metallic));

  vec3 irradiance = mix(groundColor, skyColor, saturate(N.y * 0.5 + 0.5)) * intensity;
  vec3 diffuse = kd * m.albedo * irradiance;

  vec3 R = reflect(-V, N);
  vec3 envSpec = mix(groundColor, skyColor, saturate(R.y * 0.5 + 0.5)) * intensity;
  float specFade = mix(0.15, 1.0, 1.0 - m.roughness);
  vec3 specular = F * envSpec * specFade * specularOcclusion(NdotV, m.ao, m.roughness);

  return (diffuse + specular) * m.ao;
}
`;

/** Mistura de biomas por altitude e latitude. */
export const GLSL_BIOMES = `
struct BiomeWeights {
  float deepOcean;
  float ocean;
  float beach;
  float plains;
  float hills;
  float mountains;
  float ice;
};

/*
 * params  = (seaLevel, beachWidth, plainsLine, mountainLine)
 * params2 = (snowLine, polarStart, polarSoftness, iceStrength)
 * polar   = |sin(latitude)|  (mesma coordenada de iceCaps em sprites.js)
 */
BiomeWeights computeBiomeWeights(float altitude, float polar, vec4 params, vec4 params2, float oceanSoftness) {
  BiomeWeights w;

  float h = saturate(altitude);
  float sea = params.x;
  float soft = max(oceanSoftness, 0.0005);

  float ocean = sea > 0.001 ? 1.0 - smoothstep(sea - soft, sea + soft, h) : 0.0;
  float depth = saturate((sea - h) / max(sea, 1e-4));
  float deep = ocean * smoothstep(0.0, 0.4, depth);
  float shallow = max(ocean - deep, 0.0);

  float above = 1.0 - ocean;
  float beachStart = sea + params.y * 0.55;
  float beachEnd = max(sea + params.y, beachStart + 1e-4);
  float beach = above * (1.0 - smoothstep(beachStart, beachEnd, h));
  float inland = max(above - beach, 0.0);

  float mountains = inland * smoothstep(params.w - 0.03, params.w + 0.02, h);
  float plains = inland * (1.0 - smoothstep(params.z - 0.05, params.z + 0.01, h));
  float hills = max(inland - plains - mountains, 0.0);

  float snow = smoothstep(params2.x - 0.025, params2.x + 0.01, h) * (mountains + hills * 0.35);
  float polarMask = smoothstep(params2.y - params2.z, params2.y + params2.z, saturate(polar)) * saturate(params2.w);
  float ice = saturate(1.0 - (1.0 - saturate(snow)) * (1.0 - polarMask));
  float cover = 1.0 - ice;

  w.deepOcean = deep * cover;
  w.ocean = shallow * cover;
  w.beach = beach * cover;
  w.plains = plains * cover;
  w.hills = hills * cover;
  w.mountains = mountains * cover;
  w.ice = ice;

  float total = w.deepOcean + w.ocean + w.beach + w.plains + w.hills + w.mountains + w.ice;
  if (total > 1e-4) {
    w.deepOcean /= total;
    w.ocean /= total;
    w.beach /= total;
    w.plains /= total;
    w.hills /= total;
    w.mountains /= total;
    w.ice /= total;
  } else {
    w.plains = 1.0;
  }
  return w;
}

float biomeRoughness(BiomeWeights w, vec4 roughA, vec4 roughB) {
  return saturate(
    w.deepOcean * roughA.x + w.ocean * roughA.y + w.beach * roughA.z + w.plains * roughA.w
    + w.hills * roughB.x + w.mountains * roughB.y + w.ice * roughB.z
  );
}

float biomeReflectance(BiomeWeights w, vec4 refA, vec4 refB) {
  return saturate(
    w.deepOcean * refA.x + w.ocean * refA.y + w.beach * refA.z + w.plains * refA.w
    + w.hills * refB.x + w.mountains * refB.y + w.ice * refB.z
  );
}

vec3 biomeTint(
  BiomeWeights w,
  vec3 deepColor, vec3 oceanColor, vec3 beachColor, vec3 plainsColor,
  vec3 hillsColor, vec3 rockColor, vec3 iceColor
) {
  return w.deepOcean * deepColor
    + w.ocean * oceanColor
    + w.beach * beachColor
    + w.plains * plainsColor
    + w.hills * hillsColor
    + w.mountains * rockColor
    + w.ice * iceColor;
}
`;

/**
 * Nuvens volumétricas multicamadas. O chunk declara apenas os uniforms que
 * as funções de densidade realmente usam; os demais ficam no fragment shader.
 */
export const GLSL_CLOUDS = `
#ifndef CLOUD_LAYER_COUNT
#define CLOUD_LAYER_COUNT 3
#endif
#ifndef CLOUD_STEPS
#define CLOUD_STEPS 40
#endif
#ifndef CLOUD_LIGHT_STEPS
#define CLOUD_LIGHT_STEPS 3
#endif

uniform vec3 uPlanetCenter;
uniform float uCloudBaseRadius;
uniform float uCloudTopRadius;
uniform vec4 uCloudLayerA[CLOUD_LAYER_COUNT];
uniform vec4 uCloudLayerB[CLOUD_LAYER_COUNT];
uniform vec3 uCloudWind;
uniform float uCloudWarp;
uniform float uDensityScale;
uniform float uLightMarchDistance;

float cloudAltitudeFraction(vec3 p) {
  float span = max(uCloudTopRadius - uCloudBaseRadius, 1e-4);
  return saturate((length(p - uPlanetCenter) - uCloudBaseRadius) / span);
}

/* Domain warp barato: 3 amostras de fBm de baixa oitava. */
vec3 cloudWarpOffset(vec3 q, float t, float amount) {
  float strength = uCloudWarp * amount;
  if (strength <= 0.001) return vec3(0.0);
  float a = fbmLight(q * 0.7 + vec3(0.0, t * 0.006, 0.0));
  float b = fbmLight(q * 0.7 + vec3(5.2, 1.3, t * 0.007));
  float c = fbmLight(q * 0.7 + vec3(9.7, 8.4, t * 0.005));
  return (vec3(a, b, c) - 0.5) * 2.0 * strength;
}

/* Janela de altitude + erosão de cobertura de uma camada. */
float cloudLayerShape(float h, vec4 A, vec4 B, float n) {
  float local = (h - A.x) / max(A.y - A.x, 1e-3);
  if (local <= 0.0 || local >= 1.0) return 0.0;
  float window = smoothstep(0.0, 0.16, local) * (1.0 - smoothstep(0.70, 1.0, local));
  float threshold = 1.0 - A.z;
  float shape = smoothstep(threshold - 0.12, threshold + 0.26, n);
  return shape * window * B.x;
}

/* Densidade completa (view march). */
float cloudDensity(vec3 p, float t, float warpAmount) {
  if (uDensityScale <= 0.0) return 0.0;
  float h = cloudAltitudeFraction(p);
  float span = max(uCloudTopRadius - uCloudBaseRadius, 1e-4);
  vec3 q = (p - uPlanetCenter) / span;
  q += cloudWarpOffset(q, t, warpAmount);

  float total = 0.0;
  for (int i = 0; i < CLOUD_LAYER_COUNT; i++) {
    vec4 A = uCloudLayerA[i];
    vec4 B = uCloudLayerB[i];
    if (B.x <= 0.0001 || A.z <= 0.0001) continue;
    vec3 drift = uCloudWind * (t * B.z);
    vec3 samplePos = q * A.w + vec3(B.y * 7.13, B.y * 3.71, B.y * 5.37) + drift * A.w;
    float n = fbmSimplex(samplePos);
    n = mix(n, ridgedNoise(samplePos * 1.3), B.w);
    total += cloudLayerShape(h, A, B, n);
  }
  return total * uDensityScale;
}

/* Densidade barata (light march): fBm de 2 oitavas, sem ridged. */
float cloudDensityLight(vec3 p, float t) {
  if (uDensityScale <= 0.0) return 0.0;
  float h = cloudAltitudeFraction(p);
  float span = max(uCloudTopRadius - uCloudBaseRadius, 1e-4);
  vec3 q = (p - uPlanetCenter) / span;
  q += cloudWarpOffset(q, t, 0.35);

  float total = 0.0;
  for (int i = 0; i < CLOUD_LAYER_COUNT; i++) {
    vec4 A = uCloudLayerA[i];
    vec4 B = uCloudLayerB[i];
    if (B.x <= 0.0001 || A.z <= 0.0001) continue;
    vec3 drift = uCloudWind * (t * B.z);
    vec3 samplePos = q * A.w + vec3(B.y * 7.13, B.y * 3.71, B.y * 5.37) + drift * A.w;
    float n = fbmLight(samplePos);
    total += cloudLayerShape(h, A, B, n);
  }
  return total * uDensityScale;
}

/*
 * Profundidade óptica até o Sol, medida em fração do deck (adimensional).
 * A atenuação por altitude já está embutida na densidade amostrada acima do
 * ponto; uLightAbsorption converte a profundidade em extinção (Beer).
 */
float cloudLightOpticalDepth(vec3 p, vec3 sunDir, float t) {
  float span = max(uCloudTopRadius - uCloudBaseRadius, 1e-4);
  vec2 hit = raySphere(p, sunDir, uPlanetCenter, uCloudTopRadius);
  float maxDist = clamp(hit.y, 0.0, uLightMarchDistance * span);
  float ds = maxDist / float(CLOUD_LIGHT_STEPS);
  float optical = 0.0;
  for (int i = 0; i < CLOUD_LIGHT_STEPS; i++) {
    vec3 q = p + sunDir * (ds * (float(i) + 0.5));
    optical += cloudDensityLight(q, t) * (ds / span);
  }
  return optical;
}
`;

/** Densidade exponencial e fases da atmosfera (Rayleigh/Mie). */
export const GLSL_ATMOSPHERE = `
#ifndef ATMOSPHERE_STEPS
#define ATMOSPHERE_STEPS 12
#endif
#ifndef ATMOSPHERE_LIGHT_STEPS
#define ATMOSPHERE_LIGHT_STEPS 4
#endif

float atmosphereDensity(float altitudeMeters, float scaleHeight) {
  return exp(-max(altitudeMeters, 0.0) / max(scaleHeight, 1.0));
}
`;

/* -------------------------------------------------------------------------- */
/*  Vertex shaders                                                            */
/* -------------------------------------------------------------------------- */

/** Vertex de superfície (planeta e nave): posição, normal, UV e posição local. */
const VERTEX_SURFACE_BODY = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;

uniform mat4 uModel;
uniform mat4 uViewProjection;
uniform mat3 uNormalMatrix;

varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vLocalPosition;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPosition = world.xyz;
  vWorldNormal = normalize(uNormalMatrix * aNormal);
  vUv = aUv;
  vLocalPosition = aPosition;
  gl_Position = uViewProjection * world;
}
`;

/** Vertex de shell esférico (nuvens e atmosfera). */
const VERTEX_SHELL_BODY = `
attribute vec3 aPosition;

uniform mat4 uModel;
uniform mat4 uViewProjection;

varying vec3 vWorldPosition;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPosition = world.xyz;
  gl_Position = uViewProjection * world;
}
`;

/* -------------------------------------------------------------------------- */
/*  Planet fragment — superfície PBR + biomas                                 */
/* -------------------------------------------------------------------------- */

const PLANET_FRAGMENT_BODY = `
precision highp float;

varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vLocalPosition;

uniform vec3 uCameraPosition;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbientIntensity;
uniform float uExposure;
uniform vec3 uPoleAxis;

uniform float uBodyType;              // 0 terrestre | 1 gigante gasoso
uniform float uGasGiantRoughness;
uniform float uNormalStrength;
uniform float uNormalFlipY;
uniform float uOceanWaveStrength;

uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
uniform sampler2D uSpecularMap;
uniform sampler2D uEmissiveMap;
uniform sampler2D uCloudMap;
uniform sampler2D uHeightMap;
uniform float uHasAlbedoMap;
uniform float uHasNormalMap;
uniform float uHasSpecularMap;
uniform float uHasEmissiveMap;
uniform float uHasCloudMap;
uniform float uHasHeightMap;

uniform vec4 uBiomeParams;            // seaLevel, beachWidth, plainsLine, mountainLine
uniform vec4 uBiomeParams2;           // snowLine, polarStart, polarSoftness, iceStrength
uniform float uBiomeOceanSoftness;
uniform vec4 uBiomeRoughnessA;        // deepOcean, ocean, beach, plains
uniform vec4 uBiomeRoughnessB;        // hills, mountains, ice, (reservado)
uniform vec4 uBiomeReflectanceA;      // deepOcean, ocean, beach, plains
uniform vec4 uBiomeReflectanceB;      // hills, mountains, ice, (reservado)
uniform float uBiomeTintStrength;
uniform vec3 uBiomeDeepOceanColor;
uniform vec3 uBiomeOceanColor;
uniform vec3 uBiomeBeachColor;
uniform vec3 uBiomePlainsColor;
uniform vec3 uBiomeHillsColor;
uniform vec3 uBiomeRockColor;
uniform vec3 uBiomeIceColor;

uniform float uSpecularBoost;
uniform float uCloudShadowStrength;
uniform vec2 uCloudWind;
uniform float uEmissiveIntensity;
uniform float uNightLights;
uniform vec3 uAtmosphereColor;
uniform float uAtmosphereStrength;
uniform float uAtmospherePower;
uniform float uTime;

/* Normal tangente-espaço derivado da UV equirretangular (sem derivadas). */
vec3 sampleSurfaceNormal(vec3 N, vec2 uv, float strength) {
  vec3 sampled = texture2D(uNormalMap, uv).xyz * 2.0 - 1.0;
  sampled.y *= mix(1.0, -1.0, uNormalFlipY);

  vec3 up = safeNormalize(uPoleAxis, vec3(0.0, 1.0, 0.0));
  vec3 T = cross(N, up);
  float tl = length(T);
  T = tl > 1e-4 ? T / tl : safeNormalize(cross(N, vec3(1.0, 0.0, 0.0)), vec3(0.0, 0.0, 1.0));
  vec3 B = cross(N, T);

  vec3 perturbed = safeNormalize(T * sampled.x + B * sampled.y + N * sampled.z, N);
  return safeNormalize(mix(N, perturbed, saturate(strength)), N);
}

/* Altura normalizada: heightfield de sprites ou estimativa por máscaras. */
float surfaceHeight(vec2 uv, float specular, vec3 albedoLinear) {
  if (uHasHeightMap > 0.5) return texture2D(uHeightMap, uv).r;
  float water = smoothstep(0.32, 0.68, specular);
  float sea = uBiomeParams.x;
  float land = mix(sea, mix(sea, 1.0, 0.55), 1.0 - water);
  return clamp(land + (luminance(albedoLinear) - 0.35) * 0.25, 0.0, 1.0);
}

void main() {
  vec3 N = safeNormalize(vWorldNormal, vec3(0.0, 1.0, 0.0));
  vec3 V = safeNormalize(uCameraPosition - vWorldPosition, vec3(0.0, 0.0, 1.0));
  vec3 L = safeNormalize(uSunDirection, vec3(1.0, 0.0, 0.0));
  vec2 uv = vec2(fract(vUv.x), clamp(vUv.y, 0.0, 1.0));

  vec3 albedoMap = uHasAlbedoMap > 0.5
    ? srgbToLinear(texture2D(uAlbedoMap, uv).rgb)
    : vec3(0.5);
  float specularMask = uHasSpecularMap > 0.5 ? texture2D(uSpecularMap, uv).r : 0.0;
  float emissiveMask = uHasEmissiveMap > 0.5 ? 1.0 : 0.0;
  vec3 emissiveMap = srgbToLinear(texture2D(uEmissiveMap, uv).rgb) * emissiveMask;

  float altitude = surfaceHeight(uv, specularMask, albedoMap);
  float polarWobble = (perlin3(vLocalPosition * 5.5 + vec3(uTime * 0.004)) - 0.5) * 0.05;
  float polar = saturate(abs(dot(N, safeNormalize(uPoleAxis, vec3(0.0, 1.0, 0.0)))) + polarWobble);

  BiomeWeights weights = computeBiomeWeights(
    altitude, polar, uBiomeParams, uBiomeParams2, uBiomeOceanSoftness
  );

  float biomeRough = biomeRoughness(weights, uBiomeRoughnessA, uBiomeRoughnessB);
  float biomeRefl = biomeReflectance(weights, uBiomeReflectanceA, uBiomeReflectanceB);
  vec3 tint = biomeTint(
    weights,
    uBiomeDeepOceanColor, uBiomeOceanColor, uBiomeBeachColor, uBiomePlainsColor,
    uBiomeHillsColor, uBiomeRockColor, uBiomeIceColor
  );

  float isGas = step(0.5, uBodyType);
  float tintStrength = uHasAlbedoMap > 0.5 ? saturate(uBiomeTintStrength) : 1.0;
  vec3 surfaceColor = mix(mix(albedoMap, tint, tintStrength), albedoMap, isGas);

  /* Normal: mapa de normais + ondulação de oceano (segunda amostra). */
  vec3 shadingNormal = N;
  if (uHasNormalMap > 0.5) {
    shadingNormal = sampleSurfaceNormal(N, uv, uNormalStrength);
    float oceanWeight = weights.deepOcean + weights.ocean;
    if (uOceanWaveStrength > 0.001 && oceanWeight > 0.001) {
      vec2 rippleUv = uv + vec2(uTime * 0.003, uTime * 0.0016);
      vec3 ripple = sampleSurfaceNormal(N, rippleUv, uNormalStrength * 1.6);
      shadingNormal = safeNormalize(
        mix(shadingNormal, ripple, uOceanWaveStrength * oceanWeight), N
      );
    }
  }

  /* Sombra das nuvens projetada na superfície. */
  float cloudShadow = 0.0;
  if (uHasCloudMap > 0.5 && uCloudShadowStrength > 0.001) {
    float drift = uTime;
    vec2 uv1 = uv + uCloudWind * drift;
    vec2 uv2 = uv + uCloudWind * drift * 1.37 + vec2(0.31, 0.17);
    float c1 = texture2D(uCloudMap, uv1).a;
    float c2 = texture2D(uCloudMap, uv2).a;
    cloudShadow = saturate(max(c1, c2)) * uCloudShadowStrength;
  }

  PbrMaterial material;
  material.albedo = surfaceColor;
  material.metallic = 0.0;
  material.roughness = mix(biomeRough, uGasGiantRoughness, isGas);
  material.reflectance = clamp(
    mix(biomeRefl, 0.32, isGas) + (weights.ocean + weights.deepOcean) * 0.1 * uSpecularBoost,
    0.0, 1.0
  );
  material.emissive = vec3(0.0);
  material.ao = 1.0;

  vec3 sunRadiance = uSunColor * max(uSunIntensity, 0.0) * (1.0 - cloudShadow);
  vec3 color = evaluateCookTorrance(material, shadingNormal, V, L, sunRadiance);
  color += evaluateAmbient(material, shadingNormal, V, uSkyColor, uGroundColor, uAmbientIntensity);

  /* Emissão: lava, luzes noturnas e atividade superficial. */
  float night = 1.0 - smoothstep(-0.12, 0.28, dot(N, L));
  float nightGain = mix(1.0, 1.8, uNightLights * night);
  material.emissive = emissiveMap * uEmissiveIntensity * mix(0.22, 1.0, night) * nightGain;
  color += material.emissive;

  /* Halo/limbo atmosférico (scattering aproximado, dependente do Sol). */
  float rim = pow(1.0 - saturate(dot(N, V)), max(uAtmospherePower, 0.5));
  float sunLit = smoothstep(-0.35, 0.35, dot(N, L));
  color += uAtmosphereColor * rim * sunLit * uAtmosphereStrength;

  gl_FragColor = vec4(tonemapAndEncode(color, uExposure), 1.0);
}
`;

/* -------------------------------------------------------------------------- */
/*  Spacecraft fragment — casco PBR, painéis, calor e motor                    */
/* -------------------------------------------------------------------------- */

const SPACECRAFT_FRAGMENT_BODY = `
precision highp float;

varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vLocalPosition;

uniform vec3 uCameraPosition;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbientIntensity;
uniform float uExposure;

uniform vec3 uBaseColor;
uniform float uMetallic;
uniform float uRoughness;
uniform float uReflectance;
uniform vec3 uPanelColor;
uniform float uPanelScale;
uniform float uPanelRoughness;
uniform float uPanelMetallic;
uniform float uPanelContrast;
uniform float uUsePanelDetail;

uniform vec3 uEmissiveColor;
uniform float uEmissiveIntensity;
uniform vec3 uEngineColor;
uniform float uEngineIntensity;
uniform vec3 uEngineAxis;
uniform float uEngineFalloff;
uniform vec3 uHeatColor;
uniform float uHeatGlow;
uniform vec3 uHeatDirection;
uniform float uHeatPower;
uniform float uRimStrength;
uniform float uAlpha;
uniform float uTime;

void main() {
  vec3 N = safeNormalize(vWorldNormal, vec3(0.0, 1.0, 0.0));
  vec3 V = safeNormalize(uCameraPosition - vWorldPosition, vec3(0.0, 0.0, 1.0));
  vec3 L = safeNormalize(uSunDirection, vec3(1.0, 0.0, 0.0));

  /* Painéis procedurais: grade + variação de célula por hash. */
  vec3 cellPos = vLocalPosition * max(uPanelScale, 0.001);
  vec3 cell = floor(cellPos);
  vec3 edge = abs(fract(cellPos) - 0.5);
  float seam = smoothstep(0.462, 0.498, max(max(edge.x, edge.y), edge.z));
  float panelId = hash31(cell * 0.37 + 11.0);
  float detail = saturate(uUsePanelDetail);

  vec3 albedo = mix(uBaseColor, uPanelColor, detail * panelId * uPanelContrast);
  albedo *= 1.0 - seam * 0.38 * detail;

  float roughness = mix(uRoughness, uPanelRoughness, detail * panelId);
  float metallic = mix(uMetallic, uPanelMetallic, detail * panelId);
  float grain = hash31(floor(vLocalPosition * 320.0) + uTime * 0.01);
  roughness = clamp(roughness + (grain - 0.5) * 0.04, 0.03, 1.0);

  PbrMaterial material;
  material.albedo = albedo;
  material.metallic = clamp(metallic, 0.0, 1.0);
  material.roughness = roughness;
  material.reflectance = clamp(uReflectance, 0.0, 1.0);
  material.emissive = vec3(0.0);
  material.ao = 1.0;

  vec3 sunRadiance = uSunColor * max(uSunIntensity, 0.0);
  vec3 color = evaluateCookTorrance(material, N, V, L, sunRadiance);
  color += evaluateAmbient(material, N, V, uSkyColor, uGroundColor, uAmbientIntensity);

  /* Brilho do motor: concentrado no eixo local informado. */
  vec3 engineAxis = safeNormalize(uEngineAxis, vec3(0.0, 0.0, -1.0));
  float engineShape = pow(
    saturate(dot(safeNormalize(vLocalPosition, engineAxis), engineAxis)),
    max(uEngineFalloff, 1.0)
  );
  vec3 engineGlow = uEngineColor * max(uEngineIntensity, 0.0) * engineShape;
  color += engineGlow;

  /* Calor de reentrada (atmosphere.js) no lado de barlavento + limbo.
     uHeatDirection aponta para o lado quente (a direção do movimento). */
  vec3 heatSide = safeNormalize(uHeatDirection, vec3(0.0, 0.0, 1.0));
  float rim = pow(1.0 - saturate(dot(N, V)), 2.0);
  float windward = pow(saturate(dot(N, heatSide)), max(uHeatPower, 1.0));
  vec3 heat = uHeatColor * saturate(uHeatGlow) * (0.35 + 0.65 * rim) * (0.25 + 0.75 * windward);
  color += heat;

  color += uEmissiveColor * max(uEmissiveIntensity, 0.0);
  color += uSkyColor * rim * uRimStrength;

  gl_FragColor = vec4(tonemapAndEncode(color, uExposure), clamp(uAlpha, 0.0, 1.0));
}
`;

/* -------------------------------------------------------------------------- */
/*  Clouds fragment — raymarch volumétrico multicamada                        */
/* -------------------------------------------------------------------------- */

const CLOUDS_FRAGMENT_BODY = `
precision highp float;

varying vec3 vWorldPosition;

uniform vec3 uCameraPosition;
uniform float uPlanetRadius;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbientIntensity;
uniform float uExposure;
uniform float uTime;
uniform float uExtinction;
uniform float uScattering;
uniform float uPhaseG;
uniform float uPhaseBack;
uniform float uPhaseMix;
uniform float uPowderStrength;
uniform float uLightAbsorption;
uniform float uAltitudeFalloff;
uniform vec3 uCloudColor;
uniform vec3 uCloudShadeColor;
uniform float uJitter;
uniform float uInsideShell;

void main() {
  /* Um único lado do shell: frente fora, trás dentro (culling desativado). */
  if (gl_FrontFacing == (uInsideShell > 0.5)) discard;

  vec3 ro = uCameraPosition;
  vec3 rd = safeNormalize(vWorldPosition - ro, vec3(0.0, 0.0, 1.0));
  vec3 sunDir = safeNormalize(uSunDirection, vec3(1.0, 0.0, 0.0));

  vec2 tOuter = raySphere(ro, rd, uPlanetCenter, uCloudTopRadius);
  if (tOuter.y <= 0.0) discard;

  float tStart = max(tOuter.x, 0.0);
  float tEnd = tOuter.y;

  vec2 tInner = raySphere(ro, rd, uPlanetCenter, uCloudBaseRadius);
  if (tInner.x > tStart && tInner.x < tEnd) tEnd = tInner.x;
  if (tInner.y > tStart && tInner.y < tEnd) tStart = tInner.y;
  if (tEnd <= tStart) discard;

  float span = max(uCloudTopRadius - uCloudBaseRadius, 1e-4);
  float stepLen = (tEnd - tStart) / float(CLOUD_STEPS);
  float jitter = hash21(gl_FragCoord.xy + vec2(uTime * 17.0, uTime * 11.0)) * saturate(uJitter);

  float cosTheta = dot(rd, sunDir);
  float phase = cloudPhaseFunction(cosTheta, uPhaseG, uPhaseBack, uPhaseMix);

  vec3 scattered = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < CLOUD_STEPS; i++) {
    float t = tStart + stepLen * (float(i) + jitter);
    vec3 p = ro + rd * t;
    float density = cloudDensity(p, uTime, 1.0);

    if (density > 0.001) {
      float h = cloudAltitudeFraction(p);
      float optical = cloudLightOpticalDepth(p, sunDir, uTime);
      float beer = exp(-uLightAbsorption * optical);
      float altitudeLight = mix(1.0 - uAltitudeFalloff, 1.0, h);
      float powder = mix(1.0, 1.0 - exp(-density * uPowderStrength * 4.0), uPowderStrength);
      // O planeta bloqueia o Sol: nuvens no lado noturno só recebem ambiente.
      vec2 sunPlanet = raySphere(p, sunDir, uPlanetCenter, max(uPlanetRadius, 1e-4));
      float sunShadow = sunPlanet.x > 0.0 ? 0.0 : 1.0;

      vec3 sunLight = uSunColor * max(uSunIntensity, 0.0) * beer * altitudeLight * phase * powder * sunShadow;
      vec3 ambientTint = mix(uGroundColor, uSkyColor, h);
      vec3 ambient = mix(uCloudShadeColor, uCloudColor, h) * ambientTint
        * (max(uAmbientIntensity, 0.0) * 2.4) * (0.35 + 0.65 * h);
      vec3 source = (sunLight + ambient) * max(uScattering, 0.0);

      float sigma = density * max(uExtinction, 0.0);
      float stepFrac = stepLen / span;
      float stepTrans = exp(-sigma * stepFrac);

      scattered += transmittance * source * (1.0 - stepTrans);
      transmittance *= stepTrans;
      if (transmittance < 0.015) break;
    }
  }

  float alpha = 1.0 - transmittance;
  if (alpha <= 0.002) discard;

  /* Saída premultiplicada (blend ONE, ONE_MINUS_SRC_ALPHA). */
  vec3 color = tonemapAndEncode(scattered / max(alpha, 1e-4), uExposure) * alpha;
  gl_FragColor = vec4(color, alpha);
}
`;

/* -------------------------------------------------------------------------- */
/*  Atmosphere fragment — espalhamento Rayleigh/Mie no limbo                  */
/* -------------------------------------------------------------------------- */

const ATMOSPHERE_FRAGMENT_BODY = `
precision highp float;

varying vec3 vWorldPosition;

uniform vec3 uCameraPosition;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform float uMetersPerUnit;
uniform vec3 uRayleighCoeff;
uniform vec3 uMieCoeff;
uniform float uRayleighScaleHeight;
uniform float uMieScaleHeight;
uniform float uMieG;
uniform float uScatteringStrength;
uniform float uMieBoost;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uExposure;
uniform float uInsideShell;

void main() {
  if (gl_FrontFacing == (uInsideShell > 0.5)) discard;

  vec3 ro = uCameraPosition;
  vec3 rd = safeNormalize(vWorldPosition - ro, vec3(0.0, 0.0, 1.0));
  vec3 sunDir = safeNormalize(uSunDirection, vec3(1.0, 0.0, 0.0));

  vec2 tOuter = raySphere(ro, rd, uPlanetCenter, uAtmosphereRadius);
  if (tOuter.y <= 0.0) discard;

  float tStart = max(tOuter.x, 0.0);
  float tEnd = tOuter.y;

  vec2 tPlanet = raySphere(ro, rd, uPlanetCenter, uPlanetRadius);
  if (tPlanet.x > tStart) tEnd = min(tEnd, tPlanet.x);
  if (tPlanet.y > tStart) tStart = max(tStart, tPlanet.y);
  if (tEnd <= tStart) discard;

  float mpu = max(uMetersPerUnit, 1e-6);
  float cosTheta = dot(rd, sunDir);
  float phaseR = rayleighPhase(cosTheta);
  float phaseM = henyeyGreenstein(cosTheta, uMieG);

  float steps = float(ATMOSPHERE_STEPS);
  float ds = (tEnd - tStart) / steps;
  float sunStepScale = 1.0 / float(ATMOSPHERE_LIGHT_STEPS);

  vec3 scattered = vec3(0.0);
  vec3 transmittance = vec3(1.0);
  vec3 sunRadiance = uSunColor * max(uSunIntensity, 0.0) * max(uScatteringStrength, 0.0);

  for (int i = 0; i < ATMOSPHERE_STEPS; i++) {
    vec3 p = ro + rd * (tStart + ds * (float(i) + 0.5));
    float altitude = max(length(p - uPlanetCenter) - uPlanetRadius, 0.0) * mpu;
    float rhoR = atmosphereDensity(altitude, uRayleighScaleHeight);
    float rhoM = atmosphereDensity(altitude, uMieScaleHeight);

    vec2 tSun = raySphere(p, sunDir, uPlanetCenter, uAtmosphereRadius);
    float sunDist = max(tSun.y, 0.0);
    float sunDs = sunDist * sunStepScale;
    float odR = 0.0;
    float odM = 0.0;
    for (int j = 0; j < ATMOSPHERE_LIGHT_STEPS; j++) {
      vec3 q = p + sunDir * (sunDs * (float(j) + 0.5));
      float hq = max(length(q - uPlanetCenter) - uPlanetRadius, 0.0) * mpu;
      odR += atmosphereDensity(hq, uRayleighScaleHeight) * sunDs * mpu;
      odM += atmosphereDensity(hq, uMieScaleHeight) * sunDs * mpu;
    }

    // Amostras abaixo do horizonte não recebem Sol direto.
    vec2 tSunPlanet = raySphere(p, sunDir, uPlanetCenter, uPlanetRadius);
    if (tSunPlanet.x > 0.0) continue;

    vec3 sunTrans = exp(-(uRayleighCoeff * odR + uMieCoeff * (odM * 1.1)));
    vec3 scattering = uRayleighCoeff * (rhoR * phaseR)
      + uMieCoeff * (rhoM * phaseM * max(uMieBoost, 0.0));

    float stepMeters = ds * mpu;
    vec3 stepTrans = exp(-(uRayleighCoeff * rhoR + uMieCoeff * rhoM) * stepMeters);
    scattered += transmittance * scattering * sunTrans * sunRadiance * stepMeters;
    transmittance *= stepTrans;
  }

  /* Camada aditiva: o planeta já resolve a oclusão via depth buffer. */
  gl_FragColor = vec4(tonemapAndEncode(scattered, uExposure), 1.0);
}
`;

/* ========================================================================== */
/*  7. Catálogo de programas, uniformes e composição de fontes                */
/* ========================================================================== */

/** Nomes dos programas exportados. */
export const PROGRAM_NAMES = Object.freeze(['planet', 'clouds', 'atmosphere', 'spacecraft']);

/** Matriz identidade 4×4 (coluna-maior, como o WebGL espera). */
const MAT4_IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Matriz identidade 3×3. */
const MAT3_IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Valores padrão dos uniformes do programa `planet`. */
const PLANET_UNIFORMS = deepFreeze({
  uModel: [...MAT4_IDENTITY],
  uViewProjection: [...MAT4_IDENTITY],
  uNormalMatrix: [...MAT3_IDENTITY],
  uCameraPosition: [0, 0, 3.2],
  uSunDirection: [0.78, 0.36, 0.51],
  uSunColor: [1, 0.97, 0.92],
  uSunIntensity: 3.2,
  uSkyColor: [0.16, 0.24, 0.4],
  uGroundColor: [0.05, 0.045, 0.04],
  uAmbientIntensity: 0.45,
  uExposure: 1,
  uPoleAxis: [0, 1, 0],
  uBodyType: 0,
  uGasGiantRoughness: 0.72,
  uNormalStrength: 1,
  uNormalFlipY: 0,
  uOceanWaveStrength: 0.35,
  uHasAlbedoMap: 1,
  uHasNormalMap: 0,
  uHasSpecularMap: 0,
  uHasEmissiveMap: 0,
  uHasCloudMap: 0,
  uHasHeightMap: 0,
  uBiomeParams: [0.55, 0.035, 0.72, 0.86],
  uBiomeParams2: [0.94, 0.82, 0.08, 1],
  uBiomeOceanSoftness: 0.012,
  uBiomeRoughnessA: [0.06, 0.13, 0.88, 0.8],
  uBiomeRoughnessB: [0.86, 0.68, 0.2, 1],
  uBiomeReflectanceA: [0.62, 0.55, 0.25, 0.2],
  uBiomeReflectanceB: [0.22, 0.3, 0.52, 1],
  uBiomeTintStrength: 0.42,
  uBiomeDeepOceanColor: [0.0016, 0.011, 0.024],
  uBiomeOceanColor: [0.007, 0.16, 0.26],
  uBiomeBeachColor: [0.44, 0.38, 0.21],
  uBiomePlainsColor: [0.11, 0.23, 0.06],
  uBiomeHillsColor: [0.11, 0.15, 0.07],
  uBiomeRockColor: [0.2, 0.19, 0.15],
  uBiomeIceColor: [0.81, 0.9, 1],
  uSpecularBoost: 1,
  uCloudShadowStrength: 0.6,
  uCloudWind: [0.002, 0],
  uEmissiveIntensity: 1,
  uNightLights: 1,
  uAtmosphereColor: [0.25, 0.5, 1],
  uAtmosphereStrength: 0.35,
  uAtmospherePower: 3,
  uTime: 0,
});

/** Valores padrão dos uniformes do programa `spacecraft`. */
const SPACECRAFT_UNIFORMS = deepFreeze({
  uModel: [...MAT4_IDENTITY],
  uViewProjection: [...MAT4_IDENTITY],
  uNormalMatrix: [...MAT3_IDENTITY],
  uCameraPosition: [0, 0, 3.2],
  uSunDirection: [0.78, 0.36, 0.51],
  uSunColor: [1, 0.97, 0.92],
  uSunIntensity: 3.2,
  uSkyColor: [0.16, 0.24, 0.4],
  uGroundColor: [0.05, 0.045, 0.04],
  uAmbientIntensity: 0.45,
  uExposure: 1,
  uBaseColor: [0.82, 0.85, 0.88],
  uMetallic: 0.08,
  uRoughness: 0.42,
  uReflectance: 0.5,
  uPanelColor: [0.48, 0.54, 0.61],
  uPanelScale: 10,
  uPanelRoughness: 0.35,
  uPanelMetallic: 0.12,
  uPanelContrast: 0.55,
  uUsePanelDetail: 1,
  uEmissiveColor: [0, 0, 0],
  uEmissiveIntensity: 0,
  uEngineColor: [0.35, 0.65, 1],
  uEngineIntensity: 0,
  uEngineAxis: [0, 0, -1],
  uEngineFalloff: 6,
  uHeatColor: [1, 0.3, 0.08],
  uHeatGlow: 0,
  uHeatDirection: [0, 0, 1],
  uHeatPower: 2,
  uRimStrength: 0.15,
  uAlpha: 1,
  uTime: 0,
});

/** Valores padrão dos uniformes do programa `clouds`. */
const CLOUD_UNIFORMS = deepFreeze({
  uModel: [...MAT4_IDENTITY],
  uViewProjection: [...MAT4_IDENTITY],
  uCameraPosition: [0, 0, 3.2],
  uPlanetCenter: [0, 0, 0],
  uPlanetRadius: 6.371e6,
  uCloudBaseRadius: 6.372e6,
  uCloudTopRadius: 6.385e6,
  uCloudLayerA: [
    0.0224, 0.2687, 0.52, 2.3,
    0.2239, 0.5672, 0.36, 1.7,
    0.5224, 0.9627, 0.22, 1.15,
  ],
  uCloudLayerB: [
    1, 0, 1, 0.45,
    0.65, 4.7, 1.35, 0.25,
    0.35, 9.3, 1.9, 0.08,
  ],
  uCloudColor: [1, 1, 1],
  uCloudShadeColor: [0.55, 0.69, 0.83],
  uCloudWind: [0.012, 0, 0.003],
  uCloudWarp: 0.45,
  uDensityScale: 1,
  uExtinction: 6,
  uScattering: 1,
  uPhaseG: 0.55,
  uPhaseBack: -0.22,
  uPhaseMix: 0.35,
  uPowderStrength: 0.6,
  uLightAbsorption: 6,
  uAltitudeFalloff: 0.55,
  uLightMarchDistance: 0.6,
  uAmbientIntensity: 0.35,
  uSunDirection: [0.78, 0.36, 0.51],
  uSunColor: [1, 0.97, 0.92],
  uSunIntensity: 3,
  uSkyColor: [0.2, 0.3, 0.5],
  uGroundColor: [0.07, 0.06, 0.05],
  uExposure: 1,
  uTime: 0,
  uJitter: 1,
  uInsideShell: 0,
});

/** Valores padrão dos uniformes do programa `atmosphere`. */
const ATMOSPHERE_UNIFORMS = deepFreeze({
  uModel: [...MAT4_IDENTITY],
  uViewProjection: [...MAT4_IDENTITY],
  uCameraPosition: [0, 0, 3.2],
  uPlanetCenter: [0, 0, 0],
  uPlanetRadius: 6.371e6,
  uAtmosphereRadius: 6.471e6,
  uMetersPerUnit: 1,
  uRayleighCoeff: [5.8e-6, 13.5e-6, 33.1e-6],
  uMieCoeff: [2.1e-5, 2.1e-5, 2.1e-5],
  uRayleighScaleHeight: 8500,
  uMieScaleHeight: 1200,
  uMieG: 0.76,
  uScatteringStrength: 1,
  uMieBoost: 0.6,
  uSunDirection: [0.78, 0.36, 0.51],
  uSunColor: [1, 0.97, 0.92],
  uSunIntensity: 4,
  uExposure: 1,
  uInsideShell: 0,
});

/** @private Definições internas de cada programa. */
const PROGRAM_DEFINITIONS = {
  planet: {
    label: 'Superfície planetária PBR (Cook-Torrance + biomas + nuvens)',
    vertexChunks: [],
    vertexBody: VERTEX_SURFACE_BODY,
    fragmentChunks: [GLSL_COMMON, GLSL_NOISE, GLSL_PBR, GLSL_BIOMES],
    fragmentBody: PLANET_FRAGMENT_BODY,
    defines: {},
    attributes: ['aPosition', 'aNormal', 'aUv'],
    samplers: ['uAlbedoMap', 'uNormalMap', 'uSpecularMap', 'uEmissiveMap', 'uCloudMap', 'uHeightMap'],
    uniforms: PLANET_UNIFORMS,
    renderState: { depthTest: true, depthWrite: true, blend: 'none', cullFace: 'back' },
  },
  clouds: {
    label: 'Nuvens volumétricas multicamada (raymarch + Beer-Lambert)',
    vertexChunks: [],
    vertexBody: VERTEX_SHELL_BODY,
    fragmentChunks: [GLSL_COMMON, GLSL_NOISE, GLSL_CLOUDS],
    fragmentBody: CLOUDS_FRAGMENT_BODY,
    defines: {
      CLOUD_LAYER_COUNT: CLOUD_LAYER_COUNT,
      CLOUD_STEPS: 40,
      CLOUD_LIGHT_STEPS: 3,
      CLOUD_FBM_OCTAVES: 4,
      CLOUD_LIGHT_OCTAVES: 2,
      RIDGED_OCTAVES: 3,
    },
    attributes: ['aPosition'],
    samplers: [],
    uniforms: CLOUD_UNIFORMS,
    renderState: { depthTest: true, depthWrite: false, blend: 'premultiplied', cullFace: 'none' },
  },
  atmosphere: {
    label: 'Atmosfera/limbo com espalhamento Rayleigh e Mie',
    vertexChunks: [],
    vertexBody: VERTEX_SHELL_BODY,
    fragmentChunks: [GLSL_COMMON, GLSL_ATMOSPHERE],
    fragmentBody: ATMOSPHERE_FRAGMENT_BODY,
    defines: {
      ATMOSPHERE_STEPS: 12,
      ATMOSPHERE_LIGHT_STEPS: 4,
    },
    attributes: ['aPosition'],
    samplers: [],
    uniforms: ATMOSPHERE_UNIFORMS,
    renderState: { depthTest: true, depthWrite: false, blend: 'glow', cullFace: 'none' },
  },
  spacecraft: {
    label: 'Nave PBR (metal/dielétrico, painéis, motor e calor de reentrada)',
    vertexChunks: [],
    vertexBody: VERTEX_SURFACE_BODY,
    fragmentChunks: [GLSL_COMMON, GLSL_NOISE, GLSL_PBR],
    fragmentBody: SPACECRAFT_FRAGMENT_BODY,
    defines: {},
    attributes: ['aPosition', 'aNormal', 'aUv'],
    samplers: [],
    uniforms: SPACECRAFT_UNIFORMS,
    renderState: { depthTest: true, depthWrite: true, blend: 'none', cullFace: 'back' },
  },
};

/** Congela recursivamente objetos e arrays (sem tocar em typed arrays). */
function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** @private Copia profunda de arrays/objetos simples (typed arrays viram cópia). */
export function cloneUniformValue(value) {
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (Array.isArray(value)) return value.map(cloneUniformValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneUniformValue(value[key]);
    return out;
  }
  return value;
}

/** @private Copia profunda dos defaults de uniformes. */
function cloneUniformDefaults(uniforms) {
  const out = {};
  for (const key of Object.keys(uniforms ?? {})) out[key] = cloneUniformValue(uniforms[key]);
  return out;
}

/**
 * Monta uma fonte GLSL a partir de defines, chunks e corpo.
 * A diretiva `#version` é adicionada apenas na variante 300 es.
 *
 * @param {object} options
 * @param {'vertex'|'fragment'} [options.stage='fragment']
 * @param {'100'|'300 es'} [options.version='100']
 * @param {Record<string, string|number|boolean>} [options.defines]
 * @param {string[]} [options.chunks]
 * @param {string} [options.body]
 * @returns {string}
 */
export function composeShaderSource(options = {}) {
  const stage = options.stage === 'vertex' ? 'vertex' : 'fragment';
  const version = options.version === GLSL_VERSION_300 ? GLSL_VERSION_300 : GLSL_VERSION_100;
  const defines = options.defines ?? {};
  const chunks = options.chunks ?? [];
  const body = options.body ?? '';
  const lines = [];

  // A precisão padrão precisa vir ANTES de qualquer função (inclui os chunks).
  if (stage === 'fragment') {
    lines.push('precision highp float;');
    lines.push('precision highp int;');
    lines.push('');
  }

  const entries = Object.keys(defines)
    .filter((key) => defines[key] !== false && defines[key] !== null && defines[key] !== undefined)
    .sort();
  for (const key of entries) {
    const value = defines[key];
    lines.push(value === true ? `#define ${key}` : `#define ${key} ${value}`);
  }
  if (lines.length) lines.push('');
  for (const chunk of chunks) {
    if (!chunk) continue;
    lines.push(chunk.trim());
    lines.push('');
  }
  lines.push(body.trim());
  lines.push('');

  const source = lines.join('\n');
  return version === GLSL_VERSION_300 ? upgradeShaderSource(source, stage) : source;
}

/**
 * Atualiza um shader GLSL ES 1.00 para GLSL ES 3.00 (WebGL 2):
 * `attribute` → `in`, `varying` → `in/out`, `texture2D` → `texture`,
 * `gl_FragColor` → saída declarada, remove extensões ES1 obsoletas.
 *
 * A função é conservadora: não reescreve `#ifdef`/comentários com essas
 * palavras além do necessário para o código gerado por este módulo.
 *
 * @param {string} source
 * @param {'vertex'|'fragment'} [stage='fragment']
 * @returns {string}
 */
export function upgradeShaderSource(source, stage = 'fragment') {
  let src = String(source ?? '').replace(/^\s*#version[^\n]*\n/, '');
  src = src.replace(/^\s*#extension\s+GL_OES_standard_derivatives[^\n]*\n/gm, '');

  if (stage === 'vertex') {
    src = src.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out');
  } else {
    src = src.replace(/\bvarying\b/g, 'in');
    src = src.replace(/\btexture2D\s*\(/g, 'texture(');
    src = src.replace(/\btextureCube\s*\(/g, 'texture(');
    src = src.replace(/\btexture2DProj\s*\(/g, 'textureProj(');
    src = src.replace(/\bgl_FragColor\b/g, 'fragColor');
    const lines = src.split('\n');
    const precisionIndex = lines.findIndex((line) => /^\s*precision\s+/.test(line));
    lines.splice(precisionIndex >= 0 ? precisionIndex + 1 : 0, 0, 'out vec4 fragColor;');
    src = lines.join('\n');
  }
  return `#version 300 es\n${src}`;
}

/** @private Aplica opções de qualidade aos defines de nuvens/atmosfera. */
function resolveVariantDefines(name, definition, options = {}) {
  const defines = { ...definition.defines, ...(options.defines ?? {}) };
  const intOption = (value, min, max) => (Number.isFinite(Number(value)) ? clamp(Math.round(Number(value)), min, max) : null);

  if (name === 'clouds') {
    const steps = intOption(options.steps, 8, 160);
    const lightSteps = intOption(options.lightSteps, 1, 12);
    const octaves = intOption(options.octaves, 1, 8);
    const lightOctaves = intOption(options.lightOctaves, 1, 4);
    const ridged = intOption(options.ridgedOctaves, 1, 6);
    if (steps !== null) defines.CLOUD_STEPS = steps;
    if (lightSteps !== null) defines.CLOUD_LIGHT_STEPS = lightSteps;
    if (octaves !== null) defines.CLOUD_FBM_OCTAVES = octaves;
    if (lightOctaves !== null) defines.CLOUD_LIGHT_OCTAVES = lightOctaves;
    if (ridged !== null) defines.RIDGED_OCTAVES = ridged;
  }
  if (name === 'atmosphere') {
    const steps = intOption(options.steps, 4, 64);
    const lightSteps = intOption(options.lightSteps, 1, 12);
    if (steps !== null) defines.ATMOSPHERE_STEPS = steps;
    if (lightSteps !== null) defines.ATMOSPHERE_LIGHT_STEPS = lightSteps;
  }
  return defines;
}

/**
 * Gera as fontes (vertex + fragment) de um programa, com variantes.
 *
 * @param {string} name `planet` | `clouds` | `atmosphere` | `spacecraft`
 * @param {object} [options]
 * @param {'100'|'300 es'} [options.version='100']
 * @param {Record<string, string|number|boolean>} [options.defines]
 * @param {number} [options.steps] passos de raymarch (nuvens/atmosfera)
 * @param {number} [options.lightSteps] passos da marcha de luz
 * @param {number} [options.octaves] oitavas do fBm de nuvens
 * @returns {{name:string,label:string,vertex:string,fragment:string,defines:object,version:string,attributes:string[],samplers:string[],renderState:object,uniforms:object}}
 */
export function buildShaderSource(name, options = {}) {
  const definition = PROGRAM_DEFINITIONS[name];
  if (!definition) {
    throw new Error(`shaders.js: programa desconhecido "${name}". Use ${PROGRAM_NAMES.join(', ')}.`);
  }
  const version = options.version === GLSL_VERSION_300 ? GLSL_VERSION_300 : GLSL_VERSION_100;
  const defines = resolveVariantDefines(name, definition, options);
  const vertex = composeShaderSource({
    stage: 'vertex',
    version,
    defines,
    chunks: definition.vertexChunks,
    body: definition.vertexBody,
  });
  const fragment = composeShaderSource({
    stage: 'fragment',
    version,
    defines,
    chunks: definition.fragmentChunks,
    body: definition.fragmentBody,
  });
  return {
    name,
    label: definition.label,
    vertex,
    fragment,
    defines,
    version,
    attributes: [...definition.attributes],
    samplers: [...definition.samplers],
    renderState: { ...definition.renderState },
    uniforms: cloneUniformDefaults(definition.uniforms),
  };
}

/** Gera as fontes de todos os programas (mapa nome → fontes). */
export function buildAllShaderSources(options = {}) {
  const out = {};
  for (const name of PROGRAM_NAMES) out[name] = buildShaderSource(name, options);
  return out;
}

/** @private Catálogo pré-compilado (fontes padrão prontas para uso direto). */
function buildProgramCatalog() {
  const out = {};
  for (const name of PROGRAM_NAMES) {
    const built = buildShaderSource(name);
    out[name] = deepFreeze({
      name: built.name,
      label: built.label,
      vertex: built.vertex,
      fragment: built.fragment,
      defines: built.defines,
      version: built.version,
      attributes: built.attributes,
      samplers: built.samplers,
      renderState: built.renderState,
      uniforms: built.uniforms,
    });
  }
  return out;
}

/**
 * Programas com fontes GLSL padrão (GLSL ES 1.00), metadados, atributos,
 * samplers, uniformes padrão e estado de renderização sugerido.
 */
export const SHADER_PROGRAMS = deepFreeze(buildProgramCatalog());

/** Chunks GLSL reutilizáveis, exportados para composição customizada. */
export const SHADER_CHUNKS = deepFreeze({
  common: GLSL_COMMON,
  noise: GLSL_NOISE,
  pbr: GLSL_PBR,
  biomes: GLSL_BIOMES,
  clouds: GLSL_CLOUDS,
  atmosphere: GLSL_ATMOSPHERE,
  vertexSurface: VERTEX_SURFACE_BODY,
  vertexShell: VERTEX_SHELL_BODY,
  planet: PLANET_FRAGMENT_BODY,
  cloudsFragment: CLOUDS_FRAGMENT_BODY,
  atmosphereFragment: ATMOSPHERE_FRAGMENT_BODY,
  spacecraft: SPACECRAFT_FRAGMENT_BODY,
});

/** Defaults de uniformes por programa (objetos congelados). */
export const SHADER_UNIFORM_DEFAULTS = deepFreeze({
  planet: PLANET_UNIFORMS,
  clouds: CLOUD_UNIFORMS,
  atmosphere: ATMOSPHERE_UNIFORMS,
  spacecraft: SPACECRAFT_UNIFORMS,
});

/**
 * Devolve uma cópia mutável dos uniformes padrão de um programa.
 * @param {string} name
 * @param {object} [overrides]
 * @returns {object}
 */
export function createDefaultUniforms(name, overrides = {}) {
  const defaults = SHADER_UNIFORM_DEFAULTS[name];
  if (!defaults) throw new Error(`shaders.js: programa desconhecido "${name}".`);
  return { ...cloneUniformDefaults(defaults), ...cloneUniformDefaults(overrides) };
}

/**
 * Valida/resolve um mapa de uniformes contra o schema do programa.
 *
 * @param {string} name
 * @param {object} uniforms
 * @param {object} [options]
 * @param {boolean} [options.strict=false] lança erro para nomes desconhecidos
 * @returns {{uniforms:object, unknown:string[]}}
 */
export function resolveUniforms(name, uniforms = {}, options = {}) {
  const defaults = SHADER_UNIFORM_DEFAULTS[name];
  if (!defaults) throw new Error(`shaders.js: programa desconhecido "${name}".`);
  const valid = new Set(Object.keys(defaults));
  const unknown = [];
  for (const key of Object.keys(uniforms)) {
    if (!valid.has(key)) {
      unknown.push(key);
      if (options.strict) {
        throw new Error(`shaders.js: uniforme "${key}" não existe no programa "${name}".`);
      }
    }
  }
  return { uniforms: { ...cloneUniformDefaults(defaults), ...cloneUniformDefaults(uniforms) }, unknown };
}

/** Tabela de constantes de tipo de uniform do WebGL (para introspecção). */
export const GL_UNIFORM_TYPES = Object.freeze({
  0x1406: 'float',
  0x8b50: 'vec2',
  0x8b51: 'vec3',
  0x8b52: 'vec4',
  0x1404: 'int',
  0x8b56: 'bool',
  0x8b5a: 'mat2',
  0x8b5b: 'mat3',
  0x8b5c: 'mat4',
  0x8b5e: 'sampler2D',
  0x8b60: 'samplerCube',
  0x8b5f: 'sampler3D',
  0x8a11: 'sampler2DArray',
});

/** Estado de renderização sugerido por programa. */
export const PROGRAM_RENDER_STATE = deepFreeze(
  Object.fromEntries(PROGRAM_NAMES.map((name) => [name, SHADER_PROGRAMS[name].renderState])),
);

/* ========================================================================== */
/*  8. Compilação, programas, uniformes e texturas                            */
/* ========================================================================== */

/** Anota a fonte GLSL com números de linha (para mensagens de erro). */
export function annotateShaderSource(source, options = {}) {
  const lines = String(source ?? '').split('\n');
  const start = Math.max(1, options.start ?? 1);
  const end = Math.min(lines.length, options.end ?? lines.length);
  const width = String(end).length;
  const out = [];
  for (let i = start; i <= end; i++) {
    out.push(`${String(i).padStart(width, ' ')} | ${lines[i - 1]}`);
  }
  return out.join('\n');
}

/** Extrai números de linha de um log de compilação (`ERROR: 0:42:`). */
export function shaderErrorLines(log) {
  const lines = new Set();
  const re = /(?:ERROR|WARNING):\s*\d+:(\d+)/g;
  let match;
  const text = String(log ?? '');
  while ((match = re.exec(text))) {
    const line = Number(match[1]);
    if (Number.isFinite(line) && line > 0) lines.add(line);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Formata um log de shader com contexto de fonte ao redor dos erros. */
export function formatShaderLog(source, log, label = 'shader') {
  const src = String(source ?? '');
  const logText = String(log ?? '').trim();
  const errorLines = shaderErrorLines(logText);
  const parts = [`shaders.js: ${label} rejeitado pelo driver.`];
  if (logText) parts.push(logText);
  if (errorLines.length) {
    const lines = src.split('\n');
    const ranges = [];
    for (const line of errorLines) {
      const from = Math.max(1, line - 3);
      const to = Math.min(lines.length, line + 3);
      const last = ranges[ranges.length - 1];
      if (last && from <= last.end + 1) last.end = Math.max(last.end, to);
      else ranges.push({ start: from, end: to });
    }
    parts.push('--- contexto ---');
    for (const range of ranges) {
      parts.push(annotateShaderSource(src, range));
      parts.push('...');
    }
  } else if (src.length <= 4000) {
    parts.push('--- fonte ---');
    parts.push(annotateShaderSource(src));
  }
  return parts.join('\n');
}

/**
 * Compila um shader e devolve o objeto WebGLShader.
 *
 * @param {WebGLRenderingContext} gl
 * @param {number} type `gl.VERTEX_SHADER` ou `gl.FRAGMENT_SHADER`
 * @param {string} source
 * @param {object} [options]
 * @param {string} [options.label='shader']
 * @param {boolean} [options.throwOnError=true] se false, retorna null em falha
 * @returns {WebGLShader|null}
 */
export function compileShaderSource(gl, type, source, options = {}) {
  if (!gl || typeof gl.createShader !== 'function') {
    throw new Error('shaders.js: contexto WebGL inválido para compilar shader.');
  }
  const shader = gl.createShader(type);
  if (!shader) throw new Error('shaders.js: falha ao criar shader WebGL.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (!ok) {
    const log = gl.getShaderInfoLog(shader) || 'sem log do driver';
    const label = options.label ?? 'shader';
    gl.deleteShader(shader);
    if (options.throwOnError === false) return null;
    const error = new Error(formatShaderLog(source, log, label));
    error.log = log;
    error.source = source;
    error.label = label;
    error.shaderStage = type === gl.FRAGMENT_SHADER ? 'fragment' : 'vertex';
    throw error;
  }
  return shader;
}

/**
 * Linka dois shaders já compilados em um programa WebGL.
 *
 * @param {WebGLRenderingContext} gl
 * @param {WebGLShader} vertexShader
 * @param {WebGLShader} fragmentShader
 * @param {object} [options]
 * @returns {WebGLProgram}
 */
export function linkShaderProgram(gl, vertexShader, fragmentShader, options = {}) {
  if (!gl || typeof gl.createProgram !== 'function') {
    throw new Error('shaders.js: contexto WebGL inválido para linkar programa.');
  }
  const program = gl.createProgram();
  if (!program) throw new Error('shaders.js: falha ao criar programa WebGL.');
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);

  if (Array.isArray(options.attributes)) {
    options.attributes.forEach((attribute, index) => {
      if (typeof gl.bindAttribLocation === 'function') gl.bindAttribLocation(program, index, attribute);
    });
  }

  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'sem log do driver';
    const label = options.label ?? 'programa';
    gl.deleteProgram(program);
    if (options.throwOnError === false) return null;
    const error = new Error(`shaders.js: falha ao linkar "${label}" — ${log}`);
    error.log = log;
    error.source = '';
    error.label = label;
    error.shaderStage = 'link';
    throw error;
  }
  return program;
}

/** Remove um programa (aceita `ShaderProgram` ou `WebGLProgram`). */
export function deleteProgram(gl, program) {
  if (!gl || !program) return;
  const raw = program.program ?? program;
  if (typeof program.dispose === 'function') program.dispose();
  else gl.deleteProgram(raw);
}

/* -------------------------------- texturas -------------------------------- */

/** @private Detecta um WebGLTexture real sem depender de construtor global. */
export function isWebGLTexture(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    const Ctor = globalThis.WebGLTexture;
    if (typeof Ctor === 'function' && value instanceof Ctor) return true;
  } catch { /* contexto/global ausente */ }
  return Object.prototype.toString.call(value) === '[object WebGLTexture]';
}

/** Indica se o contexto é WebGL 2 (sem quebrar em ambientes headless). */
export function isWebGL2Context(gl) {
  try {
    return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  } catch {
    return false;
  }
}

/** @private Resolve canvas/imagem a partir de texturas de sprites.js. */
export function resolveTextureSource(value) {
  if (!value) return null;
  if (value.canvas) return value.canvas;
  if (value.image) return value.image;
  if (value.bitmap) return value.bitmap;
  if (value.source && value.source !== value) return resolveTextureSource(value.source);
  return value;
}

const isPowerOfTwo = (v) => v > 0 && (v & (v - 1)) === 0;

/**
 * Upload de uma textura com parâmetros seguros para WebGL 1 e 2
 * (NPOT sem mipmap/REPEAT no WebGL 1, anisotropia opcional).
 *
 * @param {WebGLRenderingContext} gl
 * @param {any} source canvas, OffscreenCanvas, ImageBitmap, ImageData ou imagem
 * @param {object} [options]
 * @param {boolean} [options.mipmaps=true]
 * @param {boolean} [options.repeatX=true]
 * @param {boolean} [options.flipY=false]
 * @param {boolean} [options.linear=true]
 * @param {number}  [options.anisotropy=4]
 * @param {boolean} [options.premultiplyAlpha=false]
 * @returns {WebGLTexture}
 */
export function uploadShaderTexture(gl, source, options = {}) {
  if (!gl || typeof gl.createTexture !== 'function') {
    throw new Error('shaders.js: contexto WebGL inválido para upload de textura.');
  }
  const resolved = resolveTextureSource(source);
  if (!resolved) throw new Error('shaders.js: textura sem fonte (canvas/ImageData/imagem).');

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (gl.pixelStorei) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, options.flipY ? 1 : 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, options.premultiplyAlpha ? 1 : 0);
  }
  const internalFormat = gl.RGBA;
  const format = gl.RGBA;
  const type = gl.UNSIGNED_BYTE;

  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, format, type, resolved);
  } catch (err) {
    // ImageData com largura/altura explícitas não é aceito pelo overload antigo.
    if (resolved?.data && resolved.width && resolved.height) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, internalFormat, resolved.width, resolved.height, 0,
        format, type, resolved.data,
      );
    } else {
      gl.deleteTexture(texture);
      throw err;
    }
  }

  const width = resolved.width ?? resolved.videoWidth ?? 0;
  const height = resolved.height ?? resolved.videoHeight ?? 0;
  const pot = isPowerOfTwo(width) && isPowerOfTwo(height);
  const webgl2 = isWebGL2Context(gl);
  const canRepeat = webgl2 || pot;
  const canMipmap = (webgl2 || pot) && options.mipmaps !== false;
  const linear = options.linear !== false;
  const filter = linear ? gl.LINEAR : gl.NEAREST;

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, options.repeatX === false || !canRepeat ? gl.CLAMP_TO_EDGE : gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  if (canMipmap && typeof gl.generateMipmap === 'function') {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  }

  const anisotropy = options.anisotropy ?? 4;
  const ext = gl.getExtension?.('EXT_texture_filter_anisotropic')
    ?? gl.getExtension?.('WEBKIT_EXT_texture_filter_anisotropic');
  if (ext && anisotropy > 0) {
    const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
    gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(anisotropy, max));
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/** @private Conteúdo 1×1 por sampler quando a textura não é fornecida. */
const SAMPLER_FALLBACKS = Object.freeze({
  uAlbedoMap: [255, 255, 255, 255],
  uNormalMap: [128, 128, 255, 255],
  uSpecularMap: [0, 0, 0, 255],
  uEmissiveMap: [0, 0, 0, 255],
  uCloudMap: [255, 255, 255, 0],
  uHeightMap: [128, 128, 128, 255],
  default: [255, 255, 255, 255],
});

/**
 * Cache de texturas GPU por fonte (WeakMap) + fallbacks neutros por sampler.
 * Uma instância é compartilhada por todos os programas de uma `ShaderLibrary`,
 * evitando uploads duplicados dos mapas de sprites.js.
 */
export class TextureCache {
  constructor(gl, options = {}) {
    this.gl = gl;
    this.options = { repeatX: true, mipmaps: true, anisotropy: 4, ...options };
    this.cache = new WeakMap();
    this.textures = new Set();
    this.fallbacks = new Map();
    this.uploads = 0;
    this.disposed = false;
  }

  /** @private chave estável das opções de upload. */
  static key(options = {}) {
    return [
      options.mipmaps !== false ? 1 : 0,
      options.repeatX === false ? 0 : 1,
      options.flipY ? 1 : 0,
      options.linear === false ? 0 : 1,
      options.premultiplyAlpha ? 1 : 0,
      Number(options.anisotropy ?? 4),
    ].join(':');
  }

  /**
   * Devolve (ou cria) a textura de uma fonte.
   * @param {any} source WebGLTexture, saída de sprites.js, canvas ou ImageData
   * @param {object} [options]
   * @returns {WebGLTexture|null}
   */
  get(source, options = {}) {
    if (!source) return null;
    if (isWebGLTexture(source)) return source;
    if (source.texture && isWebGLTexture(source.texture)) return source.texture;
    const resolved = resolveTextureSource(source);
    if (!resolved || isWebGLTexture(resolved)) return resolved ?? null;

    let perSource = this.cache.get(resolved);
    if (!perSource) {
      perSource = new Map();
      this.cache.set(resolved, perSource);
    }
    const key = TextureCache.key({ ...this.options, ...options });
    if (perSource.has(key)) return perSource.get(key);

    const texture = uploadShaderTexture(this.gl, resolved, { ...this.options, ...options });
    perSource.set(key, texture);
    this.textures.add(texture);
    this.uploads++;
    return texture;
  }

  /** Quantidade de texturas GPU vivas nesta cache. */
  get size() { return this.textures.size; }

  /** Indica se uma fonte já possui upload nesta cache. */
  has(source) {
    if (!source) return false;
    if (isWebGLTexture(source)) return this.textures.has(source);
    const resolved = resolveTextureSource(source);
    return !!resolved && this.cache.has(resolved);
  }

  /** Remove e libera as texturas de uma fonte específica. */
  release(source) {
    if (!source) return false;
    const resolved = resolveTextureSource(source);
    if (!resolved) return false;
    const perSource = this.cache.get(resolved);
    if (!perSource) return false;
    for (const texture of perSource.values()) {
      try { this.gl.deleteTexture(texture); } catch { /* contexto perdido */ }
      this.textures.delete(texture);
    }
    this.cache.delete(resolved);
    return true;
  }

  /** @private Textura 1×1 neutra para um sampler sem fonte. */
  getFallback(samplerName = 'default') {
    if (!this.gl) return null;
    const values = SAMPLER_FALLBACKS[samplerName] ?? SAMPLER_FALLBACKS.default;
    let texture = this.fallbacks.get(samplerName);
    if (texture) return texture;
    texture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D, 0, this.gl.RGBA, 1, 1, 0,
      this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(values),
    );
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.fallbacks.set(samplerName, texture);
    this.textures.add(texture);
    return texture;
  }

  /** Libera todas as texturas criadas por esta cache. */
  dispose() {
    if (this.disposed) return;
    for (const texture of this.textures) {
      try { this.gl.deleteTexture(texture); } catch { /* contexto perdido */ }
    }
    this.textures.clear();
    this.fallbacks.clear();
    this.cache = new WeakMap();
    this.disposed = true;
  }
}

/* ------------------------------- uniformes -------------------------------- */

/** @private Indica tipos de sampler (2D/cube/3D/array). */
function isSamplerType(type) {
  return type === 0x8b5e || type === 0x8b60 || type === 0x8b5f || type === 0x8a11;
}

/** @private Empacota vetores e arrays de vetores (uniformNfv). */
function vectorPayload(value, components) {
  if (typeof value === 'string') return toVector(value, components);
  if (value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)) {
    if (typeof value.x === 'number' || typeof value.r === 'number') return toVector(value, components);
  }
  const flat = toFloat32(value);
  if (flat.length >= components) return flat;
  const out = new Float32Array(components);
  out.set(flat);
  return out;
}

/** @private Converte qualquer valor numérico em Float32Array. */
function toFloat32(value) {
  if (ArrayBuffer.isView(value)) return value instanceof Float32Array ? value : new Float32Array(value);
  if (typeof value === 'number') return new Float32Array([value]);
  if (Array.isArray(value)) {
    if (Array.isArray(value[0]) || ArrayBuffer.isView(value[0])) {
      const out = [];
      for (const item of value) out.push(...item);
      return new Float32Array(out);
    }
    return new Float32Array(value);
  }
  if (value && typeof value === 'object') {
    const keys = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'];
    const out = [];
    for (const key of keys) if (typeof value[key] === 'number') out.push(value[key]);
    return new Float32Array(out);
  }
  return new Float32Array([Number(value) || 0]);
}

/** @private Normaliza um valor de cor/vetor para o número de componentes. */
function toVector(value, components = 3) {
  let out;
  if (typeof value === 'string') {
    const c = parseColor(value, [1, 1, 1, 1]);
    out = [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3]];
  } else if (ArrayBuffer.isView(value)) {
    out = Array.from(value);
  } else if (Array.isArray(value)) {
    out = value.flat ? value.flat(4) : value;
  } else if (value && typeof value === 'object') {
    if (typeof value.x === 'number') out = [value.x, value.y ?? 0, value.z ?? 0, value.w ?? 1];
    else if (typeof value.r === 'number') out = [value.r, value.g ?? 0, value.b ?? 0, value.a ?? 1];
    else out = [0, 0, 0, 1];
  } else {
    out = [Number(value) || 0];
  }
  const result = new Float32Array(components);
  for (let i = 0; i < components; i++) result[i] = Number(out[i] ?? 0);
  return result;
}

/**
 * Gerencia uniformes de um programa: introspecção de tipos/localizações,
 * dispatch por tipo, unidades de textura e fallbacks neutros.
 */
export class UniformBinder {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {WebGLProgram} program
   * @param {object} [options]
   * @param {TextureCache} [options.textureCache]
   * @param {boolean} [options.ownsTextureCache=false]
   */
  constructor(gl, program, options = {}) {
    this.gl = gl;
    this.program = program;
    this.textureCache = options.textureCache ?? new TextureCache(gl);
    this.ownsTextureCache = options.ownsTextureCache ?? !options.textureCache;
    this.uniforms = new Map();
    this.textureUnits = new Map();
    this.nextUnit = 0;
    this._material = null;
    this._materialVersion = -1;
    this._introspect();
  }

  /** @private Lê todos os uniforms ativos do programa. */
  _introspect() {
    const gl = this.gl;
    if (!gl || typeof gl.getProgramParameter !== 'function') return;
    const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(this.program, i);
      if (!info) continue;
      const name = String(info.name).replace(/\[0\]$/, '');
      let location = gl.getUniformLocation(this.program, info.name);
      if (location === null || location === undefined) {
        // Alguns drivers só aceitam o nome base para arrays de uniformes.
        location = gl.getUniformLocation(this.program, name);
      }
      if (location === null || location === undefined) continue;
      this.uniforms.set(name, {
        name,
        glName: info.name,
        type: info.type,
        typeName: GL_UNIFORM_TYPES[info.type] ?? 'unknown',
        size: info.size ?? 1,
        location,
      });
    }
  }

  /** Lista os nomes de uniformes ativos. */
  get activeNames() { return [...this.uniforms.keys()]; }

  /** Indica se o uniforme existe/está ativo. */
  has(name) { return this.uniforms.has(name); }

  /** Tipo GLSL de um uniforme (`vec3`, `sampler2D`, ...). */
  typeOf(name) { return this.uniforms.get(name)?.typeName ?? null; }

  /**
   * Define um uniforme pelo nome. Ignora silenciosamente nomes otimizados
   * pelo driver (não presentes no programa).
   *
   * @returns {boolean} true se o valor foi enviado
   */
  set(name, value) {
    const uniform = this.uniforms.get(name);
    if (!uniform) return false;
    const gl = this.gl;
    const loc = uniform.location;

    // Samplers: delega para bindTexture (com fallback neutro).
    if (isSamplerType(uniform.type)) {
      return this.bindTexture(name, value);
    }
    if (value === null || value === undefined) return false;

    switch (uniform.type) {
      case 0x1406: // float
        if (Array.isArray(value) || ArrayBuffer.isView(value)) gl.uniform1fv(loc, toFloat32(value));
        else gl.uniform1f(loc, Number(value) || 0);
        return true;
      case 0x8b50: // vec2
        gl.uniform2fv(loc, vectorPayload(value, 2));
        return true;
      case 0x8b51: // vec3
        gl.uniform3fv(loc, vectorPayload(value, 3));
        return true;
      case 0x8b52: // vec4
        gl.uniform4fv(loc, vectorPayload(value, 4));
        return true;
      case 0x1404: // int
      case 0x8b56: // bool
        if (Array.isArray(value) || ArrayBuffer.isView(value)) gl.uniform1iv(loc, new Int32Array(value));
        else gl.uniform1i(loc, Math.round(Number(value) || 0));
        return true;
      case 0x8b5a: // mat2
        gl.uniformMatrix2fv(loc, false, toFloat32(value));
        return true;
      case 0x8b5b: // mat3
        gl.uniformMatrix3fv(loc, false, toFloat32(value));
        return true;
      case 0x8b5c: // mat4
        gl.uniformMatrix4fv(loc, false, toFloat32(value));
        return true;
      default:
        return false;
    }
  }

  /** Define vários uniformes; ignora entradas nulas. */
  setAll(uniforms = {}) {
    if (!uniforms) return this;
    for (const key of Object.keys(uniforms)) {
      if (uniforms[key] === undefined) continue;
      this.set(key, uniforms[key]);
    }
    return this;
  }

  /** Alias semântico de `setAll`. */
  setUniforms(uniforms = {}) { return this.setAll(uniforms); }

  /**
   * Vincula uma textura a um sampler, alocando (uma vez) uma unidade.
   * Valores aceitos: WebGLTexture, saída de sprites.js, `{texture}`, canvas,
   * ImageData, ImageBitmap ou `null` (fallback neutro).
   */
  bindTexture(name, value, options = {}) {
    const uniform = this.uniforms.get(name);
    if (!uniform) return false;
    const gl = this.gl;

    let texture = null;
    if (value) {
      if (isWebGLTexture(value)) texture = value;
      else if (value.texture && isWebGLTexture(value.texture)) texture = value.texture;
      else texture = this.textureCache.get(value, options);
    }
    if (!texture) texture = this.textureCache.getFallback(name);

    let unit = this.textureUnits.get(name);
    if (unit === undefined) {
      const maxUnits = (gl.getParameter?.(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) || 16);
      unit = this.nextUnit % Math.max(1, maxUnits);
      this.nextUnit++;
      this.textureUnits.set(name, unit);
    }
    if (typeof gl.activeTexture === 'function') gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniform.location, unit);
    return true;
  }

  /** Vincula um mapa `{ uSampler: source }`. */
  bindTextures(textures = {}) {
    if (!textures) return this;
    for (const key of Object.keys(textures)) this.bindTexture(key, textures[key]);
    return this;
  }

  /**
   * Aplica um material e, em seguida, uniformes de frame (câmera/matrizes),
   * que têm precedência. Materiais só são reenviados quando mudam de versão.
   *
   * @param {Material|object} material
   * @param {object} [frame]
   */
  apply(material = null, frame = null) {
    if (material) {
      const version = material.version ?? 0;
      if (this._material !== material || this._materialVersion !== version) {
        this.setAll(material.uniforms ?? material);
        if (material.textures) this.bindTextures(material.textures);
        this._bindMissingSamplers();
        this._material = material;
        this._materialVersion = version;
      }
    } else {
      this._bindMissingSamplers();
    }
    if (frame) this.setAll(frame);
    return this;
  }

  /** @private Garante textura válida em todo sampler ainda não vinculado. */
  _bindMissingSamplers() {
    for (const [name, uniform] of this.uniforms) {
      if (!isSamplerType(uniform.type)) continue;
      if (!this.textureUnits.has(name)) this.bindTexture(name, null);
    }
    return this;
  }

  /** Esquece o cache de material (força reenvio no próximo frame). */
  invalidate() {
    this._material = null;
    this._materialVersion = -1;
    return this;
  }

  dispose() {
    if (this.ownsTextureCache) this.textureCache.dispose();
    this.uniforms.clear();
    this.textureUnits.clear();
  }
}

/**
 * Programa WebGL compilado com acesso de alto nível a uniformes, atributos,
 * texturas e estado de renderização sugerido.
 */
export class ShaderProgram {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {object} options `vertex`, `fragment`, `name`, `defines`, `version`
   * @param {boolean} [options.throwOnError=true] lança em falha de compilação/link
   * @param {(diagnostic:object) => void} [options.onError] recebe o diagnóstico
   *   mesmo quando `throwOnError` é false (log anotado, estágio e fonte)
   * @param {TextureCache} [options.textureCache] cache compartilhável
   */
  constructor(gl, options = {}) {
    if (!gl) throw new Error('shaders.js: contexto WebGL ausente.');
    this.gl = gl;
    this.name = options.name ?? 'program';
    this.label = options.label ?? this.name;
    this.version = options.version ?? GLSL_VERSION_100;
    this.defines = { ...(options.defines ?? {}) };
    this.attributes = options.attributes ?? [];
    this.samplers = options.samplers ?? [];
    this.renderState = resolveRenderState(options.renderState);
    this.throwOnError = options.throwOnError !== false;
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this.compileError = null;
    this.program = null;

    let vs = null;
    let fs = null;
    try {
      vs = compileShaderSource(gl, gl.VERTEX_SHADER, options.vertex, { label: `${this.name}.vert` });
      fs = compileShaderSource(gl, gl.FRAGMENT_SHADER, options.fragment, { label: `${this.name}.frag` });
      this.program = linkShaderProgram(gl, vs, fs, { label: this.name, attributes: this.attributes });
    } catch (error) {
      this.compileError = {
        stage: error.shaderStage ?? 'link',
        label: error.label ?? this.name,
        log: error.log ?? '',
        source: error.source ?? '',
        report: error.message,
      };
      if (this.onError) {
        try { this.onError(this.compileError); } catch { /* callback não mascara o erro original */ }
      }
      if (this.throwOnError) throw error;
    } finally {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
    }
    this.linkStatus = !!this.program;

    this.textureCache = options.textureCache ?? new TextureCache(gl);
    this._ownsTextureCache = !options.textureCache;
    this.binder = new UniformBinder(gl, this.program, {
      textureCache: this.textureCache,
      ownsTextureCache: this._ownsTextureCache,
    });
    this._attributeLocations = new Map();
    this.disposed = false;
  }

  /** Programa compilado bruto. */
  get handle() { return this.program; }

  /** Nomes ativos de uniformes. */
  get activeUniforms() { return this.binder.activeNames; }

  /** Ativa o programa para desenho. */
  use() {
    if (this.disposed) throw new Error(`shaders.js: programa "${this.name}" já foi liberado.`);
    if (this.program) this.gl.useProgram(this.program);
    return this;
  }

  /** Define um uniforme (ativa o programa antes). */
  setUniform(name, value) {
    this.use();
    this.binder.set(name, value);
    return this;
  }

  /** Define vários uniformes. */
  setUniforms(uniforms = {}) {
    this.use();
    this.binder.setAll(uniforms);
    return this;
  }

  /** Vincula uma textura a um sampler. */
  bindTexture(name, value, options) {
    this.use();
    this.binder.bindTexture(name, value, options);
    return this;
  }

  /** Aplica material + uniformes de frame. */
  setMaterial(material, frame = null) {
    this.use();
    this.binder.apply(material, frame);
    return this;
  }

  /** Localização (cacheada) de um atributo; −1 se ausente/otimizado. */
  getAttributeLocation(name) {
    if (this._attributeLocations.has(name)) return this._attributeLocations.get(name);
    if (!this.program) return -1;
    const location = this.gl.getAttribLocation(this.program, name);
    this._attributeLocations.set(name, location);
    return location;
  }

  /**
   * Configura um atributo a partir de dados ou de um buffer já existente.
   * @returns {this}
   */
  setAttribute(name, data, options = {}) {
    const gl = this.gl;
    const location = this.getAttributeLocation(name);
    if (location < 0) return this;
    let buffer = options.buffer ?? null;
    if (!buffer) {
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, options.usage ?? gl.STATIC_DRAW);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    }
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      options.size ?? 3,
      options.type ?? gl.FLOAT,
      !!options.normalized,
      options.stride ?? 0,
      options.offset ?? 0,
    );
    if (options.divisor && typeof gl.vertexAttribDivisor === 'function') {
      gl.vertexAttribDivisor(location, options.divisor);
    }
    this._attributeBuffers = this._attributeBuffers ?? new Map();
    this._attributeBuffers.set(name, buffer);
    return this;
  }

  /**
   * Desenha com o programa ativo.
   * @param {number} count vértices/índices
   * @param {object} [options]
   */
  draw(count, options = {}) {
    if (!this.program) return this;
    const gl = this.gl;
    this.use();
    const mode = options.mode ?? gl.TRIANGLES;
    const offset = options.offset ?? 0;
    if (options.indexType || options.indices) {
      gl.drawElements(mode, count, options.indexType ?? gl.UNSIGNED_SHORT, offset);
    } else {
      gl.drawArrays(mode, offset, count);
    }
    return this;
  }

  /** Libera programa, buffers de atributos auxiliares e texturas próprias. */
  dispose() {
    if (this.disposed) return;
    const gl = this.gl;
    if (this._attributeBuffers) {
      for (const buffer of this._attributeBuffers.values()) {
        try { gl.deleteBuffer(buffer); } catch { /* ignore */ }
      }
      this._attributeBuffers.clear();
    }
    this.binder.dispose();
    if (this.program) {
      try { gl.deleteProgram(this.program); } catch { /* ignore */ }
    }
    this.program = null;
    this.disposed = true;
  }
}

/**
 * Atalho: compila e devolve um `ShaderProgram` a partir de um programa
 * nomeado (`buildShaderSource`) ou de fontes explícitas.
 */
export function createProgram(gl, options = {}) {
  if (options.name && PROGRAM_NAMES.includes(options.name) && !options.vertex) {
    const built = buildShaderSource(options.name, options);
    return new ShaderProgram(gl, { ...built, ...options });
  }
  return new ShaderProgram(gl, options);
}

/* ------------------------- estado de renderização ------------------------- */

/** Modos de blend prontos. */
export const BLEND_MODES = deepFreeze({
  none: null,
  alpha: { src: 'SRC_ALPHA', dst: 'ONE_MINUS_SRC_ALPHA' },
  premultiplied: { src: 'ONE', dst: 'ONE_MINUS_SRC_ALPHA' },
  additive: { src: 'SRC_ALPHA', dst: 'ONE' },
  glow: { src: 'ONE', dst: 'ONE' },
});

/** Faces para culling. */
export const CULL_FACES = Object.freeze({ none: null, back: 'BACK', front: 'FRONT', both: 'FRONT_AND_BACK' });

/**
 * Normaliza um estado de renderização (aceita nome de programa, string de
 * blend ou objeto parcial).
 */
export function resolveRenderState(state) {
  let input = state;
  if (typeof input === 'string' && PROGRAM_RENDER_STATE[input]) input = PROGRAM_RENDER_STATE[input];
  else if (typeof input === 'string') input = { blend: input };
  const s = input ?? {};
  let blend = s.blend ?? null;
  if (typeof blend === 'string') blend = BLEND_MODES[blend] ?? null;
  return {
    depthTest: s.depthTest !== false,
    depthWrite: s.depthWrite !== false,
    depthFunc: s.depthFunc ?? 'LEQUAL',
    blend,
    cullFace: s.cullFace ?? 'back',
    colorWrite: s.colorWrite ?? true,
  };
}

/**
 * Aplica estado de renderização (depth, blend, culling, colorMask).
 * Aceita `BLEND_MODES`, nomes de programa e objetos parciais.
 */
export function applyRenderState(gl, state = {}) {
  if (!gl) return null;
  const s = resolveRenderState(state);
  if (s.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  gl.depthMask(!!s.depthWrite);
  if (gl.depthFunc) {
    const fn = { NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207 }[s.depthFunc];
    if (fn !== undefined) gl.depthFunc(fn);
  }
  if (s.blend) {
    gl.enable(gl.BLEND);
    const src = gl[s.blend.src] ?? gl.ONE;
    const dst = gl[s.blend.dst] ?? gl.ZERO;
    gl.blendFunc(src, dst);
    if (gl.blendEquation) gl.blendEquation(gl.FUNC_ADD);
  } else {
    gl.disable(gl.BLEND);
  }
  if (!s.cullFace || s.cullFace === 'none') {
    gl.disable(gl.CULL_FACE);
  } else {
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl[s.cullFace] ?? gl.BACK);
  }
  if (gl.colorMask) gl.colorMask(!!s.colorWrite, !!s.colorWrite, !!s.colorWrite, !!s.colorWrite);
  return s;
}

/* ------------------------------- geometria -------------------------------- */

/** Gera uma esfera UV indexada (posições, normais, uvs e índices). */
export function createSphereGeometry(options = {}) {
  const radius = options.radius ?? 1;
  const segments = clamp(Math.round(options.segments ?? 64), 3, 512);
  const rings = clamp(Math.round(options.rings ?? Math.max(2, Math.round(segments / 2))), 2, 256);
  const vertexCount = (segments + 1) * (rings + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const lat = (0.5 - v) * PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const lon = u * TAU;
      const x = cosLat * Math.cos(lon);
      const y = sinLat;
      const z = cosLat * Math.sin(lon);
      const index = (j * (segments + 1) + i);
      positions[index * 3] = x * radius;
      positions[index * 3 + 1] = y * radius;
      positions[index * 3 + 2] = z * radius;
      normals[index * 3] = x;
      normals[index * 3 + 1] = y;
      normals[index * 3 + 2] = z;
      uvs[index * 2] = u;
      uvs[index * 2 + 1] = v;
    }
  }

  const indices = new (vertexCount > 65535 ? Uint32Array : Uint16Array)(segments * rings * 6);
  let ptr = 0;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i;
      const b = a + segments + 1;
      const c = b + 1;
      const d = a + 1;
      indices[ptr++] = a;
      indices[ptr++] = c;
      indices[ptr++] = b;
      indices[ptr++] = a;
      indices[ptr++] = d;
      indices[ptr++] = c;
    }
  }

  return {
    positions, normals, uvs, indices,
    radius, segments, rings, vertexCount,
    indexCount: indices.length,
    indexed: true,
    indexType: indices instanceof Uint32Array ? 'UINT32' : 'UINT16',
  };
}

/** Gera um quad de tela cheia (clip space) com UVs. */
export function createQuadGeometry() {
  return {
    positions: new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
    indices: null,
    vertexCount: 6,
    indexCount: 6,
    indexed: false,
    indexType: 'UINT16',
  };
}

const ATTRIBUTE_SIZES = Object.freeze({ aPosition: 3, aNormal: 3, aUv: 2, aTangent: 3, aColor: 4 });

/**
 * Malha GPU com buffers de atributos e desenho indexado.
 * Compatível com qualquer `ShaderProgram` que exponha `getAttributeLocation`.
 */
export class Mesh {
  constructor(gl, geometry) {
    if (!gl) throw new Error('shaders.js: contexto WebGL ausente para a malha.');
    this.gl = gl;
    this.geometry = geometry;
    this.buffers = new Map();
    this.indexBuffer = null;
    this.indexCount = geometry.indexCount ?? 0;
    this.vertexCount = geometry.vertexCount ?? 0;
    this.mode = gl.TRIANGLES;
    this.disposed = false;

    const sources = [
      ['aPosition', geometry.positions],
      ['aNormal', geometry.normals],
      ['aUv', geometry.uvs],
    ];
    for (const [name, data] of sources) {
      if (!data) continue;
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      this.buffers.set(name, buffer);
    }
    if (geometry.indices) {
      this.indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
      this.indexType = geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  /** Vincula os atributos e desenha. `options.attributes` limita os atributos. */
  draw(program, options = {}) {
    if (this.disposed || !program) return this;
    const gl = this.gl;
    if (typeof program.use === 'function') program.use();
    const only = options.attributes ? new Set(options.attributes) : null;
    for (const [name, buffer] of this.buffers) {
      if (only && !only.has(name)) continue;
      const location = typeof program.getAttributeLocation === 'function'
        ? program.getAttributeLocation(name)
        : gl.getAttribLocation(program.program ?? program, name);
      if (location < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, ATTRIBUTE_SIZES[name] ?? 3, gl.FLOAT, false, 0, 0);
    }
    if (this.indexBuffer) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.drawElements(this.mode, options.count ?? this.indexCount, this.indexType, options.offset ?? 0);
    } else {
      gl.drawArrays(this.mode, options.offset ?? 0, options.count ?? this.vertexCount);
    }
    return this;
  }

  dispose() {
    if (this.disposed) return;
    for (const buffer of this.buffers.values()) this.gl.deleteBuffer(buffer);
    if (this.indexBuffer) this.gl.deleteBuffer(this.indexBuffer);
    this.buffers.clear();
    this.disposed = true;
  }
}

/** Cria uma malha esférica pronta para os programas de planeta/nuvens. */
export function createSphereMesh(gl, options = {}) {
  return new Mesh(gl, createSphereGeometry(options));
}

/** Cria um quad de tela cheia (6 vértices). */
export function createQuadMesh(gl) {
  return new Mesh(gl, createQuadGeometry());
}

/* ========================================================================== */
/*  9. Materiais e integração com physics.js / atmosphere.js / sprites.js     */
/* ========================================================================== */

/**
 * Material de renderização: conjunto de uniformes, texturas, defines e
 * estado de renderização. A versão é incrementada a cada alteração e usada
 * pelo `UniformBinder` para evitar reenvios redundantes.
 */
export class Material {
  /**
   * @param {object} [options]
   * @param {string} [options.name='material']
   * @param {string} [options.program='planet']
   * @param {object} [options.uniforms]
   * @param {object} [options.textures]
   * @param {object} [options.defines]
   * @param {object} [options.renderState]
   * @param {object} [options.meta]
   */
  constructor(options = {}) {
    this.name = options.name ?? 'material';
    this.program = options.program ?? 'planet';
    this.uniforms = options.uniforms ?? {};
    this.textures = options.textures ?? {};
    this.defines = { ...(options.defines ?? {}) };
    this.renderState = resolveRenderState(options.renderState ?? PROGRAM_RENDER_STATE[this.program] ?? null);
    this.meta = options.meta ?? {};
    this.version = 0;
    this.disposed = false;
  }

  /** Atualiza um uniforme (incrementa a versão se o valor mudou). */
  set(name, value) {
    if (this.uniforms[name] === value) return this;
    this.uniforms[name] = value;
    this.version++;
    return this;
  }

  /** Atualiza vários uniformes de uma vez. */
  setAll(uniforms = {}) {
    let changed = false;
    for (const key of Object.keys(uniforms)) {
      if (this.uniforms[key] === uniforms[key]) continue;
      this.uniforms[key] = uniforms[key];
      changed = true;
    }
    if (changed) this.version++;
    return this;
  }

  /** Atualiza o mapa de texturas (sampler → fonte). */
  setTextures(textures = {}) {
    Object.assign(this.textures, textures);
    this.version++;
    return this;
  }

  /** Define/redefine uma textura. */
  setTexture(name, source) {
    this.textures[name] = source;
    this.version++;
    return this;
  }

  /** Atualiza o estado de renderização (string, objeto parcial ou nome). */
  setRenderState(state) {
    this.renderState = resolveRenderState(state);
    this.version++;
    return this;
  }

  /** Cópia independente (uniformes/defines profundos, texturas compartilhadas). */
  clone(overrides = {}) {
    return new Material({
      ...this,
      ...overrides,
      name: overrides.name ?? this.name,
      uniforms: { ...cloneUniformValue(this.uniforms), ...(overrides.uniforms ?? {}) },
      textures: { ...this.textures, ...(overrides.textures ?? {}) },
      defines: { ...this.defines, ...(overrides.defines ?? {}) },
      meta: { ...this.meta, ...(overrides.meta ?? {}) },
    });
  }

  /** Serialização (converte typed arrays em arrays comuns). */
  toJSON() {
    const uniforms = {};
    for (const [key, value] of Object.entries(this.uniforms)) {
      uniforms[key] = ArrayBuffer.isView(value) ? Array.from(value) : value;
    }
    return {
      name: this.name,
      program: this.program,
      uniforms,
      textures: Object.keys(this.textures),
      defines: { ...this.defines },
      renderState: this.renderState,
      meta: this.meta,
      version: this.version,
    };
  }
}

/* ------------------------------ utilitários ------------------------------- */

/** @private Normaliza direção/posição para vec3. */
function asVec3(value, fallback = [0, 0, 0]) {
  if (!value) return [...fallback];
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }
  if (typeof value === 'object') {
    return [Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0];
  }
  return [...fallback];
}

/** @private Cor CSS/array → array linear [r,g,b]. */
function linearColor(value, fallback = [1, 1, 1]) {
  if (value === undefined || value === null) return [...fallback];
  if (Array.isArray(value) && value.length >= 3 && value.every((v) => typeof v === 'number')) {
    // Arrays já são tratados como lineares pelo restante do módulo.
    return [value[0], value[1], value[2]];
  }
  return colorToLinear(value, [0, 0, 0]);
}

/** @private Resolve sol (direção, cor linear, intensidade) das opções. */
function resolveSun(options = {}) {
  const sun = options.sun ?? {};
  const direction = normalize3(asVec3(sun.direction ?? options.sunDirection ?? options.direction ?? [0.78, 0.36, 0.51]));
  const color = linearColor(sun.color ?? options.sunColor, [1, 0.97, 0.92]);
  const intensity = Math.max(0, sun.intensity ?? options.sunIntensity ?? 3.2);
  return { direction, color, intensity };
}

/**
 * Direção do Sol a partir das posições SI de `physics.js`.
 *
 * Aceita `Body`/`Spacecraft` (x, y, z), `{position}` ou arrays. A direção
 * devolvida aponta do corpo-alvo para o Sol, exatamente como `uSunDirection`
 * usado pelos shaders (`dot(N, L)`). A distância não influencia a direção;
 * `color`/`intensity` podem ser passados em `options` ou em `options.sun`.
 *
 * @example
 *   const sun = sunFromBodies(physics.getBody('Sol'), earth);
 *   const material = createPlanetMaterial(texture, { sun });
 *
 * @param {object|number[]} sunBody corpo do Sol (physics.js)
 * @param {object|number[]} [targetBody=[0,0,0]] corpo iluminado
 * @param {object} [options] `{ color, intensity, sun: { color, intensity } }`
 * @returns {{direction:number[],color:number[],intensity:number,distance:number}}
 */
export function sunFromBodies(sunBody, targetBody = [0, 0, 0], options = {}) {
  const read = (value) => {
    if (!value) return null;
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
    }
    if (value.position !== undefined) return read(value.position);
    if (typeof value.x === 'number' || typeof value.y === 'number' || typeof value.longitude === 'number') {
      return [
        Number(value.x ?? value.longitude) || 0,
        Number(value.y ?? value.latitude) || 0,
        Number(value.z ?? value.altitude) || 0,
      ];
    }
    return null;
  };
  const sunPos = read(sunBody);
  if (!sunPos) throw new TypeError('shaders.js: sunFromBodies requer um corpo/posição do Sol.');
  const target = read(targetBody) ?? [0, 0, 0];
  const delta = [sunPos[0] - target[0], sunPos[1] - target[1], sunPos[2] - target[2]];
  const distance = Math.hypot(delta[0], delta[1], delta[2]);
  const sunOptions = { sun: { ...(options.sun ?? {}) } };
  if (options.color !== undefined && sunOptions.sun.color === undefined) sunOptions.sun.color = options.color;
  if (options.intensity !== undefined && sunOptions.sun.intensity === undefined) sunOptions.sun.intensity = options.intensity;
  const base = resolveSun(sunOptions);
  const direction = distance > 1e-9 ? [delta[0] / distance, delta[1] / distance, delta[2] / distance] : base.direction;
  return { direction, color: base.color, intensity: base.intensity, distance };
}

/** @private Fonte de imagem aceita por WebGL (canvas, ImageData, textura...). */
function isImageSource(value) {
  if (!value || typeof value !== 'object') return false;
  return !!(
    isWebGLTexture(value) || value.canvas || value.image || value.bitmap
    || value.texture || value.imageData
    || typeof value.getContext === 'function'
    || (value.data && value.width && value.height)
  );
}

/**
 * @private Identifica uma textura de sprites.js, o resultado de
 * `uploadPlanetTexture` (`{albedo, normal, specular, emissive, cloud}`) ou
 * qualquer coleção de mapas de imagem.
 */
function looksLikeTexture(value) {
  if (!value || typeof value !== 'object') return false;
  return !!(
    value.canvas || value.imageData || value.normalMap || value.specularMap
    || value.emissiveMap || value.cloudMap || value.heightMap || value.heightField
    || value.glTexture || value.glTextures || Array.isArray(value.buffers)
    || isImageSource(value.albedo) || isImageSource(value.normal)
    || isImageSource(value.specular) || isImageSource(value.emissive)
    || isImageSource(value.cloud) || isImageSource(value.height)
    || (value.textures && (
      isImageSource(value.textures.albedo) || isImageSource(value.textures.uAlbedoMap)
      || isImageSource(value.textures.canvas)
    ))
    || typeof value.getContext === 'function'
    || (value.data && value.width && value.height)
  );
}

/** @private Separa textura de sprites e preset nas opções da fábrica. */
function resolvePlanetSource(source, options = {}) {
  let presetInput = options.preset ?? 'earth';
  let texture = null;
  if (typeof source === 'string') {
    presetInput = source;
  } else if (source && typeof source === 'object') {
    if (looksLikeTexture(source)) {
      texture = source;
      presetInput = source.preset ?? presetInput;
    } else if (source.preset !== undefined) {
      presetInput = source.preset;
    } else if (source.type || source.palette || source.height || source.atmosphere || source.iceCaps) {
      presetInput = source;
    }
  }
  return { texture, presetInput };
}

/** @private Objeto de preset (sprites) ou fallback compacto por nome. */
const CLOUDLESS_PRESETS = new Set(['desert', 'mars', 'moon', 'mercury', 'io', 'europa']);

function resolvePresetObject(presetInput) {
  if (presetInput && typeof presetInput === 'object') return presetInput;
  if (typeof presetInput === 'string') {
    const key = BIOME_PRESET_ALIASES[presetInput.trim().toLowerCase()] ?? presetInput.trim().toLowerCase();
    const preset = BIOME_PRESETS[key] ?? BIOME_PRESETS.earth;
    return { ...preset, clouds: preset.clouds ?? !CLOUDLESS_PRESETS.has(key) };
  }
  return { ...BIOME_PRESETS.earth, clouds: true };
}

/** @private Extrai um mapa de sprites de forma tolerante. */
function spriteMap(texture, key, fallbackKeys = []) {
  if (!texture) return null;
  if (texture[key]) return texture[key];
  for (const alt of fallbackKeys) if (texture[alt]) return texture[alt];
  return null;
}

/* --------------------------- fábricas de materiais ------------------------ */

/**
 * Cria o material da superfície planetária a partir de uma textura de
 * `sprites.js` (ou de um preset/nome). Usa albedo, normal, especular,
 * emissivo, nuvens e heightfield, derivando biomas e propriedades PBR.
 *
 * @param {object|string} [source] textura de sprites, preset ou nome
 * @param {object} [options]
 * @param {object|string} [options.preset] preset quando `source` não o traz
 * @param {object} [options.biome] ajustes do perfil de biomas
 * @param {object} [options.atmosphere] estado de atmosphere.js
 * @param {object} [options.sun] `{ direction, color, intensity }`
 * @param {number} [options.metersPerUnit=1]
 * @param {number} [options.normalStrength=1]
 * @param {number} [options.cloudShadowStrength]
 * @param {number} [options.exposure=1]
 * @param {string} [options.name]
 * @returns {Material}
 */
export function createPlanetMaterial(source = {}, options = {}) {
  const opts = options ?? {};
  const { texture, presetInput } = resolvePlanetSource(source, opts);
  const presetObject = resolvePresetObject(presetInput);
  const biomeOverrides = (opts.biome ?? opts.biomeProfile);
  const biomeOptions = biomeOverrides && typeof biomeOverrides === 'object' && !Array.isArray(biomeOverrides)
    ? biomeOverrides
    : {};
  const derived = deriveBiomeProfile(texture?.preset ?? presetInput, biomeOptions);

  const sun = resolveSun(opts);
  const uniforms = createDefaultUniforms('planet');
  Object.assign(uniforms, buildBiomeUniforms(derived.profile, derived.colors, biomeOptions));
  Object.assign(uniforms, {
    uSunDirection: sun.direction,
    uSunColor: sun.color,
    uSunIntensity: sun.intensity,
    uSkyColor: linearColor(opts.skyColor, uniforms.uSkyColor),
    uGroundColor: linearColor(opts.groundColor, uniforms.uGroundColor),
    uAmbientIntensity: opts.ambientIntensity ?? uniforms.uAmbientIntensity,
    uExposure: opts.exposure ?? uniforms.uExposure,
    uPoleAxis: normalize3(asVec3(opts.poleAxis ?? opts.axis, [0, 1, 0])),
    uBodyType: derived.bodyType === 'gasGiant' ? 1 : 0,
    uGasGiantRoughness: presetObject.roughness ?? uniforms.uGasGiantRoughness,
    uNightLights: presetObject.nightLights === false ? 0 : (opts.nightLights ?? 1),
    uEmissiveIntensity: opts.emissiveIntensity ?? uniforms.uEmissiveIntensity,
    uNormalStrength: opts.normalStrength ?? uniforms.uNormalStrength,
    uNormalFlipY: opts.normalFlipY ? 1 : 0,
    uOceanWaveStrength: opts.oceanWaveStrength ?? uniforms.uOceanWaveStrength,
    uSpecularBoost: opts.specularBoost ?? uniforms.uSpecularBoost,
    uTime: opts.time ?? 0,
  });

  const atmosphereCfg = presetObject.atmosphere ?? null;
  if (atmosphereCfg?.color) {
    uniforms.uAtmosphereColor = colorToLinear(atmosphereCfg.color, uniforms.uAtmosphereColor);
    uniforms.uAtmosphereStrength = opts.atmosphereStrength
      ?? clamp((atmosphereCfg.halo ?? 1) * 0.32, 0, 1.5);
  }
  if (opts.atmosphere) {
    const bridge = atmosphereUniforms(opts.atmosphere, opts);
    uniforms.uAtmosphereStrength = opts.atmosphereStrength
      ?? clamp((atmosphereCfg?.halo ?? 1) * 0.32 * (0.6 + bridge.meta.atmosphereScale * 0.15), 0, 1.5);
  }

  const textures = {};
  const has = { albedo: 0, normal: 0, specular: 0, emissive: 0, cloud: 0, height: 0 };
  if (texture) {
    const albedo = spriteMap(texture, 'canvas', ['albedo', 'image', 'source', 'glTexture']);
    const normalMap = spriteMap(texture, 'normalMap', ['normal']);
    const specularMap = spriteMap(texture, 'specularMap', ['specular']);
    const emissiveMap = spriteMap(texture, 'emissiveMap', ['emissive']);
    const cloudMap = spriteMap(texture, 'cloudMap', ['cloud']);
    const heightMap = spriteMap(texture, 'heightMap', ['height']);

    if (albedo) { textures.uAlbedoMap = albedo; has.albedo = 1; }
    if (normalMap) { textures.uNormalMap = normalMap; has.normal = 1; }
    if (specularMap) { textures.uSpecularMap = specularMap; has.specular = 1; }
    if (emissiveMap && texture.emissiveActive !== false) { textures.uEmissiveMap = emissiveMap; has.emissive = 1; }
    if (cloudMap && texture.cloudActive !== false) { textures.uCloudMap = cloudMap; has.cloud = 1; }
    if (heightMap) { textures.uHeightMap = heightMap; has.height = 1; }

    const cloudsCfg = texture.preset?.clouds ?? presetObject.clouds ?? null;
    uniforms.uCloudShadowStrength = opts.cloudShadowStrength
      ?? (has.cloud ? 0.6 * clamp01(cloudsCfg?.opacity ?? 0.85) : 0);
    if (texture.atmosphere?.color) {
      uniforms.uAtmosphereColor = colorToLinear(texture.atmosphere.color, uniforms.uAtmosphereColor);
      uniforms.uAtmosphereStrength = opts.atmosphereStrength
        ?? clamp((texture.atmosphere.halo ?? 1) * 0.32, 0, 1.5);
    }
    if (Number.isFinite(texture.seed)) uniforms.uTime = opts.time ?? 0;
  }

  uniforms.uHasAlbedoMap = has.albedo;
  uniforms.uHasNormalMap = has.normal;
  uniforms.uHasSpecularMap = has.specular;
  uniforms.uHasEmissiveMap = has.emissive;
  uniforms.uHasCloudMap = has.cloud;
  uniforms.uHasHeightMap = has.height;
  if (!has.cloud) uniforms.uCloudShadowStrength = 0;
  if (!has.height && derived.profile.hasOcean === false) {
    uniforms.uBiomeParams = [0, 0, derived.profile.plainsLine, derived.profile.mountainLine];
  }

  for (const [key, value] of Object.entries(opts.uniforms ?? {})) uniforms[key] = value;

  return new Material({
    name: opts.name ?? `${derived.name ?? 'planeta'} (superfície)`,
    program: 'planet',
    uniforms,
    textures,
    defines: { ...(opts.defines ?? {}) },
    renderState: opts.renderState ?? PROGRAM_RENDER_STATE.planet,
    meta: {
      bodyType: derived.bodyType,
      biomeProfile: derived.profile,
      biomeColors: derived.colors,
      hasMaps: has,
      preset: presetObject,
      metersPerUnit: opts.metersPerUnit ?? 1,
      planetRadius: opts.body?.radius ?? opts.planetRadius ?? null,
    },
  });
}

/**
 * Cria o material de nuvens volumétricas a partir de um preset, array de
 * camadas, configuração de nuvens de sprites.js ou textura de planeta.
 *
 * @param {string|object|Array} [source='earthlike']
 * @param {object} [options]
 * @param {number} [options.planetRadius=6.371e6] metros
 * @param {number} [options.metersPerUnit=1]
 * @param {object} [options.atmosphere] estado de atmosphere.js
 * @param {object} [options.sun]
 * @param {object} [options.clouds] sobrescreve camadas/parâmetros
 * @returns {Material}
 */
export function createCloudMaterial(source = 'earthlike', options = {}) {
  const opts = options ?? {};
  let cloudInput = source;

  if (Array.isArray(source)) {
    cloudInput = source;
  } else if (source && typeof source === 'object') {
    if (looksLikeTexture(source)) {
      const presetClouds = source.preset?.clouds;
      cloudInput = presetClouds === null || presetClouds === false
        ? 'none'
        : (presetClouds ?? 'earthlike');
    } else if (source.clouds !== undefined) {
      cloudInput = source.clouds === null ? 'none' : source.clouds;
    } else {
      cloudInput = source;
    }
  }

  const atmosphereDeck = opts.atmosphere ? cloudDeckFromAtmosphere(opts.atmosphere, opts) : null;
  const cloudOverrides = opts.clouds && typeof opts.clouds === 'object' && !Array.isArray(opts.clouds)
    ? opts.clouds
    : {};
  const resolved = resolveCloudLayers(cloudInput, {
    color: opts.cloudColor,
    shadeColor: opts.cloudShade ?? opts.shadeColor,
    windSpeed: opts.windSpeed,
    windDirection: opts.windDirection,
    warp: opts.warp,
    baseAltitude: opts.baseAltitude ?? atmosphereDeck?.baseAltitude,
    topAltitude: opts.topAltitude ?? atmosphereDeck?.topAltitude,
    ...cloudOverrides,
  });

  const sun = resolveSun(opts);
  const planetRadius = opts.planetRadius ?? opts.body?.radius ?? 6.371e6;
  const built = buildCloudUniforms(resolved.layers, resolved.deck, {
    planetRadius,
    metersPerUnit: opts.metersPerUnit ?? 1,
    center: asVec3(opts.planetCenter ?? opts.center),
    time: opts.time ?? 0,
    colors: resolved.colors,
    sunDirection: sun.direction,
    sunColor: sun.color,
    sunIntensity: opts.cloudSunIntensity ?? sun.intensity * 0.9,
    skyColor: linearColor(opts.skyColor, [0.2, 0.3, 0.5]),
    groundColor: linearColor(opts.groundColor, [0.07, 0.06, 0.05]),
    exposure: opts.exposure ?? 1,
  });

  const uniforms = createDefaultUniforms('clouds');
  Object.assign(uniforms, built.uniforms, opts.uniforms ?? {});
  uniforms.uInsideShell = opts.insideShell ? 1 : 0;

  return new Material({
    name: opts.name ?? 'nuvens',
    program: 'clouds',
    uniforms,
    textures: {},
    defines: { ...(opts.defines ?? {}) },
    renderState: opts.renderState ?? PROGRAM_RENDER_STATE.clouds,
    meta: {
      layers: resolved.layers,
      deck: resolved.deck,
      radii: built.radii,
      planetRadius,
      metersPerUnit: opts.metersPerUnit ?? 1,
    },
  });
}

/**
 * Material da atmosfera (limbo/sky scattering) a partir do estado de
 * `atmosphere.js`. Se `state` for nulo, usa a atmosfera terrestre padrão.
 *
 * @param {object|null} [state]
 * @param {object} [options]
 * @returns {Material}
 */
export function createAtmosphereMaterial(state = null, options = {}) {
  const opts = options ?? {};
  const sun = resolveSun({ ...opts, sunIntensity: opts.atmosphereSunIntensity ?? opts.sunIntensity ?? 4 });
  const bridge = atmosphereUniforms(state, {
    ...opts,
    sunDirection: sun.direction,
    sunColor: sun.color,
    sunIntensity: sun.intensity,
  });
  const uniforms = createDefaultUniforms('atmosphere');
  Object.assign(uniforms, bridge.uniforms, opts.uniforms ?? {});
  return new Material({
    name: opts.name ?? 'atmosfera',
    program: 'atmosphere',
    uniforms,
    textures: {},
    defines: { ...(opts.defines ?? {}) },
    renderState: opts.renderState ?? PROGRAM_RENDER_STATE.atmosphere,
    meta: { ...bridge.meta, atmosphereState: state },
  });
}

/**
 * Material de nave/estrutura PBR, com painéis procedurais, brilho do motor e
 * calor de reentrada derivado da telemetria de `atmosphere.js`.
 *
 * @param {object} [options]
 * @param {string|object} [options.preset='hullWhite'] chave de PBR_MATERIALS
 * @param {object} [options.telemetry] `AtmosphereSystem#getTelemetry`
 * @param {number} [options.throttle=0] 0..1 → intensidade do motor
 * @returns {Material}
 */
export function createSpacecraftMaterial(options = {}) {
  const opts = options ?? {};
  const presetInput = opts.preset ?? 'hullWhite';
  const preset = typeof presetInput === 'object'
    ? presetInput
    : (PBR_MATERIALS[presetInput] ?? PBR_MATERIALS.hullWhite);
  const m = { ...preset, ...opts };
  const sun = resolveSun(opts);
  const uniforms = createDefaultUniforms('spacecraft');
  const body = opts.body ?? opts.spacecraft ?? null;
  const throttle = clamp01(opts.throttle ?? body?.throttle ?? 0);
  const velocity = opts.velocity
    ?? (body && Number.isFinite(body.vx) ? [body.vx, body.vy ?? 0, 0] : null);
  const heatDirection = opts.heatDirection ?? opts.windDirection ?? velocity;

  Object.assign(uniforms, {
    uBaseColor: linearColor(m.baseColor, uniforms.uBaseColor),
    uMetallic: clamp01(m.metallic ?? uniforms.uMetallic),
    uRoughness: clamp(m.roughness ?? uniforms.uRoughness, 0.02, 1),
    uReflectance: clamp01(m.reflectance ?? uniforms.uReflectance),
    uPanelColor: linearColor(m.panelColor ?? m.baseColor, uniforms.uPanelColor),
    uPanelScale: m.panelScale ?? uniforms.uPanelScale,
    uPanelRoughness: clamp(m.panelRoughness ?? uniforms.uPanelRoughness, 0.02, 1),
    uPanelMetallic: clamp01(m.panelMetallic ?? uniforms.uPanelMetallic),
    uPanelContrast: clamp01(m.panelContrast ?? uniforms.uPanelContrast),
    uUsePanelDetail: m.usePanelDetail === false ? 0 : 1,
    uEmissiveColor: linearColor(m.emissive ?? opts.emissiveColor, uniforms.uEmissiveColor),
    uEmissiveIntensity: m.emissiveIntensity ?? uniforms.uEmissiveIntensity,
    uEngineColor: linearColor(opts.engineColor ?? m.engineColor ?? '#7fd4ff', uniforms.uEngineColor),
    uEngineIntensity: opts.engineIntensity ?? throttle * 1.6,
    uEngineAxis: normalize3(asVec3(opts.engineAxis, [0, 0, -1])),
    uEngineFalloff: opts.engineFalloff ?? uniforms.uEngineFalloff,
    uHeatColor: linearColor(opts.heatColor ?? '#ff5a1e', uniforms.uHeatColor),
    uHeatDirection: heatDirection ? normalize3(asVec3(heatDirection, [1, 0, 0])) : [1, 0, 0],
    uHeatPower: opts.heatPower ?? uniforms.uHeatPower,
    uRimStrength: m.rimStrength ?? uniforms.uRimStrength,
    uAlpha: clamp01(opts.alpha ?? m.alpha ?? 1),
    uSunDirection: sun.direction,
    uSunColor: sun.color,
    uSunIntensity: sun.intensity,
    uSkyColor: linearColor(opts.skyColor, uniforms.uSkyColor),
    uGroundColor: linearColor(opts.groundColor, uniforms.uGroundColor),
    uAmbientIntensity: opts.ambientIntensity ?? uniforms.uAmbientIntensity,
    uExposure: opts.exposure ?? uniforms.uExposure,
    uTime: opts.time ?? 0,
  });

  const telemetry = atmosphereFromTelemetry(opts.telemetry ?? null, opts);
  uniforms.uHeatGlow = clamp01(opts.heatGlow ?? telemetry.heatGlow);
  uniforms.uEmissiveIntensity = m.emissiveIntensity ?? (opts.emissiveIntensity ?? uniforms.uEmissiveIntensity);
  for (const [key, value] of Object.entries(opts.uniforms ?? {})) uniforms[key] = value;

  const translucent = uniforms.uAlpha < 0.999;
  const renderState = opts.renderState
    ?? (translucent
      ? { ...PROGRAM_RENDER_STATE.spacecraft, blend: 'alpha', depthWrite: false }
      : PROGRAM_RENDER_STATE.spacecraft);

  return new Material({
    name: opts.name ?? `nave (${preset.label ?? presetInput})`,
    program: 'spacecraft',
    uniforms,
    textures: { ...(opts.textures ?? {}) },
    defines: { ...(opts.defines ?? {}) },
    renderState,
    meta: { preset: presetInput, telemetry, heatGlow: uniforms.uHeatGlow, alpha: uniforms.uAlpha },
  });
}

/** Alias: material de superfície a partir de uma textura de sprites.js. */
export const materialFromSprites = createPlanetMaterial;

/**
 * Cria o conjunto completo de renderização de um planeta: superfície,
 * nuvens e atmosfera, todos coerentes entre si.
 *
 * @param {object|string} [source] textura de sprites / preset / nome
 * @param {object} [options]
 * @returns {{surface:Material, clouds:Material|null, atmosphere:Material|null, textures:object, meta:object}}
 */
export function createPlanetRenderSet(source = {}, options = {}) {
  const opts = options ?? {};
  const surface = createPlanetMaterial(source, opts);
  const presetObject = surface.meta.preset ?? BIOME_PRESETS.earth;
  const planetRadius = opts.planetRadius ?? opts.body?.radius ?? 6.371e6;

  let clouds = null;
  const cloudSetting = presetObject?.clouds;
  if (opts.clouds !== false && cloudSetting !== null && cloudSetting !== false) {
    const cloudSource = looksLikeTexture(source) ? source : (presetObject?.clouds ?? opts.clouds ?? 'earthlike');
    clouds = createCloudMaterial(cloudSource, {
      ...opts,
      planetRadius,
      planetCenter: opts.planetCenter ?? opts.center,
      sun: opts.sun,
    });
  }

  let atmosphere = null;
  if (opts.atmosphere !== false) {
    const wantsAtmosphere = opts.atmosphere != null
      || presetObject?.atmosphere != null
      || presetObject?.clouds === true
      || presetObject?.type === 'gasGiant';
    if (wantsAtmosphere) {
      atmosphere = createAtmosphereMaterial(opts.atmosphere ?? null, { ...opts, planetRadius });
    }
  }

  return {
    surface,
    clouds,
    atmosphere,
    textures: surface.textures,
    meta: {
      name: surface.name,
      preset: presetObject,
      planetRadius,
      metersPerUnit: opts.metersPerUnit ?? 1,
      clouds: clouds?.meta ?? null,
      atmosphere: atmosphere?.meta ?? null,
    },
  };
}

/* ---------------------------- upload de texturas -------------------------- */

/**
 * Envia as texturas de um material para a GPU e substitui as fontes por
 * `WebGLTexture` (idempotente quando já são texturas). Útil quando o
 * renderizador quer separar criação de material e upload.
 *
 * @param {WebGLRenderingContext} gl
 * @param {Material} material
 * @param {object} [options] opções de upload/cache (`cache` compartilhável)
 * @returns {{textures:object, cache:TextureCache, dispose:() => void}}
 */
export function uploadMaterialTextures(gl, material, options = {}) {
  const cache = options.cache ?? new TextureCache(gl, options);
  const disposedByUs = !options.cache;
  const uploaded = {};
  for (const [name, source] of Object.entries(material?.textures ?? {})) {
    if (!source) continue;
    const texture = cache.get(source, options);
    if (texture) {
      uploaded[name] = texture;
      material.textures[name] = texture;
    }
  }
  material.version++;
  return {
    textures: uploaded,
    cache,
    dispose() { if (disposedByUs) cache.dispose(); },
  };
}

/**
 * Atualiza `uInsideShell` de um material de shell (nuvens/atmosfera) a
 * partir da câmera e do raio externo. Retorna `true` se a câmera está dentro.
 *
 * @param {Material} material
 * @param {number[]|object} cameraPosition
 * @param {number[]|object} center
 * @param {number} outerRadius
 * @returns {boolean}
 */
export function updateShellCamera(material, cameraPosition, center, outerRadius) {
  const cam = asVec3(cameraPosition);
  const c = asVec3(center);
  const inside = Math.hypot(cam[0] - c[0], cam[1] - c[1], cam[2] - c[2]) < outerRadius;
  material.set('uInsideShell', inside ? 1 : 0);
  return inside;
}

/**
 * Atualiza os uniformes de câmera/frame comuns aos programas.
 * @param {Material} material
 * @param {object} frame `{ cameraPosition, model, viewProjection, normalMatrix, time }`
 */
export function updateMaterialFrame(material, frame = {}) {
  if (!material || !frame) return material;
  if (frame.cameraPosition) material.set('uCameraPosition', asVec3(frame.cameraPosition));
  if (frame.planetCenter) material.set('uPlanetCenter', asVec3(frame.planetCenter));
  if (frame.planetRadius !== undefined) material.set('uPlanetRadius', Number(frame.planetRadius));
  if (frame.model) material.set('uModel', frame.model);
  if (frame.viewProjection) material.set('uViewProjection', frame.viewProjection);
  if (frame.normalMatrix) material.set('uNormalMatrix', frame.normalMatrix);
  if (frame.sunDirection) material.set('uSunDirection', normalize3(asVec3(frame.sunDirection)));
  if (frame.sunColor !== undefined) material.set('uSunColor', linearColor(frame.sunColor, [1, 1, 1]));
  if (frame.sunIntensity !== undefined) material.set('uSunIntensity', Number(frame.sunIntensity));
  if (frame.exposure !== undefined) material.set('uExposure', Number(frame.exposure));
  if (frame.time !== undefined) material.set('uTime', frame.time);
  return material;
}

/* ========================================================================== */
/*  10. ShaderLibrary — cache de variantes, compilação e liberação            */
/* ========================================================================== */

/** @private Serialização estável (ordem de chaves) para chaves de cache. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (ArrayBuffer.isView(value)) return `[${Array.from(value).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${key}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return String(value);
}

/**
 * Biblioteca de shaders: compila variantes sob demanda, mantém cache por
 * defines/versão, compartilha texturas e libera recursos corretamente.
 *
 * @example
 *   const lib = new ShaderLibrary(gl, { version: '300 es' });
 *   const planet = lib.get('planet', { defines: { QUALITY: 'high' } });
 *   planet.setMaterial(material, { cameraPosition, model, viewProjection });
 *   applyRenderState(gl, planet.renderState);
 *   sphere.draw(planet);
 *   lib.dispose();
 */
export class ShaderLibrary {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {object} [options]
   * @param {'100'|'300 es'} [options.version='100']
   * @param {object} [options.defines] defines globais
   * @param {boolean} [options.throwOnError=true]
   * @param {TextureCache} [options.textureCache]
   */
  constructor(gl, options = {}) {
    if (!gl) throw new Error('shaders.js: ShaderLibrary requer um contexto WebGL.');
    this.gl = gl;
    this.options = {
      version: options.version === GLSL_VERSION_300 ? GLSL_VERSION_300 : GLSL_VERSION_100,
      defines: { ...(options.defines ?? {}) },
      throwOnError: options.throwOnError !== false,
    };
    this.textureCache = options.textureCache ?? new TextureCache(gl);
    this._ownsTextureCache = !options.textureCache;
    this.variants = new Map();
    this.failures = new Map();
    this.stats = { compiles: 0, cacheHits: 0, failures: 0 };
  }

  /** @private Mescla opções da biblioteca com opções da variante. */
  _mergeOptions(options = {}) {
    const merged = {
      version: options.version === GLSL_VERSION_300
        || (!options.version && this.options.version === GLSL_VERSION_300)
        ? GLSL_VERSION_300
        : GLSL_VERSION_100,
      defines: { ...this.options.defines, ...(options.defines ?? {}) },
      throwOnError: options.throwOnError ?? this.options.throwOnError,
    };
    for (const key of ['steps', 'lightSteps', 'octaves', 'lightOctaves', 'ridgedOctaves']) {
      if (options[key] !== undefined) merged[key] = options[key];
    }
    return merged;
  }

  /** @private Chave estável de uma variante. */
  _key(name, merged) {
    const keyParts = { ...merged };
    delete keyParts.throwOnError;
    return `${name}::${stableStringify(keyParts)}`;
  }

  /** Indica se uma variante já está compilada. */
  has(name, options = {}) {
    return this.variants.has(this._key(name, this._mergeOptions(options)));
  }

  /** Gera (sem compilar) as fontes de uma variante. */
  sources(name, options = {}) {
    return buildShaderSource(name, this._mergeOptions(options));
  }

  /**
   * Compila (ou devolve do cache) um programa.
   * @param {string} name
   * @param {object} [options]
   * @returns {ShaderProgram|null}
   * @throws {Error} em falha de compilação quando `throwOnError` é true
   */
  get(name, options = {}) {
    const merged = this._mergeOptions(options);
    const key = this._key(name, merged);
    const cached = this.variants.get(key);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    const failure = this.failures.get(key);
    if (failure) {
      if (merged.throwOnError) throw failure;
      return null;
    }
    try {
      const built = buildShaderSource(name, merged);
      const program = new ShaderProgram(this.gl, {
        ...built,
        defines: built.defines,
        textureCache: this.textureCache,
      });
      this.variants.set(key, program);
      this.stats.compiles++;
      return program;
    } catch (error) {
      this.failures.set(key, error);
      this.stats.failures++;
      if (merged.throwOnError) throw error;
      return null;
    }
  }

  /** Programa para um material, herdando seus defines. */
  forMaterial(material, options = {}) {
    if (!material) throw new Error('shaders.js: material ausente.');
    return this.get(material.program ?? 'planet', {
      ...options,
      defines: { ...(material.defines ?? {}), ...(options.defines ?? {}) },
    });
  }

  /** Libera uma variante específica. */
  release(name, options = {}) {
    const key = this._key(name, this._mergeOptions(options));
    const program = this.variants.get(key);
    if (!program) return false;
    program.dispose();
    this.variants.delete(key);
    this.failures.delete(key);
    return true;
  }

  /** Libera todas as variantes compiladas. */
  clear() {
    for (const program of this.variants.values()) program.dispose();
    this.variants.clear();
    this.failures.clear();
    return this;
  }

  /** Nomes das variantes compiladas (para inspeção/depuração). */
  list() {
    return [...this.variants.keys()];
  }

  /** Libera tudo, incluindo as texturas próprias. */
  dispose() {
    this.clear();
    if (this._ownsTextureCache) this.textureCache.dispose();
    return this;
  }
}

/** Atalho de criação da biblioteca. */
export function createShaderLibrary(gl, options = {}) {
  return new ShaderLibrary(gl, options);
}

/* ========================================================================== */
/*  11. Namespace público                                                     */
/* ========================================================================== */

/**
 * Namespace congelado com toda a API pública, no mesmo espírito de
 * `sprites.js`: `import { shaders } from './shaders.js'`.
 */
export const shaders = Object.freeze({
  // programas e chunks
  SHADER_PROGRAMS,
  SHADER_CHUNKS,
  SHADER_UNIFORM_DEFAULTS,
  PROGRAM_NAMES,
  PROGRAM_RENDER_STATE,
  GL_UNIFORM_TYPES,
  GLSL_VERSION_100,
  GLSL_VERSION_300,
  buildShaderSource,
  buildAllShaderSources,
  composeShaderSource,
  upgradeShaderSource,
  createDefaultUniforms,
  resolveUniforms,
  // compilação
  ShaderProgram,
  ShaderLibrary,
  createProgram,
  createShaderLibrary,
  compileShaderSource,
  linkShaderProgram,
  deleteProgram,
  formatShaderLog,
  annotateShaderSource,
  // materiais/uniformes
  Material,
  UniformBinder,
  TextureCache,
  uploadShaderTexture,
  uploadMaterialTextures,
  applyRenderState,
  resolveRenderState,
  BLEND_MODES,
  CULL_FACES,
  updateShellCamera,
  updateMaterialFrame,
  // integração
  createPlanetMaterial,
  createCloudMaterial,
  createAtmosphereMaterial,
  createSpacecraftMaterial,
  createPlanetRenderSet,
  materialFromSprites,
  atmosphereUniforms,
  sunFromBodies,
  cloudDeckFromAtmosphere,
  atmosphereFromTelemetry,
  buildCloudUniforms,
  resolveCloudLayers,
  buildBiomeUniforms,
  deriveBiomeProfile,
  biomeWeights,
  biomeMaterial,
  // BRDF CPU
  ggxDistribution,
  distributionGGX,
  geometrySchlickGGX,
  geometrySmith,
  fresnelSchlick,
  fresnelSchlickRoughness,
  f0FromMaterial,
  evaluateCookTorranceBRDF,
  evaluateAmbientBRDF,
  // geometria
  createSphereGeometry,
  createSphereMesh,
  createQuadGeometry,
  createQuadMesh,
  Mesh,
  // constantes
  BIOME_IDS,
  BIOME_LABELS,
  BIOME_MATERIALS,
  BIOME_PRESETS,
  DEFAULT_BIOME_PROFILE,
  CLOUD_LAYER_COUNT,
  CLOUD_LAYER_DEFAULTS,
  CLOUD_DECK_DEFAULTS,
  CLOUD_PRESETS,
  PBR_MATERIALS,
  MATERIAL_PRESETS,
  DEFAULT_RAYLEIGH_COEFF,
  DEFAULT_MIE_COEFF,
  ATMOSPHERE_DEFAULTS,
  // utilitários
  parseColor,
  colorToLinear,
  samplePalette,
  srgbToLinear,
  linearToSrgb,
  perlin3,
  fbm3,
  ridged3,
});

export default ShaderLibrary;
