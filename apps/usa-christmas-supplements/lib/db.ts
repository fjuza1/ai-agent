import { PrismaClient } from "./generated/prisma/index.js";

const globalForDb = globalThis as typeof globalThis & { __supplementDb?: PrismaClient };
export const db = globalForDb.__supplementDb ?? new PrismaClient({ datasourceUrl: process.env.DATABASE_URL || "file:./dev.db" });
if (process.env.NODE_ENV !== "production") globalForDb.__supplementDb = db;
