# ACD Germany – Dealer Lead Manager

A small web app for managing potential dealers (leads) in Germany and checking them on a map, so you can see straight away if a new lead is too close to an existing dealer or another lead.

## Features

- **Lead management**: company, contact person, email, phone, website, address, federal state, status, priority, lead source, assigned person, the brands they sell now, notes and the next action with a due date.
- **Activity log per lead**: record calls, emails, meetings, visits and notes. Status changes are logged automatically.
- **Map of Germany** (OpenStreetMap): each lead is a dot coloured by status.
  - A circle around each lead shows the **minimum distance** you want between dealers. If another lead sits inside that circle, the two are too close.
  - Pairs that are too close get a red outline and a dashed red line with the distance.
  - **Click anywhere on the map** to check that spot: you see the nearest leads and their distances, and you can create a new lead there.
- **"Too close" tab**: every pair of leads closer than the minimum distance, closest first. Click a pair to zoom to it. You can choose which statuses to leave out of the check (for example *Rejected*).
- **Adjustable minimum distance** (default 50 km) in the top bar.
- **Address lookup**: "Find address on map" turns an address or postal code (PLZ) into map coordinates. "Pick on map" lets you click the location instead, and you can drag the marker to fine-tune it. While you edit a lead, the form lists the nearest other leads.
- **Search, filter and sort**: search by name, city, PLZ or contact; filter by status or priority; sort by name, city, PLZ, last update or closest neighbour.
- **CSV import and export**: the export opens in Excel (`;`-separated, UTF-8). Import accepts `;` or `,` files. Rows with an `id` that already exists update that lead; other rows create new leads.

## Getting started

You only need **Python 3.9 or newer**. Nothing else has to be installed.

```bash
python3 app.py
```

Then open <http://localhost:8000> in your browser.

Options:

```bash
python3 app.py --port 9000                 # use another port
python3 app.py --db /path/to/leads.db      # store the database somewhere else
python3 app.py --host 0.0.0.0              # let colleagues on your network open it
```

All data is kept in one SQLite file, `data/leads.db` by default. To make a backup, copy that file or use **Export CSV**.

To try the app with example data, click **Import CSV** and choose `sample/sample-leads.csv`.

> The map tiles and the address lookup use OpenStreetMap, so they need an internet connection. The address lookup is limited to about one request per second.

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

Only `company` is required. `status` must be one of `new, contacted, meeting, negotiation, dealer, on_hold, rejected`. `priority` must be `low`, `medium` or `high`. Decimal commas in `lat`/`lng` are accepted.

## Development

```bash
python3 -m unittest discover -s tests
```

- `app.py`: HTTP server, JSON API and SQLite storage (Python standard library only)
- `static/`: the web interface (HTML, CSS, JavaScript), with Leaflet included in `static/vendor/leaflet`

Distances are straight-line distances between coordinates, not driving distances.
