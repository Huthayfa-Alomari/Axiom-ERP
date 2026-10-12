import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

interface IntegrationRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: { source?: unknown };
}

function constantTimeTokenMatch(received: string, expected: string): boolean {
  const left = Buffer.from(received, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) {
    // Still perform a fixed-size comparison to avoid an immediate length-only path.
    const padded = Buffer.alloc(right.length);
    left.copy(padded, 0, 0, Math.min(left.length, padded.length));
    timingSafeEqual(padded, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

@Injectable()
export class IntegrationTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    const source = request.body?.source;
    if (typeof source !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(source)) {
      throw new UnauthorizedException('Valid integration source required.');
    }

    const rawTokens = process.env.INTEGRATION_SOURCE_TOKENS_JSON;
    if (!rawTokens) {
      throw new ServiceUnavailableException('Integration credentials are not configured.');
    }

    let tokens: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawTokens);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid token map');
      tokens = parsed as Record<string, unknown>;
    } catch {
      throw new ServiceUnavailableException('Integration credentials are misconfigured.');
    }

    const expected = tokens[source];
    if (typeof expected !== 'string' || expected.length < 32) {
      throw new UnauthorizedException('Integration credentials rejected.');
    }

    const authorization = request.headers.authorization;
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer integration token required.');
    }

    const received = header.slice('Bearer '.length);
    if (!received || !constantTimeTokenMatch(received, expected)) {
      throw new UnauthorizedException('Integration credentials rejected.');
    }

    return true;
  }
}
