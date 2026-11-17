import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const CONFIG_ROOT = path.resolve(process.env.WEBHELM_CONFIG_ROOT || path.join(os.homedir(), '.config', 'webhelm'));
export const LOCAL_ROOT = path.resolve(process.env.WEBHELM_LOCAL_ROOT || path.join(os.homedir(), '.local', 'webhelm'));
export const OLD_PROFILE_DIR = path.join(CONFIG_ROOT, 'chrome');
export const PROFILE_DIR = path.join(LOCAL_ROOT, 'chrome');
export const RUNTIME_DIR = path.join(CONFIG_ROOT, 'runtime');

// Refuse to start Chrome when the current WebHelm profile is not safely migrated.
export function assertProfileConsistency() {
  if (fs.existsSync(OLD_PROFILE_DIR) && !fs.existsSync(PROFILE_DIR))
    throw Error(`WebHelm Chrome profile exists at ${OLD_PROFILE_DIR}, but ${PROFILE_DIR} is missing. Stop active Sessions, WebHelm daemon and Chrome before moving the profile to ${PROFILE_DIR}.`);
  if (fs.existsSync(OLD_PROFILE_DIR) && fs.existsSync(PROFILE_DIR) &&
      fs.realpathSync(OLD_PROFILE_DIR)!==fs.realpathSync(PROFILE_DIR))
    throw Error('Two distinct WebHelm Chrome Profiles exist; refusing to use either until reconciled.');
}
