# Mission Map — Prototype v3 (hybrid)

Hybrid of [v1](https://github.com/volzokalex/sqills-mission-map) and
[v2](https://github.com/volzokalex/sqills-mission-map-v2):

| Aspect | Source |
|---|---|
| Background, parallax (cloud-1/-2 PNGs, 2 layers, speeds 0.05/0.30) | v1 |
| Mission layout — vertical pitch + sine zig-zag, final mission centred + 1.62× | v1 |
| Visual styling (cream canvas, pill labels, soft palette) | v1 |
| Mission art (PNG stations + done-state variants) | v2 |
| Editor — drag-drop reorder, side missions, progress bar, Hide toggles | v2 |
| Data model + state machine (available / current / done / locked) | v2 |
| Sample roster (13 missions with art + titles + states) | v2 |
| Pedestals + voxel decor cubes | **removed** |

## Prod

https://volzokalex.github.io/sqills-mission-map-v3/

## Files

```
mission-map-v3/
├── README.md
├── index.html         — markup, hardcoded cloud parallax
├── styles.css         — cream-canvas palette + editor + progress styles
├── app.js             — vertical layout + v2's editor & data flow
├── sample-data.js     — 13-mission seed copied from v2
└── assets/clouds/     — cloud-1.png, cloud-2.png from v1
```
