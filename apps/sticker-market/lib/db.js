import { PrismaClient } from "@prisma/client";

const globalForDb = globalThis;
export const db = globalForDb.__stickerDb ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForDb.__stickerDb = db;
