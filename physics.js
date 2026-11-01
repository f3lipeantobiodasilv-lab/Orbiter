/**
 * ============================================================================
 *  physics.js — Motor de Física para Simulador Orbital 2D
 * ============================================================================
 *  Módulo ES6+ autocontido, sem dependências externas.
 *
 *  Conteúdo:
 *   - Body          : corpo celeste genérico (planeta, lua, estrela, asteroide)
 *   - Spacecraft    : foguete/nave com propulsão (equação de Tsiolkovsky)
 *   - PhysicsEngine : motor N-body com integrador Runge-Kutta de 4ª ordem (RK4)
 *
 *  Unidades padrão: SI (metros, quilogramas, segundos, Newtons, radianos).
 *  Para escalas de "jogo", basta passar outro valor de G no construtor do
 *  engine (ex.: new PhysicsEngine({ G: 1 }) com unidades arbitrárias).
 *
 *  Uso típico:
 *    import { PhysicsEngine, Body, Spacecraft } from './physics.js';
 *
 *    const engine = new PhysicsEngine({ G: 6.67430e-11 });
 *    engine.addBody(new Body({ name: 'Sol', mass: 1.989e30, radius: 6.957e8, fixed: true }));
 *    const nave = engine.addSpacecraft(new Spacecraft({
 *      x: 1.5e11, y: 0, vy: 29780,
 *      dryMass: 5000, fuel: 2000, maxThrust: 5e5, exhaustVelocity: 3000,
 *    }));
 *    engine.setThrottle(1);          // motor a 100%
 *    engine.update(1 / 60);          // avança a simulação (dt real em segundos)
 *    const telemetria = engine.getTelemetry(nave); // apogeu, perigeu, G, etc.
 * ============================================================================
 */

/** Constante gravitacional universal (CODATA 2018), em m^3 kg^-1 s^-2. */
export const G_SI = 6.67430e-11;
/** Aceleração gravitacional padrão ao nível do mar, em m/s^2 (1 g). */
export const G0 = 9.80665;
/** Unidade astronômica em metros. */
export const AU_M = 1.495978707e11;

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mod = (a, n) => ((a % n) + n) % n;

/** Velocidade de órbita circular: v = sqrt(mu / r). */
export function circularOrbitSpeed(mu, r) { return Math.sqrt(mu / r); }
/** Velocidade de escape: v = sqrt(2 mu / r). */
export function escapeSpeed(mu, r) { return Math.sqrt(2 * mu / r); }
/** Equação vis-viva: v = sqrt(mu (2/r - 1/a)). */
export function visVivaSpeed(mu, r, a) { return Math.sqrt(mu * (2 / r - 1 / a)); }

/**
 * Aceleração gravitacional resultante sobre um ponto (x, y) por uma lista de
 * corpos — utilitário independente para módulos de renderização/HUD.
 */
export function gravitationalAcceleration(bodies, x, y, { G = G_SI, softening = 0, exclude = null } = {}) {
  let ax = 0, ay = 0;
  const s2 = softening * softening;
  for (const b of bodies) {
    if (b === exclude) continue;
    const dx = b.x - x, dy = b.y - y;
    const r2 = dx * dx + dy * dy + s2;
    const invR = 1 / Math.sqrt(r2);
    const f = G * b.mass * invR * invR * invR; // G * m / r^3
    ax += f * dx;
    ay += f * dy;
  }
  return { x: ax, y: ay };
}

/* ========================================================================== */
/*  Body — corpo celeste                                                      */
/* ========================================================================== */

export class Body {
  /**
   * @param {object}  options
   * @param {string}  options.name    Nome do corpo.
   * @param {number}  options.x       Posição X (m).
   * @param {number}  options.y       Posição Y (m).
   * @param {number}  options.vx      Velocidade X (m/s).
   * @param {number}  options.vy      Velocidade Y (m/s).
   * @param {number}  options.mass    Massa (kg).
   * @param {number}  options.radius  Raio físico (m) — usado p/ colisões e altitude.
   * @param {string}  options.color   Cor sugerida para renderização.
   * @param {boolean} options.fixed   true = corpo ancorado (não se move, mas atrai).
   */
  constructor(options = {}) {
    this.name = options.name ?? 'corpo';
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.vx = options.vx ?? 0;
    this.vy = options.vy ?? 0;
    this._mass = options.mass ?? 0;
    this.radius = options.radius ?? 1;
    this.color = options.color ?? '#ffffff';
    this.fixed = options.fixed ?? false;
    this.isSpacecraft = false;
  }

  get mass() { return this._mass; }
  set mass(v) { this._mass = v; }

  /** Módulo da velocidade (m/s). */
  get speed() { return Math.hypot(this.vx, this.vy); }

  /** Energia cinética (J). */
  get kineticEnergy() { return 0.5 * this.mass * (this.vx * this.vx + this.vy * this.vy); }

  /** Distância euclidiana até outro corpo (m). */
  distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y); }

  toJSON() {
    return {
      type: 'body', name: this.name, x: this.x, y: this.y,
      vx: this.vx, vy: this.vy, mass: this.mass,
      radius: this.radius, color: this.color, fixed: this.fixed,
    };
  }

  static fromJSON(d) { return new Body(d); }
}

/* ========================================================================== */
/*  Spacecraft — nave/foguete com propulsão                                   */
/* ========================================================================== */

export class Spacecraft extends Body {
  /**
   * Vetor de estado completo: x, y, vx, vy, massa (dryMass + fuel),
   * angle (heading), angularVelocity, throttle, torqueInput.
   *
   * @param {object} options
   * @param {number} options.dryMass          Massa seca (kg).
   * @param {number} options.fuel             Combustível inicial (kg).
   * @param {number} options.maxThrust        Empuxo máximo do motor (N) a 100% de throttle.
   * @param {number} [options.isp]            Impulso específico (s) — alternativa a exhaustVelocity.
   * @param {number} options.exhaustVelocity  Velocidade de ejeção ve (m/s). Se isp for dado, ve = isp * g0.
   * @param {number} options.maxTorque        Torque máximo de attitude (N·m).
   * @param {number} options.momentOfInertia  Momento de inércia (kg·m²).
   * @param {number} options.angle            Heading inicial (rad, 0 = +X).
   */
  constructor(options = {}) {
    super(options);
    this.isSpacecraft = true;
    this.type = 'spacecraft';
    this.dryMass = options.dryMass ?? 1000;
    this._fuel = Math.max(0, options.fuel ?? 0);
    this.maxThrust = options.maxThrust ?? 1e6;                                   // N
    this.exhaustVelocity = options.exhaustVelocity
      ?? (options.isp != null ? options.isp * G0 : 3000);                         // m/s
    this.maxTorque = options.maxTorque ?? 1e5;                                    // N·m
    this.momentOfInertia = options.momentOfInertia ?? 1e4;                        // kg·m²
    this.angle = options.angle ?? 0;                                              // rad
    this.angularVelocity = options.angularVelocity ?? 0;                          // rad/s
    this.throttle = 0;      // 0..1 — controle de empuxo
    this.torqueInput = 0;   // -1..1 — controle de torque/atitude
    this.destroyed = false;
  }

  /** Massa total atual = massa seca + combustível (kg). */
  get mass() { return this.dryMass + this._fuel; }
  set mass(v) { this._fuel = Math.max(0, v - this.dryMass); }

  /** Combustível restante (kg). */
  get fuel() { return this._fuel; }
  set fuel(v) { this._fuel = Math.max(0, v); }

  /** Empuxo atual (N) — zero se sem combustível ou destruída. */
  get thrust() { return (this.destroyed || this._fuel <= 0) ? 0 : this.throttle * this.maxThrust; }

  /** Vazão mássica de queima (kg/s): dm/dt = F / ve. */
  get massFlow() { return this.thrust / this.exhaustVelocity; }

  /** Aceleração de empuxo atual (m/s²). */
  get thrustAcceleration() { const m = this.mass; return m > 0 ? this.thrust / m : 0; }

  /** Vetor aceleração de empuxo no plano (m/s²), na direção do heading. */
  get thrustVector() {
    const a = this.thrustAcceleration;
    return { x: a * Math.cos(this.angle), y: a * Math.sin(this.angle) };
  }

  /** Delta-v restante (m/s) pela equação de Tsiolkovsky: dv = ve * ln(m0 / mf). */
  deltaVRemaining() {
    return this._fuel > 0 ? this.exhaustVelocity * Math.log(this.mass / this.dryMass) : 0;
  }

  /** Define o throttle (0..1). Retorna o valor aplicado. */
  setThrottle(v) { this.throttle = clamp(Number(v) || 0, 0, 1); return this.throttle; }

  /**
   * Aplica um impulso instantâneo (manobra) de deltaV (m/s) ao longo do
   * heading atual, consumindo combustível segundo a Tsiolkovsky invertida:
   *   dm = m0 * (1 - exp(-|dv| / ve))
   * Retorna o delta-v realmente aplicado (limitado pelo combustível).
   */
  applyThrust(deltaV) {
    if (this.destroyed || this._fuel <= 0) return 0;
    const ve = this.exhaustVelocity;
    const m0 = this.mass;
    const dir = deltaV < 0 ? -1 : 1;
    const applied = Math.min(Math.abs(Number(deltaV) || 0), this.deltaVRemaining());
    const dm = m0 * (1 - Math.exp(-applied / ve));
    this._fuel = Math.max(0, this._fuel - dm);
    this.vx += dir * applied * Math.cos(this.angle);
    this.vy += dir * applied * Math.sin(this.angle);
    return dir * applied;
  }

  /** Define a entrada de torque de attitude (-1..1, sinal = sentido da rotação). */
  setTorqueInput(v) { this.torqueInput = clamp(Number(v) || 0, -1, 1); return this.torqueInput; }

  /** Aponta instantaneamente para um heading (rad) e zera a rotação. */
  setHeading(angle) { this.angle = angle; this.angularVelocity = 0; }

  /** Gira o heading em delta rad. */
  rotate(delta) { this.angle += delta; }

  toJSON() {
    return {
      ...super.toJSON(),
      type: 'spacecraft',
      dryMass: this.dryMass, fuel: this._fuel,
      maxThrust: this.maxThrust, exhaustVelocity: this.exhaustVelocity,
      maxTorque: this.maxTorque, momentOfInertia: this.momentOfInertia,
      angle: this.angle, angularVelocity: this.angularVelocity,
      throttle: this.throttle, torqueInput: this.torqueInput,
      destroyed: this.destroyed,
    };
  }

  static fromJSON(d) {
    const sc = new Spacecraft(d);
    sc.throttle = d.throttle ?? 0;
    sc.torqueInput = d.torqueInput ?? 0;
    sc.destroyed = d.destroyed ?? false;
    return sc;
  }
}

/* ========================================================================== */
/*  PhysicsEngine — motor N-body com RK4                                      */
/* ========================================================================== */

export class PhysicsEngine {
  /**
   * @param {object} [options]
   * @param {number} [options.G]               Constante gravitacional (padrão SI).
   * @param {number} [options.softening]       Softening length (m) p/ encontros próximos.
   * @param {number} [options.fixedDt]         Passo fixo de integração (s). Padrão 1/120 s.
   * @param {number} [options.timeScale]       Escala de tempo (1 = tempo real).
   * @param {number} [options.maxSubSteps]     Teto de sub-passos por update() (anti "spiral of death").
   * @param {number} [options.maxFrameDt]      dt real máximo acumulável por frame (s).
   * @param {boolean}[options.absorbCollisions] true = corpos que colidem se fundem (conservando momento).
   * @param {function}[options.onCollision]    Callback (event) => void em colisões.
   */
  constructor(options = {}) {
    this.G = options.G ?? G_SI;
    this.softening = options.softening ?? 0;
    this._soft2 = this.softening * this.softening;
    this.fixedDt = options.fixedDt ?? 1 / 120;
    this.timeScale = options.timeScale ?? 1;
    this.maxSubSteps = options.maxSubSteps ?? 2000;
    this.maxFrameDt = options.maxFrameDt ?? 0.25;
    this.absorbCollisions = options.absorbCollisions ?? false;
    this.onCollision = options.onCollision ?? null;

    /** @type {Body[]} lista viva de corpos (planetas, luas, estrelas, naves). */
    this.bodies = [];
    this.time = 0;

    this._acc = 0;        // acumulador do update()
    this._crafts = [];    // [{ body, index, extra, override }] — nave = 3 estados extras
    this._k1 = null;      // buffers reutilizáveis do RK4
  }

  /* ------------------------------ corpos -------------------------------- */

  addBody(body) { if (!this.bodies.includes(body)) this.bodies.push(body); return body; }
  addSpacecraft(sc) { this.addBody(sc); return sc; }

  removeBody(ref) {
    const i = typeof ref === 'string'
      ? this.bodies.findIndex(b => b.name === ref)
      : this.bodies.indexOf(ref);
    if (i >= 0) this.bodies.splice(i, 1);
    return i >= 0;
  }

  getBody(ref) {
    return typeof ref === 'string'
      ? this.bodies.find(b => b.name === ref) ?? null
      : ref;
  }

  /** Todas as naves do sistema. */
  get spacecraft() { return this.bodies.filter(b => b.isSpacecraft); }

  /* --------------------------- controle de voo -------------------------- */

  /** Aplica throttle (0..1) a uma nave (ou a todas, se omitida). */
  setThrottle(v, sc) { for (const s of sc ? [sc] : this.spacecraft) s.setThrottle(v); }

  /** Manobra instantânea de delta-v (m/s) ao longo do heading. Retorna dv total aplicado. */
  applyThrust(deltaV, sc) {
    let total = 0;
    for (const s of sc ? [sc] : this.spacecraft) total += s.applyThrust(deltaV);
    return total;
  }

  /** Entrada de torque de attitude (-1..1). */
  setTorqueInput(v, sc) { for (const s of sc ? [sc] : this.spacecraft) s.setTorqueInput(v); }

  /** Aponta a(s) nave(s) para um heading (rad). */
  setHeading(angle, sc) { for (const s of sc ? [sc] : this.spacecraft) s.setHeading(angle); }

  /** Ajusta a escala de tempo (ex.: 60 = 1 min real por s real... na verdade 60x). */
  setTimeScale(v) { this.timeScale = Math.max(0, Number(v) || 0); return this.timeScale; }

  /* --------------------------- integração RK4 ---------------------------- */

  /**
   * Empacota o estado de todos os corpos em um vetor plano:
   *   [x, y, vx, vy] por corpo + [massa, angle, angularVelocity] por nave.
   */
  _pack() {
    const n = this.bodies.length;
    let c = 0;
    for (const b of this.bodies) if (b.isSpacecraft) c++;
    const s = new Float64Array(4 * n + 3 * c);
    this._crafts.length = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i], o = 4 * i;
      s[o] = b.x; s[o + 1] = b.y; s[o + 2] = b.vx; s[o + 3] = b.vy;
      if (b.isSpacecraft) {
        const base = 4 * n + 3 * k;
        s[base] = b.mass; s[base + 1] = b.angle; s[base + 2] = b.angularVelocity;
        this._crafts.push({ body: b, index: i, extra: base, override: null });
        k++;
      }
    }
    return s;
  }

  /** Escreve o vetor de estado de volta nos objetos Body/Spacecraft. */
  _unpack(s) {
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i], o = 4 * i;
      if (!b.fixed) {
        b.x = s[o]; b.y = s[o + 1]; b.vx = s[o + 2]; b.vy = s[o + 3];
      }
    }
    for (const c of this._crafts) {
      const sc = c.body, base = c.extra;
      sc.mass = Math.max(s[base], sc.dryMass); // setter converte o excedente em combustível
      sc.angle = Math.atan2(Math.sin(s[base + 1]), Math.cos(s[base + 1]));
      sc.angularVelocity = s[base + 2];
    }
  }

  /**
   * Derivada do estado (RK4): d(pos)/dt = vel; d(vel)/dt = gravidade N-body
   * + empuxo da nave; d(massa)/dt = -F/ve; d(angle)/dt = omega;
   * d(omega)/dt = torque / I.
   * A gravidade é calculada par a par (F = G m1 m2 / r², vetorizada), com
   * softening opcional para evitar singularidades em encontros próximos.
   */
  _derive(s, out, crafts) {
    const n = this.bodies.length, G = this.G, s2 = this._soft2;

    for (let i = 0; i < n; i++) {
      const o = 4 * i, f = this.bodies[i].fixed ? 0 : 1;
      out[o] = f * s[o + 2]; out[o + 1] = f * s[o + 3];
      out[o + 2] = 0; out[o + 3] = 0;
    }

    for (let i = 0; i < n; i++) {
      const a = this.bodies[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.bodies[j];
        if (a.fixed && b.fixed) continue;
        const oi = 4 * i, oj = 4 * j;
        const dx = s[oj] - s[oi], dy = s[oj + 1] - s[oi + 1];
        const r2 = dx * dx + dy * dy + s2;
        const invR = 1 / Math.sqrt(r2);
        const f = G * invR * invR * invR; // G / r³
        if (!a.fixed) { out[oi + 2] += f * b.mass * dx; out[oi + 3] += f * b.mass * dy; }
        if (!b.fixed) { out[oj + 2] -= f * a.mass * dx; out[oj + 3] -= f * a.mass * dy; }
      }
    }

    if (crafts) {
      for (const c of crafts) {
        const sc = c.body, base = c.extra, bi = 4 * c.index, ov = c.override;
        let throttle, torqueIn, hold;
        if (ov) {
          throttle = ov.throttle ?? 0;
          torqueIn = ov.torqueInput ?? 0;
          hold = !!ov.holdAttitude;
        } else {
          throttle = (sc.destroyed || sc._fuel <= 0) ? 0 : sc.throttle;
          torqueIn = sc.torqueInput;
          hold = false;
        }
        const mass = Math.max(s[base], sc.dryMass * 0.5); // proteção numérica
        const ang = s[base + 1];
        out[base] = -throttle * sc.maxThrust / sc.exhaustVelocity;       // dm/dt
        out[base + 1] = hold ? 0 : s[base + 2];                          // d(angle)/dt
        out[base + 2] = torqueIn * sc.maxTorque / sc.momentOfInertia;    // d(omega)/dt
        const ta = throttle * sc.maxThrust / mass;                       // a_empuxo
        out[bi + 2] += ta * Math.cos(ang);
        out[bi + 3] += ta * Math.sin(ang);
      }
    }
  }

  _ensureBuffers(len) {
    if (!this._k1 || this._k1.length !== len) {
      this._k1 = new Float64Array(len);
      this._k2 = new Float64Array(len);
      this._k3 = new Float64Array(len);
      this._k4 = new Float64Array(len);
      this._tmp = new Float64Array(len);
    }
  }

  /** Um passo RK4 completo sobre o vetor de estado plano s. */
  _rk4Step(s, h, crafts) {
    const len = s.length;
    this._ensureBuffers(len);
    const { _k1: k1, _k2: k2, _k3: k3, _k4: k4, _tmp: tmp } = this;

    this._derive(s, k1, crafts);
    for (let i = 0; i < len; i++) tmp[i] = s[i] + 0.5 * h * k1[i];
    this._derive(tmp, k2, crafts);
    for (let i = 0; i < len; i++) tmp[i] = s[i] + 0.5 * h * k2[i];
    this._derive(tmp, k3, crafts);
    for (let i = 0; i < len; i++) tmp[i] = s[i] + h * k3[i];
    this._derive(tmp, k4, crafts);
    for (let i = 0; i < len; i++) s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }

  /** Avança a simulação em exatamente h segundos (um passo fixo RK4). */
  step(h = this.fixedDt) {
    const s = this._pack();
    this._rk4Step(s, h, this._crafts);
    this._unpack(s);
    this.time += h;
    this._checkCollisions();
    return this.time;
  }

  /**
   * Avanço principal por frame: update(dt) com dt em segundos REAIS.
   * Acumula o tempo e consome em passos fixos de fixedDt (RK4), garantindo
   * estabilidade orbital regardless da taxa de cuadros do renderizador.
   */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return this.time;
    this._acc += Math.min(dt, this.maxFrameDt) * this.timeScale;
    let n = 0;
    while (this._acc >= this.fixedDt && n < this.maxSubSteps) {
      this.step(this.fixedDt);
      this._acc -= this.fixedDt;
      n++;
    }
    if (n === this.maxSubSteps) this._acc = 0; // descarta backlog (evita spiral of death)
    return this.time;
  }

  /* ------------------------------ colisões ------------------------------- */

  _checkCollisions() {
    const bs = this.bodies;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const rr = a.radius + b.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-9;
        if (a.isSpacecraft) { a.destroyed = true; a.throttle = 0; }
        if (b.isSpacecraft) { b.destroyed = true; b.throttle = 0; }
        const event = {
          type: 'collision', a, b,
          penetration: rr - d,
          impactSpeed: Math.hypot(b.vx - a.vx, b.vy - a.vy),
          time: this.time,
        };
        if (this.absorbCollisions) this._merge(a, b);
        if (this.onCollision) this.onCollision(event);
      }
    }
    if (bs.some(b => b._pendingRemoval)) {
      this.bodies = bs.filter(b => !b._pendingRemoval);
    }
  }

  /** Funde dois corpos conservando massa, momento linear e volume (raio). */
  _merge(a, b) {
    let keep, drop;
    if (a.fixed && !b.fixed) { keep = a; drop = b; }
    else if (b.fixed && !a.fixed) { keep = b; drop = a; }
    else if (a.mass >= b.mass) { keep = a; drop = b; }
    else { keep = b; drop = a; }
    const M = keep.mass + drop.mass;
    if (!keep.fixed) {
      keep.vx = (keep.mass * keep.vx + drop.mass * drop.vx) / M;
      keep.vy = (keep.mass * keep.vy + drop.mass * drop.vy) / M;
    }
    if (drop.isSpacecraft) drop.destroyed = true;
    keep.mass = M;
    keep.radius = Math.cbrt(keep.radius ** 3 + drop.radius ** 3);
    drop._pendingRemoval = true;
  }

  /* ------------------------------ telemetria ----------------------------- */

  /** Aceleração gravitacional (vetor) sobre (x, y) vinda de todos os corpos. */
  gravitationalAccelerationAt(x, y, exclude = null) {
    return gravitationalAcceleration(this.bodies, x, y, {
      G: this.G, softening: this.softening, exclude,
    });
  }

  /** Corpo celeste com maior influência gravitacional sobre sc (maior m / r²). */
  getPrimaryBody(sc) {
    let best = null, bestInfl = -Infinity;
    for (const b of this.bodies) {
      if (b === sc) continue;
      const d2 = (b.x - sc.x) ** 2 + (b.y - sc.y) ** 2 + this._soft2;
      const infl = b.mass / d2;
      if (infl > bestInfl) { bestInfl = infl; best = b; }
    }
    return best;
  }

  /**
   * Elementos orbitais keplerianos de sc em relação a ref (padrão: corpo
   * primário). Usa energia específica e momento angular específico:
   *   ε = v²/2 − μ/r ;  h = r × v ;  e = sqrt(1 + 2εh²/μ²) ;  a = −μ/(2ε)
   */
  orbitalElements(sc, ref) {
    ref = ref ?? this.getPrimaryBody(sc);
    if (!ref) return null;
    const rx = sc.x - ref.x, ry = sc.y - ref.y;
    const vx = sc.vx - ref.vx, vy = sc.vy - ref.vy;
    const r = Math.hypot(rx, ry);
    const v = Math.hypot(vx, vy);
    const mu = this.G * (ref.mass + sc.mass);
    const energy = v * v / 2 - mu / r;
    const h = rx * vy - ry * vx;                    // momento angular específico (2D)
    const p = h * h / mu;                           // semi-lactus rectum
    const e = Math.sqrt(Math.max(0, 1 + 2 * energy * h * h / (mu * mu)));
    const rdotv = rx * vx + ry * vy;

    let cosNu = 0, sinNu = 0;
    if (e > 1e-12 && p > 0) {
      cosNu = clamp((p / r - 1) / e, -1, 1);
      sinNu = clamp(rdotv / (e * Math.sqrt(mu * p)), -1, 1);
    }
    const nu = Math.atan2(sinNu, cosNu);           // anomalia verdadeira

    const bound = energy < 0;
    let a, perigee, apogee, period, tApo = null, tPeri = null, E = null, M = null;
    if (bound) {
      a = -mu / (2 * energy);
      perigee = a * (1 - e);
      apogee = a * (1 + e);
      period = TAU * Math.sqrt(a * a * a / mu);
      if (e > 1e-9) {
        // Anomalia excêntrica via E, depois anomalia média M = E − e·sinE (Kepler)
        const cosE = clamp((1 - r / a) / e, -1, 1);
        const sinE = clamp(rdotv / (e * Math.sqrt(mu * a)), -1, 1);
        E = Math.atan2(sinE, cosE);
        M = mod(E - e * Math.sin(E), TAU);
        const n = Math.sqrt(mu / (a * a * a));      // movimento médio
        tApo = mod(Math.PI - M, TAU) / n;           // tempo até o apogeu
        tPeri = mod(TAU - M, TAU) / n;              // tempo até o perigeu
      }
    } else {
      a = energy === 0 ? Infinity : -mu / (2 * energy); // negativo p/ hipérbole
      perigee = p / (1 + e);
      apogee = Infinity;
      period = Infinity;
    }

    return {
      reference: ref.name, mu, r, v, h, energy,
      a, e, perigee, apogee, period,
      trueAnomaly: nu, eccentricAnomaly: E, meanAnomaly: M,
      timeToApogee: tApo, timeToPeriapsis: tPeri, bound,
    };
  }

  /**
   * Telemetria completa em tempo real de uma nave (padrão: a primeira nave):
   * posição/velocidade, velocidade orbital, circular e de escape, apogeu,
   * perigeu, e, período, tempos até apsides, força G (gravitacional e líquida
   * com empuxo), empuxo, throttle, combustível, massa e delta-v restante.
   */
  getTelemetry(sc) {
    sc = sc ?? this.spacecraft[0];
    if (!sc) return null;
    const ref = this.getPrimaryBody(sc);
    const el = this.orbitalElements(sc, ref);
    const g = this.gravitationalAccelerationAt(sc.x, sc.y, sc);
    const tv = sc.isSpacecraft ? sc.thrustVector : { x: 0, y: 0 };
    const ax = g.x + tv.x, ay = g.y + tv.y;
    return {
      time: this.time,
      name: sc.name,
      x: sc.x, y: sc.y, vx: sc.vx, vy: sc.vy,
      speed: sc.speed,
      referenceBody: ref ? ref.name : null,
      distance: el ? el.r : null,
      altitude: el ? el.r - ref.radius : null,
      orbitalVelocity: el ? el.v : sc.speed,       // velocidade relativa ao corpo primário
      circularVelocity: el ? Math.sqrt(el.mu / el.r) : null,
      escapeVelocity: el ? Math.sqrt(2 * el.mu / el.r) : null,
      semiMajorAxis: el ? el.a : null,
      eccentricity: el ? el.e : null,
      perigee: el ? el.perigee : null,
      apogee: el ? el.apogee : null,
      period: el ? el.period : null,
      timeToApogee: el ? el.timeToApogee : null,
      timeToPeriapsis: el ? el.timeToPeriapsis : null,
      trueAnomaly: el ? el.trueAnomaly : null,
      gForce: Math.hypot(g.x, g.y) / G0,           // apenas gravidade
      gForceNet: Math.hypot(ax, ay) / G0,          // gravidade + empuxo
      acceleration: { x: ax, y: ay },
      thrust: sc.isSpacecraft ? sc.thrust : 0,
      throttle: sc.isSpacecraft ? sc.throttle : 0,
      mass: sc.mass,
      fuel: sc.isSpacecraft ? sc.fuel : 0,
      deltaV: sc.isSpacecraft ? sc.deltaVRemaining() : 0,
      angle: sc.isSpacecraft ? sc.angle : 0,
      angularVelocity: sc.isSpacecraft ? sc.angularVelocity : 0,
      destroyed: !!sc.destroyed,
    };
  }

  /**
   * Prediz a trajetória futura de sc (para desenhar a órbita no renderizador)
   * propagando o sistema com RK4 sem empuxo e attitude congelada.
   * @returns {{points: {x:number,y:number}[], collided: Body|null, steps: number}}
   */
  predictTrajectory(sc, steps = 240, dt = null) {
    steps = Math.max(1, steps | 0);
    dt = dt ?? this.fixedDt * 4;
    const s = this._pack();
    const crafts = this._crafts.map(c => ({
      body: c.body, index: c.index, extra: c.extra,
      override: { throttle: 0, torqueInput: 0, holdAttitude: true },
    }));
    const ci = crafts.findIndex(c => c.body === sc);
    const bi = 4 * (ci >= 0 ? crafts[ci].index : this.bodies.indexOf(sc));
    const points = [];
    let collided = null;
    for (let k = 0; k < steps; k++) {
      this._rk4Step(s, dt, crafts);
      const x = s[bi], y = s[bi + 1];
      points.push({ x, y });
      for (const b of this.bodies) {
        if (b === sc) continue;
        const dx = b.x - x, dy = b.y - y;
        if (dx * dx + dy * dy < b.radius * b.radius) { collided = b; k = steps; break; }
      }
    }
    return { points, collided, steps: points.length };
  }

  /* ---------------------------- serialização ----------------------------- */

  toJSON() {
    return {
      G: this.G, softening: this.softening, fixedDt: this.fixedDt,
      timeScale: this.timeScale, time: this.time,
      bodies: this.bodies.map(b => b.toJSON()),
    };
  }

  static fromJSON(data) {
    const eng = new PhysicsEngine({
      G: data.G, softening: data.softening,
      fixedDt: data.fixedDt, timeScale: data.timeScale,
    });
    eng.time = data.time ?? 0;
    for (const bd of data.bodies ?? []) {
      eng.addBody(bd.type === 'spacecraft' ? Spacecraft.fromJSON(bd) : Body.fromJSON(bd));
    }
    return eng;
  }
}

export default PhysicsEngine;
