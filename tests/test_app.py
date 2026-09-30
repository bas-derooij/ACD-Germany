import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["ACD_QUIET"] = "1"

import app  # noqa: E402

BERLIN = (52.5200, 13.4050)
POTSDAM = (52.3906, 13.0645)   # ~27 km from Berlin
HAMBURG = (53.5511, 9.9937)    # ~255 km from Berlin


class DistanceTests(unittest.TestCase):
    def test_haversine_berlin_hamburg(self):
        self.assertAlmostEqual(app.haversine_km(*BERLIN, *HAMBURG), 255, delta=3)

    def test_find_conflicts(self):
        leads = [
            {"id": 1, "lat": BERLIN[0], "lng": BERLIN[1], "status": "dealer"},
            {"id": 2, "lat": POTSDAM[0], "lng": POTSDAM[1], "status": "new"},
            {"id": 3, "lat": HAMBURG[0], "lng": HAMBURG[1], "status": "new"},
            {"id": 4, "lat": None, "lng": None, "status": "new"},
        ]
        conflicts = app.find_conflicts(leads, 50)
        self.assertEqual([(c["a"], c["b"]) for c in conflicts], [(1, 2)])
        self.assertEqual(app.find_conflicts(leads, 20), [])
        leads[1]["status"] = "rejected"
        self.assertEqual(app.find_conflicts(leads, 50, ["rejected"]), [])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.server = app.make_server("127.0.0.1", 0, ":memory:")
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, method, path, body=None, raw=False):
        data = None
        headers = {}
        if body is not None:
            data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                content = resp.read().decode("utf-8-sig")
                return resp.status, (content if raw else json.loads(content))
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read().decode())

    def test_index_served(self):
        with urllib.request.urlopen(self.base + "/") as resp:
            self.assertIn("Dealer Leads", resp.read().decode())

    def test_lead_crud_and_activities(self):
        status, lead = self.call("POST", "/api/leads", {
            "company": "Autohaus Berlin", "city": "Berlin",
            "lat": BERLIN[0], "lng": BERLIN[1],
        })
        self.assertEqual(status, 201)
        self.assertEqual(lead["status"], "new")

        status, leads = self.call("GET", "/api/leads")
        self.assertEqual(len(leads), 1)

        status, lead = self.call("PUT", f"/api/leads/{lead['id']}", {"status": "contacted"})
        self.assertEqual(lead["status"], "contacted")
        self.assertEqual(lead["company"], "Autohaus Berlin")

        status, act = self.call("POST", f"/api/leads/{lead['id']}/activities",
                                {"type": "call", "text": "Called owner"})
        self.assertEqual(status, 201)
        _, acts = self.call("GET", f"/api/leads/{lead['id']}/activities")
        self.assertEqual([a["type"] for a in acts], ["call", "status", "system"])

        self.assertEqual(self.call("DELETE", f"/api/activities/{act['id']}")[0], 200)
        self.assertEqual(self.call("DELETE", f"/api/leads/{lead['id']}")[0], 200)
        self.assertEqual(self.call("GET", f"/api/leads/{lead['id']}")[0], 404)

    def test_validation(self):
        self.assertEqual(self.call("POST", "/api/leads", {"company": ""})[0], 400)
        self.assertEqual(self.call("POST", "/api/leads", {"company": "X", "status": "bogus"})[0], 400)
        self.assertEqual(self.call("POST", "/api/leads", {"company": "X", "lat": "abc"})[0], 400)
        self.assertEqual(self.call("PUT", "/api/settings", {"min_distance_km": -5})[0], 400)
        self.assertEqual(self.call("GET", "/api/leads/999")[0], 404)

    def test_settings_and_conflicts(self):
        self.call("POST", "/api/leads", {"company": "A", "lat": BERLIN[0], "lng": BERLIN[1]})
        self.call("POST", "/api/leads", {"company": "B", "lat": POTSDAM[0], "lng": POTSDAM[1]})
        _, conflicts = self.call("GET", "/api/conflicts")
        self.assertEqual(len(conflicts), 1)
        _, settings = self.call("PUT", "/api/settings", {"min_distance_km": 20})
        self.assertEqual(settings["min_distance_km"], 20)
        _, conflicts = self.call("GET", "/api/conflicts")
        self.assertEqual(conflicts, [])

    def test_csv_roundtrip(self):
        self.call("POST", "/api/leads", {"company": "Händler Süd", "city": "München",
                                         "lat": 48.137, "lng": 11.575})
        _, csv_text = self.call("GET", "/api/export.csv", raw=True)
        self.assertIn("Händler Süd", csv_text)
        csv_text = csv_text.replace("München", "Muenchen")
        csv_text += ";Neuer Händler;;;;;;;Köln;;50,94;6,96;;;;;;;;;;;\n"
        _, result = self.call("POST", "/api/import", csv_text)
        self.assertEqual((result["created"], result["updated"], result["errors"]), (1, 1, []))
        _, leads = self.call("GET", "/api/leads")
        by_name = {l["company"]: l for l in leads}
        self.assertEqual(by_name["Händler Süd"]["city"], "Muenchen")
        self.assertAlmostEqual(by_name["Neuer Händler"]["lat"], 50.94)

    def test_csv_import_comma_delimited(self):
        csv_text = "company,city,lat,lng,status\nA GmbH,Hamburg,53.55,9.99,dealer\n,Nowhere,,,\n"
        _, result = self.call("POST", "/api/import", csv_text)
        self.assertEqual(result["created"], 1)
        self.assertEqual(len(result["errors"]), 1)


if __name__ == "__main__":
    unittest.main()
