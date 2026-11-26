import { SetMetadata } from '@nestjs/common';
import type { Scope } from './auth.types.js';

export const SCOPES_KEY = 'required_scopes';

/**
 * Attaches required OAuth-style scopes to a route handler.
 */
export const RequiredScopes = (...scopes: Scope[]) => SetMetadata(SCOPES_KEY, scopes);
