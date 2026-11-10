import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const TOKEN = "sl-token";

/** Jeton de session de l'app native : dans le trousseau (iOS) / le Keystore (Android). */
export const tokenStore = {
  get: () => SecureStore.getItemAsync(TOKEN),
  set: (t: string) => SecureStore.setItemAsync(TOKEN, t),
  clear: () => SecureStore.deleteItemAsync(TOKEN),
};

/** Préférences sans importance (démo ouverte, bilans déjà lus) : une erreur de stockage ne doit rien casser. */
export const prefs = {
  async get(key: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      // stockage indisponible : on garde l'état en mémoire
    }
  },
  async remove(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // idem
    }
  },
};
