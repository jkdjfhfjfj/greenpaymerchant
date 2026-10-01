export function isVersionedApiPath(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

export function mutationRequiresSameOrigin(method: string, path: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase()) &&
    !isVersionedApiPath(path);
}

export function originIsAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return false;
  const normalize = (value: string): string | undefined => {
    try {
      const parsed = new URL(value);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.origin === "null" ||
          parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        return undefined;
      }
      return parsed.origin;
    } catch {
      return undefined;
    }
  };
  const normalized = normalize(origin);
  if (!normalized) return false;
  return allowedOrigins.some((allowed) => normalize(allowed) === normalized);
}