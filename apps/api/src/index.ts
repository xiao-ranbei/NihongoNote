import "dotenv/config";

import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import { appConfig } from "./config.js";

let app: FastifyInstance | undefined;

try {
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
