export function requireCogSeedApiBase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = String(env.COGSEED_API_BASE_URL || '').trim();
  if (!raw) throw new Error('COGSEED_API_BASE_URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('COGSEED_API_BASE_URL must be an HTTPS origin/path without credentials, query, or fragment');
  }
  if (
    url.protocol !== 'https:'
    || !!url.username
    || !!url.password
    || !!url.search
    || !!url.hash
  ) {
    throw new Error('COGSEED_API_BASE_URL must be an HTTPS origin/path without credentials, query, or fragment');
  }
  return url.toString().replace(/\/$/, '');
}
