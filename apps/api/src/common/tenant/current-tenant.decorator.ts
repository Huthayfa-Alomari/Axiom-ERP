import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { TenantRequestContext } from '../../infrastructure/database/database.service.js';

export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantRequestContext => {
    const req = context.switchToHttp().getRequest<any>();
    if (!req.tenantContext) {
      throw new InternalServerErrorException('Tenant context was not initialized');
    }
    return req.tenantContext as TenantRequestContext;
  },
);
