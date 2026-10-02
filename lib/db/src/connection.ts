export type DatabaseSource = "replit" | "external";

export function getDatabaseConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DATABASE_SOURCE?.trim().toLowerCase() || "replit";
  if (configured === "external") {
    const externalUrl = env.EXTERNAL_DATABASE_URL?.trim();
    if (!externalUrl) {
      throw new Error("EXTERNAL_DATABASE_URL must be set when DATABASE_SOURCE is external.");
    }
    return externalUrl;
  }
  if (configured !== "replit") {
    throw new Error("DATABASE_SOURCE must be either replit or external.");
  }

  const replitUrl = env.DATABASE_URL?.trim();
  if (!replitUrl) throw new Error("DATABASE_URL must be set for the Replit database.");
  return replitUrl;
}