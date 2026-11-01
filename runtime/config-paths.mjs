import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const CONFIG_ROOT = path.resolve(process.env.WEBHELM_CONFIG_ROOT || path.join(os.homedir(), '.config', 'webhelm'));
export const LEGACY_ROOT = path.join(os.homedir(), '.config', 'browser-workspace');
export const LOCAL_ROOT = path.resolve(process.env.WEBHELM_LOCAL_ROOT || path.join(os.homedir(), '.local', 'webhelm'));
export const OLD_PROFILE_DIR = path.join(CONFIG_ROOT, 'chrome');
export const PROFILE_DIR = path.join(LOCAL_ROOT, 'chrome');
export const RUNTIME_DIR = path.join(CONFIG_ROOT, 'runtime');

// Avoid starting a second FIFO dispatcher or empty Chrome profile against legacy data.
export function requireMigratedConfig() {
  if (fs.existsSync(path.join(LEGACY_ROOT, 'chrome')) && !fs.existsSync(OLD_PROFILE_DIR) && !fs.existsSync(PROFILE_DIR))
    throw Error(`Legacy Chrome profile exists at ${LEGACY_ROOT}. Stop old Chrome and WebHelm daemon, then run webhelm migrate.`);
  if (fs.existsSync(OLD_PROFILE_DIR) && !fs.existsSync(PROFILE_DIR))
    throw Error(`Chrome profile is still at ${OLD_PROFILE_DIR}. Stop active Sessions, WebHelm daemon and managed Chrome, then run webhelm migrate.`);
  if (fs.existsSync(OLD_PROFILE_DIR) && fs.existsSync(PROFILE_DIR) &&
      fs.realpathSync(OLD_PROFILE_DIR)!==fs.realpathSync(PROFILE_DIR))
    throw Error('Two distinct WebHelm Chrome Profiles exist; refusing to use either until reconciled.');
}
