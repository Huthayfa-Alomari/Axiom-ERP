import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify } from 'jose';
import { PUBLIC_ROUTE } from './public.decorator.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE,[context.getHandler(),context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<any>();
    const auth = req.headers.authorization as string | undefined;
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token required');
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) throw new Error('AUTH_JWT_SECRET is not configured');
    try {
      const { payload } = await jwtVerify(auth.slice(7), new TextEncoder().encode(secret), {
        issuer: process.env.AUTH_JWT_ISSUER,
        audience: process.env.AUTH_JWT_AUDIENCE,
      });
      if (typeof payload.sub !== 'string') throw new Error('Missing sub');
      req.principal = { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
