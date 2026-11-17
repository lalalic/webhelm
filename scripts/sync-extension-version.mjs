import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const DEFAULT_PACKAGE=path.join(root,'package.json');
const DEFAULT_MANIFEST=path.join(root,'runtime/extension/manifest.json');
const VERSION=/^\d+\.\d+\.\d+$/;

/** Keep the published unpacked Chrome Extension at exactly the npm Runtime version. */
export function syncExtensionVersion(packageFile=DEFAULT_PACKAGE,manifestFile=DEFAULT_MANIFEST,{checkOnly=false}={}) {
  const pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
  const raw=fs.readFileSync(manifestFile,'utf8');
  const manifest=JSON.parse(raw);
  if(pkg.name!=='webhelm' || !VERSION.test(pkg.version) || manifest.manifest_version!==3 || !VERSION.test(manifest.version))
    throw Error('Invalid WebHelm package or Chrome Extension manifest version');
  if(manifest.version!==pkg.version){
    if(checkOnly)throw Error(`Version mismatch: Runtime ${pkg.version}, Extension ${manifest.version}`);
    // Preserve the manifest's identity key and formatting; change only version.
    const changed=raw.replace(/("version"\s*:\s*")[^"]+("\s*,)/,(whole,start,end)=>`${start}${pkg.version}${end}`);
    if(changed===raw || JSON.parse(changed).version!==pkg.version)throw Error('Could not update Chrome Extension version');
    fs.writeFileSync(manifestFile,changed);
  }
  return {runtime:pkg.version,extension:pkg.version,changed:manifest.version!==pkg.version};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const flags=process.argv.slice(2);
  if(flags.some(f=>f!=='--check'))throw Error('Usage: node scripts/sync-extension-version.mjs [--check]');
  console.log(JSON.stringify(syncExtensionVersion(DEFAULT_PACKAGE,DEFAULT_MANIFEST,{checkOnly:flags.includes('--check')})));
}
