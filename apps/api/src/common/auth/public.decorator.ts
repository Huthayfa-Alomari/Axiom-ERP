import { SetMetadata } from '@nestjs/common';
export const PUBLIC_ROUTE = 'axiom:public-route';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
