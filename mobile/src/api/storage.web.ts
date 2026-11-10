import AsyncStorage from "@react-native-async-storage/async-storage";

// Sur le web, la session passe par le cookie HttpOnly du site : aucun jeton n'est écrit dans le navigateur.
// (Hors même origine, en développement, le jeton reste en mémoire le temps de l'onglet.)
let memory: string | null = null;
export const tokenStore = {
  get: async () => memory,
  set: async (t: string) => { memory = t; },
  clear: async () => { memory = null; },
};

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
      // navigation privée, stockage bloqué : l'état reste en mémoire
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
