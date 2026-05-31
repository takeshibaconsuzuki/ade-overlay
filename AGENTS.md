# Repository Guidelines

## Build, Test, and Development Commands

- `python3 bootstrap.py`: installs the expected Node.js version for the current platform if it is missing or stale.
- `python3 bootstrap.py --force`: replaces the existing vendored Node.js directory.
- `eval "$(python3 bootstrap.py --print-env)"`: configures the current POSIX shell to use the vendored Node.
