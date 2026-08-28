import type { AppDatabase } from "../db/database.js";
import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance, database: AppDatabase): void {
  app.get("/api/health", async () => {
    database.get("SELECT 1 AS ok");

    return {
      status: "ok",
      service: "api",
      database: "ok",
      timestamp: new Date().toISOString()
    };
  });
}
