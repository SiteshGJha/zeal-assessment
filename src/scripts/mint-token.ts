import jwt, { type SignOptions } from 'jsonwebtoken';
import { getJwtSecret, type Scope } from '../auth/auth.types.js';

type RoleOption = 'support' | 'write' | 'finance' | 'all';

const ROLE_SCOPES: Record<RoleOption, Scope[]> = {
  support: ['support:read'],
  write: ['support:read', 'support:write'],
  finance: ['support:read', 'finance:read'],
  all: ['support:read', 'support:write', 'finance:read'],
};

/**
 * Mints a signed HS256 JWT for local API, Postman, and MCP usage.
 */
export function mintToken(options: {
  role?: RoleOption;
  sub?: string;
  email?: string;
  ttl?: string;
}): string {
  const role: RoleOption = options.role ?? 'support';
  const scopes = ROLE_SCOPES[role];
  if (!scopes) {
    throw new Error(`Unsupported role "${role}". Expected support | write | finance | all.`);
  }

  const sub = options.sub ?? 'user-1';
  const email = options.email ?? `${sub}@example.com`;
  const expiresIn = (options.ttl ?? '24h') as SignOptions['expiresIn'];

  return jwt.sign({ sub, email, scope: scopes }, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn,
  });
}

function parseArgs(argv: string[]): {
  role?: RoleOption;
  sub?: string;
  email?: string;
  ttl?: string;
} {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      result[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return {
    role: result.role as RoleOption | undefined,
    sub: result.sub,
    email: result.email,
    ttl: result.ttl,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`${mintToken(args)}\n`);
}
