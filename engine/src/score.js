/**
 * The selector (انتخاب‌گر هوشمند).
 * =================================
 *
 * Choosing a transport is a *constrained bandit* problem, and treating it as
 * "ping the first one that answers" is why most auto modes feel random:
 *
 *   1. HARD GATES   discard everything the link physically cannot carry
 *                   (UDP blocked, MTU too small, server does not speak it…).
 *   2. SCORING      weighted sum over throughput / latency / stability /
 *                   evasion / cost, using *measured* samples when present and
 *                   the rung's model prior when absent.
 *   3. EXPLORATION  an UCB term so a never-measured rung still gets tried, with
 *                   a decaying budget — otherwise a bad first impression is
 *                   permanent.
 *   4. HYSTERESIS   switch only on a *sustained* win, and park failing rungs in
 *                   an exponentially backed-off cooldown. Flapping between two
 *                   near-equal transports is worse for the user than either one.
 */

import { FAMILY, RUNGS, RUNG_BY_ID, allowedRungsFor } from './ladder.js';
import { resolvePolicy } from './tune.js';

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const E = Math.E;

/* ------------------------------------------------------------------ *
 * 1. feasibility
 * ------------------------------------------------------------------ */

/**
 * @param {object} rung
 * @param {object} link      measured/estimated network characteristics
 * @param {object} client    device capabilities
 * @param {object} server    this node's advertised capabilities
 * @param {object} policy
 */
export function feasibility(rung, link, client, server, policy) {
  const req = rung.requires ?? {};
  const reject = (reason) => ({ ok: false, reason });

  if (server?.protocols && !server.protocols.includes(rung.id)) {
    return reject(`node does not advertise ${rung.id}`);
  }
  if (req.udp && link.udpBlocked) return reject('UDP is blocked on this path');
  if (req.quic && link.quicBlocked) return reject('QUIC/UDP-443 is being dropped');
  if (req.http2 && link.http2Killed) return reject('HTTP/2 transports are being reset');
  if (req.tls && !server?.capabilities?.tls) return reject('node has no TLS listener');
  if (req.fronting && !client?.capabilities?.cdnFronting) return reject('CDN fronting is not configured');
  if (req.tor && !client?.capabilities?.torExecutable) return reject('no local Tor binary (opt-in only)');
  if (req.resistanceOnly && policy.mode !== 'resist') return reject('resistance-mode only');
  if (req.legacy && !policy.allowLegacy) return reject('legacy interop is off (enable allowLegacy)');

  const mtu = client?.mtu ?? (link.access === 'cellular' ? 1280 : 1420);
  if (req.mtuFloor && mtu < req.mtuFloor) return reject(`needs MTU ≥ ${req.mtuFloor}, path gives ${mtu}`);

  if (rung.id === 'wg_uot' && link.wgSignatureBlocked) return reject('WireGuard packet pattern is being dropped');
  if (rung.id === 'ss2022' && link.ssSaltBlocked) return reject('AEAD salt length is being matched');
  if (rung.family === FAMILY.QUIC && link.quicRateLimited && policy.mode === 'game') {
    return reject('QUIC is being rate-limited; latency goals unreachable here');
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 2. scoring
 * ------------------------------------------------------------------ */

/**
 * Goodput vs packet loss, and the whole reason a pacing-based sender is worth its
 * bytes: a *loss-based* congestion controller is bounded by Reno's sqrt(p) term
 * (throughput ∝ MSS / (RTT · √p)), so 12% loss costs it ~90% of the pipe, while a
 * *pacing-based* sender (Hysteria BRUTAL) ignores the loss signal and simply holds
 * the rate it was told to hold. `tolerance` is where a rung sits between those two.
 */
export function lossEfficiency(lossPct, tolerance) {
  const p = clamp((lossPct ?? 0) / 100, 0, 0.3);
  const rel = p <= 0.0015 ? 1 : clamp(Math.sqrt(0.0015 / p), 0.05, 1);
  return clamp(1 - (1 - rel) * (1 - clamp(tolerance ?? 0.5)), 0.05, 1);
}

/**
 * Some rungs are two protocols in one config object (NaïveProxy: H2/TCP or H3/QUIC).
 * Score the variant the engine actually picked, not the union of both.
 */
export function effectiveAffinity(rung, link, tuning = {}) {
  const a = rung.affinity;
  if (rung.id === 'naive_h3') {
    return tuning.naiveQuic === false
      ? { ...a, loss: 0.45, dpi_quic: 1.0, udp_qos: 1.0, tcp_only: 1.0, shaping: 0.7 }
      : { ...a, tcp_only: 0.0 };
  }
  return a;
}

export function scoreParts(rung, sample, link, policy, evasionApplied = 0, tuning = {}) {
  const a = effectiveAffinity(rung, link, tuning);
  const loss = link.lossPct ?? 0;
  const rtt = link.rttMs ?? 60;

  // throughput — prefer the measurement, else the model
  const capacity = link.downMbps ?? 40;
  const eff = lossEfficiency(loss, a.loss);
  // Shaping/UDP-rate penalties are *conditional on the censor actually doing it*:
  // taxing a clean path for a middlebox that isn't there is how "safe" configs end up slow.
  let factor = (1 - rung.cost.overheadPct) * eff;
  if (link.bandwidthShaped || link.sizeHeuristic) factor *= 0.4 + 0.6 * (a.shaping ?? 0.5);
  // A protocol-wide rate limiter is not a port problem: hopping cannot outrun it, and
  // pacing cannot beat it. Only hop-capable rungs with a real port pool keep their edge.
  const canHop = !!tuning.hop?.server_ports?.length;
  if (link.udpThrottled && !canHop) {
    if (rung.family === FAMILY.QUIC) factor *= 0.45;
    else if (rung.family === FAMILY.RAW_UDP) factor *= 0.35;
  }
  if (rung.id === 'wg_uot' && loss < 1.5) factor *= 1.06; // no TLS/QUIC stack in the way
  const modelled = capacity * factor;
  const throughputRaw = sample?.downMbps ?? modelled;
  const throughput = clamp(throughputRaw / Math.max(capacity, 1), 0, 1);

  // latency — measured RTT plus what the rung itself costs to establish/maintain
  const rttTotal = (sample?.rttMs ?? rtt) + rung.cost.rttCostMs * rtt * 0.5 + (sample?.jitterMs ?? 0) * 0.5;
  const latency = clamp(Math.exp(-rttTotal / 90));

  // stability — loss, jitter, handshakes that died
  const failRate = clamp((sample?.failures ?? 0) / Math.max(1, sample?.attempts ?? 1));
  const stability = clamp(
    (1 - clamp(loss / 12)) * (1 - clamp((sample?.jitterMs ?? 0) / 80)) * (1 - 0.8 * failRate) + (a.udp_qos ?? 0.5) * 0.08,
    0,
    1,
  );

  // evasion — how the rung's profile matches the mechanisms we actually observed
  const observed = [];
  if (link.sniFiltered) observed.push(a.dpi_sni);
  if (link.quicFingerprinted || link.quicBlocked) observed.push(a.dpi_quic);
  if (link.sizeHeuristic) observed.push(a.shaping);
  if (link.activeProbeSuspected) observed.push(a.active_probe);
  if (link.portThrottled || link.portBlocked) observed.push(a.udp_qos);
  if (link.tcpOnly) observed.push(a.tcp_only);
  if (link.ipRangeBlocked) observed.push(a.ip_blocked ?? 0);
  if (link.bandwidthShaped) observed.push(a.shaping);
  const evasionBase = observed.length ? observed.reduce((s, v) => s + v, 0) / observed.length : clamp((a.dpi_sni + a.dpi_quic + a.active_probe) / 3, 0, 1);
  const evasion = clamp(evasionBase + evasionApplied * 0.12, 0, 1);

  // cost — CPU and bytes, which on a phone *are* speed (thermal throttle) and money (metered SIM)
  const batteryCost = link.access === 'cellular' ? 0.5 : 0.25;
  const cost = clamp(1 - (rung.cost.cpuLoad * 0.5 + rung.cost.overheadPct * 1.6 + batteryCost * (rung.family === FAMILY.QUIC ? 0.25 : 0.05)));

  return { throughput, latency, stability, evasion, cost, modelledMbps: modelled, measured: sample?.downMbps ?? null };
}

export function weightedScore(parts, weights) {
  let s = 0;
  for (const [k, w] of Object.entries(weights)) s += (parts[k] ?? 0) * w;
  return s;
}

/* ------------------------------------------------------------------ *
 * 3+4. ranking + hysteresis state machine
 * ------------------------------------------------------------------ */

/** `tunings` lets the caller feed the engine's own variant choices back into scoring. */
export function rankLadder({ link, client, server, policy = {}, samples = {}, history = {}, tunings = {}, allowLegacy = false }) {
  const resolved = resolvePolicy(policy);
  const candidates = allowedRungsFor(resolved.mode, { allowLegacy: policy.allowLegacy ?? allowLegacy, only: policy.rungs ?? policy.only });
  const totalPulls = Object.values(samples).reduce((n, s) => n + (s?.attempts ?? 0), 0);

  const rows = RUNGS.map((rung) => {
    const inLadder = candidates.some((r) => r.id === rung.id);
    const gate = feasibility(rung, link, client, server, resolved);
    const sample = samples[rung.id];
    const tuning = tunings?.[rung.id] ?? {};
    const parts = scoreParts(rung, sample, link, resolved, gate.evasionApplied ?? 0, tuning);
    const base = weightedScore(parts, resolved.weights);
    // UCB exploration: only for rungs we have not measured, and only if they passed the gates.
    const pulls = sample?.attempts ?? 0;
    const explore =
      inLadder && gate.ok && pulls < 6 && totalPulls > 0
        ? 0.06 * Math.sqrt(Math.log(totalPulls + 2) / (pulls + 1))
        : 0;
    const cooldown = history[rung.id]?.cooldownUntil ?? 0;
    const penalty = history[rung.id]?.penalty ?? 0;
    const score = clamp(base + explore - penalty, 0, 1.2);
    return {
      rungId: rung.id,
      title: rung.title,
      family: rung.family,
      inLadder,
      feasible: gate.ok && inLadder,
      reason: gate.ok ? (inLadder ? '' : 'excluded by policy mode') : gate.reason,
      // Inputs the *device* scorer needs to reproduce this row. Exported because the phone
      // re-ranks between check-ins, and a divergence would look like a bad day, not a bug.
      evasionApplied: gate.evasionApplied ?? 0,
      canHop: !!tunings?.[rung.id]?.hop?.server_ports?.length,
      naiveQuic: tunings?.[rung.id]?.naiveQuic ?? null,
      score,
      raw: base,
      explore,
      parts,
      measured: sample ? { downMbps: round1(sample.downMbps ?? 0), rttMs: round1(sample.rttMs ?? 0), lossPct: round1(sample.lossPct ?? 0) } : null,
      cooldownUntil: cooldown,
    };
  });

  rows.sort((x, y) => y.score - x.score);
  return rows;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Stateful selector. Feed it the ranked list on every measurement cycle.
 * It returns the rung to be *connected*, honouring dwell time, minimum gain,
 * and failure cooldowns.
 */
export class AdaptiveSelector {
  constructor(policy = {}, now = () => Date.now()) {
    this.policy = resolvePolicy(policy);
    this.now = now;
    this.current = null;
    this.since = 0;
    this.pending = null;
    this.pendingSince = 0;
    this.state = {}; // per-rung: {failures, attempts, cooldownUntil, penalty, confirmations}
  }

  observe(rungId, ok, metrics = {}) {
    const st = (this.state[rungId] ??= { failures: 0, attempts: 0, cooldownUntil: 0, penalty: 0, confirmations: 0, downMbps: 0, rttMs: 0, jitterMs: 0 });
    st.attempts += 1;
    if (ok) {
      st.failures = Math.floor(st.failures * 0.5); // decay, don't erase
      st.cooldownUntil = 0;
      st.penalty = Math.max(0, (st.penalty ?? 0) - 0.05);
    } else {
      st.failures += 1;
      if (st.failures >= 2) {
        const backoff = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(st.failures - 2, 8));
        st.cooldownUntil = this.now() + backoff;
        st.penalty = clamp(0.12 * st.failures, 0, 0.5);
      }
    }
    Object.assign(st, {
      downMbps: metrics.downMbps ?? st.downMbps,
      rttMs: metrics.rttMs ?? st.rttMs,
      jitterMs: metrics.jitterMs ?? st.jitterMs,
      lastOk: ok,
    });
    return st;
  }

  samples() {
    const out = {};
    for (const [id, st] of Object.entries(this.state)) {
      out[id] = {
        attempts: st.attempts,
        failures: st.failures,
        downMbps: st.downMbps,
        rttMs: st.rttMs,
        jitterMs: st.jitterMs,
      };
    }
    return out;
  }

  history() {
    const out = {};
    for (const [id, st] of Object.entries(this.state)) {
      out[id] = { cooldownUntil: st.cooldownUntil, penalty: st.penalty };
    }
    return out;
  }

  /**
   * @param {object[]} ranked rows from rankLadder
   * @returns {{pick:string, switched:boolean, gainPct:number, why:string}}
   */
  decide(ranked) {
    const best = ranked.find((r) => r.feasible);
    if (!best) throw new Error('ladder-empty: no transport is feasible on this link');
    const now = this.now();
    const incumbent = this.current && ranked.find((r) => r.rungId === this.current);
    const blocked = incumbent && (this.state[incumbent.rungId]?.cooldownUntil ?? 0) > now;

    if (!this.current || blocked || !incumbent || !incumbent.feasible) {
      const switched = !!this.current && this.current !== best.rungId;
      this.current = best.rungId;
      this.since = now;
      this.pending = null;
      return {
        pick: best.rungId,
        switched,
        gainPct: incumbent ? pctGain(best.score, incumbent.score) : 100,
        why: !this.current || switched ? (blocked ? 'incumbent is in cooldown' : !incumbent || !incumbent.feasible ? 'incumbent became infeasible' : 'falling back to best feasible rung') : 'cold start: best feasible rung',
      };
    }

    const gain = pctGain(best.score, incumbent.score);
    if (gain < this.policy.minSwitchGainPct) {
      this.pending = null;
      return { pick: incumbent.rungId, switched: false, gainPct: gain, why: `within ${this.policy.minSwitchGainPct}% of the incumbent — switching would cost a handshake for nothing` };
    }
    if (now - this.since < this.policy.dwellMs) {
      return { pick: incumbent.rungId, switched: false, gainPct: gain, why: `dwell timer (${this.policy.dwellMs / 1000}s) not expired` };
    }
    // Require sustained evidence, not one lucky sample.
    this.pending = this.pending && this.pending.rungId === best.rungId ? { ...this.pending, hits: this.pending.hits + 1 } : { rungId: best.rungId, hits: 1 };
    if (this.pending.hits < 2) {
      return { pick: incumbent.rungId, switched: false, gainPct: gain, why: `${best.rungId} leads by ${round1(gain)}% but needs a second confirming sample` };
    }
    this.pending = null;
    this.current = best.rungId;
    this.since = now;
    return {
      pick: best.rungId,
      switched: true,
      gainPct: gain,
      why: `sustained ${round1(gain)}% win over ${incumbent.rungId} across ${2} samples`,
    };
  }
}

const pctGain = (a, b) => (b <= 0 ? 100 : round1(((a - b) / b) * 100));

/**
 * Deterministic tie-break used by tests and by the cold-start UI: prefers the
 * rung with the best modelled goodput, then the cheapest CPU, then ladder order.
 */
export function coldStartPick(link, client, server, policy) {
  const ranked = rankLadder({ link, client, server, policy });
  const feasible = ranked.filter((r) => r.feasible);
  return feasible.sort((x, y) => y.score - x.score || (x.parts.cost - y.parts.cost) || RUNGS.findIndex((r) => r.id === x.rungId) - RUNGS.findIndex((r) => r.id === y.rungId))[0] ?? null;
}

export { RUNGS, RUNG_BY_ID };
