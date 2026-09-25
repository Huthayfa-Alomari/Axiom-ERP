import { getPosDb } from '../db/pos-db.js';
import type { LocalScaleMapping, LocalScaleProfile } from './types.js';

export interface ScaleConfigurationPayload {
  profiles: LocalScaleProfile[];
  mappings: LocalScaleMapping[];
}

export async function replaceScaleConfiguration(
  profiles: readonly LocalScaleProfile[],
  mappings: readonly LocalScaleMapping[],
): Promise<void> {
  const db = await getPosDb();
  const tx = db.transaction(['scaleProfiles', 'scaleMappings'], 'readwrite');

  await tx.objectStore('scaleProfiles').clear();
  await tx.objectStore('scaleMappings').clear();

  for (const profile of profiles) {
    await tx.objectStore('scaleProfiles').put(profile);
  }

  for (const mapping of mappings) {
    await tx.objectStore('scaleMappings').put(mapping);
  }

  await tx.done;
}

export async function refreshScaleConfiguration(input: {
  apiBaseUrl: string;
  terminalId: string;
  organizationId: string;
  accessToken: string;
}): Promise<ScaleConfigurationPayload> {
  const response = await fetch(
    `${input.apiBaseUrl}/api/v1/pos/terminals/${input.terminalId}/scale-config`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'x-organization-id': input.organizationId,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`SCALE_CONFIG_HTTP_${response.status}`);
  }

  const payload = await response.json() as ScaleConfigurationPayload;
  await replaceScaleConfiguration(payload.profiles, payload.mappings);
  return payload;
}
