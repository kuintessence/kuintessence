#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Revise Ecosystem catalog metadata and named selectors. The output requires signing."""
import argparse
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("metadata")
    parser.add_argument("output")
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    script = Path(__file__).resolve().with_suffix(".ts")
    os.execvp("bun", ["bun", str(script), args.manifest, args.metadata, args.output, args.version])


if __name__ == "__main__":
    main()
