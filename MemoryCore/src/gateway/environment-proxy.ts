import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

/** Apply the gateway's explicitly enabled environment proxy after imports. */
export function configureEnvironmentProxy(): void {
  if (process.env.NODE_USE_ENV_PROXY !== "1") return;
  if (getGlobalDispatcher() instanceof EnvHttpProxyAgent) return;
  // Undici 8 and Node's built-in fetch must share the opted-in proxy policy.
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
