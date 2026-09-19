import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PUBLIC_ROUTE } from '../auth/public.decorator.js';
import type { TenantRequestContext } from '../../infrastructure/database/database.service.js';

const uuidSchema = z.uuid();
const requestIdSchema = z.string().trim().min(1).max(128);

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const req = context.switchToHttp().getRequest<any>();
    const userId = req.principal?.id;
    if (!uuidSchema.safeParse(userId).success) {
      throw new BadRequestException('Authenticated user id must be a UUID');
    }

    const headerOrg = this.singleHeader(req.headers['x-organization-id']);
    const organizationId = req.principal?.organizationId ?? headerOrg;
    if (!uuidSchema.safeParse(organizationId).success) {
      throw new BadRequestException('x-organization-id header or organization_id JWT claim is required');
    }

    const suppliedRequestId = this.singleHeader(req.headers['x-request-id']);
    const requestId = suppliedRequestId && requestIdSchema.safeParse(suppliedRequestId).success
      ? suppliedRequestId
      : randomUUID();

    const tenantContext: TenantRequestContext = {
      organizationId,
      userId,
      requestId,
    };

    req.tenantContext = tenantContext;
    return true;
  }

  private singleHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
