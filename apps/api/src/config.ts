import { z } from 'zod';

/** Every setting the API reads from its environment, checked once at start-up. */
const Config = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /**
     * How sign-in tokens are checked.
     * - oidc: tokens from the sign-in provider (Supabase, Clerk, Auth0…), checked against its published keys.
     * - dev: tokens the API signs itself with AUTH_DEV_SECRET. Development and tests only.
     */
    AUTH_MODE: z.enum(['oidc', 'dev']).default('dev'),
    AUTH_ISSUER: z.string().optional(),
    AUTH_AUDIENCE: z.string().optional(),
    AUTH_JWKS_URL: z.url({ protocol: /^https$/ }).optional(),
    AUTH_DEV_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
    /** Requests each signed-in person may make per minute. */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(300),
    /** Needed to read GET /metrics outside development. Without it, /metrics does not exist there. */
    METRICS_TOKEN: z.string().min(32, 'must be at least 32 characters').optional(),
    /**
     * Who may keep records. invite: only people who entered an invite code
     * (the closed beta). open: anyone who signs in. Defaults to invite in
     * staging and production, open otherwise.
     */
    BETA_ACCESS: z.enum(['invite', 'open']).optional(),
    /** Reminders sent to devices (Web Push). Make a pair with: npx web-push generate-vapid-keys */
    VAPID_PUBLIC_KEY: z.string().min(40).optional(),
    VAPID_PRIVATE_KEY: z.string().min(20).optional(),
    /** Who push services can contact about Finken's messages: mailto:… or https://… */
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:|https:\/\/)/, 'must start with mailto: or https://')
      .optional(),
  })
  .superRefine((c, ctx) => {
    const problem = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (c.AUTH_MODE === 'dev') {
      if (c.NODE_ENV === 'staging' || c.NODE_ENV === 'production') problem('AUTH_MODE', 'dev sign-in is never allowed in staging or production');
      if (!c.AUTH_DEV_SECRET) problem('AUTH_DEV_SECRET', 'required when AUTH_MODE is dev');
    } else {
      if (!c.AUTH_ISSUER) problem('AUTH_ISSUER', 'required when AUTH_MODE is oidc');
      if (!c.AUTH_AUDIENCE) problem('AUTH_AUDIENCE', 'required when AUTH_MODE is oidc');
      if (!c.AUTH_JWKS_URL) problem('AUTH_JWKS_URL', 'required when AUTH_MODE is oidc');
    }
  });

export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Config.safeParse(env);
  if (!parsed.success) {
    // Names only: values may be secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Invalid configuration\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
