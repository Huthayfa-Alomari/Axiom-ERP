import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { IntegrationTokenGuard } from './integration-token.guard.js';

function contextFor(source: unknown, authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        body: { source },
        headers: { authorization },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('IntegrationTokenGuard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts the source-specific token when configured', () => {
    vi.stubEnv('INTEGRATION_SOURCE_TOKENS_JSON', JSON.stringify({
      altayebat: 'a'.repeat(40),
      external: 'b'.repeat(40),
    }));
    expect(new IntegrationTokenGuard().canActivate(
      contextFor('altayebat', `Bearer ${'a'.repeat(40)}`),
    )).toBe(true);
  });

  it('rejects a token belonging to a different producer', () => {
    vi.stubEnv('INTEGRATION_SOURCE_TOKENS_JSON', JSON.stringify({
      altayebat: 'a'.repeat(40),
      external: 'b'.repeat(40),
    }));
    expect(() => new IntegrationTokenGuard().canActivate(
      contextFor('altayebat', `Bearer ${'b'.repeat(40)}`),
    )).toThrow(UnauthorizedException);
  });

  it('rejects missing authorization', () => {
    vi.stubEnv('INTEGRATION_SOURCE_TOKENS_JSON', JSON.stringify({ altayebat: 'a'.repeat(40) }));
    expect(() => new IntegrationTokenGuard().canActivate(contextFor('altayebat'))).toThrow(UnauthorizedException);
  });

  it('rejects malformed or unknown source values', () => {
    vi.stubEnv('INTEGRATION_SOURCE_TOKENS_JSON', JSON.stringify({ altayebat: 'a'.repeat(40) }));
    expect(() => new IntegrationTokenGuard().canActivate(contextFor({ source: 'altayebat' }, 'Bearer x'))).toThrow(UnauthorizedException);
  });

  it('fails closed when credentials are not configured', () => {
    vi.stubEnv('INTEGRATION_SOURCE_TOKENS_JSON', '');
    expect(() => new IntegrationTokenGuard().canActivate(
      contextFor('altayebat', `Bearer ${'a'.repeat(40)}`),
    )).toThrow(ServiceUnavailableException);
  });

  it('fails closed when the token map is malformed', () => {
    vi.stubEnv('INTEGRATION_SOURCE_TOKENS_JSON', '{');
    expect(() => new IntegrationTokenGuard().canActivate(
      contextFor('altayebat', `Bearer ${'a'.repeat(40)}`),
    )).toThrow(ServiceUnavailableException);
  });
});
