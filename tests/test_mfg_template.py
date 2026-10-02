import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from worklists import labware, mfg_template  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
SAMPLE_CSV = (FIXTURES / "LAB2456_plating_template.csv").read_text()
HEADER = "r_id,dre,r_well,r_abx,r_strain,r_agar,Complexity,Spot_1,Spot_2,Spot_3,Spot_4"
DIL = ("conc", "dil", "dil", "dil")


def well(index):
    return f"{'ABCDEFGH'[index % 8]}{index // 8 + 1}"


def sheet(rows):
    """rows: (construct number, well, antibiotic, agar plate number, spots)."""
    lines = [f"RUN_{n},DRE,{w},{abx},NEB Stable,EXP_XFRMS_{plate},1,{','.join(spots)}" for n, w, abx, plate, spots in rows]
    return "\n".join([HEADER] + lines) + "\n"


def block(first, count, plate, abx="Kanamycin", spots=DIL):
    """`count` constructs from well index `first`, numbered to match their well."""
    return [(i + 1, well(i), abx, plate, spots) for i in range(first, first + count)]


class SampleSheetPlan(unittest.TestCase):
    def setUp(self):
        self.plan = mfg_template.plan_plating(SAMPLE_CSV)

    def test_agar_plates_follow_r_agar_with_their_antibiotic(self):
        self.assertEqual(self.plan["identifier"], "LAB0000_XFRMS")
        self.assertEqual(self.plan["constructCount"], 28)
        self.assertEqual(
            [(p["name"], p["antibiotic"], p["slot"], p["constructs"]) for p in self.plan["agarPlates"]],
            [("LAB0000_XFRMS_1", "Kanamycin", 1, 16), ("LAB0000_XFRMS_2", "Carbenicillin", 2, 12)],
        )
        self.assertEqual(self.plan["sourcePlates"], [{"number": 1, "slot": 7, "constructs": 28}])
        self.assertEqual((self.plan["tipColumns"], self.plan["tipSlots"], self.plan["reservoirSlot"]), (5, [10], 9))

    def test_plate_two_starts_at_its_left_position(self):
        placed = [(c["column"], c["agar"], c["position"], c["agarColumns"][0]) for c in self.plan["columns"]]
        self.assertEqual(placed, [(1, 1, 0, 1), (2, 1, 1, 5), (3, 2, 0, 1), (4, 2, 1, 5)])
        self.assertEqual(self.plan["columns"][-1]["wells"], ["A4", "B4", "C4", "D4"])
        self.assertEqual(self.plan["notices"], [])
        self.assertIn("Source column 4 has 4 empty well(s)", " ".join(self.plan["warnings"]))

    def test_confirmation_names_each_agar_plate_and_antibiotic(self):
        roles = [(item["role"], item["slots"]) for item in self.plan["labware"]]
        self.assertIn(("LAB0000_XFRMS_1, Kanamycin agar", [1]), roles)
        self.assertIn(("LAB0000_XFRMS_2, Carbenicillin agar", [2]), roles)
        self.assertIn('2: ("LAB0000_XFRMS_2", "Carbenicillin", 2),', self.plan["protocol"])
        self.assertIn('label=f"{name} ({antibiotic})"', self.plan["protocol"])

    def test_protocol_embeds_the_warehouse_agar_definition(self):
        from tests.test_labware import run_protocol_function
        self.assertEqual(run_protocol_function(self.plan["protocol"], "agar_definition"), labware.agar_definition())


class SpotTypes(unittest.TestCase):
    def test_uniform_columns_keep_their_spot_types(self):
        rows = block(0, 8, 1, spots=("conc", "conc", "conc", "dil")) + block(8, 8, 1, spots=("conc", "conc", "dil", "dil"))
        plan = mfg_template.plan_plating(sheet(rows))
        self.assertEqual([c["spots"] for c in plan["columns"]], [["conc", "conc", "conc", "dil"], ["conc", "conc", "dil", "dil"]])
        self.assertEqual(plan["notices"], [])

    def test_mixed_spots_get_3_plus_7_and_a_notice(self):
        rows = block(0, 8, 1)
        rows[1] = (2, "B1", "Kanamycin", 1, ("conc", "conc", "conc", "dil"))
        rows[2] = (3, "C1", "Kanamycin", 1, ("conc", "conc", "dil", "dil"))
        plan = mfg_template.plan_plating(sheet(rows))
        self.assertEqual(plan["columns"][0]["spots"], ["conc", "mixed", "mixed", "dil"])
        self.assertEqual(plan["notices"], [
            "Source column 1, Spot 2: B1, C1 conc; A1, D1, E1, F1, G1, H1 dil. Every well in the column gets 3 µL culture + 7 µL water (30%).",
            "Source column 1, Spot 3: B1 conc; A1, C1, D1, E1, F1, G1, H1 dil. Every well in the column gets 3 µL culture + 7 µL water (30%).",
        ])
        self.assertIn("protocol.comment(notice)", plan["protocol"])
        self.assertIn('(1, 1, 1, 1, ("conc", "mixed", "mixed", "dil")),', plan["protocol"])

    def test_draws_fit_the_20_ul_tip(self):
        draws = run_draws()
        # Culture conc/conc/conc/dil: 10+10, then 10+1. Water 9+9+9 with 2 uL overdraw: 18, then 9.
        self.assertEqual(draws([("a", 10), ("b", 10), ("c", 10), ("d", 1)], 20), [[("a", 10), ("b", 10)], [("c", 10), ("d", 1)]])
        self.assertEqual(draws([("b", 9), ("c", 9), ("d", 9)], 18), [[("b", 9), ("c", 9)], [("d", 9)]])
        self.assertEqual(draws([("a", 10), ("b", 3), ("c", 3), ("d", 1)], 20), [[("a", 10), ("b", 3), ("c", 3), ("d", 1)]])


def run_draws():
    from tests.test_labware import run_protocol_function
    protocol = mfg_template.plan_plating(SAMPLE_CSV)["protocol"]
    return run_protocol_function(protocol + "\n\ndef _draws():\n    return draws\n", "_draws")


class SourceAndAgarPlates(unittest.TestCase):
    def test_constructs_97_and_up_are_on_source_plate_two(self):
        rows = block(0, 96, 1) + [(97 + i, well(i), "Kanamycin", 2, DIL) for i in range(8)]
        # 96 constructs need four agar plates of 24; renumber so each plate gets 3 columns.
        rows = [(n, w, abx, (i // 24) + 1, spots) for i, (n, w, abx, _plate, spots) in enumerate(rows)]
        plan = mfg_template.plan_plating(sheet(rows))
        self.assertEqual([(p["number"], p["slot"], p["constructs"]) for p in plan["sourcePlates"]], [(1, 7, 96), (2, 8, 8)])
        self.assertEqual(plan["columns"][-1]["label"], "Source 2 column 1")
        self.assertEqual([p["slot"] for p in plan["agarPlates"]], [1, 2, 3, 4, 5])
        self.assertEqual(plan["tipSlots"], [10, 11])  # 13 culture columns + 1 water column

    def test_unused_positions_stay_empty_after_an_early_change(self):
        rows = block(0, 12, 1) + block(16, 8, 2)
        plan = mfg_template.plan_plating(sheet(rows))
        self.assertEqual([(c["column"], c["agar"], c["position"]) for c in plan["columns"]], [(1, 1, 0), (2, 1, 1), (3, 2, 0)])

    def test_missing_plate_number_is_noted(self):
        plan = mfg_template.plan_plating(sheet(block(0, 8, 1) + block(8, 8, 3)))
        self.assertEqual([p["slot"] for p in plan["agarPlates"]], [1, 2])
        self.assertIn("The sheet has no EXP_XFRMS_2", " ".join(plan["warnings"]))


class Rejections(unittest.TestCase):
    def errors(self, csv_text):
        with self.assertRaises(mfg_template.PlanError) as caught:
            mfg_template.plan_plating(csv_text)
        return " ".join(caught.exception.errors)

    def test_plate_change_must_start_a_new_column(self):
        message = self.errors(sheet(block(0, 12, 1) + block(12, 4, 2)))
        self.assertIn("Source column 2 holds constructs for more than one agar plate", message)
        self.assertIn("EXP_XFRMS_1 (A2, B2, C2, D2); EXP_XFRMS_2 (E2, F2, G2, H2)", message)
        self.assertIn("a plate change must start a new column", message)

    def test_one_antibiotic_per_agar_plate(self):
        rows = block(0, 8, 1)
        rows[7] = (8, "H1", "Carbenicillin", 1, DIL)
        self.assertIn("EXP_XFRMS_1 lists more than one antibiotic: Kanamycin (7 constructs); Carbenicillin (1 construct)", self.errors(sheet(rows)))

    def test_deck_limits(self):
        self.assertIn("needs 7 agar plates", self.errors(sheet([(i * 8 + 1, well(i * 8), "Kanamycin", i + 1, DIL) for i in range(7)])))
        self.assertIn("EXP_XFRMS_1 gets 4 source columns", self.errors(sheet(block(0, 32, 1))))
        self.assertIn("only 2 fit the deck", self.errors(sheet([(193, "A1", "Kanamycin", 1, DIL)])))

    def test_agar_plates_follow_source_order(self):
        self.assertIn("agar plates must follow source column order", self.errors(sheet(block(0, 8, 2) + block(8, 8, 1))))

    def test_spot_rules(self):
        message = self.errors(sheet([
            (1, "A1", "Kanamycin", 1, ("dil", "dil", "dil", "dil")),
            (2, "B1", "Kanamycin", 1, ("conc", "dil", "dil", "conc")),
            (3, "C1", "Kanamycin", 1, ("conc", "dil", "conc", "dil")),
            (4, "D1", "Kanamycin", 1, ("conc", "half", "dil", "dil")),
        ]))
        self.assertIn("Row 2 (RUN_1): Spot_1 must be conc.", message)
        self.assertIn("Row 3 (RUN_2): Spot_4 must be dil.", message)
        self.assertIn("Row 4 (RUN_3): Spot_3 must be dil when Spot_2 is dil.", message)
        self.assertIn("Row 5 (RUN_4): Spot_2 'half' must be conc or dil.", message)

    def test_wells_names_and_columns(self):
        self.assertIn("'I1' is not a 96-well position", self.errors(sheet([(1, "I1", "Kanamycin", 1, DIL)])))
        self.assertIn("'A13' is not a 96-well position", self.errors(sheet([(1, "A13", "Kanamycin", 1, DIL)])))
        self.assertIn("already used by RUN_1", self.errors(sheet([(1, "A1", "Kanamycin", 1, DIL), (2, "A1", "Kanamycin", 1, DIL)])))
        other = sheet(block(0, 8, 1)) + "RUN_9,DRE,A2,Kanamycin,NEB Stable,OTHER_XFRMS_2,1,conc,dil,dil,dil\n"
        self.assertIn("more than one experiment", self.errors(other))
        self.assertIn("missing required column(s): spot_4", self.errors("r_id,r_well,r_abx,r_agar,Spot_1,Spot_2,Spot_3\n"))
        self.assertIn("no construct rows", self.errors(HEADER + "\n"))
        self.assertIn("CSV file is empty", self.errors(""))

    def test_unmeasured_agar_blocks_generation(self):
        with mock.patch.multiple(labware, AGAR_PLATE_HEIGHT_MM=None, AGAR_SURFACE_HEIGHT_MM=None):
            self.assertIn("no definition yet", self.errors(SAMPLE_CSV))


if __name__ == "__main__":
    unittest.main()
