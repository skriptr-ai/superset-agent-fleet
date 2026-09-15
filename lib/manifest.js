// The private fast path is optional. Ambiguous organization state belongs to the CLI.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function localEndpoint(value) {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function readHostManifest(root) {
  let entries;
  try {
    entries = await readdir(join(root, 'host'), { withFileTypes: true });
  } catch {
    return { manifest: null, reason: 'no host manifest' };
  }
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const value = JSON.parse(
        await readFile(join(root, 'host', entry.name, 'manifest.json'), 'utf8'),
      );
      if (value?.endpoint && typeof value.authToken === 'string' && value.authToken) {
        manifests.push(value);
      }
    } catch {
      // Partial or unreadable manifests cannot identify a host.
    }
  }
  if (manifests.length > 1) {
    return { manifest: null, reason: 'multiple organization manifests' };
  }
  if (!manifests.length) return { manifest: null, reason: 'no complete host manifest' };
  if (!localEndpoint(manifests[0].endpoint)) {
    return { manifest: null, reason: 'host manifest does not identify a loopback endpoint' };
  }
  return { manifest: manifests[0], reason: null };
}
