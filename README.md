# ACD Germany – Dealer Lead Manager

A web app for managing potential dealers (leads) in Germany and checking them on a map, so you can see straight away if a new lead is too close to an existing dealer or another lead.

It runs entirely in the web browser: there is no server, and nothing has to be installed.

## Features

- **Lead management**: company, contact person, email, phone, website, address, federal state, status, priority, lead source, assigned person, the brands they sell now, notes and the next action with a due date.
- **Activity log per lead**: record calls, emails, meetings, visits and notes. Status changes are logged automatically.
- **Map of Germany** (OpenStreetMap): each lead is a dot coloured by status.
  - A circle around each lead shows the **minimum distance** you want between dealers. If another lead sits inside that circle, the two are too close.
  - Pairs that are too close get a red outline and a dashed red line with the distance.
  - **Click anywhere on the map** to check that spot: you see the nearest leads and their distances, and you can create a new lead there.
- **"Too close" tab**: every pair of leads closer than the minimum distance, closest first. Click a pair to zoom to it. You can choose which statuses to leave out of the check (for example *Rejected*).
- **Adjustable minimum distance** (default 50 km) in the top bar.
- **Address lookup**: "Find address on map" turns an address or postal code (PLZ) into map coordinates. "Pick on map" lets you click the location instead, and you can drag the marker to fine-tune it.
- **Search, filter and sort**: search by name, city, PLZ or contact; filter by status or priority; sort by name, city, PLZ, last update or closest neighbour.
- **Data menu**: download a full backup (all leads and activity logs) and restore it; export leads to CSV for Excel; import leads from CSV.

## Opening the app

The app is published with **GitHub Pages**. Open this address in Chrome or Edge:

**https://bas-derooij.github.io/ACD-Germany/**

To try it with example data, download [`docs/sample-leads.csv`](docs/sample-leads.csv) and use **Data → Import leads from CSV**.

### Where your data is kept

Your leads are saved **in the browser on the computer you are using**, not online. This means:

- Colleagues who open the same link see their own, empty list.
- Your leads are not on other computers or in other browsers.
- If the browser data is cleared (for example by an IT policy or by "clear browsing history"), the leads are gone. **Use Data → Download backup regularly**, and keep the file somewhere safe, such as OneDrive or a network drive.
- To move to another computer: download a backup, open the app on the other computer, then use **Data → Restore backup**.

The map background and the address lookup use OpenStreetMap, so they need an internet connection.

### Setting up GitHub Pages (one time)

1. On GitHub, go to **Settings → General → Danger Zone → Change visibility** and make the repository **public**. GitHub Pages is only free for public repositories. This makes the app's code public, but not your leads, because those stay in your browser.
2. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick the branch (`main` once this work is merged) and the folder **`/docs`**, then click **Save**.
3. After a minute or two, the app is live at the address shown on that page.

## Statuses

| Status | Meaning |
|---|---|
| New | Lead found, not contacted yet |
| Contacted | First contact made |
| Meeting planned | Appointment or visit scheduled |
| Negotiation | Talking about terms |
| Dealer (signed) | Active dealer. Also use this for your existing dealers so new leads are checked against them. |
| On hold | Paused for now |
| Rejected | Not going ahead (left out of the distance check by default) |

## CSV columns

`id; company; contact_name; email; phone; website; street; postal_code; city; state; lat; lng; status; priority; source; assigned_to; brands; notes; next_action; next_action_date`

Only `company` is required. `status` must be one of `new, contacted, meeting, negotiation, dealer, on_hold, rejected`. `priority` must be `low`, `medium` or `high`. Files may use `;` or `,` as the separator, and decimal commas in `lat`/`lng` are accepted. Rows with an `id` that already exists update that lead; other rows create new leads.

## Development

The site is in `docs/`:

- `index.html`, `style.css`: the page
- `app.js`: map, list and forms
- `store.js`: saving data in the browser (localStorage), CSV and backups
- `vendor/leaflet`: the Leaflet map library

To run it locally, serve the folder with any static web server, for example `python3 -m http.server --directory docs`. To run the tests (Node 18 or newer):

```bash
node --test tests/*.test.js
```

Distances are straight-line distances between coordinates, not driving distances.
