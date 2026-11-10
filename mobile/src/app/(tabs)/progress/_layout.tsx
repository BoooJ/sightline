import { Stack } from "expo-router";

import { color } from "@/ui/theme";

export default function TabStack() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
}
