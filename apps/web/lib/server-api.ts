import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';

export async function apiGet<T>(path: string): Promise<T> {
  const incomingHeaders = await headers();
  const cookieStore = await cookies();

  const bearerFromCookie = cookieStore.get(process.env.AXIOM_ACCESS_TOKEN_COOKIE ?? 'axiom_access_token')?.value;
  const organizationFromCookie = cookieStore.get(process.env.AXIOM_ORG_COOKIE ?? 'axiom_organization_id')?.value;

  const authorization =
    incomingHeaders.get('authorization')
    ?? (bearerFromCookie ? `Bearer ${bearerFromCookie}` : process.env.API_INTERNAL_BEARER_TOKEN);

  const organizationId =
    incomingHeaders.get('x-organization-id')
    ?? organizationFromCookie
    ?? process.env.DEFAULT_ORGANIZATION_ID;

  const outboundHeaders = new Headers({
    accept: 'application/json',
    'x-request-id': incomingHeaders.get('x-request-id') ?? randomUUID(),
  });

  if (authorization) outboundHeaders.set('authorization', authorization);
  if (organizationId) outboundHeaders.set('x-organization-id', organizationId);

  const response = await fetch(
    `${process.env.API_INTERNAL_URL ?? 'http://localhost:3001'}${path}`,
    { cache: 'no-store', headers: outboundHeaders },
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`API GET ${path} failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return response.json() as Promise<T>;
}
