import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from worklists import pcr_amp  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
SAMPLE_CSV = (FIXTURES / "LAB2446_pcr_plan.csv").read_text()
HEADER = "sample_id,dest_pcr_plate,dest_well_384,dest_well_96,dest_plate"


def sheet(rows):
    return "\n".join([HEADER] + [f"S{i},{plate},{dest},{src},RUN_AMP" for i, (plate, src, dest) in enumerate(rows)]) + "\n"


def quadrant_rows(plate, row_offset, column_offset, count=96):
    rows = []
    for index in range(count):
        row, column = index % 8, index // 8
        rows.append((f"RUN_PCR_{plate}", pcr_amp.well_name(row, column), pcr_amp.well_name(2 * row + row_offset, 2 * column + column_offset)))
    return rows


def full_four_plate_sheet():
    # Plate 1 A1, plate 2 B1, plate 3 A2, plate 4 B2.
    return sheet(quadrant_rows(1, 0, 0) + quadrant_rows(2, 1, 0) + quadrant_rows(3, 0, 1) + quadrant_rows(4, 1, 1))


class SampleSheetPlan(unittest.TestCase):
    def setUp(self):
        self.plan = pcr_amp.plan_transfer(SAMPLE_CSV)

    def test_plates_quadrants_and_deck(self):
        self.assertEqual(self.plan["identifier"], "LAB2446_AMP")
        self.assertEqual(self.plan["sampleCount"], 113)
        self.assertEqual(
            [(p["name"], p["slot"], p["quadrant"], p["samples"]) for p in self.plan["sourcePlates"]],
            [("LAB2446_PCR_1", 1, "A1", 94), ("LAB2446_PCR_2", 2, "A2", 19)],
        )
        self.assertEqual(self.plan["destinationSlot"], 5)
        self.assertEqual(self.plan["tipSlots"], [7, 8])  # 15 transfers x 8 tips = 120 tips

    def test_each_column_moves_to_every_other_row(self):
        transfers = self.plan["transfers"]
        self.assertEqual(len(transfers), 15)
        self.assertEqual(transfers[0]["destinations"], ["A1", "C1", "E1", "G1", "I1", "K1", "M1", "O1"])
        self.assertEqual((transfers[1]["column"], transfers[1]["destination"]), (2, "A3"))
        self.assertEqual((transfers[12]["plate"], transfers[12]["destination"]), (2, "A2"))
        self.assertEqual(transfers[-1]["wells"], ["A3", "B3", "C3"])
        self.assertEqual(transfers[-1]["destinations"], ["A6", "C6", "E6"])

    def test_warnings_cover_echo_volume_and_air_channels(self):
        warnings = " ".join(self.plan["warnings"])
        self.assertIn("above the Echo 384PP working maximum", warnings)
        self.assertIn("LAB2446_PCR_1 has 2 empty well(s)", warnings)
        self.assertIn("LAB2446_PCR_2 has 5 empty well(s)", warnings)

    def test_protocol_matches_the_simulated_fixture(self):
        self.assertEqual(self.plan["filename"], "LAB2446_AMP.py")
        self.assertEqual(self.plan["protocol"], (FIXTURES / "pcr_amp_LAB2446.py").read_text())
        compile(self.plan["protocol"], "protocol.py", "exec")


class FourPlatePlan(unittest.TestCase):
    def test_four_full_plates_fill_one_echo_plate(self):
        plan = pcr_amp.plan_transfer(full_four_plate_sheet(), identifier="Four plates", transfer_volume=60, starting_volume=65)
        self.assertEqual([p["quadrant"] for p in plan["sourcePlates"]], ["A1", "B1", "A2", "B2"])
        self.assertEqual(plan["sampleCount"], 384)
        self.assertEqual(len(plan["transfers"]), 48)
        self.assertEqual(plan["tipSlots"], [7, 8, 10, 11])
        by_plate = {(t["plate"], t["column"]): t for t in plan["transfers"]}
        self.assertEqual(by_plate[(3, 1)]["destination"], "A2")
        self.assertEqual(by_plate[(4, 1)]["destination"], "B2")
        self.assertEqual(by_plate[(4, 12)]["destinations"][-1], "P24")
        self.assertEqual(plan["filename"], "Four_plates.py")
        self.assertIn("5 µL is left behind", " ".join(plan["warnings"]))


class Rejections(unittest.TestCase):
    def errors(self, csv_text, **kwargs):
        with self.assertRaises(pcr_amp.PlanError) as caught:
            pcr_amp.plan_transfer(csv_text, **kwargs)
        return " ".join(caught.exception.errors)

    def test_destination_outside_any_quadrant(self):
        message = self.errors(sheet([("RUN_PCR_1", "B1", "E1")]))
        self.assertIn("cannot go to E1", message)
        self.assertIn("B1 belongs at C1, D1, C2, D2", message)

    def test_plate_that_changes_quadrant(self):
        message = self.errors(sheet([("RUN_PCR_1", "A1", "A1"), ("RUN_PCR_1", "B1", "D1")]))
        self.assertIn("quadrant B1", message)
        self.assertIn("row 2 put RUN_PCR_1 in quadrant A1", message)

    def test_two_plates_in_one_quadrant(self):
        self.assertIn("both use quadrant A1", self.errors(sheet([("RUN_PCR_1", "A1", "A1"), ("RUN_PCR_2", "B1", "C1")])))

    def test_plate_numbers_names_and_wells(self):
        self.assertIn("only plates 1-4", self.errors(sheet([("RUN_PCR_5", "A1", "A1")])))
        self.assertIn("must end in a plate number", self.errors(sheet([("RUN_PCR", "A1", "A1")])))
        self.assertIn("'I1' is not a 96-well position", self.errors(sheet([("RUN_PCR_1", "I1", "A1")])))
        self.assertIn("'A25' is not a 384-well position", self.errors(sheet([("RUN_PCR_1", "A1", "A25")])))
        self.assertIn("listed more than once", self.errors(sheet([("RUN_PCR_1", "A1", "A1"), ("RUN_PCR_1", "A1", "A1")])))
        self.assertIn("more than one run", self.errors(sheet([("RUN_PCR_1", "A1", "A1"), ("OTHER_PCR_2", "A1", "A2")])))

    def test_missing_columns_and_empty_sheets(self):
        self.assertIn("dest_well_96 (column T)", self.errors("dest_pcr_plate,dest_well_384\nRUN_PCR_1,A1\n"))
        self.assertIn("no transfer rows", self.errors(HEADER + "\n"))
        self.assertIn("CSV file is empty", self.errors(""))

    def test_volumes_outside_p300_filter_tip_range(self):
        csv_text = sheet([("RUN_PCR_1", "A1", "A1")])
        self.assertIn("Transfer volume must be 20-200", self.errors(csv_text, transfer_volume=10))
        self.assertIn("Starting volume must be above 0", self.errors(csv_text, starting_volume=0))
        self.assertIn("must be a number", self.errors(csv_text, transfer_volume="66"))

    def test_excel_byte_order_mark_and_lowercase_wells(self):
        plan = pcr_amp.plan_transfer("﻿" + sheet([("RUN_PCR_1", "a1", "a1")]))
        self.assertEqual(plan["transfers"][0]["destinations"], ["A1"])


if __name__ == "__main__":
    unittest.main()
