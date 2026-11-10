import type { Api } from "@/api/api";

import { base64UrlToBytes } from "./b64";

export type PushState = "native" | "unsupported" | "install" | "denied" | "off" | "on";

const SCOPE = "/app/";

// Sur iPhone, Safari ne propose les notifications qu'à une app ajoutée à l'écran d'accueil (iOS 16.4 et plus).
function iosNotInstalled(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
    || window.matchMedia?.("(display-mode: standalone)").matches;
  return ios && !standalone;
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration(SCOPE))
    ?? navigator.serviceWorker.register(`${SCOPE}sw.js`, { scope: SCOPE });
}

export async function pushState(): Promise<PushState> {
  if (iosNotInstalled()) return "install";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const sub = await (await navigator.serviceWorker.getRegistration(SCOPE))?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Demande la permission (au toucher du bouton, jamais à l'ouverture), s'abonne et enregistre l'appareil. */
export async function enablePush(api: Api): Promise<PushState> {
  if (!supported()) return iosNotInstalled() ? "install" : "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const key = base64UrlToBytes(await api.pushKey());
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys });
  return "on";
}

export async function disablePush(api: Api): Promise<PushState> {
  const sub = await (await navigator.serviceWorker.getRegistration(SCOPE))?.pushManager.getSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}
