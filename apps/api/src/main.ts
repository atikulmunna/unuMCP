import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureBodyParser } from "./common/body-parser";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureBodyParser(app);
  app.setGlobalPrefix("api");
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
