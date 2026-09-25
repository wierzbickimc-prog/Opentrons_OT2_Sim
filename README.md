# OT-2 Protocol Visualizer

A browser-based manufacturing tool for creating 1–144 construct plating work lists (straight or diluted with water), PCR->AMP plate transfers, and testing OT-2 protocols before they reach a robot. MFG_Plating, MFG_Hybrid_Plating, and PCR->AMP plate transfer generate downloadable Python protocols. WL Simulation runs any OT-2 Python protocol on Opentrons' own OT-2 engine against an emulated motor controller, then animates the recorded motion, scrolls the G-code the robot would send, and runs safety checks. Equipment calibration runs the OT-2 App's deck, tip length, and pipette offset calibrations and the Calibration Health Check, on a practice robot or a real OT-2.

## Run locally

```bash
scripts/setup_simulator.sh             # once: builds the OT-2 engine into .venv-sim (Python 3.10+, git, network)
OT2_SITE_PASSWORD='your-password' python3 server.py
```

`OT2_SITE_PASSWORD` gates the whole app: every page, asset, and API redirects to a sign-in page until the password is entered. Sessions last 12 hours, are signed with a per-process secret (restarting the server signs everyone out), and five wrong attempts from one address lock sign-in for five minutes. Leave the variable unset to disable the gate. Keep the password out of the repository: set it in the environment or in `~/.config/ot2-visualizer.env` on the host.

Open <http://localhost:8766>. Choose **MFG_Plating**, **MFG_Hybrid_Plating**, or **PCR->AMP plate transfer** to create a work list, **WL Simulation** to review a protocol, **Equipment calibration** to calibrate a robot or practice doing so, or **Labware Warehouse** to see every labware definition the tools use.

After updating files while the server is already running, reload the page with the browser's cache bypass shortcut (`Cmd+Shift+R` on macOS or `Ctrl+Shift+R` on Linux/Windows).

## Ubuntu hosting

Copy this directory to the Ubuntu host and serve it with any static web server. For internal testing, Python is enough:

```bash
OT2_VISUALIZER_HOST=0.0.0.0 python3 server.py
```

Then visit `http://HOST_IP:8766` from another machine on the internal network. Use an authenticated reverse proxy before exposing it outside a trusted network.

For a persistent per-user service, copy `deploy/ot2-visualizer.service` to `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, and enable it with `systemctl --user enable --now ot2-visualizer.service`.

## MFG_Hybrid_Plating

Same inputs, mapping, and deck as MFG_Plating, but the four spots per construct are 10 µL, 10 µL, 3 µL + 7 µL water, and 1 µL + 9 µL water, so every spot ends at 10 µL (100%, 100%, 30%, 10% culture).

- **Water first.** One tip column lays down all the water: each source column is one 18 µL aspirate from the reservoir, 7 µL into spot 3 and 9 µL into spot 4, and the 2 µL overdraw is blown back into the reservoir. These tips only touch the reservoir and clean agar, so they are used for the whole run.
- **Then culture**, in the same column order, with a fresh tip per source column: 20 µL → 10, 10; then 4 µL → 3, 1 dispensed into the water drops 1 mm above the agar with no blow-out.
- **Tips:** source columns + 1, so ceil((columns + 1) / 12) racks in slots 10–11 (89–96 constructs now need two racks).
- **Water:** NEST 1-Well Reservoir 195 mL in slot 9, filled to the line. The protocol models 100 mL for liquid tracking; a full run uses 2.3 mL.

On the engine, 144 constructs take about 10 minutes (MFG_Plating: about 8), and water drops wait 3.4–6.8 minutes for their culture.

## PCR->AMP plate transfer

Upload a PCR plan CSV to move up to four 96-well full-skirt PCR plates into one Labcyte Echo 384PP plate. The planner (`worklists/pcr_amp.py`, served at `POST /api/pcr-amp/plan`) reads these columns by header name:

| Column | Header | Use |
| --- | --- | --- |
| Q | `dest_pcr_plate` | Source plate; the `_1`–`_4` suffix is the plate number and deck slot |
| S | `dest_well_384` | Echo 384PP destination well |
| T | `dest_well_96` | PCR plate source well |
| AI | `dest_plate` | Default work-list identifier (optional) |

Each PCR plate occupies one quadrant of the Echo plate: 96-well row *r*, column *c* goes to 384 row 2r−1 (+1 for a B quadrant) and column 2c−1 (+1 for a 2 quadrant). For example, plate A1 → A1, B1 → C1, A2 → A3 in quadrant A1. The sheet chooses each plate's quadrant; a plate that changes quadrant between rows, two plates sharing a quadrant, a plate number above 4, duplicate wells, or more than one run or destination plate rejects the sheet with every reason listed.

The protocol uses a P300 Multi GEN2 on the left mount with 200 µL filter tips. Each occupied source column is one eight-channel transfer into every other Echo row, with fresh tips that are discarded after every transfer and no mixing. Partially filled columns still use all eight tips; empty channels aspirate air. The transfer volume defaults to 66 µL from 65 µL wells so each well is emptied (both are editable; above 65 µL warns about the Echo 384PP working maximum). Deck: PCR plates 1–4 in slots 1–4, the Echo plate in slot 5, filter tip racks in slots 7, 8, 10, and 11 as needed, trash in slot 12.

Opentrons has no Echo 384PP definition, so the protocol embeds one built from nominal SLAS 384-well dimensions (14.4 mm plate height, 11.5 mm deep 3.7 mm wells, 65 µL capacity). Check it against a physical plate and calibrate labware offsets in the OT-2 App before the first run. Dispensing happens 4 mm below the well top (`DISPENSE_DEPTH_MM`).

## WL Simulation

Uploading a protocol (or choosing **Open in WL Simulation** from MFG_Plating) sends it to `POST /api/simulate`. The server runs `simulation/worker.py` in the `.venv-sim` interpreter, which:

1. Runs Opentrons' protocol analysis to validate the file and find the pipettes and modules it needs.
2. Starts Opentrons' Smoothie and module emulators on free localhost ports, configured with those pipettes and modules.
3. Executes the protocol on the real OT-2 protocol engine and hardware controller, recording every serial write (G-code) and every gantry and plunger move, each tied to the protocol command that produced it.
4. Runs `simulation/safety.py` over the result.

The browser then plays back the recorded moves (including arc heights the engine chooses), shows the G-code in the console below the animation in step with playback, and lists safety findings; clicking a finding jumps to its step. **Download .gcode** saves the full capture, annotated by command.

Playback stops at every `protocol.pause()` and shows its message in a pop-up, as the robot waits for **Resume** in the OT-2 App. **Resume** continues; **Stay paused** leaves playback stopped on that step.

### Safety checks

| Severity | Check |
| --- | --- |
| Error | Any Opentrons engine error: out of tips, volume over pipette maximum, deck conflicts, out-of-bounds moves, invalid locations. |
| Error | Tip or nozzle end below the top of labware or a module while traveling, or on descent outside a well opening. |
| Error | Tip end below a well bottom. |
| Warning | Aspirating more than 2 µL beyond what a well holds, aspirating with the tip above the liquid surface, or overfilling a well. |
| Info | A channel aspirates from a well with no declared liquid (expected for partial columns), aspirates up to 2 µL more than a well holds to empty it (PCR->AMP transfer), or the protocol declares no liquids. |

Limits: default deck calibration and nominal labware definitions (a calibrated robot differs by a few millimeters and labware offsets are not applied); collisions are checked for tip and nozzle ends, not the full pipette body; module walls are approximated by their labware seat height; liquid checks rely on `load_liquid`. Timing is an estimate from robot-config speed and acceleration limits.

### Engine version

The engine is pinned to OT-2 robot software **26.6.0** (API level 2.28). PyPI's `opentrons` package no longer supports OT-2 protocols at this API level, so the setup script builds it from the `Opentrons/opentrons-ot2` source tag. Motion and G-code change between releases, so match the robots: check **OT-2 App → Robot Settings → Advanced → Robot software version**, then rebuild with, for example, `OT2_ENGINE_VERSION=v26.6.0 scripts/setup_simulator.sh` (delete `.venv-sim` first when changing versions). The engine version is shown in the simulator sidebar and at `/api/health`.

### Security

Simulation executes uploaded Python on the server. It is open to anyone who can reach the page unless `OT2_SIM_REQUIRE_PIN=1` is set, which gates it behind `OT2_UPLOAD_PIN`. It runs one simulation at a time in a separate process group with a private temporary `HOME`, a minimal environment, CPU/memory/file limits, and a timeout (`OT2_SIM_TIMEOUT`, default 180 s), and binds emulators to localhost. This is basic isolation suited to trusted internal users, not a sandbox for untrusted code. Results are cached in `.sim-cache/` (last 50) by protocol content and engine version; the static file server only serves the app's top-level web files, so the cache, virtualenv, and source are not reachable over HTTP.

### Tests

```bash
python3 -m unittest discover tests
```

`tests/test_labware.py` checks the warehouse against the engine and the protocols. `LiveCalibrationProxyTests` in `tests/test_server.py` check the live proxy against a fake robot. `tests/test_calibration.py` runs `tests/calibration_flows.test.js` in Node (skipped when Node is missing): every flow with an exact operator, the App's flow order, a pipette offset saved 3 mm off failing the health check, pick-up misses, and crashes. `tests/test_simulation.py` runs the sample protocol and the fixtures in `tests/fixtures/` on the real engine and is skipped when `.venv-sim` is missing. Each fixture is a deliberately faulty protocol that must produce its finding.

## Equipment calibration

The OT-2's robot calibration is not a protocol. It is four interactive flows in Opentrons' robot server (`robot_server/robot/calibration`), which the OT-2 App drives command by command while the operator jogs the pipette and the robot saves what it measures. This tool rebuilds them: `calibration_flows.js` has robot-server's state machines, command names, positions, and health-check tolerances, and `calibration.js` is the screen.

| Flow | Operator jogs to | Saves |
| --- | --- | --- |
| Deck calibration | Tip in slot 8 A1, deck in slot 5, crosses in slots 1, 3, 7 | Deck offset; clears every pipette offset |
| Tip length | Nozzle, then tip, onto the Calibration Block (slot 3 for the left mount, slot 1 for the right) or the fixed trash | Tip length; clears that pipette's offset |
| Pipette offset | Deck in slot 5, cross in slot 1 (measures tip length first when there is none) | Pipette offset |
| Calibration Health Check | Every point above, per pipette (block in slot 6) | Pass or fail per calibration, using Opentrons' tolerances (for example P20 crosses 1.4 mm, P300 1.8 mm per axis) |

Every question the OT-2 App asks appears as a pop-up: Calibration Block or trash bin, the deck setup checklist (clear all other deck slots, tip rack in slot 8, block placement) that must be ticked before **Confirm placement**, "Did pipette pick up tip successfully?", removing the Calibration Block, returning the tip, the health-check results, and "Jog too far or bend a tip?" (also raised automatically when the pipette is jogged more than 1.5 mm into a surface). Jog with the on-screen pad or the keyboard: arrows for X and Y (↑ is toward the back), Shift+↑/↓ or W/S for Z, and 1/2/3 for 0.1, 1, or 10 mm steps.

**Practice mode** runs on a simulated OT-2 whose deck, mounts, and tips are off by hidden amounts; the close-up shows what an operator would see at the robot (a top-down view of the target and a side view of the gap), and calibrations are measured from where you jog, so a sloppy calibration fails the health check. **Show exact offsets** adds a numeric training aid. Nothing is sent to a robot, and practice calibrations reset when the page reloads.

**Live mode** calibrates a real OT-2. Enter the robot's address and the upload PIN (`OT2_UPLOAD_PIN`; live mode is off without it) and connect: the panel shows the robot's attached pipettes and saved calibrations. Each button, pop-up answer, and jog is one command to the robot's calibration sessions API (`/sessions` on port 31950), relayed by `POST /api/ot2/calibration`. The robot runs its own state machine and saves the calibrations; the page waits for each move to finish and drops key presses made while the robot moves, rather than queuing them. The proxy relays only the four calibration session types and their commands, and jogs of at most 10 mm per axis, to private LAN or Tailscale addresses. Before a flow starts, a calibration session left open on the robot (by the OT-2 App or a closed tab) is offered for ending; ending it returns its tip first. The OT-2 has no camera, so live mode has no close-up: watch the pipette at the robot. Stay at the robot while calibrating, and close the OT-2 App's calibration screens first.

Two robot-server quirks are handled: the health check records the slot 5 height only when the operator jogs, so the page sends a zero-length jog before each check; and after tip length is saved in the combined tip length and pipette offset flow, starting over cannot continue, so "Jog too far or bend a tip?" is not offered there (exit and start pipette offset again; tip length is kept).

Practice limits: the deck model is a translation per pipette (no rotation), tip pick-up succeeds within 1.2 mm of A1, and moves go straight to each target without the robot's arcs.

## Labware Warehouse and confirmation

The robot moves by labware definitions, and the simulator trusts them exactly, so a definition that differs from the physical item can crash the tips without any simulated warning. `worklists/labware.py` is the one list of every definition the tools use, served at `GET /api/labware` (and each full definition at `GET /api/labware/<load name>`):

- **Opentrons standard** definitions are vendored in `labware/definitions/`, in the versions the engine loads at API 2.28 (a test compares them with the engine).
- **Custom** definitions are built in code and embedded in the protocols that use them: the Labcyte Echo 384PP (nominal SLAS dimensions, not yet checked against a real plate) and the Nunc OmniTray agar plate. Tests require the protocols' embedded copies to match.
- **Placeholders** stand in for labware with no definition. The plating tools used `corning_96_wellplate_360ul_flat` for agar OmniTrays; its well bottom (3.55 mm) is not the agar surface, so spots dispensed "1 mm above the agar" could go into it.

The **Labware Warehouse** screen lists each definition with its status, the dimensions the robot relies on, what to check on the physical item, which tools use it, a JSON download, and a blueprint drawing (top view, front elevation, title block) drawn from the definition.

**Every protocol build ends with a labware confirmation.** "Machine is ready" in MFG_Plating, MFG_Hybrid_Plating, and PCR->AMP opens a checklist of every deck item (slots, definition, dimensions, what to check), the pipette and mount, and an extra check for each custom definition. Download, simulation, and robot upload appear only after every item is ticked. A placeholder, or a definition still waiting for measurements, cannot be confirmed, so the protocol cannot be generated.

**The agar OmniTray definition** comes from a filled Nunc OmniTray measured 2026-09-25: 14.2 mm from the deck to the top of the lid (the robot runs lid off, so this slightly overstates the tray and only raises travel clearance) and the agar surface 7.7 mm above the deck. The 96 spot positions sit on the agar surface, so every spot is dispensed 1 mm above the agar; the old Corning placeholder would have put the tips about 3 mm into it. Pour to the measured volume: a higher surface drives tips into the agar. If the plates or pour change, re-measure and update `AGAR_PLATE_HEIGHT_MM` and `AGAR_SURFACE_HEIGHT_MM` in `worklists/labware.py`.

WL Simulation lists the labware in every simulated protocol and opens a review when any is custom, unknown to the warehouse, or a placeholder (the Corning plate in protocols built by these tools).

## Prototype scope

- MFG_Plating supports 1–144 constructs, two source plates, two tip racks, and up to six destination plates.
- Agar plates are Nunc OmniTrays with the agar surface 7.7 mm above the deck (see Labware Warehouse).
- Constructs map column-first: A1–H1, then A2–H2. A partial final column uses all eight tips and unused channels aspirate air.
- Starting volume is 130 µL in each occupied source well. Each source well ends at 90 µL; each destination replicate receives 10 µL.
- Generated files can be downloaded, opened directly in WL Simulation, or uploaded to an OT-2 for analysis.
- Protocol files remain in the browser unless the operator explicitly chooses direct OT-2 submission.

## Direct OT-2 upload

Set `OT2_UPLOAD_PIN` in the server environment to enable the PIN-protected upload proxy. The proxy accepts only private LAN or Tailscale robot addresses and always uses the OT-2 HTTP API on port 31950. It uploads the generated protocol for analysis but does not create or start a run.

```bash
OT2_UPLOAD_PIN='replace-with-a-long-random-value' python3 server.py
```

## Motion and timing model

Positions come from the engine's recorded moves, so arc heights, tip-pickup presses, and flow-rate-driven plunger speeds match what the engine commands. Each move's duration uses the robot config's per-axis speed and acceleration limits; homing between moves is bridged at 125 mm/s. Estimated time excludes robot initialization, calibration, network latency, user pauses, module temperature ramps, and hardware variation. Treat it as a planning estimate with approximately ±20% uncertainty until it has been calibrated against timestamps from a physical OT-2.
