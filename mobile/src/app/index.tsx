import { Redirect } from "expo-router";

import { useSession } from "@/api/session";

export default function Index() {
  const { status } = useSession();
  return <Redirect href={status === "signedIn" || status === "demo" ? "/today" : "/login"} />;
}
