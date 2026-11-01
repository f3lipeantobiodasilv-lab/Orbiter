/* ============================================================================
 *  main.js — ORBITER · Módulo mestre de integração e loop principal
 * ============================================================================
 *
 *  Une os cinco módulos do simulador num único jogo executável:
 *
 *    physics.js         → PhysicsEngine (N-body RK4), Body, Spacecraft,
 *                         telemetria orbital (apogeu/perigeu/G/delta-v)
 *    atmosphere.js      → AtmosphereSystem (hook em engine.step): arrasto,
 *                         aquecimento (Sutton-Graves/Kemp-Riddell), plasma,
 *                         espalhamento Rayleigh/Mie, ventos
 *    sprites.js         → SpriteGenerator (texturas procedurais de planetas,
 *                         sprite da nave, atlas de partículas), HUD, câmera,
 *                         formatadores pt-BR
 *    shaders.js         → ShaderLibrary (GLSL Cook-Torrance PBR, nuvens
 *                         volumétricas, biomas), e ponte CPU: sunFromBodies,
 *                         atmosphereUniforms, atmosphereFromTelemetry,
 *                         evaluateCookTorranceBRDF, biomeWeights/biomeColor
 *    postprocessing.js  → Renderer unificado: cena 2D em camadas + pipeline
 *                         WebGL (tone mapping ACES, bloom, SSAO/SSR) ou
 *                         fallback CanvasPostFX, sombras suaves, HUD por cima
 *
 *  Loop principal: requestAnimationFrame → update(dt) do engine (a atmosfera
 *  é aplicada a cada sub-passo fixo via hook) → controlos → ponte de shaders →
 *  renderer.frame(dt) (cena + pós-processamento + HUD).
 *
 *  Como rodar: sirva a pasta por HTTP (módulos ES6 não funcionam via file://):
 *      python3 -m http.server 8000   →  http://localhost:8000/
 *  e abra index.html.
 * ========================================================================== */

import {
  PhysicsEngine, Body, Spacecraft,
  G_SI, AU_M, circularOrbitSpeed,
} from './physics.js';
import { createAtmosphereSystem } from './atmosphere.js';
import * as sprites from './sprites.js';
import * as shaders from './shaders.js';
import { createRenderer, POST_QUALITY_NAMES } from './postprocessing.js';

const { clamp, clamp01, lerp, wrapPi, TAU } = sprites;

/* ========================================================================== */
/*  1. Configuração da missão                                                 */
/* ========================================================================== */

const CONFIG = {
  fixedDt: 1 / 120,          // sub-passo fixo do integrador RK4 (s)
  softening: 1e3,            // softening gravitacional (m)
  warps: [1, 2, 5, 10, 25, 50, 100, 250, 1000, 2000],
  qualityOrder: POST_QUALITY_NAMES, // ['low','medium','high','ultra']
  ship: {
    name: 'Orbiter-1',
    dryMass: 9500,           // kg
    fuel: 6500,              // kg
    maxThrust: 5.6e5,        // N  (~3,6 g no lançamento)
    exhaustVelocity: 3050,   // m/s (kerolox)
    maxTorque: 3.2e5,        // N·m
    momentOfInertia: 6.5e4,  // kg·m²
    radius: 2.5,             // m (colisão)
    spawnAltitude: 250e3,    // órbita baixa de partida (m)
    spriteLength: 34,        // px na tela
    spriteConfig: { length: 220, boosters: 2, accent: '#ff5a3c', flame: { spectrum: 'kerolox' } },
  },
};

/* ========================================================================== */
/*  2. Construção do sistema solar (physics.js)                               */
/* ========================================================================== */

/**
 * Cria o engine N-body com Sol, Terra, Lua e Marte em órbitas circulares
 * heliocêntricas reais (SI), mais a nave do jogador em órbita baixa da Terra.
 */
function buildWorld() {
  const engine = new PhysicsEngine({
    G: G_SI,
    fixedDt: CONFIG.fixedDt,
    softening: CONFIG.softening,
    timeScale: 1,
    absorbCollisions: false,
  });

  // --- Sol (fixo, estrela) -------------------------------------------------
  const sun = new Body({
    name: 'Sol', x: 0, y: 0, vx: 0, vy: 0,
    mass: 1.98892e30, radius: 6.957e8, color: '#ffd98a', fixed: true,
  });
  sun.isStar = true;   // usado por findSun (postprocessing.js)
  sun.preset = 'venus'; // textura ardente no fallback
  engine.addBody(sun);

  // --- Terra ---------------------------------------------------------------
  const terra = new Body({
    name: 'Terra', x: AU_M, y: 0,
    vx: 0, vy: circularOrbitSpeed(G_SI * sun.mass, AU_M), // ~29,8 km/s
    mass: 5.9722e24, radius: 6.371e6, color: '#3f7fbf',
  });
  terra.preset = 'earth';
  terra.atmosphere = 'earth';                    // AtmosphereSystem resolve o preset
  terra.textureOptions = { width: 512, heightMap: true };
  engine.addBody(terra);

  // --- Lua (órbita em torno da Terra) ---------------------------------------
  const dMoon = 3.844e8;
  const lua = new Body({
    name: 'Lua',
    x: terra.x + dMoon, y: terra.y,
    vx: terra.vx, vy: terra.vy + circularOrbitSpeed(G_SI * terra.mass, dMoon),
    mass: 7.342e22, radius: 1.7374e6, color: '#9aa0a8',
  });
  lua.preset = 'moon';
  engine.addBody(lua);

  // --- Marte ----------------------------------------------------------------
  const marsDist = 1.524 * AU_M;
  const mars = new Body({
    name: 'Marte', x: marsDist, y: 0,
    vx: 0, vy: circularOrbitSpeed(G_SI * sun.mass, marsDist),
    mass: 6.4171e23, radius: 3.3895e6, color: '#c1623b',
  });
  mars.preset = 'mars';
  mars.atmosphere = 'mars';
  mars.textureOptions = { width: 512, heightMap: true };
  engine.addBody(mars);

  // --- Nave do jogador: órbita circular baixa (LEO) sobre a Terra ----------
  const r0 = terra.radius + CONFIG.ship.spawnAltitude;
  const v0 = circularOrbitSpeed(G_SI * terra.mass, r0);
  const ship = new Spacecraft({
    name: CONFIG.ship.name,
    x: terra.x + r0, y: terra.y,
    vx: terra.vx, vy: terra.vy + v0,
    dryMass: CONFIG.ship.dryMass,
    fuel: CONFIG.ship.fuel,
    maxThrust: CONFIG.ship.maxThrust,
    exhaustVelocity: CONFIG.ship.exhaustVelocity,
    maxTorque: CONFIG.ship.maxTorque,
    momentOfInertia: CONFIG.ship.momentOfInertia,
    radius: CONFIG.ship.radius,
    angle: Math.PI / 2, // prograde: velocidade +y
    color: '#dfe8f2',
  });
  ship.spriteLength = CONFIG.ship.spriteLength;
  ship.spriteConfig = CONFIG.ship.spriteConfig;
  engine.addSpacecraft(ship);

  return {
    engine, sun, terra, lua, mars, ship,
    spawn: ship.toJSON(),
    spawnFuel: CONFIG.ship.fuel,
  };
}

/* ========================================================================== */
/*  3. ShaderBridge — ponte viva entre shaders.js e o resto do jogo           */
/* ========================================================================== */

/** Converte RGB linear (0..1) em css rgba(). */
function cssLinear(rgb, a = 1) {
  const c = shaders.linearToSrgb3(rgb);
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

/**
 * Integra o módulo de shaders ao loop:
 *  - compila (WebGL, se houver) os programas PBR/volumétricos do catálogo
 *    ('planet', 'clouds', 'atmosphere', 'spacecraft') numa ShaderLibrary;
 *  - por quadro, deriva direção do Sol (sunFromBodies), uniformes de
 *    atmosfera (atmosphereUniforms → halo Rayleigh/Mie por planeta),
 *    brilho térmico (atmosphereFromTelemetry), especular Cook-Torrance da
 *    nave (evaluateCookTorranceBRDF) e bioma do sub-ponto (biomeWeights +
 *    altura do heightmap gerado por sprites.js).
 *  - desenha (canvas 2D, antes do pós-processamento) o Sol, as cascas
 *    atmosféricas, a cônica orbital analítica e o glint especular.
 */
class ShaderBridge {
  constructor(game) {
    this.game = game;
    this.mode = 'cpu';
    this.gl = null;
    this.library = null;
    this.compileQueue = [...shaders.PROGRAM_NAMES];
    this.programs = {};
    this.sunDir2 = [1, 0];
    this.light3 = shaders.normalize3([1, 0, 0.45]);
    this.halos = [];
    this.heat = { heatGlow: 0, hullTemperature: 0, reentry: false };
    this.specular = 0;
    this.cloudInfo = null;
    this.biome = shaders.deriveBiomeProfile('earth');
    this.surfaceBiome = null;
    this.surfaceTint = [0.6, 0.75, 1];
    this._state = {};
    this._hmCtx = null;
  }

  /** Se o renderer caiu no pipeline WebGL, monta a ShaderLibrary no mesmo GL. */
  attachGL() {
    const gl = this.game.renderer.pipeline?.gl ?? null;
    if (!gl) { this.mode = 'cpu'; return; }
    this.gl = gl;
    this.mode = 'webgl';
    this.library = shaders.createShaderLibrary(gl, {
      version: shaders.isWebGL2Context(gl) ? '300 es' : '100',
      throwOnError: false,
    });
  }

  /** Compila no máximo um programa por frame (não trava o boot). */
  compileOnePerFrame() {
    if (!this.library || !this.compileQueue.length) return;
    const name = this.compileQueue.shift();
    try {
      this.programs[name] = this.library.get(name, { throwOnError: false });
    } catch { this.programs[name] = null; }
  }

  /** Amostra o bioma sob a nave usando o heightmap da textura do planeta. */
  sampleSurfaceBiome() {
    const g = this.game;
    const body = g.primaryBody();
    if (!body) return;
    const preset = body.preset ?? sprites.inferPlanetPreset(body);
    let tex;
    try { tex = g.generator.planet(preset, { width: 256, heightMap: true }); } catch { return; }
    const hm = tex.heightMap;
    if (!hm || !hm.width) return;
    const dx = g.ship.x - body.x, dy = g.ship.y - body.y;
    if (dx * dx + dy * dy === 0) return;
    const lon = Math.atan2(dy, dx);
    const u = ((lon / TAU) % 1 + 1) % 1;
    const px = Math.min(hm.width - 1, Math.floor(u * hm.width));
    const py = Math.floor(hm.height * 0.5);
    let h01 = 0.62;
    try {
      this._hmCtx = this._hmCtx ?? hm.getContext('2d');
      const d = this._hmCtx.getImageData(px, py, 1, 1).data;
      h01 = d[0] / 255;
    } catch { /* heightmap indisponível */ }
    // mistura de biomas por altitude (elevação normalizada do terreno)
    const profile = this.biome;
    const w = shaders.biomeWeights(h01, 0, profile.profile);
    const mat = shaders.biomeMaterial(w);
    const col = shaders.biomeColor(w, profile.colors);
    let dom = 'plains', best = -1;
    for (const id of shaders.BIOME_IDS) {
      if ((w[id] ?? 0) > best) { best = w[id]; dom = id; }
    }
    this.surfaceBiome = {
      h: h01, weights: w, material: mat,
      label: shaders.BIOME_LABELS[dom] ?? dom,
      dominant: dom,
    };
    this.surfaceTint = shaders.linearToSrgb3(col);
  }

  /** Atualiza dados derivados dos shaders para este quadro. */
  update() {
    const g = this.game;
    const cam = g.renderer.camera;

    // direção da luz a partir dos corpos do physics.js
    const sunInfo = shaders.sunFromBodies(g.sun, [cam.x, cam.y, 0], {
      color: '#fff3d6', intensity: 3.4,
    });
    this.sunDir2 = [sunInfo.direction[0], sunInfo.direction[1]];
    this.light3 = shaders.normalize3([sunInfo.direction[0], sunInfo.direction[1], 0.45]);

    // cascas atmosféricas: coeficientes Rayleigh/Mie de cada planeta
    this.halos.length = 0;
    for (const [body, model] of g.atmosphere.models) {
      const state = model.stateAt(0, this._state, { scattering: true, bodyName: body.name });
      const { meta } = shaders.atmosphereUniforms(state, {
        body,
        planetRadius: body.radius,
        topAltitude: model.topAltitude,
        sunDirection: this.light3,
        time: g.renderer.time,
      });
      const ray = meta.rayleighCoeff, mie = meta.mieCoeff;
      const maxR = Math.max(ray[0], ray[1], ray[2], 1e-12);
      const maxM = Math.max(mie[0], mie[1], mie[2], 1e-12);
      const lin = [
        (ray[0] / maxR) * 0.9 + (mie[0] / maxM) * 0.22,
        (ray[1] / maxR) * 0.9 + (mie[1] / maxM) * 0.22,
        (ray[2] / maxR) * 0.9 + (mie[2] / maxM) * 0.22,
      ];
      // deck de nuvens volumétricas derivado do estado atmosférico
      if (!this.cloudInfo || this.cloudInfo.body !== body) {
        const deck = shaders.cloudDeckFromAtmosphere(state);
        this.cloudInfo = { body, base: deck.baseAltitude, top: deck.topAltitude };
      }
      this.halos.push({
        body, model, meta,
        color: shaders.linearToSrgb3(lin),
        outer: body.radius + model.topAltitude,
      });
    }

    // telemetria atmosférica → brilho de reentrada (shaders.js)
    const aero = g.atmosphere.getTelemetry(g.ship);
    this.heat = shaders.atmosphereFromTelemetry(aero, { referenceHeatFlux: 1.2e6 });

    // especular Cook-Torrance do casco da nave (normal = flanco + face à câmera)
    const ang = g.ship.angle ?? 0;
    const n3 = shaders.normalize3([Math.cos(ang + Math.PI / 2), Math.sin(ang + Math.PI / 2), 0.85]);
    const brdf = shaders.evaluateCookTorranceBRDF({
      normal: n3,
      view: [0, 0, 1],
      light: this.light3,
      albedo: [0.83, 0.87, 0.93],
      metallic: 0.85,
      roughness: 0.32,
      radiance: [1.35, 1.28, 1.12],
    });
    this.specular = shaders.luminance(brdf.specular);
  }

  /* ------------------------- desenho (pré-pós-processamento) ------------- */

  drawOverlay(ctx, renderer) {
    this.drawSun(ctx, renderer);
    this.drawAtmosphereShells(ctx, renderer);
    this.drawOrbitConic(ctx, renderer);
    this.drawShipGlint(ctx, renderer);
  }

  /** Sol com coroa — desenhado como overlay para alimentar o bloom. */
  drawSun(ctx, renderer) {
    const cam = renderer.camera;
    const sun = this.game.sun;
    const pos = sprites.projectPoint(cam, sun.x, sun.y);
    const R = Math.max(2.5, sun.radius * cam.scale);
    const W = cam.width ?? renderer.canvas.width;
    const H = cam.height ?? renderer.canvas.height;
    if (pos.x + R * 6 < 0 || pos.x - R * 6 > W || pos.y + R * 6 < 0 || pos.y - R * 6 > H) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // coroa externa
    let g = ctx.createRadialGradient(pos.x, pos.y, R * 0.4, pos.x, pos.y, R * 6);
    g.addColorStop(0, 'rgba(255,214,140,0.16)');
    g.addColorStop(0.5, 'rgba(255,180,90,0.07)');
    g.addColorStop(1, 'rgba(255,160,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, R * 6, 0, TAU); ctx.fill();
    // disco + núcleo
    g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, R * 1.15);
    g.addColorStop(0, 'rgba(255,255,245,1)');
    g.addColorStop(0.55, 'rgba(255,236,190,0.98)');
    g.addColorStop(0.85, 'rgba(255,205,120,0.85)');
    g.addColorStop(1, 'rgba(255,190,100,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, R * 1.15, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /** Cascas atmosféricas (Rayleigh + espalhamento frontal Mie). */
  drawAtmosphereShells(ctx, renderer) {
    const cam = renderer.camera;
    const W = cam.width ?? renderer.canvas.width;
    const H = cam.height ?? renderer.canvas.height;
    const sd = this.sunDir2;
    const sdLen = Math.hypot(sd[0], sd[1]) || 1;
    const sdx = sd[0] / sdLen, sdy = sd[1] / sdLen;
    // refletância do bioma no sub-ponto modula o espalhamento frontal
    const refl = this.surfaceBiome?.material.reflectance ?? 0.5;
    for (const h of this.halos) {
      const pos = sprites.projectPoint(cam, h.body.x, h.body.y);
      const Rp = h.body.radius * cam.scale;
      const outer = Math.max(Rp + h.model.topAltitude * cam.scale, Rp * 1.05);
      if (pos.x + outer < 0 || pos.x - outer > W || pos.y + outer < 0 || pos.y - outer > H) continue;
      const fade = 0.15 + 0.85 * clamp01(Rp / 40);
      const c = h.color;
      const tint = this.surfaceTint;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // anel atmosférico (Rayleigh), mais intenso perto da superfície
      const g = ctx.createRadialGradient(pos.x, pos.y, Rp * 0.9, pos.x, pos.y, outer);
      g.addColorStop(0, `rgba(${Math.round(tint[0] * 255)},${Math.round(tint[1] * 255)},${Math.round(tint[2] * 255)},0)`);
      g.addColorStop(0.45, `rgba(${Math.round(tint[0] * 255)},${Math.round(tint[1] * 255)},${Math.round(tint[2] * 255)},${0.10 * fade})`);
      g.addColorStop(0.78, `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${0.20 * fade})`);
      g.addColorStop(1, `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, outer, 0, TAU); ctx.fill();
      // espalhamento frontal (Mie) na direção do Sol
      const sx = pos.x + sdx * Rp * 0.7, sy = pos.y + sdy * Rp * 0.7;
      const g2 = ctx.createRadialGradient(sx, sy, 0, sx, sy, outer * 0.95);
      g2.addColorStop(0, `rgba(255,240,215,${(0.05 + 0.10 * refl) * fade})`);
      g2.addColorStop(1, 'rgba(255,240,215,0)');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(sx, sy, outer * 0.95, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  /** Cônica orbital analítica (elipse) a partir dos elementos de physics.js. */
  drawOrbitConic(ctx, renderer) {
    const g = this.game;
    const el = g.orbitElements;
    const primary = g.primaryBody();
    if (!el || !primary || !Number.isFinite(el.a) || el.e >= 1 || el.e < 0) return;
    const apsides = g.orbitApsides;
    if (!apsides) return;
    const cam = renderer.camera;
    const pSemi = (el.h * el.h) / el.mu;
    const e = el.e;
    const arg = apsides.argument;
    const N = 240;
    ctx.save();
    ctx.strokeStyle = 'rgba(95,212,255,0.38)';
    ctx.lineWidth = Math.max(1, 0.8 * (renderer.pixelRatio ?? 1));
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const nu = (i / N) * TAU;
      const r = pSemi / (1 + e * Math.cos(nu));
      const wx = primary.x + Math.cos(arg + nu) * r;
      const wy = primary.y + Math.sin(arg + nu) * r;
      const sp = sprites.projectPoint(cam, wx, wy);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Glint especular Cook-Torrance sobre o casco da nave. */
  drawShipGlint(ctx, renderer) {
    const g = this.game;
    const ship = g.ship;
    if (ship.destroyed) return;
    const cam = renderer.camera;
    const pos = sprites.projectPoint(cam, ship.x, ship.y);
    const a = clamp01(this.specular * 1.25) * 0.55;
    if (a <= 0.02) return;
    const r = (ship.spriteLength ?? 34) * 1.1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r);
    grad.addColorStop(0, `rgba(255,252,240,${a})`);
    grad.addColorStop(0.4, `rgba(220,235,255,${a * 0.4})`);
    grad.addColorStop(1, 'rgba(200,225,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, TAU); ctx.fill();
    ctx.restore();
  }
}

/* ========================================================================== */
/*  4. Controlos de teclado/rato                                              */
/* ========================================================================== */

class InputController {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.keys = new Set();
    this.drag = null;
  }

  attach() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) {
        if (this.game.handleKey(e.code, true)) e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      if (this.game.handleKey(e.code, false)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // zoom ancorado no cursor
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const kx = this.canvas.width / Math.max(1, rect.width);
      const ky = this.canvas.height / Math.max(1, rect.height);
      const x = (e.clientX - rect.left) * kx;
      const y = (e.clientY - rect.top) * ky;
      this.game.camera.zoomAt(Math.exp(-e.deltaY * 0.0014), x, y);
    }, { passive: false });

    // pan com botão do meio/direito (solta a câmera da nave)
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      this.drag = { x: e.clientX, y: e.clientY };
      this.game.setFollow(false);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.drag) return;
      const rect = this.canvas.getBoundingClientRect();
      const kx = this.canvas.width / Math.max(1, rect.width);
      const ky = this.canvas.height / Math.max(1, rect.height);
      const dx = (e.clientX - this.drag.x) * kx;
      const dy = (e.clientY - this.drag.y) * ky;
      this.drag = { x: e.clientX, y: e.clientY };
      const cam = this.game.camera;
      cam.x -= dx / cam.scale;
      cam.y -= dy / cam.scale;
    });
    window.addEventListener('mouseup', () => { this.drag = null; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  down(code) { return this.keys.has(code); }
  apply(dt) { this.game.applyControls(dt, this); }
}

/* ========================================================================== */
/*  5. OrbiterGame — integração de todos os módulos + loop principal          */
/* ========================================================================== */

class OrbiterGame {
  constructor(canvas) {
    this.canvas = canvas;

    // --- physics.js: mundo + nave ------------------------------------------
    const world = buildWorld();
    Object.assign(this, world);
    this.engine = world.engine;

    // colisões: explosão de partículas + log + warp seguro
    this.engine.onCollision = (ev) => {
      const sc = ev.a.isSpacecraft ? ev.a : (ev.b.isSpacecraft ? ev.b : null);
      if (sc) {
        const other = ev.a === sc ? ev.b : ev.a;
        this.particles?.emitExplosion(sc.x, sc.y, { count: 160, power: 1200, size: 34 });
        this.log(`COLISÃO com ${other.name} a ${sprites.formatSpeed(ev.impactSpeed)} — nave destruída`);
        this.warpIndex = 0;
      }
    };

    // --- atmosphere.js: arrasto/aquecimento ligado ao engine.step -----------
    this.atmosphere = createAtmosphereSystem(this.engine, {
      models: { Terra: 'earth', Marte: 'mars' },
      defaultAtmosphere: null,
      heating: true,
      drag: true,
      particles: true,
      thermalDamage: false,
      onReentryStart: () => this.log('REENTRADA ATMOSFÉRICA iniciada'),
      onReentryEnd: () => this.log('Reentrada concluída'),
      onDestroyed: () => this.log('Nave destruída por superaquecimento'),
    });

    // --- sprites.js: texturas, HUD, partículas, câmera ----------------------
    this.generator = sprites.createSpriteGenerator({ seed: 2026, quality: 'high', planetWidth: 512 });
    this.hud = this.generator.hud({ accent: '#5fd4ff' });
    this.particles = new sprites.ParticleSystem({
      atlas: this.generator.particles(),
      maxParticles: 1800,
      seed: 42,
    });
    this.camera = sprites.createCamera({
      x: this.ship.x, y: this.ship.y,
      scale: 1,
      width: canvas.width, height: canvas.height,
      minScale: 1e-10,   // sistema solar inteiro
      maxScale: 5e-3,    // close na superfície
    });
    this.camera.frameRadius(this.terra.radius, 3.0);
    this.camera.centerOn(this.ship.x, this.ship.y);

    // --- postprocessing.js: renderizador unificado (cena + pós-processo) ----
    this.renderer = createRenderer(canvas, {
      mode: 'auto',               // WebGL se disponível, senão CanvasPostFX
      quality: 'high',
      cameraInstance: this.camera,
      particleSystem: this.particles,
      camera: { follow: true, smoothing: 5 },
      trails: { mode: 'trail', length: 200, color: 'rgba(95,212,255,0.55)' },
      particles: { enabled: true, maxParticles: 1800, create: false },
      hud: { enabled: true, render: (ctx, r, tel) => this.drawHUD(ctx, r, tel) },
      background: { stars: 1100, twinkle: true, parallax: 0.3, nebula: true },
      shadows: { enabled: true, quality: 'high', opacity: 0.62 },
      postfx: { tonemap: { operator: 'aces', exposure: 1.06, autoExposure: true } },
      context: { antialias: true, alpha: false, depth: false, powerPreference: 'high-performance' },
    });
    this.renderer.attach({
      engine: this.engine,
      atmosphere: this.atmosphere,
      sprites,                    // namespace inteiro de sprites.js
      generator: this.generator,
      hud: this.hud,
      particles: this.particles,
    });

    // o Sol é desenhado pela ponte de shaders (overlay), não como corpo texturizado
    this.renderBodies = this.engine.bodies.filter((b) => b !== this.sun);
    this.renderer.setScene({
      bodies: this.renderBodies,
      spacecraft: this.engine.spacecraft,
      follow: this.ship,
      sun: this.sun,
    });

    // --- shaders.js: ponte GLSL/CPU ------------------------------------------
    this.bridge = new ShaderBridge(this);
    this.bridge.attachGL();
    this.renderer.scene.overlays.push({ draw: (ctx, r) => this.bridge.drawOverlay(ctx, r) });

    // --- estado de jogo -------------------------------------------------------
    this.input = new InputController(canvas, this);
    this.input.attach();
    this.follow = true;
    this.hudVisible = true;
    this.debug = false;
    this.sas = false;             // hold prógrado
    this.throttleTarget = 0;
    this.warpIndex = 0;
    this.paused = false;
    this.effectiveWarp = 1;
    this.warpClamped = false;
    this.qualityIndex = 2;        // 'high'
    this.alerts = [];
    this.logLines = [];
    this.orbitElements = null;
    this.orbitApsides = null;
    this.impactPredicted = false;
    this._lastT = 0;
    this._predTimer = 0;
    this._biomeTimer = 0;
    this._raf = 0;

    this.log('Simulação iniciada. Boa viagem, comandante.');
  }

  /* ------------------------------ utilidades ------------------------------ */

  primaryBody() { return this.engine.getPrimaryBody(this.ship); }

  log(msg) {
    this.logLines.push(`[${sprites.formatTime(this.engine.time, { clock: true })}] ${msg}`);
    if (this.logLines.length > 6) this.logLines.shift();
    console.info(`[orbiter] ${msg}`);
  }

  setFollow(v) {
    this.follow = v;
    this.renderer.options.camera.follow = v;
    if (v) this.log('Câmera seguindo a nave [F]');
  }

  cycleQuality() {
    this.qualityIndex = (this.qualityIndex + 1) % CONFIG.qualityOrder.length;
    const q = CONFIG.qualityOrder[this.qualityIndex];
    this.renderer.setQuality(q);
    this.generator.quality = q;
    this.log(`Qualidade: ${q}`);
  }

  warpStep(d) {
    this.warpIndex = clamp(this.warpIndex + d, 0, CONFIG.warps.length - 1);
    if (this.paused && d !== 0) this.paused = false;
  }

  setWarpIndex(i) {
    this.warpIndex = clamp(i, 0, CONFIG.warps.length - 1);
    this.paused = false;
  }

  /** Aplica time warp com limites de segurança na atmosfera. */
  updateWarp() {
    const requested = this.paused ? 0 : CONFIG.warps[this.warpIndex];
    let w = requested;
    const a = this.atmosphere.getTelemetry(this.ship);
    if (a && a.inAtmosphere && Number.isFinite(a.altitude)) {
      if (a.reentry || a.heatFlux > 8e4 || a.dynamicPressure > 45e3) w = Math.min(w, 1);
      else if (a.altitude < 100e3) w = Math.min(w, 4);
    }
    if (this.impactPredicted || this.ship.destroyed) w = Math.min(w, 1);
    this.warpClamped = w < requested;
    this.effectiveWarp = w;
    this.engine.setTimeScale(w);
  }

  /** Recria a nave no estado inicial de lançamento. */
  reset() {
    const old = this.ship;
    this.engine.removeBody(old);
    const sc = Spacecraft.fromJSON(this.spawn);
    sc.spriteLength = old.spriteLength;
    sc.spriteConfig = old.spriteConfig;
    this.engine.addSpacecraft(sc);
    this.ship = sc;
    this.throttleTarget = 0;
    this.particles.clear();
    this.camera.centerOn(sc.x, sc.y);
    this.log('Nave reiniciada em órbita baixa de 250 km');
  }

  /* ------------------------------ controlos ------------------------------- */

  handleKey(code, repeat) {
    // teclas de segurar (repetição automática do SO é desejada)
    const held = ['Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
      'KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight',
      'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'];
    if (repeat) return held.includes(code);
    switch (code) {
      case 'Space': this.throttleTarget = 1; return true;
      case 'KeyX': this.throttleTarget = 0; return true;
      case 'KeyT':
        this.sas = !this.sas;
        this.log(this.sas ? 'SAS prógrado ligado [T]' : 'SAS desligado');
        return true;
      case 'KeyF': this.setFollow(!this.follow); return true;
      case 'KeyC':
        this.setFollow(true);
        this.camera.centerOn(this.ship.x, this.ship.y);
        return true;
      case 'KeyR': this.reset(); return true;
      case 'KeyH':
        this.hudVisible = !this.hudVisible;
        this.renderer.options.hud.enabled = this.hudVisible;
        return true;
      case 'KeyQ': this.cycleQuality(); return true;
      case 'Comma': case 'NumpadSubtract': this.warpStep(-1); return true;
      case 'Period': case 'NumpadAdd': this.warpStep(1); return true;
      case 'KeyP':
        this.paused = !this.paused;
        this.log(this.paused ? 'Pausado [P]' : 'Simulação retomada');
        return true;
      case 'Backquote': case 'F3': this.debug = !this.debug; return true;
      case 'Home':
        this.camera.centerOn(this.ship.x, this.ship.y);
        this.camera.frameRadius(this.terra.radius, 3.0);
        return true;
      case 'Digit1': this.setWarpIndex(0); return true;
      case 'Digit2': this.setWarpIndex(1); return true;
      case 'Digit3': this.setWarpIndex(3); return true;
      case 'Digit4': this.setWarpIndex(5); return true;
      case 'Digit5': this.setWarpIndex(8); return true;
      default: return false;
    }
  }

  /** Controlos contínuos (teclas seguradas), chamados 1× por frame. */
  applyControls(dt, input) {
    // throttle: Shift/W sobe, Ctrl/S desce, X corta, Espaço 100%
    if (input.down('ShiftLeft') || input.down('ShiftRight') || input.down('KeyW')) {
      this.throttleTarget = clamp01(this.throttleTarget + dt * 0.8);
    }
    if (input.down('ControlLeft') || input.down('ControlRight') || input.down('KeyS')) {
      this.throttleTarget = clamp01(this.throttleTarget - dt * 0.8);
    }
    const cur = this.ship.throttle;
    this.ship.setThrottle(cur + clamp(this.throttleTarget - cur, -dt * 2.2, dt * 2.2));

    // atitude: A/D ou ←/→ aplicam torque; T liga o SAS prógrado
    let torque = 0;
    if (this.sas && !this.ship.destroyed) {
      const p = this.primaryBody();
      const desired = Math.atan2(this.ship.vy - (p?.vy ?? 0), this.ship.vx - (p?.vx ?? 0));
      const err = wrapPi(desired - this.ship.angle);
      torque = clamp(err * 2.4 - this.ship.angularVelocity * 1.1, -1, 1);
    } else {
      if (input.down('KeyA') || input.down('ArrowLeft')) torque -= 1;
      if (input.down('KeyD') || input.down('ArrowRight')) torque += 1;
    }
    this.ship.setTorqueInput(torque);

    // zoom por teclado (centro da tela)
    if (input.down('Equal') || input.down('NumpadAdd')) this.camera.zoomAt(Math.exp(dt * 1.4));
    if (input.down('Minus') || input.down('NumpadSubtract')) this.camera.zoomAt(Math.exp(-dt * 1.4));
  }

  /* --------------------------- partículas de exaustão --------------------- */

  emitExhaust(dt) {
    const sc = this.ship;
    if (!sc || sc.destroyed || sc.throttle <= 0.01 || sc.fuel <= 0) return;
    const scale = Math.max(this.camera.scale, 1e-12);
    const shipPx = sc.spriteLength ?? 34;
    const back = (shipPx * 0.52) / scale; // tubo atrás do centro da nave (m)
    const dx = Math.cos(sc.angle), dy = Math.sin(sc.angle);
    const src = {
      x: sc.x - dx * back, y: sc.y - dy * back,
      angle: sc.angle + Math.PI, vx: sc.vx, vy: sc.vy,
    };
    const aero = this.atmosphere.getTelemetry(sc);
    const inAtmo = !!(aero && aero.inAtmosphere);
    // vento = velocidade absoluta do ar (co-rotação planetária + jato)
    const st = this.atmosphere.sample(sc);
    this.particles.wind.x = st?.airVelocity?.x ?? 0;
    this.particles.wind.y = st?.airVelocity?.y ?? 0;
    const th = sc.throttle;
    // fumaça/chaça na atmosfera, chama no vácuo (tamanhos em px → m via câmera)
    this.particles.emitFrom('nozzle', src, {
      rate: th * (inAtmo ? 320 : 120),
      kind: inAtmo ? 'smoke' : 'fire',
      speed: (inAtmo ? 70 : 260) * th / scale,
      life: inAtmo ? 1.2 : 0.45,
      size: (inAtmo ? 9 : 5.5) * (0.7 + th * 0.6) / scale,
      growth: (inAtmo ? 26 : 10) / scale,
      spread: inAtmo ? 0.5 : 0.16,
      jitter: 2.5 / scale,
      drag: inAtmo ? 1.1 : 0.35,
      buoyancy: inAtmo ? 8 / scale : 0,
      dt,
    });
    // núcleo incandescente da pluma
    this.particles.emitFrom('core', src, {
      rate: th * 160,
      kind: 'fire',
      speed: 420 * th / scale,
      life: 0.22,
      size: 3.2 / scale,
      growth: 6 / scale,
      spread: 0.06,
      jitter: 1 / scale,
      drag: 0.5,
      dt,
    });
  }

  /* --------------------------- previsões Periódicas ----------------------- */

  updatePrediction(dt) {
    this._predTimer -= dt;
    if (this._predTimer > 0) return;
    this._predTimer = 0.5;
    const el = this.engine.orbitalElements(this.ship);
    this.orbitElements = el;
    const p = this.primaryBody();
    this.orbitApsides = p ? sprites.computeApsisMarkers(this.ship, p, { G: this.engine.G }) : null;
    // impacto analítico: perigeu abaixo da superfície do corpo primário
    this.impactPredicted = !!(
      el && p && Number.isFinite(el.perigee) && el.perigee < p.radius
    );
  }

  updateBiome(dt) {
    this._biomeTimer -= dt;
    if (this._biomeTimer > 0) return;
    this._biomeTimer = 0.5;
    try { this.bridge.sampleSurfaceBiome(); } catch { /* ignora */ }
  }

  buildAlerts() {
    const t = this.engine.getTelemetry(this.ship);
    const a = this.atmosphere.getTelemetry(this.ship);
    const p = this.primaryBody();
    const alerts = [];
    if (!t) return;
    if (this.ship.destroyed) {
      alerts.push({ label: 'VEÍCULO DESTRUÍDO — [R] reinicia', level: 'danger' });
    } else {
      if (this.impactPredicted && p) {
        const alt = t.perigee - p.radius;
        alerts.push({ label: `IMPACTO PREVISTO (perigeu ${sprites.formatDistance(alt)})`, level: 'danger' });
      }
      if (a?.reentry) alerts.push({ label: 'REENTRADA — PLASMA', level: 'warn' });
      if (a && Number.isFinite(a.hullTemperature) && a.hullTemperature > 1200) {
        alerts.push({ label: `CASCO ${Math.round(a.hullTemperature)} K`, level: 'danger' });
      }
      if (a && a.dynamicPressure > 30e3) {
        alerts.push({ label: `Q ${sprites.formatSI(a.dynamicPressure, 'Pa')} — LIMITE ESTRUTURAL`, level: 'warn' });
      }
      if ((t.gForceNet ?? 0) > 8) {
        alerts.push({ label: `FORÇA G ${sprites.formatNumber(t.gForceNet, 1)}`, level: 'warn' });
      }
      if (this.spawnFuel > 0 && t.fuel / this.spawnFuel <= 0.12) {
        alerts.push({ label: 'COMBUSTÍVEL CRÍTICO', level: 'danger' });
      }
      if (this.warpClamped && !this.paused) {
        alerts.push({ label: `TIME WARP LIMITADO A ×${this.effectiveWarp} NA ATMOSFERA`, level: 'info' });
      }
    }
    this.alerts = alerts;
  }

  /* ------------------------------ HUD ------------------------------------- */

  drawHUD(ctx, renderer, telemetry) {
    if (!this.hudVisible || !telemetry) return;
    const W = renderer.canvas.width;
    const H = renderer.canvas.height;
    const style = this.hud.style;

    // HUD principal de sprites.js: órbita, velocidade, G, combustível,
    // throttle, bússola, fita de altitude e marcos de ápsides
    this.hud.draw(ctx, telemetry, {
      camera: renderer.camera,
      spacecraft: this.ship,
      primary: this.primaryBody(),
      atmosphere: renderer._aeroTelemetry ?? undefined,
      width: W,
      height: H,
      dt: renderer._lastDt,
      fuelCapacity: this.spawnFuel,
    });

    this.drawTopBar(ctx, W, style);
    this.drawAeroPanel(ctx, renderer, W, H, style);
    if (this.debug) this.drawDebug(ctx, renderer, W, H, style);
  }

  /** Barra superior central: relógio, time warp, qualidade, modo, fps + alertas. */
  drawTopBar(ctx, W, style) {
    const warpTxt = this.paused
      ? '❚❚ PAUSA'
      : `×${this.effectiveWarp}${this.warpClamped ? ' (lim.)' : ''}`;
    const parts = [
      `T+ ${sprites.formatTime(this.engine.time, { clock: true })}`,
      warpTxt,
      `Q:${CONFIG.qualityOrder[this.qualityIndex]}`,
      this.renderer.mode.toUpperCase(),
      `${Math.round(this.renderer.stats.fps)} fps`,
    ];
    ctx.save();
    ctx.font = style.font;
    let total = 0;
    const widths = parts.map((p) => { const w = ctx.measureText(p).width; total += w; return w; });
    total += (parts.length - 1) * 22 + 24;
    const x0 = Math.max(8, (W - total) / 2);
    sprites.drawHUDPanel(ctx, x0, 12, total, 26, style, { brackets: false });
    let x = x0 + 12;
    parts.forEach((p, i) => {
      ctx.font = style.font;
      ctx.fillStyle = i === 1 ? style.accent : style.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(p, x, 26);
      x += widths[i] + 22;
    });
    ctx.restore();

    // alertas abaixo da barra
    if (this.alerts.length) {
      ctx.save();
      ctx.font = style.fontLabel;
      let aw = 0;
      for (const a of this.alerts) aw = Math.max(aw, ctx.measureText(a.label).width + 26);
      sprites.drawStatusStrip(ctx, this.alerts, { x: Math.max(8, (W - aw) / 2), y: 44, style });
      ctx.restore();
    }
  }

  /** Painel atmosférico (Mach, q, fluxo de calor, casco...) quando na atmosfera. */
  drawAeroPanel(ctx, renderer, W, H, style) {
    const a = renderer._aeroTelemetry;
    if (!a || !a.inAtmosphere) return;
    const rows = [
      ['ALT', sprites.formatDistance(a.altitude)],
      ['MACH', Number.isFinite(a.mach) ? sprites.formatNumber(a.mach, 2) : '—'],
      ['Q DINÂMICO', sprites.formatSI(a.dynamicPressure, 'Pa')],
      ['FLUXO TÉRMICO', sprites.formatSI(a.heatFlux, 'W/m²')],
      ['CASCO', `${Math.round(a.hullTemperature)} K`],
      ['TEMP. AR', `${Math.round(a.airTemperature)} K`],
      ['DENSIDADE', fmtSci(a.density, 'kg/m³')],
      ['REGIME', String(a.regime ?? '—').toUpperCase()],
    ];
    if (this.bridge.surfaceBiome) {
      rows.push(['SUBPONTO', `${this.bridge.surfaceBiome.label} · h=${this.bridge.surfaceBiome.h.toFixed(2)}`]);
    }
    if (this.bridge.cloudInfo) {
      rows.push(['NUVENS', `${sprites.formatDistance(this.bridge.cloudInfo.base)} – ${sprites.formatDistance(this.bridge.cloudInfo.top)}`]);
    }
    rows.push(['BRILHO TÉRMICO', sprites.formatPercent(this.bridge.heat.heatGlow)]);
    const pw = 300, rowH = 16;
    const ph = 26 + rows.length * rowH + 6;
    const x = (W - pw) / 2, y = H - 16 - ph;
    sprites.drawHUDPanel(ctx, x, y, pw, ph, style);
    text(ctx, 'ATMOSFERA', x + 10, y + 9, { font: style.fontLabel, color: style.accent });
    let ry = y + 26;
    for (const [label, value] of rows) {
      text(ctx, label, x + 10, ry, { font: style.fontLabel, color: style.textDim });
      text(ctx, value, x + pw - 10, ry, { font: style.font, color: style.text, align: 'right' });
      ry += rowH;
    }
  }

  /** Painel de depuração (F3): stats do renderer/pipeline/engine/shaders/sprites. */
  drawDebug(ctx, renderer, W, H, style) {
    const j = renderer.toJSON();
    const lines = [
      `MODO ${j.mode} · ${Math.round(j.stats.fps)} fps · frame ${j.stats.frameMs?.toFixed(2)} ms (cena ${j.stats.sceneMs?.toFixed(2)} / pós ${j.stats.postMs?.toFixed(2)} / gbuffer ${j.stats.gbufferMs?.toFixed(2)})`,
      `pipeline: ${j.postprocessing ? `passes=${j.postprocessing.stats?.passes ?? '?'} drawCalls=${j.postprocessing.stats?.drawCalls ?? '?'} bloom thr=${j.postprocessing.stats?.bloomThreshold?.toFixed(2)} int=${j.postprocessing.stats?.bloomIntensity?.toFixed(2)}` : 'n/d'}`,
      `engine: t=${sprites.formatTime(j.time ?? this.engine.time)} warp=×${this.effectiveWarp} corpos=${this.engine.bodies.length} partículas=${this.particles.count}`,
      `shaders: ${this.bridge.mode} · programas=${Object.values(this.bridge.programs).filter(Boolean).length}/${shaders.PROGRAM_NAMES.length} · compiles=${this.bridge.library?.stats.compiles ?? 0} falhas=${this.bridge.library?.stats.failures ?? 0}`,
      `sprites: cache=${this.generator.stats.entries} (~${(this.generator.stats.bytes / 1e6).toFixed(1)} MB) hits=${this.generator.stats.hits} misses=${this.generator.stats.misses}`,
      `câmera: escala=${this.camera.scale.toExponential(2)} px/m · alvo=${this.follow ? 'nave' : 'livre'}`,
      ...this.logLines,
    ];
    const pw = 560, lh = 15;
    const ph = 24 + lines.length * lh + 6;
    const x = 14, y = 96;
    sprites.drawHUDPanel(ctx, x, y, pw, ph, style);
    text(ctx, 'DEBUG [F3]', x + 10, y + 9, { font: style.fontLabel, color: style.accent });
    let ry = y + 24;
    for (const line of lines) {
      text(ctx, line, x + 10, ry, { font: style.fontSmall, color: style.text });
      ry += lh;
    }
  }

  /* ------------------------------ loop ------------------------------------ */

  start() {
    this._lastT = performance.now();
    const loop = (t) => {
      this.frame(t);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  /**
   * Um quadro do jogo: dt real (s) → controlos → time warp → física
   * (engine.update; a atmosfera é aplicada dentro de cada sub-passo RK4
   * pelo hook do AtmosphereSystem) → shaders → renderer.frame(dt).
   */
  frame(t) {
    const raw = (t - this._lastT) / 1000;
    this._lastT = t;
    const dt = clamp(Number.isFinite(raw) ? raw : 1 / 60, 0, 0.1);

    this.input.apply(dt);
    this.updateWarp();
    this.engine.update(dt);          // N-body RK4 + aerodinâmica + térmico
    this.updatePrediction(dt);
    this.updateBiome(dt);
    this.emitExhaust(dt);

    this.bridge.update();
    this.bridge.compileOnePerFrame();

    // cena viva para o renderizador (arrays do engine são lidos a cada frame)
    this.renderer.options.camera.follow = this.follow;
    this.renderer.setScene({
      bodies: this.renderBodies,
      spacecraft: this.engine.spacecraft,
      follow: this.follow ? this.ship : null,
      sun: this.sun,
    });
    this.renderer.frame(dt);         // cena 2D → pós-processamento → HUD
    this.buildAlerts();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.renderer.dispose();
    this.generator.dispose();
  }
}

/* ========================================================================== */
/*  6. Helpers de texto                                                       */
/* ========================================================================== */

function text(ctx, str, x, y, { font, color, align = 'left', baseline = 'alphabetic' } = {}) {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(str, x, y);
  ctx.restore();
}

/** Notação científica compacta para valores muito pequenos (densidade...). */
function fmtSci(value, unit) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1000 || abs < 0.01)) return `${value.toExponential(2)} ${unit}`;
  return sprites.formatSI(value, unit);
}

/* ========================================================================== */
/*  7. Boot                                                                   */
/* ========================================================================== */

function boot() {
  const canvas = document.getElementById('game');
  const bootEl = document.getElementById('boot');
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = () => {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    };
    fit();
    window.addEventListener('resize', fit);

    const game = new OrbiterGame(canvas);

    // pré-aquece texturas de planetas + sprite da nave (evita engasgo no 1º frame)
    sprites.preloadSprites(game.generator, {
      planets: ['earth', 'moon', 'mars'],
      width: 512,
      spaceship: game.ship.spriteConfig,
    });

    game.start();
    window.orbiter = game; // inspeção no console: orbiter.engine, orbiter.renderer...

    bootEl?.remove();
    document.getElementById('help')?.classList.add('visible');
    console.info('[orbiter] pronto. Debug: window.orbiter');
  } catch (err) {
    console.error(err);
    if (bootEl) {
      bootEl.textContent = `Falha ao iniciar o simulador: ${err.message}`;
      bootEl.classList.add('error');
    }
  }
}

// Só faz boot automático num navegador; importável em Node para testes.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

export { OrbiterGame, ShaderBridge, buildWorld };
export default OrbiterGame;
