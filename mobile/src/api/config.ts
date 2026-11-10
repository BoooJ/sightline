import { Platform } from "react-native";

import appJson from "../../app.json";

/** version de l'app (app.json) : Constants.expoConfig n'est pas fiable sur le web */
export const APP_VERSION = appJson.expo.version;

const ENV = process.env.EXPO_PUBLIC_API_URL;
export const SERVER = "https://sightline.example.com";

/** Version web servie par le site sous /app/ : même origine, donc le cookie de session du site. */
export const SAME_ORIGIN = Platform.OS === "web" && !ENV;
/** « » en même origine, sinon l'adresse du serveur (app native, ou web pointé sur un autre serveur). */
export const API_BASE = SAME_ORIGIN ? "" : (ENV ?? SERVER).replace(/\/$/, "");
