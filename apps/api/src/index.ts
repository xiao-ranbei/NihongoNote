import "dotenv/config";

import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import { appConfig } from "./config.js";
import { createProviderRegistry } from "./providers/registry.js";

let app: FastifyInstance | undefined;

try {
  createProviderRegistry(appConfig);
  app = await createApp(appConfig);
  await app.listen({
    host: appConfig.host,
    port: appConfig.port
  });
} catch (error) {
  if (app) {
    app.log.error(error, "Unable to start NihongoNote API");
    await app.close();
  } else {
    console.error("Unable to start NihongoNote API", error);
  }
  process.exitCode = 1;
}
