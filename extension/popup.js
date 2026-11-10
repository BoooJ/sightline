// Fenêtre de l'icône : état du dernier tour (PRACC, démos FACEIT), bouton pour en lancer un, secret à copier dans n8n.
const $ = (id) => document.getElementById(id);

function show(last) {
  if (!last) return;
  $("state").textContent = last.message;
  $("state").className = `state ${last.state}`;
  $("when").textContent = `Dernier tour : ${new Date(last.at).toLocaleString("fr-FR")}`;
}

function showFaceit(f) {
  if (!f) return;
  $("faceit").hidden = false;
  $("faceit").textContent = f.message;
  $("faceit").className = `state ${f.state}`;
  $("faceit-when").textContent = `Démos FACEIT : ${new Date(f.at).toLocaleString("fr-FR")}`;
}

const { last, faceit } = await chrome.storage.local.get(["last", "faceit"]);
show(last);
showFaceit(faceit);
let secret = await chrome.runtime.sendMessage({ type: "secret" });
$("secret").textContent = secret;

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  $("state").textContent = "Tour en cours…";
  try {
    show(await chrome.runtime.sendMessage({ type: "tour" }));
    showFaceit(await chrome.runtime.sendMessage({ type: "faceit" }));
  } finally { $("run").disabled = false; }
});
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(secret);
  $("copy").textContent = "Copié";
});
$("use").addEventListener("click", async () => {
  const saved = await chrome.runtime.sendMessage({ type: "setSecret", value: $("paste").value });
  $("paste").value = "";
  if (!saved) { $("secret-msg").textContent = "Ce n'est pas un secret valide (64 caractères 0-9 et a-f)."; return; }
  secret = saved;
  $("secret").textContent = saved;
  $("secret-msg").textContent = "Secret enregistré : lance un tour pour vérifier.";
});
