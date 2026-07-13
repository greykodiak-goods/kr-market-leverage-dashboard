// Single place to configure the preferred CORS proxy.
//
// When the dedicated Cloudflare Worker is deployed (see cloudflare-worker/),
// paste its URL here — it becomes the #1 proxy for both quotes and news, ahead
// of the public fallbacks. Leave '' to use only the public proxies.
//
// Format: full prefix ending so that `${CUSTOM_PROXY}${encodeURIComponent(target)}`
// is a valid request. The Worker expects `?url=<encoded>`.
//
//   export const CUSTOM_PROXY = 'https://kr-market-proxy.<subdomain>.workers.dev/?url='
//
// ACTIVE: Supabase Edge Function CORS proxy (verify_jwt=false, no auth header).
// Host allowlist enforced server-side (Yahoo/Google News/GDELT/Stooq).
export const CUSTOM_PROXY = 'https://wcztgneaqmwfeuonyjny.supabase.co/functions/v1/cors-proxy?url='

// Wrap a target URL for the custom proxy (encoded query param form).
export function customProxyWrap(target: string): string {
  return `${CUSTOM_PROXY}${encodeURIComponent(target)}`
}

export const HAS_CUSTOM_PROXY = CUSTOM_PROXY.trim().length > 0
