// Usage: npm run build:border [-- <fill distance km, default 8>]
// Build the Germany outline: mainland only (incl. peninsulas), with narrow waterways along the
// north coast filled in (morphological closing), the rest of the border unchanged.
const topo = require('world-atlas/countries-10m.json');
const { feature } = require('topojson-client');
const turf = require('@turf/turf');
const D_KM = Number(process.argv[2] || 8);       // inlets narrower than ~2*D are filled
const NORTH_LAT = 53.25;                          // only the coast north of this latitude is smoothed

const de = feature(topo, topo.objects.countries).features.find((f) => f.id === '276');
const area = (ring) => { let a = 0; for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]; return Math.abs(a / 2); };
const mainland = turf.polygon([de.geometry.coordinates.reduce((b, p) => (area(p[0]) > area(b[0]) ? p : b))[0]]);

const closed = turf.buffer(turf.buffer(mainland, D_KM, { units: 'kilometers', steps: 16 }), -D_KM, { units: 'kilometers', steps: 16 });
const north = turf.bboxPolygon([0, NORTH_LAT, 20, 60]);
const fill = turf.simplify(turf.intersect(turf.featureCollection([closed, north])), { tolerance: 0.004, highQuality: true });
let result = turf.union(turf.featureCollection([mainland, fill]));
// keep the largest outer ring, no holes
let polys = result.geometry.type === 'Polygon' ? [result.geometry.coordinates] : result.geometry.coordinates;
let ring = polys.reduce((b, p) => (area(p[0]) > area(b[0]) ? p : b))[0];
result = turf.polygon([ring]);
const round = (c) => [Math.round(c[0] * 1e4) / 1e4, Math.round(c[1] * 1e4) / 1e4];
const coords = [result.geometry.coordinates[0].map(round)];
const out = `/* Border of Germany (GeoJSON geometry): mainland only (islands left out). Along the north coast
 * narrow waterways (Bodden, estuaries, fjords) are filled in for a smooth outline.
 * Source: Natural Earth 1:10m admin-0 countries via world-atlas (public domain). */
window.GERMANY_BORDER = ${JSON.stringify({ type: 'Polygon', coordinates: coords })};
`;
require('fs').writeFileSync(process.argv[3] || require('path').join(__dirname, '..', 'docs', 'germany.js'), out);
console.log('D', D_KM, 'km; points', coords[0].length, 'bytes', out.length);
