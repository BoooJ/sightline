import { Redirect } from "expo-router";

import { useWhoLater } from "@/api/me";
import { useSession } from "@/api/session";
import AppTabs from "@/components/AppTabs";

export default function TabsLayout() {
  const { status, user } = useSession();
  const { later, ready } = useWhoLater();
  // compte du site pas encore relié à un joueur des démos : on le demande avant tout, sauf « Plus tard »
  if (status === "signedIn" && !user?.steamid) {
    if (!ready) return null;
    if (!later) return <Redirect href="/who" />;
  }
  return <AppTabs />;
}
