import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { ACTIONS_DIR } from './actions-repo.mjs';


export const PLATFORMS = path.resolve(process.env.WEBHELM_PLATFORM_DIR || path.join(ACTIONS_DIR,'platforms'));

function namePart(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new Error(`invalid platform or action name: ${name}`);
  }
  return name;
}

export function listPlatforms() {
  return fs.readdirSync(PLATFORMS, { withFileTypes: true })
    .filter(item => item.isDirectory() && fs.existsSync(path.join(PLATFORMS, item.name, 'manifest.yaml')))
    .map(item => item.name).sort();
}

export function platformManifest(platform) {
  const file = path.join(PLATFORMS, namePart(platform), 'manifest.yaml');
  if (!fs.existsSync(file)) throw new Error(`unknown platform: ${platform}`);
  const manifest = parseYaml(fs.readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (!manifest || typeof manifest !== 'object' || manifest.platform !== platform) {
    throw new Error(`invalid platform manifest: ${platform}`);
  }
  return manifest;
}

export function platformProfile(platform) {
  const manifest = platformManifest(platform);
  const fields = ['platform', 'display_name', 'aliases', 'implementation_status', 'media', 'fields', 'capabilities', 'content_mapping', 'keep_alive', 'notes'];
  return Object.fromEntries(fields.filter(k => k in manifest).map(k => [k, manifest[k]]));
}

export function actionPath(platform, action) {
  const manifest = platformManifest(platform);
  const name = namePart(action.replaceAll('_', '-'));
  const relative = manifest.actions?.[name];
  if (typeof relative !== 'string' || !/^actions\/[\w-]+\.mjs$/.test(relative)) {
    throw new Error(`unknown or non-Node platform action ${platform}/${name}`);
  }
  const file = path.resolve(PLATFORMS, platform, relative);
  if (!file.startsWith(path.resolve(PLATFORMS, platform) + path.sep) || !fs.existsSync(file)) {
    throw new Error(`Node action missing or outside platform: ${platform}/${name}`);
  }
  return file;
}

export function validateConfig(platform, action, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('platform config must be a JSON object');
  if (action !== 'post') return;
  const { fields = {}, media = {} } = platformProfile(platform);
  for (const [name, spec] of Object.entries(fields)) {
    if (typeof spec !== 'object' || spec?.type === 'operation') continue;
    const value = config[name];
    if (spec.required && (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length))) {
      throw new Error(`${platform}: missing required field ${name}`);
    }
    if (value === undefined || value === null) continue;
    if (spec.type === 'string') {
      const text = String(value);
      const max = spec.max_chars ?? spec.max_chars_including_tags;
      if (spec.min_chars !== undefined && text && text.length < spec.min_chars) throw new Error(`${name} too short`);
      if (max !== undefined && text.length > max) throw new Error(`${name} too long`);
    } else if (spec.type === 'string_list') {
      const values = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim()).filter(Boolean);
      if (spec.max_count !== undefined && values.length > spec.max_count) throw new Error(`${name} has too many items`);
      if (spec.max_chars_each !== undefined && values.some(v => String(v).length > spec.max_chars_each)) throw new Error(`${name} item too long`);
      if (spec.max_total_chars !== undefined && values.reduce((n,v) => n + String(v).length,0) > spec.max_total_chars) throw new Error(`${name} total length exceeds limit`);
    } else if (spec.type === 'enum' && !(spec.values || []).includes(value)) {
      throw new Error(`${name} must be one of: ${(spec.values || []).join(', ')}`);
    }
  }
  const maxImages = media.images?.max_count;
  if (maxImages !== undefined && (config.images || []).length > maxImages) throw new Error('images exceeds platform maximum');
}

export async function invokePlatformAction(platform, action, { helpers, config, log }) {
  const file = actionPath(platform, action);
  validateConfig(platform, action, config);
  const module = await import(pathToFileURL(file).href + `?mtime=${fs.statSync(file).mtimeMs}`);
  const runner = module.run || module.default;
  if (typeof runner !== 'function') throw new Error(`Node action does not export a run function: ${platform}/${action}`);
  return runner({ helpers, config, log });
}
