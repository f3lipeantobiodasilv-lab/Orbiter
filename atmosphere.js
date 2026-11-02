/**
 * ============================================================================
 *  atmosphere.js — Atmosfera, Arrasto e Aquecimento Aerodinâmico
 * ============================================================================
 *  Módulo ES6+ autocontido (zero dependências), projetado para consumir
 *  diretamente o estado de `Body` / `Spacecraft` / `PhysicsEngine` de
 *  `physics.js` (x, y, vx, vy, mass, radius, angle, destroyed).
 *
 *  Conteúdo
 *  --------
 *   1. Propriedades do ar / gases ............ massas molares, Sutherland,
 *      velocidade do som, caminho livre médio.
 *   2. AtmosphereModel ...................... modelo em camadas (US Standard
 *      1976 e presets planetários) + modo exponencial (scale height).
 *      Inclui coeficientes de espalhamento de Rayleigh e Mie, função de fase,
 *      profundidade ótica e ventos.
 *   3. calculateAtmosphere(altitude, body) .. estado atmosférico completo.
 *   4. Arrasto ............................... Fd = ½ ρ v_rel² Cd A, oposto à
 *      velocidade relativa ao ar (atmosfera em co-rotação + ventos).
 *   5. Aquecimento ........................... fluxo convectivo de estagnação
 *      (Sutton–Graves / Detra–Kemp–Riddell), integração térmica de pele com
 *      radiação, ablação opcional, partículas térmicas e dados estruturais.
 *   6. applyAerodynamics(spacecraft, atmosphere, dt) — aplicação isolada.
 *   7. AtmosphereSystem ...................... integração não invasiva ao
 *      PhysicsEngine (hook em engine.step), telemetria e eventos.
 *
 *  Unidades: SI estrito — m, kg, s, N, Pa, K, W/m², rad.
 *
 *  Uso típico (integrado ao physics.js)
 *  ------------------------------------
 *    import { PhysicsEngine, Body, Spacecraft } from './physics.js';
 *    import { AtmosphereSystem } from './atmosphere.js';
 *
 *    const engine = new PhysicsEngine({ fixedDt: 1 / 120 });
 *    engine.addBody(new Body({ name: 'Terra', mass: 5.9722e24, radius: 6.371e6, fixed: true }));
 *    const sc = engine.addSpacecraft(new Spacecraft({ x: 6.771e6, y: 0, vy: 7669, dryMass: 1200 }));
 *
 *    const atmo = new AtmosphereSystem(engine, {
 *      models: { Terra: 'earth' },          // ou body.atmosphere = 'earth'
 *      autoInstall: true,                   // hook transparente em engine.step
 *    });
 *
 *    engine.update(1 / 60);
 *    const t = engine.getTelemetry(sc);     // física orbital (physics.js)
 *    const a = atmo.getTelemetry(sc);       // arrasto, Mach, fluxo de calor...
 *
 *  Uso isolado (sem engine)
 *  ------------------------
 *    import { calculateAtmosphere, applyAerodynamics } from './atmosphere.js';
 *    const state = calculateAtmosphere(120e3, 'earth');   // ou um Body
 *    applyAerodynamics(spacecraft, state, 1 / 60);
 *
 *  API pública
 *  -----------
 *   Classes ....... AtmosphericModel, AtmosphereSystem
 *   Modelos ....... calculateAtmosphere(altitude, body), buildAtmosphereProfile,
 *                   ATMOSPHERE_PRESETS (earth, mars, venus, titan, jupiter)
 *   Dinâmica ...... applyAerodynamics(spacecraft, atmosphere, dt),
 *                   relativeAirVelocity, dragForce, dynamicPressure
 *   Térmica ....... suttonGravesHeatFlux, detraKempRiddellHeatFlux,
 *                   ensureThermalState, thermalGlow, blackbodyRGB
 *   Óptica ........ rayleighScatteringCoefficient, rayleighPhase, miePhase
 *   Gases ......... molarMassOf, sutherlandViscosity, speedOfSound,
 *                   machNumber, knudsenNumber, flowRegime
 *   Integração .... createAtmosphereSystem, attachAtmosphere
 *   Constantes .... R_UNIVERSAL, K_BOLTZMANN, STEFAN_BOLTZMANN, G0_SI,
 *                   SUTTON_GRAVES_K, SPACECRAFT_AERO_DEFAULTS, CONVERSIONS
 *
 *  Modelo físico em resumo
 *  -----------------------
 *   • Camadas (US Standard Atmosphere 1976 até 84.852 km geopotencial, ou
 *     tabela configurável) com integração hidrostática exata por camada.
 *   • Termosfera: temperatura relaxando para T_exo, separação difusiva
 *     (M(h) cai de M0 para M_termo) e coluna hidrostática integrada
 *     numericamente → densidades realistas de 100 a 700 km (alvo de arrasto).
 *   • Modo alternativo exponencial (scale height, pressão, temperatura) para
 *     planetas/luas fictícios ou escalas de jogo.
 *   • Espalhamento Rayleigh (∝ N/λ⁴) e Mie (aerossóis, escala de altura
 *     própria) com função de fase e profundidade ótica vertical.
 *   • Arrasto com atmosfera em co-rotação + vento, Cd dependente de Mach/Kn
 *     (ou Cd fixo), integração quadrática analítica (incondicionalmente estável),
 *     sustentação opcional, coeficiente balístico e pressão dinâmica.
 *   • Aquecimento de estagnação (Sutton–Graves/DKR), pele com capacidade
 *     térmica própria, radiação εσT⁴, ablação opcional, emissão de partículas
 *     e telemetria estrutural (temperatura, carga térmica, cor de brilho).
 *
 *  Validação: as pressões do preset terrestre reproduzem a tabela USSA76 nos
 *  níveis geopotenciais de 32, 47 e 71 km (868.02 Pa, 110.91 Pa, 3.9564 Pa).
 *  O `physics.js` não é modificado: o acoplamento é feito por hook no método
 *  `engine.step`, podendo ser removido com `system.dispose()`.
 * ============================================================================
 */

/* ========================================================================== */
/*  0. Constantes e utilitários                                               */
/* ========================================================================== */

/** Constante universal dos gases (J mol⁻¹ K⁻¹), CODATA 2018. */
export const R_UNIVERSAL = 8.31446261815324;
/** Constante de Boltzmann (J K⁻¹). */
export const K_BOLTZMANN = 1.380649e-23;
/** Constante de Stefan–Boltzmann (W m⁻² K⁻⁴). */
export const STEFAN_BOLTZMANN = 5.670374419e-8;
/** Gravidade padrão (m s⁻²). */
export const G0_SI = 9.80665;
/** Constante gravitacional (m³ kg⁻¹ s⁻²) — idêntica a physics.js. */
export const G_SI = 6.67430e-11;
/** Constante de Sutton–Graves para ar (kg^0.5 m⁻¹) → q em W m⁻². */
export const SUTTON_GRAVES_K = 1.7415e-4;
/** Densidade de referência de Detra–Kemp–Riddell (kg m⁻³). */
export const RHO_REF_DKR = 1.225;
/** Velocidade de referência de Detra–Kemp–Riddell (m s⁻¹). */
export const V_REF_DKR = 7925;

/** Massas molares (kg mol⁻¹). */
export const MOLAR_MASS = Object.freeze({
  H2: 2.01588e-3,
  He: 4.002602e-3,
  N2: 28.0134e-3,
  O2: 31.9988e-3,
  Ar: 39.948e-3,
  CO2: 44.0095e-3,
  CO: 28.0101e-3,
  CH4: 16.0425e-3,
  H2O: 18.01528e-3,
  SO2: 64.066e-3,
  Ne: 20.1797e-3,
});

/** Composição do ar seco (frações molares, US Standard Atmosphere 1976). */
export const DRY_AIR = Object.freeze({ N2: 0.78084, O2: 0.209476, Ar: 0.00934, CO2: 0.00042 });

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Ângulo em (-π, π]. */
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const positiveOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

/* ========================================================================== */
/*  1. Propriedades de gases                                                  */
/* ========================================================================== */

/**
 * Massa molar média (kg/mol) de uma mistura, a partir de frações molares.
 * @param {Record<string, number>} composition ex.: { N2: 0.78, O2: 0.21 }
 * @returns {number}
 */
export function molarMassOf(composition) {
  let sum = 0;
  let total = 0;
  for (const [species, fraction] of Object.entries(composition ?? {})) {
    const m = MOLAR_MASS[species];
    if (m == null || !Number.isFinite(fraction) || fraction <= 0) continue;
    sum += m * fraction;
    total += fraction;
  }
  return total > 0 ? sum / total : 0.0289644;
}

/**
 * Viscosidade dinâmica por correlação de Sutherland (Pa·s).
 *   μ(T) = μ0 (T/T0)^1.5 (T0 + S) / (T + S)
 * @param {number} temperature K
 * @param {{mu0?:number, T0?:number, S?:number}} [coeff] padrão: ar
 * @returns {number} Pa·s
 */
export function sutherlandViscosity(temperature, coeff = {}) {
  const { mu0 = 1.716e-5, T0 = 273.15, S = 110.4 } = coeff;
  const T = Math.max(1, temperature);
  const r = T / T0;
  return mu0 * r * Math.sqrt(r) * (T0 + S) / (T + S);
}

/**
 * Velocidade do som em gás ideal: a = sqrt(γ R_esp T) = sqrt(γ R T / M).
 * @param {number} temperature K
 * @param {number} gamma razão de calores específicos
 * @param {number} molarMass kg/mol
 */
export function speedOfSound(temperature, gamma = 1.4, molarMass = 0.0289644) {
  if (!(temperature > 0) || !(molarMass > 0)) return 0;
  return Math.sqrt(gamma * R_UNIVERSAL * temperature / molarMass);
}

/**
 * Número de Mach.
 * @param {number} speed m/s
 * @param {number} soundSpeed m/s
 */
export function machNumber(speed, soundSpeed) {
  return soundSpeed > 0 ? Math.abs(speed) / soundSpeed : 0;
}

/**
 * Número de Knudsen Kn = λ / L (caminho livre médio / comprimento característico).
 * Kn < 0.01 → contínuo; 0.01–10 → transição; > 10 → molecular livre.
 */
export function knudsenNumber(meanFreePath, length) {
  return length > 0 && Number.isFinite(meanFreePath) ? meanFreePath / length : 0;
}

/**
 * Classificação de regime de escoamento a partir de Kn.
 * @returns {'continuum'|'transition'|'free-molecular'|'vacuum'}
 */
export function flowRegime(kn, density = 1) {
  if (!(density > 0)) return 'vacuum';
  if (kn <= 0.01) return 'continuum';
  if (kn < 10) return 'transition';
  return 'free-molecular';
}

/**
 * Coeficiente de espalhamento de Rayleigh (m⁻¹) para um comprimento de onda.
 *   β = 8π³(n²−1)² / (3 N λ⁴) ≈ 32π³(n−1)² / (3 N λ⁴)
 *
 * @param {number} wavelengthNm comprimento de onda em nm (ex.: 550)
 * @param {number} refractivity n − 1 do gás na densidade de referência
 * @param {number} numberDensity N, moléculas por m³
 * @returns {number} coeficiente de espalhamento em m⁻¹
 */
export function rayleighScatteringCoefficient(wavelengthNm, refractivity, numberDensity) {
  const lambda = (wavelengthNm * 1e-9);
  if (!(lambda > 0) || !(numberDensity > 0) || !(refractivity > 0)) return 0;
  const nMinus1Sq = refractivity * refractivity;   // (n−1)²
  return (32 * Math.PI ** 3 * nMinus1Sq) / (3 * numberDensity * lambda ** 4);
}

/** Função de fase de Rayleigh (normalizada a 1 sobre a esfera). */
export function rayleighPhase(cosTheta = 1) {
  const c = clamp(cosTheta, -1, 1);
  return (3 / (16 * Math.PI)) * (1 + c * c);
}

/**
 * Função de fase de Mie — aproximação de Henyey–Greenstein.
 * @param {number} cosTheta cosseno do ângulo de espalhamento
 * @param {number} g anisotropia (−1..1; aerossóis terrestres ≈ 0.76)
 */
export function miePhase(cosTheta, g = 0.76) {
  const c = clamp(cosTheta, -1, 1);
  const gg = clamp(g, -0.999, 0.999);
  const denom = 1 + gg * gg - 2 * gg * c;
  return (1 - gg * gg) / (4 * Math.PI * Math.pow(Math.max(denom, 1e-9), 1.5));
}

/**
 * Aproximação de corpo negro (Tanner Helland) → RGB 0..255.
 * @param {number} temperature K
 */
export function blackbodyRGB(temperature) {
  const t = clamp(Number(temperature) || 0, 1000, 40000) / 100;
  let r;
  let g;
  let b;
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
 * Brilho térmico visível normalizado — pronto para shaders/bloom.
 * Abaixo de ~700 K o objeto é essencialmente invisível no óptico.
 * @param {number} temperature K
 * @param {number} [referenceTemperature] temperatura à qual intensity = 1
 */
export function thermalGlow(temperature, referenceTemperature = 2200) {
  const rgb = blackbodyRGB(temperature);
  const visible = clamp((temperature - 700) / (referenceTemperature - 700), 0, 1.5);
  const intensity = clamp(visible * visible, 0, 1);
  return {
    rgb: [rgb.r / 255, rgb.g / 255, rgb.b / 255],
    rgb255: [rgb.r, rgb.g, rgb.b],
    intensity,
    temperature,
  };
}

/* ========================================================================== */
/*  2. Presets atmosféricos                                                   */
/* ========================================================================== */

/**
 * Perfis reduzidos para simulação orbital em 2D. As camadas são dadas em
 * altitude geopotencial (m) e temperatura (K); o gradiente é derivado.
 * A pressão/base e a densidade são integradas hidrostaticamente no construtor.
 *
 * Cada preset também define composição (→ massa molar, γ), coeficientes de
 * espalhamento (Rayleigh/Mie), ventos e parâmetros de aquecimento.
 */
export const ATMOSPHERE_PRESETS = Object.freeze({
  /* ---------------------------------------------------------------- Terra -- */
  earth: {
    name: 'Terra',
    planetRadius: 6.371e6,
    mu: 3.986004418e14,
    g0: 9.80665,                          // gravidade-padrão da hipometria (USSA76)
    rotationRate: 7.2921159e-5,           // rad/s (sideral, co-rotação do ar)
    topAltitude: 700e3,
    surfacePressure: 101325,
    surfaceTemperature: 288.15,
    exosphereTemperature: 1150,           // T assintótica da termosfera (K)
    exosphereScale: 180e3,                // escala de relaxação térmica (m)
    thermosphereMolarMass: 0.014,         // M médio da termosfera (N/O atômicos)
    molarMassScale: 130e3,                // escala da separação difusiva (m)
    gamma: 1.4,
    // Constantes exatas do US Standard Atmosphere 1976.
    molarMass: 0.0289644,
    universalGasConstant: 8.31432,
    composition: { ...DRY_AIR },
    // Camadas do US Standard Atmosphere 1976 (geopotencial).
    layers: [
      [0, 288.15], [11000, 216.65], [20000, 216.65], [32000, 228.65],
      [47000, 270.65], [51000, 270.65], [71000, 214.65], [84852, 186.946],
    ],
    wavelengthsNm: [680, 550, 440],       // R, G, B (visível)
    refractivity: [2.75e-4, 2.78e-4, 2.93e-4],
    mie: { surfaceCoefficient: 2.1e-5, scaleHeight: 1200, anisotropy: 0.76, wavelengthExponent: 1.0 },
    heatshield: { constant: SUTTON_GRAVES_K },
    winds: { surface: 6, surfaceScaleHeight: 2000, jetPeak: 45, jetAltitude: 11000, jetWidth: 8000 },
  },

  /* ---------------------------------------------------------------- Marte -- */
  mars: {
    name: 'Marte',
    planetRadius: 3.3895e6,
    mu: 4.282837e13,
    g0: 3.711,
    rotationRate: 7.088218e-5,
    topAltitude: 300e3,
    surfacePressure: 610,
    surfaceTemperature: 214,
    exosphereTemperature: 220,
    exosphereScale: 120e3,
    gamma: 1.30,
    molarMass: 0.04334,
    viscosity: { mu0: 1.37e-5, T0: 273.15, S: 222 },
    composition: { CO2: 0.9537, N2: 0.027, Ar: 0.016, O2: 0.0013, CO: 0.0008 },
    layers: [[0, 214], [15000, 190], [40000, 150], [90000, 130], [130000, 150]],
    wavelengthsNm: [680, 550, 440],
    refractivity: [4.40e-4, 4.50e-4, 4.75e-4],
    mie: { surfaceCoefficient: 4.0e-5, scaleHeight: 9000, anisotropy: 0.70, wavelengthExponent: 0.6 },
    heatshield: { constant: 1.9e-4 },
    winds: { surface: 2, surfaceScaleHeight: 3000, jetPeak: 30, jetAltitude: 30000, jetWidth: 15000 },
  },

  /* --------------------------------------------------------------- Vênus -- */
  venus: {
    name: 'Vênus',
    planetRadius: 6.0518e6,
    mu: 3.24859e14,
    g0: 8.87,
    rotationRate: -2.99237e-7,            // rotação retrógrada
    topAltitude: 350e3,
    surfacePressure: 9.2e6,
    surfaceTemperature: 737,
    exosphereTemperature: 300,
    exosphereScale: 100e3,
    gamma: 1.28,
    molarMass: 0.04345,
    viscosity: { mu0: 1.37e-5, T0: 273.15, S: 240 },
    composition: { CO2: 0.965, N2: 0.035 },
    layers: [[0, 737], [50000, 350], [70000, 230], [100000, 175], [150000, 180]],
    wavelengthsNm: [680, 550, 440],
    refractivity: [4.30e-4, 4.45e-4, 4.70e-4],
    mie: { surfaceCoefficient: 8.0e-5, scaleHeight: 5000, anisotropy: 0.65, wavelengthExponent: 1.0 },
    heatshield: { constant: 2.1e-4 },
    winds: { surface: 0.5, surfaceScaleHeight: 2000, jetPeak: 100, jetAltitude: 65000, jetWidth: 8000 },
  },

  /* --------------------------------------------------------------- Titã --- */
  titan: {
    name: 'Titã',
    planetRadius: 2.5747e6,
    mu: 8.9781e12,
    g0: 1.352,
    rotationRate: 4.5601e-6,
    topAltitude: 800e3,
    surfacePressure: 146700,
    surfaceTemperature: 93.7,
    exosphereTemperature: 180,
    exosphereScale: 150e3,
    gamma: 1.33,
    molarMass: 0.02784,
    viscosity: { mu0: 1.66e-5, T0: 273.15, S: 107 },
    composition: { N2: 0.949, CH4: 0.049, H2: 0.002 },
    layers: [[0, 93.7], [40000, 70], [80000, 120], [150000, 160]],
    wavelengthsNm: [680, 550, 440],
    refractivity: [2.90e-4, 2.95e-4, 3.05e-4],
    mie: { surfaceCoefficient: 1.0e-4, scaleHeight: 60000, anisotropy: 0.60, wavelengthExponent: 1.4 },
    heatshield: { constant: 1.9e-4 },
    winds: { surface: 1, surfaceScaleHeight: 5000, jetPeak: 20, jetAltitude: 100000, jetWidth: 40000 },
  },

  /* ------------------------------------------------------------- Júpiter -- */
  jupiter: {
    name: 'Júpiter',
    planetRadius: 6.9911e7,
    mu: 1.26687e17,
    g0: 24.79,
    rotationRate: 1.7585e-4,
    topAltitude: 1500e3,
    surfacePressure: 1e5,                 // nível de referência de 1 bar
    surfaceTemperature: 165,
    exosphereTemperature: 900,
    exosphereScale: 400e3,
    gamma: 1.40,
    molarMass: 0.00222,
    composition: { H2: 0.89, He: 0.11 },
    layers: [[0, 165], [100000, 110], [300000, 160]],
    wavelengthsNm: [680, 550, 440],
    refractivity: [1.25e-4, 1.30e-4, 1.36e-4],
    mie: { surfaceCoefficient: 1.0e-5, scaleHeight: 20000, anisotropy: 0.75, wavelengthExponent: 1.0 },
    heatshield: { constant: 2.0e-4 },
    winds: { surface: 20, surfaceScaleHeight: 10000, jetPeak: 150, jetAltitude: 200000, jetWidth: 100000 },
  },
});

/** Aliases aceitos por `AtmosphereModel.resolve` / `calculateAtmosphere`. */
const PRESET_ALIASES = Object.freeze({
  terra: 'earth', earth: 'earth', sol: 'earth',
  marte: 'mars', mars: 'mars',
  venus: 'venus', 'vênus': 'venus',
  tita: 'titan', titan: 'titan',
  jupiter: 'jupiter', 'júpiter': 'jupiter',
});

/** Cache de modelos por preset (chave: nome normalizado). */
const PRESET_CACHE = new Map();
/** Cache de modelos vinculados a corpos do physics.js (chave: objeto Body). */
const BODY_MODEL_CACHE = new WeakMap();

const DEFAULT_MIE = {
  surfaceCoefficient: 2e-5,   // m⁻¹ @ 550 nm na superfície
  scaleHeight: 1200,          // m
  anisotropy: 0.76,           // g de Henyey–Greenstein
  wavelengthExponent: 1.0,    // β ∝ λ^-n
};

const DEFAULT_VISCOSITY = { mu0: 1.716e-5, T0: 273.15, S: 110.4 };

const DEFAULT_WINDS = {
  surface: 0,
  surfaceScaleHeight: 2000,
  jetPeak: 0,
  jetAltitude: 12000,
  jetWidth: 8000,
};

/** Reconhece um `Body`/`Spacecraft` do physics.js (estado dinâmico, não config). */
function isBodyLike(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.surfacePressure !== undefined || value.layers !== undefined || value.scaleHeight !== undefined) return false;
  if (Array.isArray(value.layers)) return false;
  const hasMass = typeof value.mass === 'number';
  const hasRadius = typeof value.radius === 'number';
  return hasMass && hasRadius && (value.x !== undefined || value.vx !== undefined || value.mass > 0);
}

const DEFAULT_AERO = {
  cdSubsonic: 0.32,
  cdTransonic: 0.62,
  cdSupersonic: 0.85,
  cdFreeMolecular: 2.2,
  rarefactionKn: 0.35,
};

/** Defaults aerodinâmicos/térmicos de uma espaçonave. */
export const SPACECRAFT_AERO_DEFAULTS = Object.freeze({
  cd: 2.2,                    // cápsula/satélite típico (hipersônico)
  liftCoefficient: 0,         // 0 = sem sustentação; >0 habilita CL = CL·sin(2α)
  emissivity: 0.85,
  specificHeat: 900,          // J kg⁻¹ K⁻¹ (pele de alumínio/titânio ~ 900)
  initialTemperature: 288.15, // K
  maxTemperature: 2200,       // K — limite estrutural (dano opcional)
  ablationTemperature: 3200,  // K
  heatOfAblation: 2.5e7,      // J kg⁻¹
  thermalMassFraction: 0.03,  // fração da massa na "pele" exposta (pele fina)
  thermalMassMin: 5,           // kg — piso para naves muito leves
  heatingAreaFraction: 1.0,   // fração da área de referência exposta ao fluxo
  particleRate: 180,          // partículas/s no pico
  particleFluxReference: 2.0e6,
  particleTemperatureThreshold: 900,
  particleCoolingTau: 0.6,    // s
});

/* ========================================================================== */
/*  3. AtmosphereModel                                                        */
/* ========================================================================== */

/**
 * Modelo atmosférico configurável (camadas ou exponencial) com propriedades
 * termodinâmicas, espalhamento de luz e ventos.
 *
 * @example
 *   const terra = new AtmosphereModel({ ...ATMOSPHERE_PRESETS.earth });
 *   const st = terra.stateAt(400e3);
 *   st.density;   // ~ 3.9e-12 kg/m³
 *   st.temperature;
 *
 * @example <caption>Modelo exponencial simples (game scale / lua custom)</caption>
 *   const simple = new AtmosphereModel({
 *     name: 'MinhaAtmosfera', planetRadius: 1.7e6,
 *     surfacePressure: 5e4, surfaceTemperature: 250,
 *     scaleHeight: 8000, gamma: 1.4, molarMass: 0.028,
 *   });
 */
export class AtmosphereModel {
  /**
   * @param {object} config
   * @param {string}  [config.name]                Nome do modelo/planeta.
   * @param {number}  [config.planetRadius]        Raio do corpo (m).
   * @param {number}  [config.mu]                  Parâmetro gravitacional (m³/s²).
   * @param {number}  [config.g0]                  Gravidade superficial (m/s²).
   * @param {number}  [config.rotationRate]        Rotação do corpo (rad/s) — arrasto co-rotativo.
   * @param {number}  [config.topAltitude]         Topo da atmosfera (m).
   * @param {number}  [config.surfacePressure]     Pressão na superfície (Pa).
   * @param {number}  [config.surfaceTemperature]  Temperatura na superfície (K).
   * @param {Array<[number,number]>} [config.layers] [altitude, T] — camadas.
   * @param {'geopotential'|'geometric'} [config.layerReference]
   * @param {number}  [config.scaleHeight]         Ativa modo exponencial (m).
   * @param {number}  [config.surfaceDensity]      ρ0 no modo exponencial (kg/m³).
   * @param {Record<string,number>} [config.composition] Frações molares.
   * @param {number}  [config.molarMass]           Sobrescreve a massa molar (kg/mol).
   * @param {number}  [config.gamma]               Razão de calores específicos.
   * @param {number}  [config.exosphereTemperature] T assintótica da termosfera (K).
   * @param {number}  [config.exosphereScale]      Escala de relaxação térmica (m).
   * @param {number}  [config.thermosphereMolarMass] M médio da termosfera (kg/mol).
   * @param {number}  [config.molarMassScale]      Escala da separação difusiva (m).
   * @param {number}  [config.universalGasConstant] R* (J mol⁻¹ K⁻¹).
   * @param {number[]} [config.wavelengthsNm]      Canais RGB (nm).
   * @param {number[]} [config.refractivity]       (n−1) por canal.
   * @param {object}  [config.mie]                 Parâmetros de Mie.
   * @param {object}  [config.winds]               Modelo de ventos.
   * @param {object}  [config.aero]                Curva de Cd (sub/trans/super/molecular).
   */
  constructor(config = {}) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('AtmosphereModel: config deve ser um objeto.');
    }
    /** @type {object} configuração original (permite clonar para outro corpo). */
    this.config = config;
    this.name = config.name ?? 'atmosfera';
    this.planetRadius = positiveOr(config.planetRadius ?? config.radius, 6.371e6);
    this.mu = Number.isFinite(config.mu) ? config.mu
      : (Number.isFinite(config.gm) ? config.gm : null);
    this.g0 = positiveOr(
      config.g0,
      this.mu ? this.mu / (this.planetRadius * this.planetRadius) : G0_SI,
    );
    this.rotationRate = Number.isFinite(config.rotationRate) ? config.rotationRate : 0;
    this.topAltitude = positiveOr(config.topAltitude, 1e6);

    this.gamma = positiveOr(config.gamma, 1.4);
    this.composition = { ...(config.composition ?? DRY_AIR) };
    this.molarMass = positiveOr(config.molarMass, molarMassOf(this.composition));
    this.universalGasConstant = positiveOr(config.universalGasConstant, R_UNIVERSAL);
    this.gasConstant = this.universalGasConstant / this.molarMass;

    this.surfacePressure = Math.max(0, Number.isFinite(config.surfacePressure) ? config.surfacePressure : 101325);
    this.surfaceTemperature = positiveOr(config.surfaceTemperature, 288.15);
    this.exosphereTemperature = positiveOr(
      config.exosphereTemperature,
      Math.max(this.surfaceTemperature, 300),
    );
    this.exosphereScale = positiveOr(config.exosphereScale, 250e3);
    // Separação difusiva: acima da homosfera, espécies leves (O, He, H) passam a
    // dominar e a massa molar média cai. Isso controla a escala de altura
    // termosférica e, portanto, o arrasto orbital em LEO.
    this.thermosphereMolarMass = positiveOr(config.thermosphereMolarMass, this.molarMass * 0.55);
    this.molarMassScale = positiveOr(config.molarMassScale, 200e3);

    this.wavelengthsNm = Array.isArray(config.wavelengthsNm) && config.wavelengthsNm.length >= 3
      ? config.wavelengthsNm.slice(0, 3)
      : [680, 550, 440];
    this.refractivity = Array.isArray(config.refractivity) && config.refractivity.length >= 3
      ? config.refractivity.slice(0, 3)
      : [2.75e-4, 2.78e-4, 2.93e-4];

    this.mie = { ...DEFAULT_MIE, ...(config.mie ?? {}) };
    this.viscosity = { ...DEFAULT_VISCOSITY, ...(config.viscosity ?? {}) };
    this.winds = { ...DEFAULT_WINDS, ...(config.winds ?? {}) };
    this.aero = { ...DEFAULT_AERO, ...(config.aero ?? {}) };
    this.heatingConstant = positiveOr(config.heatshield?.constant ?? config.heatingConstant, SUTTON_GRAVES_K);

    // --- modo de densidade -------------------------------------------------
    if (Array.isArray(config.layers) && config.layers.length > 1) {
      this.mode = 'layered';
      this._buildLayers(config.layers, config.layerReference ?? 'geopotential');
    } else if (positiveOr(config.scaleHeight, 0) > 0) {
      this.mode = 'exponential';
      this.scaleHeight = config.scaleHeight;
      this.surfaceDensity = positiveOr(
        config.surfaceDensity,
        this.surfacePressure / (this.gasConstant * this.surfaceTemperature),
      );
      this.temperatureLapse = Number.isFinite(config.temperatureLapse) ? config.temperatureLapse : 0;
    } else {
      this.mode = 'layered';
      this._buildLayers(
        ATMOSPHERE_PRESETS.earth.layers,
        'geopotential',
      );
    }

    if (this.mode === 'layered') this._buildExtension();

    // Referências de espalhamento à densidade de superfície.
    this.refNumberDensity = this.surfacePressure / (K_BOLTZMANN * this.surfaceTemperature);
    this.refDensity = this.surfacePressure / (this.gasConstant * this.surfaceTemperature);
    this.rayleighRef = this._computeRayleighRef();
  }

  /* ------------------------------ construção ----------------------------- */

  /** @private Converte (n−1) em coeficientes de Rayleigh de referência. */
  _computeRayleighRef() {
    const out = new Float64Array(3);
    for (let i = 0; i < 3; i++) {
      out[i] = rayleighScatteringCoefficient(
        this.wavelengthsNm[i], this.refractivity[i], this.refNumberDensity,
      );
    }
    return out;
  }

  /**
   * @private Constrói as tabelas de camadas e integra a pressão hidrostática.
   * As camadas podem estar em altitude geopotencial (padrão, como no USSA76)
   * ou geométrica (`layerReference: 'geometric'`).
   */
  _buildLayers(layers, reference = 'geopotential') {
    const R = this.planetRadius;
    const pts = [];
    for (const entry of layers) {
      let h;
      let T;
      if (Array.isArray(entry)) {
        h = Number(entry[0]);
        T = Number(entry[1]);
      } else if (entry && typeof entry === 'object') {
        h = Number(entry.h ?? entry.altitude ?? entry.z);
        T = Number(entry.T ?? entry.temperature);
      }
      if (Number.isFinite(h) && Number.isFinite(T) && T > 0) pts.push({ h, T });
    }
    pts.sort((a, b) => a.h - b.h);
    if (pts.length < 2) return false;
    if (pts[0].h > 0) pts.unshift({ h: 0, T: this.surfaceTemperature });

    const n = pts.length;
    const zs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h = pts[i].h;
      zs[i] = reference === 'geometric' ? (R * h) / (R + h) : h;
    }

    const tLevels = new Float64Array(n);
    for (let i = 0; i < n; i++) tLevels[i] = pts[i].T;

    const lapse = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dz = zs[i + 1] - zs[i];
      lapse[i] = dz > 1e-6 ? (tLevels[i + 1] - tLevels[i]) / dz : 0;
    }

    const basePressure = new Float64Array(n);
    basePressure[0] = this.surfacePressure;
    const expo = -this.g0 * this.molarMass / this.universalGasConstant;
    for (let i = 0; i < n - 1; i++) {
      const L = lapse[i];
      const dz = zs[i + 1] - zs[i];
      if (Math.abs(L) < 1e-12) {
        basePressure[i + 1] = basePressure[i] * Math.exp((expo * dz) / Math.max(tLevels[i], 1));
      } else {
        basePressure[i + 1] = basePressure[i] * Math.pow(tLevels[i + 1] / tLevels[i], expo / L);
      }
    }

    this.zLevels = zs;
    this.tLevels = tLevels;
    this.lapse = lapse;
    this.basePressure = basePressure;
    this.tableTopZ = zs[n - 1];
    this.tableTopAltitude = this._geometric(zs[n - 1]);
    this.topAltitude = Math.max(this.topAltitude, this.tableTopAltitude * 1.1);
    return true;
  }

  /** @private Altitude geopotencial → geométrica. */
  _geometric(z) {
    return (this.planetRadius * z) / (this.planetRadius - z);
  }

  /** @private Altitude geométrica → geopotencial. */
  _geopotential(h) {
    return (this.planetRadius * h) / (this.planetRadius + h);
  }

  /**
   * @private Temperatura acima do topo da tabela. A atmosfera superior relaxa
   * assintoticamente para a temperatura exosférica.
   */
  _extTemperature(h) {
    const T0 = this.tLevels[this.tLevels.length - 1];
    const Tinf = this.exosphereTemperature;
    const s = this.exosphereScale;
    return Tinf - (Tinf - T0) * Math.exp(-(Math.max(h, this.tableTopAltitude) - this.tableTopAltitude) / s);
  }

  /**
   * @private Massa molar média acima do topo da tabela (kg/mol). Na homosfera
   * a composição é uniforme; acima, a difusão gravitacional enriquece o gás em
   * espécies leves, reduzindo M(h) até o valor termosférico.
   */
  _extMolarMass(h) {
    const dst = Math.max(h, this.tableTopAltitude) - this.tableTopAltitude;
    const M0 = this.molarMass;
    const Minf = this.thermosphereMolarMass;
    if (!(Minf > 0) || Minf >= M0) return M0;
    return Minf + (M0 - Minf) * Math.exp(-dst / this.molarMassScale);
  }

  /**
   * @private Escala de altura local na termosfera, H = R*·T / (M(h)·g).
   * A queda de M(h) com a altitude aumenta H e, portanto, a densidade orbital.
   */
  _extScaleHeight(h) {
    const M = this._extMolarMass(h);
    const T = this._extTemperature(h);
    return (this.universalGasConstant * T) / (Math.max(M, 1e-9) * Math.max(this.gravityAt(h), 1e-9));
  }

  /**
   * @private Integra a coluna hidrostática acima da tabela
   *   d(ln P)/dh = −g(h)·M(h) / (R*·T(h))
   * por ponto médio em uma LUT de nós quadráticos (densos junto à tabela) e
   * guarda ln(P) para interpolação linear no índice. Sem isso, a extensão
   * usaria apenas a escala de altura local e erraria a densidade orbital em
   * ordens de grandeza.
   */
  _buildExtension() {
    const n = this.tLevels.length;
    const hTop = this.tableTopAltitude;
    const N = 512;
    const hMax = Math.max(this.topAltitude * 2, hTop * 3, hTop + 1e6);
    const L = hMax - hTop;
    const lnP = new Float64Array(N + 1);
    lnP[0] = Math.log(Math.max(this.basePressure[n - 1], 1e-12));
    for (let i = 0; i < N; i++) {
      // Nós com espaçamento quadrático: densos junto à tabela (H pequeno) e
      // esparsos no topo (H grande). d(ln P)/dh = −g(h)·M(h) / (R*·T(h)).
      const w0 = (i / N) ** 2;
      const w1 = ((i + 1) / N) ** 2;
      const dh = L * (w1 - w0);
      const hM = hTop + L * (((i + 0.5) / N) ** 2);
      lnP[i + 1] = lnP[i] - dh / Math.max(this._extScaleHeight(hM), 1);
    }
    this.extTopAltitude = hMax;
    this.extLength = L;
    this.extNodes = N;
    this.extLnPressure = lnP;
    this.topAltitude = Math.max(this.topAltitude, hTop);
    return true;
  }

  /** @private Pressão/temperatura acima da tabela via LUT integrada. */
  _stateAboveTable(h) {
    const hTop = this.tableTopAltitude;
    const N = this.extLnPressure.length - 1;
    const hMax = this.extTopAltitude;
    const hClamped = Math.min(h, hMax);
    const T = this._extTemperature(hClamped);
    const M = this._extMolarMass(hClamped);
    const Rspec = this.universalGasConstant / Math.max(M, 1e-9);
    let P;
    if (h >= hMax) {
      // Além da LUT: continua exponencialmente com a escala local.
      const gTop = this.gravityAt(hMax);
      const H = (Rspec * this._extTemperature(hMax)) / Math.max(gTop, 1e-9);
      P = Math.exp(this.extLnPressure[N]) * Math.exp(-(h - hMax) / H);
    } else {
      const x = Math.sqrt(clamp((h - hTop) / this.extLength, 0, 1)) * N;
      const i = Math.min(Math.max(Math.floor(x), 0), N - 1);
      const f = clamp(x - i, 0, 1);
      const lnP = this.extLnPressure[i] * (1 - f) + this.extLnPressure[i + 1] * f;
      P = Math.exp(lnP);
    }
    const rho = P / (Rspec * Math.max(T, 1));
    return { T, P, rho, molarMass: M, gasConstant: Rspec };
  }

  /** @private Índice da camada que contém z (limitado à tabela). */
  _layerIndex(z) {
    const zs = this.zLevels;
    let i = 0;
    while (i < zs.length - 2 && z >= zs[i + 1]) i++;
    return i;
  }

  /* --------------------------- fábricas / resolução ---------------------- */

  /**
   * Instancia um preset embutido ('earth', 'mars', 'venus', 'titan', 'jupiter').
   * @param {string} name
   * @param {object} [overrides] sobrescreve campos da configuração.
   */
  static preset(name, overrides = {}) {
    const key = PRESET_ALIASES[String(name ?? '').toLowerCase()];
    const cfg = key ? ATMOSPHERE_PRESETS[key] : null;
    if (!cfg) throw new Error(`AtmosphereModel.preset: preset desconhecido "${name}".`);
    return new AtmosphereModel({ ...cfg, ...overrides });
  }

  /** Lista dos presets disponíveis. */
  static get presets() { return Object.keys(ATMOSPHERE_PRESETS); }

  /**
   * Instância compartilhada (e memorizada) de um preset — evita reconstruir as
   * tabelas hidrostáticas a cada chamada de `calculateAtmosphere` em loop.
   * Para personalizar, use `AtmosphereModel.preset(name, overrides)`.
   * @param {string} name
   * @returns {AtmosphereModel}
   */
  static cachedPreset(name) {
    const key = String(name ?? '').trim().toLowerCase();
    let model = PRESET_CACHE.get(key);
    if (!model) {
      model = AtmosphereModel.preset(name);
      PRESET_CACHE.set(key, model);
    }
    return model;
  }

  /**
   * Resolve qualquer fonte aceitável → AtmosphereModel (ou null em vácuo).
   * Fontes: instância, nome de preset, objeto de configuração, `Body` do
   * physics.js com `body.atmosphere`, ou corpo cujo nome casa com um preset.
   *
   * @param {AtmosphereModel|string|object|null} source
   * @param {object|null} [body] corpo do physics.js para herdar raio/μ/massa.
   * @param {object} [options]
   * @param {number} [options.G] constante gravitacional para derivar μ da massa.
   * @returns {AtmosphereModel|null}
   */
  static resolve(source, body = null, options = {}) {
    // 1) Modelo pronto.
    if (source instanceof AtmosphereModel) return source.forBody(body, options);

    // 2) Nome de preset: 'earth' | 'Terra' | 'mars' ...
    if (typeof source === 'string') {
      const key = PRESET_ALIASES[source.trim().toLowerCase()];
      if (!key) {
        throw new Error(
          `AtmosphereModel.resolve: preset desconhecido "${source}". `
          + `Disponíveis: ${Object.keys(ATMOSPHERE_PRESETS).join(', ')}.`,
        );
      }
      return new AtmosphereModel({ ...ATMOSPHERE_PRESETS[key] }).forBody(body, options);
    }

    // 3) Objeto: pode ser configuração, Body do physics.js ou { preset, ... }.
    if (source && typeof source === 'object') {
      if (isBodyLike(source)) {
        if (source.atmosphere != null) return AtmosphereModel.resolve(source.atmosphere, source, options);
        const key = PRESET_ALIASES[String(source.name ?? '').trim().toLowerCase()];
        if (!key) return null;                       // corpo sem atmosfera → vácuo
        return new AtmosphereModel({ ...ATMOSPHERE_PRESETS[key] }).forBody(source, options);
      }
      if (typeof source.preset === 'string') {
        const key = PRESET_ALIASES[source.preset.trim().toLowerCase()];
        if (!key) throw new Error(`AtmosphereModel.resolve: preset desconhecido "${source.preset}".`);
        return new AtmosphereModel({ ...ATMOSPHERE_PRESETS[key], ...source }).forBody(body, options);
      }
      return new AtmosphereModel({ ...source }).forBody(body ?? source, options);
    }

    // 4) Sem fonte: tenta o próprio corpo.
    if (body && typeof body === 'object') {
      if (body.atmosphere != null) return AtmosphereModel.resolve(body.atmosphere, body, options);
      const key = PRESET_ALIASES[String(body.name ?? '').trim().toLowerCase()];
      if (key) return new AtmosphereModel({ ...ATMOSPHERE_PRESETS[key] }).forBody(body, options);
    }
    return null;
  }

  /**
   * Cria uma cópia do modelo vinculada ao raio/massa de um corpo do physics.js
   * (útil para escalas de jogo em que o raio não coincide com o preset).
   * @param {object|null} body
   * @param {{G?:number}} [options]
   * @returns {AtmosphereModel} `this` se não houver mudança relevante.
   */
  forBody(body, options = {}) {
    if (!body) return this;
    const G = Number.isFinite(options.G) ? options.G : G_SI;
    const radius = positiveOr(body.radius, this.planetRadius);
    const mu = Number.isFinite(body.mu) ? body.mu
      : (body.mass > 0 ? G * body.mass : this.mu);
    const sameRadius = Math.abs(radius - this.planetRadius) <= Math.max(1, this.planetRadius * 1e-9);
    const sameMu = !Number.isFinite(mu) || !Number.isFinite(this.mu)
      || Math.abs(mu - this.mu) <= Math.abs(this.mu) * 1e-6;
    if (sameRadius && sameMu) return this;

    return new AtmosphereModel({
      ...this.config,
      planetRadius: radius,
      mu: Number.isFinite(mu) ? mu : undefined,
      g0: Number.isFinite(mu) ? mu / (radius * radius) : this.g0,
    });
  }

  /* ------------------------------ gravidade ------------------------------ */

  /** Gravidade local (m/s²) a uma altitude geométrica. */
  gravityAt(altitude = 0) {
    const r = Math.max(1, this.planetRadius + Math.max(altitude, -this.planetRadius * 0.999));
    if (Number.isFinite(this.mu) && this.mu > 0) return this.mu / (r * r);
    return this.g0 * (this.planetRadius / r) ** 2;
  }

  /* --------------------------- estado atmosférico ------------------------ */

  /**
   * Calcula o estado atmosférico completo a uma altitude geométrica.
   * O objeto `target` é reutilizado quando fornecido (evita alocações em loop).
   *
   * @param {number} altitude metros
   * @param {object} [target] objeto de saída reutilizável
   * @param {object} [options]
   * @param {boolean} [options.scattering=false] inclui coeficientes de Rayleigh/Mie
   * @param {string}  [options.bodyName]
   * @returns {object} estado atmosférico (ver documentação do módulo)
   */
  stateAt(altitude, target = {}, options = {}) {
    const out = target && typeof target === 'object' ? target : {};
    const h = Number.isFinite(altitude) ? altitude : 0;
    const hEff = Math.max(h, 0);
    const R = this.planetRadius;
    const z = this._geopotential(hEff);
    const g = this.gravityAt(hEff);

    // Defaults da homosfera (a extensão termosférica sobrescreve M e R_esp).
    out.molarMass = this.molarMass;
    out.gasConstant = this.gasConstant;
    if (!options.scattering) {
      out.rayleigh = null;
      out.mie = null;
      out.extinction = null;
      out.opticalDepth = null;
      out.scattering = null;
    }

    let T;
    let P;
    let rho;

    if (this.mode === 'exponential') {
      rho = this.surfaceDensity * Math.exp(-hEff / this.scaleHeight);
      T = this.surfaceTemperature + this.temperatureLapse * hEff;
      P = rho * this.gasConstant * T;
      out.scaleHeight = this.scaleHeight;
    } else {
      const zs = this.zLevels;
      const n = zs.length;
      const topH = this.tableTopAltitude;

      if (hEff > topH) {
        // Atmosfera superior: coluna hidrostática integrada (LUT) com T
        // relaxando para a exosfera.
        const upper = this._stateAboveTable(hEff);
        T = upper.T;
        P = upper.P;
        rho = upper.rho;
        out.molarMass = upper.molarMass;
        out.gasConstant = upper.gasConstant;
        out.scaleHeight = (upper.gasConstant * T) / Math.max(g, 1e-6);
      } else {
        const i = Math.min(this._layerIndex(z), n - 2);
        const zb = zs[i];
        const dz = z - zb;
        const L = this.lapse[i] ?? 0;
        const Tb = this.tLevels[i];
        T = Math.max(1, Tb + L * dz);
        const expo = -this.g0 * this.molarMass / this.universalGasConstant;
        if (Math.abs(L) < 1e-12) {
          P = this.basePressure[i] * Math.exp((expo * dz) / Tb);
        } else {
          P = this.basePressure[i] * Math.pow(T / Tb, expo / L);
        }
        rho = P / (this.gasConstant * T);
        out.scaleHeight = P / (rho * Math.max(g, 1e-9));
      }
    }

    if (!Number.isFinite(T) || T <= 0) T = this.surfaceTemperature;
    if (!Number.isFinite(P) || P < 0) P = 0;
    if (!Number.isFinite(rho) || rho < 0) rho = 0;

    const muVisc = sutherlandViscosity(T, this.viscosity);
    // A velocidade do som usa M(h): na termosfera o gás é mais leve.
    const sound = speedOfSound(T, this.gamma, out.molarMass);
    const mfp = P > 0
      ? (muVisc / P) * Math.sqrt((Math.PI * this.universalGasConstant * T) / (2 * Math.max(out.molarMass ?? this.molarMass, 1e-6)))
      : Infinity;
    const kn = knudsenNumber(mfp, 1);   // referência: 1 m (indicação de regime)
    const wind = this.windAt(hEff);

    out.bodyName = options.bodyName ?? this.name;
    out.model = this;
    out.altitude = h;
    out.geometricAltitude = h;
    out.geopotentialAltitude = z;
    out.belowSurface = h < 0;
    out.temperature = T;
    out.pressure = P;
    out.density = rho;
    out.gravity = g;
    out.speedOfSound = sound;
    out.meanFreePath = mfp;
    out.knudsen = kn;
    out.regime = flowRegime(kn, rho);
    out.numberDensity = P > 0 ? P / (K_BOLTZMANN * T) : 0;
    out.dynamicViscosity = muVisc;
    out.kinematicViscosity = rho > 0 ? muVisc / rho : Infinity;
    out.gamma = this.gamma;
    out.omega = this.rotationRate;
    out.wind = wind;
    out.topAltitude = this.topAltitude;
    out.vacuum = !(rho > 1e-15) || hEff > this.topAltitude;
    if (out.vacuum) out.regime = 'vacuum';

    // A orientação / vento local é preenchida por quem tem a posição da nave
    // (calculateAtmosphere + corpo, ou AtmosphereSystem).
    if (out.airVelocity === undefined) out.airVelocity = null;
    if (out.origin === undefined) out.origin = null;

    if (options.scattering) this._fillScattering(out, hEff, rho);

    return out;
  }

  /* -------------------------- propriedades diretas ----------------------- */

  /** Densidade (kg/m³) a uma altitude geométrica. */
  densityAt(altitude) { return this.stateAt(altitude).density; }
  /** Pressão (Pa). */
  pressureAt(altitude) { return this.stateAt(altitude).pressure; }
  /** Temperatura (K). */
  temperatureAt(altitude) { return this.stateAt(altitude).temperature; }
  /** Velocidade do som (m/s). */
  speedOfSoundAt(altitude) { return this.stateAt(altitude).speedOfSound; }
  /** Escala de altura local H = P / (ρ g) (m). */
  scaleHeightAt(altitude) { return this.stateAt(altitude).scaleHeight; }

  /**
   * Perfil vertical amostrado — pronto para LUTs de renderização/shaders.
   * @param {number} [samples] número de amostras
   * @param {number} [topAltitude] topo (padrão: this.topAltitude)
   * @param {boolean} [scattering] incluir coeficientes ópticos
   * @returns {object[]}
   */
  profile(samples = 64, topAltitude = null, scattering = true) {
    const n = Math.max(2, samples | 0);
    const top = topAltitude ?? this.topAltitude;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const h = (top * i) / (n - 1);
      out[i] = this.stateAt(h, {}, { scattering });
    }
    return out;
  }

  /* ----------------------------- espalhamento ---------------------------- */

  /** @private Preenche rayleigh/mie/extinção/opticalDepth no estado. */
  _fillScattering(out, h, rho) {
    const wl = this.wavelengthsNm;
    const nRatio = this.refDensity > 0 ? rho / this.refDensity : 0;
    const rayleigh = new Float64Array(3);
    const mie = new Float64Array(3);
    const extinction = new Float64Array(3);
    const mieBase = this.mie.surfaceCoefficient;
    const mieH = this.mie.scaleHeight;
    const mieExp = this.mie.wavelengthExponent;
    for (let i = 0; i < 3; i++) {
      rayleigh[i] = this.rayleighRef[i] * nRatio;
      mie[i] = mieBase * Math.pow(wl[1] / wl[i], mieExp) * Math.exp(-Math.max(h, 0) / mieH);
      extinction[i] = rayleigh[i] + mie[i];
    }
    const H = Number.isFinite(out.scaleHeight) ? out.scaleHeight : 0;
    const opticalDepth = new Float64Array(3);
    for (let i = 0; i < 3; i++) opticalDepth[i] = rayleigh[i] * H + mie[i] * mieH;

    out.rayleigh = { rgb: rayleigh, beta: rayleigh[0] + rayleigh[1] + rayleigh[2] };
    out.mie = {
      rgb: mie,
      beta: mie[0] + mie[1] + mie[2],
      anisotropy: this.mie.anisotropy,
      scaleHeight: mieH,
    };
    out.extinction = { rgb: extinction };
    out.opticalDepth = { rgb: opticalDepth, vertical: opticalDepth[1] };
    out.scattering = {
      wavelengthsNm: wl.slice(),
      rayleighPhase: rayleighPhase(1),
      miePhase: miePhase(1, this.mie.anisotropy),
      rayleighColor: [rayleigh[0], rayleigh[1], rayleigh[2]],
      mieColor: [mie[0], mie[1], mie[2]],
    };
    return out;
  }

  /**
   * Coeficientes de Rayleigh por canal RGB (m⁻¹) a uma altitude.
   * A dependência é linear na densidade do gás (β ∝ N).
   * @returns {{rgb:Float64Array, beta:number}}
   */
  rayleighCoefficients(altitude = 0) {
    const rho = this.densityAt(altitude);
    const nRatio = this.refDensity > 0 ? rho / this.refDensity : 0;
    const rgb = new Float64Array(3);
    for (let i = 0; i < 3; i++) rgb[i] = this.rayleighRef[i] * nRatio;
    return { rgb, beta: rgb[0] + rgb[1] + rgb[2] };
  }

  /**
   * Coeficientes de Mie por canal RGB (m⁻¹) a uma altitude.
   * Usa a escala de altura dos aerossóis (independente da escala do gás).
   * @returns {{rgb:Float64Array, beta:number, anisotropy:number}}
   */
  mieCoefficients(altitude = 0) {
    const h = Math.max(altitude, 0);
    const rgb = new Float64Array(3);
    for (let i = 0; i < 3; i++) {
      rgb[i] = this.mie.surfaceCoefficient
        * Math.pow(this.wavelengthsNm[1] / this.wavelengthsNm[i], this.mie.wavelengthExponent)
        * Math.exp(-h / this.mie.scaleHeight);
    }
    return { rgb, beta: rgb[0] + rgb[1] + rgb[2], anisotropy: this.mie.anisotropy };
  }

  /**
   * Propriedades ópticas completas para iluminação/atmosfera em tela.
   * `cosTheta` é o cosseno do ângulo entre a direção de visão e a luz solar.
   * @param {object} state saída de `stateAt`
   * @param {number} [cosTheta=1]
   */
  scattering(state, cosTheta = 1) {
    const st = state ?? this.stateAt(0);
    const rayleigh = this.rayleighCoefficients(st.altitude ?? 0);
    const mie = this.mieCoefficients(st.altitude ?? 0);
    const wavelength = this.wavelengthsNm;
    const extinction = new Float64Array(3);
    for (let i = 0; i < 3; i++) extinction[i] = rayleigh.rgb[i] + mie.rgb[i];
    return {
      altitude: st.altitude ?? 0,
      wavelengthsNm: wavelength.slice(),
      rayleigh: { ...rayleigh, phase: rayleighPhase(cosTheta) },
      mie: { ...mie, phase: miePhase(cosTheta, mie.anisotropy) },
      extinction,
      opticalDepth: this.opticalDepth(st.altitude ?? 0),
    };
  }

  /**
   * Profundidade ótica vertical aproximada (integração exponencial):
   *   τ(h) ≈ β(h)·H
   * @returns {{rayleigh:Float64Array, mie:Float64Array, total:Float64Array}}
   */
  opticalDepth(altitude = 0) {
    const st = this.stateAt(altitude);
    const H = Number.isFinite(st.scaleHeight) ? st.scaleHeight : 0;
    const r = this.rayleighCoefficients(altitude);
    const m = this.mieCoefficients(altitude);
    const rayleigh = new Float64Array(3);
    const mie = new Float64Array(3);
    const total = new Float64Array(3);
    for (let i = 0; i < 3; i++) {
      rayleigh[i] = r.rgb[i] * H;
      mie[i] = m.rgb[i] * this.mie.scaleHeight;
      total[i] = rayleigh[i] + mie[i];
    }
    return { rayleigh, mie, total };
  }

  /* --------------------------------- vento ------------------------------- */

  /**
   * Vento tangencial (m/s, positivo no sentido de rotação) a uma altitude.
   * Perfil simples: brisa de superfície + jato em altitude (gaussiana).
   */
  windAt(altitude = 0) {
    const w = this.winds;
    const h = Math.max(altitude, 0);
    const surface = (w.surface ?? 0) * Math.exp(-h / positiveOr(w.surfaceScaleHeight, 2000));
    const dz = h - (w.jetAltitude ?? 12000);
    const jet = (w.jetPeak ?? 0) * Math.exp(-((dz / positiveOr(w.jetWidth, 8000)) ** 2));
    return surface + jet;
  }

  /**
   * Velocidade absoluta do ar em um ponto próximo ao corpo (co-rotação +
   * vento tangencial + velocidade do próprio corpo).
   * @param {object} body corpo do physics.js ({x,y,vx,vy})
   * @param {number} x posição do ponto (m)
   * @param {number} y posição do ponto (m)
   * @param {number} [altitude] altitude no ponto (para o perfil de vento)
   * @param {{x:number,y:number}} [out] objeto reutilizável
   * @returns {{x:number,y:number}} velocidade absoluta do ar (m/s)
   */
  airVelocityAt(body, x, y, altitude = null, out = { x: 0, y: 0 }) {
    const ox = body?.x ?? 0;
    const oy = body?.y ?? 0;
    const rx = x - ox;
    const ry = y - oy;
    const r = Math.hypot(rx, ry) || 1;
    const h = Number.isFinite(altitude) ? altitude : r - this.planetRadius;
    const tangential = this.rotationRate * r + this.windAt(h);
    out.x = (body?.vx ?? 0) - (ry / r) * tangential;
    out.y = (body?.vy ?? 0) + (rx / r) * tangential;
    return out;
  }

  /* --------------------------- coeficiente de Cd ------------------------- */

  /**
   * Curva de Cd dependente de Mach e Kn (contínuo → molecular livre).
   * Um `cd` numérico em `overrides` (ou na config) força valor constante.
   * @param {number} mach
   * @param {number} [kn]
   * @param {object} [overrides]
   */
  dragCoefficient(mach, kn = 0, overrides = {}) {
    const a = overrides && typeof overrides === 'object' ? { ...this.aero, ...overrides } : this.aero;
    if (typeof a.cd === 'number' && Number.isFinite(a.cd)) return a.cd;

    const m = Math.max(0, Number(mach) || 0);
    const sub = positiveOr(a.cdSubsonic, 0.32);
    const trans = positiveOr(a.cdTransonic, 0.62);
    const sup = positiveOr(a.cdSupersonic, 0.85);
    const fm = positiveOr(a.cdFreeMolecular, 2.2);

    let cd;
    if (m <= 0.8) cd = sub;
    else if (m < 1.2) cd = lerp(sub, trans, (m - 0.8) / 0.4);
    else if (m < 3) cd = lerp(trans, sup, (m - 1.2) / 1.8);
    else cd = sup;

    const k = Math.max(0, Number(kn) || 0);
    const blend = k > 0 ? clamp(k / (k + positiveOr(a.rarefactionKn, 0.35)), 0, 1) : 0;
    return cd * (1 - blend) + fm * blend;
  }
}

/* ========================================================================== */
/*  4. calculateAtmosphere — estado atmosférico a partir de altitude + corpo  */
/* ========================================================================== */

/** @private Preenche um estado de vácuo (corpo sem atmosfera / espaço). */
function fillVacuumState(target, altitude, options = {}) {
  const out = target ?? {};
  out.model = null;
  out.bodyName = options.bodyName ?? null;
  out.altitude = Number.isFinite(altitude) ? altitude : 0;
  out.geometricAltitude = out.altitude;
  out.geopotentialAltitude = out.altitude;
  out.belowSurface = false;
  out.density = 0;
  out.pressure = 0;
  out.temperature = positiveOr(options.spaceTemperature, 3);
  out.gravity = 0;
  out.scaleHeight = Infinity;
  out.speedOfSound = 0;
  out.meanFreePath = Infinity;
  out.knudsen = Infinity;
  out.numberDensity = 0;
  out.dynamicViscosity = 0;
  out.kinematicViscosity = Infinity;
  out.molarMass = 0;
  out.gasConstant = 0;
  out.gamma = 0;
  out.omega = 0;
  out.wind = 0;
  out.topAltitude = 0;
  out.vacuum = true;
  out.regime = 'vacuum';
  out.origin = null;
  out.airVelocity = null;
  return out;
}

/**
 * Calcula o estado atmosférico a uma altitude, para um corpo qualquer.
 *
 * Aceita:
 *  - `'earth' | 'mars' | 'venus' | 'titan' | 'jupiter'`
 *  - `AtmosphereModel`
 *  - objeto de configuração atmosférica
 *  - `Body` do physics.js (usa `body.atmosphere`, ou o nome do corpo como preset)
 *  - `null` → estado de vácuo (densidade 0), sem lançar exceção
 *
 * O estado retornado carrega `origin` e `omega` para que o arrasto calcule a
 * velocidade relativa ao ar co-rotativo sem precisar do corpo novamente.
 *
 * Desempenho: o modelo resolvido é memorizado (preset por nome ou corpo por
 * identidade) e o estado pode ser escrito em `options.out` — chamadas em loop
 * ficam abaixo de 1 µs. Modelos memorizados são compartilhados: para
 * personalizar use `AtmosphereModel.preset(nome, overrides)` ou o construtor.
 *
 * @param {number} altitude altitude geométrica acima da superfície (m)
 * @param {object|string|AtmosphereModel|null} body corpo ou fonte do modelo
 * @param {object} [options]
 * @param {object} [options.out] objeto reutilizável (zero alocações)
 * @param {boolean} [options.scattering] incluir coeficientes ópticos
 * @param {number} [options.G] G para derivar μ da massa do corpo
 * @returns {object} estado atmosférico
 */
export function calculateAtmosphere(altitude, body = null, options = {}) {
  const h = Number.isFinite(altitude) ? altitude : 0;
  let model = null;

  if (typeof body === 'string') {
    // Preset por nome: modelo memorizado (sem alocação por chamada).
    model = AtmosphereModel.cachedPreset(body);
  } else if (body && typeof body === 'object' && !(body instanceof AtmosphereModel)) {
    // Corpo/configuração: reutiliza o modelo enquanto raio, GM e fonte não
    // mudarem (evita reconstruir a LUT hidrostática a cada frame).
    const cached = BODY_MODEL_CACHE.get(body);
    const source = body.atmosphere;
    if (cached && cached.source === source && cached.radius === body.radius && cached.mu === body.mu) {
      model = cached.model;
    } else {
      try {
        model = AtmosphereModel.resolve(body, body, options);
      } catch (err) {
        // Nome de preset inválido é erro de programação: propaga sempre.
        if (options.strict) throw err;
        model = null;
      }
      BODY_MODEL_CACHE.set(body, { source, radius: body.radius, mu: body.mu, model });
    }
  } else {
    try {
      model = AtmosphereModel.resolve(body, body, options);
    } catch (err) {
      if (options.strict) throw err;
      model = null;
    }
  }

  if (!model) {
    const out = fillVacuumState(options.out ?? {}, h, options);
    if (body && Number.isFinite(body.x)) {
      out.origin = { x: body.x, y: body.y, vx: body.vx ?? 0, vy: body.vy ?? 0 };
    }
    return out;
  }

  const out = model.stateAt(h, options.out ?? {}, options);
  out.bodyName = body?.name ?? model.name;
  if (body && Number.isFinite(body.x) && Number.isFinite(body.y)) {
    out.origin = out.origin ?? {};
    out.origin.x = body.x;
    out.origin.y = body.y;
    out.origin.vx = body.vx ?? 0;
    out.origin.vy = body.vy ?? 0;
  } else {
    out.origin = null;
  }
  out.omega = model.rotationRate;
  return out;
}

/**
 * Perfil vertical de um modelo/corpo (atalho para `AtmosphereModel.profile`).
 * @param {object|string|AtmosphereModel} body
 * @param {number} [samples]
 * @param {number} [topAltitude]
 * @param {boolean} [scattering]
 */
export function buildAtmosphereProfile(body, samples = 64, topAltitude = null, scattering = true) {
  const model = AtmosphereModel.resolve(body, body);
  if (!model) return [];
  return model.profile(samples, topAltitude, scattering);
}

/* ========================================================================== */
/*  5. Arrasto e aquecimento — funções físicas                                */
/* ========================================================================== */

/**
 * Pressão dinâmica q = ½ ρ v² (Pa).
 */
export function dynamicPressure(density, speed) {
  if (!(density > 0) || !(speed > 0)) return 0;
  return 0.5 * density * speed * speed;
}

/**
 * Força de arrasto Fd = ½ ρ v² Cd A (N).
 */
export function dragForce(density, speed, cd, area) {
  if (!(density > 0) || !(speed > 0) || !(cd > 0) || !(area > 0)) return 0;
  return 0.5 * density * speed * speed * cd * area;
}

/**
 * Fluxo de calor convectivo de estagnação — Sutton–Graves:
 *   q̇ = k √(ρ / R_n) · v³     [W/m²]
 *
 * Correlação clássica para reentrada em ar (k = 1.7415e-4 kg^0.5/m).
 * @param {number} density ρ (kg/m³)
 * @param {number} speed v relativa ao ar (m/s)
 * @param {number} noseRadius R_n (m)
 * @param {number} [k] constante do gás/planeta
 */
export function suttonGravesHeatFlux(density, speed, noseRadius, k = SUTTON_GRAVES_K) {
  if (!(density > 0) || !(speed > 0) || !(noseRadius > 0)) return 0;
  return k * Math.sqrt(density / noseRadius) * speed * speed * speed;
}

/**
 * Fluxo de calor convectivo — Detra–Kemp–Riddell (alternativa a Sutton–Graves):
 *   q̇ = 1.103e8 / √R_n · (ρ/ρ0)^0.5 · (v/7925)^3.15   [W/m²]
 */
export function detraKempRiddellHeatFlux(density, speed, noseRadius) {
  if (!(density > 0) || !(speed > 0) || !(noseRadius > 0)) return 0;
  return (1.103e8 / Math.sqrt(noseRadius))
    * Math.sqrt(density / RHO_REF_DKR)
    * Math.pow(speed / V_REF_DKR, 3.15);
}

/**
 * Velocidade relativa da espaçonave em relação ao ar.
 * Prioridade: `state.airVelocity` → `state.origin` + ω×r + vento → repouso.
 *
 * @param {object} spacecraft Body/Spacecraft do physics.js
 * @param {object} state estado de `calculateAtmosphere`
 * @returns {{x:number,y:number,airX:number,airY:number}}
 */
export function relativeAirVelocity(spacecraft, state) {
  let ax = 0;
  let ay = 0;
  if (state?.airVelocity && Number.isFinite(state.airVelocity.x)) {
    ax = state.airVelocity.x;
    ay = state.airVelocity.y;
  } else if (state?.origin && Number.isFinite(state.origin.x)) {
    const ox = state.origin.x ?? 0;
    const oy = state.origin.y ?? 0;
    const rx = (spacecraft?.x ?? 0) - ox;
    const ry = (spacecraft?.y ?? 0) - oy;
    const r = Math.hypot(rx, ry);
    const rSafe = r || 1;
    const tangential = (state.omega ?? 0) * r + (state.wind ?? 0);
    ax = (state.origin.vx ?? 0) - (ry / rSafe) * tangential;
    ay = (state.origin.vy ?? 0) + (rx / rSafe) * tangential;
  }
  return {
    x: (spacecraft?.vx ?? 0) - ax,
    y: (spacecraft?.vy ?? 0) - ay,
    airX: ax,
    airY: ay,
  };
}

/** @private Resolve propriedades geométricas e térmicas da espaçonave. */
function resolveAeroProperties(spacecraft, state, options = {}) {
  const cfg = spacecraft?.aero ?? spacecraft?.aerodynamics ?? {};
  const radius = positiveOr(spacecraft?.radius, 1);
  const area = positiveOr(cfg.area ?? cfg.crossSection ?? cfg.referenceArea, Math.PI * radius * radius);
  const noseRadius = positiveOr(cfg.noseRadius, Math.max(radius * 0.5, 0.02));
  const characteristicLength = positiveOr(cfg.characteristicLength, 2 * noseRadius);
  const cdSpec = cfg.cd ?? options.cd ?? SPACECRAFT_AERO_DEFAULTS.cd;
  return {
    area,
    noseRadius,
    characteristicLength,
    cdSpec,
    autoCd: cdSpec === 'auto' || cfg.autoDragCoefficient === true,
    liftCoefficient: Number.isFinite(cfg.liftCoefficient)
      ? cfg.liftCoefficient
      : (Number.isFinite(options.liftCoefficient) ? options.liftCoefficient : 0),
    emissivity: clamp(Number.isFinite(cfg.emissivity) ? cfg.emissivity : SPACECRAFT_AERO_DEFAULTS.emissivity, 0, 1),
    specificHeat: positiveOr(cfg.specificHeat, SPACECRAFT_AERO_DEFAULTS.specificHeat),
    initialTemperature: positiveOr(cfg.initialTemperature, SPACECRAFT_AERO_DEFAULTS.initialTemperature),
    maxTemperature: positiveOr(cfg.maxTemperature, SPACECRAFT_AERO_DEFAULTS.maxTemperature),
    ablationTemperature: positiveOr(cfg.ablationTemperature, SPACECRAFT_AERO_DEFAULTS.ablationTemperature),
    heatOfAblation: positiveOr(cfg.heatOfAblation, SPACECRAFT_AERO_DEFAULTS.heatOfAblation),
    heatingArea: positiveOr(
      cfg.heatingArea,
      area * clamp(positiveOr(cfg.heatingAreaFraction, SPACECRAFT_AERO_DEFAULTS.heatingAreaFraction), 0, 1),
    ),
    heatingScale: positiveOr(cfg.heatingScale, 1),
    // Massa térmica da pele: uma fração da massa total (a pele aquece muito mais
    // rápido que o corpo da nave). Pode ser fixada via `aero.thermalMass`.
    thermalMass: positiveOr(
      cfg.thermalMass,
      Math.max(
        (spacecraft?.mass ?? 1000) * clamp(
          positiveOr(cfg.thermalMassFraction, SPACECRAFT_AERO_DEFAULTS.thermalMassFraction), 1e-4, 1,
        ),
        SPACECRAFT_AERO_DEFAULTS.thermalMassMin,
      ),
    ),
    particleRate: positiveOr(cfg.particleRate, SPACECRAFT_AERO_DEFAULTS.particleRate),
    particleFluxReference: positiveOr(cfg.particleFluxReference, SPACECRAFT_AERO_DEFAULTS.particleFluxReference),
    particleTemperatureThreshold: positiveOr(cfg.particleTemperatureThreshold, SPACECRAFT_AERO_DEFAULTS.particleTemperatureThreshold),
    particleCoolingTau: positiveOr(cfg.particleCoolingTau, SPACECRAFT_AERO_DEFAULTS.particleCoolingTau),
    cfg,
  };
}

/**
 * Garante (e devolve) o estado térmico persistente da espaçonave.
 * Campos públicos úteis para HUD/renderização:
 *   temperature, peakTemperature, totalHeatLoad, particles[], ablationMass.
 * @param {object} spacecraft
 * @param {object} [options]
 * @returns {object}
 */
export function ensureThermalState(spacecraft, options = {}) {
  if (!spacecraft || typeof spacecraft !== 'object') {
    throw new TypeError('ensureThermalState: spacecraft inválido.');
  }
  let th = spacecraft.thermal;
  if (!th || typeof th !== 'object') th = spacecraft.thermal = {};
  if (!Number.isFinite(th.temperature)) {
    th.temperature = positiveOr(options.initialTemperature, SPACECRAFT_AERO_DEFAULTS.initialTemperature);
  }
  if (!Number.isFinite(th.peakTemperature)) th.peakTemperature = th.temperature;
  if (!Number.isFinite(th.totalHeatLoad)) th.totalHeatLoad = 0;
  if (!Number.isFinite(th.ablationMass)) th.ablationMass = 0;
  if (!Number.isFinite(th.emitAccumulator)) th.emitAccumulator = 0;
  if (!Number.isFinite(th.rngState)) th.rngState = 0x9e3779b9;
  if (!Array.isArray(th.particles)) th.particles = [];
  return th;
}

/** @private PRNG determinístico (LCG) — mantém a simulação reprodutível. */
function nextRandom(th) {
  th.rngState = (Math.imul(th.rngState, 1664525) + 1013904223) >>> 0;
  return th.rngState / 4294967296;
}

/** @private Cria uma partícula térmica na face de barlavento. */
function spawnThermalParticle(spacecraft, th, ctx, aero) {
  const speed = Math.max(ctx.speed, 0);
  const rvx = ctx.relativeVelocity.x;
  const rvy = ctx.relativeVelocity.y;
  const windwardX = speed > 1e-9 ? -rvx / speed : 0;
  const windwardY = speed > 1e-9 ? -rvy / speed : 0;
  const radius = positiveOr(spacecraft.radius, 1);
  const lateral = (nextRandom(th) - 0.5) * radius * 1.6;
  const back = radius * (0.35 + nextRandom(th) * 0.5);
  const jitterSpeed = speed * (0.02 + nextRandom(th) * 0.06) + 2;

  const temperature = ctx.temperature * (0.65 + nextRandom(th) * 0.55);
  const glow = thermalGlow(temperature);
  const life = 0.25 + nextRandom(th) * 1.1;

  return {
    // Posição absoluta no mundo (mesma referência de physics.js).
    x: (spacecraft.x ?? 0) - windwardX * back - windwardY * lateral,
    y: (spacecraft.y ?? 0) - windwardY * back + windwardX * lateral,
    vx: (spacecraft.vx ?? 0) - windwardX * jitterSpeed + (nextRandom(th) - 0.5) * 2.5,
    vy: (spacecraft.vy ?? 0) - windwardY * jitterSpeed + (nextRandom(th) - 0.5) * 2.5,
    temperature,
    life,
    maxLife: life,
    size: radius * (0.05 + nextRandom(th) * 0.14),
    coolingTau: aero.particleCoolingTau,
    r: glow.rgb255[0],
    g: glow.rgb255[1],
    b: glow.rgb255[2],
    intensity: glow.intensity,
    kind: 'plasma',
  };
}

/** @private Atualiza/emite partículas térmicas. */
function updateThermalParticles(spacecraft, th, aero, state, ctx, dt, options) {
  const list = th.particles;
  const maxParticles = Math.max(0, options.maxParticlesPerCraft ?? 320);
  let write = 0;
  for (let read = 0; read < list.length; read++) {
    const p = list[read];
    p.life -= dt;
    if (p.life <= 0) continue;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const dragFactor = Math.exp(-dt * 1.8);
    p.vx *= dragFactor;
    p.vy *= dragFactor;
    p.temperature *= Math.exp(-dt / Math.max(p.coolingTau, 1e-3));
    const glow = thermalGlow(p.temperature);
    p.intensity = glow.intensity;
    p.r = glow.rgb255[0];
    p.g = glow.rgb255[1];
    p.b = glow.rgb255[2];
    list[write++] = p;
  }
  list.length = write;

  if (options.particles === false || maxParticles === 0) return 0;

  const heatFactor = clamp(ctx.heatFlux / aero.particleFluxReference, 0, 1);
  const tempFactor = clamp(
    (ctx.temperature - aero.particleTemperatureThreshold) / 1200,
    0, 1,
  );
  const rate = aero.particleRate * heatFactor * tempFactor;
  if (!(rate > 0)) return 0;

  th.emitAccumulator += rate * dt;
  let count = Math.min(Math.floor(th.emitAccumulator), 24);
  th.emitAccumulator = Math.min(th.emitAccumulator - count, 8);
  let emitted = 0;
  while (count-- > 0) {
    if (list.length >= maxParticles) list.shift();
    list.push(spawnThermalParticle(spacecraft, th, ctx, aero));
    emitted++;
  }
  return emitted;
}

/** @private Integra o balanço térmico da pele (radiação + ablação opcional). */
function integrateThermal(spacecraft, th, aero, state, heatFlux, dt, options) {
  const envTemperature = positiveOr(state?.temperature, positiveOr(options.spaceTemperature, 3));
  const emissivity = aero.emissivity;
  const area = aero.heatingArea;
  const cp = aero.specificHeat;
  const thermalMass = Math.min(Math.max(aero.thermalMass, 1e-6), 1e9);
  const heatCapacity = Math.max(cp * thermalMass, 1e-3);

  const P_in = heatFlux * area;
  const sigmaA = emissivity * STEFAN_BOLTZMANN * area;

  let T = th.temperature;
  let ablationMass = 0;
  let radiativeCooling = 0;

  // Sub-passos para estabilizar o termo radiativo (T⁴) em dt grande.
  const maxStep = clamp(Number(options.thermalStep) || 0.25, 1e-3, 1);
  const n = Math.min(64, Math.max(1, Math.ceil(dt / maxStep)));
  const h = dt / n;
  const ablationEnabled = options.ablation !== false && aero.ablationTemperature > 0 && aero.heatOfAblation > 0;

  for (let i = 0; i < n; i++) {
    radiativeCooling = sigmaA * (Math.pow(T, 4) - Math.pow(envTemperature, 4));
    if (heatFlux > 0) th.totalHeatLoad += heatFlux * area * h;

    if (ablationEnabled && T >= aero.ablationTemperature) {
      // Excesso de energia acima do necessário para manter T no limite é
      // removido por ablação: dm = (Q̇_excesso · h) / h_abl.
      const excess = Math.max(0, P_in - radiativeCooling);
      const dm = (excess * h) / aero.heatOfAblation;
      if (dm > 0) ablationMass += dm;
      T = aero.ablationTemperature;
    } else {
      T += ((P_in - radiativeCooling) * h) / heatCapacity;
    }
    if (!Number.isFinite(T)) T = th.temperature;
    T = clamp(T, 1, Math.max(aero.maxTemperature * 4, 4000));
  }

  th.temperature = T;
  th.peakTemperature = Math.max(th.peakTemperature ?? T, T);
  if (ablationMass > 0) {
    th.ablationMass += ablationMass;
    if (options.applyAblationMass && spacecraft.isSpacecraft && Number.isFinite(spacecraft.dryMass)) {
      spacecraft.dryMass = Math.max(spacecraft.dryMass - ablationMass, spacecraft.dryMass * 0.2);
    }
  }

  const glow = thermalGlow(T);
  const structural = {
    temperature: T,
    peakTemperature: th.peakTemperature,
    heatFlux,
    totalHeatLoad: th.totalHeatLoad,
    radiativeCooling,
    heatCapacity,
    emissivity,
    area,
    limit: aero.maxTemperature,
    utilization: aero.maxTemperature > 0 ? T / aero.maxTemperature : 0,
    ablationRate: dt > 0 ? ablationMass / dt : 0,
    ablationMass: th.ablationMass,
    glowColor: glow.rgb,
    glowColor255: glow.rgb255,
    glowIntensity: glow.intensity,
    status: T >= aero.maxTemperature ? 'critical' : (T > 900 ? 'hot' : (T > 400 ? 'warm' : 'nominal')),
    phase: T >= aero.ablationTemperature ? 'ablation' : (T > 1200 ? 'incandescent' : 'solid'),
  };

  return { thermalState: th, structural, radiativeCooling, ablationMass, hullTemperature: T };
}

/**
 * Resolve o argumento `atmosphere` de `applyAerodynamics` em um estado.
 * @private
 */
function resolveAtmosphereState(atmosphere, spacecraft) {
  // Altitude explícita tem prioridade (preenchida por AtmosphereSystem ou HUD).
  let altitude = Number.isFinite(spacecraft?.altitude) ? spacecraft.altitude : null;

  if (atmosphere instanceof AtmosphereModel) {
    // Fallback: assume o corpo na origem do sistema.
    if (altitude === null && Number.isFinite(spacecraft?.x) && Number.isFinite(spacecraft?.y)) {
      altitude = Math.hypot(spacecraft.x, spacecraft.y) - atmosphere.planetRadius;
    }
    return atmosphere.stateAt(altitude ?? 0);
  }

  if (atmosphere && typeof atmosphere === 'object') {
    if (Number.isFinite(atmosphere.density)) return atmosphere;   // já é um estado
    // `atmosphere` é um corpo do physics.js: deriva a altitude da geometria.
    if (altitude === null
        && Number.isFinite(atmosphere.x) && Number.isFinite(atmosphere.y)
        && Number.isFinite(atmosphere.radius)
        && Number.isFinite(spacecraft?.x) && Number.isFinite(spacecraft?.y)) {
      altitude = Math.hypot(spacecraft.x - atmosphere.x, spacecraft.y - atmosphere.y) - atmosphere.radius;
    }
    return calculateAtmosphere(altitude ?? 0, atmosphere);
  }

  return fillVacuumState({}, altitude ?? 0);
}

/* ========================================================================== */
/*  6. applyAerodynamics — arrasto + aquecimento em uma espaçonave            */
/* ========================================================================== */

/**
 * Aplica arrasto aerodinâmico e aquecimento a uma espaçonave durante `dt`.
 *
 * Física implementada
 * -------------------
 *  • Velocidade relativa ao ar co-rotativo (+ vento):
 *      v_rel = v_nave − (v_corpo + ω × r)
 *  • Arrasto: F_d = ½ ρ v_rel² C_d A, exatamente oposto a v_rel.
 *  • Integração estável da desaceleração quadrática (solução analítica):
 *      v_rel(t + dt) = v_rel / (1 + K v_rel dt),  K = ½ ρ C_d A / m
 *  • Sustentação opcional: C_L = CL·sin(2α), perpendicular a v_rel.
 *  • Aquecimento convectivo (Sutton–Graves ou DKR), balanço térmico
 *    radiativo, ablação e emissão de partículas de plasma.
 *
 * O módulo NÃO move a nave (integração de posição é do physics.js): apenas
 * atualiza `spacecraft.vx`, `spacecraft.vy` e o estado térmico.
 *
 * @param {object} spacecraft Spacecraft (ou Body) do physics.js
 * @param {object|AtmosphereModel|string} atmosphere estado de
 *        `calculateAtmosphere` (recomendado) ou modelo/configuração/corpo
 * @param {number} dt passo de tempo (s)
 * @param {object} [options]
 * @param {boolean} [options.drag=true]
 * @param {boolean} [options.heating=true]
 * @param {number}  [options.cd] Cd forçado
 * @param {number}  [options.liftCoefficient] CL para sustentação
 * @param {'sutton-graves'|'dkr'} [options.heatingModel]
 * @param {boolean} [options.applyAblationMass=false]
 * @param {number}  [options.maxParticlesPerCraft=320]
 * @returns {object|null} resultado aerodinâmico completo
 */
export function applyAerodynamics(spacecraft, atmosphere, dt, options = {}) {
  if (!spacecraft || typeof spacecraft !== 'object') {
    throw new TypeError('applyAerodynamics: spacecraft inválido.');
  }
  const step = Number(dt);
  if (!(step > 0) || !Number.isFinite(step)) return null;
  if (spacecraft.destroyed) return null;

  const state = resolveAtmosphereState(atmosphere, spacecraft);
  const model = state.model ?? null;
  const density = Number.isFinite(state.density) ? Math.max(state.density, 0) : 0;
  const aero = resolveAeroProperties(spacecraft, state, options);
  const mass = Math.max(Number(spacecraft.mass) || Number(spacecraft.dryMass) || 1, 1e-6);

  const rel = relativeAirVelocity(spacecraft, state);
  const speed = Math.hypot(rel.x, rel.y);
  const soundSpeed = Number.isFinite(state.speedOfSound) ? state.speedOfSound : 0;
  const mach = soundSpeed > 0 ? speed / soundSpeed : 0;
  const mfp = Number.isFinite(state.meanFreePath) ? state.meanFreePath : Infinity;
  const kn = knudsenNumber(mfp, aero.characteristicLength);

  // Cd numérico/forçado → constante; 'auto' → curva Mach/Kn do modelo.
  let cd;
  if (typeof aero.cdSpec === 'number' && Number.isFinite(aero.cdSpec) && !aero.autoCd) {
    cd = aero.cdSpec;
  } else if (model) {
    cd = model.dragCoefficient(mach, kn, aero.cfg);
  } else {
    cd = SPACECRAFT_AERO_DEFAULTS.cd;
  }
  cd = Math.max(cd, 0);

  const qDynamic = dynamicPressure(density, speed);
  const dragN = dragForce(density, speed, cd, aero.area);
  const dragAccel = dragN / mass;

  const result = {
    model,
    bodyName: state.bodyName ?? model?.name ?? null,
    altitude: Number.isFinite(state.altitude) ? state.altitude : null,
    density,
    pressure: Number.isFinite(state.pressure) ? state.pressure : 0,
    temperature: Number.isFinite(state.temperature) ? state.temperature : 0,
    speedOfSound: soundSpeed,
    gravity: Number.isFinite(state.gravity) ? state.gravity : 0,
    scaleHeight: state.scaleHeight ?? Infinity,
    regime: state.regime ?? (density > 0 ? flowRegime(kn, density) : 'vacuum'),
    vacuum: !!state.vacuum,
    airVelocity: { x: rel.airX, y: rel.airY },
    relativeVelocity: { x: rel.x, y: rel.y },
    speed,
    mach,
    knudsen: kn,
    dynamicPressure: qDynamic,
    dragCoefficient: cd,
    area: aero.area,
    noseRadius: aero.noseRadius,
    mass,
    dragForce: dragN,
    dragAcceleration: dragAccel,
    dragVector: { x: 0, y: 0 },
    liftForce: 0,
    liftAcceleration: 0,
    ballisticCoefficient: cd > 0 && aero.area > 0 ? mass / (cd * aero.area) : Infinity,
    heatFlux: 0,
    convectiveHeatFlux: 0,
    radiativeCooling: 0,
    totalHeatLoad: 0,
    hullTemperature: 0,
    structural: null,
    particles: null,
    emittedParticles: 0,
    applied: false,
    deltaV: 0,
  };

  /* ------------------------------ arrasto -------------------------------- */
  if (options.drag !== false && density > 0 && speed > 1e-9 && dragN > 0) {
    const oldVx = spacecraft.vx ?? 0;
    const oldVy = spacecraft.vy ?? 0;

    // Solução analítica de dv/dt = −K v² por passo → estabilidade incondicional.
    const K = (0.5 * density * cd * aero.area) / mass;
    const decay = 1 / (1 + K * speed * step);
    let newRelX = rel.x * decay;
    let newRelY = rel.y * decay;
    let newVx = rel.airX + newRelX;
    let newVy = rel.airY + newRelY;

    result.dragVector.x = -dragN * (rel.x / speed);
    result.dragVector.y = -dragN * (rel.y / speed);

    /* ------------------------- sustentação opcional ---------------------- */
    if (aero.liftCoefficient > 0 && speed > 1e-6) {
      const flowAngle = Math.atan2(-rel.y, -rel.x);
      const alpha = wrapPi((spacecraft.angle ?? 0) - flowAngle);
      const cl = aero.liftCoefficient * Math.sin(2 * alpha);
      if (cl !== 0) {
        const liftN = qDynamic * Math.abs(cl) * aero.area;
        const nX = -rel.y / speed;
        const nY = rel.x / speed;
        const sign = cl >= 0 ? 1 : -1;
        const dvLift = (liftN / mass) * step * sign;
        newVx += nX * dvLift;
        newVy += nY * dvLift;
        result.liftForce = liftN;
        result.liftAcceleration = liftN / mass;
      }
    }

    spacecraft.vx = newVx;
    spacecraft.vy = newVy;
    result.applied = true;
    result.deltaV = Math.hypot(newVx - oldVx, newVy - oldVy);
  }

  /* ----------------------------- aquecimento ----------------------------- */
  const thermal = ensureThermalState(spacecraft, aero);
  let heatFlux = 0;
  if (options.heating !== false && density > 0 && speed > 1 && model) {
    heatFlux = options.heatingModel === 'dkr'
      ? detraKempRiddellHeatFlux(density, speed, aero.noseRadius)
      : suttonGravesHeatFlux(density, speed, aero.noseRadius, model.heatingConstant);
    heatFlux *= aero.heatingScale;
  }

  const thermo = integrateThermal(spacecraft, thermal, aero, state, heatFlux, step, options);
  result.heatFlux = heatFlux;
  result.convectiveHeatFlux = heatFlux;
  result.radiativeCooling = thermo.radiativeCooling;
  result.totalHeatLoad = thermal.totalHeatLoad;
  result.hullTemperature = thermo.hullTemperature;
  result.structural = thermo.structural;

  result.emittedParticles = updateThermalParticles(
    spacecraft,
    thermal,
    aero,
    state,
    {
      heatFlux,
      temperature: thermo.hullTemperature,
      relativeVelocity: rel,
      speed,
    },
    step,
    options,
  );
  result.particles = thermal.particles;

  // Cache conveniente para HUD/renderização (mesmo objeto atualizado no lugar).
  spacecraft.aeroState = result;
  return result;
}

/* ========================================================================== */
/*  7. AtmosphereSystem — integração com o PhysicsEngine                      */
/* ========================================================================== */

/**
 * Sistema atmosférico para o `PhysicsEngine` do physics.js.
 *
 * Instala-se de forma transparente envolvendo `engine.step(h)`: depois de cada
 * passo RK4, aplica arrasto e aquecimento com o dt do passo. Isso mantém a
 * integração orbital intacta e usa as posições/velocidades já resolvidas.
 *
 * @example
 *   const atmo = new AtmosphereSystem(engine, {
 *     models: { Terra: 'earth', Marte: 'mars' },
 *     heating: true,
 *     onReentryStart: ({ sc, result }) => console.log('reentrada', result.heatFlux),
 *   });
 *   engine.update(1 / 60);
 *   atmo.getTelemetry(sc);
 */
export class AtmosphereSystem {
  /**
   * @param {import('./physics.js').PhysicsEngine|object} engineOrOptions
   * @param {object} [maybeOptions]
   * @param {object}  [opts.engine]                Engine (quando 1º arg é objeto).
   * @param {object}  [opts.models]                { [nomeDoCorpo]: preset|config|AtmosphereModel }.
   * @param {string|object|AtmosphereModel} [opts.defaultAtmosphere] Modelo para corpos sem atmosfera definida.
   * @param {boolean} [opts.autoInstall=true]      Envolver engine.step automaticamente.
   * @param {boolean} [opts.heating=true]
   * @param {boolean} [opts.drag=true]
   * @param {boolean} [opts.particles=true]
   * @param {number}  [opts.maxParticlesPerCraft=320]
   * @param {number}  [opts.spaceTemperature=3]    Temperatura de corpo negro do espaço (K).
   * @param {number}  [opts.reentryHeatFlux=1e4]   Limiar de evento de reentrada (W/m²).
   * @param {boolean} [opts.thermalDamage=false]   Destruir a nave acima de maxTemperature.
   * @param {function} [opts.onAerodynamic]
   * @param {function} [opts.onHeating]
   * @param {function} [opts.onReentryStart]
   * @param {function} [opts.onReentryEnd]
   * @param {function} [opts.onDestroyed]
   */
  constructor(engineOrOptions = {}, maybeOptions = {}) {
    const isEngine = engineOrOptions && Array.isArray(engineOrOptions.bodies);
    const options = isEngine ? (maybeOptions ?? {}) : (engineOrOptions ?? {});
    const engine = isEngine ? engineOrOptions : options.engine;

    if (!engine || !Array.isArray(engine.bodies)) {
      throw new TypeError(
        'AtmosphereSystem: informe um PhysicsEngine (new AtmosphereSystem(engine, opts) '
        + 'ou new AtmosphereSystem({ engine, ...opts })).',
      );
    }

    this.engine = engine;
    this.options = {
      heating: true,
      drag: true,
      particles: true,
      ablation: true,
      lift: false,
      autoInstall: true,
      maxParticlesPerCraft: 320,
      spaceTemperature: 3,
      reentryHeatFlux: 1e4,
      thermalDamage: false,
      ...options,
    };

    /** @type {Map<object, AtmosphereModel>} corpo → modelo. */
    this.models = new Map();
    this.time = 0;
    this.events = [];
    this.stats = {
      maxHeatFlux: 0,
      maxDrag: 0,
      maxDynamicPressure: 0,
      maxTemperature: 0,
      reentries: 0,
    };

    this._states = new Map();
    this._installed = false;
    this._originalStep = null;
    this._wrapper = null;

    this._assignModels();
    if (this.options.autoInstall) this.install();
  }

  /** @private Associa modelos aos corpos do engine. */
  _assignModels() {
    const map = this.options.models ?? {};
    for (const body of this.engine.bodies) {
      if (body.isSpacecraft) continue;
      let source = map[body.name];
      if (source === undefined) {
        const lowerName = String(body.name ?? '').toLowerCase();
        source = Object.keys(map).find((k) => k.toLowerCase() === lowerName);
        if (source !== undefined) source = map[source];
      }
      if (source === undefined) source = body.atmosphere;
      if (source === undefined || source === null) source = this.options.defaultAtmosphere;
      if (source == null) continue;
      try {
        const model = AtmosphereModel.resolve(source, body, { G: this.engine.G });
        if (model) this.models.set(body, model);
      } catch (err) {
        if (this.options.strict) throw err;
      }
    }
  }

  /**
   * Define/atualiza o modelo atmosférico de um corpo.
   * @param {object|string} bodyRef corpo, nome ou índice
   * @param {string|object|AtmosphereModel} source
   */
  setModel(bodyRef, source) {
    const body = this._resolveBody(bodyRef);
    if (!body) throw new Error('AtmosphereSystem.setModel: corpo não encontrado.');
    const model = AtmosphereModel.resolve(source, body, { G: this.engine.G });
    if (!model) throw new Error('AtmosphereSystem.setModel: fonte atmosférica inválida.');
    this.models.set(body, model);
    return model;
  }

  /** @private */
  _resolveBody(ref) {
    if (!ref) return null;
    if (typeof ref === 'number') return this.engine.bodies[ref] ?? null;
    if (typeof ref === 'string') return this.engine.bodies.find((b) => b.name === ref) ?? null;
    return ref;
  }

  /** Modelo atmosférico associado a um corpo (ou null). */
  modelFor(bodyRef) {
    const body = this._resolveBody(bodyRef);
    return body ? (this.models.get(body) ?? null) : null;
  }

  /**
   * Instala o hook em `engine.step`. Idempotente.
   * @returns {this}
   */
  install(engine = this.engine) {
    if (this._installed && this.engine === engine) return this;
    if (this._installed) this.dispose();

    const self = this;
    this.engine = engine;
    this._originalStep = engine.step;
    const wrapper = function atmosphereStep(h = engine.fixedDt) {
      const t = self._originalStep.call(engine, h);
      self.integrate(h);
      return t;
    };
    wrapper._atmosphereWrapper = true;
    this._wrapper = wrapper;
    engine.step = wrapper;
    this._installed = true;
    engine.atmosphere = this;
    if (!this.models.size) this._assignModels();
    return this;
  }

  /** Remove o hook e restaura `engine.step`. */
  dispose() {
    if (!this._installed) return this;
    if (this._wrapper && this.engine.step === this._wrapper) {
      this.engine.step = this._originalStep;
    }
    if (this.engine.atmosphere === this) this.engine.atmosphere = null;
    this._installed = false;
    this._wrapper = null;
    return this;
  }

  /**
   * Corpo de referência com atmosfera que contém a nave (menor altitude).
   * @returns {{body:object, model:AtmosphereModel, altitude:number}|null}
   */
  referenceFor(spacecraft) {
    let best = null;
    for (const [body, model] of this.models) {
      if (body === spacecraft) continue;
      const d = Math.hypot((spacecraft.x ?? 0) - (body.x ?? 0), (spacecraft.y ?? 0) - (body.y ?? 0));
      const altitude = d - (body.radius ?? model.planetRadius);
      if (altitude > model.topAltitude) continue;
      if (!best || altitude < best.altitude) best = { body, model, altitude };
    }
    return best;
  }

  /** @private Estado de vácuo reutilizável. */
  _vacuumState(sc) {
    let state = this._states.get(sc);
    if (!state) {
      state = {};
      this._states.set(sc, state);
    }
    return fillVacuumState(state, Infinity, { spaceTemperature: this.options.spaceTemperature });
  }

  /** @private Estado atmosférico reutilizável para uma nave/corpo. */
  _stateFor(sc, ref) {
    if (!ref) return this._vacuumState(sc);
    let state = this._states.get(sc);
    if (!state) {
      state = {};
      this._states.set(sc, state);
    }
    const model = ref.model;
    const body = ref.body;
    model.stateAt(ref.altitude, state, {
      bodyName: body.name ?? model.name,
      scattering: this.options.scattering === true,
    });
    if (!state.origin) state.origin = { x: 0, y: 0, vx: 0, vy: 0 };
    state.origin.x = body.x ?? 0;
    state.origin.y = body.y ?? 0;
    state.origin.vx = body.vx ?? 0;
    state.origin.vy = body.vy ?? 0;
    state.omega = model.rotationRate;
    if (!state.airVelocity) state.airVelocity = { x: 0, y: 0 };
    model.airVelocityAt(body, sc.x ?? 0, sc.y ?? 0, ref.altitude, state.airVelocity);
    return state;
  }

  /**
   * Aplica a física atmosférica a todas as naves (chamado automaticamente
   * pelo hook de `engine.step`, mas pode ser invocado manualmente).
   * @param {number} dt segundos
   */
  integrate(dt) {
    const step = Number(dt);
    if (!(step > 0) || !Number.isFinite(step)) return;
    this.time += step;

    const spacecraftList = this.engine.spacecraft;
    for (const sc of spacecraftList) {
      if (sc.destroyed) continue;
      const ref = this.referenceFor(sc);
      const state = this._stateFor(sc, ref);
      sc.aeroAltitude = ref ? ref.altitude : Infinity;
      sc.altitude = ref ? ref.altitude : Infinity;

      const result = applyAerodynamics(sc, state, step, this.options);
      if (!result) continue;

      result.referenceBody = ref?.body ?? null;
      result.altitude = ref ? ref.altitude : null;
      result.time = this.time;

      this.stats.maxHeatFlux = Math.max(this.stats.maxHeatFlux, result.heatFlux);
      this.stats.maxDrag = Math.max(this.stats.maxDrag, result.dragForce);
      this.stats.maxDynamicPressure = Math.max(this.stats.maxDynamicPressure, result.dynamicPressure);
      this.stats.maxTemperature = Math.max(this.stats.maxTemperature, result.hullTemperature);

      this._handleEvents(sc, result);
    }
  }

  /** @private Eventos de reentrada / aquecimento / dano térmico. */
  _handleEvents(sc, result) {
    const active = result.heatFlux > this.options.reentryHeatFlux;
    const wasActive = !!sc._reentryActive;
    if (active && !wasActive) {
      sc._reentryActive = true;
      this.stats.reentries++;
      this._emit('reentry-start', sc, result);
      this.options.onReentryStart?.({ sc, result, system: this });
    } else if (!active && wasActive) {
      sc._reentryActive = false;
      this._emit('reentry-end', sc, result);
      this.options.onReentryEnd?.({ sc, result, system: this });
    }
    if (result.heatFlux > 0) {
      this.options.onHeating?.({ sc, result, system: this });
    }
    this.options.onAerodynamic?.({ sc, result, system: this });

    if (this.options.thermalDamage && result.structural
        && result.structural.utilization >= 1 && !sc.destroyed) {
      sc.destroyed = true;
      sc.throttle = 0;
      this._emit('destroyed', sc, result, { reason: 'thermal' });
      this.options.onDestroyed?.({ sc, result, reason: 'thermal', system: this });
    }
  }

  /** @private */
  _emit(type, sc, result, extra = {}) {
    this.events.push({ type, time: this.time, spacecraft: sc, result, ...extra });
    if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
  }

  /**
   * Estado atmosférico atual de uma nave (sem aplicar forças).
   * @param {object} spacecraft
   * @returns {object|null}
   */
  sample(spacecraft) {
    const ref = this.referenceFor(spacecraft);
    if (!ref) return this._vacuumState(spacecraft);
    return this._stateFor(spacecraft, ref);
  }

  /**
   * Telemetria atmosférica da nave (complementa `engine.getTelemetry`).
   * @param {object} spacecraft
   */
  getTelemetry(spacecraft) {
    const sc = spacecraft ?? this.engine.spacecraft[0];
    if (!sc) return null;
    const result = sc.aeroState;
    if (!result) return null;
    return {
      time: this.time,
      name: sc.name,
      altitude: result.altitude,
      referenceBody: result.referenceBody?.name ?? result.bodyName ?? null,
      density: result.density,
      pressure: result.pressure,
      airTemperature: result.temperature,
      speedOfSound: result.speedOfSound,
      relativeSpeed: result.speed,
      mach: result.mach,
      knudsen: result.knudsen,
      regime: result.regime,
      dynamicPressure: result.dynamicPressure,
      dragCoefficient: result.dragCoefficient,
      dragForce: result.dragForce,
      dragAcceleration: result.dragAcceleration,
      decelerationG: result.dragAcceleration / G0_SI,
      ballisticCoefficient: result.ballisticCoefficient,
      heatFlux: result.heatFlux,
      totalHeatLoad: result.totalHeatLoad,
      hullTemperature: result.hullTemperature,
      structural: result.structural,
      particles: result.particles ? result.particles.length : 0,
      inAtmosphere: !!result.applied,
      reentry: !!sc._reentryActive,
    };
  }

  /** Todas as partículas térmicas ativas no sistema (para renderização). */
  get particles() {
    const out = [];
    for (const sc of this.engine.spacecraft) {
      const list = sc.thermal?.particles;
      if (Array.isArray(list) && list.length) out.push(...list);
    }
    return out;
  }

  /** Remove partículas de todas as naves. */
  clearParticles() {
    for (const sc of this.engine.spacecraft) {
      if (Array.isArray(sc.thermal?.particles)) sc.thermal.particles.length = 0;
    }
  }

  /** Mapa de densidades/coeficientes para renderização de camadas. */
  renderProfile(bodyRef, samples = 64, scattering = true) {
    const model = this.modelFor(bodyRef);
    if (!model) return [];
    return model.profile(samples, null, scattering);
  }

  /** Serialização leve do estado atmosférico/térmico. */
  toJSON() {
    return {
      time: this.time,
      options: { ...this.options, models: undefined },
      stats: { ...this.stats },
      models: [...this.models].map(([body, model]) => ({ body: body.name, model: model.name, mode: model.mode })),
      spacecraft: this.engine.spacecraft.map((sc) => ({
        name: sc.name,
        aeroState: sc.aeroState ? {
          altitude: sc.aeroState.altitude,
          density: sc.aeroState.density,
          dragForce: sc.aeroState.dragForce,
          heatFlux: sc.aeroState.heatFlux,
          hullTemperature: sc.aeroState.hullTemperature,
          totalHeatLoad: sc.aeroState.totalHeatLoad,
        } : null,
      })),
    };
  }
}

/**
 * Atalho: cria e instala um AtmosphereSystem.
 * @param {object} engine PhysicsEngine
 * @param {object} [options]
 */
export function createAtmosphereSystem(engine, options = {}) {
  return new AtmosphereSystem(engine, options);
}

/** Alias semântico de `createAtmosphereSystem` (integração em uma linha). */
export function attachAtmosphere(engine, options = {}) {
  return new AtmosphereSystem(engine, options);
}

/** Exportações auxiliares para conversões rápidas de unidades. */
export const CONVERSIONS = Object.freeze({
  knotsToMs: 0.514444,
  kmhToMs: 1 / 3.6,
  feetToMeters: 0.3048,
  /** Kelvin → graus Celsius. */
  kelvinToCelsius: (k) => k - 273.15,
  /** Graus → radianos / radianos → graus. */
  degToRad: (d) => d * DEG,
  radToDeg: (r) => r / DEG,
  TAU,
});

export default AtmosphereSystem;
