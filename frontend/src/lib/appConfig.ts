// Single source of truth for the product's display name. Set APP_NAME in
// the repo-root .env. It is read at runtime (see runtimeConfig.ts), not
// baked into the build.
import { getRuntimeConfig } from './runtimeConfig';

export const APP_NAME = getRuntimeConfig().appName;
