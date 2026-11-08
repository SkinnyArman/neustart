// WG-Gesucht changed its listing cards in November 2026 (a <div> became an
// <a>, new class names, flatmates in a popover, no "wants a woman" icon).
// The parser reads both; the old markup is covered by the golden run.
import assert from "node:assert/strict";
const S = await import(new URL("../src/scraper.ts", import.meta.url).pathname);
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ✓", name); };

const card = (id, { title, rent, size, details, people = "" }) => `
<span id="back_to_ad_${id}"></span>
<a
    id="liste-details-ad-${id}"
    class="wgg-list-card offer_list_item  "
    data-id="${id}"
    href="/wg-zimmer-in-Cottbus-Mitte.${id}.html"
    aria-label="${title}">
  <img class="sp-image top-image-card img-responsive" src="img/d.gif" data-src="https://img.wg-gesucht.de/media/up/2026/1/abc_${id}.small.jpg" alt="x" title="Anzeige ansehen: ${title}">
  <span class="card-main-text">${rent} &euro;</span>
  <span class="card-main-text card-title-text" title="Anzeige ansehen: ${title}">${title}</span>
  <div class="card-subtitle card-details-text noprint" title="${details}"><span>…</span></div>
  <span class="size-value">${size} m&sup2;</span>
  <div id="flatmates-${id}" class="display-none">
    <div class="text-bold mb10">Ihre zukünftigen Mitbewohner</div>
    <div class="flatmates-breakdown">${people}
    </div>
  </div>
</a>
<div class="printonly"><a class="detailansicht" href="/wg-zimmer-in-Cottbus-Mitte.${id}.html"><b>${title}</b></a></div>`;
const person = (n, label) => `<div class="vertical-align-center"><span class="material-symbols-outlined ms-20px mr10" aria-hidden="true">x</span>
                                    ${n} ${label}                                </div>`;
const page = `<title>WG-Zimmer mieten in Cottbus</title><div class="row g20">` +
  card(111, { title: "Helles Zimmer &amp; Balkon", rent: 305, size: 18, details: "4er WG   · Cottbus Mitte · Bahnhofstraße 1",
    people: person(2, "Frauen") + person(1, "Mann") + person(1, "freier Platz") }) +
  card(222, { title: "Zimmer frei", rent: "1.020", size: 22, details: "Cottbus Sandow" }) + `</div>`;

console.log("\nWG-Gesucht's November 2026 cards");
const ads = S.parseListing(page);
ok("every card is read", () => assert.deepEqual(ads.map((a) => a.ad_id), ["111", "222"]));
ok("title, link, rent, size, district, photo", () => {
  const a = ads[0];
  assert.equal(a.title, "Helles Zimmer & Balkon");
  assert.equal(a.url, "https://www.wg-gesucht.de/wg-zimmer-in-Cottbus-Mitte.111.html");
  assert.equal(a.rent, "305 €"); assert.equal(a.size, "18 m²");
  assert.equal(a.district, "Cottbus Mitte · Bahnhofstraße 1");
  assert.equal(a.image, "https://img.wg-gesucht.de/media/up/2026/1/abc_111.sized.jpg");
  assert.equal(ads[1].rent, "1.020 €");
});
ok("flatmates from the popover: 4er WG · 👩×2 👨×1", () => {
  assert.equal(S.flatmates(ads[0]), "4er WG · 👩×2 👨×1");
  assert.equal(ads[1].wg_size, 0);                        // no WG size given: no line
});
ok("not a bot check", () => assert.equal(S.isCaptcha(page), false));
ok("who the WG wants, from the ad page", () => {
  const ad = (who) => `<h3 class="headline pb0">\n Gesucht wird:\n</h3><ul class="pl15"><li><span class="section_panel_detail">\n ${who}\n</span></li></ul>`;
  assert.equal(S.parseSeeking(ad("Geschlecht egal")), "any");
  assert.equal(S.parseSeeking(ad("Frau zwischen 20 und 30 Jahren")), "female");
  assert.equal(S.parseSeeking(ad("Mann zwischen 18 und 99 Jahren")), "male");
  assert.equal(S.parseSeeking("<p>no section</p>"), "");
});
console.log(`\nall ${pass} wg card checks passed`);
