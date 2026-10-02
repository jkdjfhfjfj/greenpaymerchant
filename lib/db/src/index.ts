import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { getDatabaseConnectionString } from "./connection";

const { Pool } = pg;

export const pool = new Pool({ connectionString: getDatabaseConnectionString() });
export const db = drizzle(pool, { schema });

export * from "./schema";
export { getDatabaseConnectionString } from "./connection";
