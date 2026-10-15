// The API is served by this same Next app (src/pages/api/v1), so the default
// is same-origin. NEXT_PUBLIC_API_URL only overrides it for split setups.
import { getRuntimeConfig } from './runtimeConfig';

export const API_BASE = getRuntimeConfig().apiUrl;
