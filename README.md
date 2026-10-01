# ACD Duitsland – Leads

Webapp om leads (potentiële dealers, merkambassadeurs, beurzen, …) in Duitsland te beheren en op een kaart te zien. Zo zie je meteen of een nieuwe lead te dicht bij een bestaande dealer of lead ligt.

De app draait volledig in de browser: er is geen server en je hoeft niets te installeren.

## Openen

De app staat op GitHub Pages: **https://bas-derooij.github.io/ACD-Germany/**

Je leads worden **in de browser op je eigen computer** bewaard, niet online en niet op GitHub. Gebruik daarom regelmatig **Data → Back-up downloaden** en bewaar het bestand bijvoorbeeld op OneDrive. Met **Back-up terugzetten** zet je alles terug, ook op een andere computer of in een andere browser.

## Wat zit erin

- **Leads in de opmaak van de roadmap**:
  - Domein, Onderneming, Naam, Telefoonnummer, Mailadres, Website en Locatie (gemeente).
  - Deelstaat, Status, Status informatie, Volgende actie (met datum), Laatste bezoek, Demo-serre en Notitie.
  - Optioneel ook straat en postcode, voor een exacte locatie.
- **Status = kleurcode uit de roadmap**: 🟠 Gesprek, 🟢 Samenwerking, 🔴 Geen samenwerking.
- **Kaart van Duitsland** met een rode lijn langs de grens. Elke lead is een pin:
  - de **vulling** is de kleur van het domein (klik in de legende op een kleur om ze te wijzigen);
  - de **rand** is de status (oranje, groen of rood);
  - een **rode stippelring** en een stippellijn met de afstand betekenen *te dicht bij een andere lead*.
- **Tabblad "Te dichtbij"**: alle paren leads die dichter dan de minimale afstand (standaard 50 km) bij elkaar liggen. Je kiest per domein en per status wie meetelt. Standaard tellen alle dealer-domeinen mee, maar niet Merkambassadeur, Certified assembler, Galabau verkoper/monteur, de beurzen en *Geen samenwerking*.
- **Klik op de kaart** om een plek te controleren: je ziet de dichtstbijzijnde leads en kunt er meteen een nieuwe lead aanmaken.
- **Activiteitenlog** per lead (telefoon, mail, videocall, bezoek, notitie). Statuswijzigingen worden automatisch gelogd.

## Data-menu

- **Exporteren naar Excel…**: maakt een Excel-bestand in de opmaak van de roadmap, met een gekleurde statuskolom. Je kiest welke domeinen en statussen erin komen, met één tabblad of een overzicht plus één tabblad per domein.
- **Importeren uit roadmap (Excel)…**: leest een roadmap-bestand in.
  - Alleen **groene en oranje** rijen worden toegevoegd. Rode rijen en rijen zonder kleur worden overgeslagen.
  - Kolom I (Regio Duitsland) wordt niet gebruikt.
  - Bestaande leads met dezelfde ondernemingsnaam worden bijgewerkt.
  - Rijen zonder onderneming (beurzen) krijgen de naam uit kolom C.
  - Daarna zet de app automatisch een pin op de **gemeente** (kolom G).
- **Ontbrekende locaties zoeken**: zoekt opnieuw locaties voor leads die nog geen pin hebben.
- **Back-up downloaden / terugzetten**: alle leads, activiteiten en instellingen in één bestand.

### Over het zoeken van locaties

Locaties worden opgezocht via OpenStreetMap (Nominatim). Daarbij worden **alleen de gemeente en de deelstaat** (of het adres dat je zelf invult) verstuurd, nooit namen of contactgegevens.

Een pin die automatisch op de gemeente is gezet, staat in het centrum van die gemeente. Bij plaatsnamen die meerdere keren voorkomen (bv. Kastl of Haselbach) kan het de verkeerde zijn. Open de lead en controleer de pin. Je kunt de pin verslepen of met **Kies op de kaart** een andere plek aanklikken.

## GitHub Pages instellen (eenmalig)

1. **Settings → General → Danger Zone → Change visibility → Make public**. GitHub Pages is alleen gratis voor openbare repositories. Alleen de code wordt openbaar, je leads niet. **Zet nooit je roadmap, exports of back-ups in deze repository.**
2. **Settings → Pages**: kies *Deploy from a branch*, de branch en de map **`/docs`**, en klik op **Save**.

## Ontwikkeling

De site staat in `docs/`:

- `index.html`, `style.css`: de pagina
- `app.js`: kaart, lijst, formulieren, import en export
- `store.js`: opslag in de browser (localStorage) en back-ups
- `roadmap.js`: de roadmap-sheet lezen en schrijven (met ExcelJS)
- `germany.js`: de grens van Duitsland (Natural Earth, publiek domein)
- `vendor/`: Leaflet (kaart) en ExcelJS (Excel)

Lokaal draaien: `python3 -m http.server --directory docs 8000` en open http://localhost:8000.

Tests (Node 18 of nieuwer):

```bash
npm install
npm test
```

Afstanden zijn in vogelvlucht, niet over de weg.
