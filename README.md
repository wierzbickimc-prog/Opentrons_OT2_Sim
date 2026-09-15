# OT-2 Protocol Visualizer

A browser-based manufacturing tool for creating 1–144 construct plating work lists and reviewing OT-2 protocols. It generates downloadable Python protocols, renders synchronized top-down and three-quarter views, animates the eight-channel pipette, and tracks tips and liquid volumes.

## Run locally

```bash
python3 server.py
```

Open <http://localhost:8766>. Choose **MFG_Plating** to create a work list or **WL Simulation** to review a protocol.

After updating files while the server is already running, reload the page with the browser's cache bypass shortcut (`Cmd+Shift+R` on macOS or `Ctrl+Shift+R` on Linux/Windows).

## Ubuntu hosting

Copy this directory to the Ubuntu host and serve it with any static web server. For internal testing, Python is enough:

```bash
OT2_VISUALIZER_HOST=0.0.0.0 python3 server.py
```

Then visit `http://HOST_IP:8766` from another machine on the internal network. Use an authenticated reverse proxy before exposing it outside a trusted network.

For a persistent per-user service, copy `deploy/ot2-visualizer.service` to `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, and enable it with `systemctl --user enable --now ot2-visualizer.service`.

## Prototype scope

- MFG_Plating supports 1–144 constructs, two source plates, two tip racks, and up to six destination plates.
- Constructs map column-first: A1–H1, then A2–H2. A partial final column uses all eight tips and unused channels aspirate air.
- Starting volume is 130 µL in each occupied source well. Each source well ends at 90 µL; each destination replicate receives 10 µL.
- Generated files can be downloaded, opened directly in WL Simulation, or uploaded to an OT-2 for analysis.
- Protocol files remain in the browser unless the operator explicitly chooses direct OT-2 submission.
- The current parser recognizes and validates the supplied colony-rearray layout. A production version should use Opentrons' protocol-analysis output rather than executing arbitrary uploaded Python in the browser.

## Direct OT-2 upload

Set `OT2_UPLOAD_PIN` in the server environment to enable the PIN-protected upload proxy. The proxy accepts only private LAN or Tailscale robot addresses and always uses the OT-2 HTTP API on port 31950. It uploads the generated protocol for analysis but does not create or start a run.

```bash
OT2_UPLOAD_PIN='replace-with-a-long-random-value' python3 server.py
```

## Motion and timing model

The visualizer uses OT-2 deck pitch and the official A1/pitch/bottom-Z geometry for the three bundled labware load names. Each move is divided into a vertical retract, accelerated XY traversal, vertical descent, and liquid-handling operation. Defaults are 400 mm/s XY gantry speed, 125 mm/s Z speed, and 7.6 µL/s P20 Multi GEN2 aspiration/dispense flow. Explicit `default_speed`, `flow_rate.aspirate`, and `flow_rate.dispense` assignments in an uploaded file override those defaults.

Estimated time excludes robot initialization, homing, calibration, network latency, user pauses, and hardware variation. Treat it as a planning estimate with approximately ±20% uncertainty until it has been calibrated against timestamps from a physical OT-2.
