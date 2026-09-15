import unittest

import server


class ServerSecurityTests(unittest.TestCase):
    def test_private_and_tailscale_addresses_are_allowed(self):
        self.assertTrue(server.is_allowed_robot_ip("192.168.1.42"))
        self.assertTrue(server.is_allowed_robot_ip("10.0.0.8"))
        self.assertTrue(server.is_allowed_robot_ip("100.79.20.44"))

    def test_public_and_special_addresses_are_rejected(self):
        self.assertFalse(server.is_allowed_robot_ip("8.8.8.8"))
        self.assertFalse(server.is_allowed_robot_ip("127.0.0.1"))
        self.assertFalse(server.is_allowed_robot_ip("169.254.1.2"))

    def test_current_and_legacy_multipart_field_names(self):
        for field_name in ("files", "protocolFile"):
            body, boundary = server.multipart_body(
                field_name,
                "MFG-1.py",
                b"from opentrons import protocol_api\n",
                "MFG-1",
            )
            self.assertIn(f'name="{field_name}"'.encode(), body)
            self.assertIn(boundary.encode(), body)


if __name__ == "__main__":
    unittest.main()
