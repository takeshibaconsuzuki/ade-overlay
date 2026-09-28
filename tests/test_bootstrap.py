import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bootstrap.py"
spec = importlib.util.spec_from_file_location("bootstrap", SCRIPT)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="ade-bootstrap-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        root_patch = patch.object(bootstrap, "PROJECT_ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.write(".node-version", bootstrap.NODE_VERSION)
        self.write("package.json", '{"name":"test"}')
        self.write("package-lock.json", '{"lockfileVersion":3}')
        self.write("scripts/bootstrap.py", SCRIPT.read_text())
        self.node_dir = bootstrap.node_directory()
        windows = bootstrap.node_platform()[0] == "win"
        self.node = self.node_dir / ("node.exe" if windows else "bin/node")
        self.npm = self.node_dir / (
            "node_modules/npm/bin/npm-cli.js"
            if windows
            else "lib/node_modules/npm/bin/npm-cli.js"
        )
        self.write(self.node, "node")
        self.write(self.npm, "npm")
        self.stamp = self.root / "node_modules" / ".ade-bootstrap.json"
        self.install()

    def write(self, path, content):
        path = self.root / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def install(self, node_dir=None):
        self.write("node_modules/.package-lock.json", "installed")
        self.write("node_modules/electron/path.txt", "electron")
        self.write("node_modules/electron/dist/electron", "binary")

    def prepare(self, force=False):
        with (
            patch.object(bootstrap, "bootstrap", return_value=self.node_dir) as node,
            patch.object(
                bootstrap, "install_dependencies", side_effect=self.install
            ) as npm,
        ):
            result = bootstrap.prepare_environment(force)
        self.assertEqual(result, self.node_dir)
        return node, npm

    def test_ready_environment_runs_no_tools_and_emits_only_activation(self):
        node, npm = self.prepare()
        node.assert_called_once_with(False)
        npm.assert_called_once_with(self.node_dir)
        with (
            patch.object(
                bootstrap.subprocess, "run", side_effect=AssertionError("started a tool")
            ),
            patch.object(sys, "argv", [str(SCRIPT)]),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            bootstrap.main()
        self.assertIn(str(self.node_dir), output.getvalue())
        self.assertNotIn("Installing", output.getvalue())

    def test_changed_inputs_reinstall(self):
        self.prepare()
        for name in (
            ".node-version",
            "package.json",
            "package-lock.json",
            "scripts/bootstrap.py",
            ".npmrc",
        ):
            with self.subTest(name=name):
                self.write(name, "changed")
                _, npm = self.prepare()
                npm.assert_called_once()
                _, npm = self.prepare()
                npm.assert_not_called()
        (self.root / ".npmrc").unlink()
        _, npm = self.prepare()
        npm.assert_called_once()

    def test_missing_or_replaced_runtime_and_dependencies_reinstall(self):
        self.prepare()
        for path in (
            self.node,
            self.npm,
            self.root / "node_modules/.package-lock.json",
            self.root / "node_modules/electron/path.txt",
            self.root / "node_modules/electron/dist/electron",
        ):
            with self.subTest(path=path):
                before = path.read_text()
                path.unlink()
                self.assertIsNone(bootstrap.environment_state(self.node_dir))
                _, npm = self.prepare()
                npm.assert_called_once()
                self.write(path, before + " replacement")
                _, npm = self.prepare()
                npm.assert_called_once()
                self.write(path, before)
                self.prepare()

    def test_invalid_or_missing_stamp_reinstalls(self):
        for content in ("broken JSON", "null", "{}"):
            with self.subTest(content=content):
                self.stamp.write_text(content)
                _, npm = self.prepare()
                npm.assert_called_once()
        self.stamp.unlink()
        _, npm = self.prepare()
        npm.assert_called_once()

    def test_force_bypasses_valid_cache(self):
        self.prepare()
        node, npm = self.prepare(force=True)
        node.assert_called_once_with(True)
        npm.assert_called_once()

    def test_failed_install_invalidates_previous_success(self):
        self.prepare()
        with (
            patch.object(bootstrap, "bootstrap", return_value=self.node_dir),
            patch.object(
                bootstrap,
                "install_dependencies",
                side_effect=subprocess.CalledProcessError(1, "npm"),
            ),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            bootstrap.prepare_environment(force=True)
        self.assertFalse(self.stamp.exists())
        _, npm = self.prepare()
        npm.assert_called_once()

    def test_cache_records_lockfile_after_install(self):
        def install(node_dir):
            self.install(node_dir)
            self.write("package-lock.json", "updated by npm")

        with (
            patch.object(bootstrap, "bootstrap", return_value=self.node_dir),
            patch.object(bootstrap, "install_dependencies", side_effect=install),
        ):
            bootstrap.prepare_environment(False)
        _, npm = self.prepare()
        npm.assert_not_called()
        self.assertEqual(
            json.loads(self.stamp.read_text()), bootstrap.environment_state(self.node_dir)
        )


if __name__ == "__main__":
    unittest.main()
