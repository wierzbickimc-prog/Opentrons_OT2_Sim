# OT-2 Protocol Visualizer

A dependency-free browser prototype for reviewing an OT-2 colony-rearray protocol. It renders synchronized top-down and three-quarter views, animates the eight-channel pipette, and tracks tips and liquid volumes locally in the browser.

## Run locally

```bash
python3 -m http.server 8080
```

Open <http://localhost:8080> and press **Play**. Uploading the supplied Python protocol recognizes its deck layout and warns about the original flattened-column targeting expression.

After updating files while the server is already running, reload the page with the browser's cache bypass shortcut (`Cmd+Shift+R` on macOS or `Ctrl+Shift+R` on Linux/Windows).

## Ubuntu hosting

Copy this directory to the Ubuntu host and serve it with any static web server. For internal testing, Python is enough:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

Then visit `http://HOST_IP:8080` from another machine on the internal network. Use an authenticated reverse proxy before exposing it outside a trusted network.

## Prototype scope

- The included rearray workflow contains 96 actions: 8 actions for each of 12 source columns.
- Starting volume defaults to 130 µL in each of the 96 source wells.
- Each source well ends at 90 µL; each destination well receives 10 µL.
- Protocol files remain in the browser and are not uploaded to a server.
- The current parser recognizes and validates the supplied colony-rearray layout. A production version should use Opentrons' protocol-analysis output rather than executing arbitrary uploaded Python in the browser.

## Motion and timing model

The visualizer uses OT-2 deck pitch and the official A1/pitch/bottom-Z geometry for the three bundled labware load names. Each move is divided into a vertical retract, accelerated XY traversal, vertical descent, and liquid-handling operation. Defaults are 400 mm/s XY gantry speed, 125 mm/s Z speed, and 7.6 µL/s P20 Multi GEN2 aspiration/dispense flow. Explicit `default_speed`, `flow_rate.aspirate`, and `flow_rate.dispense` assignments in an uploaded file override those defaults.

Estimated time excludes robot initialization, homing, calibration, network latency, user pauses, and hardware variation. Treat it as a planning estimate with approximately ±20% uncertainty until it has been calibrated against timestamps from a physical OT-2.
