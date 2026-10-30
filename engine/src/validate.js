/**
 * Config validation against the official sing-box JSON schema.
 *
 * The schema (docs/schema.json upstream, vendored at engine/schema/) is generated
 * by sing-box itself from its Go option structs, so "valid here" means sing-box
 * will actually parse the config — including the parts that are easy to get wrong
 * from blog posts: `additionalProperties:false` everywhere, `route.sniff` being
 * gone, `geoip`/`geosite` being removed, `gso` being dead.
 *
 * ajv is a devDependency; when it is not installed the checks degrade to the
 * structural lint below so the engine still runs on a phone/CI without npm.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCHEMA = path.join(HERE, '..', 'schema', 'sing-box-1.14.4.schema.json');

let cached = null;

export function loadSchema(schemaPath = DEFAULT_SCHEMA) {
  if (cached && cached.path === schemaPath) return cached.doc;
  if (!existsSync(schemaPath)) throw new Error(`schema not found: ${schemaPath} (npm run schema to refresh)`);
  const doc = JSON.parse(readFileSync(schemaPath, 'utf8'));
  cached = { path: schemaPath, doc };
  return doc;
}

/** Cheap, dependency-free sanity pass: catches the mistakes that break startup. */
export function structuralLint(config) {
  const errors = [];
  const push = (m) => errors.push(m);
  if (!config || typeof config !== 'object') return ['config is not an object'];
  for (const dead of ['geoip', 'geosite', 'experimental']) {
    if (dead === 'experimental' && config.experimental && !config.experimental.cache_file) push('experimental without cache_file');
    if (dead !== 'experimental' && config.route?.[dead]) push(`route.${dead} was removed in sing-box 1.12.0 — use route.rule_set`);
  }
  if (config.route?.sniff) push('route.sniff was removed — use a route rule with action:"sniff"');
  for (const ib of config.inbounds ?? []) {
    if (ib.type === 'tun' && ib.gso) push('tun.gso is deprecated and does nothing since 1.11.0');
    if (ib.type === 'tun' && !ib.address) push('tun inbound needs "address"');
    if (ib.inbound && ib.inbound.detour) push('inbound.detour is not valid inside inbounds[]');
  }
  for (const ob of config.outbounds ?? []) {
    if (!ob.type) push(`outbound ${ob.tag ?? '?'} has no type`);
    if (ob.tls?.kernel_rx) push('tls.kernel_rx is documented as degrading performance — never enable it');
    if (ob.tls?.insecure) push(`outbound ${ob.tag}: tls.insecure=true is a MITM hole; pin the SPKI instead`);
    if (ob.type === 'hysteria2' && ob.tls?.reality?.enabled) push('hysteria2 cannot use reality (QUIC carries its own TLS)');
    if (ob.type === 'vless' && ob.tls?.reality?.enabled && ob.flow && ob.transport) push('reality + flow + transport: pick flow for tcp only');
  }
  const tags = (config.outbounds ?? []).map((o) => o.tag);
  for (const t of new Set(tags)) if (tags.filter((x) => x === t).length > 1) push(`duplicate outbound tag: ${t}`);
  for (const ob of config.outbounds ?? []) {
    for (const ref of [ob.tag && ob.detour, ob.type === 'selector' || ob.type === 'urltest' ? ob.outbounds : null].flat().filter(Boolean)) {
      if (Array.isArray(ref) ? ref.some((r) => !tags.includes(r)) : !tags.includes(ref)) push(`${ob.tag}: references unknown outbound ${ref}`);
    }
  }
  if (config.route?.final && !tags.includes(config.route.final)) push(`route.final references unknown outbound ${config.route.final}`);
  return errors;
}

let compiledCache = null;
function compiledValidator(schemaPath, AjvCtor) {
  if (compiledCache?.path === schemaPath) return compiledCache.validate;
  const ajv = new AjvCtor({ strict: false, allowUnionTypes: true, discriminator: true, large: 8 });
  ajv.addSchema(loadSchema(schemaPath), 'sing-box');
  const validate = ajv.getSchema('sing-box');
  compiledCache = { path: schemaPath, validate };
  return validate;
}

/**
 * @returns {Promise<{ok:boolean, engine:'ajv'|'lint', errors:string[], skipped?:string}>}
 */
export async function validateConfig(config, { schemaPath = DEFAULT_SCHEMA } = {}) {
  const lint = structuralLint(config);
  let AjvCtor;
  let is2020 = true;
  try {
    const schemaDoc = loadSchema(schemaPath);
    is2020 = String(schemaDoc.$schema ?? '').includes('2020');
    AjvCtor = is2020 ? (await import('ajv/dist/2020.js')).default : (await import('ajv')).default;
  } catch (e) {
    return { ok: lint.length === 0, engine: 'lint', errors: lint, skipped: `ajv unavailable (${e.code ?? e.message}) — run "npm i" in engine/ for full schema validation` };
  }
  const validate = compiledValidator(schemaPath, AjvCtor);
  const ok = validate(config);
  const errors = ok
    ? lint
    : validate.errors.map((e) => {
        const where = (e.instancePath || '/').replace(/^\//, '').replace(/\//g, '.');
        const hint = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : '';
        return `${where || 'root'}: ${e.message}${hint}`;
      }).concat(lint);
  return { ok: ok && lint.length === 0, engine: 'ajv', errors: [...new Set(errors)] };
}

/** Refresh helper: copy a newer docs/schema.json in, keeping the version in the filename. */
export function schemaVersion(schemaPath = DEFAULT_SCHEMA) {
  try {
    const doc = JSON.parse(readFileSync(schemaPath, 'utf8'));
    return doc.$id ?? 'unknown';
  } catch {
    return null;
  }
}
