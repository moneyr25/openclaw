import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildConfig, type AppConfig } from "./config-core.ts";

export type {
  AppConfig,
  AppleWeatherKitCredentials,
  EnvSource,
} from "./config-core.ts";
export { buildConfig } from "./config-core.ts";

/** Absolute path to the app root (the directory holding package.json). */
export const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Load `.env` from the app root if present. Real env always wins. */
export const loadEnvFile = (): void => {
  const envPath = path.join(APP_ROOT, ".env");
  if (!existsSync(envPath)) return;
  process.loadEnvFile(envPath);
};

/** Node entry point for configuration: `.env`, `process.env`, and disk. */
export const loadConfig = (): AppConfig => {
  loadEnvFile();
  return buildConfig(process.env, {
    readPrivateKeyFile: (keyPath) =>
      readFileSync(path.resolve(APP_ROOT, keyPath), "utf8"),
  });
};
