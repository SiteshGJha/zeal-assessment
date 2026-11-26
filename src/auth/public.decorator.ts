import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route handler or controller as bypassing JWT and rate-limit guards.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
