// Service worker de l'extension : un tour PRACC toutes les 30 minutes (et sur demande depuis la fenêtre de l'icône), et
// toutes les 5 minutes les démos FACEIT demandées (/demos sur Discord, ou d'office pour chaque nouvel adversaire).
import { cleanSecret, grabDemoLinks, newSecret, runFaceit, runTour } from "./lib.js";

const ALARM = "tour";
const FACEIT = "faceit";
// badge rouge : reconnexion PRACC ; « F » : reconnexion FACEIT ; orange : à regarder
const BADGE = { expired: ["!", "#e5484d"], faceit: ["F", "#e5484d"], error: ["?", "#f5a524"] };

async function secret() {
  let { secret: s } = await chrome.storage.local.get("secret");
  if (!s) {
    s = newSecret();
    await chrome.storage.local.set({ secret: s });
  }
  return s;
}

async function badge() {
  const { last, faceit } = await chrome.storage.local.get(["last", "faceit"]);
  const key = last?.state === "expired" ? "expired" : faceit?.state === "expired" ? "faceit"
    : [last?.state, faceit?.state].includes("error") ? "error" : null;
  const [text, color] = BADGE[key] || [""];
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}

// un seul travail à la fois (alarmes et bouton en même temps) : PRACC et FACEIT passent l'un après l'autre
let chain = Promise.resolve();
const serial = (job) => {
  const p = chain.then(job);
  chain = p.catch(() => {});
  return p;
};

let running = null;
function tour() {
  running ??= serial(async () => {
    const last = await runTour({ fetchFn: (...a) => fetch(...a), secret: await secret() });
    await chrome.storage.local.set({ last });
    await badge();
    return last;
  }).finally(() => { running = null; });
  return running;
}

/** Page du match dans une petite fenêtre visible, le temps de relever les liens (quelques secondes), puis fermée. Une page
 *  cachée (onglet en arrière-plan, fenêtre réduite) ne donne pas de lien : FACEIT attend qu'elle soit affichée. */
async function openRoom(url) {
  let win;
  try {
    win = await chrome.windows.create({ url, type: "popup", focused: true, width: 520, height: 680 });
    const tab = win.tabs[0];
    await loaded(tab.id);
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: grabDemoLinks });
    return res?.result ?? { error: "Page FACEIT illisible" };
  } finally {
    if (win) chrome.windows.remove(win.id).catch(() => {});
  }
}

function loaded(tabId, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const done = (id, info) => {
      if (id === tabId && info.status === "complete") { stop(); resolve(); }
    };
    const timer = setTimeout(() => { stop(); reject(new Error("Page FACEIT trop lente")); }, timeout);
    const stop = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(done); };
    chrome.tabs.onUpdated.addListener(done);
    chrome.tabs.get(tabId).then((t) => done(tabId, t)).catch(() => {});
  });
}

let fetching = null;
function faceit() {
  fetching ??= serial(async () => {
    const res = await runFaceit({ fetchFn: (...a) => fetch(...a), secret: await secret(), openRoom });
    await chrome.storage.local.set({ faceit: res });
    await badge();
    return res;
  }).finally(() => { fetching = null; });
  return fetching;
}

const schedule = () => {
  chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 30 });
  chrome.alarms.create(FACEIT, { delayInMinutes: 2, periodInMinutes: 5 });
};
chrome.runtime.onInstalled.addListener(() => { secret(); schedule(); });
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tour();
  if (a.name === FACEIT) faceit();
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "tour") { tour().then(reply); return true; } // réponse asynchrone
  if (msg?.type === "faceit") { faceit().then(reply); return true; }
  if (msg?.type === "secret") { secret().then(reply); return true; }
  if (msg?.type === "setSecret") { // secret d'une autre extension : n8n n'en connaît qu'un pour toute l'équipe
    const s = cleanSecret(msg.value);
    if (!s) { reply(null); return false; }
    chrome.storage.local.set({ secret: s }).then(() => reply(s));
    return true;
  }
  return false;
});
