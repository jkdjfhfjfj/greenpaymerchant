import { defineConfig } from "drizzle-kit";
import path from "path";
import { getDatabaseConnectionString } from "./src/connection";

if (process.env.DATABASE_SOURCE?.trim().toLowerCase() !== "external") {
  throw new Error("Render migrations require DATABASE_SOURCE=external.");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: path.relative(process.cwd(), path.join(__dirname, "./migrations")),
  dialect: "postgresql",
  dbCredentials: {
    url: getDatabaseConnectionString(),
  },
});