"""The one [Y/n] rule: EOF is never consent. install.py's private mirror must agree on every input."""
import importlib.util
import io
import sys
import unittest
from pathlib import Path

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))

from bff import prompt

spec = importlib.util.spec_from_file_location("bff_installer_for_prompt", SDK / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

TABLE = [("", False), ("\n", True), ("\r\n", True), ("y\n", True), ("Y\n", True), ("yes\n", True),
         ("YES\n", True), (" y \n", True), ("  \n", True), ("n\n", False), ("no\n", False), ("N\n", False),
         ("maybe\n", False), ("yy\n", False), ("y", True), ("n", False)]


class AnswerTests(unittest.TestCase):
    def test_table(self):
        for line, expected in TABLE:
            with self.subTest(line=line):
                self.assertIs(prompt.answer_is_yes(line), expected)

    def test_installer_mirror_agrees_on_every_input(self):
        for line, _ in TABLE:
            with self.subTest(line=line):
                self.assertIs(installer._answer_is_yes(line), prompt.answer_is_yes(line))

    def test_confirm_writes_the_question_and_reads_one_line(self):
        out, stdin = io.StringIO(), io.StringIO("y\nrest\n")
        self.assertTrue(prompt.confirm("Go? [Y/n] ", stdin, out))
        self.assertEqual(out.getvalue(), "Go? [Y/n] ")
        self.assertEqual(stdin.read(), "rest\n")

    def test_confirm_enter_is_yes_and_eof_is_no(self):
        self.assertTrue(prompt.confirm("?", io.StringIO("\n"), io.StringIO()))
        self.assertFalse(prompt.confirm("?", io.StringIO(""), io.StringIO()))
        self.assertFalse(prompt.confirm("?", io.StringIO("n\n"), io.StringIO()))


if __name__ == "__main__":
    unittest.main()
