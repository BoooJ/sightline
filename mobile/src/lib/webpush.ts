import type { Api } from "@/api/api";

/** État des notifications sur l'appareil. App native (Expo Go, APK) : pas de notifications système en v1. */
export type PushState = "native" | "unsupported" | "install" | "denied" | "off" | "on";

export async function pushState(): Promise<PushState> {
  return "native";
}

export async function enablePush(_api: Api): Promise<PushState> {
  return "native";
}

export async function disablePush(_api: Api): Promise<PushState> {
  return "native";
}
