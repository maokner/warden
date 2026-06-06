export const PROTECTED_ENV_PATTERNS = [
  /^GITHUB_TOKEN$/,
  /^GH_TOKEN$/,
  /^GITLAB_TOKEN$/,
  /^SLACK_.*TOKEN$/,
  /^STRIPE_.*(KEY|TOKEN|SECRET)$/,
  /^DATABASE_URL$/,
  /^POSTGRES(_URL|_PASSWORD)?$/,
  /^PGPASSWORD$/,
  /^MYSQL(_URL|_PASSWORD|_PWD)?$/,
  /^REDIS_URL$/,
  /^MONGODB_URI$/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_ACCESS_KEY_ID$/,
  /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /^OPENAI_API_KEY$/,
  /^ANTHROPIC_API_KEY$/,
  /SECRET/,
  /PRIVATE_KEY/,
  /API_KEY/,
  /ACCESS_TOKEN/,
  /CONNECTION_STRING/,
  /DATABASE/,
] as const;

export function isProtectedEnvName(name: string): boolean {
  return PROTECTED_ENV_PATTERNS.some((pattern) => pattern.test(name));
}

export function scrubEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isProtectedEnvName(key)) {
      continue;
    }

    scrubbed[key] = value;
  }

  return scrubbed;
}
