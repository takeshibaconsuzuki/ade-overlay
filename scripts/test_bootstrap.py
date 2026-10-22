import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import bootstrap


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        root_patch = patch.object(bootstrap, "PROJECT_ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        os_name, arch = bootstrap.node_platform()
        self.node_dir = self.root / f".node.{os_name}-{arch}"
        self.node, self.npm = bootstrap.node_paths(self.node_dir)
        for path in (self.node, self.npm):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fake executable", encoding="utf-8")
        (self.root / "package.json").write_text("{}", encoding="utf-8")
        self.lock = self.root / "package-lock.json"
        self.lock.write_text("{}", encoding="utf-8")
        self.installed_lock = self.root / "node_modules/.package-lock.json"
        self.marker = self.root / "node_modules/.bootstrap-dependencies.json"

    def fake_install(self, *args, **kwargs):
        self.installed_lock.parent.mkdir(parents=True, exist_ok=True)
        self.installed_lock.write_text("{}", encoding="utf-8")
        # npm may update the lockfile during installation.
        self.lock.write_text('{"lockfileVersion": 3}', encoding="utf-8")

    def install(self):
        with patch("subprocess.run", side_effect=self.fake_install) as run:
            bootstrap.install_dependencies(self.node_dir)
        return run

    def test_node_validation_is_cached(self):
        with patch.object(
            bootstrap, "existing_node_version", return_value=bootstrap.NODE_VERSION
        ) as version:
            self.assertEqual(bootstrap.bootstrap(False), self.node_dir)
            bootstrap.bootstrap(False)
            version.assert_called_once_with(self.node)

    def test_changed_node_is_revalidated(self):
        with patch.object(
            bootstrap, "existing_node_version", return_value=bootstrap.NODE_VERSION
        ) as version:
            bootstrap.bootstrap(False)
            self.node.write_text("replacement executable", encoding="utf-8")
            bootstrap.bootstrap(False)
            self.assertEqual(version.call_count, 2)

    def test_changed_expected_version_invalidates_node_cache(self):
        bootstrap.write_state(
            self.node_dir / ".bootstrap-node.json", bootstrap.node_state(self.node_dir)
        )
        with patch.object(bootstrap, "NODE_VERSION", "99.0.0"), patch.object(
            bootstrap, "existing_node_version", return_value="99.0.0"
        ) as version:
            bootstrap.bootstrap(False)
            version.assert_called_once()

    def test_missing_npm_or_force_requires_node_download(self):
        bootstrap.write_state(
            self.node_dir / ".bootstrap-node.json", bootstrap.node_state(self.node_dir)
        )
        with patch.object(bootstrap, "download", side_effect=RuntimeError("download")):
            with self.assertRaisesRegex(RuntimeError, "download"):
                bootstrap.bootstrap(True)
            self.npm.unlink()
            with self.assertRaisesRegex(RuntimeError, "download"):
                bootstrap.bootstrap(False)

    def test_install_uses_vendored_node_and_preserves_activation_stdout(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            run = self.install()
        args, kwargs = run.call_args
        self.assertEqual(args[0][:3], [str(self.node), str(self.npm), "install"])
        self.assertEqual(kwargs["cwd"], self.root)
        self.assertTrue(kwargs["env"]["PATH"].startswith(str(self.node.parent) + os.pathsep))
        self.assertIs(kwargs["stdout"], bootstrap.sys.stderr)
        self.assertIs(kwargs["stderr"], bootstrap.sys.stderr)
        self.assertTrue(kwargs["check"])
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(bootstrap.read_state(self.marker), bootstrap.dependency_state(self.node_dir))
        with patch("subprocess.run") as run:
            bootstrap.install_dependencies(self.node_dir)
            run.assert_not_called()

    def test_changed_inputs_trigger_install_even_with_same_size_and_mtime(self):
        self.install()
        for name in ("package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc", "scripts/install-terminal.mjs"):
            with self.subTest(name=name):
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("aaa", encoding="utf-8")
                self.install()
                previous_stat = path.stat()
                path.write_text("b" * previous_stat.st_size, encoding="utf-8")
                os.utime(path, ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns))
                self.install().assert_called_once()

    def test_missing_or_changed_installed_lock_triggers_install(self):
        self.install()
        self.installed_lock.unlink()
        self.install().assert_called_once()
        self.installed_lock.write_text("changed by external npm install", encoding="utf-8")
        self.install().assert_called_once()

    def test_changed_node_triggers_dependency_install(self):
        self.install()
        self.node.write_text("new node executable", encoding="utf-8")
        self.install().assert_called_once()

    def test_failed_install_removes_success_marker_and_retries(self):
        self.install()
        with patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "npm")):
            with self.assertRaises(subprocess.CalledProcessError):
                bootstrap.install_dependencies(self.node_dir, force=True)
        self.assertFalse(self.marker.exists())
        self.install().assert_called_once()

    def test_corrupt_marker_is_rebuilt(self):
        self.install()
        self.marker.write_text("{invalid json", encoding="utf-8")
        self.install().assert_called_once()
        self.assertIsInstance(json.loads(self.marker.read_text(encoding="utf-8")), dict)


if __name__ == "__main__":
    unittest.main()
